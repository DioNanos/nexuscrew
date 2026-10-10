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
const { hostOnlyHeadFilter } = require('../lib/proxy/node-proxy.js');
const decksStore = require('../lib/decks/store.js');
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
async function hostileWsUpstream(t, { status101 = true, mode = null } = {}) {
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

// An upstream that speaks a raw head of our choosing (bytes), for the parser-differential cases.
async function rawHeadUpstream(t, makeHead) {
  const srv = net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(buf);
      const accept = crypto.createHash('sha1').update(`${key ? key[1] : ''}${GUID}`).digest('base64');
      sock.write(Buffer.concat([Buffer.from(makeHead(accept), 'latin1'), frameText('first-frame')]));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.close(r); }));
  return srv.address().port;
}

async function viaUpgrade(t, { boxPort, headers = { authorization: 'Bearer from-reader1', 'x-nexuscrew-visited': READER1 }, pathname = '/federation/route/box/_/ws', hubAttaches = null, hostOnly = true, prepare = null } = {}) {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'nc-gates-'));
  const nodesPath = buildStore(dir, { boxPort, audience: [READER1], hostOnly });
  if (prepare) prepare(nodesPath);
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

test('P2 (WS head, non-101): a refusal head from a host-only peer is NOT passed along: the client gets our answer, never the peer\'s headers', async (t) => {
  const boxPort = await hostileWsUpstream(t, { status101: false });
  const g = await viaUpgrade(t, { boxPort });
  const outcome = await new Promise((resolve) => {
    const ws = new WebSocket(g.url, { headers: g.headers });
    const done = (o) => { try { ws.terminate(); } catch (_) { /* gone */ } resolve(o); };
    ws.on('unexpected-response', (_q, r) => done({ kind: 'http', headers: r.headers, status: r.statusCode }));
    ws.on('message', (m) => done({ kind: 'message', message: String(m) }));
    ws.on('error', () => done({ kind: 'error' }));
    ws.on('close', () => done({ kind: 'closed' }));
    setTimeout(() => done({ kind: 'timeout' }), 3000);
  });
  assert.notEqual(outcome.message, 'first-frame', 'the frame of the refused peer reached the client');
  if (outcome.kind === 'http') {
    assert.equal(outcome.headers['set-cookie'], undefined);
    assert.equal(outcome.headers['clear-site-data'], undefined);
    assert.equal(outcome.headers['content-security-policy'], undefined);
    assert.notEqual(outcome.status, 403, 'the peer\'s own refusal must not reach the client as it is');
  }
});

const clientSees = (url, headers) => new Promise((resolve) => {
  const ws = new WebSocket(url, { headers });
  const out = { headers: null, message: null, status: null, kind: 'pending' };
  ws.on('upgrade', (res) => { out.headers = res.headers; });
  ws.on('message', (m) => { out.message = String(m); out.kind = 'message'; ws.terminate(); resolve(out); });
  ws.on('unexpected-response', (_q, r) => { out.status = r.statusCode; out.headers = r.headers; out.kind = 'http'; resolve(out); });
  ws.on('error', () => { out.kind = 'error'; resolve(out); });
  setTimeout(() => { try { ws.terminate(); } catch (_) { /* gone */ } resolve(out); }, 3000);
});

test('M2 (interim head): a 100 Continue followed by a 101 carrying cookies is refused on the federated route and on /node', async (t) => {
  const port = await rawHeadUpstream(t, (accept) => `HTTP/1.1 100 Continue\r\nX-A: 1\r\n\r\nHTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: evil=1; Path=/\r\nClear-Site-Data: "storage"\r\n\r\n`);
  const g = await viaUpgrade(t, { boxPort: port });
  const fed1 = await clientSees(g.url, g.headers);
  assert.notEqual(fed1.message, 'first-frame', 'the interim answer let a second head through on the federated route');
  assert.equal(fed1.headers && fed1.headers['set-cookie'], undefined);
  const h = await realHub(t);
  store.atomicWriteStore(h.nodesPath, store.updateNode(store.loadStore(h.nodesPath), 'box', { localPort: port }));
  const legacy = await clientSees(`ws://127.0.0.1:${h.port}/node/box/ws`, { authorization: `Bearer ${h.token}` });
  assert.notEqual(legacy.message, 'first-frame', 'the interim answer let a second head through on /node');
  assert.equal(legacy.headers && legacy.headers['set-cookie'], undefined);
});

test('P2 (parser differential): the head is read as the most lenient consumer would read it (bare LF, folded lines, odd names, bare CR, NUL)', async (t) => {
  const heads = {
    'bare LF line endings': (a) => `HTTP/1.1 101 Switching Protocols\nUpgrade: websocket\nConnection: Upgrade\nSec-WebSocket-Accept: ${a}\nSet-Cookie: evil=1; Path=/\nClear-Site-Data: "storage"\n\n`,
    'mixed endings': (a) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${a}\nset-cookie: evil=1\r\n\r\n`,
    'folded continuation of a dropped header': (a) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${a}\r\nSet-Cookie: a=b;\r\n\tevil=1; Path=/\r\n\r\n`,
    'space before the colon': (a) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${a}\r\nSet-Cookie : evil=1\r\nCLEAR-SITE-DATA\t: "*"\r\n\r\n`,
  };
  for (const [label, make] of Object.entries(heads)) {
    const port = await rawHeadUpstream(t, make);
    const g = await viaUpgrade(t, { boxPort: port });
    const seen = await clientSees(g.url, g.headers);
    assert.equal(seen.kind, 'message', `${label}: the upgrade must still work (${seen.kind})`);
    assert.equal(seen.message, 'first-frame', label);
    assert.equal(seen.headers['set-cookie'], undefined, `${label}: Set-Cookie reached the client`);
    assert.equal(seen.headers['clear-site-data'], undefined, `${label}: Clear-Site-Data reached the client`);
    assert.equal(seen.headers.evil, undefined, label);
  }
  // heads that must be REFUSED, not passed: bare CR, NUL, no colon, bad name, no status line
  const filterRun = (chunks) => new Promise((resolve) => {
    const f = hostOnlyHeadFilter(); const out = [];
    f.on('data', (c) => out.push(c)); f.on('error', (e) => resolve({ error: e.message })); f.on('end', () => resolve({ out: Buffer.concat(out) }));
    for (const c of chunks) f.write(c); f.end();
  });
  const bad = {
    'bare CR': 'HTTP/1.1 101 X\r\nUpgrade: websocket\rSet-Cookie: a=b\r\n\r\n',
    'NUL': 'HTTP/1.1 101 X\r\nUpgrade: websocket\r\nX: a\0b\r\n\r\n',
    'no colon': 'HTTP/1.1 101 X\r\nUpgrade websocket\r\n\r\n',
    'bad header name': 'HTTP/1.1 101 X\r\nUp grade: websocket\r\n\r\n',
    'no status line': 'Upgrade: websocket\r\n\r\n',
    'not a 101': 'HTTP/1.1 200 OK\r\nX: 1\r\n\r\n',
    'interim 100': 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 101 X\r\n\r\n',
    'continuation before any header': 'HTTP/1.1 101 X\r\n  stray\r\n\r\n',
  };
  for (const [label, head] of Object.entries(bad)) assert.ok((await filterRun([Buffer.from(head, 'latin1')])).error, `${label} must be refused`);
  assert.ok((await filterRun([Buffer.alloc(20000, 0x41)])).error, 'a head over 16 KB is refused');
  // chunking: the terminator split across chunks, binary after the head untouched
  const good = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSet-Cookie: a=b\r\n\r\n', 'latin1');
  const tail = Buffer.from([0x81, 0x05, 0x00, 0xff, 0x7f, 0x80, 0x0d, 0x0a, 0x0d, 0x0a]);
  const whole = Buffer.concat([good, tail]);
  for (let cut = 1; cut < good.length + 3; cut += 7) {
    const r = await filterRun([whole.subarray(0, cut), whole.subarray(cut)]);
    assert.ok(r.out, `cut ${cut}: ${r.error}`);
    assert.ok(r.out.subarray(r.out.length - tail.length).equals(tail), `cut ${cut}: the bytes after the head changed`);
    assert.ok(!r.out.toString('latin1').toLowerCase().includes('set-cookie'), `cut ${cut}: cookie kept`);
  }
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

test('L1 (originating publication): a stream dies when anything of the authorization it was opened under changes', async (t) => {
  const off = (np) => store.setPublishRemoteCas({ filePath: np, name: 'box', enabled: false });
  const on = (np, audience) => store.setPublishRemoteCas({ filePath: np, name: 'box', enabled: true, audience });
  const cases = [
    ['credential of the peer rotated', (np) => store.atomicWriteStore(np, store.updateNode(store.loadStore(np), 'box', { token: 'rotated-peer-credential' }))],
    ['mode off, then plain sharing turned on before the next check', (np) => { off(np); store.atomicWriteStore(np, store.updateNode(store.loadStore(np), 'box', { shared: true })); }],
    ['mode off, then on again with the same audience (another generation)', (np) => { off(np); on(np, [READER1]); }],
    ['mode off, then on for a different audience', (np) => { off(np); on(np, [READER2]); }],
    ['another opt-in whose backup name sorts BEFORE the previous one (same second)', (np) => require('node:fs').writeFileSync(`${np}.pre-publish-remote-20000101T000000Z-00000000.bak`, '{}', { mode: 0o600 })],
    ['mode off', (np) => off(np)],
    ['peer moved to another port', (np) => { const st = store.loadStore(np); const used = new Set(st.nodes.flatMap((n) => [n.localPort, n.panelLocalPort])); let port = 43998; while (used.has(port)) port -= 1; store.atomicWriteStore(np, store.updateNode(st, 'box', { localPort: port })); }],
  ];
  for (const [label, mutate] of cases) {
    const { upstream, g } = await heldAttachFixture(t);
    const ws = new WebSocket(g.url, { headers: g.headers });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); setTimeout(() => reject(new Error('no open')), 3000); });
    await sleep(200);
    assert.equal(upstream.connections, 1, label);
    mutate(g.nodesPath);
    await sleep(2500);
    assert.equal(upstream.closes, 1, `the stream is still open after: ${label}`);
    try { ws.terminate(); } catch (_) { /* gone */ }
  }
});

test('L1 (originating publication) GUARD: an unrelated change in the store does not close the stream', async (t) => {
  const { upstream, g } = await heldAttachFixture(t);
  const ws = new WebSocket(g.url, { headers: g.headers });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); setTimeout(() => reject(new Error('no open')), 3000); });
  await sleep(200);
  store.atomicWriteStore(g.nodesPath, store.updateNode(store.loadStore(g.nodesPath), 'intruder', { label: 'renamed' }));
  await sleep(2500);
  assert.equal(upstream.closes, 0, 'a change that does not touch the authorization must not cut the stream');
  assert.equal(ws.readyState, WebSocket.OPEN);
  try { ws.terminate(); } catch (_) { /* gone */ }
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

test('P3 (protocol topology): the reader is judged again after the fan-out wait: a grant revoked meanwhile removes the host-only leaf', async (t) => {
  const slowTopology = (req, res) => {
    if (/\/federation\/topology/.test(req.url)) {
      return setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ instanceId: OTHER, nodes: [] })); }, 900);
    }
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  };
  const h = await realHub(t, { otherReply: slowTopology, fetchImpl: fetch });
  const ask = () => fetch(`${h.base}/federation/topology`, { headers: reader1 }).then((r) => r.text());
  assert.ok(mentionsBox(await ask()), 'control: the audience member gets the leaf');
  const pending = ask();
  await sleep(250);
  store.atomicWriteStore(h.nodesPath, store.updateNode(store.loadStore(h.nodesPath), 'reader1', { peerOperatorAccess: false }));
  const text = await pending;
  assert.ok(!mentionsBox(text), `the leaf is still served after the operator grant was revoked: ${text.slice(0, 140)}`);
});

test('P3 (protocol topology): an audience change during the wait also removes the leaf; an unrelated change does not (GUARD)', async (t) => {
  const slowTopology = (req, res) => {
    if (/\/federation\/topology/.test(req.url)) {
      return setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ instanceId: OTHER, nodes: [] })); }, 900);
    }
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  };
  const h = await realHub(t, { otherReply: slowTopology, fetchImpl: fetch });
  const ask = () => fetch(`${h.base}/federation/topology`, { headers: reader1 }).then((r) => r.text());
  let pending = ask();
  await sleep(250);
  store.atomicWriteStore(h.nodesPath, store.updateNode(store.loadStore(h.nodesPath), 'intruder', { label: 'renamed' }));
  assert.ok(mentionsBox(await pending), 'GUARD: an unrelated change keeps the leaf');
  pending = ask();
  await sleep(250);
  store.setPublishRemoteCas({ filePath: h.nodesPath, name: 'box', enabled: false });
  store.setPublishRemoteCas({ filePath: h.nodesPath, name: 'box', enabled: true, audience: [READER2] });
  assert.ok(!mentionsBox(await pending), 'the leaf is served to a reader that left the audience during the wait');
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
  const h = await realHub(t, { otherReply: slowTopology, fetchImpl: fetch });
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

// ------------------------------------------------------------------------- R5 (redirects) and M1 (decks)

const REDIRECT = (status, location) => (req, res) => { res.writeHead(status, { location, 'content-type': 'text/plain' }); res.end(); };

test('R5 (redirects): a 3xx from a host-only peer is never passed along, so the browser cannot repeat the owner\'s call elsewhere', async (t) => {
  for (const [status, location, label] of [[307, '/api/route/other/_/cells/send', '307 towards a trusted peer'], [302, '/api/config', '302 towards this node']]) {
    const h = await realHub(t, { boxReply: REDIRECT(status, location) });
    const own = { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' };
    for (const [url, method] of [['/api/route/box/_/cells/send', 'POST'], ['/api/route/box/_/sessions', 'GET'], ['/node/box/api/sessions', 'GET']]) {
      const before = h.otherCalls.length;
      const manual = await fetch(`${h.base}${url}`, { method, headers: own, body: method === 'POST' ? '{"id":"x"}' : undefined, redirect: 'manual' });
      assert.equal(manual.status, 502, `${label} ${url}: the redirect reached the client (status ${manual.status})`);
      assert.equal(manual.headers.get('location'), null, `${label} ${url}: Location reached the client`);
      const followed = await fetch(`${h.base}${url}`, { method, headers: own, body: method === 'POST' ? '{"id":"x"}' : undefined, redirect: 'follow' });
      assert.equal(followed.status, 502, `${label} ${url}: following ended somewhere else (${followed.url})`);
      assert.equal(h.otherCalls.length, before, `${label} ${url}: the redirected call reached the trusted peer`);
    }
    // the audience member through the federated route
    const viaFed = await fetch(`${h.base}/federation/route/box/_/sessions`, { headers: reader1, redirect: 'manual' });
    assert.equal(viaFed.status, 502, `${label}: federated route`);
  }
});

test('R5 (headers that redirect without a 3xx): Location, Content-Location and Refresh of a host-only peer are dropped', async (t) => {
  const h = await realHub(t, { boxReply: (req, res) => { res.writeHead(200, { 'content-type': 'text/plain', refresh: '0;url=/api/config', location: '/api/config', 'content-location': '/api/config' }); res.end('x'); } });
  for (const url of ['/api/route/box/_/sessions', '/node/box/api/sessions']) {
    const r = await fetch(`${h.base}${url}`, { headers: { authorization: `Bearer ${h.token}` } });
    assert.equal(r.status, 200, url);
    for (const name of ['refresh', 'location', 'content-location']) assert.equal(r.headers.get(name), null, `${url}: ${name} reached the client`);
  }
});

test('R5 GUARD: a trusted peer\'s redirect is forwarded as it always was', async (t) => {
  const h = await realHub(t, { otherReply: REDIRECT(302, '/somewhere') });
  const r = await fetch(`${h.base}/api/route/other/_/sessions`, { headers: { authorization: `Bearer ${h.token}` }, redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/somewhere');
});

test('M1 (decks): tiles and windows that point at a host-only peer are not served to a reader outside its audience, in any answer', async (t) => {
  const h = await realHub(t);
  const st = decksStore.emptyStore();
  st.decks[0].layout = { columns: [{ width: 100, tiles: [
    { session: 'agent-1', node: 'box', ownerId: BOX, height: 50, fontSize: 13 },
    { session: 'agent-2', node: 'other', ownerId: OTHER, height: 50, fontSize: 13 },
  ] }] };
  decksStore.atomicWrite(decksStore.defaultDecksPath(h.home), st);
  const read = async (headers, prefix) => (await (await fetch(`${h.base}${prefix}/decks`, { headers })).text());
  assert.ok(mentionsBox(await read({ authorization: `Bearer ${h.token}` }, '/api')), 'control: the owner sees the tile');
  assert.ok(mentionsBox(await read(reader1, '/federation/route/_')), 'GUARD: the audience member sees it');
  const out = await read(admin2, '/federation/route/_');
  assert.ok(!mentionsBox(out), `the outsider reads the tile: ${out.slice(0, 200)}`);
  assert.ok(out.includes('agent-2'), 'the tile of a trusted peer is still there');
  // the 409 answer carries the current deck too
  const conflict = await fetch(`${h.base}/federation/route/_/decks/main`, { method: 'PUT', headers: admin2, body: JSON.stringify({ expectedRevision: 99, layout: { columns: [] } }) });
  assert.ok(!mentionsBox(await conflict.text()), 'the conflict answer names the host-only peer');
});

test('M1 (decks, integrity): a reader that cannot see the references of a deck cannot save it back and erase them; decks without them and the audience are unaffected', async (t) => {
  const h = await realHub(t);
  const file = decksStore.defaultDecksPath(h.home);
  const st = decksStore.emptyStore();
  st.decks[0].layout = { columns: [{ width: 100, tiles: [{ session: 'agent-1', node: 'box', ownerId: BOX, height: 100, fontSize: 13 }] }] };
  st.decks.push({ name: 'plain', revision: 0, layout: { columns: [{ width: 100, tiles: [{ session: 'agent-2', node: 'other', ownerId: OTHER, height: 100, fontSize: 13 }] }] } });
  decksStore.atomicWrite(file, st);
  const before = JSON.stringify(decksStore.loadStore(file));
  const put = (headers, name, revision) => fetch(`${h.base}/federation/route/_/decks/${name}`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: revision, layout: { columns: [{ width: 100, tiles: [{ session: 'agent-3', node: 'other', ownerId: OTHER, height: 100, fontSize: 13 }] }] } }) });
  const refused = await put(admin2, 'main', 0);
  assert.equal(refused.status, 403, 'the outsider saved the filtered copy of a deck that holds hidden content');
  assert.ok(!mentionsBox(await refused.text()), 'the refusal names the host-only peer');
  const del = await fetch(`${h.base}/federation/route/_/decks/main`, { method: 'DELETE', headers: admin2 });
  assert.equal(del.status, 403, 'the outsider deleted a deck that holds hidden content');
  assert.equal(JSON.stringify(decksStore.loadStore(file)), before, 'the stored decks changed');
  assert.equal((await put(admin2, 'plain', 0)).status, 200, 'GUARD: a deck without hidden content is edited as before');
  const created = await fetch(`${h.base}/federation/route/_/decks`, { method: 'POST', headers: admin2, body: JSON.stringify({ name: 'fresh' }) });
  assert.equal(created.status, 201, 'GUARD: creating a new deck overwrites nothing and is not refused');
  assert.equal((await put(reader1, 'main', 0)).status, 200, 'GUARD: the audience member edits the whole deck');
  const ownerPut = await fetch(`${h.base}/api/decks/main`, { method: 'PUT', headers: own(h), body: JSON.stringify({ expectedRevision: 1, layout: { columns: [{ width: 100, tiles: [{ session: 'agent-1', node: 'box', ownerId: BOX, height: 100, fontSize: 13 }] }] } }) });
  assert.equal(ownerPut.status, 200, 'GUARD: the owner is never filtered');
});

// ------------------------------------------------------------------------- state captured BEFORE a wait
// A publication that ENDS during a wait must not hand its leaf to a reader that was not entitled to it
// when the request began (or that is no longer entitled to it when the answer leaves).

test('P3 (publication ended during the fan-out): the protocol topology does not keep the leaf of a peer that stopped being host-only meanwhile', async () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'nc-topo-off-'));
  try {
    const np = buildStore(dir, { boxPort: 43231, audience: [READER1] });
    const reader = store.getNode(store.loadStore(np), 'reader1');
    let release; const pending = new Promise((r) => { release = r; });
    let reached; const started = new Promise((r) => { reached = r; });
    const result = fed.collectTopology({ nodesPath: np, ingress: reader, visited: [READER1], timeoutMs: 5000, fetchImpl: async () => { reached(); await pending; return { ok: false }; } });
    await started;
    store.setPublishRemoteCas({ filePath: np, name: 'box', enabled: false });
    release();
    const top = await result;
    assert.equal(top.nodes.some((n) => n.instanceId === BOX), false, 'the leaf survived the end of the publication');
    // GUARD: with the publication still active and the reader still entitled, the leaf stays
    const dir2 = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'nc-topo-on-'));
    const np2 = buildStore(dir2, { boxPort: 43232, audience: [READER1] });
    const r2 = store.getNode(store.loadStore(np2), 'reader1');
    const top2 = await fed.collectTopology({ nodesPath: np2, ingress: r2, visited: [READER1], timeoutMs: 300, fetchImpl: async () => ({ ok: false }) });
    assert.equal(top2.nodes.some((n) => n.instanceId === BOX), true, 'GUARD: the entitled reader keeps the leaf');
    require('node:fs').rmSync(dir2, { recursive: true, force: true });
  } finally { require('node:fs').rmSync(dir, { recursive: true, force: true }); }
});

test('P3 (publication ended during the wait, local topology): a reader hidden when it asked is not handed the peer by an off in between', async (t) => {
  const slowTopology = (req, res) => {
    if (/\/federation\/topology/.test(req.url)) {
      return setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ instanceId: OTHER, nodes: [] })); }, 900);
    }
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  };
  const h = await realHub(t, { otherReply: slowTopology, fetchImpl: fetch });
  const pending = fetch(`${h.base}/federation/route/_/topology`, { headers: admin2 }).then((r) => r.text());
  await sleep(250);
  store.setPublishRemoteCas({ filePath: h.nodesPath, name: 'box', enabled: false });
  const text = await pending;
  assert.ok(!mentionsBox(text), `an outsider that asked while the peer was host-only learns it because the publication ended: ${text.slice(0, 140)}`);
});

test('P4 (live host, publication turned on during the wait): the owner is not named to a reader that is outside the audience when the answer leaves', async (t) => {
  const slowOwner = (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (/live-host\/designate/.test(req.url)) return res.end(JSON.stringify({ hostCell: 'c1', revision: 1 }));
    if (/live-host$/.test(req.url.split('?')[0])) return setTimeout(() => res.end(JSON.stringify({ eligible: true, threadStatus: 'present', host: { lease: null } })), 800);
    return res.end('{"ok":true}');
  };
  const h = await realHub(t, { boxReply: slowOwner, hostOnly: false });
  const own1 = { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' };
  assert.equal((await post(h, '/api/route/box/_/live-host/designate', { cell: 'c1' }, own1)).status, 200, 'control: designated while the peer was a plain peer');
  const pending = fetch(`${h.base}/federation/route/_/live-host`, { headers: admin2 }).then((r) => r.text());
  await sleep(250);
  store.setPublishRemoteCas({ filePath: h.nodesPath, name: 'box', enabled: true, audience: [READER1] });
  const text = await pending;
  assert.ok(!mentionsBox(text), `the owner is named after the publication was turned on: ${text.slice(0, 160)}`);
});

test('P4 (audio, publication ended while the target is resolved): the dispatcher does not turn a request denied at the start into an allowed one', async () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'nc-disp-off-'));
  try {
    const np = buildStore(dir, { boxPort: 43233, audience: [READER1] });
    let fetched = 0; let release; const wait = new Promise((r) => { release = r; });
    const dispatcher = createDispatcher({
      localNodeId: () => ID('f'),
      peers: async () => { await wait; return [{ nodeId: BOX, name: 'box', route: ['box'] }]; },
      localPort: () => 1234, localToken: () => 't',
      fetchImpl: async () => { fetched += 1; return { status: 200, json: async () => ({ status: 'spoken' }) }; },
      federatedGuard: ({ target, route }) => fed.touchesHostOnly(np, { target, route }),
    });
    const pending = dispatcher.dispatch({ resource: '/audio/speak', target: BOX, origin: { node: ADMIN2 }, payload: {}, federated: true });
    await sleep(100);
    store.setPublishRemoteCas({ filePath: np, name: 'box', enabled: false });
    release();
    const out = await pending;
    assert.equal(out.status, 'refused');
    assert.equal(fetched, 0, 'a request denied when it began left after the publication ended');
  } finally { require('node:fs').rmSync(dir, { recursive: true, force: true }); }
});

test('P4 (live host, publication ended while the owner is resolved): the Live-host federation does not query a peer that was host-only when the request began', async () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'nc-lh-off-'));
  try {
    const np = buildStore(dir, { boxPort: 43234, audience: [READER1] });
    let fetched = 0; let release; const wait = new Promise((r) => { release = r; });
    const lh = createLiveHostFederation({
      localNodeId: () => ID('f'), peers: async () => { await wait; return [{ nodeId: BOX, name: 'box', route: ['box'] }]; },
      localPort: () => 1234, localToken: () => 't', fetchImpl: async () => { fetched += 1; return { status: 200, json: async () => ({}) }; },
      ownerGuard: ({ target, route }) => fed.touchesHostOnly(np, { target, route }),
    });
    const pending = lh.getOwnerState({ ownerId: BOX });
    await sleep(100);
    store.setPublishRemoteCas({ filePath: np, name: 'box', enabled: false });
    release();
    assert.equal((await pending).ok, false);
    assert.equal(fetched, 0);
  } finally { require('node:fs').rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------- streams opened BEFORE the peer is published, backups

const shareOn = (np) => store.atomicWriteStore(np, store.updateNode(store.loadStore(np), 'box', { shared: true }));
const activate = (np) => {
  store.atomicWriteStore(np, store.updateNode(store.loadStore(np), 'box', { shared: false }));    // Share off
  store.setPublishRemoteCas({ filePath: np, name: 'box', enabled: true, audience: [READER1] });   // then the publication
};

test('G1 (WS): a federated stream already open through a peer when the publication is turned on ends', async (t) => {
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 }); const seen = { closes: 0 };
  wss.on('connection', (ws) => { ws.on('close', () => { seen.closes += 1; }); ws.on('error', () => {}); });
  await new Promise((r) => wss.once('listening', r));
  t.after(() => { for (const c of wss.clients) c.terminate(); wss.close(); });
  const g = await viaUpgrade(t, { boxPort: wss.address().port, hostOnly: false, prepare: shareOn, headers: { authorization: 'Bearer from-admin2', 'x-nexuscrew-visited': ADMIN2 } });
  const ws = new WebSocket(g.url, { headers: g.headers });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); setTimeout(() => reject(new Error('no open')), 3000); });
  await sleep(1500);
  assert.equal(seen.closes, 0, 'GUARD: with no publication the trusted stream stays as it always did');
  activate(g.nodesPath);
  await sleep(2500);
  assert.equal(seen.closes, 1, 'the stream opened before the publication survived its activation');
  try { ws.terminate(); } catch (_) { /* gone */ }
});

test('G1 (SSE): an event stream already open through a peer when the publication is turned on ends', async (t) => {
  const h = await realHub(t, {
    hostOnly: false,
    boxReply: (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: 1\n\n'); const iv = setInterval(() => res.write(': hb\n\n'), 200); res.on('close', () => clearInterval(iv)); },
  });
  shareOn(h.nodesPath);
  const res = await fetch(`${h.base}/federation/route/box/_/event-feed`, { headers: admin2 });
  assert.equal(res.status, 200, 'the stream opens through the plain peer');
  const reader = res.body.getReader();
  try {
    await reader.read();
    const stillOpen = await Promise.race([reader.read().then(() => true, () => false), sleep(1500).then(() => true)]);
    assert.equal(stillOpen, true, 'GUARD: no publication, the stream stays');
    activate(h.nodesPath);
    const ended = await Promise.race([
      (async () => { for (;;) { const { done } = await reader.read(); if (done) return true; } })().catch(() => true),
      sleep(2800).then(() => false),
    ]);
    assert.equal(ended, true, 'the event stream opened before the publication survived its activation');
  } finally { try { await reader.cancel(); } catch (_) { /* gone */ } }
});

test('G4 (backups): two backups of the same bytes in the same second get distinct names instead of failing the opt-in', () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'nc-bak-'));
  try {
    const np = buildStore(dir, { boxPort: 43301, audience: [READER1], hostOnly: false });
    const when = new Date('2026-10-10T20:00:00Z');
    const a = store.backupStoreFile(np, when); const b = store.backupStoreFile(np, when); const c = store.backupStoreFile(np, when);
    assert.equal(new Set([a.path, b.path, c.path]).size, 3, 'the names collide');
    for (const x of [a, b, c]) assert.ok(require('node:fs').existsSync(x.path) && (require('node:fs').statSync(x.path).mode & 0o777) === 0o600, 'backup missing or not 0600');
    assert.equal(a.sha256, b.sha256);
    store.setPublishRemoteCas({ filePath: np, name: 'box', enabled: true, audience: [READER1] });
    store.setPublishRemoteCas({ filePath: np, name: 'box', enabled: false });
    store.setPublishRemoteCas({ filePath: np, name: 'box', enabled: true, audience: [READER1] });
  } finally { require('node:fs').rmSync(dir, { recursive: true, force: true }); }
});

test('fixture: an ephemeral stub port that equals one of the fixed peer ports does not break the fixture', () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'nc-port-'));
  try {
    const np = buildStore(dir, { boxPort: 43101, otherPort: 43150, audience: [READER1] });
    const ports = store.loadStore(np).nodes.flatMap((n) => [n.localPort, n.panelLocalPort]).filter(Boolean);
    assert.equal(new Set(ports).size, ports.length, 'two peers share a port');
  } finally { require('node:fs').rmSync(dir, { recursive: true, force: true }); }
});
