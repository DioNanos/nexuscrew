'use strict';
// tests/live-host-routes.test.js — route /api/live-host (control plane designazione).
// Comportamentali via HTTP: ciclo designate/clear, CAS concorrente (barriera),
// readonly, cella non locale (federazione), eligible derivato, inerzia.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const { requireToken } = require('../lib/auth/middleware.js');
const { liveHostRoutes } = require('../lib/live-host/routes.js');
const { createLiveHostStore, liveHostPath } = require('../lib/live-host/store.js');

const TOKEN = 'test-token-123';
const H = (t = TOKEN) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
const CELLS = [
  { cell: 'cloud-Dev', active: true, tmux: true, tmuxSession: 'cloud-Dev' },
  { cell: 'cloud-Off', active: false, tmux: false, tmuxSession: 'cloud-Off' },
];
const mockFleet = (cells = CELLS) => Promise.resolve({
  available: true,
  status: async () => ({ available: true, cells }),
});

async function boot({ readonly = () => false, fleet = mockFleet() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-routes-'));
  const cfg = { liveHostPath: path.join(dir, 'live-host.json') };
  const store = createLiveHostStore({ filePath: liveHostPath(cfg), now: () => 2000 });
  const app = express();
  app.use('/api/live-host', requireToken({ get: () => TOKEN }), liveHostRoutes({
    fleetP: fleet, store, readonly,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, dir, store,
    close: () => { fs.rmSync(dir, { recursive: true, force: true }); return new Promise((r) => server.close(r)); },
  };
}

const j = async (r) => r.json().catch(() => ({}));

test('GET iniziale: hostCell null, eligible false', async () => {
  const ctx = await boot();
  try {
    const r = await fetch(`${ctx.base}/api/live-host`, { headers: H() });
    assert.equal(r.status, 200);
    const body = await j(r);
    assert.equal(body.hostCell, null);
    assert.equal(body.eligible, false);
    assert.equal(Number.isInteger(body.revision), true);
  } finally { await ctx.close(); }
});

test('ciclo designate -> clear con CAS', async () => {
  const ctx = await boot();
  try {
    const rev0 = (await j(await fetch(`${ctx.base}/api/live-host`, { headers: H() }))).revision;
    const d = await fetch(`${ctx.base}/api/live-host/designate`, {
      method: 'POST', headers: H(), body: JSON.stringify({ cellId: 'cloud-Dev', expectedRevision: rev0 }),
    });
    assert.equal(d.status, 200);
    const db = await j(d);
    assert.equal(db.hostCell, 'cloud-Dev');
    assert.equal(db.eligible, true); // cloud-Dev attiva
    const after = await j(await fetch(`${ctx.base}/api/live-host`, { headers: H() }));
    assert.equal(after.hostCell, 'cloud-Dev');
    const c = await fetch(`${ctx.base}/api/live-host/clear`, {
      method: 'POST', headers: H(), body: JSON.stringify({ expectedRevision: db.revision }),
    });
    assert.equal(c.status, 200);
    assert.equal((await j(c)).hostCell, null);
  } finally { await ctx.close(); }
});

test('BARRIERA HTTP: due designate concorrenti stessa revision -> un 200, un 409, un solo host', async () => {
  const ctx = await boot();
  try {
    const rev0 = (await j(await fetch(`${ctx.base}/api/live-host`, { headers: H() }))).revision;
    const bodies = [JSON.stringify({ cellId: 'cloud-Dev', expectedRevision: rev0 }),
      JSON.stringify({ cellId: 'cloud-Off', expectedRevision: rev0 })];
    const [r1, r2] = await Promise.all(bodies.map((b) => fetch(`${ctx.base}/api/live-host/designate`, {
      method: 'POST', headers: H(), body: b,
    })));
    const codes = [r1.status, r2.status].sort();
    assert.deepEqual(codes, [200, 409], 'un vincitore (200) e un conflict (409)');
    const after = await j(await fetch(`${ctx.base}/api/live-host`, { headers: H() }));
    assert.ok(['cloud-Dev', 'cloud-Off'].includes(after.hostCell), 'un solo hostCell');
  } finally { await ctx.close(); }
});

test('expectedRevision stale -> 409 con la revision corrente (la UI puo\' rileggere)', async () => {
  const ctx = await boot();
  try {
    await fetch(`${ctx.base}/api/live-host/designate`, {
      method: 'POST', headers: H(), body: JSON.stringify({ cellId: 'cloud-Dev', expectedRevision: 0 }),
    });
    const r = await fetch(`${ctx.base}/api/live-host/designate`, {
      method: 'POST', headers: H(), body: JSON.stringify({ cellId: 'cloud-Off', expectedRevision: 0 }), // stale
    });
    assert.equal(r.status, 409);
    const body = await j(r);
    assert.equal(typeof body.revision, 'number');
    assert.equal(body.hostCell, 'cloud-Dev');
  } finally { await ctx.close(); }
});

test('readonly -> 403 su designate e su clear', async () => {
  const ctx = await boot({ readonly: () => true });
  try {
    const d = await fetch(`${ctx.base}/api/live-host/designate`, {
      method: 'POST', headers: H(), body: JSON.stringify({ cellId: 'cloud-Dev', expectedRevision: 0 }),
    });
    assert.equal(d.status, 403);
    const c = await fetch(`${ctx.base}/api/live-host/clear`, {
      method: 'POST', headers: H(), body: JSON.stringify({ expectedRevision: 0 }),
    });
    assert.equal(c.status, 403);
    // e non ha scritto nulla
    assert.equal((await j(await fetch(`${ctx.base}/api/live-host`, { headers: H() }))).hostCell, null);
  } finally { await ctx.close(); }
});

test('federazione default-deny: cellId non locale -> 404', async () => {
  const ctx = await boot();
  try {
    const r = await fetch(`${ctx.base}/api/live-host/designate`, {
      method: 'POST', headers: H(), body: JSON.stringify({ cellId: 'federata-altro-nodo', expectedRevision: 0 }),
    });
    assert.equal(r.status, 404);
    assert.equal((await j(await fetch(`${ctx.base}/api/live-host`, { headers: H() }))).hostCell, null);
  } finally { await ctx.close(); }
});

test('token assente -> 401 (nessuna designazione senza auth locale)', async () => {
  const ctx = await boot();
  try {
    const r = await fetch(`${ctx.base}/api/live-host/designate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cellId: 'cloud-Dev', expectedRevision: 0 }),
    });
    assert.equal(r.status, 401);
  } finally { await ctx.close(); }
});

test('cella inattiva: designabile e PRESERVA, eligible false; torna attiva -> eligible true', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-inactive-'));
  const filePath = path.join(dir, 'live-host.json');
  // boot 1: cloud-Off e' nel roster ma e' inattiva -> designabile, eligible false.
  const app = express();
  app.use('/api/live-host', requireToken({ get: () => TOKEN }), liveHostRoutes({
    fleetP: mockFleet(),
    store: createLiveHostStore({ filePath, now: () => 3000 }),
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const d = await fetch(`${base}/api/live-host/designate`, {
      method: 'POST', headers: H(), body: JSON.stringify({ cellId: 'cloud-Off', expectedRevision: 0 }),
    });
    assert.equal(d.status, 200, 'una cella definita ma spenta e\' designabile');
    assert.equal((await j(d)).eligible, false);
    const after = await j(await fetch(`${base}/api/live-host`, { headers: H() }));
    assert.equal(after.hostCell, 'cloud-Off');
    assert.equal(after.eligible, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
  // boot 2: STESSO file su disco (hostCell preservato tra riavvii) ma cloud-Off ora ATTIVA.
  const app2 = express();
  app2.use('/api/live-host', requireToken({ get: () => TOKEN }), liveHostRoutes({
    fleetP: mockFleet([{ cell: 'cloud-Off', active: true, tmux: true, tmuxSession: 'cloud-Off' }]),
    store: createLiveHostStore({ filePath, now: () => 4000 }),
  }));
  const server2 = http.createServer(app2);
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  try {
    const after = await j(await fetch(`${base2}/api/live-host`, { headers: H() }));
    assert.equal(after.hostCell, 'cloud-Off', 'designazione preservata tra riavvii');
    assert.equal(after.eligible, true, 'ora che la cella e\' attiva, eligible diventa true');
  } finally {
    await new Promise((r) => server2.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inerzia: fleet unavailable -> designate 503, GET preserva hostCell (eligible false)', async () => {
  const ctx = await boot({ fleet: Promise.resolve({ available: false }) });
  try {
    const d = await fetch(`${ctx.base}/api/live-host/designate`, {
      method: 'POST', headers: H(), body: JSON.stringify({ cellId: 'cloud-Dev', expectedRevision: 0 }),
    });
    assert.equal(d.status, 503);
    const g = await j(await fetch(`${ctx.base}/api/live-host`, { headers: H() }));
    assert.equal(g.hostCell, null); // nessuna designazione senza roster
    assert.equal(g.eligible, false);
  } finally { await ctx.close(); }
});

test('inerzia: GET non muta lo stato (nessun side effect sul percorso di lettura)', async () => {
  const ctx = await boot();
  try {
    const before = ctx.store.snapshot();
    await fetch(`${ctx.base}/api/live-host`, { headers: H() });
    await fetch(`${ctx.base}/api/live-host`, { headers: H() });
    assert.deepEqual(ctx.store.snapshot(), before);
  } finally { await ctx.close(); }
});

test('BARRIERA omissione: due writer concorrenti SENZA expectedRevision -> 400 entrambi, nessun 200', async () => {
  const ctx = await boot();
  try {
    const [r1, r2] = await Promise.all([
      fetch(`${ctx.base}/api/live-host/designate`, { method: 'POST', headers: H(), body: JSON.stringify({ cellId: 'cloud-Dev' }) }),
      fetch(`${ctx.base}/api/live-host/designate`, { method: 'POST', headers: H(), body: JSON.stringify({ cellId: 'cloud-Off' }) }),
    ]);
    assert.equal(r1.status, 400);
    assert.equal(r2.status, 400);
    assert.equal((await j(await fetch(`${ctx.base}/api/live-host`, { headers: H() }))).hostCell, null);
  } finally { await ctx.close(); }
});

test('designate e clear senza expectedRevision (singolo) -> 400', async () => {
  const ctx = await boot();
  try {
    const d = await fetch(`${ctx.base}/api/live-host/designate`, { method: 'POST', headers: H(), body: JSON.stringify({ cellId: 'cloud-Dev' }) });
    assert.equal(d.status, 400);
    const c = await fetch(`${ctx.base}/api/live-host/clear`, { method: 'POST', headers: H(), body: JSON.stringify({}) });
    assert.equal(c.status, 400);
    // expected non-integer (stringa) -> 400, non accettato
    const s = await fetch(`${ctx.base}/api/live-host/designate`, { method: 'POST', headers: H(), body: JSON.stringify({ cellId: 'cloud-Dev', expectedRevision: '0' }) });
    assert.equal(s.status, 400);
  } finally { await ctx.close(); }
});
