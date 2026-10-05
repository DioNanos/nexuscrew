'use strict';
// Durable receiver-to-owner synchronization. No attempt may submit an answer.
function createImportedDismissalDrainer({ store, relay, now = Date.now, random = Math.random,
  setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 15000,
  globalBudget = 4, ownerBudget = 1, budgetWindowMs = 60000, bindingForOwner = () => null, readonly = () => false, log = () => {} } = {}) {
  const flights = new Set();
  const globalHits = [];
  const ownerHits = new Map();
  let stopped = false;
  let timer = null;
  let running = null;
  function defer(record, reason, blocked = false, retryAfterMs = 0) {
    const attempts = (record.attempts || 0) + 1;
    const delay = Math.max(retryAfterMs, Math.min(300000, 1000 * 2 ** Math.min(attempts, 9)) * (0.5 + random() * 0.5));
    return store.updateImportedDismissal(record.ownerId, record.ownerAskId, {
      syncState: blocked ? 'blocked' : 'pending', retryBinding: bindingForOwner(record.ownerId), attempts, lastReason: reason || 'owner-unreachable', nextRetryAt: now() + delay,
    });
  }
  function rejected(record, result = {}) {
    const reason = result.reason || 'owner-unreachable';
    const transient = ['answering', 'delivery-unknown-block', 'reverse-slot-unverified', 'relay-deadline', 'owner-unreachable', 'federation-peer-unreachable'];
    const pending = transient.includes(reason) || result.code === 429 || result.code >= 500;
    return defer(record, reason, !pending, result.retryAfterMs || 0);
  }
  function confirmed(record, outcome) {
    return store.updateImportedDismissal(record.ownerId, record.ownerAskId, {
      syncState: outcome === 'answered' ? 'confirmed-answered' : 'confirmed-dismissed', ownerOutcome: outcome, lastReason: null,
    });
  }
  async function attempt(record) {
    const key = `${record.ownerId}|${record.ownerAskId}`;
    if (flights.has(key) || stopped || readonly()) return;
    flights.add(key);
    try {
      let current = store.getImportedDismissal(record.ownerId, record.ownerAskId);
      if (!current || current.syncState !== 'pending') return;
      const result = await relay.inspectDismissal({ ownerId: record.ownerId, askId: record.ownerAskId });
      if (stopped || readonly()) return;
      current = store.getImportedDismissal(record.ownerId, record.ownerAskId);
      if (!current || current.syncState !== 'pending' || current.dismissedTs !== record.dismissedTs) return;
      if (!result.ok) { rejected(current, result); return; }
      if (result.generationPrecondition !== true) { defer(current, 'unsupported', true); return; }
      if (!result.ask || (result.ask.ownerAskId || result.ask.id) !== current.ownerAskId
        || store.askFingerprint(result.ask) !== current.ownerAskFingerprint
        || !Number.isSafeInteger(result.ask.ts) || result.ask.ts <= 0
        || (current.generation === 'known' && current.ownerAskTs !== result.ask.ts)) {
        defer(current, 'generation-mismatch', true); return;
      }
      const adopted = store.adoptImportedDismissal(current.ownerId, current.ownerAskId, result.ask);
      if (!adopted.ok) { log(`dismissal adoption refused: ${adopted.reason}`); return; }
      current = adopted.record;
      if (['answered', 'dismissed'].includes(result.status)) { confirmed(current, result.status); return; }
      if (result.status !== 'open') { rejected(current, { code: 409, reason: result.status || 'unknown' }); return; }
      // The timestamp is durable before the request and checked atomically by
      // the owner. A lost response leaves the record pending for reconciliation.
      const out = await relay.relayDismiss({ ownerId: current.ownerId, askId: current.ownerAskId, expectedTs: current.ownerAskTs });
      if (stopped || readonly()) return;
      const latest = store.getImportedDismissal(current.ownerId, current.ownerAskId);
      if (!latest || latest.syncState !== 'pending' || latest.dismissedTs !== current.dismissedTs) return;
      if (out.ok && ['answered', 'dismissed'].includes(out.outcome)) confirmed(latest, out.outcome);
      else rejected(latest, out.ok ? { code: 409, reason: 'unsupported' } : out);
    } catch (error) {
      const current = store.getImportedDismissal(record.ownerId, record.ownerAskId);
      if (!stopped && current && current.syncState === 'pending') defer(current, 'owner-unreachable');
      log(`dismissal synchronization failed: ${String(error.message || error)}`);
    } finally { flights.delete(key); }
  }
  async function run() {
    if (stopped || readonly()) return;
    const t = now();
    const prune = hits => { while (hits.length && hits[0] <= t - budgetWindowMs) hits.shift(); };
    prune(globalHits);
    for (const [ownerId, hits] of ownerHits) { prune(hits); if (!hits.length) ownerHits.delete(ownerId); }
    for (let record of store.listImportedDismissals()) {
      if (globalHits.length >= globalBudget) break;
      if (record.syncState === 'blocked' && record.lastReason !== 'generation-mismatch') {
        const binding = bindingForOwner(record.ownerId);
        if (binding !== null && binding !== record.retryBinding) {
          const resumed = store.updateImportedDismissal(record.ownerId, record.ownerAskId, { syncState: 'pending', nextRetryAt: 0, retryBinding: binding });
          if (resumed.ok) record = resumed.record;
        }
      }
      if (record.syncState !== 'pending' || (record.nextRetryAt || 0) > now()) continue;
      const hits = ownerHits.get(record.ownerId) || [];
      if (hits.length >= ownerBudget) continue;
      hits.push(t); ownerHits.set(record.ownerId, hits); globalHits.push(t);
      await attempt(record);
    }
  }
  function drain() {
    if (running) return running;
    const flight = run().finally(() => { if (running === flight) running = null; });
    running = flight;
    return flight;
  }
  function schedule() {
    if (stopped || timer) return;
    timer = setTimer(() => { timer = null; void drain().catch(error => log(String(error.message || error))).finally(schedule); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function start() { schedule(); void drain().catch(error => log(String(error.message || error))); }
  function stop() { stopped = true; if (timer) clearTimer(timer); timer = null; }
  function nudge() { if (!stopped) void drain().catch(error => log(String(error.message || error))); }
  return { start, stop, drain, nudge };
}
module.exports = { createImportedDismissalDrainer };
