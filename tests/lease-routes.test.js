'use strict';
// Route /api/lease — la cella si risolve sul catalogo fleet CORRENTE: la
// sessione EFFETTIVA dichiarata (override, altrimenti default canonico)
// decide nel percorso legacy; in authority il subject resta il proof
// verificato e la sessione del body è solo un confronto anti-confusione.
// I gruppi B01-B19 coprono il contratto completo: ogni rifiuto di mapping è
// accompagnato da spy sui metodi del manager e confronto dello stato
// supervisore prima/dopo, oltre allo status HTTP.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const express = require('express');
const { leaseRoutes } = require('../lib/fleet/lease-routes.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { atomicWrite, tmuxSessionForCell, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createIdentityAuthority } = require('../lib/fleet/identity-authority.js');
const { createMcpIdentityProvider, persistIdentityChannel } = require('../lib/mcp/identity-provider.js');
const { ENGINE, catalogDoc, catalogFixture } = require('./helpers/lease-catalog.js');

// Celle del catalogo di default: canonica, override con prefisso di nodo,
// override custom arbitrario, id puntato (default v2 derivato dal parser).
const DEFAULT_CELLS = [
  { id: 'Dev' },
  { id: 'SysAdmin', tmuxSession: 'edge-SysAdmin' },
  { id: 'Fork', tmuxSession: 'rack-Fork' },
  { id: 'Trading', tmuxSession: 'jarvis' },
  { id: 'agy.native' },
];
const SESSION_V2 = tmuxSessionForCell('agy.native');

// Catalogo scritto a mano (NON validato da atomicWrite): per i documenti
// volutamente invalidi, che un loader validante deve rifiutare.
function rawCatalog(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lease-catalog-'));
  const defsPath = path.join(dir, 'fleet.json');
  fs.writeFileSync(defsPath, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return {
    defsPath,
    // stessa proiezione della lettura stretta del provider
    leaseCellCatalog: () => {
      const d = loadDefinitions(defsPath);
      if (!d) return { ok: false, code: 'LEASE_CATALOG_UNAVAILABLE' };
      return { ok: true, cells: d.cells.map((c) => ({ id: c.id, tmuxSession: c.tmuxSession })) };
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// Factory di proof identity: ogni chiamata emette challenge+grant+proof
// freschi (i proof sono one-shot, un riuso sarebbe un replay).
function makeAuthority(home, { now } = {}) {
  const authority = createIdentityAuthority({
    dir: path.join(home, 'identity'),
    serviceCredential: 'fixture-service-credential',
    ...(now ? { now } : {}),
  });
  let n = 0;
  const proofFor = (cellId, { audience = 'nexuscrew-lease' } = {}) => {
    n += 1;
    const tuple = {
      ownerInstanceId: 'owner-a', cellId, audience,
      incarnationId: `incarnation-${n}`, launchEpoch: `epoch-${n}`,
      daemonBootId: 'boot-a', connectionId: `connection-${n}`,
    };
    const challenge = authority.registerDaemonChallenge({ serviceCredential: 'fixture-service-credential', ...tuple });
    const grant = authority.issueLaunchGrant({ serviceCredential: 'fixture-service-credential', challenge: challenge.challenge, ...tuple });
    return authority.issueChallengeProof({ launchGrant: grant.grant, challenge: challenge.challenge }).proof;
  };
  return { authority, proofFor };
}

// Spy sul manager: registra ogni chiamata ai metodi child/track e fotografa
// lo stato supervisore (lease + control) per il confronto prima/dopo.
function withSpies(mgr) {
  const calls = { childRegister: [], childRefresh: [], childRecovery: [], childIntrospect: [], track: [] };
  for (const name of Object.keys(calls)) {
    const orig = mgr[name].bind(mgr);
    mgr[name] = (...args) => { calls[name].push(args); return orig(...args); };
  }
  return {
    calls,
    supervisor(cell) {
      return JSON.stringify({
        status: mgr.status(cell),
        controlArmato: mgr.controlArmato(cell),
        controlEpoch: mgr.controlEpoch(cell),
      });
    },
  };
}

function buildWorld({ cells = DEFAULT_CELLS, realClock = false, catalog = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leaseroutes-'));
  const clock = realClock ? null : { t: 10_000 };
  const cat = catalog || catalogFixture(cells);
  const mgr = createLeaseManager(
    { home, log: () => {} },
    ...(realClock ? [] : [{ now: () => clock.t }]),
  );
  const { authority, proofFor } = makeAuthority(home, realClock ? {} : { now: () => 10_000 });
  const spies = withSpies(mgr);
  const makeFleet = (over = {}) => ({
    available: true,
    lease: mgr,
    identityAuthority: authority,
    leaseCellCatalog: cat.leaseCellCatalog,
    ...over,
  });
  const listen = ({ fleetP = null, identityMode = 'authority', readonly = false, instanceId = null } = {}) => {
    const app = express();
    app.use(express.json({ limit: '8kb' }));
    app.use('/api/lease', leaseRoutes({
      fleetP: fleetP || Promise.resolve(makeFleet()),
      readonly: () => readonly,
      identityMode,
      ...(instanceId !== null ? { instanceId: () => instanceId } : {}),
    }));
    const server = http.createServer(app);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
      });
    });
  };
  return {
    home, clock, catalog: cat, mgr, authority, proofFor, ...spies, makeFleet, listen,
    cleanup() {
      try { mgr.close(); } catch (_) { /* best-effort */ }
      cat.cleanup();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

async function call(base, p, body, headers = {}) {
  const r = await fetch(`${base}/api/lease${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const sessionDev = () => tmuxSessionForCell('Dev');

// Setup monouso per i test storici.
async function setup({ readonly = false, identityMode = 'authority', cells = DEFAULT_CELLS } = {}) {
  const w = buildWorld({ cells });
  const srv = await w.listen({ identityMode, readonly });
  return {
    url: srv.url, close: async () => { await srv.close(); w.cleanup(); },
    clock: w.clock, mgr: w.mgr, home: w.home, catalog: w.catalog, calls: w.calls,
    supervisor: w.supervisor, proofFor: w.proofFor,
    identityProof: w.proofFor('Dev'),
  };
}

// ---------------------------------------------------------------------------
// Test storici (contratti conservati)
// ---------------------------------------------------------------------------

test('register: la sessione nel body non è più una credenziale', async () => {
  const s = await setup();
  try {
    const out = await call(s.url, '/register', { session: sessionDev() });
    assert.equal(out.status, 400);
    assert.match(out.json.error, /proof/i);
  } finally { await s.close(); }
});

test('register: proof valido -> registration; proof kind child in risposta', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    const out = await call(s.url, '/register', { proof: s.identityProof });
    assert.equal(out.status, 200);
    assert.equal(out.json.status, 'registered');
    assert.equal(out.json.proof.kind, 'child');
    assert.equal(out.json.proof.cellId, 'Dev');
  } finally { await s.close(); }
});

test('register legacy: la modalità server preserva il percorso D con la sessione', async () => {
  const s = await setup({ identityMode: 'legacy' });
  try {
    await s.mgr.track('Dev');
    const out = await call(s.url, '/register', { session: sessionDev() });
    assert.equal(out.status, 200);
    assert.equal(out.json.status, 'registered');
    assert.equal(out.json.proof.kind, 'child');
  } finally { await s.close(); }
});

test('register: proof malformato -> denied dal verifier, body vuoto -> 400', async () => {
  const s = await setup();
  try {
    const bad = await call(s.url, '/register', { proof: { cellId: 'nope-$$$' } });
    assert.equal(bad.status, 200);
    assert.equal(bad.json.status, 'denied');
    const missing = await call(s.url, '/register', {});
    assert.equal(missing.status, 400);
  } finally { await s.close(); }
});

test('register: cella NON tracciata -> pending (200 con status)', async () => {
  const s = await setup();
  try {
    const out = await call(s.url, '/register', { proof: s.identityProof });
    assert.equal(out.status, 200);
    assert.equal(out.json.status, 'pending');
    assert.ok(Number.isFinite(out.json.retryAfterMs));
  } finally { await s.close(); }
});

test('refresh e recovery via route: esiti del manager, proof in ingresso e in uscita', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    const reg = await call(s.url, '/register', { proof: s.identityProof });
    const rf = await call(s.url, '/refresh', { proof: reg.json.proof });
    assert.equal(rf.status, 200);
    assert.equal(rf.json.status, 'live');
    s.clock.t += 61_000;
    const rec = await call(s.url, '/recovery', { proof: rf.json.proof });
    assert.equal(rec.status, 200);
    assert.equal(rec.json.status, 'live');
    assert.equal(rec.json.incarnationId, reg.json.incarnationId);
  } finally { await s.close(); }
});

test('refresh con sessione di un altra cella -> 400, nessun live', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    await s.mgr.track('Research');
    const regDev = await call(s.url, '/register', { proof: s.identityProof });
    const rf = await call(s.url, '/refresh', { session: tmuxSessionForCell('Research'), proof: regDev.json.proof });
    assert.equal(rf.status, 400);
    assert.match(rf.json.error, /differs from the cell's effective session/);
  } finally { await s.close(); }
});

test('lease non disponibile (fleet senza lease) -> 501 chiaro, non 500 ambiguo', async () => {
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use('/api/lease', leaseRoutes({ fleetP: Promise.resolve({ available: true }) }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/lease/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: sessionDev() }),
    });
    assert.equal(r.status, 501);
    assert.match((await r.json()).error, /lease non disponibile/);
  } finally {
    await new Promise((r2) => server.close(r2));
  }
});

test('readonly -> 403 su tutte e tre le mutazioni', async () => {
  const s = await setup({ readonly: true });
  try {
    const a = await call(s.url, '/register', { session: sessionDev() });
    const b = await call(s.url, '/refresh', { session: sessionDev(), proof: {} });
    const c = await call(s.url, '/recovery', { session: sessionDev(), proof: {} });
    assert.equal(a.status, 403);
    assert.equal(b.status, 403);
    assert.equal(c.status, 403);
  } finally { await s.close(); }
});

test('introspect: authority only; registration authority-backed ok, legacy denied', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    const reg = await call(s.url, '/register', { proof: s.identityProof });
    assert.equal(reg.json.identityMode, 'authority');
    const out = await call(s.url, '/introspect', { proof: reg.json.proof });
    assert.equal(out.status, 200);
    assert.equal(out.json.status, 'live');
    assert.equal(out.json.cellId, 'Dev');
    assert.equal(out.json.tmuxSession, 'cloud-Dev');
    assert.equal(out.json.identityMode, 'authority');
    assert.equal(out.json.incarnationId, reg.json.incarnationId);
    assert.equal(out.json.expiresAt, reg.json.proof.expiresAt);
    s.clock.t += 61_000;
    const stale = await call(s.url, '/introspect', { proof: reg.json.proof });
    assert.equal(stale.json.status, 'expired');
  } finally { await s.close(); }
});

test('introspect: legacy mode 501 e proof di registration legacy mai autorizzato', async () => {
  const legacy = await setup({ identityMode: 'legacy' });
  try {
    await legacy.mgr.track('Dev');
    const reg = await call(legacy.url, '/register', { session: sessionDev() });
    assert.equal(reg.json.status, 'registered');
    assert.equal(reg.json.identityMode, undefined);
    const off = await call(legacy.url, '/introspect', { proof: reg.json.proof });
    assert.equal(off.status, 501);
  } finally { await legacy.close(); }
  const authority = await setup();
  try {
    await authority.mgr.track('Dev');
    const reg = authority.mgr.childRegister('Dev');
    assert.equal(reg.status, 'registered');
    const out = await call(authority.url, '/introspect', { proof: reg.proof });
    assert.equal(out.status, 200);
    assert.equal(out.json.status, 'denied');
    assert.equal(out.json.reason, 'legacy-registration');
  } finally { await authority.close(); }
});

// ---------------------------------------------------------------------------
// B01-B19 — contratto del resolver stretto e delle quattro route
// ---------------------------------------------------------------------------

test('B01 register legacy: ogni sessione dichiarata risolve l_unica cella giusta', async () => {
  const casi = [
    ['cloud-Dev', 'Dev'],
    ['edge-SysAdmin', 'SysAdmin'],
    ['rack-Fork', 'Fork'],
    ['jarvis', 'Trading'],
    [SESSION_V2, 'agy.native'],
  ];
  for (const [session, expectedCell] of casi) {
    const s = await setup({ identityMode: 'legacy' });
    try {
      await s.mgr.track(expectedCell);
      const out = await call(s.url, '/register', { session });
      assert.equal(out.status, 200, `sessione ${session}`);
      assert.equal(out.json.status, 'registered', `sessione ${session}`);
      assert.equal(out.json.proof.cellId, expectedCell, `sessione ${session} deve registrare ESATTAMENTE ${expectedCell}`);
      assert.deepEqual(s.calls.childRegister, [[expectedCell, { authority: false }]], `sessione ${session}: childRegister con la cella giusta`);
    } finally { await s.close(); }
  }
});

test('B02 cella dichiarata ma non tracciata -> pending, nessun track né lease/control creati', async () => {
  const s = await setup({ identityMode: 'legacy' });
  try {
    const before = s.supervisor('Trading');
    const out = await call(s.url, '/register', { session: 'jarvis' });
    assert.equal(out.status, 200);
    assert.equal(out.json.status, 'pending');
    assert.ok(Number.isFinite(out.json.retryAfterMs));
    assert.equal(s.calls.track.length, 0, 'nessun track per trasformare pending in registered');
    assert.equal(s.supervisor('Trading'), before, 'nessuna lease/control del supervisore');
  } finally { await s.close(); }
});

test('B03 sessione non dichiarata -> 400 LEASE_SESSION_INVALID, zero registration', async () => {
  const s = await setup({ identityMode: 'legacy' });
  try {
    // 'edge-Fork': l'id derivato togliendo il prefisso esiste, ma la sessione
    // DICHIARATA di quella cella è un'altra ('rack-Fork'): il prefisso non è
    // un fallback, il confronto è sul nome effettivo.
    for (const session of ['cloud-Research', 'edge-Research', 'rack-Research', 'edge-Fork', 'rack-SysAdmin']) {
      const out = await call(s.url, '/register', { session });
      assert.equal(out.status, 400, `sessione ${session}`);
      assert.equal(out.json.code, 'LEASE_SESSION_INVALID', `sessione ${session}`);
    }
    assert.equal(s.calls.childRegister.length, 0);
    assert.equal(s.calls.track.length, 0);
  } finally { await s.close(); }
});

test('B04 catalogo cambiato senza restart: default con override, rename e rimozione -> rifiuto', async () => {
  const s = await setup({ identityMode: 'legacy' });
  try {
    await s.mgr.track('SysAdmin');
    await s.mgr.track('Trading');
    // default canonico di una cella con override: NON è un alias ammesso
    const alias = await call(s.url, '/register', { session: 'cloud-SysAdmin' });
    assert.equal(alias.status, 400);
    assert.equal(alias.json.code, 'LEASE_SESSION_INVALID');
    // la sessione effettiva registra...
    assert.equal((await call(s.url, '/register', { session: 'edge-SysAdmin' })).json.status, 'registered');
    // ...rename: l'override cambia e la sessione vecchia muore con lui
    s.catalog.rewrite([
      { id: 'Dev' },
      { id: 'SysAdmin', tmuxSession: 'edge-SysAdmin2' },
      { id: 'Fork', tmuxSession: 'rack-Fork' },
      { id: 'agy.native' },
    ]);
    const vecchia = await call(s.url, '/register', { session: 'edge-SysAdmin' });
    assert.equal(vecchia.status, 400);
    assert.equal(vecchia.json.code, 'LEASE_SESSION_INVALID');
    // ...rimozione: il vecchio nome custom non sopravvive alla cella
    const rimossa = await call(s.url, '/register', { session: 'jarvis' });
    assert.equal(rimossa.status, 400);
    assert.equal(s.calls.childRegister.length, 1, 'solo la sessione effettiva ha registrato');
  } finally { await s.close(); }
});

test('B05 duplicato nel documento o snapshot ambiguo -> 503 LEASE_CATALOG_UNAVAILABLE, mai la prima', async () => {
  // documento con id duplicato: il parser lo rifiuta, il catalogo è invalido
  const docDuplicato = {
    ...catalogDoc(DEFAULT_CELLS),
    cells: [...catalogDoc(DEFAULT_CELLS).cells, { id: 'Dev', cwd: '/tmp', engine: 'claude' }],
  };
  const dup = rawCatalog(docDuplicato);
  const w1 = buildWorld({ catalog: dup });
  const srv1 = await w1.listen({ identityMode: 'legacy' });
  try {
    await w1.mgr.track('Dev');
    const out = await call(srv1.url, '/register', { session: 'cloud-Dev' });
    assert.equal(out.status, 503);
    assert.equal(out.json.code, 'LEASE_CATALOG_UNAVAILABLE');
    assert.equal(w1.calls.childRegister.length, 0);
  } finally { await srv1.close(); w1.cleanup(); }
  // snapshot iniettato ambiguo (due candidate per la stessa sessione)
  const w2 = buildWorld();
  const srv2 = await w2.listen({
    identityMode: 'legacy',
    fleetP: Promise.resolve(w2.makeFleet({
      leaseCellCatalog: () => ({
        ok: true,
        cells: [
          { id: 'Dev', tmuxSession: 'cloud-Dev' },
          { id: 'Dev2', tmuxSession: 'cloud-Dev' },
        ],
      }),
    })),
  });
  try {
    await w2.mgr.track('Dev');
    const out = await call(srv2.url, '/register', { session: 'cloud-Dev' });
    assert.equal(out.status, 503);
    assert.equal(out.json.code, 'LEASE_CATALOG_UNAVAILABLE');
    assert.equal(w2.calls.childRegister.length, 0, 'mai «prendi la prima»');
  } finally { await srv2.close(); w2.cleanup(); }
});

test('B06 catalogo rimosso/invalido dopo un successo -> 503, nessuna riesumazione', async () => {
  // mondo 1: successo, poi il file sparisce
  const s = await setup({ identityMode: 'legacy' });
  try {
    await s.mgr.track('Dev');
    assert.equal((await call(s.url, '/register', { session: 'cloud-Dev' })).json.status, 'registered');
    fs.rmSync(s.catalog.defsPath);
    const gone = await call(s.url, '/register', { session: 'cloud-Dev' });
    assert.equal(gone.status, 503);
    assert.equal(gone.json.code, 'LEASE_CATALOG_UNAVAILABLE');
    assert.equal(s.calls.childRegister.length, 1, 'solo la prima, valida, ha registrato');
  } finally { await s.close(); }
  // mondo 2: JSON rotto
  const rotto = rawCatalog('{"schemaVersion": 1, "cells": [');
  const w2 = buildWorld({ catalog: rotto });
  const srv2 = await w2.listen({ identityMode: 'legacy' });
  try {
    const out = await call(srv2.url, '/register', { session: 'cloud-Dev' });
    assert.equal(out.status, 503);
    assert.equal(out.json.code, 'LEASE_CATALOG_UNAVAILABLE');
    assert.equal(w2.calls.childRegister.length, 0);
  } finally { await srv2.close(); w2.cleanup(); }
  // mondo 3: definizione strutturalmente invalida (engine inesistente)
  const invalido = rawCatalog({
    schemaVersion: 1,
    engines: [{ ...ENGINE }],
    cells: [{ id: 'Dev', cwd: '/tmp', engine: 'ghost' }],
  });
  const w3 = buildWorld({ catalog: invalido });
  const srv3 = await w3.listen({ identityMode: 'legacy' });
  try {
    const out = await call(srv3.url, '/register', { session: 'cloud-Dev' });
    assert.equal(out.status, 503);
    assert.equal(out.json.code, 'LEASE_CATALOG_UNAVAILABLE');
    assert.equal(w3.calls.childRegister.length, 0);
  } finally { await srv3.close(); w3.cleanup(); }
});

test('B07 nessuna coercizione del body: valori malformati -> 400, session assente in legacy -> 400', async () => {
  const s = await setup({ identityMode: 'legacy' });
  try {
    await s.mgr.track('Dev');
    const malformate = ['', ' ', null, 123, ['cloud-Dev'], { a: 1 }, 'cloud-Dev ', ' cloud-Dev',
      'cloud-Dev\n', `cloud-${'x'.repeat(100)}`, 'CLOUD-DEV', 'Cloud-Dev'];
    for (const session of malformate) {
      const out = await call(s.url, '/register', { session });
      assert.equal(out.status, 400, `sessione ${JSON.stringify(session)}`);
      assert.equal(out.json.code, 'LEASE_SESSION_INVALID', `sessione ${JSON.stringify(session)}`);
    }
    const missing = await call(s.url, '/register', {});
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'LEASE_SESSION_INVALID');
    assert.equal(s.calls.childRegister.length, 0);
  } finally { await s.close(); }
});

test('B08 authority: subject dal proof; sessione opzionale deve essere quella effettiva', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    await s.mgr.track('SysAdmin');
    await s.mgr.track('Trading');
    // assente -> subject del proof
    const noSession = await call(s.url, '/register', { proof: s.proofFor('SysAdmin') });
    assert.equal(noSession.status, 200);
    assert.equal(noSession.json.proof.cellId, 'SysAdmin');
    assert.deepEqual(s.calls.childRegister.at(-1), ['SysAdmin', { authority: true }]);
    // effettiva (override con prefisso) -> ok
    const effettiva = await call(s.url, '/register', { session: 'edge-SysAdmin', proof: s.proofFor('SysAdmin') });
    assert.equal(effettiva.status, 200);
    assert.equal(effettiva.json.proof.cellId, 'SysAdmin');
    // alias canonico di cella con override -> rifiuto
    const alias = await call(s.url, '/register', { session: 'cloud-SysAdmin', proof: s.proofFor('SysAdmin') });
    assert.equal(alias.status, 400);
    assert.equal(alias.json.code, 'LEASE_SESSION_MISMATCH');
    // sessione effettiva di UN_ALTRO subject -> rifiuto, mai registration di B
    const diB = await call(s.url, '/register', { session: 'cloud-Dev', proof: s.proofFor('SysAdmin') });
    assert.equal(diB.status, 400);
    assert.equal(diB.json.code, 'LEASE_SESSION_MISMATCH');
    // valori presenti ma non stringa valida: sono presenti, si rifiutano
    for (const session of [null, '', 42, ['edge-SysAdmin']]) {
      const presente = await call(s.url, '/register', { session, proof: s.proofFor('SysAdmin') });
      assert.equal(presente.status, 400, `sessione presente ${JSON.stringify(session)}`);
      assert.equal(presente.json.code, 'LEASE_SESSION_MISMATCH');
    }
    const registrate = s.calls.childRegister.length;
    // subject rimosso dal catalogo -> rifiuto, niente registration
    s.catalog.rewrite(DEFAULT_CELLS.filter((c) => c.id !== 'Trading'));
    const rimossa = await call(s.url, '/register', { proof: s.proofFor('Trading') });
    assert.equal(rimossa.status, 400);
    assert.equal(rimossa.json.code, 'LEASE_CELL_INVALID');
    assert.equal(s.calls.childRegister.length, registrate, 'nessuna registration dal rifiuto');
  } finally { await s.close(); }
});

test('B09 authority: proof negato non passa al legacy; subject estraneo rifiutato senza registration', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    await s.mgr.track('Research');
    // proof assente -> 400
    assert.equal((await call(s.url, '/register', {})).status, 400);
    // proof alterato -> denied dal verifier, zero registration
    const altered = await call(s.url, '/register', { proof: { ...s.proofFor('Dev'), jti: 'f'.repeat(16) } });
    assert.equal(altered.status, 200);
    assert.equal(altered.json.status, 'denied');
    // audience sbagliata -> denied, zero registration
    const altraAudience = await call(s.url, '/register', { proof: s.proofFor('Dev', { audience: 'altra' }) });
    assert.equal(altraAudience.status, 200);
    assert.equal(altraAudience.json.status, 'denied');
    assert.equal(s.calls.childRegister.length, 0);
    // replay: un proof buono una volta sola
    const buono = s.proofFor('Dev');
    assert.equal((await call(s.url, '/register', { proof: buono })).json.status, 'registered');
    const replay = await call(s.url, '/register', { proof: buono });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.status, 'denied');
    assert.equal(s.calls.childRegister.length, 1, 'il replay non registra due volte');
    // subject estraneo (verificato ma non dichiarato) -> rifiuto di mapping, mai pending
    const before = s.supervisor('Research');
    const estraneo = await call(s.url, '/register', { proof: s.proofFor('Research') });
    assert.equal(estraneo.status, 400);
    assert.equal(estraneo.json.code, 'LEASE_CELL_INVALID');
    assert.equal(s.calls.childRegister.length, 1);
    assert.equal(s.supervisor('Research'), before);
  } finally { await s.close(); }
});

test('B10 refresh/recovery: manager riceve cella e proof originali; sessione di B o cella rimossa -> nessuna chiamata mutante', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    await s.mgr.track('SysAdmin');
    const reg = await call(s.url, '/register', { proof: s.proofFor('SysAdmin') });
    const proof = reg.json.proof;
    // senza sessione: byCell NON si salta
    const rf1 = await call(s.url, '/refresh', { proof });
    assert.equal(rf1.status, 200);
    assert.equal(rf1.json.status, 'live');
    assert.deepEqual(s.calls.childRefresh[0], ['SysAdmin', proof], 'stesso id e STESSO proof al manager');
    // sessione effettiva dichiarata -> ok
    const rf2 = await call(s.url, '/refresh', { session: 'edge-SysAdmin', proof });
    assert.equal(rf2.status, 200);
    assert.equal(rf2.json.status, 'live');
    // sessione di B -> nessuna chiamata mutante
    const rf3 = await call(s.url, '/refresh', { session: 'cloud-Dev', proof });
    assert.equal(rf3.status, 400);
    assert.equal(rf3.json.code, 'LEASE_SESSION_MISMATCH');
    assert.equal(s.calls.childRefresh.length, 2);
    // cella rimossa dal catalogo -> nessuna chiamata mutante
    s.catalog.rewrite(DEFAULT_CELLS.filter((c) => c.id !== 'SysAdmin'));
    const rf4 = await call(s.url, '/refresh', { proof });
    assert.equal(rf4.status, 400);
    assert.equal(rf4.json.code, 'LEASE_CELL_INVALID');
    assert.equal(s.calls.childRefresh.length, 2);
    // recovery con sessione effettiva -> manager con id e proof originali
    s.catalog.rewrite(DEFAULT_CELLS);
    s.clock.t += 61_000;
    const rec = await call(s.url, '/recovery', { session: 'edge-SysAdmin', proof });
    assert.equal(rec.status, 200);
    assert.equal(rec.json.status, 'live');
    assert.deepEqual(s.calls.childRecovery[0], ['SysAdmin', proof]);
  } finally { await s.close(); }
});

test('B11 claim falsificati e scadenze: il contratto crittografico del manager resta quello', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    await s.mgr.track('SysAdmin');
    // Dev registrata: un proof child falsificato come Dev esiste come registration
    const regDev = await call(s.url, '/register', { proof: s.proofFor('Dev') });
    const reg = await call(s.url, '/register', { proof: s.proofFor('SysAdmin') });
    const proof = reg.json.proof;
    // claim A falsificato come B (dichiarato): la firma non torna -> rifiuto crittografico
    const forged = await call(s.url, '/refresh', { proof: { ...proof, cellId: 'Dev' } });
    assert.equal(forged.status, 200);
    assert.equal(forged.json.status, 'denied', 'mai live con claim falsificato');
    // kind lease al posto di child -> denied
    const kindSbagliato = await call(s.url, '/refresh', { proof: { ...proof, kind: 'lease' } });
    assert.equal(kindSbagliato.status, 200);
    assert.equal(kindSbagliato.json.status, 'denied');
    // proof child scaduto in refresh -> negato, nessun rinnovo
    s.clock.t += 61_000;
    const scaduto = await call(s.url, '/refresh', { proof });
    assert.equal(scaduto.status, 200);
    assert.notEqual(scaduto.json.status, 'live');
    // recovery ENTRO grace -> live sulla STESSA incarnazione
    s.clock.t = 10_000;
    const reg2 = await call(s.url, '/register', { proof: s.proofFor('SysAdmin') });
    s.clock.t += 61_000;
    const entro = await call(s.url, '/recovery', { proof: reg2.json.proof });
    assert.equal(entro.status, 200);
    assert.equal(entro.json.status, 'live');
    assert.equal(entro.json.incarnationId, reg2.json.incarnationId);
    // recovery OLTRE grace -> expired, mai live
    s.clock.t += 61_000;
    const oltre = await call(s.url, '/recovery', { proof: reg2.json.proof });
    assert.equal(oltre.status, 200);
    assert.equal(oltre.json.status, 'expired');
    // cap tentativi: anche i tentativi negati consumano attempt
    s.clock.t = 10_000;
    const reg3 = await call(s.url, '/register', { proof: s.proofFor('SysAdmin') });
    void regDev;
    let esito = null;
    for (let i = 0; i < 10; i += 1) {
      esito = await call(s.url, '/recovery', { proof: { ...reg3.json.proof, proof: '0'.repeat(64) } });
      if (esito.json.status === 'denied' && esito.json.reason === 'attempt-bound') break;
    }
    assert.equal(esito.json.status, 'denied');
    assert.equal(esito.json.reason, 'attempt-bound');
  } finally { await s.close(); }
});

test('B12 binding presentato: 403 invariato; assenza header tiene il percorso nativo; il resolver non cancella l errore binding', async () => {
  const w = buildWorld({ realClock: true });
  const srv = await w.listen({ identityMode: 'authority' });
  try {
    await w.mgr.track('Dev');
    const reg = await w.mgr.childRegister('Dev', { authority: true });
    const header = (over = {}) => ({
      'x-nexuscrew-identity-binding': JSON.stringify({
        context: {
          version: '1', kind: 'mcp-v1', verified: true, mode: 'shared',
          bindingId: `Dev:${reg.proof.incarnationId}`,
          ownerInstanceId: 'owner-a', cellId: 'Dev', tmuxSession: 'cloud-Dev',
          connectionId: `Dev:${reg.proof.incarnationId}`, threadId: reg.proof.incarnationId,
          origin: 'local_tui', audience: 'nexuscrew-mcp', scopes: ['mcp:tools/call'],
          issuedAt: reg.proof.issuedAt, notBefore: reg.proof.issuedAt, expiresAt: reg.proof.expiresAt,
          ...(over.context || {}),
        },
        proof: over.proof || reg.proof,
      }),
    });
    // binding valido + proof coerente -> percorso nativo col binding OK
    const pos = await call(srv.url, '/refresh', { proof: reg.proof }, header());
    assert.equal(pos.status, 200);
    assert.equal(pos.json.status, 'live');
    // assenza header -> solo percorso nativo ammesso
    const nativo = await call(srv.url, '/refresh', { proof: reg.proof });
    assert.equal(nativo.status, 200);
    assert.equal(nativo.json.status, 'live');
    // header malformato -> 403
    const rotto = await call(srv.url, '/refresh', { proof: reg.proof }, { 'x-nexuscrew-identity-binding': '{' });
    assert.equal(rotto.status, 403);
    // binding di altra cella -> 403, anche se il catalogo risolve il subject
    const altraCella = await call(srv.url, '/refresh', { proof: reg.proof }, header({ context: { cellId: 'Ghost' } }));
    assert.equal(altraCella.status, 403);
    // incarnazione diversa -> 403
    const altraInc = await call(srv.url, '/refresh', { proof: reg.proof }, header({ context: { threadId: 'ff'.repeat(8) } }));
    assert.equal(altraInc.status, 403);
    assert.equal(w.calls.childRefresh.length, 2, 'solo i due positivi hanno raggiunto il manager');
  } finally { await srv.close(); w.cleanup(); }
});

test('B13 introspect: sessione effettiva dal catalogo; cella rimossa o catalogo rotto -> mai live con nome ricostruito', async () => {
  const s = await setup();
  try {
    for (const cell of ['Dev', 'SysAdmin', 'agy.native', 'Trading']) await s.mgr.track(cell);
    const sessioniAttese = new Map([
      ['Dev', 'cloud-Dev'],
      ['SysAdmin', 'edge-SysAdmin'],
      ['agy.native', SESSION_V2],
      ['Trading', 'jarvis'],
    ]);
    const proofs = new Map();
    for (const cell of sessioniAttese.keys()) {
      const reg = await call(s.url, '/register', { proof: s.proofFor(cell) });
      assert.equal(reg.json.status, 'registered', `cella ${cell}`);
      proofs.set(cell, reg.json.proof);
    }
    for (const [cell, sessione] of sessioniAttese) {
      const out = await call(s.url, '/introspect', { proof: proofs.get(cell) });
      assert.equal(out.status, 200, `cella ${cell}`);
      assert.equal(out.json.status, 'live', `cella ${cell}`);
      assert.equal(out.json.tmuxSession, sessione, `cella ${cell}: sessione EFFETTIVA dal catalogo`);
      assert.equal(out.json.cellId, cell);
      // body con la sessione effettiva -> live; il confronto usa il subject verificato
      const effettiva = await call(s.url, '/introspect', { session: sessione, proof: proofs.get(cell) });
      assert.equal(effettiva.json.status, 'live');
      assert.equal(effettiva.json.tmuxSession, sessione);
    }
    const discordante = await call(s.url, '/introspect', { session: 'cloud-Trading', proof: proofs.get('Trading') });
    assert.equal(discordante.status, 400);
    assert.equal(discordante.json.code, 'LEASE_SESSION_MISMATCH');
    // cella rimossa: il proof è ancora valido ma la cella non c'è più -> mai live
    s.catalog.rewrite(DEFAULT_CELLS.filter((c) => c.id !== 'Trading'));
    const rimossa = await call(s.url, '/introspect', { proof: proofs.get('Trading') });
    assert.equal(rimossa.status, 400);
    assert.equal(rimossa.json.code, 'LEASE_CELL_INVALID');
    assert.notEqual(rimossa.json.status, 'live');
    // catalogo illeggibile -> 503, nessun live con nome ricostruito
    fs.rmSync(s.catalog.defsPath);
    const rotto = await call(s.url, '/introspect', { proof: proofs.get('Dev') });
    assert.equal(rotto.status, 503);
    assert.equal(rotto.json.code, 'LEASE_CATALOG_UNAVAILABLE');
  } finally { await s.close(); }
});

test('B14 introspect read-only: 501/denied/expired originali; nessuna mutazione di stato', async () => {
  const legacy = await setup({ identityMode: 'legacy' });
  try {
    await legacy.mgr.track('Dev');
    const reg = await call(legacy.url, '/register', { session: 'cloud-Dev' });
    assert.equal((await call(legacy.url, '/introspect', { proof: reg.json.proof })).status, 501);
  } finally { await legacy.close(); }
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    // registration nata legacy: denied, resta tale
    const regLegacy = s.mgr.childRegister('Dev');
    const out = await call(s.url, '/introspect', { proof: regLegacy.proof });
    assert.equal(out.json.status, 'denied');
    assert.equal(out.json.reason, 'legacy-registration');
    // proof sbagliato -> denied
    assert.equal((await call(s.url, '/introspect', { proof: { kind: 'child' } })).json.status, 'denied');
    // registration valida: due introspezioni, stessa risposta, niente rinnovo
    const reg = await call(s.url, '/register', { proof: s.identityProof });
    const before = s.supervisor('Dev');
    const prima = await call(s.url, '/introspect', { proof: reg.json.proof });
    assert.equal(prima.json.status, 'live');
    const seconda = await call(s.url, '/introspect', { proof: reg.json.proof });
    assert.deepEqual(seconda.json, prima.json, 'due introspezioni: stessa risposta, niente rinnovo');
    // proof scaduto -> expired
    s.clock.t += 61_000;
    const stale = await call(s.url, '/introspect', { proof: reg.json.proof });
    assert.equal(stale.json.status, 'expired');
    assert.equal(s.calls.childRegister.length, 2, 'una diretta del test + una via route: nessuna extra dalle introspezioni');
    assert.equal(s.calls.childRefresh.length, 0);
    assert.equal(s.calls.childRecovery.length, 0);
    assert.equal(s.calls.track.length, 1, 'solo il track esplicito del test');
    assert.equal(s.supervisor('Dev'), before, 'stato supervisore intatto');
  } finally { await s.close(); }
  // in readonly l_introspezione resta leggibile e non muta nulla
  const ro = await setup({ readonly: true });
  try {
    await ro.mgr.track('Dev');
    const regRo = ro.mgr.childRegister('Dev', { authority: true });
    const beforeRo = ro.supervisor('Dev');
    const intro = await call(ro.url, '/introspect', { proof: regRo.proof });
    assert.equal(intro.status, 200);
    assert.equal(intro.json.status, 'live');
    assert.equal(ro.calls.childRefresh.length, 0);
    assert.equal(ro.calls.childRegister.length, 1, 'solo la childRegister esplicita del test');
    assert.equal(ro.supervisor('Dev'), beforeRo);
  } finally { await ro.close(); }
});

test('B15 readonly 403, fleet disabled 404, lease assente 501, catalogo stretto assente 503', async () => {
  const s = await setup({ readonly: true });
  try {
    // readonly precede ogni mutazione, anche a catalogo rotto
    fs.rmSync(s.catalog.defsPath);
    assert.equal((await call(s.url, '/register', { session: 'cloud-Dev' })).status, 403);
    assert.equal((await call(s.url, '/refresh', { proof: {} })).status, 403);
    assert.equal((await call(s.url, '/recovery', { proof: {} })).status, 403);
  } finally { await s.close(); }
  const w = buildWorld();
  const off404 = await w.listen({ identityMode: 'legacy', fleetP: Promise.resolve({ available: false }) });
  try {
    assert.equal((await call(off404.url, '/register', { session: 'cloud-Dev' })).status, 404);
  } finally { await off404.close(); }
  const noLease = await w.listen({ identityMode: 'legacy', fleetP: Promise.resolve({ available: true }) });
  try {
    assert.equal((await call(noLease.url, '/register', { session: 'cloud-Dev' })).status, 501);
  } finally { await noLease.close(); }
  const noCatalog = await w.listen({ identityMode: 'legacy', fleetP: Promise.resolve({ available: true, lease: w.mgr }) });
  try {
    const out = await call(noCatalog.url, '/register', { session: 'cloud-Dev' });
    assert.equal(out.status, 503);
    assert.equal(out.json.code, 'LEASE_CATALOG_UNAVAILABLE');
    assert.equal(w.calls.childRegister.length, 0);
  } finally { await noCatalog.close(); w.cleanup(); }
});

// Seam dichiarato per B16: un thenable Fleet che distingue
// il PRIMO await del router (guard esterno di lease-routes.js, `await fleetP`
// prima di entrare nel corpo della route) dal SECONDO, che esiste soltanto
// quando il guard binding ha un header valido da verificare
// (binding-guard.js, `await fleetP` interno). Il primo await consegna subito
// il fleet REALE; il secondo resta appeso finché il test non chiama release().
// Il segnale «binding entrato» è quindi la chiamata di quel secondo await:
// sincronizzazione esplicita, nessuno sleep e nessun setImmediate come prova
// di raggiungimento. Dopo il rilascio il thenable si comporta come una
// promise già risolta (le richieste successive sono del tutto normali).
function bindingGateFleetP(fleet) {
  let awaits = 0;
  let parked = null;
  let open = false;
  let signal = null;
  const bindingEntered = new Promise((r) => { signal = r; });
  return {
    fleetP: {
      then(onFulfilled) {
        awaits += 1;
        if (awaits === 1 || open) {
          queueMicrotask(() => onFulfilled(fleet));
          return;
        }
        signal();
        parked = onFulfilled;
      },
    },
    bindingEntered,
    release() {
      open = true;
      if (parked) queueMicrotask(() => parked(fleet));
    },
  };
}

test('B16 catalogo cambiato con la richiesta sospesa NEL guard binding: vale la versione corrente', { timeout: 20_000 }, async () => {
  const w = buildWorld({ realClock: true });
  const srv1 = await w.listen({ identityMode: 'authority' });
  try {
    await w.mgr.track('SysAdmin');
    const reg = await call(srv1.url, '/register', { proof: w.proofFor('SysAdmin') });
    assert.equal(reg.json.status, 'registered');
    const proof = reg.json.proof;
    // binding REALEMENTE valido: contesto shared coerente col proof vivo
    // (stessa cella, stessa incarnazione, stessa scadenza), verificato dal
    // guard contro il manager vero durante la sospensione controllata.
    const binding = {
      'x-nexuscrew-identity-binding': JSON.stringify({
        context: {
          version: '1', kind: 'mcp-v1', verified: true, mode: 'shared',
          bindingId: `SysAdmin:${reg.json.incarnationId}`,
          ownerInstanceId: 'owner-a', cellId: 'SysAdmin', tmuxSession: 'cloud-SysAdmin',
          connectionId: `SysAdmin:${reg.json.incarnationId}`, threadId: reg.json.incarnationId,
          origin: 'local_tui', audience: 'nexuscrew-mcp', scopes: ['mcp:tools/call'],
          issuedAt: proof.issuedAt, notBefore: proof.issuedAt, expiresAt: proof.expiresAt,
        },
        proof,
      }),
    };
    const prima = w.supervisor('SysAdmin');
    // refresh e recovery condividono routeRinnovo: in ENTRAMBI la fotografia
    // del catalogo dev'essere presa DOPO l'attesa del guard binding.
    for (const [routePath, spy] of [['/refresh', 'childRefresh'], ['/recovery', 'childRecovery']]) {
      const gate = bindingGateFleetP(w.makeFleet());
      const srv = await w.listen({ identityMode: 'authority', fleetP: gate.fleetP });
      try {
        const inFlight = call(srv.url, routePath, { proof }, binding);
        // deterministico: la richiesta è ferma DENTRO guardBinding (secondo
        // await), con il binding valido già in verifica — non prima.
        await gate.bindingEntered;
        // il catalogo cambia in quel punto di sospensione: la cella sparisce
        w.catalog.rewrite(DEFAULT_CELLS.filter((c) => c.id !== 'SysAdmin'));
        gate.release();
        const out = await inFlight;
        assert.equal(out.status, 400, `${routePath}: rifiuto con il catalogo corrente`);
        assert.equal(out.json.code, 'LEASE_CELL_INVALID');
        assert.equal(w.calls[spy].length, 0, `${routePath}: la mappa di prima dell'attesa non autorizza la mutazione`);
        assert.equal(w.supervisor('SysAdmin'), prima, `${routePath}: stato supervisore intatto`);
        // controllo positivo, stesso server e stesso binding: a catalogo
        // ripristinato la route procede (cablaggio e binding davvero validi)
        w.catalog.rewrite(DEFAULT_CELLS);
        const dopo = await call(srv.url, routePath, { proof }, binding);
        assert.equal(dopo.status, 200, `${routePath}: controllo positivo`);
        assert.equal(dopo.json.status, 'live');
      } finally {
        await srv.close();
      }
    }
    assert.equal(w.calls.childRefresh.length, 1, 'solo il controllo positivo del refresh ha raggiunto il manager');
    assert.equal(w.calls.childRecovery.length, 1, 'solo il controllo positivo del recovery ha raggiunto il manager');
  } finally { await srv1.close(); w.cleanup(); }
});

test('B17 le chiamate child non toccano lease/control del supervisore', async () => {
  const s = await setup();
  try {
    await s.mgr.track('SysAdmin');
    const noneBefore = s.supervisor('SysAdmin');
    assert.equal(JSON.parse(noneBefore).status.state, 'none');
    const reg = await call(s.url, '/register', { proof: s.proofFor('SysAdmin') });
    const rf = await call(s.url, '/refresh', { proof: reg.json.proof });
    assert.equal(rf.json.status, 'live');
    s.clock.t += 61_000;
    const rec = await call(s.url, '/recovery', { proof: rf.json.proof });
    assert.equal(rec.json.status, 'live');
    assert.equal(s.supervisor('SysAdmin'), noneBefore, 'lease=none resta none');
  } finally { await s.close(); }
  // con lease già live: leaseId/generation/bound del supervisore immutati
  const w = buildWorld();
  const srv = await w.listen();
  const pairServer = net.createServer();
  const connected = new Promise((r) => pairServer.once('connection', r));
  await new Promise((r) => pairServer.listen(0, '127.0.0.1', r));
  const client = net.createConnection(pairServer.address().port, '127.0.0.1');
  try {
    const [serverSide] = await Promise.all([connected, new Promise((r) => client.once('connect', r))]);
    await w.mgr.track('SysAdmin');
    assert.equal(w.mgr.attachInitial('SysAdmin', serverSide, { generation: 3 }), true);
    const liveBefore = w.supervisor('SysAdmin');
    assert.equal(JSON.parse(liveBefore).status.state, 'live');
    const reg = await call(srv.url, '/register', { proof: w.proofFor('SysAdmin') });
    assert.equal(reg.json.status, 'registered');
    const rf = await call(srv.url, '/refresh', { proof: reg.json.proof });
    assert.equal(rf.json.status, 'live');
    const intro = await call(srv.url, '/introspect', { proof: reg.json.proof });
    assert.equal(intro.json.status, 'live');
    assert.equal(intro.json.tmuxSession, 'edge-SysAdmin');
    assert.equal(w.supervisor('SysAdmin'), liveBefore, 'leaseId/generation/bound del supervisore immutati');
  } finally {
    try { client.destroy(); } catch (_) { /* best-effort */ }
    await new Promise((r) => pairServer.close(r));
    await srv.close();
    w.cleanup();
  }
});

test('B18 server reale -> route -> provider -> catalogo reale: override risolto e rifiuto dopo un successo', async () => {
  const { createServer } = require('../lib/server.js');
  const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
  const nodesStore = require('../lib/nodes/store.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lease-real-'));
  const configDir = path.join(home, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const catalog = catalogFixture(DEFAULT_CELLS);
  const nodesPath = path.join(configDir, 'nodes.json');
  const tokenPath = path.join(configDir, 'token');
  nodesStore.initStore(nodesPath);
  const fleet = await createBuiltinFleet({
    home,
    fleetDefsPath: catalog.defsPath,
    tmuxBin: 'tmux',
    cellLeaseEnabled: true,
    protectSharedTmuxServer: false,
    log: () => {},
  });
  const { server, token } = createServer({
    protectSharedTmuxServer: false,
    home,
    configPath: path.join(configDir, 'config.json'),
    nodesPath,
    tokenPath,
    filesRoot: path.join(home, 'files'),
    port: 0,
    autoUpdate: false,
    fleetIdentityMode: 'legacy',
    fleetP: Promise.resolve(fleet),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(`${base}${p}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    await fleet.lease.track('SysAdmin');
    // override dichiarato risolto dal catalogo REALE attraverso il server REALE
    const reg = await post('/api/lease/register', { session: 'edge-SysAdmin' });
    assert.equal(reg.status, 200);
    const body = await reg.json();
    assert.equal(body.status, 'registered');
    assert.equal(body.proof.cellId, 'SysAdmin');
    // il default canonico della stessa cella NON è un alias
    const alias = await post('/api/lease/register', { session: 'cloud-SysAdmin' });
    assert.equal(alias.status, 400);
    // successo precedente, poi catalogo rimosso: la vista cached del provider
    // (definitions) resta leggibile ma il lease rifiuta — nessuna riesumazione
    assert.ok(fleet.definitions().cells.some((c) => c.id === 'SysAdmin'));
    fs.rmSync(catalog.defsPath);
    const dopo = await post('/api/lease/register', { session: 'cloud-Dev' });
    assert.equal(dopo.status, 503);
    assert.equal((await dopo.json()).code, 'LEASE_CATALOG_UNAVAILABLE');
    assert.ok(fleet.definitions().cells.some((c) => c.id === 'SysAdmin'), 'la vista cached sopravvive; il lease no');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fleet.close();
    catalog.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('B19 authority canonica end-to-end col provider; limite consumer per celle custom dichiarato', async () => {
  const w = buildWorld({ realClock: true });
  const srv = await w.listen({ instanceId: 'owner-a' });
  const tokenPath = path.join(w.home, 'token');
  fs.writeFileSync(tokenPath, 'fixture-token\n', { mode: 0o600 });
  const verifiedEnv = (cellId, incarnationId) => ({
    NEXUSCREW_VERIFIED_ENV_VERSION: '1',
    NEXUSCREW_VERIFIED_OWNER_INSTANCE_ID: 'owner-a',
    NEXUSCREW_VERIFIED_CELL_ID: cellId,
    NEXUSCREW_VERIFIED_INCARNATION_ID: incarnationId,
    NEXUSCREW_VERIFIED_BINDING_ID: `binding-${cellId}`,
    NEXUSCREW_VERIFIED_ORIGIN: 'local_tui',
    NEXUSCREW_VERIFIED_THREAD_ID: incarnationId,
  });
  const makeProvider = (cellId, incarnationId) => createMcpIdentityProvider({
    config: { port: Number(new URL(srv.url).port), tokenPath, identityOwnerInstanceId: 'owner-a' },
    env: { ...verifiedEnv(cellId, incarnationId) },
    fetchImpl: fetch,
  });
  try {
    // percorso CANONICO: nessuna regressione — il provider verifica e produce il contesto shared
    await w.mgr.track('Dev');
    const reg = await call(srv.url, '/register', { proof: w.proofFor('Dev') });
    assert.equal(reg.json.status, 'registered');
    assert.equal(persistIdentityChannel({
      tokenPath, session: 'cloud-Dev', cellId: 'Dev',
      proof: reg.json.proof, expiresAt: Number(reg.json.proof.expiresAt),
    }), true);
    const ctx = await makeProvider('Dev', reg.json.incarnationId)();
    assert.equal(ctx.verified, true);
    assert.equal(ctx.cellId, 'Dev');
    assert.equal(ctx.tmuxSession, 'cloud-Dev');
    // LIMITE DICHIARATO: cella con sessione custom. Il canale del consumer
    // vive sotto il nome canonico (reverse canonico), ma l_introspezione dice
    // la verità (jarvis): il consumer rifiuta invece di accettare un nome
    // ricostruito. Estendere il consumer è uno strato separato, non questo.
    await w.mgr.track('Trading');
    const regCustom = await call(srv.url, '/register', { proof: w.proofFor('Trading') });
    assert.equal(regCustom.json.status, 'registered');
    assert.equal(persistIdentityChannel({
      tokenPath, session: 'cloud-Trading', cellId: 'Trading',
      proof: regCustom.json.proof, expiresAt: Number(regCustom.json.proof.expiresAt),
    }), true);
    const intro = await call(srv.url, '/introspect', { proof: regCustom.json.proof });
    assert.equal(intro.json.status, 'live');
    assert.equal(intro.json.tmuxSession, 'jarvis', 'la route dice la sessione effettiva');
    await assert.rejects(
      makeProvider('Trading', regCustom.json.incarnationId)(),
      (e) => e && e.code === 'NEXUSCREW_MCP_IDENTITY_VERIFIED_ENV_INVALID',
      'il consumer legacy-canonical rifiuta la sessione effettiva custom: limite dichiarato',
    );
  } finally { await srv.close(); w.cleanup(); }
});
