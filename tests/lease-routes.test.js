'use strict';
// Fetta 2b — route /api/lease (D3: il collegamento MCP↔leaseManager passa dal
// canale nativo del bridge, l'HTTP loopback dietro token). La route deriva la
// CELLA dalla sessione dichiarata dal chiamante autenticato (lo stesso modello
// degli altri tool nc_*); il PROOF e' l'authorizer di refresh/recovery.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { leaseRoutes } = require('../lib/fleet/lease-routes.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const { createIdentityAuthority } = require('../lib/fleet/identity-authority.js');

function setup({ readonly = false, identityMode = 'authority' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leaseroutes-'));
  const clock = { t: 10_000 };
  const mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  const authority = createIdentityAuthority({
    dir: path.join(home, 'identity'),
    serviceCredential: 'fixture-service-credential',
    now: () => 10_000,
  });
  const tuple = {
    ownerInstanceId: 'owner-a', cellId: 'Dev', audience: 'nexuscrew-lease',
    incarnationId: 'incarnation-a', launchEpoch: 'epoch-a', daemonBootId: 'boot-a',
    connectionId: 'connection-a',
  };
  const challenge = authority.registerDaemonChallenge({ serviceCredential: 'fixture-service-credential', ...tuple });
  const grant = authority.issueLaunchGrant({ serviceCredential: 'fixture-service-credential', challenge: challenge.challenge, ...tuple });
  const identity = authority.issueChallengeProof({ launchGrant: grant.grant, challenge: challenge.challenge });
  const fleetP = Promise.resolve({ available: true, lease: mgr, identityAuthority: authority });
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use('/api/lease', leaseRoutes({ fleetP, readonly: () => readonly, identityMode }));
  const server = require('node:http').createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        clock, mgr, home, identityProof: identity.proof,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function call(base, method, p, body) {
  const r = await fetch(`${base}/api/lease${p}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const sessionDev = () => tmuxSessionForCell('Dev');

test('register: la sessione nel body non è più una credenziale', async () => {
  const s = await setup();
  try {
    const out = await call(s.url, 'POST', '/register', { session: sessionDev() });
    assert.equal(out.status, 400);
    assert.match(out.json.error, /proof/i);
  } finally { await s.close(); }
});

test('register: sessione valida -> registration; proof kind child in risposta', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    const out = await call(s.url, 'POST', '/register', { proof: s.identityProof });
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
    const out = await call(s.url, 'POST', '/register', { session: sessionDev() });
    assert.equal(out.status, 200);
    assert.equal(out.json.status, 'registered');
    assert.equal(out.json.proof.kind, 'child');
  } finally { await s.close(); }
});

test('register: sessione non valida -> 400, nessuna registration', async () => {
  const s = await setup();
  try {
    const bad = await call(s.url, 'POST', '/register', { proof: { cellId: 'nope-$$$' } });
    assert.equal(bad.status, 200);
    assert.equal(bad.json.status, 'denied');
    const missing = await call(s.url, 'POST', '/register', {});
    assert.equal(missing.status, 400);
  } finally { await s.close(); }
});

test('register: cella NON tracciata -> pending (200 con status)', async () => {
  const s = await setup();
  try {
    const out = await call(s.url, 'POST', '/register', { proof: s.identityProof });
    assert.equal(out.status, 200);
    assert.equal(out.json.status, 'pending');
  } finally { await s.close(); }
});

test('refresh e recovery via route: esiti del manager, proof in ingresso e in uscita', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    const reg = await call(s.url, 'POST', '/register', { proof: s.identityProof });
    const rf = await call(s.url, 'POST', '/refresh', { proof: reg.json.proof });
    assert.equal(rf.status, 200);
    assert.equal(rf.json.status, 'live');
    s.clock.t += 61_000;
    const rec = await call(s.url, 'POST', '/recovery', { proof: rf.json.proof });
    assert.equal(rec.status, 200);
    assert.equal(rec.json.status, 'live');
    assert.equal(rec.json.incarnationId, reg.json.incarnationId);
  } finally { await s.close(); }
});

test('refresh con proof di un altra cella -> denied (scope per-cell dalla sessione)', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    await s.mgr.track('Research');
    const regDev = await call(s.url, 'POST', '/register', { proof: s.identityProof });
    // presenta il proof di Dev dichiarandosi Research: la sessione decide la
    // cella, il proof decide l'autorita' — entrambi devono combaciare.
    const rf = await call(s.url, 'POST', '/refresh', { session: tmuxSessionForCell('Research'), proof: regDev.json.proof });
    assert.equal(rf.status, 400);
    assert.match(rf.json.error, /discordante/);
  } finally { await s.close(); }
});

test('lease non disponibile (fleet senza lease) -> 501 chiaro, non 500 ambiguo', async () => {
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use('/api/lease', leaseRoutes({ fleetP: Promise.resolve({ available: true }) }));
  const server = require('node:http').createServer(app);
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
    const a = await call(s.url, 'POST', '/register', { session: sessionDev() });
    const b = await call(s.url, 'POST', '/refresh', { session: sessionDev(), proof: {} });
    const c = await call(s.url, 'POST', '/recovery', { session: sessionDev(), proof: {} });
    assert.equal(a.status, 403);
    assert.equal(b.status, 403);
    assert.equal(c.status, 403);
  } finally { await s.close(); }
});

test('introspect: authority only; registration authority-backed ok, legacy denied', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    const reg = await call(s.url, 'POST', '/register', { proof: s.identityProof });
    assert.equal(reg.json.identityMode, 'authority');
    const out = await call(s.url, 'POST', '/introspect', { proof: reg.json.proof });
    assert.equal(out.status, 200);
    assert.equal(out.json.status, 'live');
    assert.equal(out.json.cellId, 'Dev');
    assert.equal(out.json.identityMode, 'authority');
    assert.equal(out.json.incarnationId, reg.json.incarnationId);
    assert.equal(out.json.expiresAt, reg.json.proof.expiresAt);
    s.clock.t += 61_000;
    const stale = await call(s.url, 'POST', '/introspect', { proof: reg.json.proof });
    assert.equal(stale.json.status, 'expired');
  } finally { await s.close(); }
});

test('introspect: legacy mode 501 e proof di registration legacy mai autorizzato', async () => {
  const legacy = await setup({ identityMode: 'legacy' });
  try {
    await legacy.mgr.track('Dev');
    const reg = await call(legacy.url, 'POST', '/register', { session: sessionDev() });
    assert.equal(reg.json.status, 'registered');
    assert.equal(reg.json.identityMode, undefined);
    const off = await call(legacy.url, 'POST', '/introspect', { proof: reg.json.proof });
    assert.equal(off.status, 501);
  } finally { await legacy.close(); }
  const authority = await setup();
  try {
    await authority.mgr.track('Dev');
    // registration nata senza authority: il proof child esiste ma non puo
    // autorizzare il percorso shared.
    const reg = authority.mgr.childRegister('Dev');
    assert.equal(reg.status, 'registered');
    const out = await call(authority.url, 'POST', '/introspect', { proof: reg.proof });
    assert.equal(out.status, 200);
    assert.equal(out.json.status, 'denied');
    assert.equal(out.json.reason, 'legacy-registration');
  } finally { await authority.close(); }
});
