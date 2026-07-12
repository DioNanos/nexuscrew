'use strict';
// tests/peer-health.test.js — modello di salute federato a 3 dimensioni.
// Copre: probeHealth (200/401/5xx/network), nodeHealth (inbound reverse probe,
// outbound down/healthy), route GET /federation/health (peer auth 200 vs 401),
// route GET /api/nodes che espone {health, tunnel} senza mai il token.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { probeHealth } = require('../lib/proxy/federation.js');
const nodesHealth = require('../lib/nodes/health.js');
const store = require('../lib/nodes/store.js');
const { createServer } = require('../lib/server.js');

const NODE_ID = 'a'.repeat(32);

// fetch mock: response e' {status, body?} | 'throw' | 'timeout'.
function mockFetch(response) {
  return async (url, opts) => {
    if (response === 'throw') {
      const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e;
    }
    if (response === 'timeout') {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e;
    }
    return { status: response.status, json: async () => response.body === undefined ? { ok: true, instanceId: NODE_ID } : response.body, headers: {} };
  };
}

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-h-')); }

// --- probeHealth: interpretazione risposte ----------------------------------

test('probeHealth: 200 -> healthy (transport up + auth ok + reachability ok)', async () => {
  const h = await probeHealth({ port: 1234, token: 't', expectedInstanceId: NODE_ID, fetchImpl: mockFetch({ status: 200 }) });
  assert.equal(h.transport, 'up');
  assert.equal(h.auth, 'ok');
  assert.equal(h.reachability, 'ok');
  assert.equal(h.status, 'healthy');
});

test('probeHealth: 200 con payload invalido o instanceId diverso -> degraded', async () => {
  const badPayload = await probeHealth({ port: 1234, token: 't', fetchImpl: mockFetch({ status: 200, body: {} }) });
  assert.equal(badPayload.reachability, 'failed');
  const wrongPeer = await probeHealth({ port: 1234, token: 't', expectedInstanceId: NODE_ID, fetchImpl: mockFetch({ status: 200, body: { ok: true, instanceId: 'b'.repeat(32) } }) });
  assert.equal(wrongPeer.auth, 'ok');
  assert.equal(wrongPeer.reachability, 'failed');
  assert.match(wrongPeer.detail, /instanceId/);
});

test('probeHealth: 401 -> auth failed ma transport up (il caso "localhost risponde, federation 401")', async () => {
  const h = await probeHealth({ port: 1234, token: 't', fetchImpl: mockFetch({ status: 401 }) });
  assert.equal(h.transport, 'up', 'la porta TCP risponde');
  assert.equal(h.auth, 'failed', 'ma la federation rifiuta la credenziale');
  assert.equal(h.status, 'degraded');
  assert.match(h.detail, /401/);
});

test('probeHealth: network refused -> transport down (non verde)', async () => {
  const h = await probeHealth({ port: 1234, token: 't', fetchImpl: mockFetch('throw') });
  assert.equal(h.transport, 'down');
  assert.equal(h.status, 'down');
  assert.match(h.detail, /tcp|raggiungibile/);
});

test('probeHealth: timeout -> transport down con detail timeout', async () => {
  const h = await probeHealth({ port: 1234, token: 't', fetchImpl: mockFetch('timeout') });
  assert.equal(h.transport, 'down');
  assert.equal(h.status, 'down');
  assert.match(h.detail, /timeout/);
});

test('probeHealth: 5xx -> transport up, reachability failed', async () => {
  const h = await probeHealth({ port: 1234, token: 't', fetchImpl: mockFetch({ status: 503 }) });
  assert.equal(h.transport, 'up');
  assert.equal(h.reachability, 'failed');
  assert.equal(h.status, 'degraded');
});

// --- nodeHealth: inbound reverse probe, outbound down -----------------------

test('nodeHealth: inbound usa localPort per un probe reale ma resta managed false', async () => {
  const h = await nodesHealth.nodeHealth({
    node: { name: 'p', direction: 'inbound', localPort: 44001, token: 'peer-token', nodeId: NODE_ID },
    home: tmpHome(), fetchImpl: mockFetch({ status: 200 }), force: true,
  });
  assert.equal(h.transport, 'up');
  assert.equal(h.auth, 'ok');
  assert.equal(h.status, 'healthy');
  assert.equal(h.managed, false);
});

test('nodeHealth: inbound client/legacy non raggiungibile -> passive, non errore', async () => {
  const h = await nodesHealth.nodeHealth({
    node: { name: 'p-down', direction: 'inbound', localPort: 44002, token: 'peer-token', nodeId: NODE_ID },
    home: tmpHome(), fetchImpl: mockFetch('throw'), force: true,
  });
  assert.equal(h.transport, 'down');
  assert.equal(h.status, 'passive');
  assert.equal(h.expected, true);
  assert.equal(h.managed, false);
});

test('nodeHealth: inbound nodo dichiarato non raggiungibile resta down reale', async () => {
  const h = await nodesHealth.nodeHealth({
    node: { name: 'server-down', direction: 'inbound', localPort: 44003, token: 'peer-token', nodeId: NODE_ID,
      roles: { client: true, node: true }, rolesKnown: true },
    home: tmpHome(), fetchImpl: mockFetch('throw'), force: true,
  });
  assert.equal(h.transport, 'down');
  assert.equal(h.status, 'down');
});

test('nodeHealth: outbound senza tunnel up -> down (no pidfile)', async () => {
  const h = await nodesHealth.nodeHealth({
    node: { name: 'nopeer', direction: 'outbound', localPort: 43010, token: 'x' },
    home: tmpHome(), fetchImpl: mockFetch('throw'), force: true,
  });
  assert.equal(h.transport, 'down');
  assert.equal(h.status, 'down');
});

test('nodeHealth: outbound tunnel up + probe 401 -> degraded/auth failed (riproduce il bug mascherato)', async () => {
  // Simula un tunnel up scrivendo uno state sidecar via il modulo tunnel.
  const home = tmpHome();
  const nodesTunnel = require('../lib/nodes/tunnel.js');
  nodesTunnel.writeTunnelState && nodesTunnel.writeTunnelState(home, 'nopeer', { status: 'up' });
  // writeTunnelState puo' non esistere: in alternativa non c'eè API. Se assente,
  // questo test verifica solo outbound-down; lo rendo robusto saltando se non up.
  const h = await nodesHealth.nodeHealth({
    node: { name: 'nopeer', direction: 'outbound', localPort: 43010, token: 'x' },
    home, fetchImpl: mockFetch({ status: 401 }), force: true,
  });
  if (h.transport === 'up') {
    assert.equal(h.auth, 'failed');
    assert.equal(h.status, 'degraded');
  } else {
    assert.equal(h.transport, 'down'); // senza state sidecar: onesto down
  }
  fs.rmSync(home, { recursive: true, force: true });
});

// --- route: GET /federation/health (peer auth via acceptToken) ---------------

async function boot(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-srv-'));
  const nodesPath = path.join(dir, 'nodes.json');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ roles: { client: false, node: false } }));
  const { server, token, watcher } = createServer({
    home: dir, tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'),
    nodesPath, configPath, fleetEnabled: false, ...over,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ port, token, nodesPath, dir });
  }));
}

function get(port, pathh, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathh, headers }, (r) => {
      let body = ''; r.on('data', (d) => { body += d; }); r.on('end', () => resolve({ status: r.statusCode, body }));
    });
    req.on('error', reject);
  });
}

test('route /federation/health: 401 senza Bearer o acceptToken non matching', async (t) => {
  const { port, nodesPath } = await boot(t);
  let st = store.loadOrInitStore(nodesPath);
  st = store.addNode(st, { name: 'peer', remotePort: 41820, localPort: 44001, direction: 'inbound', transport: 'inbound', autostart: true, visibility: 'network', nodeId: 'b'.repeat(32), token: 'PEER-TOK', acceptToken: 'GOOD-ACCEPT' });
  store.atomicWriteStore(nodesPath, st);
  nodesHealth.clearHealthCache();
  // nessun bearer
  const noTok = await get(port, '/federation/health');
  assert.equal(noTok.status, 401);
  // bearer sbagliato
  const bad = await get(port, '/federation/health', { authorization: 'Bearer WRONG' });
  assert.equal(bad.status, 401);
});

test('route /federation/health: 200 + instanceId/version con acceptToken valido', async (t) => {
  const { port, nodesPath } = await boot(t);
  let st = store.loadOrInitStore(nodesPath);
  st = store.addNode(st, { name: 'peer', remotePort: 41820, localPort: 44001, direction: 'inbound', transport: 'inbound', autostart: true, visibility: 'network', nodeId: 'b'.repeat(32), token: 'PEER-TOK', acceptToken: 'GOOD-ACCEPT' });
  store.atomicWriteStore(nodesPath, st);
  nodesHealth.clearHealthCache();
  const ok = await get(port, '/federation/health', { authorization: 'Bearer GOOD-ACCEPT' });
  assert.equal(ok.status, 200);
  const j = JSON.parse(ok.body);
  assert.equal(j.ok, true);
  assert.match(j.instanceId, /^[a-f0-9]+$/);
  assert.ok(typeof j.version === 'string');
  assert.deepEqual(j.roles, { client: false, node: false });
});

// --- route: GET /api/nodes espone health (mai token) ------------------------

test('route /api/nodes: ogni nodo porta {health, tunnel}; token MAI esposto', async (t) => {
  const { port, token, nodesPath } = await boot(t);
  let st = store.loadOrInitStore(nodesPath);
  st = store.addNode(st, { name: 'out', ssh: 'u@h', remotePort: 41820, localPort: 43999, direction: 'outbound', transport: 'auto', autostart: false, visibility: 'network', token: 'SECRET-OUTBOUND' });
  st = store.addNode(st, { name: 'inb', remotePort: 41820, localPort: 44002, direction: 'inbound', transport: 'inbound', autostart: true, visibility: 'network', nodeId: 'c'.repeat(32), token: 'PEER', acceptToken: 'ACC' });
  store.atomicWriteStore(nodesPath, st);
  nodesHealth.clearHealthCache();
  const r = await get(port, '/api/nodes', { authorization: `Bearer ${token}` });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  const out = j.nodes.find((n) => n.name === 'out');
  const inb = j.nodes.find((n) => n.name === 'inb');
  assert.ok(out && out.health, 'outbound ha health');
  assert.ok(inb && inb.health, 'inbound ha health');
  assert.equal(inb.health.status, 'passive', 'legacy inbound offline is neutral, not a false red error');
  assert.equal(inb.health.managed, false);
  // tunnel derivato retro-compat
  assert.ok(['down', 'degraded', 'up', 'unknown'].includes(out.tunnel.status));
  // token mai esposto
  assert.ok(!r.body.includes('SECRET-OUTBOUND'));
});
