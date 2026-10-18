'use strict';
// tests/hub-held-reattach.test.js — regression for the hub-held reattach bug.
//
// When a browser client drops without a close frame (mobile network cut,
// killed tab), the hub keeps the FEDERATED upstream websocket attached and
// holds it for the grace window (lib/proxy/federation.js, hubMode branch of
// forwardUpgrade + createHubAttachStore). The bridge on the hosting node
// stays `attached` on that upstream. On reconnect the hub splices the new
// client socket onto the SAME upstream and forwards its frames raw, so the
// fresh `{type:'attach'}` frame every browser sends on open reached a bridge
// that was already attached and was rejected with close 1002
// "already attached" (lib/ws/bridge.js). The client then reconnected in a
// loop and the terminal stayed black.
//
// The upstream here is the REAL bridge (bindWs) with an in-memory PTY, and
// the clients replicate the browser sequence (attach frame on open, focus,
// binary output frames with a 4-byte big-endian seq).
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { bindWs, createPtyGraceStore } = require('../lib/ws/bridge.js');

const PEER_ID = 'b'.repeat(32);
const ATTACH_ID = `a2${'0'.repeat(30)}`; // 32 hex chars, stable per node+session
const PEER_TOKEN = 'PEER-TOKEN';
const SESSION = 'phone-cell';

async function bootHub(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca2-hub-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
    topologyCachePath: path.join(configDir, 'topology-cache.json'),
  };
  nodesStore.initStore(paths.nodesPath);
  const { server, token } = createServer({ protectSharedTmuxServer: false, ...paths, filesRoot: path.join(dir, 'files'), port: 0 });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { try { server.close(); } catch (_) { /* already closed */ } });
  return { nodesPath: paths.nodesPath, port: server.address().port, token };
}

function addPeer(nodesPath, upstreamPort) {
  let st = nodesStore.loadStoreStrict(nodesPath);
  st = nodesStore.addNode(st, {
    name: 'peer-a', ssh: 'user@peer-a', remotePort: upstreamPort, localPort: upstreamPort,
    nodeId: PEER_ID, direction: 'outbound', shared: true, visibility: 'network',
    token: PEER_TOKEN, peerOperatorAccess: true,
  });
  nodesStore.atomicWriteStore(nodesPath, st);
}

// The node that HOSTS the cell (a phone in the field): an HTTP server whose
// upgrade completes the websocket handshake and runs the REAL bridge with an
// in-memory PTY. Nothing here touches tmux, systemd or the network beyond
// 127.0.0.1.
async function bootPhoneNode(t) {
  const state = { connections: 0, sockets: [], ptys: 0, writes: [] };
  const output = new EventEmitter();
  const grace = createPtyGraceStore();
  const server = http.createServer((req, res) => { try { res.destroy(); } catch (_) { /* unused */ } });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.connections += 1;
      state.sockets.push(ws);
      ws.on('error', () => {});
      // Same rule as the real node: a valid Bearer on the upgrade (injected by
      // the hub proxy via cleanHeaders) preauthorizes the channel; the token
      // inside the attach frame is the hub's own and is not valid here.
      const preauth = String(req.headers.authorization || '') === `Bearer ${PEER_TOKEN}`;
      bindWs(ws, {
        openAttach: () => {
          state.ptys += 1;
          return {
            tty: null,
            write: (d) => state.writes.push(String(d)),
            resize: () => {},
            promote: () => {},
            demote: () => {},
            kill: () => {},
            onData: (cb) => output.on('data', cb),
            onExit: (cb) => output.on('exit', cb),
          };
        },
        verifyToken: () => preauth,
        isValidSession: (s) => s === SESSION,
        // A tmux binary that does not exist: the bridge's fire-and-forget
        // window-size call fails silently and no real tmux is ever touched.
        defaults: { tmuxBin: '/nonexistent/nexuscrew-a2-test-tmux' },
        ptyGrace: grace,
        capturePane: (s, bin, lines, cb) => cb(null, 'PANE-CONTENT'),
      });
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => {
    grace.close();
    for (const ws of state.sockets) { try { ws.terminate(); } catch (_) { /* gone */ } }
    try { wss.close(); } catch (_) { /* gone */ }
    try { server.close(); } catch (_) { /* gone */ }
  });
  return { port: server.address().port, state, emitOutput: (text) => output.emit('data', text) };
}

// A browser-like client over the hub route: same URL shape the installed
// bundle uses (token + attachId + attachSession in the query), attach frame
// on open (+reconnectToken when it has one), focus right after.
function browserClient(t, { port, token, attachId = ATTACH_ID }) {
  const url = `ws://127.0.0.1:${port}/api/route/peer-a/_/ws?token=${encodeURIComponent(token)}`
    + `&attachId=${attachId}&attachSession=${encodeURIComponent(SESSION)}`;
  const ws = new WebSocket(url);
  ws.on('error', () => {});
  const state = { messages: [], codes: [], opened: false };
  ws.on('open', () => { state.opened = true; });
  ws.on('message', (d, isBinary) => state.messages.push({ data: d, isBinary }));
  ws.on('close', (code) => state.codes.push(code));
  t.after(() => { try { ws.terminate(); } catch (_) { /* gone */ } });
  return { ws, state };
}

function browserAttach(ws, token, reconnectToken) {
  const msg = { type: 'attach', session: SESSION, token, cols: 80, rows: 24, readonly: false };
  if (reconnectToken) msg.reconnectToken = reconnectToken;
  ws.send(JSON.stringify(msg));
  ws.send(JSON.stringify({ type: 'focus', on: true }));
}

const jsonOf = (m) => { try { return JSON.parse(m.data.toString()); } catch (_) { return null; } };
// Binary output frames carry a 4-byte big-endian seq before the payload.
const outputTexts = (state) => state.messages.filter((m) => m.isBinary)
  .map((m) => m.data.subarray(4).toString());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(10); }
  return false;
};

test('hub-held reattach: same attachId reconnect reattaches on the held upstream and keeps streaming', async (t) => {
  const { nodesPath, port, token } = await bootHub(t);
  const phone = await bootPhoneNode(t);
  addPeer(nodesPath, phone.port);

  // 1) First attach, browser sequence: attach frame on a fresh open.
  const a = browserClient(t, { port, token });
  assert.ok(await waitFor(() => a.state.opened), 'first client opens');
  browserAttach(a.ws, token);
  assert.ok(
    await waitFor(() => a.state.messages.some((m) => { const j = jsonOf(m); return j && j.type === 'attached'; })),
    'first attach is acknowledged',
  );
  const ack = a.state.messages.map(jsonOf).find((j) => j && j.type === 'attached');
  const reconnectToken = ack && ack.reconnectToken;
  assert.ok(reconnectToken, 'a reconnectToken was issued with the first attach');
  assert.equal(phone.state.ptys, 1, 'exactly one pty opened on the hosting node');
  phone.emitOutput('FIRST-OUTPUT');
  assert.ok(await waitFor(() => outputTexts(a.state).includes('FIRST-OUTPUT')), 'live output reaches the first client');

  // 2) Client drop with no close frame (network cut / killed tab): the hub
  // must hold the upstream and the bridge must stay attached on it.
  a.ws.terminate();
  await wait(800);
  assert.equal(phone.state.connections, 1, 'still one upstream connection');
  assert.equal(phone.state.sockets[0].readyState, WebSocket.OPEN, 'the hub keeps the upstream websocket held');

  // Output produced while the client is away feeds the hub ring.
  phone.emitOutput('WHILE-AWAY');

  // 3) Reconnect with the SAME attachId and the reconnectToken (browser
  // backoff loop). This is the proven defect: the fresh attach frame lands
  // on the already-attached upstream.
  const b = browserClient(t, { port, token });
  assert.ok(await waitFor(() => b.state.opened), 'the returning client opens (101 from the held proxy)');
  browserAttach(b.ws, token, reconnectToken);
  assert.ok(
    await waitFor(() => b.state.messages.some((m) => { const j = jsonOf(m); return j && j.type === 'attached'; })),
    'the reconnect is acknowledged (attached) instead of rejected',
  );
  // Output emitted only after the reattach is established, like a real
  // terminal producing output on a live session.
  phone.emitOutput('AFTER-RECONNECT');
  assert.ok(
    await waitFor(() => outputTexts(b.state).includes('AFTER-RECONNECT')),
    'the returning client receives live frames again',
  );
  const errSeen = b.state.messages.map(jsonOf).some((j) => j && j.type === 'error');
  assert.equal(errSeen, false, 'no protocol error on reconnect');
  await wait(300);
  assert.deepEqual(b.state.codes, [], 'the reconnected client is not closed');
  assert.equal(phone.state.connections, 1, 'the held upstream is reused, not re-dialed');
  assert.equal(phone.state.ptys, 1, 'no second pty is opened on the hosting node');
  assert.equal(phone.state.sockets[0].readyState, WebSocket.OPEN, 'the upstream stays attached');
});

test('clean liveness close 4000 + reconnect: the session resumes and streaming continues', async (t) => {
  const { nodesPath, port, token } = await bootHub(t);
  const phone = await bootPhoneNode(t);
  addPeer(nodesPath, phone.port);

  const a = browserClient(t, { port, token });
  assert.ok(await waitFor(() => a.state.opened), 'first client opens');
  browserAttach(a.ws, token);
  assert.ok(
    await waitFor(() => a.state.messages.some((m) => { const j = jsonOf(m); return j && j.type === 'attached'; })),
    'first attach is acknowledged',
  );
  const ack = a.state.messages.map(jsonOf).find((j) => j && j.type === 'attached');
  const reconnectToken = ack && ack.reconnectToken;

  // Liveness close, as the installed bundle does after >10s of silence: a
  // CLEAN close. The close frame is forwarded, the upstream closes and the
  // pty enters the bridge grace. The return must resume, not break.
  a.ws.close(4000, 'liveness timeout');
  assert.ok(
    await waitFor(() => phone.state.sockets[0].readyState === WebSocket.CLOSED),
    'the upstream closes after the clean client close',
  );
  await wait(300); // let the hub drop the held record

  const b = browserClient(t, { port, token });
  assert.ok(await waitFor(() => b.state.opened), 'the returning client opens');
  browserAttach(b.ws, token, reconnectToken);
  assert.ok(
    await waitFor(() => b.state.messages.some((m) => { const j = jsonOf(m); return j && j.type === 'attached'; })),
    'the reconnect is acknowledged',
  );
  phone.emitOutput('AFTER-4000');
  assert.ok(
    await waitFor(() => outputTexts(b.state).includes('AFTER-4000')),
    'streaming continues after a liveness close and reconnect',
  );
  assert.equal(phone.state.ptys, 1, 'the suspended pty is resumed, not duplicated');
});

// ── bridge unit: the fix lives in the duplicate-attach handling ──

function fakeWs() {
  const ws = new EventEmitter();
  ws.sent = []; ws.bufferedAmount = 0; ws.closedCode = null;
  ws.send = (data) => ws.sent.push(data);
  ws.close = (code) => { ws.closedCode = code; };
  return ws;
}

function unitDeps(over = {}) {
  const handle = new EventEmitter();
  const state = { opens: 0, writes: [] };
  const pty = {
    write: (d) => state.writes.push(String(d)),
    resize: () => {},
    promote: () => {},
    demote: () => {},
    kill: () => {},
    onData: (cb) => handle.on('data', cb),
    onExit: (cb) => handle.on('exit', cb),
  };
  const openAttach = () => { state.opens += 1; return pty; };
  return {
    handle, pty, state,
    deps: {
      openAttach, verifyToken: () => true, isValidSession: () => true,
      capturePane: (s, b, l, cb) => cb(null, 'PANE'),
      ...over,
    },
  };
}

const sentJson = (ws) => ws.sent.map((s) => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);

test('bridge: duplicate attach with the SAME session is an idempotent re-ack, not close 1002', () => {
  const ws = fakeWs(); const u = unitDeps();
  bindWs(ws, u.deps);
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  const firstAck = sentJson(ws).find((m) => m.type === 'attached');
  assert.ok(firstAck, 'first attach acknowledged');
  u.handle.emit('data', 'BEFORE');
  assert.equal(ws.closedCode, null, 'no close after the first attach');

  // The hub-held reconnect: a second attach frame for the SAME session on
  // the SAME (still attached) websocket.
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', reconnectToken: firstAck.reconnectToken }), false);
  assert.equal(ws.closedCode, null, 'duplicate same-session attach does not close the channel');
  assert.equal(u.state.opens, 1, 'the duplicate attach opens no second pty');
  const acks = sentJson(ws).filter((m) => m.type === 'attached');
  assert.equal(acks.length, 2, 'the duplicate attach is re-acknowledged');
  assert.equal(acks[1].reconnectToken, firstAck.reconnectToken, 'the re-ack reuses the same capability, no new grant');
  assert.ok(sentJson(ws).some((m) => m.type === 'link' && m.state === 'live'), 'link stays live after the re-ack');
  u.handle.emit('data', 'AFTER');
  const frames = ws.sent.filter(Buffer.isBuffer).map((b) => b.subarray(4).toString());
  assert.deepEqual(frames, ['BEFORE', 'AFTER'], 'streaming continues across the duplicate attach');
  assert.equal(u.state.writes.length, 0, 'no attach side effect: the duplicate attach payload is ignored');
});

test('bridge: duplicate attach cannot downgrade readonly', () => {
  const ws = fakeWs(); const u = unitDeps();
  bindWs(ws, u.deps);
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', readonly: true }), false);
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', readonly: false }), false);
  assert.equal(ws.closedCode, null, 'the re-attach is accepted');
  ws.emit('message', Buffer.from('must-not-write'), true);
  assert.equal(u.state.writes.length, 0, 'a re-attach cannot enable writes on a read-only attach');
});

test('bridge: duplicate attach for a DIFFERENT session still closes 1002', () => {
  const ws = fakeWs(); const u = unitDeps();
  bindWs(ws, u.deps);
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'Y', token: 't' }), false);
  assert.strictEqual(ws.closedCode, 1002, 'a different session on the same channel is still a protocol violation');
});
