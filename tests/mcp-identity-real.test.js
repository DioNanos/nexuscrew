'use strict';
// G1 commit 3 — provider MCP produttivo: proof child persistito + introspect
// HTTP reale + processo `nexuscrew mcp` stdio. Niente provider sintetico.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const express = require('express');
const { leaseRoutes } = require('../lib/fleet/lease-routes.js');
const { notifyRoutes } = require('../lib/notify/routes.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { persistIdentityChannel } = require('../lib/mcp/identity-provider.js');
const { createMcpServer } = require('../lib/mcp/server.js');

const LOCAL = 'a'.repeat(32);
const CELL = 'Dev';
const SESSION = `cloud-${CELL}`;
const BIN = path.join(__dirname, '..', 'bin', 'nexuscrew.js');

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

async function spawnMcp(t, { home, tokenPath, port, session }) {
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      NEXUSCREW_CONFIG_FILE: path.join(home, 'config.json'),
      NEXUSCREW_PORT: String(port),
      NEXUSCREW_TOKEN_FILE: tokenPath,
      NEXUSCREW_MCP_SESSION: session,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill(); } catch (_) {} });
  const pending = new Map();
  let buf = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
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
    const timer = setTimeout(() => {
      reject(new Error(`timeout MCP id=${id} stderr=${stderr.slice(0, 400)}`));
    }, 8000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${rpc(id, method, params)}\n`);
  });
  const init = await call(1, 'initialize', { protocolVersion: '2025-03-26' });
  assert.equal(init.result.serverInfo.name, 'nexuscrew');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return { child, call, stderr: () => stderr };
}

async function makeHub(t, { identityMode = 'authority', introspectStatus = null, introspectIncarnationId = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mcp-id-real-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  const tokenPath = path.join(home, 'token');
  fs.writeFileSync(tokenPath, 'fixture-token\n', { mode: 0o600 });
  const mgr = createLeaseManager({ home, log: () => {} });
  t.after(() => mgr.close());
  await mgr.track(CELL);
  const introspects = [];
  const notifies = [];
  const lease = {
    childRegister: (...args) => mgr.childRegister(...args),
    childRefresh: (...args) => mgr.childRefresh(...args),
    childRecovery: (...args) => mgr.childRecovery(...args),
    childIntrospect: (proof) => {
      introspects.push(proof);
      const out = mgr.childIntrospect(proof);
      // Seam dedicato alla difesa in profondità del provider: l’autorità
      // accetta il proof, ma risponde per un’incarnazione diversa.
      if (out && out.status === 'live' && introspectIncarnationId) {
        return { ...out, incarnationId: introspectIncarnationId };
      }
      return out;
    },
  };
  const fleetP = Promise.resolve({ available: true, lease });
  const notifier = {
    emit: async (frame) => {
      notifies.push(frame);
      return { ui: 1, push: 0 };
    },
  };
  const app = express();
  app.use('/api', notifyRoutes({
    cfg: {},
    notifier,
    push: { sendToAll: async () => ({ sent: 0, removed: 0 }), vapidPublicKey: () => 'k' },
    asks: { create: () => ({ id: 'ask' }) },
    paste: async () => true,
    sessionExists: (session) => session === SESSION,
    fleetP,
    instanceId: () => LOCAL,
    identityMode,
    localNodeId: () => LOCAL,
  }));
  if (introspectStatus) {
    app.post('/api/lease/introspect', (_req, res) => {
      res.status(introspectStatus).json({ error: 'authority-down' });
    });
  }
  app.use('/api/lease', leaseRoutes({
    fleetP,
    identityMode,
    identityAuthority: {},
    instanceId: () => LOCAL,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    home, tokenPath, mgr, lease, introspects, notifies,
    port: server.address().port,
    persist(proof) {
      return persistIdentityChannel({
        tokenPath, session: SESSION, cellId: CELL, proof, expiresAt: Number(proof.expiresAt),
      });
    },
  };
}

function forgedChildProof() {
  return {
    kind: 'child',
    cellId: CELL,
    incarnationId: 'ab'.repeat(8),
    jti: 'c'.repeat(16),
    issuedAt: String(Date.now()),
    expiresAt: Date.now() + 60_000,
    proof: 'd'.repeat(64),
  };
}

test('mcp_legacy_channel_absent_unchanged', async (t) => {
  const hub = await makeHub(t, { identityMode: 'legacy' });
  const mcp = await spawnMcp(t, {
    home: hub.home, tokenPath: hub.tokenPath, port: hub.port, session: SESSION,
  });
  const identity = await mcp.call(2, 'tools/call', { name: 'nc_identity', arguments: {} });
  assert.equal(identity.result.isError, undefined);
  const body = JSON.parse(identity.result.content[0].text);
  assert.equal(body.identified, true);
  assert.equal(body.session, SESSION);
  assert.equal(body.source, 'NEXUSCREW_MCP_SESSION');
  assert.equal(body.bindingId, undefined);
  const notify = await mcp.call(3, 'tools/call', {
    name: 'nc_notify', arguments: { title: 'legacy D' },
  });
  assert.equal(notify.result.isError, undefined);
  assert.deepEqual(JSON.parse(notify.result.content[0].text), { delivered: { ui: 1, push: 0 } });
  assert.equal(hub.introspects.length, 0);
  assert.equal(hub.notifies.length, 1);
});

test('mcp_provider_uses_persisted_proof_and_online_introspect', async (t) => {
  const hub = await makeHub(t);
  const reg = hub.mgr.childRegister(CELL, { authority: true });
  assert.equal(hub.persist(reg.proof), true);
  const mcp = await spawnMcp(t, {
    home: hub.home, tokenPath: hub.tokenPath, port: hub.port, session: SESSION,
  });
  const identity = await mcp.call(2, 'tools/call', { name: 'nc_identity', arguments: {} });
  assert.equal(identity.result.isError, undefined, identity.result && identity.result.content[0].text);
  const body = JSON.parse(identity.result.content[0].text);
  assert.equal(body.source, 'online');
  assert.equal(body.session, SESSION);
  assert.equal(body.ownerInstanceId, LOCAL);
  assert.equal(body.cellId, CELL);
  assert.equal(body.origin, 'daemon');
  assert.equal(typeof body.expiresAt, 'number');
  assert.equal(hub.introspects.length, 1);
  assert.equal(hub.introspects[0].jti, reg.proof.jti);
  const notify = await mcp.call(3, 'tools/call', {
    name: 'nc_notify', arguments: { title: 'verified' },
  });
  assert.equal(notify.result.isError, undefined, notify.result && notify.result.content[0].text);
  assert.equal(hub.notifies.length, 1);
  assert.ok(hub.introspects.length >= 2, 'ogni tools/call ripete introspect');
});

test('mcp_binding_rejects_unverified_context', async (t) => {
  const hub = await makeHub(t);
  assert.equal(hub.persist(forgedChildProof()), true);
  const mcp = await spawnMcp(t, {
    home: hub.home, tokenPath: hub.tokenPath, port: hub.port, session: SESSION,
  });
  const notify = await mcp.call(2, 'tools/call', {
    name: 'nc_notify', arguments: { title: 'must not emit' },
  });
  assert.equal(notify.result.isError, true);
  assert.match(notify.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_CONTEXT_(MISSING|UNVERIFIED)|non verificato|non disponibile/);
  assert.equal(hub.notifies.length, 0);
  assert.ok(hub.introspects.length >= 1);
});

test('mcp_provider_has_no_lifetime_success_cache', async (t) => {
  const hub = await makeHub(t);
  const first = hub.mgr.childRegister(CELL, { authority: true });
  assert.equal(hub.persist(first.proof), true);
  const mcp = await spawnMcp(t, {
    home: hub.home, tokenPath: hub.tokenPath, port: hub.port, session: SESSION,
  });
  const ok = await mcp.call(2, 'tools/call', { name: 'nc_identity', arguments: {} });
  assert.equal(ok.result.isError, undefined, ok.result && ok.result.content[0].text);
  assert.equal(JSON.parse(ok.result.content[0].text).source, 'online');
  const afterFirst = hub.introspects.length;
  assert.ok(afterFirst >= 1);
  hub.mgr.childRegister(CELL, { authority: true });
  const again = await mcp.call(3, 'tools/call', { name: 'nc_identity', arguments: {} });
  assert.equal(again.result.isError, true);
  assert.match(again.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_CONTEXT_(MISSING|UNVERIFIED)|non verificato|non disponibile/);
  assert.ok(hub.introspects.length > afterFirst, 'il successo non resta cacheato a vita');
});

test('mcp_provider_rejects_introspected_incarnation_mismatch', async (t) => {
  const hub = await makeHub(t, { introspectIncarnationId: 'bb'.repeat(8) });
  const reg = hub.mgr.childRegister(CELL, { authority: true });
  assert.equal(hub.persist(reg.proof), true);
  const mcp = await spawnMcp(t, {
    home: hub.home, tokenPath: hub.tokenPath, port: hub.port, session: SESSION,
  });
  const identity = await mcp.call(2, 'tools/call', { name: 'nc_identity', arguments: {} });
  assert.equal(identity.result.isError, true);
  assert.match(identity.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_CONTEXT_UNVERIFIED|non verificato/);
  const notify = await mcp.call(3, 'tools/call', {
    name: 'nc_notify', arguments: { title: 'must not emit' },
  });
  assert.equal(notify.result.isError, true);
  assert.equal(hub.notifies.length, 0);
  assert.equal(hub.introspects.length, 2);
});

test('mcp_nc_identity_verified_only_after_introspection', async (t) => {
  const hub = await makeHub(t);
  assert.equal(hub.persist(forgedChildProof()), true);
  const mcp = await spawnMcp(t, {
    home: hub.home, tokenPath: hub.tokenPath, port: hub.port, session: SESSION,
  });
  const denied = await mcp.call(2, 'tools/call', { name: 'nc_identity', arguments: {} });
  assert.equal(denied.result.isError, true);
  assert.doesNotMatch(denied.result.content[0].text, /"identified":\s*true/);
  assert.match(denied.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_CONTEXT_(MISSING|UNVERIFIED)|non verificato|non disponibile/);
  const live = hub.mgr.childRegister(CELL, { authority: true });
  assert.equal(hub.persist(live.proof), true);
  const verified = await mcp.call(3, 'tools/call', { name: 'nc_identity', arguments: {} });
  assert.equal(verified.result.isError, undefined, verified.result && verified.result.content[0].text);
  const body = JSON.parse(verified.result.content[0].text);
  assert.equal(body.source, 'online');
  assert.equal(body.identified, true);
  assert.equal(body.ownerInstanceId, LOCAL);
  assert.ok(hub.introspects.length >= 2);
});

test('mcp_nc_identity_exposes_thread_and_verified_flag', async (t) => {
  const hub = await makeHub(t);
  const reg = hub.mgr.childRegister(CELL, { authority: true });
  assert.equal(hub.persist(reg.proof), true);
  const mcp = await spawnMcp(t, {
    home: hub.home, tokenPath: hub.tokenPath, port: hub.port, session: SESSION,
  });
  const identity = await mcp.call(2, 'tools/call', { name: 'nc_identity', arguments: {} });
  assert.equal(identity.result.isError, undefined, identity.result && identity.result.content[0].text);
  const body = JSON.parse(identity.result.content[0].text);
  assert.equal(body.source, 'online');
  assert.equal(body.verified, true);
  assert.equal(body.threadId, reg.proof.incarnationId);

  const lines = [];
  const now = Date.now();
  const srv = createMcpServer({
    output: { write: (s) => { for (const line of String(s).split('\n')) if (line.trim()) lines.push(JSON.parse(line)); } },
    env: { NEXUSCREW_MCP_SESSION: SESSION },
    config: { port: 1, tokenPath: hub.tokenPath, tmuxBin: 'tmux' },
    identityContextProvider: async () => ({
      version: '1', kind: 'connection-v1', verified: true, mode: 'shared',
      bindingId: 'bind-conn', ownerInstanceId: LOCAL, cellId: CELL,
      tmuxSession: SESSION, connectionId: 'conn-1', origin: 'daemon',
      audience: 'nexuscrew-mcp', scopes: ['mcp:tools/call'],
      issuedAt: now - 1000, notBefore: now - 1000, expiresAt: now + 60_000,
    }),
    errlog: () => {},
  });
  await srv.handleLine(rpc(9, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const conn = JSON.parse(lines[0].result.content[0].text);
  assert.equal(conn.verified, true);
  assert.equal(conn.threadId, null);
});

test('mcp_authority_unavailable_is_distinct_and_fail_closed', async (t) => {
  const hub = await makeHub(t, { introspectStatus: 500 });
  const reg = hub.mgr.childRegister(CELL, { authority: true });
  assert.equal(hub.persist(reg.proof), true);
  const mcp = await spawnMcp(t, {
    home: hub.home, tokenPath: hub.tokenPath, port: hub.port, session: SESSION,
  });
  const identity = await mcp.call(2, 'tools/call', { name: 'nc_identity', arguments: {} });
  assert.equal(identity.result.isError, true);
  assert.match(identity.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_AUTHORITY_UNAVAILABLE/);
  assert.doesNotMatch(identity.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_CONTEXT_UNVERIFIED/);
  const notify = await mcp.call(3, 'tools/call', {
    name: 'nc_notify', arguments: { title: 'must not emit' },
  });
  assert.equal(notify.result.isError, true);
  assert.match(notify.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_AUTHORITY_UNAVAILABLE/);
  assert.equal(hub.notifies.length, 0);
});
