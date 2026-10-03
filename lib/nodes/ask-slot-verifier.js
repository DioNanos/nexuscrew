'use strict';
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { probeReverseSlot } = require('./reverse-slot-proof.js');

const PROOF_TTL_MS = 10000;
const MAX_PROOFS = 256;

function channel(peer) {
  const pool = peer && peer.reversePool;
  const slot = pool && Array.isArray(pool.slots) && pool.slots[pool.activeSlot];
  if (!peer || peer.direction !== 'inbound' || peer.shared !== true || !peer.token || !peer.nodeId
    || !slot || slot.state !== 'active' || !Number.isInteger(slot.port) || slot.port < 1 || slot.port > 65535
    || !Number.isSafeInteger(pool.activeGeneration) || pool.activeGeneration < 1
    || slot.generation !== pool.activeGeneration) return null;
  return { port: slot.port, generation: pool.activeGeneration, instanceId: peer.nodeId };
}
function binding(store, peer) {
  const selected = channel(peer);
  if (!store || !selected) return null;
  const key = JSON.stringify([store.nodeId, peer.name, peer.nodeId, selected.port, selected.generation]);
  // The whole peer includes pool, credential, direction, sharing and ACL.
  // Only an in-process fingerprint is retained; it never enters responses/logs.
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([store.nodeId, peer])).digest('hex');
  return { key, fingerprint, selected };
}

function createAskSlotVerifier({ now = () => performance.now() } = {}) {
  const entries = new Map();
  function sync(store, scope = store && store.nodeId) {
    const at = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) { entries.delete(key); continue; }
      if (entry.scope !== scope) continue;
      const peer = store && (store.nodes || []).find(node => node.name === entry.name);
      const current = binding(store, peer);
      if (!current || current.key !== key || current.fingerprint !== entry.fingerprint) entries.delete(key);
    }
  }
  function invalidate(key) { if (key) entries.delete(key); }
  async function verify({ store, peer, loadStore, signal, scope = store && store.nodeId, probeImpl = probeReverseSlot } = {}) {
    sync(store, scope);
    const selected = binding(store, peer);
    if (!selected || (signal && signal.aborted)) return { owned: false, code: 'reverse-slot-proof-unavailable' };
    const cached = entries.get(selected.key);
    if (cached && cached.fingerprint === selected.fingerprint) {
      entries.delete(selected.key); entries.set(selected.key, cached); // LRU only: expiry never slides.
      return { owned: true, key: selected.key, code: 'reverse-slot-owned' };
    }
    invalidate(selected.key);
    let proof;
    try { proof = await probeImpl({ port: selected.selected.port, secret: peer.token,
      expected: { remotePort: selected.selected.port, generation: selected.selected.generation, instanceId: peer.nodeId },
      timeoutMs: 6000, signal }); }
    catch (_) { proof = { owned: false, code: 'reverse-slot-proof-unavailable' }; }
    const freshStore = typeof loadStore === 'function' ? loadStore() : store;
    sync(freshStore, scope);
    const freshPeer = freshStore && (freshStore.nodes || []).find(node => node.name === peer.name);
    const fresh = binding(freshStore, freshPeer);
    if ((signal && signal.aborted) || !fresh || fresh.key !== selected.key || fresh.fingerprint !== selected.fingerprint
      || !proof || proof.owned !== true) {
      invalidate(selected.key);
      return { owned: false, code: proof && proof.code || 'reverse-slot-proof-unavailable' };
    }
    entries.set(selected.key, { scope, name: peer.name, fingerprint: selected.fingerprint, expiresAt: now() + PROOF_TTL_MS });
    while (entries.size > MAX_PROOFS) entries.delete(entries.keys().next().value);
    return { owned: true, key: selected.key, code: 'reverse-slot-owned' };
  }
  return { verify, invalidate, sync };
}
const askSlotVerifier = createAskSlotVerifier();
module.exports = { channel, binding, createAskSlotVerifier, askSlotVerifier };
