'use strict';
// tests/nodes-inspect-cell-scope.test.js — uno scope ristretto deve VEDERSI.
//
// Trovato usando il comando, non leggendolo: dopo `nodes cells <nodo>
// Research` nessun comando mostrava piu' quel limite. Un permesso che
// l'operatore non rilegge da nessuna parte e' un permesso che si dimentica, e
// il giorno che un peer "non trova" una cella la causa resta invisibile.
//
// Il caso `all` NON stampa nulla di proposito: e' il default, e una riga per
// dire "nessun limite" sarebbe rumore su ogni nodo normale.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/nodes/store.js');
const nodesCmds = require('../lib/nodes/commands.js');

const PEER_ID = 'e'.repeat(32);

function fixture(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-inspect-scope-'));
  const dir = path.join(home, '.nexuscrew');
  fs.mkdirSync(dir, { recursive: true });
  const nodesPath = path.join(dir, 'nodes.json');
  store.initStore(nodesPath);
  let st = store.loadStoreStrict(nodesPath);
  st = store.addNode(st, {
    name: 'peer', remotePort: 41999, localPort: 44991, nodeId: PEER_ID,
    acceptToken: 'ACC', direction: 'inbound', shared: true, visibility: 'network', ...extra,
  });
  store.atomicWriteStore(nodesPath, st);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, nodesPath };
}

function inspect(fx) {
  const lines = [];
  const res = nodesCmds.nodesInspect({
    home: fx.home, nodesPath: fx.nodesPath, ref: 'peer', log: (l) => lines.push(String(l)),
  });
  return { code: res.code, out: lines.join('\n') };
}

test('lo scope selected si legge in inspect, con le celle concesse', (t) => {
  const fx = fixture(t, { cellVisibility: 'selected', cells: ['Research', 'Dev'] });
  const { code, out } = inspect(fx);
  assert.equal(code, 0);
  assert.match(out, /celle:/, 'lo scope deve comparire');
  assert.match(out, /Research/);
  assert.match(out, /Dev/);
});

test('lo scope none si legge come tale, non come assenza di informazione', (t) => {
  const fx = fixture(t, { cellVisibility: 'none' });
  const { out } = inspect(fx);
  assert.match(out, /celle:/);
  assert.match(out, /none/);
});

test('il default `all` non stampa nulla: nessun rumore sui nodi normali', (t) => {
  const fx = fixture(t);
  const { out } = inspect(fx);
  assert.ok(!/celle:/.test(out), `nessuna riga celle attesa, ricevuto:\n${out}`);
});

test('un elenco vuoto sotto selected si dichiara, invece di sembrare permissivo', (t) => {
  // Caso limite reale: `selected` con lista vuota significa NESSUNA cella. Una
  // riga muta qui si leggerebbe come "nessun limite", cioe' l'opposto.
  const fx = fixture(t, { cellVisibility: 'selected', cells: [] });
  const { out } = inspect(fx);
  assert.match(out, /celle:/);
  assert.match(out, /vuoto|nessuna/i);
});
