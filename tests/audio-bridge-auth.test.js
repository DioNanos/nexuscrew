'use strict';
// tests/audio-bridge-auth.test.js — confine di identita' del bridge MCP.
// Copre: file segreto 0600 anti-symlink, firma su BYTE del body, finestra
// temporale, replay bounded e il fatto che una firma sbagliata non bruci il
// nonce di una richiesta legittima.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ba = require('../lib/audio/bridge-auth.js');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaudio-ba-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('segreto bridge: creato 0600, preservato, e distinto dal token UI', (t) => {
  const dir = tmp(t);
  const p = path.join(dir, '.nexuscrew', 'audio-bridge.key');
  const first = ba.loadOrCreateBridgeSecret(p);
  assert.ok(first && first.length >= 32, 'segreto non banale');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600, 'permessi 0600');
  assert.equal(ba.loadOrCreateBridgeSecret(p), first, 'un segreto esistente non viene sovrascritto');
});

test('segreto bridge: un symlink al posto del file e rifiutato, non seguito', (t) => {
  const dir = tmp(t);
  const real = path.join(dir, 'altrui.key');
  fs.writeFileSync(real, 'segreto-di-qualcun-altro\n', { mode: 0o600 });
  const p = path.join(dir, 'audio-bridge.key');
  fs.symlinkSync(real, p);
  assert.throws(() => ba.loadOrCreateBridgeSecret(p), /symlink/i,
    'seguire il symlink significherebbe farsi scegliere il segreto da chi lo ha piantato');
});

test('firma: copre i BYTE del body, non la sua forma', () => {
  const secret = 'k'.repeat(43);
  const parts = { method: 'POST', path: '/api/audio/speak', session: 'cell-a', timestamp: '1000', nonce: 'a'.repeat(32) };
  const a = ba.signRequest(secret, { ...parts, rawBody: '{"target":"x","text":"ciao"}' });
  const b = ba.signRequest(secret, { ...parts, rawBody: '{"text":"ciao","target":"x"}' });
  assert.notEqual(a, b, 'due serializzazioni diverse dello stesso oggetto non condividono la firma');
});

test('verify: proof valida passa; header malformati, metodo/path diversi e body alterato falliscono', () => {
  const secret = ba.signRequest ? 's'.repeat(43) : null;
  const now = () => 5_000;
  const rawBody = Buffer.from('{"target":"aa"}');
  const headers = ba.signedHeaders(secret, { method: 'POST', path: '/api/audio/speak', session: 'cellA', rawBody, now });
  const base = { secret, method: 'POST', path: '/api/audio/speak', headers, rawBody, now };

  assert.equal(ba.verifyRequest({ ...base, nonceCache: ba.createNonceCache({ now }) }).ok, true);
  assert.equal(ba.verifyRequest({ ...base, method: 'GET', nonceCache: ba.createNonceCache({ now }) }).reason, 'bad-proof',
    'una firma non e trasportabile su un altro metodo');
  assert.equal(ba.verifyRequest({ ...base, path: '/api/audio/stop', nonceCache: ba.createNonceCache({ now }) }).reason, 'bad-proof',
    'una firma non e trasportabile su un altro path');
  assert.equal(ba.verifyRequest({ ...base, rawBody: Buffer.from('{"target":"bb"}'), nonceCache: ba.createNonceCache({ now }) }).reason, 'bad-proof',
    'il body alterato invalida la firma');
  assert.equal(ba.verifyRequest({ ...base, headers: { ...headers, [ba.NONCE_HEADER]: 'non-hex' } }).reason, 'malformed');
  assert.equal(ba.verifyRequest({ ...base, headers: { ...headers, [ba.PROOF_HEADER]: 'zz' } }).reason, 'malformed');
  assert.equal(ba.verifyRequest({ ...base, secret: null }).reason, 'no-secret');
});

test('verify: finestra temporale — troppo vecchia e troppo nel futuro sono entrambe scadute', () => {
  const secret = 'w'.repeat(43);
  const rawBody = Buffer.from('{}');
  const signedAt = 1_000_000;
  const headers = ba.signedHeaders(secret, { method: 'POST', path: '/p', session: 'c', rawBody, now: () => signedAt });
  const at = (t) => ba.verifyRequest({
    secret, method: 'POST', path: '/p', headers, rawBody,
    nonceCache: ba.createNonceCache({ now: () => t }), now: () => t,
  });
  assert.equal(at(signedAt + 30_000).ok, true, 'dentro la finestra');
  assert.equal(at(signedAt + 61_000).reason, 'expired');
  assert.equal(at(signedAt - 61_000).reason, 'expired', 'un timestamp nel futuro non e piu affidabile di uno nel passato');
});

test('replay: lo stesso nonce vale una volta sola', () => {
  const secret = 'r'.repeat(43);
  const now = () => 2_000;
  const rawBody = Buffer.from('{"x":1}');
  const headers = ba.signedHeaders(secret, { method: 'POST', path: '/p', session: 'c', rawBody, now });
  const cache = ba.createNonceCache({ now });
  const call = () => ba.verifyRequest({ secret, method: 'POST', path: '/p', headers, rawBody, nonceCache: cache, now });
  assert.equal(call().ok, true);
  assert.equal(call().reason, 'replay', 'la seconda volta e un replay, anche se la firma e perfetta');
});

test('replay: una firma sbagliata NON consuma il nonce (nessun denial per terzi)', () => {
  const secret = 'n'.repeat(43);
  const now = () => 3_000;
  const rawBody = Buffer.from('{"y":2}');
  const headers = ba.signedHeaders(secret, { method: 'POST', path: '/p', session: 'c', rawBody, now });
  const cache = ba.createNonceCache({ now });
  // Un attaccante indovina il nonce e prova con una firma qualunque.
  const forged = { ...headers, [ba.PROOF_HEADER]: crypto.randomBytes(32).toString('hex') };
  assert.equal(ba.verifyRequest({ secret, method: 'POST', path: '/p', headers: forged, rawBody, nonceCache: cache, now }).reason, 'bad-proof');
  // La richiesta legittima con lo stesso nonce deve ancora passare.
  assert.equal(ba.verifyRequest({ secret, method: 'POST', path: '/p', headers, rawBody, nonceCache: cache, now }).ok, true,
    'bruciare il nonce su firma invalida permetterebbe a un terzo di bloccare richieste altrui');
});

test('cache nonce: bounded, non cresce senza limite', () => {
  let t = 0;
  const cache = ba.createNonceCache({ now: () => t, cap: 8, ttlMs: 1000 });
  for (let i = 0; i < 50; i += 1) { t += 1; cache.use(`n${i}`); }
  assert.ok(cache.size() <= 8, `cache bounded (${cache.size()} <= 8)`);
});
