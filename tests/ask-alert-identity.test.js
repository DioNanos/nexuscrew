'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier } = require('../lib/notify/notifier.js');
const { buildEnvelope } = require('../lib/notify/event-feed-producers.js');
const { buildPayload } = require('../lib/notify/push-relay.js');
const ownerId = 'a'.repeat(32);
const identity = { ownerId, askId: 'abcdef01', ownerAskTs: 1700000000000 };
function frame(over = {}) { return { title: 'question', body: 'continue?', urgency: 'high', ...identity, ...over }; }
test('the direct notifier preserves canonical ASK identity in UI and push', async () => {
  const ui = []; const sent = [];
  const n = createNotifier({ hub: { broadcast: f => { ui.push(f); return 1; } }, push: { sendToAll: async p => { sent.push(p); return { sent: 1 }; } } });
  await n.emit(frame());
  for (const f of [ui[0], sent[0]]) for (const [key, value] of Object.entries(identity)) assert.equal(f[key], value, key);
  assert.match(sent[0].tag, /^nc:ask:[a-f0-9]{64}$/);
});
test('distinct ASK generations and owners have distinct direct push tags', async () => {
  const sent = []; const n = createNotifier({ hub: { broadcast: () => 0 }, push: { sendToAll: async p => { sent.push(p); return { sent: 1 }; } } });
  for (const over of [{}, { askId: 'abcdef02' }, { ownerAskTs: identity.ownerAskTs + 1 }, { ownerId: 'b'.repeat(32) }]) await n.emit(frame(over));
  assert.equal(new Set(sent.map(p => p.tag)).size, 4);
});
test('the real feed producer and relay keep ASK generation and the same canonical tag as direct push', async () => {
  const sent = []; const n = createNotifier({ hub: { broadcast: () => 0 }, push: { sendToAll: async p => { sent.push(p); return { sent: 1 }; } } });
  await n.emit(frame());
  const envelope = buildEnvelope({ type: 'notify', ownerId, cellId: 'dev', payload: frame() });
  assert.equal(envelope.frame.ownerAskTs, identity.ownerAskTs);
  const imported = buildPayload(envelope);
  assert.equal(imported.ownerAskTs, identity.ownerAskTs);
  assert.equal(imported.tag, sent[0].tag);
});

test('direct notifications share canonical admission for concurrent fan-out and feed replay', async () => {
  const seen = new Set(); let claims = 0; const calls = [];
  const alertRegistry = {
    claim(f, channel) { claims++; const key = `${f.ownerId}|${f.askId}|${f.ownerAskTs}|${channel}`; if (seen.has(key)) return { allowed: false, reason: 'already-alerted' }; seen.add(key); return { allowed: true }; },
    complete() {},
  };
  const n = createNotifier({ alertRegistry, hub: { broadcast: () => { calls.push('ui'); return 1; } }, push: { sendToAll: async () => { calls.push('push'); return { sent: 1 }; } } });
  await Promise.all([n.emit(frame()), n.emit(frame({ eventId: 'feed-replay' }))]);
  assert.equal(claims, 4, 'both channels consult the shared question registry');
  assert.deepEqual(calls, ['ui', 'push']);
});
test('zero delivery distinguishes persisted ASK from successful alert delivery', async () => {
  const n = createNotifier({ hub: { broadcast: () => 0 }, push: { sendToAll: async () => ({ sent: 0 }) } });
  const result = await n.emit(frame());
  assert.equal(result.ui, 0); assert.equal(result.push, 0);
  assert.equal(result.alertStatus, 'no-delivery');
});
test('a failed push is observable without rejecting or recreating the ASK', async () => {
  const n = createNotifier({ hub: { broadcast: () => 0 }, push: { sendToAll: async () => { throw new Error('provider unavailable'); } } });
  const result = await n.emit(frame());
  assert.equal(result.alertStatus, 'no-delivery');
  assert.equal(result.pushReason, 'send-failed');
});

for (const feedFirst of [false, true]) test(`direct notifier and real imported relay share one push admission (${feedFirst ? 'feed first' : 'fan-out first'})`, async t => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const { createAskAlertRegistry } = require('../lib/notify/ask-alert-registry.js');
  const { createPushRelay, createPushDedup } = require('../lib/notify/push-relay.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-shared-admission-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = createAskAlertRegistry({ filePath: path.join(dir, 'ask-alerts.json') }); const sent = [];
  const send = async p => { sent.push(p); return { sent: 1 }; };
  const n = createNotifier({ alertRegistry: registry, hub: { broadcast: () => 1 }, push: { sendToAll: send } });
  const relay = createPushRelay({ alertRegistry: registry, pushDedup: createPushDedup({ filePath: path.join(dir, 'events.json') }), send, sendTimeoutMs: 20 });
  const envelope = buildEnvelope({ type: 'notify', ownerId, cellId: 'dev', payload: frame() });
  if (feedFirst) { relay.consider(envelope); await new Promise(resolve => setImmediate(resolve)); await n.emit(frame()); }
  else { await n.emit(frame()); relay.consider(envelope); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1, 'same canonical question across actual direct and imported paths');
});

test('a real feed ASK frame admits historical alert generation before the following notification', async t => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const { createAskAlertRegistry } = require('../lib/notify/ask-alert-registry.js');
  const { askFingerprint } = require('../lib/notify/asks.js');
  const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-generation-feed-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = createAskAlertRegistry({ filePath: path.join(dir, 'ask-alerts.json') });
  const ask = { id: identity.askId, question: 'continue?', options: ['yes'], session: 'cloud-reviewer' };
  const old = { ownerId, askId: ask.id, ownerAskFingerprint: askFingerprint(ask) };
  registry.claim(old, 'push'); registry.complete(old, 'push', 1);
  const client = createEventFeedClient({ loadStore: () => ({ nodeId: 'b'.repeat(32), nodes: [] }), eventsHub: { broadcast() {} },
    onAuthoritativeAsks: (owner, asks) => { for (const a of asks) registry.adopt(owner, a, a.ownerAskTs); }, log() {},
  }); t.after(() => client.stop());
  client.reemit({ ownerId, eventId: 'owner-ask-frame', hop: 1, scope: 'cell', cellId: 'reviewer', frame: { type: 'ask', askId: ask.id, askTs: identity.ownerAskTs, question: ask.question, options: ask.options, session: ask.session, ts: identity.ownerAskTs + 99 } });
  assert.equal(registry.claim(frame(), 'push').allowed, false, 'the real feed callback must preserve historical alert admission');
});

test('historical feed notify derives only a server-side fingerprint from a fresh matching full ASK', t => {
  const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');
  const { askFingerprint } = require('../lib/notify/asks.js');
  const emitted = []; const authoritative = [];
  const client = createEventFeedClient({ loadStore: () => ({ nodeId: 'b'.repeat(32), nodes: [] }), eventsHub: { broadcast: f => emitted.push(f) },
    onAuthoritativeAsks: (owner, asks) => authoritative.push({ owner, asks }), log() {} }); t.after(() => client.stop());
  const ask = { id: identity.askId, question: 'continue?', options: ['yes'], session: 'cloud-reviewer', ts: identity.ownerAskTs };
  const view = client.viewFor(ownerId); view.stale = false; view.asks = [ask];
  const legacy = { ownerId, eventId: 'historic-notify', hop: 1, scope: 'cell', cellId: 'reviewer', frame: { type: 'notify', askId: ask.id, title: 'domanda', body: ask.question, ts: identity.ownerAskTs + 999 } };
  client.reemit(legacy);
  assert.equal(emitted[0].ownerAskFingerprint, askFingerprint(ask), 'full owner view supplies the historical fingerprint');
  assert.equal(emitted[0].ownerAskTs, undefined, 'notification timestamp cannot assert a generation');
  assert.equal(authoritative.length, 2, 'adoption runs before and after admission so a first historical alert is bound');
  view.stale = true; client.reemit({ ...legacy, eventId: 'stale-notify' });
  assert.equal(emitted[1].ownerAskFingerprint, undefined, 'stale state cannot identify the historical question');
  view.stale = false; client.reemit({ ...legacy, eventId: 'different-question', frame: { ...legacy.frame, body: 'another question' } });
  assert.equal(emitted[2].ownerAskFingerprint, undefined, 'ID alone cannot identify a reused question');
});
