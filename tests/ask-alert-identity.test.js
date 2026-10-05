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
