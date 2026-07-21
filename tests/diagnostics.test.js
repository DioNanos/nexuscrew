'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { createDiagnostics } = require('../lib/diagnostics/store.js');
const { diagnosticsRoutes } = require('../lib/diagnostics/routes.js');
const { fleetRoutes } = require('../lib/fleet/routes.js');
const { createServer } = require('../lib/server.js');

const listen = (app) => new Promise((resolve) => {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

test('diagnostics: verbose opt-in, expiry e sequenza incrementale', () => {
  let clock = Date.parse('2026-07-21T08:00:00Z');
  const diagnostics = createDiagnostics({ now: () => clock });
  assert.equal(diagnostics.record('debug', 'fleet', 'DEBUG_DROP', 'not retained'), null);
  diagnostics.record('warn', 'fleet', 'FLEET_WARN', 'Warning retained');
  assert.equal(diagnostics.logs().records.length, 1);
  diagnostics.setVerbose(true, 300);
  diagnostics.record('debug', 'fleet', 'FLEET_DEBUG', 'Debug retained', { cell: 'Dev' });
  const incremental = diagnostics.logs({ after: 1, limit: 10 });
  assert.deepEqual(incremental.records.map((entry) => entry.code), ['VERBOSE_ENABLED', 'FLEET_DEBUG']);
  clock += 300_001;
  const status = diagnostics.status();
  assert.equal(status.verbose, false);
  assert.equal(diagnostics.logs().records.at(-1).code, 'VERBOSE_EXPIRED');
  assert.equal(diagnostics.record('info', 'server', 'AFTER_EXPIRY', 'dropped'), null);
});

test('diagnostics: redazione alla sorgente e meta allowlist', () => {
  const diagnostics = createDiagnostics();
  diagnostics.setVerbose(true, 300);
  diagnostics.record('error', 'fleet', 'CELL_SPAWN_FAILED',
    'Bearer SUPERSECRET /home/alice/private.txt OPENAI_API_KEY=value', {
      errno: 'EACCES', client: 'codex.js', cell: 'Dev',
      prompt: 'do not retain', argv: ['--secret'], token: 'SUPERSECRET', path: '/home/alice/private.txt',
    });
  const text = JSON.stringify(diagnostics.logs());
  for (const forbidden of ['SUPERSECRET', '/home/alice', 'do not retain', '--secret', 'OPENAI_API_KEY=value']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  const entry = diagnostics.logs().records.at(-1);
  assert.deepEqual(entry.meta, { errno: 'EACCES', client: 'codex.js', cell: 'Dev' });
  assert.deepEqual(Object.keys(entry), ['seq', 'ts', 'level', 'component', 'code', 'message', 'meta']);
});

test('diagnostics: ring buffer rispetta cap record/byte/entry e clear lascia solo evento reset', () => {
  const diagnostics = createDiagnostics({ maxRecords: 3, maxBytes: 900, maxEntryBytes: 360 });
  for (let i = 0; i < 10; i += 1) diagnostics.record('warn', 'test', 'BOUNDED_WARN', `event ${i}`, { count: i });
  const before = diagnostics.logs();
  assert.equal(before.records.length, 3);
  assert.ok(before.bytes <= 900);
  assert.ok(before.records[0].seq > 1);
  const cleared = diagnostics.clear();
  assert.equal(cleared.cleared, 3);
  assert.deepEqual(diagnostics.logs().records.map((entry) => entry.code), ['LOGS_CLEARED']);
});

test('diagnostics routes: auth wrapper compatible, validation e READONLY', async (t) => {
  const diagnostics = createDiagnostics();
  const app = express();
  app.use('/api/diagnostics', (req, res, next) => req.headers.authorization === 'Bearer local' ? next() : res.sendStatus(401));
  app.use('/api/diagnostics', diagnosticsRoutes({ diagnostics, readonly: () => false }));
  const server = await listen(app); t.after(() => close(server));
  const base = `http://127.0.0.1:${server.address().port}/api/diagnostics`;
  const headers = { authorization: 'Bearer local', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/status`)).status, 401);
  assert.equal((await fetch(`${base}/verbose`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: true, durationSeconds: 900 }) })).status, 200);
  assert.equal((await fetch(`${base}/verbose`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: true, durationSeconds: 301 }) })).status, 400);
  assert.equal((await fetch(`${base}/logs?after=0&limit=200`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/logs?raw=/home/user`, { headers })).status, 400);

  const ro = express();
  ro.use('/api/diagnostics', diagnosticsRoutes({ diagnostics, readonly: () => true }));
  const roServer = await listen(ro); t.after(() => close(roServer));
  const roBase = `http://127.0.0.1:${roServer.address().port}/api/diagnostics`;
  assert.equal((await fetch(`${roBase}/status`)).status, 200);
  assert.equal((await fetch(`${roBase}/verbose`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })).status, 403);
  assert.equal((await fetch(`${roBase}/logs`, { method: 'DELETE' })).status, 403);
});

test('createServer mounts authenticated diagnostics and records lifecycle only in verbose mode', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-diag-server-'));
  const diagnostics = createDiagnostics();
  diagnostics.setVerbose(true, 300);
  const instance = createServer({
    home: dir, tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'),
    fleetEnabled: false, diagnostics, autoUpdate: false,
  });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => instance.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${instance.server.address().port}/api/diagnostics`;
  assert.equal((await fetch(`${base}/status`)).status, 401);
  const headers = { authorization: `Bearer ${instance.token}` };
  assert.equal((await fetch(`${base}/status`, { headers })).status, 200);
  const logs = await (await fetch(`${base}/logs?after=0&limit=20`, { headers })).json();
  assert.equal(logs.records.some((entry) => entry.code === 'SERVER_STARTED'), true);
});

test('fleet diagnostics emits sanitized CELL_SPAWN_FAILED without raw error', async (t) => {
  const diagnostics = createDiagnostics();
  const fleet = {
    available: true,
    capabilities: () => ['up'],
    up: async () => { const error = new Error('client /home/alice/codex.js: nexuscrew cell spawn failed: EACCES codex.js Bearer SECRET'); error.status = 500; throw error; },
  };
  const app = express(); app.use('/api/fleet', fleetRoutes(Promise.resolve(fleet), { diagnostics }));
  const server = await listen(app); t.after(() => close(server));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/fleet/up`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cell: 'Dev' }),
  });
  assert.equal(response.status, 500);
  const records = diagnostics.logs().records;
  assert.equal(records.length, 1);
  assert.equal(records[0].code, 'CELL_SPAWN_FAILED');
  assert.deepEqual(records[0].meta, { action: 'up', cell: 'Dev', errno: 'EACCES', client: 'codex.js', status: 500 });
  assert.equal(JSON.stringify(records).includes('SECRET'), false);
  assert.equal(JSON.stringify(records).includes('/home/alice'), false);
});
