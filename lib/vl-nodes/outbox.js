'use strict';

const { deliverCellMessage } = require('../cells/deliver.js');
const { publicCells } = require('../cells/routes.js');
const { submitTextOk } = require('../tmux/actions.js');
const store = require('./store.js');

const MAX_OUTBOX_TEXT = 2048; // 2 KiB
const RATE_LIMIT_MINUTE_CAP = 6;
const RATE_LIMIT_HOUR_CAP = 20;
const RATE_LIMIT_MINUTE_MS = 60_000;
const RATE_LIMIT_HOUR_MS = 3_600_000;
const MSG_ID_RE = /^[a-f0-9]{32}$/;
const TARGET_RE = /^[a-f0-9]{16,64}:[A-Za-z0-9._-]{1,64}$/;
// Simple cell name (`Dev`): resolves to the LOCAL cell of the hub owner.
const SIMPLE_TARGET_RE = /^[A-Za-z0-9._-]{1,32}$/;

// In-process registry of ids currently being settled, so a concurrent
// presentation of the same id joins the first run instead of delivering again.
const inflightSettles = new Map(); // nodeId -> Map<id, Promise<outcome>>

function inflightGet(nodeId, id) {
  return inflightSettles.get(nodeId)?.get(id) || null;
}

function inflightSet(nodeId, id, promise) {
  if (!inflightSettles.has(nodeId)) inflightSettles.set(nodeId, new Map());
  inflightSettles.get(nodeId).set(id, promise);
}

function inflightDelete(nodeId, id) {
  const map = inflightSettles.get(nodeId);
  if (!map) return;
  map.delete(id);
  if (!map.size) inflightSettles.delete(nodeId);
}

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
  if (typeof raw.to !== 'string'
    || !(TARGET_RE.test(raw.to) || SIMPLE_TARGET_RE.test(raw.to))) {
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
  // The text of a cell message is validated with the SAME rule of the send
  // route: what a cell message must satisfy to be delivered at all.
  if (!submitTextOk(raw.text)) {
    return { id: raw.id, item: null, error: 'invalid-text' };
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

  function windowCounts(nodeId, now) {
    const hourCutoff = now - RATE_LIMIT_HOUR_MS;
    const hour = (records.get(nodeId) || []).filter((ts) => ts > hourCutoff);
    records.set(nodeId, hour);
    const minuteCutoff = now - RATE_LIMIT_MINUTE_MS;
    return {
      minute: hour.filter((ts) => ts > minuteCutoff).length,
      hour: hour.length,
    };
  }

  // Non-consuming probe: would a message from this node be admitted right now?
  function check(nodeId, now) {
    const { minute, hour } = windowCounts(nodeId, now);
    return minute < RATE_LIMIT_MINUTE_CAP && hour < RATE_LIMIT_HOUR_CAP;
  }

  function checkAndConsume(nodeId, now) {
    if (!check(nodeId, now)) return false;
    records.get(nodeId).push(now);
    return true;
  }

  function reset(nodeId) {
    if (nodeId) records.delete(nodeId);
    else records.clear();
  }

  return { check, checkAndConsume, reset };
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

// Resolve and deliver a single outbox item. Returns the FINAL outcome string
// (`submitted` or `rejected:<reason>`). Authorization is re-evaluated
// immediately before the submit: an ACL revoked while the fleet
// directory was resolving ends in `rejected:acl-revoked` with no delivery.
// The read-only gate is read the same way: a server that became read-only
// while the directory was resolving ends in `rejected:readonly`.
async function settleItem({ raw, node, storePath, localOwner, fleetStatus, submit, rateLimiter, currentTime, readonly }) {
  // The gate of the send route, read from its source every time it matters:
  // a read-only server delivers nothing. The outcome is `rejected:readonly`,
  // exactly like the other refusals of the outbox.
  const readOnly = () => typeof readonly === 'function' && readonly();
  // At the entry, before every other check.
  if (readOnly()) {
    return 'rejected:readonly';
  }
  const { item, error } = sanitizeOutboxItem(raw);
  if (error || !item) {
    return `rejected:${error || 'invalid-message'}`;
  }

  // A simple cell name addresses the LOCAL cell of the hub owner.
  let toOwner;
  let toCell;
  if (item.to.includes(':')) {
    [toOwner, toCell] = item.to.split(':');
  } else {
    toOwner = localOwner;
    toCell = item.to;
  }

  // 1. Federation: only local targets allowed (closed by default)
  if (!localOwner || toOwner !== localOwner) {
    return 'rejected:remote-unsupported';
  }

  const aclAllows = (cell) => {
    const acl = store.getNodeAcl(storePath, node.nodeId, currentTime);
    return Boolean(acl && Array.isArray(acl.allowCells) && acl.allowCells.includes(cell));
  };

  // 2. ACL pre-check (default deny) — fail fast before any async work
  if (!aclAllows(toCell)) {
    return 'rejected:acl-denied';
  }

  // 3. Rate limit pre-check (non-consuming probe)
  if (rateLimiter && !rateLimiter.check(node.nodeId, currentTime)) {
    return 'rejected:rate-limited';
  }

  // 4. Resolve target in local directory (async: the revocation window)
  const resolvedFleet = await resolveFleet(fleetStatus);
  // The gate is read again after the wait: a server that became read-only
  // while the directory was resolving admits nothing, and the rate limit
  // is not consumed for a delivery that will not happen.
  if (readOnly()) {
    return 'rejected:readonly';
  }
  const cells = publicCells(resolvedFleet, localOwner, currentTime);
  const target = cells.find((c) => c.cell === toCell);
  if (!target) {
    return 'rejected:unknown-target';
  }
  if (!target.canReceive) {
    return 'rejected:target-not-active';
  }

  // 5. Authorization re-evaluated immediately before the submit.
  if (!aclAllows(toCell)) {
    return 'rejected:acl-revoked';
  }
  // The last gate before the delivery: nothing is delivered by a server that
  // is read-only at this point.
  if (readOnly()) {
    return 'rejected:readonly';
  }
  // The authoritative rate-limit consumption happens here, at delivery time.
  if (rateLimiter && !rateLimiter.checkAndConsume(node.nodeId, currentTime)) {
    return 'rejected:rate-limited';
  }

  // 6. Deliver through submit seam
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
      return 'submitted';
    }
    return `rejected:${delivery?.reason || 'delivery-failed'}`;
  } catch (e) {
    return `rejected:${String(e.message || e).slice(0, 48)}`;
  }
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
  readonly,
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
    const rawId = raw && typeof raw === 'object' && typeof raw.id === 'string' ? raw.id : null;
    const trackableId = rawId && MSG_ID_RE.test(rawId) ? rawId : null;
    const msgId = trackableId || rawId;
    const emit = (outcome) => {
      outcomes.push({ id: msgId, outcome });
      if (msgId) lastCursor = `${msgId}:${outcome}`;
    };

    let run = null;
    if (trackableId) {
      // An id currently being settled joins the first run instead of
      // triggering a second delivery.
      run = inflightGet(node.nodeId, trackableId);
      if (!run && storePath) {
        // An id already settled returns its previous outcome, without
        // delivering again (TTL and caps are enforced by the store).
        const seen = store.getSeenOutcome(storePath, node.nodeId, trackableId, currentTime);
        if (seen !== null) {
          emit(seen);
          continue;
        }
      }
      if (!run) {
        const settle = settleItem({
          raw,
          node,
          storePath,
          localOwner,
          fleetStatus,
          submit,
          rateLimiter,
          currentTime,
          readonly,
        }).then((outcome) => {
          if (storePath) {
            try {
              store.recordSeenOutcome(storePath, node.nodeId, { id: trackableId, outcome, at: currentTime }, currentTime);
            } catch (_) { /* store issues must not corrupt the outcome */ }
          }
          return outcome;
        });
        inflightSet(node.nodeId, trackableId, settle);
        run = settle;
      }
    }

    if (run) {
      let outcome;
      try {
        outcome = await run;
      } finally {
        if (trackableId) inflightDelete(node.nodeId, trackableId);
      }
      emit(outcome);
      continue;
    }

    // No trackable id (invalid or missing): settle without dedup bookkeeping.
    emit(await settleItem({
      raw,
      node,
      storePath,
      localOwner,
      fleetStatus,
      submit,
      rateLimiter,
      currentTime,
      readonly,
    }));
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
