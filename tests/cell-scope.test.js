'use strict';
// tests/cell-scope.test.js — chi vede quali celle, deciso in un punto solo.
//
// Gemello di lib/audio/acl.js, e per la stessa ragione: la sorgente della
// decisione e' il node store locale, mai il corpo della richiesta. L'identita'
// del peer arriva dalla catena `visited` che costruisce il server.
//
// L'invariante che questo file protegge, e che una versione semplificata
// romperebbe in silenzio: in multi-hop lo scope effettivo e' l'INTERSEZIONE fra
// chi consegna e chi origina. Guardare solo il consegnante lascerebbe un terzo
// nodo ereditare i permessi di chi lo instrada.
const { test } = require('node:test');
const assert = require('node:assert');
const { createCellScope } = require('../lib/cells/scope.js');

const LOCAL = 'a'.repeat(32);
const DELIVER = 'b'.repeat(32);
const ORIGIN = 'c'.repeat(32);

// Store finto: niente filesystem, la forma e' quella di lib/nodes/store.js.
const storeWith = (...nodes) => ({ nodeId: LOCAL, nodes });
const peer = (nodeId, extra = {}) => ({
  name: `n-${nodeId.slice(0, 4)}`, nodeId, visibility: 'network', shared: true,
  cellVisibility: 'all', ...extra,
});

// Mappa sessione -> cella iniettata: il risolutore non deve conoscere fleet.json.
const cellForSession = (s) => (s && s.startsWith('cloud-') ? s.slice('cloud-'.length) : null);

const make = (st) => createCellScope({
  nodesPath: '/finto', loadStoreImpl: () => st, cellForSession,
});

test('senza scope dichiarato il peer vede tutte le celle', () => {
  const scope = make(storeWith(peer(DELIVER))).resolve({ trust: 'federated', visited: [DELIVER, LOCAL] });
  assert.equal(scope.mode, 'all');
  assert.equal(scope.allowsCell('Dev'), true);
  assert.equal(scope.allowsCell('Research'), true);
});

test('selected concede SOLO le celle elencate', () => {
  const st = storeWith(peer(DELIVER, { cellVisibility: 'selected', cells: ['Research'] }));
  const scope = make(st).resolve({ trust: 'federated', visited: [DELIVER, LOCAL] });
  assert.equal(scope.mode, 'selected');
  assert.equal(scope.allowsCell('Research'), true);
  assert.equal(scope.allowsCell('Dev'), false);
  assert.equal(scope.allowsCell('SysAdmin'), false);
});

test('none non concede nulla', () => {
  const st = storeWith(peer(DELIVER, { cellVisibility: 'none' }));
  const scope = make(st).resolve({ trust: 'federated', visited: [DELIVER, LOCAL] });
  assert.equal(scope.allowsCell('Research'), false);
  assert.equal(scope.allowsCell('Dev'), false);
});

test('una sessione tmux e\' concessa solo se lo e\' la sua cella', () => {
  const st = storeWith(peer(DELIVER, { cellVisibility: 'selected', cells: ['Research'] }));
  const scope = make(st).resolve({ trust: 'federated', visited: [DELIVER, LOCAL] });
  assert.equal(scope.allowsSession('cloud-Research'), true);
  assert.equal(scope.allowsSession('cloud-Dev'), false);
  // Una sessione che non appartiene a nessuna cella non e' "libera": e' fuori
  // dallo scope, altrimenti basterebbe una tmux a mano per aggirare tutto.
  assert.equal(scope.allowsSession('mia-build-a-mano'), false);
});

test('multi-hop: lo scope e\' l\'INTERSEZIONE fra chi consegna e chi origina', () => {
  const st = storeWith(
    peer(DELIVER),                                                            // consegna: all
    peer(ORIGIN, { cellVisibility: 'selected', cells: ['Research'] }),        // origina: solo Research
  );
  const scope = make(st).resolve({ trust: 'federated', visited: [ORIGIN, DELIVER, LOCAL] });
  assert.equal(scope.allowsCell('Research'), true);
  assert.equal(scope.allowsCell('Dev'), false, 'l\'originante non deve ereditare lo scope di chi lo instrada');
});

test('multi-hop: il consegnante non puo\' allargare cio\' che l\'origine non ha', () => {
  const st = storeWith(
    peer(DELIVER, { cellVisibility: 'selected', cells: ['Dev'] }),
    peer(ORIGIN, { cellVisibility: 'selected', cells: ['Research'] }),
  );
  const scope = make(st).resolve({ trust: 'federated', visited: [ORIGIN, DELIVER, LOCAL] });
  assert.equal(scope.allowsCell('Dev'), false);
  assert.equal(scope.allowsCell('Research'), false, 'intersezione vuota: nessuna cella in comune');
});

test('un peer sconosciuto non ottiene nulla', () => {
  const scope = make(storeWith()).resolve({ trust: 'federated', visited: [DELIVER, LOCAL] });
  assert.equal(scope.mode, 'none');
  assert.equal(scope.allowsCell('Research'), false);
});

test('catena malformata: fail-closed, non permissivo', () => {
  const st = storeWith(peer(DELIVER));
  for (const visited of [null, [], [LOCAL], undefined]) {
    const scope = make(st).resolve({ trust: 'federated', visited });
    assert.equal(scope.allowsCell('Research'), false, `catena ${JSON.stringify(visited)} non deve concedere`);
  }
});

test('store illeggibile: nega invece di aprire', () => {
  const scope = createCellScope({
    nodesPath: '/finto',
    loadStoreImpl: () => { throw new Error('disco'); },
    cellForSession,
  }).resolve({ trust: 'federated', visited: [DELIVER, LOCAL] });
  assert.equal(scope.allowsCell('Research'), false);
});

test('una richiesta locale non e\' soggetta allo scope dei peer', () => {
  const st = storeWith(peer(DELIVER, { cellVisibility: 'none' }));
  const scope = make(st).resolve({ trust: 'local-bridge' });
  assert.equal(scope.mode, 'all', 'il proprietario della macchina non si limita da solo');
  assert.equal(scope.allowsCell('Dev'), true);
});

test('l\'elenco delle celle si filtra con lo stesso scope, senza logica parallela', () => {
  const st = storeWith(peer(DELIVER, { cellVisibility: 'selected', cells: ['Research'] }));
  const scope = make(st).resolve({ trust: 'federated', visited: [DELIVER, LOCAL] });
  const cells = [{ cell: 'Dev' }, { cell: 'Research' }, { cell: 'SysAdmin' }];
  assert.deepEqual(scope.filterCells(cells).map((c) => c.cell), ['Research']);
  const sessions = [{ name: 'cloud-Dev' }, { name: 'cloud-Research' }, { name: 'libera' }];
  assert.deepEqual(scope.filterSessions(sessions).map((s) => s.name), ['cloud-Research']);
});
