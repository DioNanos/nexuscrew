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

function setup({ readonly = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leaseroutes-'));
  const clock = { t: 10_000 };
  const mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  const fleetP = Promise.resolve({ available: true, lease: mgr });
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use('/api/lease', leaseRoutes({ fleetP, readonly: () => readonly }));
  const server = require('node:http').createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        clock, mgr, home,
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

test('register: sessione valida -> registration; proof kind child in risposta', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    const out = await call(s.url, 'POST', '/register', { session: sessionDev() });
    assert.equal(out.status, 200);
    assert.equal(out.json.status, 'registered');
    assert.equal(out.json.proof.kind, 'child');
    assert.equal(out.json.proof.cellId, 'Dev');
  } finally { await s.close(); }
});

test('register: sessione non valida -> 400, nessuna registration', async () => {
  const s = await setup();
  try {
    const bad = await call(s.url, 'POST', '/register', { session: 'nope-$$$' });
    assert.equal(bad.status, 400);
    const missing = await call(s.url, 'POST', '/register', {});
    assert.equal(missing.status, 400);
  } finally { await s.close(); }
});

test('register: cella NON tracciata -> pending (200 con status)', async () => {
  const s = await setup();
  try {
    const out = await call(s.url, 'POST', '/register', { session: sessionDev() });
    assert.equal(out.status, 200);
    assert.equal(out.json.status, 'pending');
  } finally { await s.close(); }
});

test('refresh e recovery via route: esiti del manager, proof in ingresso e in uscita', async () => {
  const s = await setup();
  try {
    await s.mgr.track('Dev');
    const reg = await call(s.url, 'POST', '/register', { session: sessionDev() });
    const rf = await call(s.url, 'POST', '/refresh', { session: sessionDev(), proof: reg.json.proof });
    assert.equal(rf.status, 200);
    assert.equal(rf.json.status, 'live');
    s.clock.t += 61_000;
    const rec = await call(s.url, 'POST', '/recovery', { session: sessionDev(), proof: rf.json.proof });
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
    const regDev = await call(s.url, 'POST', '/register', { session: sessionDev() });
    // presenta il proof di Dev dichiarandosi Research: la sessione decide la
    // cella, il proof decide l'autorita' — entrambi devono combaciare.
    const rf = await call(s.url, 'POST', '/refresh', { session: tmuxSessionForCell('Research'), proof: regDev.json.proof });
    assert.equal(rf.status, 200);
    assert.equal(rf.json.status, 'no-registration');
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
