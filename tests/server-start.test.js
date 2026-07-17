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
    home: dir, tokenPath, nodesPath: path.join(dir, 'nodes.json'),
    filesRoot: path.join(dir, 'files'), port: 0,
    fleetEnabled: false, autoUpdate: false, log: (m) => lines.push(String(m)),
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

test('start(): porta occupata con peer collegati -> nessun fallback silenzioso', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-start-paired-port-'));
  const blocker = require('node:http').createServer((_req, res) => res.end('other'));
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupied = blocker.address().port;
  const configPath = path.join(dir, 'config.json'); const nodesPath = path.join(dir, 'nodes.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: occupied, wizardDone: true }) + '\n', { mode: 0o600 });
  let st = nodesStore.emptyStore('a'.repeat(32));
  st = nodesStore.addNode(st, {
    name: 'hub', ssh: 'user@hub', remotePort: 41820, localPort: 43001,
    direction: 'outbound', transport: 'auto', autostart: true,
    nodeId: 'b'.repeat(32), token: 'to-hub', acceptToken: 'from-hub',
  });
  nodesStore.atomicWriteStore(nodesPath, st);
  let candidate;
  const failure = new Promise((resolve) => {
    candidate = start({
      home: dir, configDir: dir, configPath, nodesPath, tokenPath: path.join(dir, 'token'),
      filesRoot: path.join(dir, 'files'), port: occupied, fleetEnabled: false, autoUpdate: false, log: () => {},
      onListenError: resolve,
    });
  });
  const error = await failure;
  t.after(() => { try { candidate.close(); } catch (_) {} blocker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(error.code, 'EADDRINUSE_PAIRED');
  assert.match(error.message, /refusing automatic port change/);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).port, occupied);
});

test('createServer: legacy roles.node/rendezvous non apre una seconda connessione SSH nascosta', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-start-node-'));
  const configDir = path.join(dir, '.nexuscrew');
  const nodesPath = path.join(configDir, 'nodes.json');
  let st = nodesStore.emptyStore();
  st = nodesStore.parseStore({ ...st, rendezvous: {
    ssh: 'user@rendezvous', publishedPort: 41821, localPort: 41820,
    keyPath: path.join(configDir, 'keys', 'rendezvous_ed25519'),
  } });
  nodesStore.atomicWriteStore(nodesPath, st);
  const calls = [];
  const made = createServer({
    home: dir, configDir, nodesPath, tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(dir, 'files'), fleetEnabled: false, roles: { client: false, node: true },
    tunnelLogFd: null,
    tunnelSpawnSyncImpl: () => ({ stderr: 'OpenSSH_9.6p1\n' }),
    tunnelSpawnImpl: (bin, args) => { calls.push([bin, args]); return { pid: 4193999, unref() {} }; },
  });
  assert.equal(calls.length, 0, 'mai avviare il tunnel prima del bind HTTP');
  await new Promise((resolve) => made.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { made.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(calls.length, 0, 'solo un hub outbound puo avviare SSH; il rendezvous legacy resta inerte');
});

test('createServer: outbound autostart usa SSH reale dopo listen; -R solo con Share', async (t) => {
  for (const shared of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nc-start-peer-${shared}-`));
    const configDir = path.join(dir, '.nexuscrew');
    const nodesPath = path.join(configDir, 'nodes.json');
    let st = nodesStore.emptyStore();
    st = nodesStore.addNode(st, {
      name: 'hub', ssh: 'user@hub', remotePort: 41777, localPort: 43001,
      direction: 'outbound', transport: 'auto', autostart: true,
      shared, reversePort: 44001, visibility: 'network',
      token: 'hub-scoped-token', acceptToken: 'local-scoped-token', nodeId: 'a'.repeat(32),
    });
    nodesStore.atomicWriteStore(nodesPath, st);
    const calls = [];
    const reconciled = [];
    const shareReconciled = [];
    const made = createServer({
      home: dir, configDir, nodesPath, tokenPath: path.join(configDir, 'token'),
      filesRoot: path.join(dir, 'files'), fleetEnabled: false, tunnelLogFd: null,
      tunnelSpawnSyncImpl: () => ({ stderr: 'OpenSSH_9.6p1\n' }),
      tunnelSpawnImpl: (bin, args) => { calls.push([bin, args]); return { pid: shared ? 4193998 : 4193997, unref() {} }; },
      reconcileTunnelSupervisorsImpl: (input) => { reconciled.push(input); return { kept: [], stopped: [], cleaned: [], failed: [] }; },
      reconcilePeerShareImpl: async (input) => { shareReconciled.push(input); return { shared: input.shared }; },
    });
    assert.equal(calls.length, 0);
    await new Promise((resolve) => made.server.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(reconciled.length, 1);
    assert.deepEqual(reconciled[0].configuredNames, ['hub']);
    assert.equal(reconciled[0].home, dir);
    assert.equal(calls[0][1][1], 'ssh', 'auto = OpenSSH sotto un solo supervisor');
    assert.ok(calls[0][1].includes('-L'));
    assert.equal(calls[0][1].includes('-R'), shared);
    assert.equal(shareReconciled.length, 1, 'paired peer republishes desired Share state after boot');
    assert.equal(shareReconciled[0].shared, shared);
    if (shared) assert.ok(calls[0][1].includes(`127.0.0.1:44001:127.0.0.1:${made.server.address().port}`));
    await new Promise((resolve) => made.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
