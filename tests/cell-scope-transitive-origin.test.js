'use strict';
// tests/cell-scope-transitive-origin.test.js — la rete a tre nodi.
//
// CASO REALE (2026-08-07): A e C sono entrambi peer di B, e non si conoscono
// fra loro. A chiede le celle di C passando per B. Sul nodo C la catena e'
// [A, B, C]: il consegnante B e' noto, l'origine A NON e' nel suo store —
// perche' non ha alcun motivo di esserlo.
//
// Trattare quell'origine come `none` sembrava prudente ed era una porta chiusa
// in faccia al traffico legittimo: appena lo scope celle e' arrivato sui peer,
// il terzo nodo ha smesso di vedere QUALSIASI cella, senza un errore che lo
// dicesse. Il difetto e' stato segnalato dall'operatore («da AsusRP3 non vedo
// le celle del Pixel»), non dai test — che coprivano solo il caso a due nodi.
const { test } = require('node:test');
const assert = require('node:assert');
const { createCellScope } = require('../lib/cells/scope.js');

const LOCALE = 'c'.repeat(32);     // il nodo che risponde (il Pixel)
const HUB = 'b'.repeat(32);        // chi consegna, ed e' un mio peer (VPS3)
const ESTRANEO = 'a'.repeat(32);   // chi origina, e non e' nel mio store (l'Asus)

const cellForSession = (s) => (s && s.startsWith('cloud-') ? s.slice('cloud-'.length) : null);
const peer = (nodeId, extra = {}) => ({ name: `n-${nodeId.slice(0, 4)}`, nodeId, shared: true, ...extra });

const scopeWith = (nodes, visited) => createCellScope({
  nodesPath: '/finto', loadStoreImpl: () => ({ nodeId: LOCALE, nodes }), cellForSession,
}).resolve({ trust: 'federated', visited });

test('un\'origine che non e\' nel mio store non azzera lo scope', () => {
  // Il caso che si e' rotto in produzione.
  const scope = scopeWith([peer(HUB)], [ESTRANEO, HUB, LOCALE]);
  assert.equal(scope.mode, 'all');
  assert.ok(scope.allowsCell('Dev'));
  assert.ok(scope.allowsSession('cloud-Dev'));
});

test('ma la restrizione di CHI CONSEGNA continua a valere', () => {
  // La correzione non e' un ampliamento: se l'hub che instrada e' ristretto,
  // il traffico che passa da lui resta ristretto.
  const scope = scopeWith(
    [peer(HUB, { cellVisibility: 'selected', cells: ['Research'] })],
    [ESTRANEO, HUB, LOCALE],
  );
  assert.equal(scope.mode, 'selected');
  assert.ok(scope.allowsCell('Research'));
  assert.ok(!scope.allowsCell('Dev'));
});

test('un\'origine CHE E\' mia porta con se\' la propria restrizione, anche in multi-hop', () => {
  // L'invariante originale resta: chi ho ristretto io non guadagna permessi
  // passando da un altro nodo.
  const scope = scopeWith(
    [peer(HUB), peer(ESTRANEO, { cellVisibility: 'selected', cells: ['Foxy'] })],
    [ESTRANEO, HUB, LOCALE],
  );
  assert.equal(scope.mode, 'selected');
  assert.ok(scope.allowsCell('Foxy'));
  assert.ok(!scope.allowsCell('Dev'));
});

test('l\'intersezione fra le due restrizioni resta la piu\' stretta', () => {
  const scope = scopeWith(
    [peer(HUB, { cellVisibility: 'selected', cells: ['Research', 'Foxy'] }),
      peer(ESTRANEO, { cellVisibility: 'selected', cells: ['Foxy', 'Dev'] })],
    [ESTRANEO, HUB, LOCALE],
  );
  assert.deepEqual(scope.cells, ['Foxy']);
});

test('un CONSEGNANTE sconosciuto resta fail-closed', () => {
  // Qui la prudenza va tenuta: chi consegna mi ha parlato autenticandosi, e se
  // non lo trovo nello store qualcosa non torna.
  const scope = scopeWith([], [ESTRANEO, HUB, LOCALE]);
  assert.equal(scope.mode, 'none');
  assert.ok(!scope.allowsCell('Dev'));
});

test('a due nodi nulla cambia: origine e consegnante coincidono', () => {
  const aperto = scopeWith([peer(HUB)], [HUB, LOCALE]);
  assert.equal(aperto.mode, 'all');
  const ristretto = scopeWith([peer(HUB, { cellVisibility: 'none' })], [HUB, LOCALE]);
  assert.equal(ristretto.mode, 'none');
});
