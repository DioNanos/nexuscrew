'use strict';

const crypto = require('node:crypto');
const { NODE_ID_RE } = require('./store.js');

const SESSION_RE = /^[a-f0-9]{32}$/;
const PROTOCOL = 'vl-node/1';
const MAX_WAIT_MS = 30_000;
const ONLINE_GRACE_MS = 45_000;

function boundedString(value, max = 128) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, max) : '';
}

function boundedInteger(value, min, max, fallback = 0) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

function sanitizeAck(raw) {
  if (!raw || !/^[a-f0-9]{32}$/.test(String(raw.id || ''))) return null;
  if (!['ok', 'error', 'rejected'].includes(raw.status)) return null;
  const result = raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result)
    ? JSON.parse(JSON.stringify(raw.result).slice(0, 16_384)) : null;
  return { id: raw.id, status: raw.status, ...(result ? { result } : {}) };
}

function sanitizeHealth(raw) {
  const health = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    state: ['starting', 'running', 'stopped', 'degraded', 'error'].includes(health.state)
      ? health.state : 'degraded',
    uptimeSec: boundedInteger(health.uptimeSec, 0, Number.MAX_SAFE_INTEGER),
    rssBytes: boundedInteger(health.rssBytes, 0, 1 << 30),
    processCount: boundedInteger(health.processCount, 1, 16, 1),
    brokerReachable: health.brokerReachable === true,
    childPid: boundedInteger(health.childPid, 1, 1 << 30, 0) || null,
    batteryPercent: boundedInteger(health.batteryPercent, 0, 100, -1),
    detail: boundedString(health.detail, 256),
  };
}

function sanitizeHeartbeat(raw) {
  if (!raw || raw.protocol !== PROTOCOL || !SESSION_RE.test(String(raw.sessionId || ''))
    || !Number.isSafeInteger(raw.seq) || raw.seq < 0) return null;
  const capabilities = Array.isArray(raw.capabilities)
    ? [...new Set(raw.capabilities.filter((item) => /^[a-z][a-z0-9_]{0,31}$/.test(String(item))))].slice(0, 32)
    : [];
  return {
    protocol: PROTOCOL,
    sessionId: raw.sessionId,
    seq: raw.seq,
    version: boundedString(raw.version, 64),
    capabilities,
    health: sanitizeHealth(raw.health),
    ack: sanitizeAck(raw.ack),
  };
}

function createBroker(options = {}) {
  const now = options.now || Date.now;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const states = new Map();

  function ensure(node) {
    let state = states.get(node.nodeId);
    if (!state) {
      state = {
        nodeId: node.nodeId,
        label: node.label,
        pairedAt: node.pairedAt,
        lastSeen: null,
        heartbeat: null,
        generation: 0,
        waiter: null,
        inflight: null,
        lastAck: null,
      };
      states.set(node.nodeId, state);
    }
    state.label = node.label;
    state.pairedAt = node.pairedAt;
    return state;
  }

  function finishWaiter(state, value) {
    const waiter = state.waiter;
    if (!waiter) return false;
    state.waiter = null;
    clearTimer(waiter.timer);
    waiter.cleanup?.();
    waiter.resolve(value);
    return true;
  }

  function observe(node, raw) {
    const heartbeat = sanitizeHeartbeat(raw);
    if (!heartbeat) return { ok: false, code: 'invalid-heartbeat' };
    // Reaching this authenticated endpoint is itself the end-to-end proof.
    // Do not preserve a stale false value from the instant before send().
    heartbeat.health.brokerReachable = true;
    const state = ensure(node);
    const sameSession = Boolean(state.heartbeat
      && state.heartbeat.sessionId === heartbeat.sessionId);
    if (sameSession
      && heartbeat.seq <= state.heartbeat.seq) return { ok: false, code: 'stale-sequence' };
    if (!sameSession) {
      state.generation += 1;
      finishWaiter(state, { type: 'superseded', generation: state.generation });
      if (state.inflight) {
        state.lastAck = {
          id: state.inflight.id,
          status: 'error',
          result: { code: 'stale-session', detail: 'device session changed before ack' },
          at: now(),
        };
        state.inflight = null;
      }
    }
    state.lastSeen = now();
    state.heartbeat = heartbeat;
    let acknowledged = false;
    if (heartbeat.ack && state.inflight && heartbeat.ack.id === state.inflight.id) {
      state.lastAck = { ...heartbeat.ack, at: state.lastSeen };
      state.inflight = null;
      acknowledged = true;
    } else if (state.inflight && sameSession) {
      state.lastAck = {
        id: state.inflight.id,
        status: 'error',
        result: {
          code: 'delivery-unknown',
          detail: 'device repolled without acknowledging the dispatched command',
        },
        at: state.lastSeen,
      };
      state.inflight = null;
    }
    return { ok: true, state, acknowledged };
  }

  function poll(node, rawHeartbeat, { waitMs = MAX_WAIT_MS, signal = null } = {}) {
    const observed = observe(node, rawHeartbeat);
    if (!observed.ok) return Promise.resolve({ type: 'error', code: observed.code });
    const state = observed.state;
    finishWaiter(state, { type: 'superseded', generation: state.generation });
    if (observed.acknowledged) {
      return Promise.resolve({ type: 'acknowledged', generation: state.generation });
    }
    const boundedWait = Math.max(1, Math.min(MAX_WAIT_MS, Number(waitMs) || MAX_WAIT_MS));
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null, cleanup: null };
      waiter.timer = setTimer(() => {
        if (state.waiter === waiter) state.waiter = null;
        waiter.cleanup?.();
        resolve({ type: 'idle', generation: state.generation });
      }, boundedWait);
      waiter.timer.unref?.();
      if (signal) {
        const onAbort = () => {
          if (state.waiter === waiter) state.waiter = null;
          clearTimer(waiter.timer);
          resolve({ type: 'aborted', generation: state.generation });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      state.waiter = waiter;
    });
  }

  function dispatch(nodeId, command) {
    if (!NODE_ID_RE.test(String(nodeId || ''))) return { ok: false, code: 'invalid-node-id' };
    const state = states.get(nodeId);
    if (!state || !state.waiter || !state.heartbeat || now() - state.lastSeen > ONLINE_GRACE_MS) {
      return { ok: false, code: 'node-offline' };
    }
    if (state.inflight) return { ok: false, code: 'command-in-flight' };
    const id = randomBytes(16).toString('hex');
    const envelope = { id, issuedAt: now(), generation: state.generation, ...command };
    state.inflight = { id, kind: command.kind, status: 'submitted', submittedAt: envelope.issuedAt };
    if (!finishWaiter(state, { type: 'command', command: envelope })) {
      state.inflight = null;
      return { ok: false, code: 'node-offline' };
    }
    return { ok: true, id, status: 'submitted', generation: state.generation };
  }

  function forget(nodeId) {
    const state = states.get(nodeId);
    if (state) finishWaiter(state, { type: 'revoked' });
    return states.delete(nodeId);
  }

  function list(nodes) {
    const at = now();
    return nodes.map((node) => {
      const state = states.get(node.nodeId);
      const online = Boolean(state && (state.waiter || state.inflight)
        && state.lastSeen !== null && at - state.lastSeen <= ONLINE_GRACE_MS);
      return {
        ...node,
        online,
        lastSeen: state?.lastSeen ?? null,
        generation: state?.generation ?? 0,
        version: state?.heartbeat?.version || '',
        capabilities: state?.heartbeat?.capabilities || [],
        health: state?.heartbeat?.health || null,
        inflight: state?.inflight || null,
        lastAck: state?.lastAck || null,
      };
    });
  }

  return { poll, dispatch, forget, list, observe, _states: states };
}

module.exports = {
  SESSION_RE,
  PROTOCOL,
  MAX_WAIT_MS,
  ONLINE_GRACE_MS,
  sanitizeHeartbeat,
  sanitizeHealth,
  sanitizeAck,
  createBroker,
};
