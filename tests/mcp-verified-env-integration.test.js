'use strict';
// C8-ter integrazione: `nexuscrew mcp` REALE (subprocess) con metadati
// NEXUSCREW_VERIFIED_* nell'env e authority finta (hub HTTP locale che serve
// /api/lease/introspect). Positivo: nc_identity -> source verified-env,
// verified true. Mismatch: fail-closed VERIFIED_ENV_INVALID.
// Le tre variabili legacy NON servono (il figlio bound di vl.3 non le ha).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { persistIdentityChannel } = require('../lib/mcp/identity-provider.js');

const OWNER = 'a'.repeat(32);
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

function mondo({ incarnationMismatch = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vint-'));
  const tokenPath = path.join(dir, 'token');
  fs.writeFileSync(tokenPath, 'tok-verified\n', { mode: 0o600 });
  const incarnationId = 'ab'.repeat(8);
  const expiresAt = Date.now() + 6_000_000;
  const proof = {
    kind: 'child', cellId: 'cell-a', incarnationId, jti: 'c'.repeat(16),
    issuedAt: 1, expiresAt, proof: 'd'.repeat(64),
  };
  persistIdentityChannel({
    tokenPath, session: 'cloud-cell-a', cellId: 'cell-a', proof, expiresAt,
  });
  const envOut = {
    status: 'live', identityMode: 'authority', instanceId: OWNER,
    cellId: 'cell-a', tmuxSession: 'cloud-cell-a',
    incarnationId: incarnationMismatch ? 'cd'.repeat(8) : incarnationId,
    issuedAt: 1, expiresAt,
  };
  const hub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (incarnationMismatch && req.url === '/api/lease/introspect') {
        res.end(JSON.stringify({ ...envOut, status: 'stale' }));
        return;
      }
      res.end(JSON.stringify(envOut));
    });
  });
  const verifiedEnv = {
    NEXUSCREW_VERIFIED_ENV_VERSION: '1',
    NEXUSCREW_VERIFIED_OWNER_INSTANCE_ID: OWNER,
    NEXUSCREW_VERIFIED_CELL_ID: 'cell-a',
    NEXUSCREW_VERIFIED_INCARNATION_ID: incarnationId,
    NEXUSCREW_VERIFIED_BINDING_ID: 'binding-int',
    NEXUSCREW_VERIFIED_ORIGIN: 'local_tui',
  };
  return { dir, tokenPath, hub, verifiedEnv, proof };
}

function spawnMcp(t, { dir, tokenPath, port, verifiedEnv, extraEnv = {} }) {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    identityOwnerInstanceId: OWNER,
  }));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'nexuscrew.js'), 'mcp'], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      NEXUSCREW_CONFIG_FILE: configPath,
      NEXUSCREW_PORT: String(port),
      NEXUSCREW_TOKEN_FILE: tokenPath,
      ...verifiedEnv,
      ...extraEnv,
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
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const call = (id, method, params) => new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${rpc(id, method, params)}\n`);
  });
  return { child, call };
}

async function waitForLine(hub, timeoutMs = 3000) {
  const started = Date.now();
  while (!hub.listening) {
    if (Date.now() - started > timeoutMs) throw new Error('fake hub non in ascolto');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('integrazione: nc_identity verified su nexuscrew mcp reale', async (t) => {
  const m = mondo();
  await new Promise((res) => m.hub.listen(0, '127.0.0.1', res));
  await waitForLine(m.hub);
  t.after(() => m.hub.close());

  const { call } = spawnMcp(t, {
    dir: m.dir, tokenPath: m.tokenPath, port: m.hub.address().port, verifiedEnv: m.verifiedEnv,
  });
  await call(1, 'initialize', { protocolVersion: '2026-01-01' });
  const out = await call(2, 'tools/call', { name: 'nc_identity', arguments: {} });
  assert.equal(out.result.isError, undefined, 'nc_identity verified: nessun errore');
  const j = JSON.parse(out.result.content[0].text);
  assert.equal(j.identified, true);
  assert.equal(j.source, 'verified-env');
  assert.equal(j.verified, true);
  assert.equal(j.cellId, 'cell-a');
  assert.equal(j.ownerInstanceId, OWNER);
});

test('integrazione: incarnation mismatch -> fail-closed VERIFIED_ENV_INVALID', async (t) => {
  const m = mondo({ incarnationMismatch: true });
  await new Promise((res) => m.hub.listen(0, '127.0.0.1', res));
  await waitForLine(m.hub);
  t.after(() => m.hub.close());

  const { call } = spawnMcp(t, {
    dir: m.dir, tokenPath: m.tokenPath, port: m.hub.address().port, verifiedEnv: m.verifiedEnv,
  });
  await call(1, 'initialize', { protocolVersion: '2026-01-01' });
  const out = await call(2, 'tools/call', { name: 'nc_identity', arguments: {} });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_VERIFIED_ENV_INVALID/);
  // Mai fallback legacy: l'errore non nomina il percorso tmux/sessione.
  assert.doesNotMatch(out.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_MISSING/);
});
