'use strict';
// NC-5 subset: processi reali NC (authority/lease, nexuscrew mcp stdio, bus,
// sonda emit). VL C5 non chiuso: i casi che richiedono TUI/daemon/app-server
// restano skip espliciti, non verdi finti.
//
// Revisioni pinnate (documentate, non eseguite qui):
//   NC  760ac031d3c1bfe9581c82b346d9017827a04603  (tip NC-4 residuo)
//   VL  865fefceb5 … 7339ffa0af                   (C1–C4; C5 aperto)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const { leaseRoutes } = require('../lib/fleet/lease-routes.js');
const { notifyRoutes } = require('../lib/notify/routes.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { persistIdentityChannel } = require('../lib/mcp/identity-provider.js');
const { requireToken } = require('../lib/auth/middleware.js');
const { liveHostRoutes } = require('../lib/live-host/routes.js');
const { createLiveHostStore } = require('../lib/live-host/store.js');
const { createLiveBridge } = require('../lib/live-host/bridge.js');

const PINNED_NC = '760ac031d3c1bfe9581c82b346d9017827a04603';
const PINNED_VL_FROM = '865fefceb5';
const PINNED_VL_TO = '7339ffa0af';
const SKIP_VL = `richiede VL C5/daemon/TUI (pinnato ${PINNED_VL_FROM}..${PINNED_VL_TO}; NC ${PINNED_NC.slice(0, 7)})`;

const LOCAL = 'a'.repeat(32);
const CELL = 'Dev';
const SESSION = `cloud-${CELL}`;
const BIN = path.join(__dirname, '..', 'bin', 'nexuscrew.js');
const TOKEN = 'bridge-token-123';
const H = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

async function spawnMcp(t, { home, tokenPath, port, session }) {
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    env: {
      PATH: process.env.PATH, HOME: home,
      NEXUSCREW_CONFIG_FILE: path.join(home, 'config.json'),
      NEXUSCREW_PORT: String(port), NEXUSCREW_TOKEN_FILE: tokenPath,
      NEXUSCREW_MCP_SESSION: session,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill(); } catch (_) {} });
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== null && msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg); pending.delete(msg.id);
      }
    }
  });
  const call = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout MCP id=${id}`)), 8000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${rpc(id, method, params)}\n`);
  });
  await call(1, 'initialize', { protocolVersion: '2025-03-26' });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return { call };
}

async function makeMcpHub(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc5-term-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  const tokenPath = path.join(home, 'token');
  fs.writeFileSync(tokenPath, 'fixture-token\n', { mode: 0o600 });
  const mgr = createLeaseManager({ home, log: () => {} });
  t.after(() => mgr.close());
  await mgr.track(CELL);
  const notifies = [];
  const fleetP = Promise.resolve({
    available: true,
    lease: {
      childRegister: (...a) => mgr.childRegister(...a),
      childRefresh: (...a) => mgr.childRefresh(...a),
      childRecovery: (...a) => mgr.childRecovery(...a),
      childIntrospect: (...a) => mgr.childIntrospect(...a),
    },
  });
  const app = express();
  app.use('/api', notifyRoutes({
    cfg: {},
    notifier: { emit: async (frame) => { notifies.push(frame); return { ui: 1, push: 0 }; } },
    push: { sendToAll: async () => ({ sent: 0, removed: 0 }), vapidPublicKey: () => 'k' },
    asks: { create: () => ({ id: 'ask' }) },
    paste: async () => true,
    sessionExists: (session) => session === SESSION,
    fleetP, instanceId: () => LOCAL, identityMode: 'authority', localNodeId: () => LOCAL,
  }));
  app.use('/api/lease', leaseRoutes({
    fleetP, identityMode: 'authority', identityAuthority: {}, instanceId: () => LOCAL,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    home, tokenPath, mgr, notifies, port: server.address().port,
    persist(proof) {
      return persistIdentityChannel({
        tokenPath, session: SESSION, cellId: CELL, proof, expiresAt: Number(proof.expiresAt),
      });
    },
  };
}

test('tool_sees_bound_owner_and_cell', async (t) => {
  const hub = await makeMcpHub(t);
  const reg = hub.mgr.childRegister(CELL, { authority: true });
  assert.equal(hub.persist(reg.proof), true);
  const mcp = await spawnMcp(t, {
    home: hub.home, tokenPath: hub.tokenPath, port: hub.port, session: SESSION,
  });
  const identity = await mcp.call(2, 'tools/call', { name: 'nc_identity', arguments: {} });
  assert.equal(identity.result.isError, undefined, identity.result && identity.result.content[0].text);
  const body = JSON.parse(identity.result.content[0].text);
  assert.equal(body.verified, true);
  assert.equal(body.ownerInstanceId, LOCAL);
  assert.equal(body.cellId, CELL);
  const notify = await mcp.call(3, 'tools/call', { name: 'nc_notify', arguments: { title: 'bound-owner' } });
  assert.equal(notify.result.isError, undefined, notify.result && notify.result.content[0].text);
  assert.equal(hub.notifies.length, 1);
  assert.equal(hub.notifies[0].session, SESSION);
});

test('forged_claims_fail_before_effect', async (t) => {
  const hub = await makeMcpHub(t);
  assert.equal(hub.persist({
    kind: 'child', cellId: CELL, incarnationId: 'ab'.repeat(8), jti: 'c'.repeat(16),
    issuedAt: String(Date.now()), expiresAt: Date.now() + 60_000, proof: 'd'.repeat(64),
  }), true);
  const mcp = await spawnMcp(t, {
    home: hub.home, tokenPath: hub.tokenPath, port: hub.port, session: SESSION,
  });
  const notify = await mcp.call(2, 'tools/call', { name: 'nc_notify', arguments: { title: 'forged' } });
  assert.equal(notify.result.isError, true);
  assert.equal(hub.notifies.length, 0, 'sonda destinataria: zero effetti');
});

function makeFakeDaemon({ socketPath, threadId = 'bridge-thread-0001', delayMs = 120 } = {}) {
  const seen = { methods: [], threadStarts: [] };
  const server = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(String(data)); } catch (_) { return; }
        seen.methods.push(msg.method || `reply#${msg.id}`);
        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { userAgent: 'fake-app-server/test', codexHome: '/tmp/fake-codex-home' },
          }));
        } else if (msg.method === 'thread/start') {
          seen.threadStarts.push(msg.params || {});
          setTimeout(() => ws.send(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { thread: { id: threadId }, cwd: (msg.params || {}).cwd, model: 'fake', modelProvider: 'fake' },
          })), delayMs);
        } else if (msg.method === 'thread/stop') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        } else if (msg.method === 'turn/start' || msg.method === 'thread/resume') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { accepted: true } }));
        } else if (msg.method) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'metodo sconosciuto' } }));
        }
      });
    });
  });
  return {
    seen,
    listen: () => new Promise((resolve, reject) => {
      try { fs.rmSync(socketPath, { force: true }); } catch (_) { /* assente */ }
      server.once('error', reject);
      server.listen(socketPath, resolve);
    }),
    close: () => new Promise((resolve) => {
      wss.clients.forEach((c) => { try { c.terminate(); } catch (_) { /* già chiuso */ } });
      server.close(() => { try { fs.rmSync(socketPath, { force: true }); } catch (_) { /* già */ } resolve(); });
    }),
  };
}

async function aspettaEvento(condizione) {
  for (;;) {
    if (condizione()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('lease_pairing_designation_race_denies_old_binding', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc5-live-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  const root = path.join(dir, 'NexusFiles');
  fs.mkdirSync(root, { recursive: true });
  const socketPath = path.join(dir, 'app-server-control.sock');
  const daemon = makeFakeDaemon({ socketPath });
  await daemon.listen();
  t.after(() => daemon.close());
  const store = createLiveHostStore({ filePath: path.join(dir, 'live-host.json'), now: () => 42000 });
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  const cfg = {
    port, liveBridgeEnabled: true, liveBridgeSocketPath: socketPath,
    liveBridgeTimeoutMs: 1500, filesRoot: root,
  };
  const cells = [
    { cell: 'cloud-Alfa', active: true, tmux: true, tmuxSession: 'cloud-Alfa', engine: 'codex-vl.native', cwd: '/tmp' },
    { cell: 'cloud-Beta', active: true, tmux: true, tmuxSession: 'cloud-Beta', engine: 'claude.native', cwd: '/tmp' },
  ];
  const fleetP = Promise.resolve({
    available: true,
    status: async () => ({ available: true, cells }),
    lease: { status: () => ({ state: 'live', leaseId: 'lease-1', generation: 3 }) },
  });
  const bridge = createLiveBridge({ cfg, fleetP, tokenGet: () => TOKEN, filesRoot: root });
  const app = express();
  app.use('/api/live-host', requireToken({ get: () => TOKEN }), liveHostRoutes({
    fleetP, store, readonly: () => false, bridge,
  }));
  server.on('request', app);
  const base = `http://127.0.0.1:${port}`;
  const designate = async (cellId) => {
    const rev = (await (await fetch(`${base}/api/live-host`, { headers: H() })).json()).revision;
    return fetch(`${base}/api/live-host/designate`, {
      method: 'POST', headers: H(), body: JSON.stringify({ cellId, expectedRevision: rev }),
    });
  };
  await designate('cloud-Alfa');
  const promise = bridge.resolveForLive();
  await aspettaEvento(() => daemon.seen.threadStarts.length === 1);
  const changed = await designate('cloud-Beta');
  assert.equal(changed.status, 200);
  const out = await promise;
  assert.equal(out.mode, 'none');
  assert.equal(out.reason, 'designation-changed');
  assert.equal(out.discardedThread, 'bridge-thread-0001');
  assert.equal(daemon.seen.methods.includes('turn/start'), false);
  assert.equal(daemon.seen.methods.includes('thread/resume'), false);
});

test('new_tui_b_never_reuses_a_identity', { skip: SKIP_VL }, () => {});
test('paired_live_preserves_host_a_origin', { skip: SKIP_VL }, () => {});
test('a_b_live_interleaving_isolation', { skip: SKIP_VL }, () => {});
test('resume_fork_and_new_incarnation_reauthorize', { skip: SKIP_VL }, () => {});
test('cwd_does_not_become_identity', { skip: SKIP_VL }, () => {});
test('stale_socket_and_restart_are_scoped', { skip: SKIP_VL }, () => {});
test('feature_register_contract_smoke', { skip: SKIP_VL }, () => {});
