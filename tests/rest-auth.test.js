'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { requireToken } = require('../lib/auth/middleware.js');

function listen(app) {
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
}

test('requireToken: 401 senza header, 401 token errato, 200 corretto', async (t) => {
  const app = express();
  app.use('/api', requireToken('sekret'), (_req, res) => res.json({ ok: true }));
  const srv = await listen(app);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;

  assert.equal((await fetch(`${base}/api/x`)).status, 401);
  assert.equal((await fetch(`${base}/api/x`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  const ok = await fetch(`${base}/api/x`, { headers: { authorization: 'Bearer sekret' } });
  assert.equal(ok.status, 200);
});

test('createServer: /api/* gated, static libero', async (t) => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { createServer } = require('../lib/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsrv-'));
  const { server, token, watcher } = createServer({
    tokenPath: path.join(dir, 'token'),
    filesRoot: path.join(dir, 'files'),
    fleetEnabled: false,
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); if (watcher) watcher.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/config`)).status, 401);
  assert.equal((await fetch(`${base}/api/files?session=x`)).status, 401);
  const ok2 = await fetch(`${base}/api/config`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok2.status, 200);
  const cfg = await ok2.json();
  assert.equal(cfg.bind, '127.0.0.1');
  assert.equal(typeof cfg.port, 'number');
  assert.ok(typeof cfg.version === 'string' && cfg.version.length > 0);
  assert.ok(cfg.uiVersion === null || typeof cfg.uiVersion === 'string');
});
