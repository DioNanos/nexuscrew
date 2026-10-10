'use strict';
// Shared fixtures for the host-only tests on the legacy paths: a REAL hub
// (createServer) with stub upstreams standing for a host-only peer ("box") and
// for a trusted peer ("other"), both recording what reaches them.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const store = require('../../lib/nodes/store.js');
const { createServer } = require('../../lib/server.js');

const ID = (c) => c.repeat(32);
const SELF = ID('f');
const BOX = ID('c');
const READER1 = ID('a');
const READER2 = ID('b');
const INTRUDER = ID('1');
const LIMITED = ID('4');
const ADMIN2 = ID('5');
const OTHER = ID('2');

function peer(name, nodeId, over = {}) {
  return {
    name, ssh: name, remotePort: 41820, localPort: 43000 + (parseInt(nodeId.slice(0, 2), 16) % 200), nodeId,
    token: `to-${name}`, acceptToken: `from-${name}`, direction: 'outbound',
    transport: 'auto', autostart: true, shared: true, visibility: 'network', peerOperatorAccess: true,
    roles: { client: true, node: false }, ...over,
  };
}
const BOX_PEER = (over = {}) => peer('box', BOX, {
  shared: false, ssh: 'private-link', peerOperatorAccess: false,
  cellVisibility: 'none', eventsAccess: true, nodeEventsAccess: true, filesReadAccess: true,
  askReplyAccess: false, panelAccess: false, liveHostAccess: false, accessConfigured: true,
  panelLocalPort: 43999, panelRemotePort: 41821, ...over,
});
// "Limited": panelAccess yes, files yes, cells all, operator no — the live profile.
const LIMITED_PEER = (over = {}) => peer('limited', LIMITED, {
  localPort: 43150, peerOperatorAccess: false, cellVisibility: 'all', panelAccess: true, filesReadAccess: true,
  eventsAccess: true, nodeEventsAccess: true, askReplyAccess: false, liveHostAccess: false, accessConfigured: true, ...over,
});

const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const closeServer = (s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(resolve); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildStore(dir, { boxPort, otherPort = 43120, audience = [READER1], hostOnly = true }) {
  const nodesPath = path.join(dir, '.nexuscrew', 'nodes.json');
  fs.mkdirSync(path.dirname(nodesPath), { recursive: true });
  // The stub peers listen on ephemeral ports, which can land on one of the fixed ports below: those are moved aside
  // (an exact collision made the fixture throw, and a throw used to leave the stubs listening).
  const taken = new Set([boxPort, otherPort]);
  const fixed = (p) => { let v = p; while (taken.has(v)) v += 11; taken.add(v); return v; };
  let st = store.emptyStore(SELF);
  st = store.addNode(st, peer('reader1', READER1, { localPort: fixed(43101) }));
  st = store.addNode(st, peer('reader2', READER2, { localPort: fixed(43102) }));
  st = store.addNode(st, peer('intruder', INTRUDER, { localPort: fixed(43103) }));
  st = store.addNode(st, LIMITED_PEER({ localPort: fixed(43150) }));
  st = store.addNode(st, peer('admin2', ADMIN2, { localPort: fixed(43160) }));
  st = store.setPeerAccessPreset(st, 'admin2', 'admin');
  st = store.addNode(st, peer('other', OTHER, { localPort: otherPort }));
  st = store.addNode(st, BOX_PEER({ localPort: boxPort, panelLocalPort: fixed(43999) }));
  store.atomicWriteStore(nodesPath, st);
  if (hostOnly) store.setPublishRemoteCas({ filePath: nodesPath, name: 'box', enabled: true, audience });
  return nodesPath;
}

// A REAL hub (createServer) with stub upstreams standing for "Box" (host-only)
// and for a trusted peer ("other"). Both record what reaches them.
async function realHub(t, { boxReply, otherReply, hostOnly = true, fetchImpl = null } = {}) {
  const boxCalls = []; const otherCalls = []; const boxUpgrades = [];
  const reply = (calls, custom) => (req, res) => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, cookie: req.headers.cookie || null });
    if (custom) return custom(req, res);
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  };
  const box = await listen(reply(boxCalls, boxReply));
  box.on('upgrade', (req, socket) => { boxUpgrades.push({ url: req.url, auth: req.headers.authorization || null }); socket.destroy(); });
  const other = await listen(reply(otherCalls, otherReply));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hostonly-legacy-'));
  let nodesPath;
  try { nodesPath = buildStore(dir, { boxPort: box.address().port, otherPort: other.address().port, hostOnly }); } catch (e) {
    await closeServer(box); await closeServer(other); fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const configDir = path.join(dir, '.nexuscrew');
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ roles: { client: true, node: false } }));
  const made = createServer({
    home: dir, configDir, nodesPath,
    configPath: path.join(configDir, 'config.json'), tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(dir, 'files'), fleetEnabled: false, port: 41840, panelPort: 0,
    fetchImpl: fetchImpl || (async () => { throw new Error('no network in this test'); }),
  });
  await new Promise((resolve, reject) => { made.server.once('error', reject); made.server.listen(0, '127.0.0.1', resolve); });
  made.cfg.port = made.server.address().port;
  t.after(async () => {
    await closeServer(made.server); if (made.panelServer && made.panelServer.listening) await closeServer(made.panelServer);
    if (made.watcher) made.watcher.close();
    await closeServer(box); await closeServer(other); fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${made.server.address().port}`;
  const st = store.loadStore(nodesPath);
  return { base, port: made.server.address().port, token: made.token, nodesPath, boxCalls, otherCalls, boxUpgrades, st, diagnostics: made.diagnostics, made, home: dir };
}

const status = async (url, headers = {}, init = {}) => (await fetch(url, { headers, redirect: 'manual', ...init }));
const wsAttempt = (url, headers = {}, ms = 1500) => new Promise((resolve) => {
  const ws = new WebSocket(url, { headers });
  const done = (v) => { try { ws.terminate(); } catch (_) { /* gone */ } resolve(v); };
  ws.on('open', () => done('open'));
  ws.on('unexpected-response', (_q, res) => done(`http-${res.statusCode}`));
  ws.on('error', () => done('error'));
  ws.on('close', () => done('closed'));
  setTimeout(() => done('timeout'), ms);
});

module.exports = {
  ID, SELF, BOX, READER1, READER2, INTRUDER, LIMITED, ADMIN2, OTHER,
  peer, BOX_PEER, LIMITED_PEER, listen, closeServer, sleep, buildStore, realHub, status, wsAttempt,
};
