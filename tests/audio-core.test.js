'use strict';
// tests/audio-core.test.js — WP2R core: GLOBALLY bounded receipt (cap 512 global,
// TTL 24h, immutable utteranceId, idempotency, collision fail-closed, caller-
// scoped read) + speak rate limiter (3 bucket) + capability + node schema.
const { test } = require('node:test');
const assert = require('node:assert');
const { createReceiptStore } = require('../lib/audio/receipt.js');
const { createSpeakRateLimiter } = require('../lib/audio/rate-limit.js');
const { describeCapability, admitAudio } = require('../lib/audio/capability.js');
const nodesStore = require('../lib/nodes/store.js');

const BASE_NODE = { name: 'hub', ssh: 'u@h', remotePort: 41820, localPort: 43001, roles: { node: true } };
const ORIGIN = (cell) => ({ node: 'n1', cell });

// --- Receipt store (GLOBALLY bounded 512) ------------------------------------

test('receipt: utteranceId immutabile (generato se omesso, rispettato se fornito)', () => {
  const rs = createReceiptStore({ now: () => 0 });
  const r1 = rs.record({ caller: 'cellA', origin: ORIGIN('cellA'), target: 'n2', status: 'accepted' });
  assert.ok(r1.utteranceId && typeof r1.utteranceId === 'string');
  const r2 = rs.record({ caller: 'cellA', origin: ORIGIN('cellA'), target: 'n2', status: 'spoken', utteranceId: 'u-fixed' });
  assert.equal(r2.utteranceId, 'u-fixed');
});

test('receipt: caller-scoped read (un caller non vede i receipt di un altro)', () => {
  const rs = createReceiptStore({ now: () => 0 });
  rs.record({ caller: 'cellA', origin: ORIGIN('cellA'), target: 'n2', status: 'accepted', utteranceId: 'u-a' });
  rs.record({ caller: 'cellB', origin: ORIGIN('cellB'), target: 'n2', status: 'accepted', utteranceId: 'u-b' });
  assert.equal(rs.get('cellA', 'u-a').status, 'accepted');
  assert.equal(rs.get('cellB', 'u-a'), null, 'cellB non vede receipt di cellA');
  assert.equal(rs.get('cellA', 'u-b'), null);
});

test('receipt: cap 512 GLOBALE (non per-caller); FIFO eviction sui piu vecchi', () => {
  let t = 0;
  const rs = createReceiptStore({ now: () => t });
  for (let i = 0; i < 600; i += 1) {
    t = i;
    rs.record({ caller: `cell${i % 4}`, origin: ORIGIN(`cell${i % 4}`), target: 'n2', status: 'spoken', utteranceId: `u-${i}` });
  }
  assert.equal(rs.count(), 512, 'cap GLOBALE 512');
  assert.equal(rs.get('cell0', 'u-0'), null, 'piu vecchio evicted');
  assert.equal(rs.get('cell0', 'u-87'), null, 'ultimo evicted');
  assert.ok(rs.get('cell0', 'u-88'), 'primo trattenuto');
});

test('receipt: TTL 24h cleanup globale (entry scadute non ritornate)', () => {
  let t = 0;
  const rs = createReceiptStore({ now: () => t });
  rs.record({ caller: 'cellA', origin: ORIGIN('cellA'), target: 'n2', status: 'spoken', utteranceId: 'u-old' });
  t = 24 * 60 * 60 * 1000 + 1;
  rs.record({ caller: 'cellA', origin: ORIGIN('cellA'), target: 'n2', status: 'spoken', utteranceId: 'u-new' });
  assert.equal(rs.get('cellA', 'u-old'), null);
  assert.ok(rs.get('cellA', 'u-new'));
  assert.equal(rs.count(), 1, 'cleanup globale rimuove le scadute');
});

test('receipt: idempotency via find — stesso utteranceId+caller+target ritorna existing; collision fail-closed', () => {
  const rs = createReceiptStore({ now: () => 0 });
  rs.record({ caller: 'cellA', origin: ORIGIN('cellA'), target: 'n2', status: 'spoken', utteranceId: 'u-1' });
  assert.equal(rs.find('u-1', 'cellA', 'n2').status, 'spoken', 'idempotente: stesso caller+target');
  assert.equal(rs.find('u-1', 'cellB', 'n2'), 'collision', 'diverso caller => collisione');
  assert.equal(rs.find('u-1', 'cellA', 'n3'), 'collision', 'diverso target => collisione');
  assert.equal(rs.find('nope', 'cellA', 'n2'), null);
});

test('receipt: record con utteranceId esistente + stesso caller/target e idempotente (no overwrite)', () => {
  const rs = createReceiptStore({ now: () => 0 });
  rs.record({ caller: 'cellA', origin: ORIGIN('cellA'), target: 'n2', status: 'spoken', utteranceId: 'u-1' });
  const again = rs.record({ caller: 'cellA', origin: ORIGIN('cellA'), target: 'n2', status: 'refused', reason: 'x', utteranceId: 'u-1' });
  assert.equal(again.status, 'spoken', 'non sovrascrive: ritorna existing');
  // collisione su stesso utteranceId con caller diverso => throw (fail-closed)
  assert.throws(() => rs.record({ caller: 'cellB', origin: ORIGIN('cellB'), target: 'n2', status: 'spoken', utteranceId: 'u-1' }), /collision/);
});

test('receipt: attribution redacted — MAI text/lang/voice/path/secret; status enum', () => {
  const rs = createReceiptStore({ now: () => 0 });
  const r = rs.record({
    caller: 'cellA', origin: ORIGIN('cellA'), target: 'n2', status: 'refused', reason: 'readonly',
    text: 'SECRET-TEXT', lang: 'it', voice: 'alloy', path: '/secret', token: 'BEARER-XYZ',
  });
  const json = JSON.stringify(r);
  assert.ok(!json.includes('SECRET-TEXT') && !json.includes('BEARER-XYZ') && !json.includes('alloy'));
  assert.equal(r.origin.cell, 'cellA');
  assert.equal(r.target, 'n2');
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, 'readonly');
  for (const bad of ['delivered', 'ok', 'success', 'pending']) {
    assert.throws(() => rs.record({ caller: 'cellA', origin: ORIGIN('cellA'), target: 'n2', status: bad }), /status/);
  }
});

// --- Speak rate limiter (3 bucket) -------------------------------------------

test('rate-limit: origin cell 6/60s (7a denied; high urgency non bypassa)', () => {
  let t = 0;
  const rl = createSpeakRateLimiter({ now: () => t });
  for (let i = 0; i < 6; i += 1) assert.equal(rl.check({ originCell: 'cellA', target: 'nA' }).allowed, true);
  const denied = rl.check({ originCell: 'cellA', target: 'nA' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.bucket, 'origin-cell');
  assert.equal(rl.check({ originCell: 'cellA', target: 'nA', urgency: 'high' }).allowed, false);
});

test('rate-limit: target+origin tracciato; target-global 12/60s (somma origin)', () => {
  let t = 0;
  const rl = createSpeakRateLimiter({ now: () => t });
  for (let i = 0; i < 6; i += 1) assert.equal(rl.check({ originCell: 'cellA', target: 'nA' }).allowed, true);
  assert.equal(rl.check({ originCell: 'cellA', target: 'nA' }).allowed, false, '7a cellA denied (origin-cell)');
  for (let i = 0; i < 6; i += 1) assert.equal(rl.check({ originCell: 'cellB', target: 'nA' }).allowed, true, '6 cellB ok (target-global 6->12)');
  assert.equal(rl.check({ originCell: 'cellC', target: 'nA' }).allowed, false, 'cellC denied (target-global 12)');
  assert.equal(rl.check({ originCell: 'cellC', target: 'nA' }).bucket, 'target-global');
});

test('rate-limit: sliding window 60s (dopo 60s reset)', () => {
  let t = 0;
  const rl = createSpeakRateLimiter({ now: () => t });
  for (let i = 0; i < 6; i += 1) rl.check({ originCell: 'cellA', target: 'nA' });
  assert.equal(rl.check({ originCell: 'cellA', target: 'nA' }).allowed, false);
  t = 60 * 1000 + 1;
  assert.equal(rl.check({ originCell: 'cellA', target: 'nA' }).allowed, true);
});

// --- Capability metadata + admission honesty --------------------------------

test('capability: describeCapability bounded {adapter, installed, liveness, voices, languages}', () => {
  const cap = describeCapability({ adapter: null, voices: ['alloy', 'nova'], languages: ['it', 'en'], installed: false, liveness: 'unavailable' });
  assert.deepEqual(Object.keys(cap).sort(), ['adapter', 'installed', 'languages', 'liveness', 'voices'].sort());
  assert.equal(cap.liveness, 'unavailable');
  assert.ok(cap.voices.length <= 32);
});

test('capability: admitAudio honesty — no adapter => refused/unavailable, mai accepted/spoken', () => {
  const admit = admitAudio({ adapter: null });
  assert.ok(admit.status === 'unavailable' || admit.status === 'refused');
  assert.ok(admit.status !== 'accepted' && admit.status !== 'spoken');
});

// --- Self-owned audio consent store (default OFF, schema chiuso, atomic) ------
const consent = require('../lib/audio/consent.js');
const fs2 = require('node:fs');
const os2 = require('node:os');
const path2 = require('node:path');

test('consent store: self-local default OFF; toggle persistito atomico; schema chiuso', () => {
  const home = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ncaudio-'));
  try {
    assert.equal(consent.isConsent({ home }, home), false, 'default OFF');
    consent.setConsent({ home }, true, home);
    assert.equal(consent.isConsent({ home }, home), true, 'toggle ON persistito');
    assert.equal(consent.readConsent({ home }, home).audio.consent, true);
    // schema chiuso: file con chiave extra -> default OFF (rifiutato)
    fs2.writeFileSync(consent.consentPath({ home }, home), JSON.stringify({ schemaVersion: 1, audio: { consent: true, extra: 1 } }));
    assert.equal(consent.readConsent({ home }, home).audio.consent, false, 'schema chiuso -> default');
    consent.setConsent({ home }, false, home);
    assert.equal(consent.isConsent({ home }, home), false);
  } finally { fs2.rmSync(home, { recursive: true, force: true }); }
});
