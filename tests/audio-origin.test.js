'use strict';
// tests/audio-origin.test.js — risoluzione dell'origine, casi limite.
// L'end-to-end federato vive in audio-federation-e2e; qui si isolano le
// decisioni che un percorso completo attraverserebbe senza mostrarle.
const { test } = require('node:test');
const assert = require('node:assert');
const { createOriginResolver, parseVisitedChain } = require('../lib/audio/origin.js');
const ba = require('../lib/audio/bridge-auth.js');
const { createHopSecret, signHop, HOP_HEADER } = require('../lib/proxy/hop-proof.js');

const SELF = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const THIRD = 'c'.repeat(32);
const SECRET = 's'.repeat(43);
const SESSION = 'cloud-Dev';

function resolver(over = {}) {
  return createOriginResolver({
    localNodeId: () => SELF,
    activeCells: async () => [{ cell: 'Dev', tmuxSession: SESSION, active: true }],
    bridgeSecret: () => SECRET,
    hopSecret: () => null,
    nonceCache: ba.createNonceCache(),
    ...over,
  });
}

function bridgeReq(over = {}) {
  const rawBody = Buffer.from(JSON.stringify({ target: SELF, text: 'x' }));
  const headers = ba.signedHeaders(SECRET, { method: 'POST', path: '/api/audio/speak', session: SESSION, rawBody });
  return { method: 'POST', originalUrl: '/api/audio/speak', headers, rawBody, body: {}, ...over };
}

test('senza identita di nodo si fallisce chiuso, non si inventa un nodeId vuoto', async () => {
  const r = resolver({ localNodeId: () => null });
  assert.deepEqual(await r.resolve(bridgeReq()), { ok: false, reason: 'no-node-identity' });
});

test('bridge: firma valida su cella attiva => origine locale verificata', async () => {
  const out = await resolver().resolve(bridgeReq());
  assert.equal(out.ok, true);
  assert.deepEqual(out.origin, { node: SELF, cell: 'Dev' });
  assert.equal(out.trust, 'local-bridge');
});

test('bridge: la cella deve essere ATTIVA adesso, non solo esistere', async () => {
  const r = resolver({ activeCells: async () => [{ cell: 'Dev', tmuxSession: SESSION, active: false }] });
  assert.equal((await r.resolve(bridgeReq())).reason, 'cell-not-active');
});

test('bridge: se lo stato Fleet non e leggibile non si concede il beneficio del dubbio', async () => {
  const r = resolver({ activeCells: async () => { throw new Error('fleet giu'); } });
  assert.equal((await r.resolve(bridgeReq())).reason, 'fleet-unavailable');
  const r2 = resolver({ activeCells: async () => null });
  assert.equal((await r2.resolve(bridgeReq())).reason, 'fleet-unavailable');
});

test('bridge: nessuna firma => nessuna origine, per quanto il body sia convincente', async () => {
  const r = resolver();
  const req = { method: 'POST', originalUrl: '/api/audio/speak', headers: {}, body: { session: SESSION, originCell: 'Dev' } };
  assert.equal((await r.resolve(req)).ok, false);
});

test('hop: senza prova valida un client non diventa federato', async () => {
  const hop = createHopSecret();
  const r = resolver({ hopSecret: () => hop });
  const req = {
    method: 'POST', originalUrl: '/api/audio/speak',
    headers: { 'x-nexuscrew-visited': `${OTHER},${SELF}`, [HOP_HEADER]: 'd'.repeat(64) },
    body: { originCell: 'Evil' },
  };
  assert.equal((await r.resolve(req)).reason, 'bad-hop');
});

test('hop: prova valida => origine = primo nodo della catena, non un campo del body', async () => {
  const hop = createHopSecret();
  const visited = [OTHER, SELF];
  const r = resolver({ hopSecret: () => hop });
  const req = {
    method: 'POST', originalUrl: '/api/audio/speak',
    headers: {
      'x-nexuscrew-visited': visited.join(','),
      [HOP_HEADER]: signHop(hop, { method: 'POST', path: '/api/audio/speak', visited }),
    },
    body: { originCell: 'Dev', originNode: OTHER },
  };
  const out = await r.resolve(req);
  assert.equal(out.ok, true);
  assert.equal(out.origin.node, OTHER);
  assert.equal(out.trust, 'federated');
});

test('hop: un originNode del body in conflitto con la catena fa cadere la richiesta', async () => {
  const hop = createHopSecret();
  const visited = [OTHER, SELF];
  const r = resolver({ hopSecret: () => hop });
  const req = {
    method: 'POST', originalUrl: '/api/audio/speak',
    headers: {
      'x-nexuscrew-visited': visited.join(','),
      [HOP_HEADER]: signHop(hop, { method: 'POST', path: '/api/audio/speak', visited }),
    },
    body: { originCell: 'Dev', originNode: THIRD },
  };
  assert.equal((await r.resolve(req)).reason, 'origin-mismatch',
    'in conflitto vince la catena controllata dal server, e la richiesta cade invece di essere corretta in silenzio');
});

test('hop: una catena che parte dal nodo locale non e un inbound federato', async () => {
  const hop = createHopSecret();
  const visited = [SELF];
  const r = resolver({ hopSecret: () => hop });
  const req = {
    method: 'POST', originalUrl: '/api/audio/speak',
    headers: {
      'x-nexuscrew-visited': visited.join(','),
      [HOP_HEADER]: signHop(hop, { method: 'POST', path: '/api/audio/speak', visited }),
    },
    body: { originCell: 'Dev' },
  };
  assert.equal((await r.resolve(req)).reason, 'self-hop');
});

test('hop: una prova firmata per un altro path non e trasportabile', async () => {
  const hop = createHopSecret();
  const visited = [OTHER, SELF];
  const r = resolver({ hopSecret: () => hop });
  const req = {
    method: 'POST', originalUrl: '/api/audio/speak',
    headers: {
      'x-nexuscrew-visited': visited.join(','),
      [HOP_HEADER]: signHop(hop, { method: 'POST', path: '/api/audio/stop', visited }),
    },
    body: { originCell: 'Dev' },
  };
  assert.equal((await r.resolve(req)).reason, 'bad-hop');
});

test('catena visited: forma validata — deve chiudersi sul nodo locale, senza cicli', () => {
  assert.deepEqual(parseVisitedChain(`${OTHER},${SELF}`, SELF), [OTHER, SELF]);
  assert.equal(parseVisitedChain(`${OTHER},${THIRD}`, SELF), null, 'l ultimo hop deve essere questo nodo');
  assert.equal(parseVisitedChain(`${OTHER},${OTHER},${SELF}`, SELF), null, 'nessun nodo ripetuto');
  assert.equal(parseVisitedChain('non-hex,' + SELF, SELF), null);
  assert.equal(parseVisitedChain('', SELF), null);
});

// Confine dichiarato, non un difetto scoperto per caso: fra nodi diversi non
// esiste un segreto condiviso end-to-end, quindi il nodo di origine e' provato
// dalla catena ma la CELLA che dichiara resta un'attestazione di quel nodo.
// Il test lo fissa per iscritto perche' non venga scambiato per una verifica.
test('confine: la cella remota e attestata dal suo nodo, non verificata da qui', async () => {
  const hop = createHopSecret();
  const visited = [OTHER, SELF];
  const r = resolver({ hopSecret: () => hop });
  const req = {
    method: 'POST', originalUrl: '/api/audio/speak',
    headers: {
      'x-nexuscrew-visited': visited.join(','),
      [HOP_HEADER]: signHop(hop, { method: 'POST', path: '/api/audio/speak', visited }),
    },
    body: { originCell: 'CellaCheQuelNodoDichiara' },
  };
  const out = await r.resolve(req);
  assert.equal(out.ok, true);
  assert.equal(out.trust, 'federated');
  assert.equal(out.origin.cell, 'CellaCheQuelNodoDichiara');
  assert.equal(out.origin.node, OTHER,
    'il nodo resta quello provato: il tetto per target e calcolato su questo, non sul nome dichiarato');
});

test('cella attestata: nomi malformati restano rifiutati anche via federazione', async () => {
  const hop = createHopSecret();
  const visited = [OTHER, SELF];
  const r = resolver({ hopSecret: () => hop });
  const mk = (originCell) => ({
    method: 'POST', originalUrl: '/api/audio/speak',
    headers: {
      'x-nexuscrew-visited': visited.join(','),
      [HOP_HEADER]: signHop(hop, { method: 'POST', path: '/api/audio/speak', visited }),
    },
    body: { originCell },
  });
  for (const bad of ['', 'a'.repeat(33), 'con spazio', 'con/slash', null, 42]) {
    assert.equal((await r.resolve(mk(bad))).reason, 'bad-attested-cell', `rifiutato: ${String(bad)}`);
  }
});
