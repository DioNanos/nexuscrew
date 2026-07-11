'use strict';
// Test matrix §4b(2) del reverse-proxy /node/<name> (B1). Server upstream FAKE su
// porta effimera; nessun ssh/tunnel reale. Copre: auth-prima, name strict/traversal,
// no token leak (anche su errore), header override ignorato, no proxy transitivo,
// nodo giu' -> 502, READONLY, e parita' WS (auth + inject token remoto).
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const { requireToken } = require('../lib/auth/middleware.js');
const {
  createNodeProxy, handleNodeUpgrade,
  splitNodePath, isTransitiveRest, sanitizeRequestHeaders, sanitizeResponseHeaders,
  buildUpgradeRequest, stripLocalTokenQuery,
} = require('../lib/proxy/node-proxy.js');

const LOCAL = 'local-secret-token';
const REMOTE = 'remote-secret-token-xyz';

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server)));
}

// Upstream HTTP fake: registra ogni richiesta ricevuta; risposta configurabile.
function makeUpstream(respond) {
  const reqs = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      reqs.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (respond) return respond(req, res);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  server.reqs = reqs;
  return server;
}

// App proxy: requireToken(LOCAL) DAVANTI al router (auth locale prima del resolve).
function makeProxyApp({ resolveNode, readonly }) {
  const app = express();
  app.use('/node', requireToken(LOCAL), createNodeProxy({ resolveNode, readonly }));
  return app;
}

const auth = { authorization: `Bearer ${LOCAL}` };

// --- unit puri --------------------------------------------------------------

test('splitNodePath: name/rest/search e casi vuoti', () => {
  assert.deepStrictEqual(splitNodePath('/vps/api/x?y=1'), { name: 'vps', rest: '/api/x', search: '?y=1' });
  assert.deepStrictEqual(splitNodePath('/vps'), { name: 'vps', rest: '/', search: '' });
  assert.deepStrictEqual(splitNodePath('/vps/'), { name: 'vps', rest: '/', search: '' });
  assert.strictEqual(splitNodePath('/'), null);
  assert.strictEqual(splitNodePath(''), null);
});

test('isTransitiveRest: /node/* bloccato anche percent-encoded', () => {
  assert.strictEqual(isTransitiveRest('/node/b'), true);
  assert.strictEqual(isTransitiveRest('/node'), true);
  assert.strictEqual(isTransitiveRest('/%6eode/b'), true); // decodifica -> /node/b
  assert.strictEqual(isTransitiveRest('/api/node'), false);
  assert.strictEqual(isTransitiveRest('/'), false);
});

test('sanitizeRequestHeaders: strip client-supplied, inietta token remoto', () => {
  const out = sanitizeRequestHeaders({
    host: 'evil.example', authorization: 'Bearer CLIENT', cookie: 'a=b',
    'x-forwarded-host': 'evil', 'proxy-authorization': 'x', connection: 'keep-alive',
    'user-agent': 'ua', 'content-type': 'application/json',
  }, REMOTE);
  assert.strictEqual(out.host, undefined);
  assert.strictEqual(out.cookie, undefined);
  assert.strictEqual(out['x-forwarded-host'], undefined);
  assert.strictEqual(out['proxy-authorization'], undefined);
  assert.strictEqual(out.connection, undefined);
  assert.strictEqual(out['user-agent'], 'ua');
  assert.strictEqual(out['content-type'], 'application/json');
  assert.strictEqual(out.authorization, `Bearer ${REMOTE}`); // iniettato, non quello client
});

test('sanitizeRequestHeaders: strip headers nominated dynamically by Connection', () => {
  const out = sanitizeRequestHeaders({ connection: 'X-Hop, keep-alive', 'x-hop': 'secret', accept: 'text/plain' }, REMOTE);
  assert.strictEqual(out['x-hop'], undefined);
  assert.strictEqual(out.accept, 'text/plain');
});

test('sanitizeResponseHeaders: strip hop-by-hop', () => {
  const out = sanitizeResponseHeaders({ 'content-type': 'text/plain', connection: 'x-hop, close', 'x-hop': 'secret', 'transfer-encoding': 'chunked' });
  assert.strictEqual(out['content-type'], 'text/plain');
  assert.strictEqual(out.connection, undefined);
  assert.strictEqual(out['transfer-encoding'], undefined);
  assert.strictEqual(out['x-hop'], undefined);
});

test('stripLocalTokenQuery: rimuove solo token', () => {
  assert.strictEqual(stripLocalTokenQuery('?token=abc'), '');
  assert.strictEqual(stripLocalTokenQuery('?token=abc&x=1'), '?x=1');
  assert.strictEqual(stripLocalTokenQuery(''), '');
});

test('buildUpgradeRequest: Connection/Upgrade controllati, token iniettato, host loopback', () => {
  const raw = buildUpgradeRequest('GET', '/ws', '?token=LOCAL&x=1', {
    host: 'evil', authorization: 'Bearer CLIENT', 'sec-websocket-key': 'KEY==',
    'sec-websocket-version': '13', connection: 'Upgrade', upgrade: 'websocket',
  }, REMOTE, 44444);
  assert.match(raw, /^GET \/ws\?x=1 HTTP\/1\.1\r\n/);      // token locale strippato
  assert.match(raw, /\r\nHost: 127\.0\.0\.1:44444\r\n/);
  assert.match(raw, /\r\nSec-Websocket-Key: KEY==\r\n/i);
  assert.match(raw, /\r\nConnection: Upgrade\r\n/);
  assert.match(raw, /\r\nUpgrade: websocket\r\n/);
  assert.match(raw, new RegExp(`\\r\\nauthorization: Bearer ${REMOTE}\\r\\n`, 'i'));
  assert.ok(!/Bearer CLIENT/.test(raw), 'authorization client non inoltrato');
  assert.ok(raw.endsWith('\r\n\r\n'));
});

// --- (a) auth-prima + ordine middleware -------------------------------------

test('(a) auth locale mancante -> 401 e name NON risolto', async (t) => {
  let resolveCalls = 0;
  const app = makeProxyApp({ resolveNode: () => { resolveCalls += 1; return { localPort: 1, token: REMOTE }; } });
  const srv = await listen(http.createServer(app));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const r = await fetch(`${base}/node/vps/api/x`); // niente Authorization
  assert.strictEqual(r.status, 401);
  assert.strictEqual(resolveCalls, 0, 'resolveNode non deve essere chiamato senza auth');
});

test('ordine middleware: 401 su name inesistente SENZA auth, 404 CON auth', async (t) => {
  const app = makeProxyApp({ resolveNode: () => null }); // ghost sempre sconosciuto
  const srv = await listen(http.createServer(app));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  assert.strictEqual((await fetch(`${base}/node/ghost`)).status, 401);
  assert.strictEqual((await fetch(`${base}/node/ghost`, { headers: auth })).status, 404);
});

// --- (b) name invalido/traversal --------------------------------------------

test('(b) name invalido/traversal-like -> 404 senza toccare upstream', async (t) => {
  let resolveCalls = 0;
  const app = makeProxyApp({ resolveNode: () => { resolveCalls += 1; return { localPort: 1, token: REMOTE }; } });
  const srv = await listen(http.createServer(app));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const bad = [
    '/node/..%2f..%2fetc',
    '/node/%2e%2e/x',
    '/node/UPPER',                 // maiuscole fuori dall'allowlist
    '/node/has.dot',
    `/node/${'a'.repeat(33)}`,     // troppo lungo (>32)
    '/node/',                      // niente name
  ];
  for (const p of bad) {
    const r = await fetch(`${base}${p}`, { headers: auth });
    assert.strictEqual(r.status, 404, `${p} deve dare 404`);
  }
  // '/node/a/b/..%2f' passa il name 'a' (valido) e inoltra rest -> upstream sarebbe
  // toccato; qui verifichiamo solo che i name malformati non risolvano.
  assert.strictEqual(resolveCalls, 0, 'nessun name malformato deve risolvere');
});

// --- (c) token remoto MAI nella risposta (anche su errore) ------------------

test('(c) token remoto assente nella risposta; iniettato upstream; auth client strippata', async (t) => {
  const upstream = makeUpstream((req, res) => {
    if (req.url === '/boom') { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('upstream error'); }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-note': 'clean' });
    res.end('hello');
  });
  await listen(upstream);
  const upPort = upstream.address().port;
  const app = makeProxyApp({ resolveNode: (n) => (n === 'vps' ? { localPort: upPort, token: REMOTE } : null) });
  const srv = await listen(http.createServer(app));
  t.after(() => { srv.close(); upstream.close(); });
  const base = `http://127.0.0.1:${srv.address().port}`;

  // client autenticato localmente (Bearer LOCAL): la SUA Authorization non deve
  // arrivare upstream, dev'essere sostituita col token remoto.
  const ok = await fetch(`${base}/node/vps/x`, { headers: auth });
  assert.strictEqual(ok.status, 200);
  const okText = await ok.text();
  let hdrDump = '';
  ok.headers.forEach((v, k) => { hdrDump += `${k}:${v}\n`; });
  assert.ok(!okText.includes(REMOTE) && !hdrDump.includes(REMOTE), 'token remoto non deve comparire nella risposta ok');

  // errore upstream: nemmeno qui il token deve trapelare
  const err = await fetch(`${base}/node/vps/boom`, { headers: auth });
  assert.strictEqual(err.status, 500);
  const errText = await err.text();
  assert.ok(!errText.includes(REMOTE), 'token remoto non deve comparire su errore upstream');

  // upstream ha ricevuto il token remoto iniettato, NON quello locale del client
  const seen = upstream.reqs.find((r) => r.url === '/x');
  assert.strictEqual(seen.headers.authorization, `Bearer ${REMOTE}`);
  assert.ok(!JSON.stringify(seen.headers).includes(LOCAL), 'token locale del client non inoltrato upstream');
});

// --- (e) override upstream via Host/X-Forwarded-* ----------------------------

test('(e) Host/X-Forwarded-* client ignorati: upstream vede loopback, niente x-forwarded', async (t) => {
  const upstream = makeUpstream();
  await listen(upstream);
  const upPort = upstream.address().port;
  const app = makeProxyApp({ resolveNode: () => ({ localPort: upPort, token: REMOTE }) });
  const srv = await listen(http.createServer(app));
  t.after(() => { srv.close(); upstream.close(); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const r = await fetch(`${base}/node/vps/probe`, {
    headers: { ...auth, host: 'evil.example.com', 'x-forwarded-host': 'evil', 'x-forwarded-for': '9.9.9.9', 'x-forwarded-proto': 'https' },
  });
  assert.strictEqual(r.status, 200);
  const seen = upstream.reqs.find((x) => x.url === '/probe');
  assert.strictEqual(seen.headers.host, `127.0.0.1:${upPort}`, 'host deve essere il loopback upstream');
  assert.strictEqual(seen.headers['x-forwarded-host'], undefined);
  assert.strictEqual(seen.headers['x-forwarded-for'], undefined);
  assert.strictEqual(seen.headers['x-forwarded-proto'], undefined);
});

// --- (f) niente proxy transitivo --------------------------------------------

test('(f) /node/<a>/node/<b> -> 404, upstream mai toccato', async (t) => {
  const upstream = makeUpstream();
  await listen(upstream);
  const upPort = upstream.address().port;
  const app = makeProxyApp({ resolveNode: () => ({ localPort: upPort, token: REMOTE }) });
  const srv = await listen(http.createServer(app));
  t.after(() => { srv.close(); upstream.close(); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  assert.strictEqual((await fetch(`${base}/node/vps/node/other`, { headers: auth })).status, 404);
  assert.strictEqual((await fetch(`${base}/node/vps/%6eode/other`, { headers: auth })).status, 404);
  assert.strictEqual(upstream.reqs.length, 0, 'transitivo non deve raggiungere upstream');
});

// --- (g) nodo giu' -> 502 JSON ----------------------------------------------

test('(g) nodo irraggiungibile -> 502 JSON {error}, non hang', async (t) => {
  // porta con nessun listener: ECONNREFUSED immediato.
  const deadPort = await freePort();
  const app = makeProxyApp({ resolveNode: () => ({ localPort: deadPort, token: REMOTE }) });
  const srv = await listen(http.createServer(app));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const r = await fetch(`${base}/node/vps/x`, { headers: auth });
  assert.strictEqual(r.status, 502);
  const body = await r.json();
  assert.ok(typeof body.error === 'string' && body.error.length > 0);
});

// --- READONLY ---------------------------------------------------------------

test('READONLY locale: metodi mutanti verso nodo -> 403; GET passa', async (t) => {
  const upstream = makeUpstream();
  await listen(upstream);
  const upPort = upstream.address().port;
  const app = makeProxyApp({ resolveNode: () => ({ localPort: upPort, token: REMOTE }), readonly: () => true });
  const srv = await listen(http.createServer(app));
  t.after(() => { srv.close(); upstream.close(); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await fetch(`${base}/node/vps/mutate`, { method, headers: auth });
    assert.strictEqual(r.status, 403, `${method} deve dare 403 in READONLY`);
  }
  const get = await fetch(`${base}/node/vps/read`, { headers: auth });
  assert.strictEqual(get.status, 200);
  assert.ok(upstream.reqs.every((x) => x.method === 'GET'), 'nessuna mutazione deve raggiungere upstream');
});

// --- audit F5: write-failure nello upgrade WS -> fail(502) operative, no socket leak ---

test('F5 handleNodeUpgrade: write-failure -> fail(502) operativo (entrambi i socket distrutti + 502)', () => {
  const { EventEmitter } = require('node:events');
  // upstream: emetto 'connect' dopo; write LANCIA (es. header invalido); destroy spiato.
  const up = new EventEmitter();
  up.write = () => { throw new Error('write boom (header invalido)'); };
  let upDestroyed = false;
  up.destroy = () => { upDestroyed = true; };
  // socket del browser: write raccoglie l\'output, destroy spiato.
  const sockWrites = [];
  let sockDestroyed = false;
  const sock = new EventEmitter();
  sock.write = (d) => { sockWrites.push(String(d)); return true; };
  sock.destroy = () => { sockDestroyed = true; };
  sock.pipe = () => {};
  const req = { url: '/node/vps/ws', method: 'GET', headers: { 'sec-websocket-key': 'K==', 'sec-websocket-version': '13' } };
  handleNodeUpgrade({
    req, socket: sock, head: Buffer.alloc(0),
    resolveNode: () => ({ localPort: 5555, token: 'REMOTE' }),
    verifyToken: () => true,
    readonly: () => false,
    connect: () => up,
  });
  // connect-handler prova upstream.write che lancia -> catch -> fail(502).
  // Prima dell'audit settled=true era messo PRIMA dei write: fail() era no-op,
  // nessun socket distrutto, nessun 502, entrambi i socket vivi (leak).
  up.emit('connect');
  assert.strictEqual(upDestroyed, true, 'upstream va distrutto sul write-failure (no leak upstream)');
  assert.strictEqual(sockDestroyed, true, 'socket del browser va distrutto (no leak browser-side)');
  assert.ok(sockWrites.some((w) => /502/.test(w)), 'un 502 esplicito va inviato al browser');
});

test('F5 handleNodeUpgrade: write OK -> settle, piping raw, nessun 502', () => {
  const { EventEmitter } = require('node:events');
  const up = new EventEmitter();
  const upWrites = [];
  up.write = (d) => { upWrites.push(String(d)); return true; };
  let upDestroyed = false;
  up.destroy = () => { upDestroyed = true; };
  up.pipe = () => {};
  const sockWrites = [];
  let sockDestroyed = false;
  const sock = new EventEmitter();
  sock.write = (d) => { sockWrites.push(String(d)); return true; };
  sock.destroy = () => { sockDestroyed = true; };
  sock.pipe = () => {};
  const req = { url: '/node/vps/ws', method: 'GET', headers: { 'sec-websocket-key': 'K==', 'sec-websocket-version': '13' } };
  const activeSockets = new Set();
  handleNodeUpgrade({
    req, socket: sock, head: Buffer.alloc(0),
    resolveNode: () => ({ localPort: 5556, token: 'REMOTE' }),
    verifyToken: () => true,
    readonly: () => false,
    connect: () => up,
    activeSockets,
  });
  up.emit('connect');
  assert.ok(upWrites.some((w) => /^GET \/ws/.test(w)), 'la upgrade request e\' stata scritta upstream');
  assert.strictEqual(sockDestroyed, false, 'successo: nessun 502/destroy sul socket browser');
  assert.strictEqual(upDestroyed, false, 'successo: upstream non distrutto');
  assert.equal(activeSockets.has(sock), true, 'socket browser tracciato per invalidazione token');
  assert.equal(activeSockets.has(up), true, 'socket upstream tracciato per invalidazione token');
  sock.emit('close');
  assert.equal(activeSockets.size, 0, 'entrambi rimossi dal tracking alla chiusura');
});

// --- WS: (d) reject senza auth, (h) parita' + inject token, name/transitive ---

// Upstream WS fake: cattura l'Authorization ricevuta, poi completa l'handshake.
function makeWsUpstream() {
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
  server.captured = { auth: null, hits: 0 };
  server.on('upgrade', (req, socket, head) => {
    server.captured.hits += 1;
    server.captured.auth = req.headers.authorization || null;
    wss.handleUpgrade(req, socket, head, (client) => { client.send('hello-upstream'); });
  });
  return server;
}

function makeWsProxyServer({ resolveNode, readonly }) {
  const server = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://127.0.0.1').pathname.startsWith('/node')) {
      handleNodeUpgrade({ req, socket, head, resolveNode, verifyToken: (tk) => tk === LOCAL, readonly });
    } else { try { socket.destroy(); } catch (_) {} }
  });
  return server;
}

function wsExpectReject(url, opts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { ws.close(); } catch (_) {} resolve(v); } };
    ws.on('open', () => { if (!done) { done = true; try { ws.close(); } catch (_) {} reject(new Error('atteso reject, ma ha aperto')); } });
    ws.on('unexpected-response', () => fin(true));
    ws.on('error', () => fin(true));
  });
}

function wsExpectMessage(url, opts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('timeout ws')); }, 4000);
    ws.on('message', (m) => { clearTimeout(timer); try { ws.close(); } catch (_) {} resolve(String(m)); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

test('(d) WS senza auth -> reject, upstream mai toccato', async (t) => {
  const up = makeWsUpstream();
  await listen(up);
  const proxy = makeWsProxyServer({ resolveNode: () => ({ localPort: up.address().port, token: REMOTE }) });
  await listen(proxy);
  t.after(() => { proxy.close(); up.close(); });
  const url = `ws://127.0.0.1:${proxy.address().port}/node/vps/ws`;
  assert.strictEqual(await wsExpectReject(url), true);               // niente token
  assert.strictEqual(await wsExpectReject(`${url}?token=WRONG`), true); // token errato
  assert.strictEqual(up.captured.hits, 0, 'upstream non deve ricevere upgrade senza auth valida');
});

test('(h) WS parita\': upgrade autenticato arriva a upstream col token remoto iniettato', async (t) => {
  const up = makeWsUpstream();
  await listen(up);
  const upPort = up.address().port;
  const proxy = makeWsProxyServer({ resolveNode: (n) => (n === 'vps' ? { localPort: upPort, token: REMOTE } : null) });
  await listen(proxy);
  t.after(() => { proxy.close(); up.close(); });
  const pPort = proxy.address().port;

  // via Authorization header
  const m1 = await wsExpectMessage(`ws://127.0.0.1:${pPort}/node/vps/ws`, { headers: { authorization: `Bearer ${LOCAL}` } });
  assert.strictEqual(m1, 'hello-upstream');
  assert.strictEqual(up.captured.auth, `Bearer ${REMOTE}`, 'upstream deve vedere il token remoto iniettato');

  // via ?token= (browser), il token locale NON deve trapelare come auth upstream
  up.captured.auth = null;
  const m2 = await wsExpectMessage(`ws://127.0.0.1:${pPort}/node/vps/ws?token=${LOCAL}`);
  assert.strictEqual(m2, 'hello-upstream');
  assert.strictEqual(up.captured.auth, `Bearer ${REMOTE}`);
});

test('WS: name invalido e transitivo -> reject', async (t) => {
  const up = makeWsUpstream();
  await listen(up);
  const proxy = makeWsProxyServer({ resolveNode: () => ({ localPort: up.address().port, token: REMOTE }) });
  await listen(proxy);
  t.after(() => { proxy.close(); up.close(); });
  const pPort = proxy.address().port;
  const authHdr = { headers: { authorization: `Bearer ${LOCAL}` } };
  assert.strictEqual(await wsExpectReject(`ws://127.0.0.1:${pPort}/node/%2e%2e/ws`, authHdr), true);
  assert.strictEqual(await wsExpectReject(`ws://127.0.0.1:${pPort}/node/vps/node/other`, authHdr), true);
  assert.strictEqual(up.captured.hits, 0);
});

test('WS: nodo sconosciuto -> reject (name valido, non in config)', async (t) => {
  const proxy = makeWsProxyServer({ resolveNode: () => null });
  await listen(proxy);
  t.after(() => proxy.close());
  const url = `ws://127.0.0.1:${proxy.address().port}/node/ghost/ws`;
  assert.strictEqual(await wsExpectReject(url, { headers: { authorization: `Bearer ${LOCAL}` } }), true);
});

// §9d: READONLY locale nega il WS proxy in toto (piping raw = nessun readonly
// frame-level possibile; un attach WS e' un canale di scrittura verso il PTY remoto).
test('WS: READONLY locale -> reject anche autenticato, upstream mai toccato', async (t) => {
  const up = makeWsUpstream();
  await listen(up);
  const proxy = makeWsProxyServer({
    resolveNode: () => ({ localPort: up.address().port, token: REMOTE }),
    readonly: () => true,
  });
  await listen(proxy);
  t.after(() => { proxy.close(); up.close(); });
  const url = `ws://127.0.0.1:${proxy.address().port}/node/vps/ws`;
  assert.strictEqual(await wsExpectReject(url, { headers: { authorization: `Bearer ${LOCAL}` } }), true);
  assert.strictEqual(up.captured.hits, 0, 'in READONLY l\'upstream non deve ricevere upgrade');
});

// Parita' col WS: il token LOCALE in query (?token=) non deve MAI arrivare al
// nodo remoto nemmeno sul path HTTP (auth upstream = Authorization remoto).
test('HTTP: ?token= locale in query non inoltrato upstream, altri parametri passano', async (t) => {
  const up = makeUpstream();
  await listen(up);
  const app = makeProxyApp({ resolveNode: () => ({ localPort: up.address().port, token: REMOTE }) });
  const srv = await listen(http.createServer(app));
  t.after(() => { srv.close(); up.close(); });
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/node/vps/api/x?token=${LOCAL}&y=1`, { headers: auth });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(up.reqs.length, 1);
  assert.ok(!up.reqs[0].url.includes(LOCAL), 'token locale non deve arrivare upstream');
  assert.ok(up.reqs[0].url.includes('y=1'), 'gli altri parametri di query passano');
});

// --- integrazione end-to-end via createServer -------------------------------
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const nodesStore = require('../lib/nodes/store.js');
const { createServer } = require('../lib/server.js');

async function bootServer(t, { nodesPath } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncproxy-'));
  const { server, token, watcher } = createServer({
    tokenPath: path.join(dir, 'token'),
    filesRoot: path.join(dir, 'files'),
    nodesPath: nodesPath || path.join(dir, 'nodes.json'),
    fleetEnabled: false,
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); if (watcher) watcher.close(); });
  return { server, token, dir, base: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
}

test('createServer: /api/nodes redatto (token mai esposto) + stato tunnel', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncnodes-'));
  const nodesPath = path.join(dir, 'nodes.json');
  let st = nodesStore.emptyStore();
  st = nodesStore.addNode(st, { name: 'up1', ssh: 'u@h', remotePort: 41820, localPort: 43101, keyPath: '/tmp/k_ed25519', roles: { client: true, node: false } });
  st = nodesStore.setNodeToken(st, 'up1', REMOTE);
  nodesStore.atomicWriteStore(nodesPath, st);
  const { base, token } = await bootServer(t, { nodesPath });

  assert.strictEqual((await fetch(`${base}/api/nodes`)).status, 401); // gated
  const r = await fetch(`${base}/api/nodes`, { headers: { authorization: `Bearer ${token}` } });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.nodes.length, 1);
  assert.strictEqual(body.nodes[0].name, 'up1');
  assert.strictEqual(body.nodes[0].hasToken, true);
  assert.strictEqual(body.nodes[0].token, undefined, 'il token non deve mai comparire');
  assert.ok(body.nodes[0].tunnel && typeof body.nodes[0].tunnel.status === 'string');
  assert.ok(!JSON.stringify(body).includes(REMOTE), 'token remoto assente dal JSON');
});

test('createServer: proxy /node/<name> end-to-end inietta il token remoto', async (t) => {
  const upstream = makeUpstream();
  await listen(upstream);
  const upPort = upstream.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncnodes2-'));
  const nodesPath = path.join(dir, 'nodes.json');
  let st = nodesStore.emptyStore();
  st = nodesStore.addNode(st, { name: 'up1', ssh: 'u@h', remotePort: 41820, localPort: upPort, keyPath: '/tmp/k_ed25519', roles: { client: true, node: false } });
  st = nodesStore.setNodeToken(st, 'up1', REMOTE);
  nodesStore.atomicWriteStore(nodesPath, st);
  const { base, token } = await bootServer(t, { nodesPath });
  t.after(() => upstream.close());

  assert.strictEqual((await fetch(`${base}/node/up1/api/x`)).status, 401); // auth locale prima
  const ok = await fetch(`${base}/node/up1/api/x`, { headers: { authorization: `Bearer ${token}` } });
  assert.strictEqual(ok.status, 200);
  const seen = upstream.reqs.find((x) => x.url === '/api/x');
  assert.strictEqual(seen.headers.authorization, `Bearer ${REMOTE}`);
  // nodo sconosciuto -> 404 secco
  assert.strictEqual((await fetch(`${base}/node/ghost/x`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
});

test('createServer: /ws locale ancora funzionante dopo il refactor noServer (bad token -> 4401)', async (t) => {
  const { port } = await bootServer(t);
  const code = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => reject(new Error('timeout /ws')), 4000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'attach', session: 'X', token: 'bad-token' })));
    ws.on('close', (c) => { clearTimeout(timer); resolve(c); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  assert.strictEqual(code, 4401, 'il WS locale deve raggiungere bindWs e chiudere 4401 su token errato');
});

// util: porta libera (bind:0 poi chiudi)
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
