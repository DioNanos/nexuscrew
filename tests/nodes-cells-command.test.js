'use strict';
// tests/nodes-cells-command.test.js — le tre forme di `nodes cells`.
//
// Difetto trovato PROVANDO il comando, non leggendolo: `all` e `none`
// passavano `cells: []` nel patch, e parseNode rifiuta un elenco quando la
// modalita' non e' `selected` — giustamente, perche' un elenco che sembra un
// permesso senza esserlo e' peggio di un errore. La regola resta; e' il
// comando a doverla rispettare.
//
// Il caso che mancava del tutto: passare da `selected` a `none` deve
// CANCELLARE le celle concesse. Un residuo la' dentro tornerebbe buono al
// primo ritorno a `selected`, concedendo silenziosamente cio' che l'operatore
// credeva di aver tolto.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/nodes/store.js');
const nodesCmds = require('../lib/nodes/commands.js');

const PEER_ID = 'f'.repeat(32);

function fixture(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cells-cmd-'));
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

const read = (nodesPath) => store.getNode(store.loadStore(nodesPath), 'peer');
const run = (fx, patch) => nodesCmds.nodesEdit({
  home: fx.home, nodesPath: fx.nodesPath, log: () => {}, ref: 'peer', patch,
});

// Le tre forme come le produce lib/cli/commands.js.
const FORMS = {
  all: { cellVisibility: 'all' },
  none: { cellVisibility: 'none' },
  selected: (cells) => ({ cellVisibility: 'selected', cells }),
};

test('forma lista: concede esattamente le celle indicate', (t) => {
  const fx = fixture(t);
  assert.equal(run(fx, FORMS.selected(['Research'])).code, 0);
  const n = read(fx.nodesPath);
  assert.equal(n.cellVisibility, 'selected');
  assert.deepEqual(n.cells, ['Research']);
});

test('forma none: riesce, e AZZERA le celle concesse prima', (t) => {
  const fx = fixture(t, { cellVisibility: 'selected', cells: ['Research', 'Dev'] });
  assert.equal(run(fx, FORMS.none).code, 0, 'il comando `none` deve riuscire');
  const n = read(fx.nodesPath);
  assert.equal(n.cellVisibility, 'none');
  // Il residuo non deve sopravvivere: tornando a `selected` concederebbe di
  // nuovo cio' che l'operatore credeva di aver tolto.
  assert.ok(!n.cells || n.cells.length === 0, `celle residue: ${JSON.stringify(n.cells)}`);
});

test('forma all: riesce, e AZZERA le celle concesse prima', (t) => {
  const fx = fixture(t, { cellVisibility: 'selected', cells: ['Research'] });
  assert.equal(run(fx, FORMS.all).code, 0, 'il comando `all` deve riuscire');
  const n = read(fx.nodesPath);
  assert.equal(n.cellVisibility, 'all');
  assert.ok(!n.cells || n.cells.length === 0, `celle residue: ${JSON.stringify(n.cells)}`);
});

test('il giro completo selected -> none -> selected non lascia residui', (t) => {
  const fx = fixture(t);
  assert.equal(run(fx, FORMS.selected(['Research', 'Dev'])).code, 0);
  assert.equal(run(fx, FORMS.none).code, 0);
  assert.equal(run(fx, FORMS.selected(['Research'])).code, 0);
  const n = read(fx.nodesPath);
  assert.deepEqual(n.cells, ['Research'], 'Dev era stato revocato e non deve tornare');
});

test('un elenco con la modalita\' sbagliata viene normalizzato via, non conservato', (t) => {
  const fx = fixture(t);
  // Due livelli, due responsabilita' diverse — e la prima stesura di questo
  // test le confondeva:
  //   * nodesEdit NORMALIZZA il patch, esattamente come fa da sempre per
  //     visibility/selected (`if (patch.visibility !== 'selected') delete
  //     patch.selected`). Chiedere qui un rifiuto avrebbe reso lo scope celle
  //     l'unico campo che si comporta diversamente dal suo gemello.
  //   * parseNode RIFIUTA un elenco senza `selected`, perche' e' il guardiano
  //     dei dati e li' l'ambiguita' non deve entrare. Coperto in
  //     tests/node-cell-scope-store.test.js.
  assert.equal(run(fx, { cellVisibility: 'none', cells: ['Research'] }).code, 0);
  const n = read(fx.nodesPath);
  assert.equal(n.cellVisibility, 'none');
  assert.ok(!n.cells || n.cells.length === 0, 'l\'elenco non deve sopravvivere alla modalita\' che lo revoca');
});
