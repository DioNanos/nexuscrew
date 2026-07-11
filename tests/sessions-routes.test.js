'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');

// tmux finto: registra le chiamate su file e simula duplicate/missing session.
const FAKE_TMUX = path.join(__dirname, 'fixtures', 'fake-tmux.sh');

function boot(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsl-'));
  process.env.FAKE_TMUX_LOG = path.join(dir, 'tmux.log');
  const { server, token, watcher } = createServer({
    tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'),
    tmuxBin: FAKE_TMUX, fleetEnabled: false, ...over,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, token, dir });
  }));
}
const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('create: 201 con preset shell, 400 nome/preset invalidi', async (t) => {
  const { base, token } = await boot(t);
  const home = os.homedir();
  const ok = await fetch(`${base}/api/sessions`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'w1', cwd: home, preset: 'shell' }) });
  assert.equal(ok.status, 201);
  assert.deepEqual(await ok.json(), { created: true, name: 'w1' });
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: '-bad', cwd: home }) })).status, 400);
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'cloud-Fake', cwd: home, preset: 'shell' }) })).status, 409, 'namespace cloud-* riservato anche in create');
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'w2', cwd: home, preset: 'rm -rf' }) })).status, 400);
});

test('kill: 409 su cloud-* ANCHE con fleet unavailable (F2), 200 su generica, 404 su assente', async (t) => {
  const { base, token } = await boot(t);
  assert.equal((await fetch(`${base}/api/sessions/cloud-Build`, { method: 'DELETE', headers: H(token) })).status, 409);
  assert.equal((await fetch(`${base}/api/sessions/w1`, { method: 'DELETE', headers: H(token) })).status, 200);
  assert.equal((await fetch(`${base}/api/sessions/ghost`, { method: 'DELETE', headers: H(token) })).status, 404);
});

test('READONLY is a destination floor for direct session create and kill', async (t) => {
  const { base, token } = await boot(t, { readonlyDefault: true });
  const create = await fetch(`${base}/api/sessions`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'blocked', cwd: os.homedir(), preset: 'shell' }) });
  assert.equal(create.status, 403);
  assert.equal((await fetch(`${base}/api/sessions/w1`, { method: 'DELETE', headers: H(token) })).status, 403);
});

test('destination READONLY also wins through the compatible /node path', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsl-node-ro-'));
  process.env.FAKE_TMUX_LOG = path.join(dir, 'tmux.log');
  const dest = createServer({ home: dir, tokenPath: path.join(dir, 'dest-token'), nodesPath: path.join(dir, 'dest-nodes.json'), filesRoot: path.join(dir, 'dest-files'), tmuxBin: FAKE_TMUX, fleetEnabled: false, readonlyDefault: true });
  await new Promise((resolve) => dest.server.listen(0, '127.0.0.1', resolve));
  const rootNodes = path.join(dir, 'root-nodes.json');
  let st = nodesStore.emptyStore('a'.repeat(32));
  st = nodesStore.addNode(st, { name: 'dest', ssh: 'dest', remotePort: dest.server.address().port, localPort: dest.server.address().port, direction: 'outbound', transport: 'ssh', autostart: false, visibility: 'network', nodeId: 'b'.repeat(32), token: dest.token, acceptToken: 'dest-back' });
  nodesStore.atomicWriteStore(rootNodes, st);
  const root = createServer({ home: dir, tokenPath: path.join(dir, 'root-token'), nodesPath: rootNodes, filesRoot: path.join(dir, 'root-files'), tmuxBin: FAKE_TMUX, fleetEnabled: false });
  await new Promise((resolve) => root.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { root.server.close(); dest.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${root.server.address().port}`;
  const headers = H(root.token);
  assert.equal((await fetch(`${base}/node/dest/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ name: 'blocked', cwd: os.homedir(), preset: 'shell' }) })).status, 403);
  assert.equal((await fetch(`${base}/node/dest/api/sessions/w1`, { method: 'DELETE', headers })).status, 403);
});
