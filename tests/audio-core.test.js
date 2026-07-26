'use strict';
// tests/audio-core.test.js — unita' del nucleo Audio Share: receipt (scope
// nodo+cella), rate limit (tre bucket, nessuna corsia per l'urgency),
// capability (metadati bounded e onesti).
const { test } = require('node:test');
const assert = require('node:assert');
const { createReceiptStore, callerKey, CAP } = require('../lib/audio/receipt.js');
const { createSpeakRateLimiter } = require('../lib/audio/rate-limit.js');
const { describeCapability } = require('../lib/audio/capability.js');

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);
const TARGET = 'c'.repeat(32);
const originA = { node: NODE_A, cell: 'Dev' };
const originB = { node: NODE_B, cell: 'Dev' }; // stesso NOME cella, nodo diverso

test('receipt: lo scope e nodo+cella, non la sola cella', () => {
  const s = createReceiptStore({ now: () => 0 });
  const r = s.record({ origin: originA, target: TARGET, status: 'accepted' });
  assert.ok(s.get(originA, r.utteranceId), 'la stessa origine legge il proprio receipt');
  assert.equal(s.get(originB, r.utteranceId), null,
    'una cella omonima su un ALTRO nodo non deve vedere il receipt: e il caso reale di due installazioni con una cella "Dev"');
  assert.notEqual(callerKey(originA), callerKey(originB));
});

test('receipt: redazione — mai testo, lingua, voce; attribuzione minima', () => {
  const s = createReceiptStore({ now: () => 7 });
  const r = s.record({ origin: originA, target: TARGET, status: 'spoken', reason: 'ok' });
  assert.deepEqual(Object.keys(r).sort(),
    ['origin', 'reason', 'status', 'target', 'timestamp', 'utteranceId'].sort());
  assert.deepEqual(r.origin, { node: NODE_A, cell: 'Dev', attested: false });
  const serialized = JSON.stringify(r);
  for (const leak of ['text', 'lang', 'voice', 'token', 'secret']) {
    assert.equal(serialized.includes(leak), false, `nessun campo ${leak} nel receipt`);
  }
});

test('receipt: `attested` distingue una cella verificata da una dichiarata da un altro nodo', () => {
  const s = createReceiptStore({ now: () => 0 });
  const local = s.record({ origin: originA, target: TARGET, status: 'accepted', attested: false });
  const remote = s.record({ origin: originB, target: TARGET, status: 'accepted', attested: true });
  assert.equal(local.origin.attested, false);
  assert.equal(remote.origin.attested, true,
    'perdere questa distinzione significherebbe trattare un attestato come una verifica');
});

test('receipt: idempotenza per utteranceId; collisione fail-closed', () => {
  const s = createReceiptStore({ now: () => 0 });
  const id = 'utt-1234567890';
  s.record({ origin: originA, target: TARGET, status: 'accepted', utteranceId: id });
  const again = s.record({ origin: originA, target: TARGET, status: 'accepted', utteranceId: id });
  assert.equal(again.utteranceId, id, 'un retry identico non crea un secondo receipt');
  assert.equal(s.find(id, originA, TARGET).utteranceId, id);
  assert.equal(s.find(id, originB, TARGET), 'collision',
    'riusare l id di un altro non deve permettere di leggerne il receipt');
  assert.throws(() => s.record({ origin: originB, target: TARGET, status: 'accepted', utteranceId: id }));
});

test('receipt: update fa evolvere solo lo stato, mai origine o target', () => {
  const s = createReceiptStore({ now: () => 0 });
  const r = s.record({ origin: originA, target: TARGET, status: 'accepted' });
  const up = s.update(r.utteranceId, 'spoken');
  assert.equal(up.status, 'spoken');
  assert.deepEqual(up.origin, r.origin);
  assert.equal(up.target, r.target);
  assert.equal(s.update('inesistente', 'spoken'), null);
  assert.throws(() => s.update(r.utteranceId, 'inventato'));
});

test('receipt: cap globale 512 con eviction dei piu vecchi', () => {
  let t = 0;
  const s = createReceiptStore({ now: () => { t += 1; return t; } });
  for (let i = 0; i < CAP + 20; i += 1) s.record({ origin: originA, target: TARGET, status: 'accepted' });
  assert.ok(s.count() <= CAP, `store bounded (${s.count()} <= ${CAP})`);
});

test('receipt: TTL 24h — le entry scadute non vengono ritornate', () => {
  let t = 0;
  const s = createReceiptStore({ now: () => t });
  const r = s.record({ origin: originA, target: TARGET, status: 'accepted' });
  t = 24 * 60 * 60 * 1000 + 1;
  assert.equal(s.get(originA, r.utteranceId), null);
});

test('rate-limit: 6/60s per (nodo,cella); urgency alta NON bypassa', () => {
  let t = 0;
  const rl = createSpeakRateLimiter({ now: () => t });
  for (let i = 0; i < 6; i += 1) assert.equal(rl.check({ origin: originA, target: TARGET }).allowed, true, `#${i}`);
  const denied = rl.check({ origin: originA, target: TARGET, urgency: 'high' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.bucket, 'origin-cell');
});

test('rate-limit: celle omonime su nodi diversi hanno budget separati', () => {
  const rl = createSpeakRateLimiter({ now: () => 0 });
  for (let i = 0; i < 6; i += 1) rl.check({ origin: originA, target: TARGET });
  assert.equal(rl.check({ origin: originA, target: TARGET }).allowed, false);
  assert.equal(rl.check({ origin: originB, target: TARGET }).allowed, true,
    'contare per sola cella farebbe consumare a un nodo il budget di un altro');
});

test('rate-limit: tetto globale per target 12/60s sommando le origini', () => {
  const rl = createSpeakRateLimiter({ now: () => 0 });
  const origins = Array.from({ length: 4 }, (_, i) => ({ node: `${i}`.repeat(32), cell: 'Dev' }));
  let allowed = 0;
  for (const o of origins) for (let i = 0; i < 6; i += 1) if (rl.check({ origin: o, target: TARGET }).allowed) allowed += 1;
  assert.equal(allowed, 12, 'e il tetto che limita il danno di un nodo che inventa nomi di cella');
});

test('rate-limit: finestra scorrevole — dopo 60s riparte', () => {
  let t = 0;
  const rl = createSpeakRateLimiter({ now: () => t });
  for (let i = 0; i < 6; i += 1) rl.check({ origin: originA, target: TARGET });
  assert.equal(rl.check({ origin: originA, target: TARGET }).allowed, false);
  t += 60_001;
  assert.equal(rl.check({ origin: originA, target: TARGET }).allowed, true);
});

test('rate-limit: origine incompleta e un errore, non un permesso', () => {
  const rl = createSpeakRateLimiter({ now: () => 0 });
  assert.throws(() => rl.check({ origin: { node: NODE_A }, target: TARGET }));
  assert.throws(() => rl.check({ origin: originA }));
});

test('capability: senza adapter non promette nulla', () => {
  const c = describeCapability({ adapter: null, consent: true });
  assert.equal(c.adapter, null);
  assert.equal(c.installed, false);
  assert.equal(c.liveness, 'unavailable');
});

test('capability: senza consenso la liveness resta unavailable anche con adapter pronto', () => {
  const adapter = { id: 'say', installed: true, limits: 'richiede GUI' };
  assert.equal(describeCapability({ adapter, consent: false }).liveness, 'unavailable',
    'dichiarare ready un endpoint che rifiutera comunque inviterebbe a un tentativo impossibile');
  assert.equal(describeCapability({ adapter, consent: true }).liveness, 'ready');
});

test('capability: metadati bounded — nessun path di binario, nessuna enumerazione voci', () => {
  const adapter = { id: 'espeak-ng', installed: true, bin: '/usr/bin/espeak-ng', limits: 'sink reale richiesto' };
  const c = describeCapability({ adapter, consent: true, nodeId: NODE_A });
  const serialized = JSON.stringify(c);
  assert.equal(serialized.includes('/usr/bin'), false, 'il path del binario descriverebbe il filesystem a un peer');
  assert.deepEqual(c.voices, []);
  assert.deepEqual(c.languages, []);
  assert.ok(c.limits, 'i limiti di piattaforma sono dichiarati, non taciuti');
});
