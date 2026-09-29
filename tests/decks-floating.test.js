'use strict';
// tests/decks-floating.test.js — finestre flottanti: le finestre staccate viaggiano
// ACCANTO alla griglia nel record del deck (campo `floating`), valide e
// clampate. La regola che rende innocuo un nodo/client vecchio: un PUT che
// NON porta `floating` PRESERVA quello salvato; `floating: []` lo svuota.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const decksStore = require('../lib/decks/store.js');

const H = (t) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
const layout = { columns: [{ width: 1, tiles: [{ session: 'dev', height: 1, fontSize: 11 }] }] };
const floating = (over = {}) => ([{ session: 'fork', x: 0.5, y: 0.2, w: 0.4, h: 0.5, fontSize: 11, ...over }]);

async function boot(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncflt-'));
  const decksPath = path.join(dir, '.nexuscrew', 'decks.json');
  decksStore.initStore(decksPath);
  const made = createServer({ home: dir, decksPath, tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'), fleetEnabled: false, ...over });
  await new Promise((r) => made.server.listen(0, '127.0.0.1', r));
  t.after(() => { made.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${made.server.address().port}`, token: made.token, decksPath };
}

test('PUT con floating valido: salvato, letto, persistito su file', async (t) => {
  const { base, token, decksPath } = await boot(t);
  const h = H(token);
  await fetch(`${base}/api/decks`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'work' }) });
  let r = await fetch(`${base}/api/decks/work`, { method: 'PUT', headers: h, body: JSON.stringify({ layout, expectedRevision: 0, floating: floating() }) });
  assert.equal(r.status, 200);
  let d = await r.json();
  assert.equal(d.revision, 1);
  assert.deepEqual(d.floating, floating());
  // round-trip: rilegge dal server (dalla lista dei deck)
  const lista = await (await fetch(`${base}/api/decks`, { headers: h })).json();
  d = lista.decks.find((x) => x.name === 'work');
  assert.deepEqual(d.floating, floating());
  // persistenza vera: parseStore rilegge il file
  const onDisk = JSON.parse(fs.readFileSync(decksPath, 'utf8'));
  const rec = onDisk.decks.find((x) => x.name === 'work');
  assert.deepEqual(rec.floating, floating());
});

test('PUT SENZA floating (nodo/client vecchio): le flottanti restano', async (t) => {
  const { base, token } = await boot(t);
  const h = H(token);
  await fetch(`${base}/api/decks`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'work' }) });
  await fetch(`${base}/api/decks/work`, { method: 'PUT', headers: h, body: JSON.stringify({ layout, expectedRevision: 0, floating: floating() }) });
  // il vecchio salva SOLO il layout
  const r = await fetch(`${base}/api/decks/work`, { method: 'PUT', headers: h, body: JSON.stringify({ layout, expectedRevision: 1 }) });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(d.floating, floating(), 'il PUT senza floating deve preservare');
});

test('PUT con floating: [] svuota esplicitamente', async (t) => {
  const { base, token } = await boot(t);
  const h = H(token);
  await fetch(`${base}/api/decks`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'work' }) });
  await fetch(`${base}/api/decks/work`, { method: 'PUT', headers: h, body: JSON.stringify({ layout, expectedRevision: 0, floating: floating() }) });
  const r = await fetch(`${base}/api/decks/work`, { method: 'PUT', headers: h, body: JSON.stringify({ layout, expectedRevision: 1, floating: [] }) });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.floating, undefined);
});

test('floating invalido -> 400 (geometria, ref, tetto, duplicato con la griglia)', async (t) => {
  const { base, token } = await boot(t);
  const h = H(token);
  await fetch(`${base}/api/decks`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'work' }) });
  for (const bad of [
    floating({ x: 1.5 }),                       // fuori schermo non clampabile
    floating({ w: 0 }),                          // larghezza nulla
    floating({ fontSize: 99 }),                  // font fuori bound
    [{ session: '' }],                           // ref vuota
    floating({ node: 'BRUTTO!!' }),              // route invalida
    Array.from({ length: 7 }, (_v, i) => ({ session: `s${i}`, x: 0.1, y: 0.1, w: 0.2, h: 0.2, fontSize: 11 })), // >6
    floating({ session: 'dev' }),                // duplicato con la griglia
  ]) {
    const r = await fetch(`${base}/api/decks/work`, { method: 'PUT', headers: h, body: JSON.stringify({ layout, expectedRevision: 0, floating: bad }) });
    assert.equal(r.status, 400, `atteso 400 per ${JSON.stringify(bad).slice(0, 60)}`);
  }
});

test('geometria oltre il bordo viene clampata DENTRO (0..1), non rifiutata', async (t) => {
  const { base, token } = await boot(t);
  const h = H(token);
  await fetch(`${base}/api/decks`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'work' }) });
  const r = await fetch(`${base}/api/decks/work`, { method: 'PUT', headers: h, body: JSON.stringify({
    layout, expectedRevision: 0,
    floating: [{ session: 'fork', x: 0.9, y: 0.9, w: 0.4, h: 0.4, fontSize: 11 }],
  }) });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.floating[0].x + d.floating[0].w <= 1.0000001, 'x+w clampato dentro lo schermo');
  assert.ok(d.floating[0].y + d.floating[0].h <= 1.0000001, 'y+h clampato dentro lo schermo');
});

// Il campo nuova generazione accetta solo NUMERI veri.
// Stringhe numeriche e null non si coercitono più in silenzio: il record
// pubblico non deve mai contenere tipi inventati da una conversione.
test('parseFloating rifiuta geometria e font non numerici (stringhe e null)', () => {
  const layoutOk = decksStore.parseLayout({ columns: [{ width: 1, tiles: [{ session: 'dev', height: 1, fontSize: 11 }] }] });
  const casi = [
    [{ session: 'fl', x: '0.2', y: 0.2, w: 0.4, h: 0.4, fontSize: 11 }],
    [{ session: 'fl', x: 0.2, y: null, w: 0.4, h: 0.4, fontSize: 11 }],
    [{ session: 'fl', x: 0.2, y: 0.2, w: '0.4', h: 0.4, fontSize: 11 }],
    [{ session: 'fl', x: 0.2, y: 0.2, w: 0.4, h: 0.4, fontSize: '11' }],
  ];
  for (const f of casi) {
    assert.equal(decksStore.parseFloating(f, layoutOk), null, JSON.stringify(f));
  }
});

// Un client/nodo di versione precedente salva la griglia senza `floating`
// e ci mette una sessione che nel record è staccata: vince la griglia, la
// copia staccata omonima si scarta. Il record resta valido e rileggibile.
test('PUT senza floating che mette in griglia una sessione staccata: vince la griglia', async (t) => {
  const { base, token, decksPath } = await boot(t);
  const h = H(token);
  await fetch(`${base}/api/decks`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'work' }) });
  const due = [...floating(), { session: 'altra', x: 0.1, y: 0.1, w: 0.3, h: 0.3, fontSize: 11 }];
  let r = await fetch(`${base}/api/decks/work`, { method: 'PUT', headers: h, body: JSON.stringify({ layout, expectedRevision: 0, floating: due }) });
  assert.equal(r.status, 200);
  const conFork = { columns: [{ width: 1, tiles: [{ session: 'dev', height: 1, fontSize: 11 }, { session: 'fork', height: 1, fontSize: 11 }] }] };
  r = await fetch(`${base}/api/decks/work`, { method: 'PUT', headers: h, body: JSON.stringify({ layout: conFork, expectedRevision: 1 }) });
  assert.equal(r.status, 200, await r.clone().text());
  const d = await r.json();
  assert.deepEqual(d.layout.columns[0].tiles.map((x) => x.session), ['dev', 'fork']);
  assert.deepEqual(d.floating.map((f) => f.session), ['altra']);
  // il file resta valido: la lista si legge e il record è quello
  const lista = await fetch(`${base}/api/decks`, { headers: h });
  assert.equal(lista.status, 200);
  const rec = (await lista.json()).decks.find((x) => x.name === 'work');
  assert.deepEqual(rec.floating.map((f) => f.session), ['altra']);
  assert.ok(decksStore.loadStoreStrict(decksPath));
});

test('PUT senza floating che assorbe l\'unica staccata: il campo sparisce dal record', async (t) => {
  const { base, token } = await boot(t);
  const h = H(token);
  await fetch(`${base}/api/decks`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'work' }) });
  await fetch(`${base}/api/decks/work`, { method: 'PUT', headers: h, body: JSON.stringify({ layout, expectedRevision: 0, floating: floating() }) });
  const conFork = { columns: [{ width: 1, tiles: [{ session: 'dev', height: 1, fontSize: 11 }, { session: 'fork', height: 1, fontSize: 11 }] }] };
  const r = await fetch(`${base}/api/decks/work`, { method: 'PUT', headers: h, body: JSON.stringify({ layout: conFork, expectedRevision: 1 }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).floating, undefined);
});
