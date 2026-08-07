'use strict';
// tests/node-cell-scope-store.test.js — il campo che dice QUALI CELLE un peer
// puo' vedere di questo nodo.
//
// Sta nello store per la stessa ragione di `visibility`/`selected`: la
// decisione appartiene al nodo che possiede le celle, e la sorgente non deve
// mai essere il corpo di una richiesta.
//
// Due scelte deliberate, entrambe provate qui:
//  - default `all` quando il campo e' assente. Un default fail-closed
//    romperebbe ogni pairing esistente al primo aggiornamento: la flotta
//    diventerebbe muta senza che nessuno abbia deciso nulla. La migrazione a
//    scope ristretto e' un atto esplicito dell'operatore (modello §6: "non c'e'
//    un passo in cui un nodo guadagna poteri che prima non aveva" — e nemmeno
//    uno in cui li perde per sorpresa).
//  - `selected` con lista VUOTA e' legittimo e significa "nessuna cella".
//    Distinguere "campo assente" da "lista vuota" e' esattamente il motivo per
//    cui serve `cellVisibility` e non basta l'array.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/nodes/store.js');

const NODE_ID = 'c'.repeat(32);

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nccellscope-'));
  const p = path.join(dir, 'nodes.json');
  store.initStore(p);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return p;
}

const addPeer = (st, extra = {}) => store.addNode(st, {
  name: 'peer', remotePort: 41999, localPort: 44777, nodeId: NODE_ID,
  acceptToken: 'ACC', direction: 'inbound', shared: true, visibility: 'network', ...extra,
});

test('un nodo senza il campo resta con accesso a tutte le celle', (t) => {
  const p = freshStore(t);
  const st = addPeer(store.loadStoreStrict(p));
  store.atomicWriteStore(p, st);
  const node = store.getNode(store.loadStore(p), 'peer');
  assert.equal(node.cellVisibility, 'all', 'gli store esistenti non devono diventare muti');
});

test('cellVisibility selected + lista celle sopravvive a scrittura e rilettura', (t) => {
  const p = freshStore(t);
  const st = addPeer(store.loadStoreStrict(p), { cellVisibility: 'selected', cells: ['Research', 'Dev'] });
  store.atomicWriteStore(p, st);
  const node = store.getNode(store.loadStore(p), 'peer');
  assert.equal(node.cellVisibility, 'selected');
  assert.deepEqual([...node.cells].sort(), ['Dev', 'Research']);
});

test('selected con lista vuota significa NESSUNA cella, ed e\' diverso da assente', (t) => {
  const p = freshStore(t);
  const st = addPeer(store.loadStoreStrict(p), { cellVisibility: 'selected', cells: [] });
  store.atomicWriteStore(p, st);
  const node = store.getNode(store.loadStore(p), 'peer');
  assert.equal(node.cellVisibility, 'selected');
  assert.deepEqual(node.cells, []);
});

test('cellVisibility none non ammette celle', (t) => {
  const p = freshStore(t);
  const st = addPeer(store.loadStoreStrict(p), { cellVisibility: 'none' });
  store.atomicWriteStore(p, st);
  assert.equal(store.getNode(store.loadStore(p), 'peer').cellVisibility, 'none');
});

test('input invalido fa fallire il parse invece di essere indovinato', (t) => {
  const p = freshStore(t);
  const base = store.loadStoreStrict(p);
  for (const bad of [
    { cellVisibility: 'qualsiasi' },
    { cellVisibility: 'selected', cells: 'Research' },
    { cellVisibility: 'selected', cells: ['ok', 'nome con spazi'] },
    { cellVisibility: 'selected', cells: ['x'.repeat(33)] },
    { cells: ['Research'] }, // celle senza dichiarare la modalita'
  ]) {
    // Il rifiuto arriva gia' da addNode: la validazione sta all'ingresso, non
    // alla scrittura. Meglio cosi' — un nodo malformato non entra mai in
    // memoria, nemmeno per il tempo di un write fallito.
    assert.throws(() => addPeer(base, bad), undefined,
      `deve rifiutare: ${JSON.stringify(bad)}`);
  }
});

test('le celle sono deduplicate, come selected', (t) => {
  const p = freshStore(t);
  const st = addPeer(store.loadStoreStrict(p), { cellVisibility: 'selected', cells: ['Dev', 'Dev', 'Research'] });
  store.atomicWriteStore(p, st);
  const node = store.getNode(store.loadStore(p), 'peer');
  assert.deepEqual([...node.cells].sort(), ['Dev', 'Research']);
});

test('lo scope celle e\' visibile nella redazione: non e\' un segreto, e\' una decisione', (t) => {
  const p = freshStore(t);
  const st = addPeer(store.loadStoreStrict(p), { cellVisibility: 'selected', cells: ['Research'] });
  store.atomicWriteStore(p, st);
  const red = store.redactStore(store.loadStore(p)).nodes.find((n) => n.name === 'peer');
  assert.equal(red.cellVisibility, 'selected');
  assert.deepEqual(red.cells, ['Research']);
  // Il token non deve mai comparire, qui come altrove.
  assert.equal(red.token, undefined);
  assert.equal(red.acceptToken, undefined);
});
