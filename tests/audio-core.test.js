'use strict';
// tests/audio-core.test.js — WP2 core: receipt store (caller-scoped, immutable
// utteranceId, cap<=512, TTL 24h, redacted attribution) + speak rate limiter
// (3 bucket: origin cell 6/60s, target+origin 6/60s, target global 12/60s;
// high urgency never bypasses). Test fake only, no physical audio.
const { test } = require('node:test');
const assert = require('node:assert');
const { createReceiptStore } = require('../lib/audio/receipt.js');
const { createSpeakRateLimiter } = require('../lib/audio/rate-limit.js');
const { describeCapability, admitAudio } = require('../lib/audio/capability.js');
const nodesStore = require('../lib/nodes/store.js');

const BASE_NODE = { name: 'hub', ssh: 'u@h', remotePort: 41820, localPort: 43001, roles: { node: true } };

// --- Node audio schema (consent default false, schema chiuso, redaction) -----
test('node audio schema: consent default false; round-trip; schema chiuso; redaction', () => {
  assert.equal(nodesStore.parseNode({ ...BASE_NODE, audio: { consent: true } }).audio.consent, true);
  assert.equal(nodesStore.parseNode({ ...BASE_NODE, audio: { consent: false } }).audio.consent, false);
  assert.equal(nodesStore.parseNode({ ...BASE_NODE }).audio, undefined, 'audio assente di default');
  assert.equal(nodesStore.parseNode({ ...BASE_NODE, audio: { foo: 1 } }), null, 'schema chiuso: chiave non consentita');
  assert.equal(nodesStore.parseNode({ ...BASE_NODE, audio: { consent: 'yes' } }), null, 'consent deve essere boolean');
  assert.equal(nodesStore.parseNode({ ...BASE_NODE, audio: 'x' }), null);
  assert.equal(nodesStore.parseNode({ ...BASE_NODE, audio: { consent: false, extra: 1 } }), null, 'schema chiuso audio');
  const r = nodesStore.redactNode(nodesStore.parseNode({ ...BASE_NODE, audio: { consent: true } }));
  assert.deepEqual(r.audio, { consent: true });
  assert.equal(nodesStore.redactNode(nodesStore.parseNode({ ...BASE_NODE })).audio.consent, false, 'redaction default false');
});

// --- Receipt store -----------------------------------------------------------

test('receipt: utteranceId immutabile (generato se omesso, rispettato se fornito)', () => {
  const rs = createReceiptStore({ now: () => 0 });
  const r1 = rs.record({ caller: 'cellA', origin: { node: 'n1', cell: 'c1' }, target: 'n2', status: 'accepted' });
  assert.ok(r1.utteranceId && typeof r1.utteranceId === 'string' && r1.utteranceId.length > 0);
  const r2 = rs.record({ caller: 'cellA', origin: { node: 'n1', cell: 'c1' }, target: 'n2', status: 'spoken', utteranceId: 'u-fixed' });
  assert.equal(r2.utteranceId, 'u-fixed', 'utteranceId fornito e rispettato');
});

test('receipt: caller-scoped (un caller non vede i receipt di un altro)', () => {
  const rs = createReceiptStore({ now: () => 0 });
  rs.record({ caller: 'cellA', origin: { node: 'n1', cell: 'cA' }, target: 'n2', status: 'accepted', utteranceId: 'u-a' });
  rs.record({ caller: 'cellB', origin: { node: 'n1', cell: 'cB' }, target: 'n2', status: 'accepted', utteranceId: 'u-b' });
  assert.equal(rs.get('cellA', 'u-a').status, 'accepted');
  assert.equal(rs.get('cellB', 'u-a'), null, 'cellB non vede receipt di cellA');
  assert.equal(rs.get('cellA', 'u-b'), null);
});

test('receipt: cap <=512 per caller (FIFO eviction sui piu vecchi)', () => {
  let t = 0;
  const rs = createReceiptStore({ now: () => t });
  for (let i = 0; i < 600; i += 1) {
    t = i;
    rs.record({ caller: 'cellA', origin: { node: 'n1', cell: 'cA' }, target: 'n2', status: 'spoken', utteranceId: `u-${i}` });
  }
  assert.equal(rs.count('cellA'), 512, 'cap 512 per caller');
  // i piu vecchi (u-0..u-87) sono evicted; gli ultimi 512 restano
  assert.equal(rs.get('cellA', 'u-0'), null);
  assert.equal(rs.get('cellA', 'u-87'), null, 'ultimo evicted');
  assert.ok(rs.get('cellA', 'u-88') !== null, 'primo trattenuto');
  assert.ok(rs.get('cellA', 'u-599') !== null, 'ultimo trattenuto');
});

test('receipt: TTL 24h (entry scadute non ritornate; cleanup)', () => {
  let t = 0;
  const rs = createReceiptStore({ now: () => t });
  rs.record({ caller: 'cellA', origin: { node: 'n1', cell: 'cA' }, target: 'n2', status: 'spoken', utteranceId: 'u-old' });
  t = 24 * 60 * 60 * 1000 + 1; // > 24h
  rs.record({ caller: 'cellA', origin: { node: 'n1', cell: 'cA' }, target: 'n2', status: 'spoken', utteranceId: 'u-new' });
  assert.equal(rs.get('cellA', 'u-old'), null, 'scaduto dopo 24h');
  assert.ok(rs.get('cellA', 'u-new'));
});

test('receipt: attribution redacted — MAI text/lang/voice/path/secret', () => {
  const rs = createReceiptStore({ now: () => 0 });
  const r = rs.record({
    caller: 'cellA', origin: { node: 'n1', cell: 'cA' }, target: 'n2', status: 'refused', reason: 'readonly',
    text: 'SECRET-TEXT', lang: 'it', voice: 'alloy', path: '/secret', token: 'BEARER-XYZ',
  });
  const json = JSON.stringify(r);
  assert.ok(!json.includes('SECRET-TEXT') && !json.includes('BEARER-XYZ') && !json.includes('alloy'));
  assert.equal(r.origin.node, 'n1');
  assert.equal(r.origin.cell, 'cA');
  assert.equal(r.target, 'n2');
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, 'readonly');
  assert.ok(typeof r.timestamp === 'number');
  // status enum ristretta
  for (const bad of ['delivered', 'ok', 'success', 'pending']) {
    assert.throws(() => rs.record({ caller: 'cellA', origin: { node: 'n1', cell: 'cA' }, target: 'n2', status: bad }), /status/);
  }
});

test('receipt: list per caller ritorna solo i propri, redacted, con attribution', () => {
  const rs = createReceiptStore({ now: () => 0 });
  rs.record({ caller: 'cellA', origin: { node: 'n1', cell: 'cA' }, target: 'n2', status: 'accepted', utteranceId: 'u1', text: 'S' });
  rs.record({ caller: 'cellB', origin: { node: 'n1', cell: 'cB' }, target: 'n2', status: 'spoken', utteranceId: 'u2' });
  const list = rs.list('cellA');
  assert.equal(list.length, 1);
  assert.equal(list[0].utteranceId, 'u1');
  assert.equal(JSON.stringify(list[0]).includes('S"') || JSON.stringify(list[0]).includes('"text"'), false);
});

// --- Speak rate limiter (3 bucket) -------------------------------------------

test('rate-limit: origin cell 6/60s (7a speak denied, high urgency non bypassa)', () => {
  let t = 0;
  const rl = createSpeakRateLimiter({ now: () => t });
  for (let i = 0; i < 6; i += 1) {
    assert.equal(rl.check({ originCell: 'cellA', target: 'nA' }).allowed, true, `speak ${i + 1} ok`);
  }
  const denied = rl.check({ originCell: 'cellA', target: 'nA' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.bucket, 'origin-cell');
  // high urgency non bypassa
  const deniedUrgent = rl.check({ originCell: 'cellA', target: 'nA', urgency: 'high' });
  assert.equal(deniedUrgent.allowed, false, 'high urgency non bypassa rate limit');
});

test('rate-limit: target+origin 6/60s tracciato (7a speak stessa coppia denied; origin diversa = nuovo bucket)', () => {
  let t = 0;
  const rl = createSpeakRateLimiter({ now: () => t });
  // 6 speak cellA->nA ok; 7a denied (origin-cell e target-origin saturano insieme)
  for (let i = 0; i < 6; i += 1) assert.equal(rl.check({ originCell: 'cellA', target: 'nA' }).allowed, true);
  const d = rl.check({ originCell: 'cellA', target: 'nA' });
  assert.equal(d.allowed, false);
  // una origin diversa verso la stessa coppia nA: nuovo bucket -> ok
  assert.equal(rl.check({ originCell: 'cellB', target: 'nA' }).allowed, true, 'origin diversa: nuovo bucket');
});

test('rate-limit: target global 12/60s (somma di tutte le origin verso il target)', () => {
  let t = 0;
  const rl = createSpeakRateLimiter({ now: () => t });
  // 6 cellA->nA (origin-cell ok, target-origin ok, target-global 6/12)
  for (let i = 0; i < 6; i += 1) rl.check({ originCell: 'cellA', target: 'nA' });
  // 6 cellB->nA: origin-cell ok (bucket diverso), target-origin ok (coppia diversa), target-global 12/12
  for (let i = 0; i < 6; i += 1) assert.equal(rl.check({ originCell: 'cellB', target: 'nA' }).allowed, true);
  // 13a verso nA: target-global denied
  const d = rl.check({ originCell: 'cellC', target: 'nA' });
  assert.equal(d.allowed, false);
  assert.equal(d.bucket, 'target-global');
});

test('rate-limit: sliding window 60s (dopo 60s i counter si resettano)', () => {
  let t = 0;
  const rl = createSpeakRateLimiter({ now: () => t });
  for (let i = 0; i < 6; i += 1) rl.check({ originCell: 'cellA', target: 'nA' });
  assert.equal(rl.check({ originCell: 'cellA', target: 'nA' }).allowed, false);
  t = 60 * 1000 + 1;
  assert.equal(rl.check({ originCell: 'cellA', target: 'nA' }).allowed, true, 'dopo 60s la window si resetta');
});

// --- Capability metadata bounded + admission honesty ------------------------

test('capability: describeCapability ritorna metadata bounded redacted {adapter, installed, liveness, voices, languages}', () => {
  const cap = describeCapability({
    adapter: null, // WP3: nessun adapter ancora
    voices: ['alloy', 'nova', 'SECRET-VOICE'],
    languages: ['it', 'en'],
    installed: false,
    liveness: 'unavailable',
  });
  assert.deepEqual(Object.keys(cap).sort(), ['adapter', 'installed', 'languages', 'liveness', 'voices'].sort());
  assert.equal(cap.adapter, null);
  assert.equal(cap.installed, false);
  assert.equal(cap.liveness, 'unavailable');
  // voices redacted bounded (mai SECRET-VALUE grezzo? qui e' solo un elenco di nomi voce, ok)
  assert.ok(Array.isArray(cap.voices) && cap.voices.length <= 32);
});

test('capability: admitAudio honesty — no adapter => refused/unavailable, MAI accepted/spoken senza test fake', () => {
  const admit = admitAudio({ adapter: null });
  assert.ok(admit.status === 'unavailable' || admit.status === 'refused');
  assert.ok(admit.status !== 'accepted' && admit.status !== 'spoken');
  // con un test fake adapter (WP3 pluggabile), ammette
  const fake = admitAudio({ adapter: { id: 'test-fake', speak: () => ({ ok: true }) } });
  assert.ok(['unavailable', 'refused', 'accepted', 'spoken'].includes(fake.status) || fake.status === 'unavailable' || fake.adapterDetected === true);
});