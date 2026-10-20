'use strict';

const { deliverCellMessage } = require('../cells/deliver.js');
const { publicCells } = require('../cells/routes.js');
const store = require('./store.js');

const MAX_OUTBOX_TEXT = 2048; // 2 KiB
const RATE_LIMIT_MINUTE_CAP = 6;
const RATE_LIMIT_HOUR_CAP = 20;
const RATE_LIMIT_MINUTE_MS = 60_000;
const RATE_LIMIT_HOUR_MS = 3_600_000;
const MSG_ID_RE = /^[a-f0-9]{32}$/;
const TARGET_RE = /^[a-f0-9]{16,64}:[A-Za-z0-9._-]{1,64}$/;

function hasIllegalControlChars(text) {
  // Disallow control characters except TAB (\x09), LF (\x0a), CR (\x0d)
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}

function sanitizeOutboxItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { item: null, error: 'invalid-item' };
  }
  // Deny-extra keys: only id, to, text (and from is ignored if present)
  for (const key of Object.keys(raw)) {
    if (key !== 'id' && key !== 'to' && key !== 'text' && key !== 'from') {
      return { item: null, error: 'unknown-field' };
    }
  }
  if (!MSG_ID_RE.test(String(raw.id || ''))) {
    return { item: null, error: 'invalid-id' };
  }
  if (typeof raw.to !== 'string' || !TARGET_RE.test(raw.to)) {
    return { id: raw.id, item: null, error: 'invalid-target' };
  }
  if (typeof raw.text !== 'string') {
    return { id: raw.id, item: null, error: 'invalid-text' };
  }
  if (Buffer.byteLength(raw.text, 'utf8') > MAX_OUTBOX_TEXT) {
    return { id: raw.id, item: null, error: 'oversized' };
  }
  if (hasIllegalControlChars(raw.text)) {
    return { id: raw.id, item: null, error: 'control-chars' };
  }
  return {
    item: {
      id: raw.id,
      to: raw.to,
      text: raw.text,
    },
    error: null,
  };
}

function createRateLimiter() {
  const records = new Map(); // nodeId -> [timestamps]

  function checkAndConsume(nodeId, now) {
    let list = records.get(nodeId);
    if (!list) {
      list = [];
      records.set(nodeId, list);
    }
    // Prune entries older than 1 hour
    const hourCutoff = now - RATE_LIMIT_HOUR_MS;
    list = list.filter((ts) => ts > hourCutoff);
    records.set(nodeId, list);

    // Check 1 minute cap
    const minuteCutoff = now - RATE_LIMIT_MINUTE_MS;
    const minuteCount = list.filter((ts) => ts > minuteCutoff).length;
    if (minuteCount >= RATE_LIMIT_MINUTE_CAP) {
      return false;
    }

    // Check 1 hour cap
    if (list.length >= RATE_LIMIT_HOUR_CAP) {
      return false;
    }

    list.push(now);
    return true;
  }

  function reset(nodeId) {
    if (nodeId) records.delete(nodeId);
    else records.clear();
  }

  return { checkAndConsume, reset };
}

async function resolveFleet(fleetSource) {
  if (!fleetSource) return null;
  let fleet = fleetSource;
  if (typeof fleet === 'function') fleet = fleet();
  if (fleet && typeof fleet.then === 'function') fleet = await fleet;
  if (!fleet) return null;
  if (typeof fleet.cellStatus === 'function') return await fleet.cellStatus();
  if (typeof fleet.status === 'function') return await fleet.status();
  return fleet;
}

async function processOutbox({
  outbox,
  node,
  storePath,
  ownerId,
  fleetStatus,
  submit,
  now = Date.now,
  rateLimiter,
}) {
  if (!Array.isArray(outbox) || outbox.length === 0) {
    return { outcomes: [], cursor: null };
  }

  const currentTime = typeof now === 'function' ? now() : now;
  const localOwner = typeof ownerId === 'function' ? ownerId() : ownerId;
  const outcomes = [];
  let lastCursor = null;

  // Process up to 1 message per poll (queue of 1 on wire)
  for (const raw of outbox.slice(0, 1)) {
    const { item, id, error } = sanitizeOutboxItem(raw);
    const msgId = item?.id || id || (raw && typeof raw === 'object' && typeof raw.id === 'string' ? raw.id : null);
    if (error || !item) {
      const outcome = `rejected:${error || 'invalid-message'}`;
      outcomes.push({ id: msgId, outcome });
      if (msgId) lastCursor = `${msgId}:${outcome}`;
      continue;
    }

    const [toOwner, toCell] = item.to.split(':');

    // 1. Check federation: only local targets allowed
    if (!localOwner || toOwner !== localOwner) {
      const outcome = 'rejected:remote-unsupported';
      outcomes.push({ id: item.id, outcome });
      lastCursor = `${item.id}:${outcome}`;
      continue;
    }

    // 2. Check ACL (default deny)
    const acl = store.getNodeAcl(storePath, node.nodeId, currentTime);
    if (!acl || !Array.isArray(acl.allowCells) || !acl.allowCells.includes(toCell)) {
      const outcome = 'rejected:acl-denied';
      outcomes.push({ id: item.id, outcome });
      lastCursor = `${item.id}:${outcome}`;
      continue;
    }

    // 3. Check Rate Limit
    if (rateLimiter && !rateLimiter.checkAndConsume(node.nodeId, currentTime)) {
      const outcome = 'rejected:rate-limited';
      outcomes.push({ id: item.id, outcome });
      lastCursor = `${item.id}:${outcome}`;
      continue;
    }

    // 4. Resolve target in local directory
    const resolvedFleet = await resolveFleet(fleetStatus);
    const cells = publicCells(resolvedFleet, localOwner, currentTime);
    const target = cells.find((c) => c.cell === toCell);
    if (!target) {
      const outcome = 'rejected:unknown-target';
      outcomes.push({ id: item.id, outcome });
      lastCursor = `${item.id}:${outcome}`;
      continue;
    }
    if (!target.canReceive) {
      const outcome = 'rejected:target-not-active';
      outcomes.push({ id: item.id, outcome });
      lastCursor = `${item.id}:${outcome}`;
      continue;
    }

    // 5. Deliver through submit seam
    const fromLabel = `VL-${node.nodeId.slice(0, 8)}@${localOwner.slice(0, 8)}`;
    try {
      if (typeof submit !== 'function') {
        throw new Error('cell submit function unavailable');
      }
      const delivery = await deliverCellMessage(submit, target, {
        id: item.id,
        label: fromLabel,
        text: item.text,
      });
      if (delivery && delivery.submitted === true) {
        const outcome = 'submitted';
        outcomes.push({ id: item.id, outcome });
        lastCursor = `${item.id}:${outcome}`;
      } else {
        const outcome = `rejected:${delivery?.reason || 'delivery-failed'}`;
        outcomes.push({ id: item.id, outcome });
        lastCursor = `${item.id}:${outcome}`;
      }
    } catch (e) {
      const outcome = `rejected:${String(e.message || e).slice(0, 48)}`;
      outcomes.push({ id: item.id, outcome });
      lastCursor = `${item.id}:${outcome}`;
    }
  }

  return { outcomes, cursor: lastCursor };
}

module.exports = {
  MAX_OUTBOX_TEXT,
  RATE_LIMIT_MINUTE_CAP,
  RATE_LIMIT_HOUR_CAP,
  sanitizeOutboxItem,
  createRateLimiter,
  processOutbox,
};
