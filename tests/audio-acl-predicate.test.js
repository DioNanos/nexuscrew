'use strict';
// tests/audio-acl-predicate.test.js — il predicato che decide chi puo' far
// parlare questo dispositivo, provato direttamente.
//
// Perche' esiste questo file: `allows()` non era esercitato da nessun test —
// era coperto solo di rimbalzo dai test e2e delle route audio. In particolare
// NON era protetta la riga che a me e' costata una regressione altrove:
//
//     if (originPeer && !peerAllows(originPeer, st.nodeId))
//
// Quel `originPeer &&` e' una TOLLERANZA deliberata: un'origine che non e' nel
// mio store non e' un peer che governo, e va lasciata passare — la restrizione
// che conta e' quella di chi consegna. Nello scope celle avevo replicato la
// struttura di questo modulo senza replicare quella riga, e il risultato e'
// stato che in una rete a tre nodi il terzo smetteva di vedere qualsiasi cosa.
//
// Qui il comportamento e' corretto oggi. Questo file serve a fare in modo che
// resti corretto quando qualcuno, per prudenza, vorra' irrigidirlo.
const { test } = require('node:test');
const assert = require('node:assert');
const { createAudioAcl } = require('../lib/audio/acl.js');

const LOCALE = 'c'.repeat(32);
const HUB = 'b'.repeat(32);
const ESTRANEO = 'a'.repeat(32);

const peer = (nodeId, extra = {}) => ({
  name: `n-${nodeId.slice(0, 4)}`, nodeId, shared: true, visibility: 'network', ...extra,
});
const acl = (nodes) => createAudioAcl({
  nodesPath: '/finto', loadStoreImpl: () => ({ nodeId: LOCALE, nodes }),
});

test('rete a tre nodi: un\'origine sconosciuta NON blocca la voce', () => {
  // Il caso che nello scope celle era rotto. Qui deve restare permesso.
  const res = acl([peer(HUB)]).allows({
    trust: 'federated', origin: { node: ESTRANEO }, visited: [ESTRANEO, HUB, LOCALE],
  });
  assert.deepEqual(res, { allowed: true });
});

test('ma un CONSEGNANTE sconosciuto resta rifiutato', () => {
  // Chi consegna mi ha parlato: se non lo conosco, non diventa autorevole per
  // il fatto di aver bussato.
  const res = acl([]).allows({
    trust: 'federated', origin: { node: ESTRANEO }, visited: [ESTRANEO, HUB, LOCALE],
  });
  assert.equal(res.allowed, false);
  assert.equal(res.reason, 'unknown-peer');
});

test('un\'origine CHE E\' mia e non mi vede resta rifiutata', () => {
  // La tolleranza vale per chi non governo, non per chi ho marcato relay-only:
  // quello puo' far transitare traffico, non farmi parlare.
  const res = acl([peer(HUB), peer(ESTRANEO, { visibility: 'relay-only' })]).allows({
    trust: 'federated', origin: { node: ESTRANEO }, visited: [ESTRANEO, HUB, LOCALE],
  });
  assert.equal(res.allowed, false);
  assert.equal(res.reason, 'origin-visibility');
});

test('la visibilita\' di CHI CONSEGNA continua a decidere', () => {
  const res = acl([peer(HUB, { visibility: 'selected', selected: [] })]).allows({
    trust: 'federated', origin: { node: ESTRANEO }, visited: [ESTRANEO, HUB, LOCALE],
  });
  assert.equal(res.allowed, false);
  assert.equal(res.reason, 'peer-visibility');
});

test('il bridge locale non passa da qui', () => {
  assert.deepEqual(acl([]).allows({ trust: 'local-bridge' }), { allowed: true });
});

test('una fiducia che non si riconosce non e\' una fiducia', () => {
  assert.equal(acl([]).allows({ trust: 'boh' }).reason, 'unknown-trust');
  assert.equal(acl([]).allows({}).reason, 'unknown-trust');
});

test('una catena troppo corta non identifica nessuno', () => {
  const res = acl([peer(HUB)]).allows({
    trust: 'federated', origin: { node: HUB }, visited: [LOCALE],
  });
  assert.equal(res.reason, 'no-delivering-peer');
});

test('store illeggibile: si nega, non si indovina', () => {
  const rotto = createAudioAcl({
    nodesPath: '/finto', loadStoreImpl: () => { throw new Error('disco'); },
  });
  const res = rotto.allows({
    trust: 'federated', origin: { node: ESTRANEO }, visited: [ESTRANEO, HUB, LOCALE],
  });
  assert.equal(res.reason, 'store-unavailable');
});
