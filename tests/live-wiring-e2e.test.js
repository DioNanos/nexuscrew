'use strict';
// tests/live-wiring-e2e.test.js — il server vero, con la Live cablata.
//
// I moduli (registro, voce, attestazione) hanno test propri; qui si prova che
// siano davvero collegati: la directory del server mostra la Live, l'etichetta
// compare solo con un riferimento che il registro conferma, e il nome Live non
// consegna mai a nessuno.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { createServer } = require('../lib/server.js');
const nodes = require('../lib/nodes/store.js');
const { atomicWriteJson } = require('../lib/notify/persist.js');

const REF = 'ab'.repeat(16);
const MESSAGE = '12345678-1234-1234-1234-123456789abc';

function fakeDaemon(socketPath, statusRef) {
  const server = http.createServer((_q, res) => { res.writeHead(426); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.method === 'initialize') ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'f', codexHome: '/tmp' } }));
      else if (msg.method === 'thread/read') ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: msg.params.threadId, status: { type: statusRef.value } } } }));
    });
  }));
  return {
    listen: () => new Promise((r) => server.listen(socketPath, r)),
    close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); server.close(r); }),
  };
}

async function boot(t, threadStatus = 'idle') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'live-e2e-'));
  const configDir = path.join(home, 'cfg'); fs.mkdirSync(configDir, { recursive: true });
  const nodesPath = path.join(configDir, 'nodes.json'); nodes.initStore(nodesPath);
  const log = path.join(home, 'commands.jsonl'); fs.writeFileSync(log, '');
  const binary = path.join(home, 'tmux');
  fs.writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'); const a=process.argv.slice(2);
if(a[0]==='load-buffer'){ const p=a.at(-1); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(['payload',fs.readFileSync(p,'utf8')])+'\\n'); }
if(a[0]==='display-message'){ const ti=a.indexOf('-t'); const tgt=ti>=0?String(a[ti+1]):''; const memo=${JSON.stringify(log)}+'.session';
  if(a.at(-1)==='#{pane_id}'){ fs.writeFileSync(memo,tgt.replace(/^=/,'').replace(/:$/,'')); process.stdout.write('%7\\n'); }
  else process.stdout.write(fs.readFileSync(memo,'utf8')+'\\t0\\t%7\\n'); }
`, { mode: 0o700 });
  const socketPath = path.join(home, 'control.sock');
  const status = { value: threadStatus };
  const daemon = fakeDaemon(socketPath, status);
  await daemon.listen();
  const runtime = createServer({
    home, configDir, nodesPath, configPath: path.join(configDir, 'config.json'), tokenPath: path.join(configDir, 'token'),
    port: 0, tmuxBin: binary, fleetEnabled: false, sessionExistsSeam: () => true, filesRoot: path.join(home, 'files'),
    liveBridgeEnabled: true, liveBridgeSocketPath: socketPath, liveBridgeTimeoutMs: 1500, liveThreadStatusCacheMs: 0,
    settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { throw Error('disabled'); }, serviceInstallPath: path.join(home, 'service'), keygen: () => 'ssh-ed25519 AAAAFIXTURE demo', spawnImpl: () => ({ pid: 4100000, unref() {} }), sshVersion: () => ({ major: 9, minor: 6 }) },
  });
  const fleet = await runtime.fleetP;
  fleet.available = true;
  fleet.cellStatus = async () => ({ available: true, cells: [
    { cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'codex-vl.native', active: true, tmux: true, cwd: home },
    { cell: 'Dst', tmuxSession: 'cloud-Dst', engine: 'claude.native', active: true, tmux: true, cwd: home },
    { cell: 'Live', tmuxSession: 'cloud-Live', engine: 'claude.native', active: true, tmux: true, cwd: home },
  ] });
  atomicWriteJson(path.join(configDir, 'live-host.json'), { revision: 1, hostCell: 'Dev', updatedAt: 1 });
  atomicWriteJson(path.join(configDir, 'live-threads.json'), { version: 1, threads: { Dev: { threadId: 'thr-1', ref: REF, tmuxSession: 'cloud-Dev', startedAt: 1 } } });
  await new Promise((r) => runtime.server.listen(0, '127.0.0.1', r));
  t.after(async () => { runtime.server.closeAllConnections(); await new Promise((r) => runtime.server.close(r)); runtime.watcher.close(); await daemon.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${runtime.server.address().port}/api`;
  const H = (extra = {}) => ({ authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json', ...extra });
  const get = async (p) => (await fetch(base + p, { headers: H() })).json();
  const payloads = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((a) => a[0] === 'payload').map((a) => a[1]);
  const send = async ({ to = 'Dst', header } = {}) => {
    const id = (await get('/config')).instanceId;
    return fetch(`${base}/cells/send`, {
      method: 'POST', headers: H(header ? { 'x-nexuscrew-live-thread': header } : {}),
      body: JSON.stringify({
        id: MESSAGE,
        from: { instanceId: id, cell: 'Dev', tmuxSession: 'cloud-Dev' },
        to: { instanceId: id, cell: to, tmuxSession: `cloud-${to}` },
        message: 'ciao',
      }),
    });
  };
  return { get, send, payloads, status };
}

test('server vero: la directory mostra la Live quando il thread e\' vivo, e solo allora', async (t) => {
  const s = await boot(t, 'idle');
  const dir = await s.get('/cells');
  const live = dir.cells.filter((c) => c.kind === 'live');
  assert.equal(live.length, 1);
  assert.equal(live[0].id, `${dir.instanceId}:Live`);
  assert.equal(live[0].state, 'present');
  assert.equal(live[0].canReceive, false);
  assert.ok(!dir.cells.some((c) => c.cell === 'Live' && c.kind !== 'live'), 'la cella chiamata Live non e\' in directory');
  s.status.value = 'notLoaded';
  const after = await s.get('/cells');
  assert.equal(after.cells.filter((c) => c.kind === 'live').length, 0);
});

test('server vero: etichetta Live solo con riferimento confermato dal registro', async (t) => {
  const s = await boot(t, 'idle');
  const r1 = await s.send({ header: REF });
  assert.equal(r1.status, 200, await r1.clone().text());
  assert.equal((await s.send({})).status, 200);
  assert.equal((await s.send({ header: 'cd'.repeat(16) })).status, 200);
  const [withRef, plain, unknown] = s.payloads().map((p) => p.split('\n')[0]);
  assert.match(withRef, /from Live\(via Dev\)@/);
  assert.match(plain, /from Dev@/);
  assert.match(unknown, /from Dev@/);
  s.status.value = 'notLoaded';
  assert.equal((await s.send({ header: REF })).status, 200);
  assert.match(s.payloads().at(-1).split('\n')[0], /from Dev@/, 'thread non vivo: nessuna etichetta');
});

test('server vero: il nome Live non consegna a nessuno, nemmeno a una cella omonima ancora definita', async (t) => {
  const s = await boot(t, 'idle');
  const before = s.payloads().length;
  const res = await s.send({ to: 'Live' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /live-not-addressable/);
  assert.equal(s.payloads().length, before);
});
