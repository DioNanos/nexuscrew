'use strict';
// tests/host-only-legacy-gates.test.js — isolated gates for the host-only boundary on
// the legacy paths, one test per gate:
//   P1  no unauthenticated federated panel door for anything that can reach a
//       host-only peer: peer-bound (reverse) listeners, any Authorization header,
//       and a route that names a host-only peer at ANY hop;
//   P2  the head of an upgrade answer from a host-only peer is filtered (101 and
//       non-101), later frames are intact; protective headers are imposed after the
//       stripping; streams die on revocation, held attaches and detached upstreams
//       included, within a bounded time;
//   P3  the identity of a federated reader of a LOCAL handler is the verified hop
//       proof, never the header; invalid -> deny; warm cache and a revocation during
//       the fan-out wait cannot leak;
//   P4  audio and Live host look at the target actually resolved, with the store read
//       just before the I/O, and a designation recorded before the mode was turned
//       on is unusable.
// Tests marked GUARD pass before and after the fix: they pin trusted-peer behaviour.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const WebSocket = require('ws');
const store = require('../lib/nodes/store.js');
const fed = require('../lib/proxy/federation.js');
const { createDispatcher } = require('../lib/audio/dispatch.js');
const { createLiveHostFederation } = require('../lib/live-host/federation.js');
const {
  ID, BOX, READER1, READER2, INTRUDER, ADMIN2, OTHER, listen, closeServer, sleep, buildStore, realHub, status, wsAttempt,
} = require('./helpers/host-only-hub.js');

const admin2 = { authorization: 'Bearer from-admin2', 'x-nexuscrew-visited': ADMIN2, 'content-type': 'application/json' };
const reader1 = { authorization: 'Bearer from-reader1', 'x-nexuscrew-visited': READER1, 'content-type': 'application/json' };
const own = (h) => ({ authorization: `Bearer ${h.token}`, 'content-type': 'application/json' });
const post = (h, p, body, headers) => fetch(`${h.base}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
const mentionsBox = (text) => /\bbox\b|c{32}/.test(text);

// ------------------------------------------------------------------------- P1

async function openSlot(h) {
  const slot = await h.made.reverseSlotListeners.open({ nodeName: 'other', remotePort: 41999, generation: 1, instanceId: OTHER, secret: 'slot-secret' });
  return `http://127.0.0.1:${slot.localPort}`;
}

test('P1 (peer-bound listener): the unauthenticated panel door is closed on a reverse listener, with no header, a peer Bearer or a panel cookie; the owner\'s own listener keeps it (GUARD)', async (t) => {
  const h = await realHub(t);
  const slot = await openSlot(h);
  const panel = '/api/route/other/_/panel/c1/index.html';
  for (const [label, headers] of [['no header', {}], ['Bearer of the host-only peer', { authorization: 'Bearer from-box' }], ['Bearer of a trusted peer', { authorization: 'Bearer from-other' }], ['panel cookie', { cookie: 'npanel=anything' }]]) {
    const r = await status(`${slot}${panel}`, headers);
    assert.ok([401, 403].includes(r.status), `${label} on the peer-bound listener: ${r.status}`);
  }
  assert.equal(h.otherCalls.length, 0, 'nothing was forwarded to the trusted peer from the peer-bound listener');
  // GUARD: a frame in the owner's browser (no header, own listener) still opens the panel of a trusted peer.
  assert.equal((await status(`${h.base}${panel}`)).status, 200);
  assert.equal(h.otherCalls.length, 1);
});

test('P1 (peer-bound listener, WS): a panel cookie does not open an upgrade on a reverse listener', async (t) => {
  const h = await realHub(t);
  const hits = [];
  const upstream = await listen(() => {});
  upstream.on('upgrade', (req, socket) => { hits.push(req.url); socket.destroy(); });
  t.after(() => closeServer(upstream));
  store.atomicWriteStore(h.nodesPath, store.updateNode(store.loadStore(h.nodesPath), 'other', { localPort: upstream.address().port }));
  const slot = (await openSlot(h)).replace('http', 'ws');
  await wsAttempt(`${slot}/api/route/other/_/panel/c1/ws`, { cookie: 'npanel=x' });
  assert.equal(hits.length, 0, 'the upgrade must not reach the trusted peer from a peer-bound listener');
  await wsAttempt(`ws://127.0.0.1:${h.port}/api/route/other/_/panel/c1/ws`, { cookie: 'npanel=x' });
  assert.equal(hits.length, 1, 'GUARD: the same upgrade from the owner\'s own listener goes through');
});

test('P1 (route naming a host-only peer at a later hop): neither HTTP nor WS is forwarded without the owner token; any Authorization closes the door', async (t) => {
  const h = await realHub(t);
  const hits = [];
  const upstream = await listen(() => {});
  upstream.on('upgrade', (req, socket) => { hits.push(req.url); socket.destroy(); });
  t.after(() => closeServer(upstream));
  store.atomicWriteStore(h.nodesPath, store.updateNode(store.loadStore(h.nodesPath), 'other', { localPort: upstream.address().port }));
  const viaOther = await status(`${h.base}/api/route/other/box/_/panel/c1/index.html`);
  assert.ok([401, 403].includes(viaOther.status), `trusted first hop, host-only later: ${viaOther.status}`);
  const anyBearer = await status(`${h.base}/api/route/other/_/panel/c1/index.html`, { authorization: 'Bearer from-other' });
  assert.ok([401, 403].includes(anyBearer.status), `a peer Bearer is not the owner's: ${anyBearer.status}`);
  await wsAttempt(`ws://127.0.0.1:${h.port}/api/route/other/box/_/panel/c1/ws`, { cookie: 'npanel=x' });
  assert.equal(h.otherCalls.length, 0);
  assert.equal(hits.length, 0, 'no upgrade towards the first hop either');
});

// ------------------------------------------------------------------------- P2

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const frameText = (text) => Buffer.concat([Buffer.from([0x81, text.length]), Buffer.from(text)]);

// An upstream that answers the upgrade with a hostile head and then a frame in the SAME chunk.
async function hostileWsUpstream(t, { status101 = true } = {}) {
  const srv = net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(buf);
      const accept = crypto.createHash('sha1').update(`${key ? key[1] : ''}${GUID}`).digest('base64');
      const hostile = ['Set-Cookie: evil=1; Path=/', 'Clear-Site-Data: "storage"', "Content-Security-Policy: default-src *"];
      const head = status101
        ? ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, ...hostile]
        : ['HTTP/1.1 403 Forbidden', 'Content-Type: text/html', 'Content-Length: 4', ...hostile];
      sock.write(Buffer.concat([Buffer.from(`${head.join('\r\n')}\r\n\r\n`, 'latin1'), status101 ? frameText('first-frame') : Buffer.from('nope')]));
      if (!status101) sock.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.close(r); }));
  return srv.address().port;
}

async function viaUpgrade(t, { boxPort, headers = { authorization: 'Bearer from-reader1', 'x-nexuscrew-visited': READER1 }, pathname = '/federation/route/box/_/ws', hubAttaches = null } = {}) {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'nc-gates-'));
  const nodesPath = buildStore(dir, { boxPort, audience: [READER1] });
  const hub = await listen(() => {});
  const activeSockets = new Set();
  hub.on('upgrade', (req, socket, head) => {
    const ingress = fed.peerFromToken(nodesPath, (req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!ingress) return socket.destroy();
    fed.forwardUpgrade({ req, socket, head, nodesPath, localPort: 1, localCredential: () => 'hub-main', ingress, readonly: () => false, hopSecret: null, hubAttaches, activeSockets });
  });
  // Upgraded sockets are not closed by closeAllConnections(): a failing assertion must not leave the run hanging.
  t.after(async () => {
    for (const sk of activeSockets) { try { sk.destroy(); } catch (_) { /* gone */ } }
    await closeServer(hub); require('node:fs').rmSync(dir, { recursive: true, force: true });
  });
  return { nodesPath, url: `ws://127.0.0.1:${hub.address().port}${pathname}`, headers };
}

test('P2 (WS head): the 101 answer of a host-only peer loses cookies, Clear-Site-Data and CSP; the frame sent in the same chunk arrives intact', async (t) => {
  const boxPort = await hostileWsUpstream(t);
  const g = await viaUpgrade(t, { boxPort });
  const seen = await new Promise((resolve) => {
    const ws = new WebSocket(g.url, { headers: g.headers });
    const out = { headers: null, message: null };
    ws.on('upgrade', (res) => { out.headers = res.headers; });
    ws.on('message', (m) => { out.message = String(m); ws.terminate(); resolve(out); });
    ws.on('error', () => resolve(out));
    setTimeout(() => { try { ws.terminate(); } catch (_) { /* gone */ } resolve(out); }, 3000);
  });
  assert.ok(seen.headers, 'the upgrade was answered');
  assert.equal(seen.message, 'first-frame', 'the frame after the head is intact');
  assert.equal(seen.headers['set-cookie'], undefined);
  assert.equal(seen.headers['clear-site-data'], undefined);
  assert.equal(seen.headers['content-security-policy'], undefined);
  assert.equal(String(seen.headers.upgrade).toLowerCase(), 'websocket', 'the upgrade headers survive');
});

test('P2 (WS head, non-101): a refusal head from a host-only peer is filtered too', async (t) => {
  const boxPort = await hostileWsUpstream(t, { status101: false });
  const g = await viaUpgrade(t, { boxPort });
  const res = await new Promise((resolve) => {
    const ws = new WebSocket(g.url, { headers: g.headers });
    ws.on('unexpected-response', (_q, r) => resolve(r));
    ws.on('error', () => resolve(null));
    setTimeout(() => resolve(null), 3000);
  });
  assert.ok(res, 'the refusal reached the client');
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(res.headers['clear-site-data'], undefined);
  assert.equal(res.headers['content-security-policy'], undefined);
});

test('P2 (protective headers): they are imposed after the stripping, also when Connection names them', async (t) => {
  const h = await realHub(t, {
    boxReply: (req, res) => {
      res.writeHead(200, { connection: 'content-security-policy, x-content-type-options', 'content-security-policy': 'default-src *', 'x-content-type-options': 'sniff-please', 'content-type': 'text/html' });
      res.end('<b>x</b>');
    },
  });
  const r = await status(`${h.base}/api/route/box/_/sessions`, { authorization: `Bearer ${h.token}` });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy') || '', /\bsandbox\b/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

async function heldAttachFixture(t) {
  const upstream = { closes: 0, connections: 0 };
  const wss = new WebSocket.Server({ port: 0 });
  wss.on('connection', (ws) => { upstream.connections += 1; ws.on('close', () => { upstream.closes += 1; }); ws.on('error', () => {}); });
  await new Promise((r) => wss.once('listening', r));
  t.after(() => { for (const c of wss.clients) c.terminate(); wss.close(); });
  const hubAttaches = fed.createHubAttachStore({ graceMs: 60000, maxAttaches: 8, ringBytes: 4096 });
  const g = await viaUpgrade(t, { boxPort: wss.address().port, hubAttaches, pathname: `/federation/route/box/_/ws?attachId=${'a'.repeat(32)}&attachSession=work-build` });
  return { upstream, hubAttaches, g };
}

test('L1 (held attach): after the browser has gone, the detached upstream is closed on revocation and cannot be resumed', async (t) => {
  const { upstream, g } = await heldAttachFixture(t);
  const ws = new WebSocket(g.url, { headers: g.headers });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); setTimeout(() => reject(new Error('no open')), 3000); });
  await sleep(200);
  assert.equal(upstream.connections, 1);
  ws.terminate(); // the browser is gone: the upstream is held for the grace period
  await sleep(300);
  assert.equal(upstream.closes, 0, 'control: the held upstream is alive during the grace period');
  store.setPublishRemoteCas({ filePath: g.nodesPath, name: 'box', enabled: false });
  await sleep(2500);
  assert.equal(upstream.closes, 1, 'the detached upstream is still open after the revocation');
  const resumed = await wsAttempt(g.url, g.headers, 1500);
  assert.notEqual(resumed, 'open', 'the revoked reader cannot resume the held attach');
  assert.equal(upstream.connections, 1, 'and no new upstream was opened for it');
});

test('L1 (identity): a stream dies when the credential of the reader rotates, or the peer changes port, or the store is gone', async (t) => {
  for (const mutate of [
    (np) => store.atomicWriteStore(np, store.updateNode(store.loadStore(np), 'reader1', { acceptToken: 'rotated-credential' })),
    (np) => store.atomicWriteStore(np, store.removeNode(store.loadStore(np), 'reader1')),
    (np) => require('node:fs').writeFileSync(np, '{not json'),
  ]) {
    const { upstream, g } = await heldAttachFixture(t);
    const ws = new WebSocket(g.url, { headers: g.headers });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); setTimeout(() => reject(new Error('no open')), 3000); });
    await sleep(150);
    mutate(g.nodesPath);
    await sleep(2500);
    assert.equal(upstream.closes, 1, 'the upstream is still open after the authentication changed');
    try { ws.terminate(); } catch (_) { /* gone */ }
  }
});

// ------------------------------------------------------------------------- P3

test('P3 (verified origin): a hop header that does not verify is never the owner: the host-only peer stays hidden (and the bare owner call is unchanged)', async (t) => {
  const h = await realHub(t);
  const bare = await (await fetch(`${h.base}/api/topology`, { headers: own(h) })).text();
  assert.ok(mentionsBox(bare), 'control: the owner call without a hop header lists the peer');
  const forged = { ...own(h), 'x-nexuscrew-hop': 'f'.repeat(64), 'x-nexuscrew-visited': `${READER1},${ID('f')}` };
  for (const [url, pick] of [['/api/topology', (t) => t], ['/api/config', (t) => JSON.stringify(JSON.parse(t).nodePanelPorts)]]) {
    const text = await (await fetch(`${h.base}${url}`, { headers: forged })).text();
    assert.ok(!mentionsBox(pick(text)), `${url} with a forged hop header names the host-only peer`);
  }
  const garbage = { ...own(h), 'x-nexuscrew-hop': 'not-hex', 'x-nexuscrew-visited': 'zz' };
  assert.ok(!mentionsBox(await (await fetch(`${h.base}/api/topology`, { headers: garbage })).text()), 'a malformed hop header hides it too');
});

test('P3 (unknown peer in the chain): chainInAudience refuses an id the store does not know, an empty proof of audience, and a non-audience member', () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'nc-chain-'));
  try {
    const nodesPath = buildStore(dir, { boxPort: 43105, audience: [READER1, READER2] });
    const st = store.loadStore(nodesPath); const box = store.getNode(st, 'box');
    assert.equal(fed.chainInAudience(st, [READER1, st.nodeId], box), true);
    assert.equal(fed.chainInAudience(st, [READER2, READER1, st.nodeId], box), true, 'a chain made of audience members');
    assert.equal(fed.chainInAudience(st, [ID('9'), READER1, st.nodeId], box), false, 'an id this node does not know');
    assert.equal(fed.chainInAudience(st, [INTRUDER, READER1, st.nodeId], box), false, 'a known peer outside the audience');
    assert.equal(fed.chainInAudience(null, [READER1], box), false, 'no store');
    assert.equal(fed.chainInAudience(st, 'nope', box), false, 'no chain');
  } finally { require('node:fs').rmSync(dir, { recursive: true, force: true }); }
});

test('P3 (config): the list of host-only peers announced to the UI follows the same visibility', async (t) => {
  const h = await realHub(t);
  const names = async (headers, prefix) => (await (await fetch(`${h.base}${prefix}/config`, { headers })).json()).hostOnlyNodes;
  assert.deepEqual(await names(own(h), '/api'), ['box'], 'the owner is told');
  assert.deepEqual(await names(reader1, '/federation/route/_'), ['box'], 'GUARD: the audience member is told');
  assert.deepEqual(await names(admin2, '/federation/route/_'), [], 'the outsider is not');
});

test('P3 (unreadable store): the owner is never filtered; a federated reader is denied everything', () => {
  const gone = '/nonexistent/nodes.json';
  const owner = fed.hostOnlyVisibility(gone, { headers: {} }, () => Buffer.from('s'));
  assert.equal(owner.unreadable, false);
  assert.equal(owner.hiddenNames.size + owner.hiddenIds.size, 0);
  const federated = fed.hostOnlyVisibility(gone, { headers: { 'x-nexuscrew-hop': 'f'.repeat(64) } }, () => Buffer.from('s'));
  assert.equal(federated.unreadable, true, 'a header that cannot be verified against a readable store denies');
});

test('P3 (warm cache): the owner warms the topology cache with the peer in it; the outsider still does not see it, nor a stale copy', async (t) => {
  const h = await realHub(t);
  for (let i = 0; i < 2; i += 1) { // twice: the second answer can be served from the cache
    const warm = await (await fetch(`${h.base}/api/topology`, { headers: own(h) })).text();
    assert.ok(mentionsBox(warm), 'control: the owner view carries the peer');
  }
  const out = await (await fetch(`${h.base}/federation/route/_/topology`, { headers: admin2 })).text();
  assert.ok(!mentionsBox(out), `the outsider gets the peer from a warm cache: ${out.slice(0, 120)}`);
  const aud = await (await fetch(`${h.base}/federation/route/_/topology`, { headers: reader1 })).text();
  assert.ok(mentionsBox(aud), 'GUARD: the audience member still gets it');
});

test('P3 (revocation during the wait): the audience is revoked while the topology fan-out is waiting; the answer is decided after the wait', async (t) => {
  const slowTopology = (req, res) => {
    if (/\/federation\/topology/.test(req.url)) {
      return setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ instanceId: OTHER, nodes: [] })); }, 900);
    }
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  };
  const h = await realHub(t, { otherReply: slowTopology });
  const pending = fetch(`${h.base}/federation/route/_/topology`, { headers: reader1 }).then((r) => r.text());
  await sleep(250);
  // the audience changes to somebody else (off, then on for another reader)
  store.setPublishRemoteCas({ filePath: h.nodesPath, name: 'box', enabled: false });
  store.setPublishRemoteCas({ filePath: h.nodesPath, name: 'box', enabled: true, audience: [READER2] });
  const text = await pending;
  assert.ok(!mentionsBox(text), `the answer still carries the peer after the revocation: ${text.slice(0, 120)}`);
});

// ------------------------------------------------------------------------- P4

test('P4 (state read just before the I/O): the same federated speak is refused while the peer is host-only and goes through while it is not', async (t) => {
  const h = await realHub(t);
  const speak = () => post(h, '/federation/route/_/audio/speak', { target: BOX, text: 'hello', originCell: 'c1' }, admin2);
  await speak();
  assert.equal(h.boxCalls.length, 0, 'host-only: refused');
  store.setPublishRemoteCas({ filePath: h.nodesPath, name: 'box', enabled: false });
  await speak();
  const whileOff = h.boxCalls.length;
  assert.equal(whileOff, 1, 'control (legacy behaviour, general fix is 0.9.68): not host-only, the re-dispatch still happens');
  store.setPublishRemoteCas({ filePath: h.nodesPath, name: 'box', enabled: true, audience: [READER1] });
  await speak();
  assert.equal(h.boxCalls.length, whileOff, 'host-only again: refused again (the store is read at the I/O)');
});

test('P4 (target actually resolved): the dispatcher refuses a federated request whose resolved route passes through a host-only peer at any hop, before any I/O', async () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'nc-disp-'));
  try {
    const nodesPath = buildStore(dir, { boxPort: 43105, audience: [READER1] });
    const target = ID('9');
    let fetched = 0;
    const dispatcher = createDispatcher({
      localNodeId: () => ID('f'),
      peers: async () => [{ nodeId: target, name: 'far', route: ['other', 'box'] }],
      localPort: () => 1234, localToken: () => 't',
      fetchImpl: async () => { fetched += 1; return { status: 200, json: async () => ({ status: 'spoken' }) }; },
      federatedGuard: ({ target: tgt, route }) => fed.touchesHostOnly(nodesPath, { target: tgt, route }),
    });
    const out = await dispatcher.dispatch({ resource: '/audio/speak', target, origin: { node: READER1, cell: 'c' }, payload: {}, federated: true });
    assert.equal(out.status, 'refused');
    assert.equal(fetched, 0, 'no request left');
    const local = await dispatcher.dispatch({ resource: '/audio/speak', target, origin: { node: ID('f'), cell: 'c' }, payload: {}, federated: false });
    assert.equal(local.status, 'spoken', 'GUARD: a local caller (owner authority) is not subject to the guard');
    assert.equal(fetched, 1);
    // by instance id
    const byId = createDispatcher({
      localNodeId: () => ID('f'), peers: async () => [{ nodeId: BOX, name: 'x', route: ['far-name'] }],
      localPort: () => 1234, localToken: () => 't', fetchImpl: async () => { fetched += 1; return { status: 200, json: async () => ({ status: 'spoken' }) }; },
      federatedGuard: ({ target: tgt, route }) => fed.touchesHostOnly(nodesPath, { target: tgt, route }),
    });
    assert.equal((await byId.dispatch({ resource: '/audio/speak', target: BOX, origin: { node: READER1 }, payload: {}, federated: true })).status, 'refused', 'the instance id of the host-only peer is enough');
  } finally { require('node:fs').rmSync(dir, { recursive: true, force: true }); }
});

test('P4 (live host, multi-hop owner): the Live-host federation refuses an owner whose route passes through a host-only peer, before any I/O', async () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'nc-lh-'));
  try {
    const nodesPath = buildStore(dir, { boxPort: 43105, audience: [READER1] });
    const owner = ID('9'); let fetched = 0;
    const lh = createLiveHostFederation({
      localNodeId: () => ID('f'), peers: async () => [{ nodeId: owner, name: 'far', route: ['other', 'box'] }],
      localPort: () => 1234, localToken: () => 't', fetchImpl: async () => { fetched += 1; return { status: 200, json: async () => ({}) }; },
      ownerGuard: ({ target, route }) => fed.touchesHostOnly(nodesPath, { target, route }),
    });
    const state = await lh.getOwnerState({ ownerId: owner });
    assert.equal(state.ok, false);
    const bridge = await lh.bridgeForward({ ownerId: owner, expect: { hostCell: 'c1', revision: 1 } });
    assert.equal(bridge.ok, false);
    assert.equal(fetched, 0, 'no request left');
  } finally { require('node:fs').rmSync(dir, { recursive: true, force: true }); }
});

const DESIGNATE = (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(/live-host\/designate/.test(req.url) ? JSON.stringify({ hostCell: 'c1', revision: 1 }) : '{"ok":true}');
};

test('P4 (stale designation): a designation recorded BEFORE the mode was turned on is unusable and invisible to an outsider', async (t) => {
  const h = await realHub(t, { boxReply: DESIGNATE, hostOnly: false });
  const designated = await post(h, '/api/route/box/_/live-host/designate', { cell: 'c1' }, own(h));
  assert.equal(designated.status, 200, 'control: designating a plain private peer is allowed');
  assert.equal(h.boxCalls.length, 1);
  store.setPublishRemoteCas({ filePath: h.nodesPath, name: 'box', enabled: true, audience: [READER1] });
  const before = h.boxCalls.length;
  const view = await (await fetch(`${h.base}/federation/route/_/live-host`, { headers: admin2 })).text();
  await post(h, '/federation/route/_/live-host/bridge', { expect: { hostCell: 'c1', revision: 1 } }, admin2);
  assert.equal(h.boxCalls.length, before, 'queries sent to the host-only peer for an outsider');
  assert.ok(!mentionsBox(view), `the outsider sees the designation: ${view.slice(0, 140)}`);
  const ownerView = await (await fetch(`${h.base}/api/live-host`, { headers: own(h) })).json();
  assert.equal(ownerView.hostCell, 'c1', 'GUARD: the owner still sees what is recorded');
  assert.equal(h.boxCalls.length, before, 'and even the owner\'s read does not query the host-only peer');
});
