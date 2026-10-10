'use strict';
// lib/proxy/node-proxy.js — single-origin reverse proxy for /node/<name>.
//
// The MOST security-critical surface of the project. Hard contracts:
//   1. Il token LOCALE (Bearer) si verifica PRIMA di risolvere <name>. Il router
//      HTTP e' montato DIETRO requireToken; l'upgrade WS verifica il token in testa
//      a handleNodeUpgrade, prima di qualunque parsing/resolve.
//   2. <name> = chiave strict di nodes.json (^[a-z0-9-]{1,32}$), MAI usata per
//      costruire path/URL filesystem; nome non in config -> 404 secco.
// 3. Il token del nodo remoto lo inietta SOLO il proxy (da nodes.json via); il
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
const { Transform } = require('node:stream');
const { NODE_NAME_RE } = require('../nodes/store.js');
const { bearerFrom } = require('../auth/middleware.js');

// Upstream timeouts: unreachable/slow -> 502, never an endless spinner.
const PROXY_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 10000;

// Metodi che mutano stato sul nodo remoto: bloccati sotto NEXUSCREW_READONLY locale.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Path LOCAL-ONLY: non attraversano MAI la federazione via /node/<name>. La
// designazione "cella ospite Live" e' un'azione del nodo stesso: nessun peer puo'
// designare una cella di questo nodo da remoto (federazione default-deny). Il
// browser parla con /api/live-host solo sul proprio loopback.
// `/api/panel` e' local-only per la stessa ragione, piu' una sua: dietro c'e' un
// browser con sessioni gia' autenticate, e un peer pairato non deve poterlo
// aprire per il solo fatto di essere pairato. L'accesso dai nodi del proprietario
// passera' dalla via allowlistata della federazione, mai da questo pass-through
// generico — che inoltra QUALSIASI path non elencato qui.
// `/api/route` e `/federation/route` sono qui per una ragione che e' costata un
// da revisione: l'origine di una richiesta veniva dedotta dal PATH. Su /api/route il
// gestore assume di parlare col proprietario e non applica gate per-peer; ma un
// peer poteva farci arrivare quella forma ATTRAVERSO questo stesso pass-through
// (/node/<A>/api/route/_/panel/<cella>/...), e a quel punto il nodo di
// destinazione la vedeva come richiesta locale — con il gate del pannello
// saltato. La catena di inoltro ha gia' un canale suo (/api/route con i suoi
// hop): passare da qui era un secondo percorso per la stessa cosa, ed e' la
// forma di difetto che continuiamo a trovare.
const LOCAL_ONLY_PREFIXES = ['/api/live-host', '/api/panel', '/api/route', '/federation/route'];

// Hop-by-hop (RFC 7230 section 6.1) + Proxy-*: never forwarded end-to-end.
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

function connectionOptions(headers) {
  const names = new Set();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== 'connection') continue;
    const raw = Array.isArray(value) ? value.join(',') : String(value || '');
    for (const item of raw.split(',')) {
      const name = item.trim().toLowerCase();
      if (/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) names.add(name);
    }
  }
  return names;
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

// Un path local-only non e' instradabile via /node, neanche in lettura: il proxy lo
// chiude prima di resolveNode. Controlla raw e decodificato, come isTransitiveRest.
function isLocalOnly(rest) {
  const hit = (p) => LOCAL_ONLY_PREFIXES.some((px) => p === px || p.startsWith(`${px}/`));
  if (hit(rest)) return true;
  try { if (hit(decodeURIComponent(rest))) return true; } catch (_) { /* malformed: raw basta */ }
  return false;
}

// Headers per l'HTTP upstream: strip client-supplied pericolosi, inietta il token
// del nodo. host lo mette node http.request da host/port (loopback da config).
function sanitizeRequestHeaders(headers, remoteToken) {
  const out = {};
  const dynamicHop = connectionOptions(headers);
  for (const [k, v] of Object.entries(headers || {})) {
    if (isStrippedRequestHeader(k.toLowerCase()) || dynamicHop.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  if (remoteToken) out.authorization = `Bearer ${remoteToken}`;
  return out;
}

// Headers della RISPOSTA verso il browser: strip hop-by-hop (igiene proxy). Il
// token remoto non viene MAI messo qui dal proxy; il nodo remoto non lo riflette.
function sanitizeResponseHeaders(headers) {
  const out = {};
  const dynamicHop = connectionOptions(headers);
  for (const [k, v] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(k.toLowerCase()) || dynamicHop.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

// Answers of a host-only peer: the peer is published one way, so nothing it says
// may act on the origin of the PWA. Its cookies, its Clear-Site-Data and its CSP
// are dropped; the body is served sandboxed and without MIME sniffing.
const HOST_ONLY_STRIPPED_HEADERS = new Set([
  'set-cookie', 'set-cookie2', 'clear-site-data', 'content-security-policy', 'content-security-policy-report-only',
  'x-content-type-options', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'location', 'content-location', 'refresh',
]);
function sanitizeHostOnlyResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(sanitizeResponseHeaders(headers))) {
    if (HOST_ONLY_STRIPPED_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out['content-security-policy'] = "sandbox; default-src 'none'";
  out['x-content-type-options'] = 'nosniff';
  return out;
}

// The head of an upgrade answer from a host-only peer: the same headers dropped as on the HTTP
// answers (cookies, Clear-Site-Data, CSP). The head is parsed the way the most lenient consumer
// would read it, so what is dropped here cannot reappear there: the end of the head is the first
// empty line (CRLF or bare LF), lines end with CRLF or bare LF, folded (continuation) lines are
// unfolded, a header name is a strict token. Anything that does not parse that way — a bare CR, a
// NUL, a line without a colon or with a malformed name, a first line that is not a status line, a
// head over 16 KB — is refused (the stream errors, the connection is closed) instead of passed
// along. Bytes after the head pass as they are.
const HOST_ONLY_HEAD_DROPPED = new Set(['set-cookie', 'set-cookie2', 'clear-site-data', 'content-security-policy', 'content-security-policy-report-only']);
const HOST_ONLY_HEAD_MAX = 16384;
function sanitizeUpgradeHead(headText) {
  if (/\0/.test(headText) || /\r(?!\n)/.test(headText)) throw new Error('upgrade head with a NUL or a bare CR');
  const raw = headText.split(/\r?\n/);
  // The ONLY answer to an upgrade that is passed along is a 101: a refusal, a 100 Continue (an interim answer
  // that would let a second head slip through) or anything else is refused here.
  if (!/^HTTP\/1\.[01] 101(?: [^\r\n]*)?$/.test(raw[0])) throw new Error('upgrade answer of a host-only peer is not a 101');
  const logical = [];
  for (const line of raw.slice(1)) {
    if (/^[ \t]/.test(line)) {                        // obs-fold: continuation of the previous header
      if (!logical.length) throw new Error('upgrade head with a continuation before any header');
      logical[logical.length - 1] += ` ${line.trim()}`;
    } else logical.push(line);
  }
  const kept = [raw[0]];
  for (const line of logical) {
    const i = line.indexOf(':');
    if (i <= 0) throw new Error('upgrade head with a malformed header line');
    const name = line.slice(0, i).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error('upgrade head with a malformed header name');
    if (HOST_ONLY_HEAD_DROPPED.has(name.toLowerCase())) continue;
    kept.push(`${name}:${line.slice(i + 1)}`);
  }
  return `${kept.join('\r\n')}\r\n\r\n`;
}
function hostOnlyHeadFilter() {
  let buf = Buffer.alloc(0); let done = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (done) return cb(null, chunk);
      buf = Buffer.concat([buf, chunk]);
      const window = buf.toString('latin1', 0, Math.min(buf.length, HOST_ONLY_HEAD_MAX + 4));
      const m = /\r?\n\r?\n/.exec(window);
      if (!m || m.index > HOST_ONLY_HEAD_MAX) return buf.length > HOST_ONLY_HEAD_MAX ? cb(new Error('upgrade head too large')) : cb();
      let head;
      try { head = sanitizeUpgradeHead(window.slice(0, m.index)); } catch (e) { return cb(e); }
      const rest = buf.subarray(m.index + m[0].length);
      done = true; buf = null;
      return cb(null, Buffer.concat([Buffer.from(head, 'latin1'), rest]));
    },
  });
}

function notFound(res) { res.status(404).json({ error: 'not found' }); }

// --- HTTP proxy middleware --------------------------------------------------
// Montare come: app.use('/node', requireToken(token), createNodeProxy({...}))
// -> req.url e' gia' il path DOPO /node (es. '/vps/api/x'); l'auth locale e' gia'
// passata (requireToken davanti). Ordine interno: name strict -> no-transitive ->
// resolve -> readonly -> proxy.
function createNodeProxy(deps) {
  const { resolveNode, readonly = () => false, httpRequest = http.request, proxyTimeoutMs = PROXY_TIMEOUT_MS } = deps;
  return function nodeProxy(req, res) {
    const parsed = splitNodePath(req.url);
    if (!parsed) return notFound(res);                       // no name
    if (!NODE_NAME_RE.test(parsed.name)) return notFound(res); // strict/traversal
    if (isTransitiveRest(parsed.rest)) return notFound(res);   // no transitive rest
    if (isLocalOnly(parsed.rest)) {
      return res.status(403).json({ error: 'local-only: azione non instradabile via federazione' });
    }
    const node = resolveNode(parsed.name);
    if (!node) return notFound(res);                           // nome non in config -> 404 secco
    if (readonly() && MUTATING.has(req.method)) {
      return res.status(403).json({ error: 'READONLY: mutazione verso nodo bloccata' });
    }
    proxyHttp(req, res, node, parsed.rest, parsed.search, httpRequest, proxyTimeoutMs);
  };
}

function proxyHttp(req, res, node, rest, search, httpRequest, timeoutMs) {
  const options = {
    host: '127.0.0.1',                 // upstream loopback ONLY, from config
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
  // 502 JSON come gli altri errori upstream, senza esporre nulla. (fix da revisione).
  let upstream;
  try {
    upstream = httpRequest(options, (up) => {
      if (node.hostOnly === true && up.statusCode >= 300 && up.statusCode < 400) {
        // A redirect from a host-only peer would be followed by the browser WITH the owner's Authorization.
        up.resume();
        return res.status(502).json({ error: 'redirect refused', reason: 'host-only-redirect' });
      }
      res.writeHead(up.statusCode, (node.hostOnly === true ? sanitizeHostOnlyResponseHeaders : sanitizeResponseHeaders)(up.headers));
      up.pipe(res);
    });
  } catch (_) {
    if (!res.headersSent) res.status(502).json({ error: 'node non raggiungibile' });
    return;
  }
  upstream.setTimeout(timeoutMs || PROXY_TIMEOUT_MS, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on('error', (e) => {
    // Il timeout di attesa (PROXY_TIMEOUT_MS) NON è un nodo morto: il nodo
    // remoto può essere ancora al lavoro sulla richiesta (es. un avvio cella
    // oltre i 30 s). Il `cause` distinto permette al client di trattarlo
    // come attesa in corso e non come errore del nodo.
    if (!res.headersSent) {
      const waiting = e && e.message === 'upstream timeout';
      res.status(502).json(waiting
        ? { error: 'node non raggiungibile', cause: 'upstream-timeout' }
        : { error: 'node non raggiungibile' });
    } else res.destroy();
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
  const clean = sanitizeRequestHeaders(headers, remoteToken);
  lines.push(`${method} ${rest}${cleanSearch} HTTP/1.1`);
  lines.push(`Host: 127.0.0.1:${localPort}`);
  for (const [k, v] of Object.entries(clean)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'connection' || lk === 'upgrade') continue;
    const val = Array.isArray(v) ? v.join(', ') : v;
    lines.push(`${k}: ${val}`);
  }
  lines.push('Connection: Upgrade');
  lines.push('Upgrade: websocket');
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
  if (isLocalOnly(parsed.rest)) return abortUpgrade(socket, 403);
  const node = resolveNode(parsed.name);
  if (!node) return abortUpgrade(socket, 404);

  // In local READONLY the WS proxy refuses wholesale — raw piping cannot
  // apply a frame-level readonly and a WS attach is a write channel (remote
  // PTY). The remote node applies ITS OWN READONLY to its clients;
  // here the local one rules, as for mutating HTTP methods.
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
    // i socket e invia 502) invece di no-op. Prima della revisione settled veniva messo a
    // true PRIMA dei write: un throw li' rendeva fail() un no-op e lasciava entrambi i
    // socket vivi (leak) senza alcun 502 al client (da revisione).
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
    let down = upstream;
    if (node.hostOnly === true) {
      const filter = hostOnlyHeadFilter();
      filter.on('error', () => { try { upstream.destroy(); } catch (_) {} abortUpgrade(socket, 502); });
      down = upstream.pipe(filter);
    }
    down.pipe(socket);
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
  splitNodePath, isTransitiveRest, sanitizeRequestHeaders, sanitizeResponseHeaders, sanitizeHostOnlyResponseHeaders, hostOnlyHeadFilter,
  buildUpgradeRequest, stripLocalTokenQuery, isStrippedRequestHeader, connectionOptions, bearerFromUpgrade,
  MUTATING, HOP_BY_HOP, PROXY_TIMEOUT_MS,
};
