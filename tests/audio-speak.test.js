'use strict';
// tests/audio-speak.test.js — WP2: speak/stop gate logic. Target independently
// gates ACL/consent/READONLY/rate/dedup; exact target only (no wildcards/all);
// adapter honest (no accepted/spoken without a test fake).
const { test } = require('node:test');
const assert = require('node:assert');
const { handleSpeak, handleStop } = require('../lib/audio/speak.js');
const { createReceiptStore } = require('../lib/audio/receipt.js');
const { createSpeakRateLimiter } = require('../lib/audio/rate-limit.js');

const TARGET = 'a'.repeat(32);
const ORIGIN = { node: 'b'.repeat(32), cell: 'cellA' };

function deps({ readonly = false, allows = true, consent = true, reachable = true, adapter = null, rl, rs } = {}) {
  const store = rs || createReceiptStore({ now: () => 0 });
  const limiter = rl || createSpeakRateLimiter({ now: () => 0 });
  return {
    store, limiter, rateLimiter: limiter,
    readonly: () => readonly,
    targetAllowsOrigin: () => allows,
    targetConsent: () => consent,
    targetReachable: () => reachable,
    adapter,
    receipt: (status, o) => store.record({ caller: o.origin && o.origin.cell, origin: o.origin, target: o.target, status, reason: o.reason, utteranceId: o.utteranceId }),
    dedup: (id) => store.get('cellA', id),
  };
}

test('speak: target non-instanceId / wildcard / all -> refused invalid-target', () => {
  const d = deps();
  assert.equal(handleSpeak({ target: '*', origin: ORIGIN }, d).reason, 'invalid-target');
  assert.equal(handleSpeak({ target: 'all', origin: ORIGIN }, d).reason, 'invalid-target');
  assert.equal(handleSpeak({ target: 'not-an-id', origin: ORIGIN }, d).reason, 'invalid-target');
  assert.equal(handleSpeak({ target: '', origin: ORIGIN }, d).reason, 'invalid-target');
});

test('speak: READONLY => refused reason readonly (prima di ACL/consent)', () => {
  const d = deps({ readonly: true, allows: false, consent: false });
  const r = handleSpeak({ target: TARGET, origin: ORIGIN }, d);
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, 'readonly');
});

test('speak: ACL negata => refused acl', () => {
  const d = deps({ allows: false });
  const r = handleSpeak({ target: TARGET, origin: ORIGIN }, d);
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, 'acl');
});

test('speak: consent false (default off) => refused consent', () => {
  const d = deps({ consent: false });
  const r = handleSpeak({ target: TARGET, origin: ORIGIN }, d);
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, 'consent');
});

test('speak: rate limit superato => refused rate-limit (high urgency non bypassa)', () => {
  const d = deps();
  for (let i = 0; i < 6; i += 1) handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA' }, d);
  const r = handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA', urgency: 'high' }, d);
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, 'rate-limit');
});

test('speak: target unreachable => status unreachable', () => {
  const d = deps({ reachable: false });
  const r = handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA' }, d);
  assert.equal(r.status, 'unreachable');
  assert.equal(r.reason, 'unreachable');
});

test('speak: no adapter (WP3) => refused no-adapter, MAI accepted/spoken', () => {
  const d = deps({ adapter: null });
  const r = handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA' }, d);
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, 'no-adapter');
  assert.ok(r.status !== 'accepted' && r.status !== 'spoken');
});

test('speak: test-fake adapter => status spoken; receipt redacted (no text/lang/voice)', () => {
  const fakeAdapter = { id: 'test-fake', speak: () => ({ spoken: true }) };
  const d = deps({ adapter: fakeAdapter });
  const r = handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA', text: 'SECRET', lang: 'it', voice: 'alloy' }, d);
  assert.equal(r.status, 'spoken');
  const json = JSON.stringify(r);
  assert.ok(!json.includes('SECRET') && !json.includes('alloy') && !json.includes('"text"') && !json.includes('"lang"'));
  assert.equal(r.target, TARGET);
  assert.equal(r.origin.cell, 'cellA');
  assert.ok(r.utteranceId);
});

test('speak: immutable utteranceId (fornito rispettato, redatto nel receipt)', () => {
  const fakeAdapter = { id: 'test-fake', speak: () => ({ spoken: true }) };
  const d = deps({ adapter: fakeAdapter });
  const r = handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA', utteranceId: 'u-fixed' }, d);
  assert.equal(r.utteranceId, 'u-fixed');
});

test('speak: dedup utteranceId terminal => idempotent (ritorna existing)', () => {
  const fakeAdapter = { id: 'test-fake', speak: () => ({ spoken: true }) };
  const d = deps({ adapter: fakeAdapter });
  const first = handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA', utteranceId: 'u-dedup' }, d);
  assert.equal(first.status, 'spoken');
  const second = handleSpeak({ target: TARGET, origin: ORIGIN, originCell: 'cellA', utteranceId: 'u-dedup' }, d);
  assert.equal(second.status, 'spoken');
  assert.equal(second.utteranceId, 'u-dedup');
});

test('stop: local sovereign + remote by utteranceId; readonly refused', () => {
  const d = deps();
  assert.equal(handleStop({ target: TARGET, origin: ORIGIN }, d).status, 'accepted');
  assert.equal(handleStop({ target: TARGET, origin: ORIGIN, utteranceId: 'nope' }, d).status, 'unknown');
  const d2 = deps({ readonly: true });
  assert.equal(handleStop({ target: TARGET, origin: ORIGIN }, d2).status, 'refused');
  assert.equal(handleStop({ target: TARGET, origin: ORIGIN }, d2).reason, 'readonly');
});