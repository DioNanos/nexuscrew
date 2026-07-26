'use strict';
// tests/audio-speak.test.js — WP2R: speak/stop gate logic. text 1..320; target
// gates ACL/consent/READONLY/idempotency/rate; exact target only; adapter honest.
// Idempotency BEFORE rate (identical retry does not consume rate); collision
// fail-closed.
const { test } = require('node:test');
const assert = require('node:assert');
const { handleSpeak, handleStop } = require('../lib/audio/speak.js');
const { createReceiptStore } = require('../lib/audio/receipt.js');
const { createSpeakRateLimiter } = require('../lib/audio/rate-limit.js');

const TARGET = 'a'.repeat(32);
const ORIGIN = { node: 'b'.repeat(32), cell: 'cellA' };
const TEXT = 'hello';

function deps({ readonly = false, allows = true, consent = true, reachable = true, adapter = null, rl, rs } = {}) {
  const store = rs || createReceiptStore({ now: () => 0 });
  return {
    store, rateLimiter: rl || undefined,
    readonly: () => readonly,
    targetAllowsOrigin: () => allows,
    targetConsent: () => consent,
    targetReachable: () => reachable,
    adapter,
    receipt: (status, o) => store.record({ caller: o.origin && o.origin.cell, origin: o.origin, target: o.target, status, reason: o.reason, utteranceId: o.utteranceId }),
    findReceipt: (id, caller, target) => store.find(id, caller, target),
  };
}

test('speak: text obbligatorio 1..320; vuoto o 321 => refused invalid-text', () => {
  const d = deps();
  assert.equal(handleSpeak({ target: TARGET, origin: ORIGIN, text: '' }, d).reason, 'invalid-text');
  assert.equal(handleSpeak({ target: TARGET, origin: ORIGIN }, d).reason, 'invalid-text');
  assert.equal(handleSpeak({ target: TARGET, origin: ORIGIN, text: 'x'.repeat(321) }, d).reason, 'invalid-text');
  assert.equal(handleSpeak({ target: TARGET, origin: ORIGIN, text: 'x'.repeat(320) }, d).reason, 'no-adapter');
});

test('speak: target non-instanceId / wildcard / all -> refused invalid-target', () => {
  const d = deps();
  assert.equal(handleSpeak({ target: '*', origin: ORIGIN, text: TEXT }, d).reason, 'invalid-target');
  assert.equal(handleSpeak({ target: 'all', origin: ORIGIN, text: TEXT }, d).reason, 'invalid-target');
});

test('speak: READONLY => refused readonly (prima di ACL/consent)', () => {
  const d = deps({ readonly: true, allows: false, consent: false });
  const r = handleSpeak({ target: TARGET, origin: ORIGIN, text: TEXT }, d);
  assert.equal(r.status, 'refused'); assert.equal(r.reason, 'readonly');
});

test('speak: ACL negata => refused acl; consent false => refused consent', () => {
  assert.equal(handleSpeak({ target: TARGET, origin: ORIGIN, text: TEXT }, deps({ allows: false })).reason, 'acl');
  assert.equal(handleSpeak({ target: TARGET, origin: ORIGIN, text: TEXT }, deps({ consent: false })).reason, 'consent');
});

test('speak: rate limit 6/60s origin-cell; high urgency non bypassa', () => {
  const d = deps({ rl: createSpeakRateLimiter({ now: () => 0 }) });
  for (let i = 0; i < 6; i += 1) handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA', text: TEXT }, d);
  const r = handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA', text: TEXT, urgency: 'high' }, d);
  assert.equal(r.status, 'refused'); assert.equal(r.reason, 'rate-limit');
});

test('speak: unreachable => status unreachable; no adapter => refused no-adapter', () => {
  assert.equal(handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA', text: TEXT }, deps({ reachable: false })).status, 'unreachable');
  const r = handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA', text: TEXT }, deps());
  assert.equal(r.status, 'refused'); assert.equal(r.reason, 'no-adapter');
});

test('speak: fake adapter => spoken; receipt redacted (no text/lang/voice)', () => {
  const d = deps({ adapter: { id: 'test-fake', speak: () => ({ spoken: true }) } });
  const r = handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA', text: 'SECRET', lang: 'it', voice: 'alloy' }, d);
  assert.equal(r.status, 'spoken');
  const json = JSON.stringify(r);
  assert.ok(!json.includes('SECRET') && !json.includes('alloy') && !json.includes('"text"') && !json.includes('"lang"'));
});

test('speak: idempotency — retry identico (stesso utteranceId+caller+target) ritorna existing e NON consuma rate', () => {
  const d = deps({ adapter: { id: 'test-fake', speak: () => ({ spoken: true }) }, rl: createSpeakRateLimiter({ now: () => 0 }) });
  const first = handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA', text: TEXT, utteranceId: 'u-1' }, d);
  assert.equal(first.status, 'spoken');
  // 6 speak con altri utteranceId saturano origin-cell (6/60s)
  for (let i = 0; i < 6; i += 1) handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA', text: TEXT, utteranceId: `u-${i + 10}` }, d);
  // retry di u-1: idempotente (ritorna existing spoken, NON consuma rate -> non denied)
  const retry = handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA', text: TEXT, utteranceId: 'u-1' }, d);
  assert.equal(retry.status, 'spoken');
  assert.equal(retry.utteranceId, 'u-1');
});

test('speak: collisione utteranceId (diverso caller/target) => refused utterance-collision (fail-closed)', () => {
  const d = deps({ adapter: { id: 'test-fake', speak: () => ({ spoken: true }) } });
  handleSpeak({ target: TARGET, origin: { node: 'n', cell: 'cellA' }, originCell: 'cellA', text: TEXT, utteranceId: 'shared' }, d);
  const collision = handleSpeak({ target: TARGET, origin: { node: 'n', cell: 'cellB' }, originCell: 'cellB', text: TEXT, utteranceId: 'shared' }, d);
  assert.equal(collision.status, 'refused');
  assert.equal(collision.reason, 'utterance-collision');
});

test('stop: local sovereign + remote by utteranceId; readonly refused', () => {
  const d = deps();
  assert.equal(handleStop({ target: TARGET, origin: ORIGIN }, d).status, 'accepted');
  assert.equal(handleStop({ target: TARGET, origin: ORIGIN, utteranceId: 'nope' }, d).status, 'unknown');
  const d2 = deps({ readonly: true });
  assert.equal(handleStop({ target: TARGET, origin: ORIGIN }, d2).status, 'refused');
  assert.equal(handleStop({ target: TARGET, origin: ORIGIN }, d2).reason, 'readonly');
});