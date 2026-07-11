'use strict';
// F1 (audit run multi-fase, BLOCKER verifier A2): lo startup di start() NON deve
// stampare il token — l'output finisce nei log del servizio (journalctl/logfile)
// che il service manager espone. L'apertura autenticata usa `nexuscrew show`.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');

test('start(): il token non compare nell\'output di startup', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-start-'));
  const tokenPath = path.join(dir, 'token');
  const lines = [];
  // port: 0 = effimera (loadConfig: opts vincono su config.json/env)
  const server = start({
    tokenPath, filesRoot: path.join(dir, 'files'), port: 0,
    fleetEnabled: false, log: (m) => lines.push(String(m)),
  });
  await new Promise((res) => server.on('listening', res));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  assert.ok(token.length >= 16, 'token generato');
  assert.ok(lines.length >= 2, 'startup logga le sue righe');
  const out = lines.join('\n');
  assert.ok(!out.includes(token), 'il token NON deve comparire nello startup log');
  assert.ok(out.includes('nexuscrew show'), 'lo startup rimanda a `nexuscrew show`');
});

test('start(): porta occupata al boot -> bind alternativo e persistenza atomica', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-start-port-'));
  const blocker = require('node:http').createServer((_req, res) => res.end('other'));
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupied = blocker.address().port;
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: occupied, wizardDone: true }) + '\n', { mode: 0o600 });
  const server = start({
    home: dir, configDir: dir, configPath, tokenPath: path.join(dir, 'token'),
    filesRoot: path.join(dir, 'files'), port: occupied, fleetEnabled: false, log: () => {},
  });
  await new Promise((resolve) => server.on('listening', resolve));
  t.after(() => {
    server.close(); blocker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const selected = server.address().port;
  assert.notEqual(selected, occupied);
  assert.ok(selected > occupied && selected <= occupied + 200, 'sceglie deterministicamente la prima porta successiva disponibile');
  const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(persisted.port, selected);
  assert.equal(persisted.wizardDone, true);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('createServer: roles.node autostarta il reverse supervisor al reboot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-start-node-'));
  const configDir = path.join(dir, '.nexuscrew');
  const nodesPath = path.join(configDir, 'nodes.json');
  let st = nodesStore.emptyStore();
  st = nodesStore.setRendezvous(st, {
    ssh: 'user@rendezvous', publishedPort: 41821, localPort: 41820,
    keyPath: path.join(configDir, 'keys', 'rendezvous_ed25519'),
  });
  nodesStore.atomicWriteStore(nodesPath, st);
  const calls = [];
  const made = createServer({
    home: dir, configDir, nodesPath, tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(dir, 'files'), fleetEnabled: false, roles: { client: false, node: true },
    tunnelLogFd: null,
    tunnelSpawnSyncImpl: () => ({ stderr: 'OpenSSH_9.6p1\n' }),
    tunnelSpawnImpl: (bin, args) => { calls.push([bin, args]); return { pid: 4193999, unref() {} }; },
  });
  try {
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], process.execPath);
    assert.ok(calls[0][1][0].endsWith('tunnel-supervisor.js'));
    assert.ok(calls[0][1].includes('-R'));
    assert.ok(calls[0][1].includes('127.0.0.1:41821:127.0.0.1:41820'));
  } finally {
    made.watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
