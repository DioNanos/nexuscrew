'use strict';
// tests/fragment-scrub.test.js — parsing/scrub del fragment di bootstrap (#token,
// #pair). Verifica che il fragment sensibile venga rimosso producendo un nextUrl
// pulito (path + query preservati) e che #pair venga ricostruito come pairingUrl.
const { test } = require('node:test');
const assert = require('node:assert');

const mod = () => import('../frontend/src/lib/fragment.js');

test('parseBootstrapHash: #token= estratto e scrubbato (path+query preservati)', async () => {
  const { parseBootstrapHash } = await mod();
  const r = parseBootstrapHash({ hash: '#token=ABC123', origin: 'http://x', pathname: '/', search: '' });
  assert.equal(r.token, 'ABC123');
  assert.equal(r.pair, '');
  assert.equal(r.nextUrl, '/', 'fragment rimosso, path preservato');
});

test('parseBootstrapHash: #pair= ricostruito come pairingUrl e scrubbato', async () => {
  const { parseBootstrapHash } = await mod();
  const r = parseBootstrapHash({ hash: '#pair=PAYLOAD42', origin: 'http://127.0.0.1:41820', pathname: '/', search: '' });
  assert.equal(r.pair, 'http://127.0.0.1:41820/#pair=PAYLOAD42');
  assert.equal(r.token, '');
  assert.equal(r.nextUrl, '/', 'pair sensibile rimosso dal fragment');
});

test('parseBootstrapHash: token + pair insieme; query search preservata', async () => {
  const { parseBootstrapHash } = await mod();
  const r = parseBootstrapHash({ hash: '#token=T1&pair=P9', origin: 'http://x', pathname: '/deck/main', search: '?ref=qr' });
  assert.equal(r.token, 'T1');
  assert.equal(r.pair, 'http://x/deck/main#pair=P9');
  assert.equal(r.nextUrl, '/deck/main?ref=qr', 'path + query preservati, fragment sensibile via');
});

test('parseBootstrapHash: nessun fragment -> vuoto, nextUrl = path+search', async () => {
  const { parseBootstrapHash } = await mod();
  const r = parseBootstrapHash({ hash: '', origin: 'http://x', pathname: '/', search: '?a=b' });
  assert.equal(r.token, '');
  assert.equal(r.pair, '');
  assert.equal(r.nextUrl, '/?a=b');
});

test('parseBootstrapHash: fragment non sensibile (altre chiavi) non produce token/pair', async () => {
  const { parseBootstrapHash } = await mod();
  const r = parseBootstrapHash({ hash: '#foo=bar', origin: 'http://x', pathname: '/', search: '' });
  assert.equal(r.token, '');
  assert.equal(r.pair, '');
});

test('parseBootstrapHash: robusto su input degradato (nessun side effect, no throw)', async () => {
  const { parseBootstrapHash } = await mod();
  assert.doesNotThrow(() => parseBootstrapHash({}));
  const r = parseBootstrapHash({});
  assert.equal(r.token, '');
  assert.equal(r.pair, '');
  assert.equal(r.nextUrl, '');
});
