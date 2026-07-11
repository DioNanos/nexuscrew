'use strict';
// lib/proxy/node-proxy.js — reverse-proxy single-origin /node/<name> (design §4, §4b(2)).
//
// La superficie PIU' security-critical del progetto. Contratti duri (§4b(2)):
//   1. Il token LOCALE (Bearer) si verifica PRIMA di risolvere <name>. Il router
//      HTTP e' montato DIETRO requireToken; l'upgrade WS verifica il token in testa
//      a handleNodeUpgrade, prima di qualunque parsing/resolve.
//   2. <name> = chiave strict di nodes.json (^[a-z0-9-]{1,32}$), MAI usata per
//      costruire path/URL filesystem; nome non in config -> 404 secco.
//   3. Il token del nodo remoto lo inietta SOLO il proxy (da nodes.json via B0); il
//      browser non lo vede MAI. Header hop-by-hop e Authorization/cookie/host/
//      x-forwarded/proxy-* client-supplied STRIPPATI, mai inoltrati upstream.
//   4. Upstream consentito: ESCLUSIVAMENTE 127.0.0.1:<localPort> del tunnel da
//      config — mai derivato da input utente/header.
//   5. Upgrade WS: STESSI check dell'HTTP (auth locale -> name strict -> inject
//      token remoto). Parita' HTTP/WS.
//   7. NIENTE proxy transitivo: /node/<a>/node/<b> -> 404 (espone SOLO la root
//      locale del nodo remoto, mai il suo /node/*).
//   8. Nodo irraggiungibile -> 502 JSON {error}, mai hang: timeout esplicito.
//
// Niente shell, niente http-proxy: proxy manuale con http.request (HTTP) e piping
// raw socket TCP (upgrade WS). resolveNode/httpRequest/connect iniettabili (test).
const http = require('node:http');
const net = require('node:net');
const { NODE_NAME_RE } = require('../nodes/store.js');
const { bearerFrom } = require('../auth/middleware.js');

// Timeout upstream: irraggiungibile/lento -> 502, mai spinner infinito (§8).
const PROXY_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 10000;

// Metodi che mutano stato sul nodo remoto: bloccati sotto NEXUSCREW_READONLY locale.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Hop-by-hop (RFC 7230 §6.1) + Proxy-*: mai inoltrati end-to-end.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

// Header della RICHIESTA client da NON inoltrare upstream: hop-by-hop + i
// client-supplied che potrebbero (a) impersonare/derivare l'upstream o (b)
// confondere l'auth remota. Authorization viene RI-iniettato col token del nodo.
function isStrippedRequestHeader(lk) {
  if (HOP_BY_HOP.has(lk)) return true;
  if (lk === 'authorization' || lk === 'cookie' || lk === 'host') return true;
  if (lk.startsWith('proxy-')) return true;
  if (lk === 'forwarded' || lk.startsWith('x-forwarded-')) return true;
  return false;
}

// Divide "/vps/api/x?y=1" -> { name:'vps', rest:'/api/x', search:'?y=1' }.
// name RAW (non decodificato): validato poi contro l'allowlist strict, cosi'
// '..', '%2e', nomi lunghi falliscono il regex -> 404. rest/search preservano
// l'encoding originale e vengono inoltrati verbatim.
function splitNodePath(afterNode) {
  const qIdx = afterNode.indexOf('?');
  const rawPath = qIdx >= 0 ? afterNode.slice(0, qIdx) : afterNode;
  const search = qIdx >= 0 ? afterNode.slice(qIdx) : '';
  const trimmed = rawPath.replace(/^\/+/, '');
  if (!trimmed) return null; // '/node' o '/node/' senza name -> 404
  const slash = trimmed.indexOf('/');
  const name = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
  const rest = slash >= 0 ? trimmed.slice(slash) : '/';
  return { name, rest, search };
}

// Proxy transitivo: il path inoltrato NON deve a sua volta essere un /node/*.
// Controlla sia raw sia decodificato (il remoto normalizza il percent-encoding
// in fase di routing, quindi '/%6eode/b' vale '/node/b').
function isTransitiveRest(rest) {
  const hit = (p) => p === '/node' || p.startsWith('/node/');
  if (hit(rest)) return true;
  try { if (hit(decodeURIComponent(rest))) return true; } catch (_) { /* malformed: raw basta */ }
  return false;
}

// Headers per l'HTTP upstream: strip client-supplied pericolosi, inietta il token
// del nodo. host lo mette node http.request da host/port (loopback da config).
function sanitizeRequestHeaders(headers, remoteToken) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (isStrippedRequestHeader(k.toLowerCase())) continue;
    out[k] = v;
  }
  if (remoteToken) out.authorization = `Bearer ${remoteToken}`;
  return out;
}

// Headers della RISPOSTA verso il browser: strip hop-by-hop (igiene proxy). Il
// token remoto non viene MAI messo qui dal proxy; il nodo remoto non lo riflette.
function sanitizeResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function notFound(res) { res.status(404).json({ error: 'not found' }); }

// --- HTTP proxy middleware --------------------------------------------------
// Montare come: app.use('/node', requireToken(token), createNodeProxy({...}))
// -> req.url e' gia' il path DOPO /node (es. '/vps/api/x'); l'auth locale e' gia'
// passata (requireToken davanti). Ordine interno: name strict -> no-transitive ->
// resolve -> readonly -> proxy.
function createNodeProxy(deps) {
  const { resolveNode, readonly = () => false, httpRequest = http.request } = deps;
  return function nodeProxy(req, res) {
    const parsed = splitNodePath(req.url);
    if (!parsed) return notFound(res);                       // §4b(2)#2 no name
    if (!NODE_NAME_RE.test(parsed.name)) return notFound(res); // §4b(2)#2 strict/traversal
    if (isTransitiveRest(parsed.rest)) return notFound(res);   // §4b(2)#7 no transitive
    const node = resolveNode(parsed.name);
    if (!node) return notFound(res);                           // nome non in config -> 404 secco
    if (readonly() && MUTATING.has(req.method)) {
      return res.status(403).json({ error: 'READONLY: mutazione verso nodo bloccata' });
    }
    proxyHttp(req, res, node, parsed.rest, parsed.search, httpRequest);
  };
}

function proxyHttp(req, res, node, rest, search, httpRequest) {
  const options = {
    host: '127.0.0.1',                 // §4b(2)#4 upstream SOLO loopback da config
    port: node.localPort,
    method: req.method,
    // parita' col path WS: il token LOCALE eventualmente in query (?token=) non
    // deve MAI arrivare al nodo remoto — l'auth upstream e' l'Authorization col
    // token remoto iniettato da sanitizeRequestHeaders.
    path: `${rest}${stripLocalTokenQuery(search)}`,
    headers: sanitizeRequestHeaders(req.headers, node.token),
  };
  // http.request puo' lanciare in modo SINCRONO (es. header value con char
  // invalido dal token del nodo) -> senza try/catch diventa un throw non gestito
  // e Express emette una pagina 500 con lo stack (path interni). Chiudiamo in
  // 502 JSON come gli altri errori upstream, senza esporre nulla. (fix audit).
  let upstream;
  try {
    upstream = httpRequest(options, (up) => {
      res.writeHead(up.statusCode, sanitizeResponseHeaders(up.headers));
      up.pipe(res);
    });
  } catch (_) {
    if (!res.headersSent) res.status(502).json({ error: 'node non raggiungibile' });
    return;
  }
  upstream.setTimeout(PROXY_TIMEOUT_MS, () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'node non raggiungibile' });
    else res.destroy();
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

// --- WebSocket upgrade proxy (raw socket) -----------------------------------
// Stessi check dell'HTTP, ma l'auth locale va fatta in TESTA (browser non puo'
// settare Authorization sul WS -> token accettato anche via ?token=<local>).
// Proxy trasparente a livello TCP: si inoltra la stessa upgrade request (header
// sanificati + token remoto iniettato) all'upstream loopback e si fa piping raw
// dei due socket. Nessun doppio handshake: l'Accept lo calcola l'upstream dalla
// Sec-WebSocket-Key del client, che inoltriamo verbatim.
function bearerFromUpgrade(req, url) {
  const h = bearerFrom(req);
  if (h) return h;
  try { return url.searchParams.get('token') || ''; } catch (_) { return ''; }
}

function abortUpgrade(socket, code) {
  const msg = http.STATUS_CODES[code] || 'Error';
  try {
    socket.write(
      `HTTP/1.1 ${code} ${msg}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`,
    );
  } catch (_) { /* socket gia' morto */ }
  try { socket.destroy(); } catch (_) {}
}

// Costruisce il blocco header raw dell'upgrade da inoltrare upstream. Preserva i
// Sec-WebSocket-* e imposta Connection/Upgrade in modo controllato; strippa i
// client-supplied pericolosi; inietta il token remoto. Rimuove ?token= locale.
function buildUpgradeRequest(method, rest, search, headers, remoteToken, localPort) {
  const lines = [];
  const cleanSearch = stripLocalTokenQuery(search);
  lines.push(`${method} ${rest}${cleanSearch} HTTP/1.1`);
  lines.push(`Host: 127.0.0.1:${localPort}`);
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (lk === 'host') continue;
    if (lk === 'connection' || lk === 'upgrade') continue; // ri-aggiunti controllati
    if (isStrippedRequestHeader(lk)) continue;             // authorization/cookie/proxy-*/x-forwarded-*/hop-by-hop
    const val = Array.isArray(v) ? v.join(', ') : v;
    lines.push(`${k}: ${val}`);
  }
  lines.push('Connection: Upgrade');
  lines.push('Upgrade: websocket');
  if (remoteToken) lines.push(`Authorization: Bearer ${remoteToken}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function stripLocalTokenQuery(search) {
  if (!search || search === '?') return '';
  const sp = new URLSearchParams(search.slice(1));
  sp.delete('token');
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// handleNodeUpgrade — chiamato dal server.on('upgrade') per i path /node/*.
// connect(port) -> duplex verso 127.0.0.1:port (default net.connect), seam test.
function handleNodeUpgrade(ctx) {
  const {
    req, socket, head, resolveNode, verifyToken,
    readonly = () => false, connect = defaultConnect, activeSockets = null,
  } = ctx;
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return abortUpgrade(socket, 400); }

  // (1) AUTH LOCALE PRIMA DI TUTTO
  if (!verifyToken(bearerFromUpgrade(req, url))) return abortUpgrade(socket, 401);

  // (2) name strict + (7) no transitive
  const afterNode = req.url.replace(/^\/node(?=\/|\?|$)/, '');
  const parsed = splitNodePath(afterNode);
  if (!parsed || !NODE_NAME_RE.test(parsed.name)) return abortUpgrade(socket, 404);
  if (isTransitiveRest(parsed.rest)) return abortUpgrade(socket, 404);
  const node = resolveNode(parsed.name);
  if (!node) return abortUpgrade(socket, 404);

  // §9d: in READONLY locale il WS proxy si nega in toto — il piping raw non puo'
  // applicare un readonly frame-level e un attach WS e' un canale di scrittura
  // (PTY remoto). Il nodo remoto applica il PROPRIO READONLY ai suoi client;
  // qui vale quello locale, come per i metodi HTTP mutanti.
  if (readonly()) return abortUpgrade(socket, 403);

  // (3)(4) inject token remoto, upstream SOLO loopback da config
  let upstream;
  let settled = false;
  let fail = (code) => { if (settled) return; settled = true; try { upstream && upstream.destroy(); } catch (_) {} abortUpgrade(socket, code); };
  try {
    upstream = connect(node.localPort);   // net.connect puo' lanciare sync su opzioni invalide (port NaN da config)
  } catch (_) { return fail(502); }       // (parita' error-handling con proxyHttp: 502 JSON-equivalent, no stack)

  const timer = setTimeout(() => fail(502), CONNECT_TIMEOUT_MS);
  upstream.on('connect', () => {
    clearTimeout(timer);
    if (settled) { try { upstream.destroy(); } catch (_) {} return; }
    // buildUpgradeRequest/write possono lanciare (header invalido). Settle DOPO il
    // successo dei write: cosi' il catch -> fail(502) e' OPERATIVO (distrugge entrambi
    // i socket e invia 502) invece di no-op. Prima dell'audit settled veniva messo a
    // true PRIMA dei write: un throw li' rendeva fail() un no-op e lasciava entrambi i
    // socket vivi (leak) senza alcun 502 al client (audit F5).
    try {
      upstream.write(buildUpgradeRequest(req.method, parsed.rest, parsed.search, req.headers, node.token, node.localPort));
      if (head && head.length) upstream.write(head);
    } catch (e) { return fail(502); }
    settled = true;
    if (activeSockets && typeof activeSockets.add === 'function') {
      activeSockets.add(socket);
      activeSockets.add(upstream);
      const remove = () => {
        try { activeSockets.delete(socket); } catch (_) {}
        try { activeSockets.delete(upstream); } catch (_) {}
      };
      if (typeof socket.once === 'function') socket.once('close', remove);
      if (typeof upstream.once === 'function') upstream.once('close', remove);
    }
    socket.on('error', () => { try { upstream.destroy(); } catch (_) {} });
    upstream.on('error', () => { try { socket.destroy(); } catch (_) {} });
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => { clearTimeout(timer); fail(502); });
}

function defaultConnect(port) {
  return net.connect({ host: '127.0.0.1', port });
}

module.exports = {
  createNodeProxy,
  handleNodeUpgrade,
  // esposti per i test
  splitNodePath, isTransitiveRest, sanitizeRequestHeaders, sanitizeResponseHeaders,
  buildUpgradeRequest, stripLocalTokenQuery, isStrippedRequestHeader, bearerFromUpgrade,
  MUTATING, HOP_BY_HOP, PROXY_TIMEOUT_MS,
};
