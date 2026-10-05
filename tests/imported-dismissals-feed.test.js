'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAsksStore } = require('../lib/notify/asks.js');
const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');
const OWNER = 'b'.repeat(32), OTHER = 'c'.repeat(32), SELF = 'a'.repeat(32), ID = '12345678';
const question = () => ({ id: ID, ts: 100, question: 'Review?', options: ['Yes'], session: 'reviewer' });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismissal-feed-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'asks.json'); let store = createAsksStore({ dir }); let epoch = 1, clock = 1000, asks = [question()], hold = null;
  const broadcast = [];
  function client() {
    const value = createEventFeedClient({ now: () => clock, minSnapshotIntervalMs: 0, pollMs: 60000,
      isAskDismissed: (owner, ask) => store.isImportedDismissed(owner, ask),
      onAskClosed: (ownerId, ownerAskId, outcome) => store.closeImported({ ownerId, ownerAskId, outcome }),
      eventsHub: { broadcast: frame => broadcast.push(frame) },
      loadStore: () => ({ nodeId: SELF, nodes: [{ name: 'owner', nodeId: OWNER, direction: 'outbound', token: 'fixture', eventsReceive: true, localPort: 42001 }] }),
      fetchImpl: async (url, options = {}) => {
        if (url.includes('/federation/health')) return { ok: true, status: 200, json: async () => ({ ok: true, instanceId: OWNER, eventFeedV1: true }) };
        if (url.includes('/event-feed/snapshot')) return { ok: true, status: 200, text: async () => { const snapshot = JSON.stringify({ ownerId: OWNER, cursor: '1:0', viewEpoch: epoch, asks, notifications: [] }); if (hold) await hold; return snapshot; } };
        return { ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })), cancel: async () => {} }) } };
      },
    }); t.after(() => value.stop()); return value;
  }
  const dismiss = () => { const out = store.dismissImported({ ownerId: OWNER, ownerAskId: ID, ask: question() }); assert.equal(out.ok, true); };
  return { client, dismiss, broadcast, store: () => store, restart() { store = createAsksStore({ dir }); }, changeEpoch() { epoch++; clock += 11 * 60000; }, setAsks(value) { asks = value; }, hold(value) { hold = value; } };
}
async function round(client) { client.start(); await new Promise(resolve => setImmediate(resolve)); client.stop(); assert.deepEqual(client.viewFor(OWNER).asks, client.state().views[0]?.asks || [], 'snapshot cache and aggregated view agree'); return client.state().views[0]?.asks || []; }
test('durable suppression survives subscriber and store restart past TTL and epoch reset', async t => {
  const f = fixture(t); f.dismiss(); assert.deepEqual(await round(f.client()), []);
  f.restart(); f.changeEpoch(); assert.deepEqual(await round(f.client()), []);
});
test('snapshot suppression is evaluated after an in-flight response completes', async t => {
  const f = fixture(t); let release; const held = new Promise(resolve => { release = resolve; }); f.hold(held);
  const client = f.client(); client.start(); await new Promise(resolve => setImmediate(resolve)); f.dismiss(); release();
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(client.viewFor(OWNER).asks, []); assert.deepEqual(client.state().views[0].asks, []); client.stop();
});
test('a replacement fingerprint or timestamp remains visible in snapshots', async t => {
  const f = fixture(t); f.dismiss(); f.setAsks([{ ...question(), question: 'New review?' }, { ...question(), id: '87654321' }]);
  assert.equal((await round(f.client())).length, 2);
  f.setAsks([{ ...question(), ts: 101 }]); assert.equal((await round(f.client())).length, 1);
});
test('aggregated reads filter existing views using the live owner-qualified dismissal store', t => {
  const f = fixture(t), client = f.client(); client.viewFor(OWNER).asks = [{ ...question(), id: '87654321', ownerAskId: ID }];
  client.viewFor(OTHER).asks = [question()]; f.dismiss(); const views = client.state().views;
  assert.deepEqual(views.find(v => v.ownerId === OWNER).asks, []); assert.equal(views.find(v => v.ownerId === OTHER).asks.length, 1);
});
test('late imported ask frames are suppressed before local SSE emission', t => {
  const f = fixture(t), client = f.client(); f.dismiss();
  const frame = { type: 'ask', askId: ID, ...question(), askTs: question().ts };
  assert.equal(client.reemit({ ownerId: OWNER, eventId: 'old', hop: 1, frame }), false);
  assert.deepEqual(f.broadcast, []);
  assert.equal(client.reemit({ ownerId: OWNER, eventId: 'new', hop: 1, frame: { ...frame, askTs: 101, ts: 999 } }), true);
  assert.equal(f.broadcast[0].ask.ownerAskTs, 101);
});

test('an authoritative feed closure updates a feed-only locally dismissed record', t => {
  const f = fixture(t), client = f.client(); f.dismiss();
  client.reemit({ ownerId: OWNER, eventId: 'closed', hop: 1, frame: { type: 'ask-closed', askId: ID, outcome: 'answered' } });
  assert.equal(f.store().getImportedDismissal(OWNER, ID).syncState, 'confirmed-answered');
  assert.equal(f.store().getImportedDismissal(OWNER, ID).ownerOutcome, 'answered');
});
