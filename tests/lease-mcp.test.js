'use strict';
// Fetta 2b — tool MCP nc_lease_register / nc_lease_refresh / nc_lease_recovery
// (B5): la superficie child vista dal bridge dentro la cella. MAI tmux reale:
// identita' via env esplicito, API via fetch finto (pattern di mcp-server.test).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMcpServer } = require('../lib/mcp/server.js');
const { TOOLS } = require('../lib/mcp/tools.js');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'leasemcp-')); }

function makeSrv({ env, responder }) {
  const dir = tmpdir();
  const tp = path.join(dir, 'token');
  fs.writeFileSync(tp, 'tok\n', { mode: 0o600 });
  const lines = [];
  const calls = [];
  const impl = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    const r = responder(call);
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  };
  const srv = createMcpServer({
    output: { write: (s) => { for (const l of String(s).split('\n')) if (l.trim()) lines.push(JSON.parse(l)); } },
    env,
    config: { port: 4242, tokenPath: tp, tmuxBin: 'tmux' },
    fetchImpl: impl,
    execFileImpl: () => { throw new Error('tmux non deve essere chiamato'); },
    errlog: () => {},
  });
  return { srv, lines, calls };
}

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

async function callTool(srv, outLines, name, args) {
  await srv.handleLine(rpc(1, 'tools/call', { name, arguments: args }));
  const r = outLines[outLines.length - 1];
  assert.equal(r.error, undefined, JSON.stringify(r));
  return JSON.parse(r.result.content[0].text);
}

const ENV = { NEXUSCREW_MCP_SESSION: 'cloud-Dev' };

test('i tre tool esistono con i nomi del contratto (B5: metodi distinti)', () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.includes('nc_lease_register'));
  assert.ok(names.includes('nc_lease_refresh'));
  assert.ok(names.includes('nc_lease_recovery'));
});

test('nc_lease_register: nessun argomento — la cella e la sessione del chiamante', async () => {
  const { srv, lines, calls } = makeSrv({
    env: ENV,
    responder: () => ({ status: 200, json: { status: 'registered', incarnationId: 'ab'.repeat(8), proof: { kind: 'child' } } }),
  });
  const out = await callTool(srv, lines, 'nc_lease_register', {});
  assert.equal(out.status, 'registered');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'http://127.0.0.1:4242/api/lease/register');
  assert.equal(calls[0].body.session, 'cloud-Dev');
});

test('nc_lease_refresh: proof in ingresso, proof nuova in uscita', async () => {
  const proof = { kind: 'child', cellId: 'Dev', incarnationId: 'ab'.repeat(8), jti: 'c'.repeat(16), issuedAt: 1, expiresAt: 61_000, proof: 'd'.repeat(64) };
  const { srv, lines, calls } = makeSrv({
    env: ENV,
    responder: () => ({ status: 200, json: { status: 'live', proof: { ...proof, jti: 'e'.repeat(16) } } }),
  });
  const out = await callTool(srv, lines, 'nc_lease_refresh', { proof });
  assert.equal(out.status, 'live');
  assert.equal(calls[0].url, 'http://127.0.0.1:4242/api/lease/refresh');
  assert.deepEqual(calls[0].body.proof, proof);
  assert.equal(calls[0].body.session, 'cloud-Dev');
});

test('nc_lease_recovery: proof anche scaduto; attempt bounded lato server', async () => {
  const proof = { kind: 'child', cellId: 'Dev', incarnationId: 'ab'.repeat(8), jti: 'c'.repeat(16), issuedAt: 1, expiresAt: 61_000, proof: 'd'.repeat(64) };
  const { srv, lines, calls } = makeSrv({
    env: ENV,
    responder: () => ({ status: 200, json: { status: 'live', incarnationId: 'ab'.repeat(8), proof: { ...proof, jti: 'f'.repeat(16) } } }),
  });
  const out = await callTool(srv, lines, 'nc_lease_recovery', { proof });
  assert.equal(out.status, 'live');
  assert.equal(calls[0].url, 'http://127.0.0.1:4242/api/lease/recovery');
});

test('identity gate: senza sessione i tre tool falliscono con il codice di identita', async () => {
  const { srv, lines } = makeSrv({
    env: {},
    responder: () => ({ status: 200, json: { status: 'registered' } }),
  });
  await srv.handleLine(rpc(1, 'tools/call', { name: 'nc_lease_register', arguments: {} }));
  const r = lines[lines.length - 1];
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_/);
});

test('lo status della route passa intatto al chiamante (pending/expired/non mentiti)', async () => {
  const { srv, lines } = makeSrv({
    env: ENV,
    responder: () => ({ status: 200, json: { status: 'pending', retryAfterMs: 20_000 } }),
  });
  const out = await callTool(srv, lines, 'nc_lease_register', {});
  assert.equal(out.status, 'pending');
  assert.equal(out.retryAfterMs, 20_000);
});
