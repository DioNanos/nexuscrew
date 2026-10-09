'use strict';
// tests/asks-store-unreadable.test.js — store illeggibile (asks.json malformato
// o con `asks` non array). La verifica ha mostrato che un file ESISTENTE ma
// MALFORMATO produceva un list() [] autorevole: readJsonSafe tornava {} su
// parse error, load() cacheava [] per tutto il processo, le mutazioni
// sovrascrivevano il file malformato con [] e le domande aperte erano perse.
// Contratto del fix:
//   - assente => leggibile, list() [];
//   - malformato (virgola finale) => illeggibile, list() [], create() rifiutato
//     e file BYTE-IDENTICO dopo il tentativo;
//   - riparo del file => leggibile e la domanda riappare SENZA ricreare lo store;
//   - {"asks":{}} e {} (file presente) => illeggibile (non vuoto autorevole).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAsksStore } = require('../lib/notify/asks.js');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ncasks-unread-')); }
const asksFile = (dir) => path.join(dir, 'asks.json');
const writeAsks = (dir, content) => {
  const file = asksFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
};

test('store illeggibile: assente => readable:true e list() []', () => {
  const dir = tmpdir();
  const store = createAsksStore({ dir });
  assert.deepEqual(store.health(), { readable: true }, 'assente e\' leggibile (stato iniziale legittimo)');
  assert.deepEqual(store.list(), []);
  assert.equal(store.list({ open: true }).length, 0);
  assert.equal(store.openCount(), 0);
  assert.equal(store.findImported('owner', 'ask'), null);
  assert.equal(store.get('xyz'), null);
});

test('store illeggibile: JSON malformato (virgola finale) => readable:false, list() [], create() rifiutato e file BYTE-IDENTICO', () => {
  const dir = tmpdir();
  const raw = '{"asks":[{"id":"abc","question":"x","session":"cell-a","ts":1,"answered":false,"dismissed":false}],}';
  const file = writeAsks(dir, raw);
  const before = fs.readFileSync(file, 'utf8');
  const store = createAsksStore({ dir });

  const h = store.health();
  assert.equal(h.readable, false, 'malformato => illeggibile');
  assert.ok(h.reason, 'reason presente');

  // Superfici LOCALI invariate: vuoto, niente lancio.
  assert.deepEqual(store.list(), []);
  assert.equal(store.list({ open: true }).length, 0);
  assert.equal(store.openCount(), 0);

  // Mutazione rifiutata: nessuna scrittura.
  const out = store.create({ question: 'nuova', session: 'cell-a' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'store-unreadable');

  // Il file malformato NON e' stato toccato.
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, before, 'file BYTE-IDENTICO dopo il tentativo di create');
});

test('store illeggibile: altre mutazioni rifiutano senza scrivere', () => {
  const dir = tmpdir();
  writeAsks(dir, '{"asks":[{"id":"abc","question":"x","session":"cell-a","ts":1,"answered":false,"dismissed":false}],}');
  const store = createAsksStore({ dir });
  assert.equal(store.health().readable, false);

  // claim / dismiss / closeImported / markReconciled rifiutano, forma coerente.
  assert.deepEqual(store.claim('abc'), { ok: false, reason: 'store-unreadable' });
  assert.equal(store.commit('abc', 'txt'), false);
  assert.deepEqual(store.dismiss('abc'), { ok: false, reason: 'store-unreadable' });
  assert.deepEqual(store.closeImported({ ownerId: 'o', ownerAskId: 'a', outcome: 'dismissed' }),
    { ok: false, reason: 'store-unreadable', changed: false, ask: null });
  assert.deepEqual(store.markReconciled('abc', 'mark-delivered'), { ok: false, reason: 'store-unreadable' });
  assert.equal(store.markAnswered('abc', 'txt'), false);

  // Nessuna scrittura: il file e' ancora il malformato originale.
  assert.match(fs.readFileSync(asksFile(dir), 'utf8'), /\],\}\s*$/, 'file non sovrascritto');
});

test('store illeggibile: riparo del file => readable:true e la domanda riappare (stessa istanza, niente restart)', () => {
  const dir = tmpdir();
  writeAsks(dir, '{"asks":[{"id":"abc","question":"aperta","session":"cell-a","ts":1,"answered":false,"dismissed":false}],}');
  const store = createAsksStore({ dir });
  assert.equal(store.health().readable, false, 'parte illeggibile');

  // Riparo il file sul disco: STessa istanza di store, nessun nuovo createAsksStore.
  fs.writeFileSync(asksFile(dir), `${JSON.stringify({
    asks: [{ id: 'abc', question: 'aperta', session: 'cell-a', ts: 1, answered: false, dismissed: false }],
  }, null, 2)}\n`, { mode: 0o600 });

  assert.equal(store.health().readable, true, 'dopo il riparo lo store torna leggibile senza riavvio');
  const open = store.list({ open: true });
  assert.equal(open.length, 1, 'la domanda aperta riappare');
  assert.equal(open[0].id, 'abc');
  assert.equal(open[0].question, 'aperta');
});

test('store illeggibile: {"asks":{}} (asks non array) => illeggibile', () => {
  const dir = tmpdir();
  writeAsks(dir, `${JSON.stringify({ asks: { not: 'an array' } }, null, 2)}\n`);
  const store = createAsksStore({ dir });
  assert.equal(store.health().readable, false, 'asks non array => illeggibile, non vuoto autorevole');
  assert.deepEqual(store.list(), []);
});

test('store illeggibile: {} con file presente => illeggibile (non vuoto autorevole)', () => {
  const dir = tmpdir();
  writeAsks(dir, '{}\n');
  const store = createAsksStore({ dir });
  assert.equal(store.health().readable, false, 'oggetto senza asks => illeggibile');
  assert.deepEqual(store.list(), []);
});

// Un file sano con asks array (anche vuoto) resta leggibile: regressione.
test('store illeggibile: file sano con asks:[] => readable:true', () => {
  const dir = tmpdir();
  writeAsks(dir, `${JSON.stringify({ asks: [] }, null, 2)}\n`);
  const store = createAsksStore({ dir });
  assert.deepEqual(store.health(), { readable: true });
  assert.deepEqual(store.list(), []);
});