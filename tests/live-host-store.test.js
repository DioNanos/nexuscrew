'use strict';
// tests/live-host-store.test.js — CAS store della designazione "cella ospite Live".
// Comportamentali: ogni asserzione rompe se il comportamento cambia, non legge il
// sorgente. La barriera concorrente e' Promise.all (non sequenza).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createLiveHostStore } = require('../lib/live-host/store.js');

function tmpStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-store-'));
  const filePath = path.join(dir, 'live-host.json');
  return { dir, filePath, store: createLiveHostStore({ filePath, now: () => 1000, ...opts }) };
}

test('snapshot iniziale legittimo: revision 0, hostCell null', () => {
  const { store, dir } = tmpStore();
  assert.deepEqual(store.snapshot(), { revision: 0, hostCell: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CAS semplice avanza la revision e scrive hostCell', async () => {
  const { store, dir } = tmpStore();
  const r = await store.compareAndSet(0, 'cloud-Dev');
  assert.equal(r.ok, true);
  assert.equal(r.revision, 1);
  assert.equal(r.hostCell, 'cloud-Dev');
  assert.equal(store.snapshot().hostCell, 'cloud-Dev');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CAS con expected stale -> conflict, hostCell invariato', async () => {
  const { store, dir } = tmpStore();
  await store.compareAndSet(0, 'A');
  const r = await store.compareAndSet(0, 'B'); // expected 0, ma la revision e' ormai 1
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.equal(r.revision, 1);
  assert.equal(r.hostCell, 'A'); // il conflict riporta lo stato corrente
  assert.equal(store.snapshot().hostCell, 'A'); // invariato: il perdente non scrive
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BARRIERA: N writers concorrenti sulla stessa revision -> esattamente un ok', async () => {
  const { store, dir } = tmpStore();
  const base = store.snapshot().revision;
  const tries = await Promise.all([0, 1, 2, 3, 4].map((i) => store.compareAndSet(base, `C${i}`)));
  const oks = tries.filter((t) => t.ok);
  const winners = tries.filter((t) => t.ok).map((t) => t.hostCell);
  assert.equal(oks.length, 1, 'esattamente un vincitore, non consegna sequenziale');
  assert.equal(store.snapshot().revision, base + 1);
  assert.deepEqual([store.snapshot().hostCell], winners, 'hostCell finale = l\'unico vincitore');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('persistenza: lo stato sopravvive a un nuovo store (simula riavvio processo)', async () => {
  const { filePath, store, dir } = tmpStore();
  await store.compareAndSet(0, 'cloud-Dev');
  const reborn = createLiveHostStore({ filePath }); // nuovo processo, stesso file
  assert.equal(reborn.snapshot().hostCell, 'cloud-Dev');
  assert.equal(reborn.snapshot().revision, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cella inattiva PRESERVA: nessun metodo dello store cancella hostCell per inattivita\'', async () => {
  // Lo store e' agnostico ad active/inactive (elegibilita\' e\' derivata a monte
  // roster). hostCell resta fino a un clear esplicito: e' cio\' che realizza
  // "spegnere una cella non le toglie la stellina rossa".
  const { store, dir } = tmpStore();
  await store.compareAndSet(0, 'cloud-Dev');
  assert.equal(store.snapshot().hostCell, 'cloud-Dev');
  // snapshot ripetuta non muta nulla (nessun reaper, nessun TTL qui).
  assert.equal(store.snapshot().hostCell, 'cloud-Dev');
  const cleared = await store.compareAndSet(1, null);
  assert.equal(cleared.ok, true);
  assert.equal(store.snapshot().hostCell, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hostCell fuori formato viene normalizzato a null (no garbage su disco)', async () => {
  const { store, dir } = tmpStore();
  const r = await store.compareAndSet(0, 'bad cell!');
  assert.equal(r.ok, true);
  assert.equal(r.hostCell, null); // rifiutato, non promosso a garbage
  fs.rmSync(dir, { recursive: true, force: true });
});

test('file garbage/corrupt -> stato iniziale legittimo, nessun crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-g-'));
  const filePath = path.join(dir, 'live-host.json');
  // mode 0600 come lo scriverebbe atomicWriteJson: readJsonSafe accetta i permessi
  // e poi chiude il JSON garbage a {} (fail-closed, non crash).
  fs.writeFileSync(filePath, 'not json{', { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  const store = createLiveHostStore({ filePath });
  assert.deepEqual(store.snapshot(), { revision: 0, hostCell: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fail-closed: expected non-integer (undefined/null/stringa/NaN/bool) -> conflict, mai lasciapassare', async () => {
  const { store, dir } = tmpStore();
  for (const bad of [undefined, null, '0', 'x', NaN, 1.5, -1, true]) {
    const r = await store.compareAndSet(bad, 'A');
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} deve essere conflict, non ok`);
    assert.equal(r.conflict, true);
  }
  assert.equal(store.snapshot().hostCell, null); // nessun write e' passato
  // con integer corretto invece scrive (controllo positivo):
  const ok = await store.compareAndSet(0, 'A');
  assert.equal(ok.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
