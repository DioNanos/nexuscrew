'use strict';
// tests/host-only-legacy-paths.test.js — the host-only boundary on the legacy paths.
//
// The host-only gate lives in canTransit/classGateCheck and covers the
// peer-facing protocol (/federation/*). The older paths — the unauthenticated
// panel door, the node proxy, the local handlers that re-send with the node's own
// authority — must honour the same boundary. Every test below states the property
// that must hold and the family it belongs to:
//
//   F1  the federated panel router is mounted BEFORE requireToken with ingress
//       null (owner rights): no token, no canTransit/audience, no panelAccess,
//       on HTTP (/api/route/<peer>/_/panel/*) and on WS (cookie npanel= = any).
//   F2  what a host-only peer answers goes back to the PWA origin with its
//       Set-Cookie / Clear-Site-Data / CSP untouched (hop-by-hop strip only).
//   F3  audience is checked on the LAST hop only: a caller outside the audience
//       gets in through an audience member; the topology repeats the mistake.
//   L1  streams (WS, SSE) opened while allowed are not closed on revocation.
//
// Tests marked GUARD pass today and MUST keep passing after the fix: they pin
// the behaviour towards trusted peers, which the fix must not change.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const WebSocket = require('ws');
const store = require('../lib/nodes/store.js');
const fed = require('../lib/proxy/federation.js');
const {
  ID, SELF, BOX, READER1, READER2, INTRUDER, LIMITED, ADMIN2, OTHER,
  peer, BOX_PEER, LIMITED_PEER, listen, closeServer, sleep, buildStore, realHub, status, wsAttempt,
} = require('./helpers/host-only-hub.js');

// ------------------------------------------------------------------ F1 (HTTP)

test('F1 control: without a credential the normal owner routes are refused and Box sees nothing', async (t) => {
  const h = await realHub(t);
  assert.equal((await status(`${h.base}/api/route/box/_/sessions`)).status, 401);
  assert.equal(h.boxCalls.length, 0);
});

test('F1 HTTP: /api/route/<host-only>/_/panel/* needs the hub\'s own authentication and the audience check', async (t) => {
  const h = await realHub(t);
  for (const [method, p] of [['GET', '/api/route/box/_/panel/c1/index.html'], ['POST', '/api/route/box/_/panel/c1/x'], ['GET', '/api/route/box/_/panel/c1/']]) {
    const r = await status(`${h.base}${p}`, {}, { method });
    assert.ok([401, 403].includes(r.status), `${method} ${p} without credential: got ${r.status}`);
  }
  assert.equal(h.boxCalls.length, 0, 'nothing reached the host-only peer without a credential');
});

test('F1 HTTP (Limited profile): a non-audience peer is refused by /federation/route AND by /api/route on the same listener', async (t) => {
  const h = await realHub(t);
  const limited = { authorization: 'Bearer from-limited', 'x-nexuscrew-visited': LIMITED };
  // Control (passes today): the peer-facing door applies canTransit.
  const viaFederation = await status(`${h.base}/federation/route/box/_/panel/c1/index.html`, limited);
  assert.equal(viaFederation.status, 403, 'federation door: non-audience peer refused');
  assert.equal(h.boxCalls.length, 0);
  // The same peer, same listener, the legacy door.
  const viaApi = await status(`${h.base}/api/route/box/_/panel/c1/index.html`, { authorization: 'Bearer from-limited' });
  assert.ok([401, 403].includes(viaApi.status), `/api/route door: got ${viaApi.status}`);
  assert.equal(h.boxCalls.length, 0, 'Box saw no request originated by a non-audience peer');
});

test('F1 HTTP (host-only peer as the caller): it reaches no other node through the legacy door', async (t) => {
  const h = await realHub(t);
  const r = await status(`${h.base}/api/route/other/_/panel/c1/index.html`, { authorization: 'Bearer from-box' });
  assert.ok([401, 403].includes(r.status), `host-only peer -> other via /api/route: got ${r.status}`);
  assert.equal(h.otherCalls.length, 0, 'peer -> anyone: never');
});

test('F1 GUARD: towards a TRUSTED peer the panel route keeps its contract (the owner node decides; no hub token needed)', async (t) => {
  const h = await realHub(t);
  const r = await status(`${h.base}/api/route/other/_/panel/c1/index.html`);
  assert.equal(r.status, 200, 'legacy panel bypass towards a trusted peer stays (iframes cannot carry headers)');
  assert.equal(h.otherCalls.length, 1);
  assert.equal(h.otherCalls[0].auth, 'Bearer to-other');
});

// ------------------------------------------------------------------- F1 (WS)

test('F1 WS: a cookie named npanel= (any value) does not open a tunnel to a host-only peer', async (t) => {
  const h = await realHub(t);
  const url = `ws://127.0.0.1:${h.port}/api/route/box/_/panel/c1/ws`;
  assert.notEqual(await wsAttempt(url), 'open');
  assert.equal(h.boxUpgrades.length, 0, 'control: no cookie, no tunnel');
  await wsAttempt(url, { cookie: 'npanel=anything' });
  assert.equal(h.boxUpgrades.length, 0, 'with a forged npanel cookie nothing may reach the peer');
});

test('F1 WS GUARD: towards a trusted peer the npanel cookie still lets the upgrade through (owner validates it)', async (t) => {
  const h = await realHub(t);
  const hits = [];
  // re-point "other" at a ws-aware stub
  const upstream = await listen(() => {});
  upstream.on('upgrade', (req, socket) => { hits.push(req.url); socket.destroy(); });
  t.after(() => closeServer(upstream));
  const nodes = store.loadStore(h.nodesPath);
  store.atomicWriteStore(h.nodesPath, store.updateNode(nodes, 'other', { localPort: upstream.address().port }));
  await wsAttempt(`ws://127.0.0.1:${h.port}/api/route/other/_/panel/c1/ws`, { cookie: 'npanel=x' });
  assert.equal(hits.length, 1, 'trusted peer: the upgrade is forwarded as today');
});

// ------------------------------------------------------------------------ F2

const HOSTILE = (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/html',
    'set-cookie': ['evil=1; Path=/', 'npanel=forged; Path=/api/route/box/_/panel/c1'],
    'clear-site-data': '"cache", "cookies", "storage"',
    'content-security-policy': "default-src * 'unsafe-inline' 'unsafe-eval'",
  });
  res.end('<script>/* runs on the PWA origin */</script>');
};
const lower = (r) => Object.fromEntries([...r.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));

test('F2: an answer from a host-only peer reaches the PWA without Set-Cookie / Clear-Site-Data, with a sandboxing CSP and nosniff', async (t) => {
  const h = await realHub(t, { boxReply: HOSTILE });
  for (const p of ['/api/route/box/_/sessions', '/api/route/box/_/files/download?path=a']) {
    const r = await status(`${h.base}${p}`, { authorization: `Bearer ${h.token}` });
    const hd = lower(r);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.getSetCookie().length, 0, `${p}: Set-Cookie from the peer must not reach the PWA origin`);
    assert.equal(hd['clear-site-data'], undefined, `${p}: Clear-Site-Data must be dropped`);
    assert.match(hd['content-security-policy'] || '', /\bsandbox\b/, `${p}: CSP sandbox`);
    assert.equal(hd['x-content-type-options'], 'nosniff', `${p}: nosniff`);
  }
});

test('F2 (panel): the authenticated owner request for a host-only panel is refused or fully sanitized', async (t) => {
  const h = await realHub(t, { boxReply: HOSTILE });
  const r = await status(`${h.base}/api/route/box/_/panel/c1/index.html`, { authorization: `Bearer ${h.token}` });
  if (r.status === 200) {
    const hd = lower(r);
    assert.equal(r.headers.getSetCookie().length, 0);
    assert.equal(hd['clear-site-data'], undefined);
    assert.match(hd['content-security-policy'] || '', /\bsandbox\b/);
  } else assert.ok([403, 404].includes(r.status), `refused: ${r.status}`);
});

test('F2 (legacy /node proxy): the owner reaching a host-only peer through /node/<name> gets the same sanitized answer', async (t) => {
  const h = await realHub(t, { boxReply: HOSTILE });
  const r = await status(`${h.base}/node/box/api/sessions`, { authorization: `Bearer ${h.token}` });
  assert.equal(r.status, 200, 'the legacy proxy reaches the peer for the owner');
  assert.equal(h.boxCalls.length, 1);
  assert.equal(r.headers.getSetCookie().length, 0, 'Set-Cookie from the peer must not reach the PWA origin');
  assert.equal(lower(r)['clear-site-data'], undefined);
  assert.match(lower(r)['content-security-policy'] || '', /\bsandbox\b/);
});

test('F2 GUARD: a TRUSTED peer\'s answer is forwarded untouched (its panel cookie is a legitimate Set-Cookie)', async (t) => {
  const h = await realHub(t, { otherReply: HOSTILE });
  const r = await status(`${h.base}/api/route/other/_/panel/c1/index.html`);
  assert.equal(r.status, 200);
  assert.ok(r.headers.getSetCookie().length >= 1, 'trusted-peer Set-Cookie is still forwarded');
  assert.equal(lower(r)['content-security-policy'], "default-src * 'unsafe-inline' 'unsafe-eval'", 'trusted-peer CSP untouched');
});

// ------------------------------------------------------------- F3 + L1 (peer router)

function peerFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hostonly-hops-'));
  const nodesPath = buildStore(dir, { boxPort: 43105, audience: [READER1] });
  return { dir, nodesPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
async function relay(t, { upstreamHandler, audience, reader1 } = {}) {
  const calls = [];
  const upstream = await listen(upstreamHandler || ((req, res) => {
    calls.push(req.url); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hostonly-relay-'));
  const nodesPath = buildStore(dir, { boxPort: upstream.address().port, audience: audience || [READER1] });
  if (reader1) store.atomicWriteStore(nodesPath, store.updateNode(store.loadStore(nodesPath), 'reader1', reader1));
  const app = express();
  app.use('/federation', fed.peerRouter({ nodesPath, localPort: 1, localCredential: () => 'hub-main', fetchImpl: async () => { throw new Error('no network'); } }));
  const hub = await listen(app);
  t.after(async () => { await closeServer(hub); await closeServer(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const get = (p, who, visited) => fetch(`http://127.0.0.1:${hub.address().port}${p}`, {
    headers: { authorization: `Bearer from-${who}`, 'x-nexuscrew-visited': visited },
  });
  return { calls, get, nodesPath, hub, upstream };
}

test('F3 (hops): audience is required on EVERY hop of the visited chain, not only on the last', async (t) => {
  const r = await relay(t, { audience: [READER1] });
  // X (outside the audience) -> reader1 (audience) -> us -> host-only peer
  const viaOutsider = await r.get('/federation/route/box/_/sessions', 'reader1', `${INTRUDER},${READER1}`);
  assert.equal(viaOutsider.status, 403, 'an origin outside the audience must not ride an audience member');
  assert.equal(r.calls.length, 0);
  // control: the audience member alone is let through
  assert.equal((await r.get('/federation/route/box/_/sessions', 'reader1', READER1)).status, 200);
});

test('F3 GUARD: a chain made only of audience members still passes', async (t) => {
  const r = await relay(t, { audience: [READER1, READER2] });
  assert.equal((await r.get('/federation/route/box/_/sessions', 'reader1', `${READER2},${READER1}`)).status, 200);
});

test('F3 (topology): the host-only peer is not announced to an audience member on behalf of an outsider', async () => {
  const f = peerFixture();
  try {
    const st = store.loadStore(f.nodesPath);
    const log = [];
    const fetchImpl = async (url) => { log.push(String(url)); return { ok: true, json: async () => ({ instanceId: ID('a'), nodes: [] }) }; };
    const routes = async (ingress, visited) => (await fed.collectTopology({ nodesPath: f.nodesPath, ingress, visited, fetchImpl, timeoutMs: 300 }))
      .nodes.map((n) => n.route.join('/'));
    const own = await routes(store.getNode(st, 'reader1'), [READER1]);
    assert.ok(own.includes('box'), 'control: the audience member sees the peer');
    const onBehalf = await routes(store.getNode(st, 'reader1'), [INTRUDER, READER1]);
    assert.ok(!onBehalf.includes('box'), 'asked on behalf of an outsider, the peer must not be listed');
  } finally { f.cleanup(); }
});

test('L1 (WS): an open tunnel to a host-only peer is closed when the audience is revoked', async (t) => {
  const wsSrv = await listen(() => {});
  const wss = new WebSocket.Server({ server: wsSrv });
  wss.on('connection', (ws) => ws.send('hello'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hostonly-l1-'));
  const nodesPath = buildStore(dir, { boxPort: wsSrv.address().port, audience: [READER1] });
  const activeSockets = new Set();
  const hub = await listen(() => {});
  hub.on('upgrade', (req, socket, head) => {
    const ingress = fed.peerFromToken(nodesPath, (req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!ingress) return socket.destroy();
    fed.forwardUpgrade({ req, socket, head, nodesPath, localPort: 1, localCredential: () => 'hub-main', ingress, readonly: () => false, hopSecret: null, activeSockets });
  });
  t.after(async () => { wss.close(); await closeServer(hub); await closeServer(wsSrv); fs.rmSync(dir, { recursive: true, force: true }); });
  const ws = new WebSocket(`ws://127.0.0.1:${hub.address().port}/federation/route/box/_/ws`, {
    headers: { authorization: 'Bearer from-reader1', 'x-nexuscrew-visited': READER1 },
  });
  try {
    await new Promise((resolve, reject) => { ws.once('message', resolve); ws.once('error', reject); setTimeout(() => reject(new Error('no hello')), 3000); });
    store.setPublishRemoteCas({ filePath: nodesPath, name: 'box', enabled: false });
    await sleep(2500);
    assert.notEqual(ws.readyState, WebSocket.OPEN, 'the tunnel opened before the revocation is still open');
  } finally { try { ws.terminate(); } catch (_) { /* gone */ } for (const sk of activeSockets) { try { sk.destroy(); } catch (_) { /* gone */ } } }
});

test('L1 (SSE): an open event stream from a host-only peer ends when the audience is revoked', async (t) => {
  const r = await relay(t, {
    audience: [READER1], reader1: { eventsAccess: true, nodeEventsAccess: true, accessConfigured: true },
    upstreamHandler: (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: 1\n\n'); const iv = setInterval(() => res.write(': hb\n\n'), 200); res.on('close', () => clearInterval(iv)); },
  });
  const res = await r.get('/federation/route/box/_/event-feed', 'reader1', READER1);
  assert.equal(res.status, 200, 'the stream opens for the audience');
  const reader = res.body.getReader();
  try {
    await reader.read();
    store.setPublishRemoteCas({ filePath: r.nodesPath, name: 'box', enabled: false });
    const ended = await Promise.race([
      (async () => { for (;;) { const { done } = await reader.read(); if (done) return true; } })().catch(() => true),
      sleep(2500).then(() => false),
    ]);
    assert.equal(ended, true, 'the SSE stream is still delivering after the revocation');
  } finally { try { await reader.cancel(); } catch (_) { /* gone */ } }
});

// ------------------------------------------------------------------ second pass: the other legacy surfaces
// "admin2" is an admin peer (every grant) OUTSIDE the audience: it may use the
// protocol, but it must not reach or learn the host-only peer through us.
const admin2 = { authorization: 'Bearer from-admin2', 'x-nexuscrew-visited': ADMIN2, 'content-type': 'application/json' };
const reader1 = { authorization: 'Bearer from-reader1', 'x-nexuscrew-visited': READER1, 'content-type': 'application/json' };
const post = (h, p, body, headers) => fetch(`${h.base}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
const SPEAK = { target: BOX, text: 'hello', originCell: 'c1' };

test('G1 (audio speak): a federated /audio/speak terminating here is not re-dispatched to a host-only peer for a caller outside the audience', async (t) => {
  const h = await realHub(t);
  const r = await post(h, '/federation/route/_/audio/speak', SPEAK, admin2);
  assert.equal(h.boxCalls.length, 0, `the host-only peer received ${h.boxCalls.map((c) => c.url)} (status ${r.status})`);
});

test('G1 GUARD (audio speak): the audience member still reaches the host-only peer on its own route', async (t) => {
  const h = await realHub(t);
  const r = await post(h, '/federation/route/box/_/audio/speak', SPEAK, reader1);
  assert.equal(r.status, 200);
  assert.equal(h.boxCalls.length, 1);
});

test('G2 (audio stop): same as speak, for the stop command', async (t) => {
  const h = await realHub(t);
  await post(h, '/federation/route/_/audio/stop', { target: BOX, utteranceId: '3c9a46d5-fbfb-4a30-9715-4e7b870cc493', originCell: 'c1' }, admin2);
  assert.equal(h.boxCalls.length, 0, `the host-only peer received ${h.boxCalls.map((c) => c.url)}`);
});

const DESIGNATE = (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(/live-host\/designate/.test(req.url) ? JSON.stringify({ hostCell: 'c1', revision: 1 }) : '{"ok":true}');
};

test('G3 (live-host): once the owner designates a cell of a host-only peer, a caller outside the audience cannot make us query or bridge to it', async (t) => {
  const h = await realHub(t, { boxReply: DESIGNATE });
  const own = { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' };
  const open = await fetch(`${h.base}/federation/route/_/live-host`, { headers: admin2 });
  assert.equal(open.status, 200, 'control: the admin peer may read the live-host view of this node');
  await post(h, '/api/route/box/_/live-host/designate', { cell: 'c1' }, own);
  const before = h.boxCalls.length;
  await fetch(`${h.base}/federation/route/_/live-host`, { headers: admin2 });
  await post(h, '/federation/route/_/live-host/bridge', { expect: { hostCell: 'c1', revision: 1 } }, admin2);
  assert.equal(h.boxCalls.length, before, `queries sent to the host-only peer on behalf of the outsider: ${h.boxCalls.slice(before).map((c) => `${c.method} ${c.url}`)}`);
});

const mentionsBox = (text) => /\bbox\b|c{32}/.test(text);

test('G4 (topology): the local topology served to an operator peer outside the audience does not list the host-only peer', async (t) => {
  const h = await realHub(t);
  const own = await (await fetch(`${h.base}/api/topology`, { headers: { authorization: `Bearer ${h.token}` } })).text();
  assert.ok(mentionsBox(own), 'control: the owner sees the peer');
  const aud = await (await fetch(`${h.base}/federation/route/_/topology`, { headers: reader1 })).text();
  assert.ok(mentionsBox(aud), 'GUARD: the audience member sees it');
  const out = await (await fetch(`${h.base}/federation/route/_/topology`, { headers: admin2 })).text();
  assert.ok(!mentionsBox(out), `the outsider learns the host-only peer: ${out.slice(0, 160)}`);
});

test('G5 (config): the node panel-port map served to an operator peer outside the audience does not name the host-only peer', async (t) => {
  const h = await realHub(t);
  const own = await (await fetch(`${h.base}/api/config`, { headers: { authorization: `Bearer ${h.token}` } })).json();
  assert.ok(own.nodePanelPorts && own.nodePanelPorts.box, 'control: the owner map has the peer');
  const aud = await (await fetch(`${h.base}/federation/route/_/config`, { headers: reader1 })).json();
  assert.ok(aud.nodePanelPorts && aud.nodePanelPorts.box, 'GUARD: the audience member keeps it');
  const out = await (await fetch(`${h.base}/federation/route/_/config`, { headers: admin2 })).json();
  assert.ok(!(out.nodePanelPorts && out.nodePanelPorts.box), `the outsider reads ${JSON.stringify(out.nodePanelPorts)}`);
});

test('G6 (diagnostics): records naming a host-only peer (by name or id, in any field) are not served to a caller outside the audience', async (t) => {
  const h = await realHub(t);
  h.diagnostics.record('warn', 'share', 'SHARE_REVOKE_PENDING', 'Share OFF reconciliation pending', { node: 'box', state: 'pending' });
  h.diagnostics.record('warn', 'share', 'PEER_NOTE', 'peer box answered slowly', {});
  h.diagnostics.record('warn', 'share', 'PEER_ID', 'probe', { node: BOX });
  h.diagnostics.record('warn', 'share', 'OTHER_NOTE', 'unrelated record about reader1', {});
  const logs = async (headers, prefix) => (await (await fetch(`${h.base}${prefix}/diagnostics/logs`, { headers })).json()).records || [];
  const codes = (records) => records.map((r) => r.code);
  const own = codes(await logs({ authorization: `Bearer ${h.token}` }, '/api'));
  for (const c of ['SHARE_REVOKE_PENDING', 'PEER_NOTE', 'PEER_ID', 'OTHER_NOTE']) assert.ok(own.includes(c), `control: the owner sees ${c}`);
  const aud = codes(await logs(reader1, '/federation/route/_'));
  assert.ok(aud.includes('PEER_NOTE') && aud.includes('PEER_ID'), 'GUARD: the audience member sees them');
  const out = codes(await logs(admin2, '/federation/route/_'));
  assert.ok(out.includes('OTHER_NOTE'), 'the outsider still gets the unrelated records');
  for (const c of ['SHARE_REVOKE_PENDING', 'PEER_NOTE', 'PEER_ID']) assert.ok(!out.includes(c), `the outsider reads ${c}`);
});
