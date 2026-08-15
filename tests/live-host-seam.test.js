'use strict';
// Seam lease↔designazione (dispatch Dev 2026-08-15, decisione: eligible in
// grace = FALSE). La designazione non perde hostCell mai (invariante store):
// oscilla l'IDONEITA', non la scelta dell'operatore. I quattro stati lease
// restano distinti fino a chi legge; il fallback senza fleet.lease e' un
// FAIL-OPEN dichiarato (eligible torna tmux-only, host.lease='unavailable').
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const express = require('express');
const { liveHostRoutes } = require('../lib/live-host/routes.js');
const { createLiveHostStore } = require('../lib/live-host/store.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');

const CELLS = [
  { cell: 'Dev', active: true, tmux: true, tmuxSession: 'cloud-Dev' },
  { cell: 'Off', active: false, tmux: false, tmuxSession: 'cloud-Off' },
];

function pair() {
  return new Promise((resolve, reject) => {
    let pending = null;
    const srv = net.createServer((sock) => { pending = sock; });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const client = net.createConnection(srv.address().port, '127.0.0.1', () => {
        const wait = () => pending ? (srv.close(() => {}), resolve({ serverSide: pending, client })) : setTimeout(wait, 2);
        wait();
      });
      client.once('error', reject);
    });
  });
}
// Stessa guardia di liveness di cell-lease-server, e stesso motivo: il timeout
// di recv dice «il messaggio non arrivera' MAI», non «e' arrivato tardi». Su
// loopback in-process arriva in pochi ms; i 500ms del vecchio default non
// proteggevano nulla e sotto il load di base di questa macchina (>7, flotta
// attiva, runner a concorrenza 2) li superava lo scheduling, non un difetto —
// il file cadeva 1 volta su 3 anche ISOLATO, con la firma «recv timeout».
// 5000ms coprono il «mai» restando invisibili quando tutto funziona.
const recv = (sock, pred, ms = 5000) => new Promise((resolve, reject) => {
  let buf = '';
  const to = setTimeout(() => { sock.removeListener('data', on); reject(new Error('recv timeout')); }, ms);
  const on = (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const m = JSON.parse(line); if (!pred || pred(m)) { clearTimeout(to); sock.removeListener('data', on); resolve(m); return; } } catch (_) {}
    }
  };
  sock.on('data', on);
});
const refresh = async (client) => {
  client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  return recv(client, (m) => m.type === 'ack');
};

async function boot({ fleetExtra } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-route-'));
  const clock = { t: 100_000 };
  const mgr = createLeaseManager({ home: dir, log: () => {} }, { now: () => clock.t });
  await mgr.track('Dev');
  const fleetP = Promise.resolve({
    available: true,
    status: async () => ({ available: true, cells: CELLS }),
    ...(fleetExtra || { lease: mgr }),
  });
  const store = createLiveHostStore({ filePath: path.join(dir, 'live-host.json'), now: () => clock.t });
  const app = express();
  app.use(express.json({ limit: '4kb' }));
  app.use('/api/live-host', liveHostRoutes({ fleetP, store, readonly: () => false, now: () => clock.t }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`, clock, mgr,
    get: async () => (await fetch(`${base()}/api/live-host`)).json(),
    designate: async (cellId, rev) => (await fetch(`${base()}/api/live-host/designate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cellId, expectedRevision: rev }),
    })).json(),
    close: () => { mgr.close(); fs.rmSync(dir, { recursive: true, force: true }); return new Promise((r) => server.close(r)); },
  };
  function base() { return `http://127.0.0.1:${server.address().port}`; }
}

test('eligible composto: attiva AND lease live; grace/expired/none non sono idonee (decisione: grace=false)', async () => {
  const ctx = await boot();
  try {
    await ctx.designate('Dev', 0);
    // lease APERTO: attach + refresh -> live
    const p = await pair();
    assert.equal(ctx.mgr.attachInitial('Dev', p.serverSide, { generation: 0 }), true);
    await refresh(p.client);
    let body = await ctx.get();
    assert.equal(body.hostCell, 'Dev');
    assert.equal(body.eligible, true, 'attiva + lease live -> idonea');
    assert.equal(body.host.lease, 'live', 'lo stato lease arriva DISTINTO a chi legge');

    // EOF -> grace: la garanzia non c'e' (decisione Dev: eligible=false)
    p.client.destroy();
    await new Promise((r) => setTimeout(r, 30));
    body = await ctx.get();
    assert.equal(body.host.lease, 'grace');
    assert.equal(body.eligible, false, 'grace: non idonea, ma VISIBILE come recupero in corso');

    // oltre la grace -> expired
    ctx.clock.t += 61_000;
    body = await ctx.get();
    assert.equal(body.host.lease, 'expired');
    assert.equal(body.eligible, false);
    // VINCOLO 1: la designazione NON si perde — oscilla l'idoneita', non la scelta
    assert.equal(body.hostCell, 'Dev', 'hostCell preservato oltre la scadenza del lease');
  } finally { await ctx.close(); }
});

test('designata attiva MAI supervisionata (lease none): eligible false, host.lease none', async () => {
  const ctx = await boot();
  try {
    await ctx.designate('Off', 0).then(() => {}); // Off e' inattiva: serve Dev
    const body = await ctx.get(); // riparte dalla designazione reale
    assert.equal(body.hostCell, 'Off'); // inattiva: gia' oggi non idonea
    assert.equal(body.eligible, false);
    // cella ATTIVA mai attach: designiamola davvero
    const d = await ctx.designate('Dev', body.revision);
    assert.equal(d.hostCell, 'Dev');
    assert.equal(d.host.lease, 'none', 'attiva in tmux, mai supervisionata: nessun lease');
    assert.equal(d.eligible, false, 'senza supervisione non c\'e garanzia: non idonea');
  } finally { await ctx.close(); }
});

test('VINCOLO 2 — fallback fail-open dichiarato: senza fleet.lease eligible torna tmux-only e host.lease=unavailable', async () => {
  const ctx = await boot({ fleetExtra: {} }); // nessun lease sul provider
  try {
    const d = await ctx.designate('Dev', 0);
    assert.equal(d.hostCell, 'Dev');
    assert.equal(d.host.lease, 'unavailable', 'la garanzia non e disponibile su questa installazione: DETTO, non implicito');
    assert.equal(d.eligible, true, 'fail-open: idoneita tmux-only quando il lease non esiste');
    const body = await ctx.get();
    assert.equal(body.host.lease, 'unavailable');
    assert.equal(body.eligible, true);
  } finally { await ctx.close(); }
});

test('senza designazione: host.lease null (nessun soggetto, nessuno stato)', async () => {
  const ctx = await boot();
  try {
    const body = await ctx.get();
    assert.equal(body.hostCell, null);
    assert.equal(body.host.lease, null);
    assert.equal(body.eligible, false);
  } finally { await ctx.close(); }
});

test('i cinque stati restano distinti: nessuno collassa nell altro', async () => {
  const ctx = await boot();
  try {
    await ctx.designate('Dev', 0);
    const seen = new Set();
    seen.add((await ctx.get()).host.lease); // none
    const p = await pair();
    ctx.mgr.attachInitial('Dev', p.serverSide, { generation: 0 });
    await refresh(p.client);
    seen.add((await ctx.get()).host.lease); // live
    p.client.destroy();
    await new Promise((r) => setTimeout(r, 30));
    seen.add((await ctx.get()).host.lease); // grace
    ctx.clock.t += 61_000;
    seen.add((await ctx.get()).host.lease); // expired
    const ctx2 = await boot({ fleetExtra: {} });
    try {
      await ctx2.designate('Dev', 0);
      seen.add((await ctx2.get()).host.lease); // unavailable
    } finally { await ctx2.close(); }
    assert.deepEqual([...seen].sort(), ['expired', 'grace', 'live', 'none', 'unavailable']);
  } finally { await ctx.close(); }
});

// --- Facade: cellStatus espone il segnale lease (il punto minimo del SEAM doc) --
//
// Il facade possiede gia' leaseManager nel ctx: qui si esprime. Senza leaseManager
// (installazione senza lease) il campo e' 'unavailable' — lo stesso fail-open
// dichiarato delle route, mai un valore che finga una verifica avvenuta.

const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { writeConfigAtomic } = require('../lib/cli/init.js');

function builtinWorld({ withLease }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-facade-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, 'Dev'); fs.mkdirSync(cwd);
  const command = path.join(root, 'true.sh'); fs.writeFileSync(command, '#!/bin/sh\nexit 0\n'); fs.chmodSync(command, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  writeConfigAtomic(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'claude', label: 'C', rc: true, command, args: ['--x'], env: {}, promptMode: 'flag', promptFlag: '--p' }],
    cells: [{ id: 'Dev', tmuxSession: 'work-build', cwd, engine: 'claude', boot: false }],
  });
  // tmux finto: la sessione e' sempre viva (la verita' tmux); il resto exit 0.
  const tmuxBin = path.join(root, 'fake-tmux.sh');
  fs.writeFileSync(tmuxBin, '#!/bin/sh\ncase "$1" in\n  list-sessions) echo "work-build: 1 windows (created)"; exit 0 ;;\n  *) exit 0 ;;\nesac\n');
  fs.chmodSync(tmuxBin, 0o755);
  return {
    fleetP: createBuiltinFleet({ home, fleetDefsPath: defsPath, tmuxBin, ...(withLease ? { cellLeaseEnabled: true } : {}) }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('facade: cellStatus espone lease per cella — unavailable senza leaseManager, none/live con', async () => {
  const noLease = builtinWorld({ withLease: false });
  try {
    const fleet = await noLease.fleetP;
    const cells = (await fleet.cellStatus()).cells;
    assert.equal(cells.length, 1);
    assert.equal(cells[0].lease, 'unavailable', 'senza leaseManager: garanzia non disponibile, DETTA');
    await fleet.close();
  } finally { noLease.cleanup(); }

  const withLease = builtinWorld({ withLease: true });
  try {
    const fleet = await withLease.fleetP;
    let cells = (await fleet.cellStatus()).cells;
    assert.equal(cells[0].lease, 'none', 'mai supervisionata: nessun lease, nessuna garanzia');
    // il lease si apre dal percorso reale: track + attachInitial sul manager esposto
    await fleet.lease.track('Dev');
    const p = await pair();
    assert.equal(fleet.lease.attachInitial('Dev', p.serverSide, { generation: 0 }), true);
    p.client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
    await recv(p.client, (m) => m.type === 'ack');
    cells = (await fleet.cellStatus()).cells;
    assert.equal(cells[0].lease, 'live', 'lease aperto e rinfrescato: il facade lo vede live');
    p.client.destroy();
    await fleet.close();
  } finally { withLease.cleanup(); }
});
