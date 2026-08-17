'use strict';
// Prova dal vivo dell'INGRESSO al pannello: ticket monouso + cookie di visione.
// Socket veri, nessun mock del trasporto — la stessa forma di
// panel-proxy-live.test.js, applicata a come entra l'iframe:
//
//   PWA (Bearer) chiede il ticket → iframe apre col ticket → il proxy lo
//   consuma e risponde col cookie → la pagina chiede le sotto-risorse col
//   cookie → passano.
//
// E i casi che DEVONO fallire, perché lì l'errore non si vede:
//   un ticket riusabile, un ticket di un'altra cella, un cookie fuori dalla
//   sua cella, un cookie con lo scope largo, un ticket/cookie scaduto.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { createPanelProxy, handlePanelUpgrade } = require('../lib/proxy/panel-proxy.js');
const { createPanelAuth } = require('../lib/proxy/panel-auth.js');
const federation = require('../lib/proxy/federation.js');
const nodesStore = require('../lib/nodes/store.js');
const { requireToken } = require('../lib/auth/middleware.js');

const TOKEN = 'buono';

// Un "pannello" vero: pagina + sotto-risorsa + WebSocket, e registra TUTTO
// ciò che riceve — path e header — perché i test negativi sui dati inoltrati
// (ticket, referer, cookie) si provano dal lato del container.
//
// P1 (rilievo auditor, poi misura sul pannello REALE — 2026-08-17): `scriptSrc`
// e' configurabile — di default `./assets/app.js`, RELATIVO, com'e' il
// pannello vero. Misurato dopo che l'operatore ha temporaneamente rimosso la
// Basic auth davanti al pannello per la verifica: l'HTML servito referenzia
// SOLO risorse relative — "./assets/index-*.css", "./assets/index-*.js",
// "icon.png", "manifest.json", "src/universalTouchGamepad.js" — nessun path
// assoluto, nessun tag `<base>`. Non e' piu' un'assunzione del commento
// storico di panel-auth.js: e' verificata. Un test dedicato passa comunque
// un `src` assoluto per DOCUMENTARE cosa succederebbe se quell'assunzione cambiasse
// (non e' il caso oggi) — nessuno dei due valori e' hardcoded nel test che
// consuma l'HTML: il path della sotto-risorsa si DERIVA da quello che il
// pannello ha davvero servito, mai inventato a mano.
async function pannelloFinto({ scriptSrc = './assets/app.js' } = {}) {
  const seen = { requests: [] };
  const server = http.createServer((req, res) => {
    seen.requests.push({ url: req.url, headers: { ...req.headers } });
    if (req.url.startsWith('/page.html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><script src="${scriptSrc}"></script>pannello</html>`);
      return;
    }
    if (req.url.startsWith('/assets/app.js') || req.url.startsWith('/app.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('console.log("panel");');
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server, path: '/websockify' });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => ws.send(`eco:${data}`));
    ws.send('benvenuto');
  });
  server.on('close', () => { for (const c of wss.clients) c.terminate(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, wss, port: server.address().port, seen };
}

// Il nostro lato: panelAuth + proxy montati come in produzione (l'auth sta
// davanti al proxy, il proxy non vede chi non è entrato). Orologio iniettabile
// per provare le scadenze deterministicamente.
//
// R22: montato con VERO express, stessa forma di server.js (api router sotto
// /api, /panel dentro l'api router) — non più uno strip manuale su un server
// http grezzo. Il fix dipende da `req.baseUrl`, che express popola SOLO
// quando il mount è vero: uno strip a mano lo lascerebbe `undefined` e ogni
// test qui sotto passerebbe per un motivo che in produzione non esiste.
function serverControlPlane(auth, resolveCellPanel) {
  const proxy = createPanelProxy({ resolveCellPanel });
  const app = express();
  const api = express.Router();
  api.use('/panel', auth.panelAuthMiddleware, proxy);
  app.use('/api', api);
  return http.createServer(app);
}

async function latoNostro(panelPort, { ticketTtlMs, cookieTtlMs } = {}) {
  let clock = 1_000_000;
  const resolveCellPanel = async (cellId) => {
    if (cellId === 'A' || cellId === 'B') return `http://127.0.0.1:${panelPort}`;
    return cellId === 'Spenta' ? '' : undefined;
  };
  const auth = createPanelAuth({
    verifyToken: (t) => t === TOKEN,
    resolveCellPanel,
    now: () => clock,
    ...(ticketTtlMs ? { ticketTtlMs } : {}),
    ...(cookieTtlMs ? { cookieTtlMs } : {}),
  });
  const server = serverControlPlane(auth, resolveCellPanel);
  server.on('upgrade', (req, socket, head) => {
    handlePanelUpgrade({ req, socket, head, resolveCellPanel, authorize: auth.authorizeUpgrade });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server, port: server.address().port, auth,
    avanza: (ms) => { clock += ms; },
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

// R22: il SECONDO mount — porta pannello dedicata, `panelApp.use('/panel', …)`
// SENZA nessun livello sopra (a differenza del control plane, che vive dentro
// `/api`). Stesso `auth` di `latoNostro` se condiviso da chi chiama, cosi' un
// ticket emesso dal control plane si consuma sulla porta pannello — proprio
// come in produzione, dove `panelAuth` e' UNA istanza sola condivisa dai due
// mount (server.js:614, 627, 642).
async function latoNostroPortaPannello(auth, resolveCellPanel) {
  const proxy = createPanelProxy({ resolveCellPanel });
  const panelApp = express();
  panelApp.use('/panel', auth.consumeMiddleware, proxy);
  // Stesso catch-all esplicito di server.js:652 — senza, express risponde
  // ai path fuori da /panel con la sua pagina HTML di default "Cannot GET",
  // non col 404 JSON che il test sull'assoluto (sotto) deve pinnare davvero.
  panelApp.use((_req, res) => res.status(404).json({ error: 'not found' }));
  const server = http.createServer(panelApp);
  server.on('upgrade', (req, socket, head) => {
    handlePanelUpgrade({ req, socket, head, resolveCellPanel, authorize: auth.authorizeUpgrade });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` };
}

const richiedi = (url, { headers = {} } = {}) => fetch(url, { headers, redirect: 'manual' })
  .then(async (r) => ({ status: r.status, setCookie: r.headers.get('set-cookie'), body: await r.text() }));

// fetch POST senza body: la route del ticket non legge body.
async function postTicket(base, cell, headers = {}) {
  const r = await fetch(`${base}/api/panel/${cell}/ticket`, { method: 'POST', headers });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// —— R22: il Path del cookie deve valere per il mount REALE da cui la
// richiesta e' entrata — non per una costante. Due mount, due Path diversi;
// con un solo mount il test non discrimina (il briefing lo dice alla lettera).

test('R22: control plane — Path=/api/panel/<cella>', async (t) => {
  const panel = await pannelloFinto();
  const lato = await latoNostro(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); });
  const tk = await postTicket(lato.base, 'A', { authorization: `Bearer ${TOKEN}` });
  const page = await richiedi(`${lato.base}/api/panel/A/page.html?ticket=${tk.body.ticket}`);
  assert.equal(page.status, 200);
  assert.match(page.setCookie || '', /Path=\/api\/panel\/A;/);
});

test('R22: porta pannello dedicata — Path=/panel/<cella>, NON /api/panel/<cella>', async (t) => {
  const panel = await pannelloFinto();
  const lato = await latoNostro(panel.port); // emette il ticket (control plane, dietro Bearer)
  const porta = await latoNostroPortaPannello(lato.auth, async (cellId) => (
    cellId === 'A' ? `http://127.0.0.1:${panel.port}` : undefined
  ));
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); porta.server.close(); });

  const tk = await postTicket(lato.base, 'A', { authorization: `Bearer ${TOKEN}` });
  // Il ticket si consuma sulla PORTA PANNELLO — e' li' che l'iframe apre davvero.
  const page = await richiedi(`${porta.base}/panel/A/page.html?ticket=${tk.body.ticket}`);
  assert.equal(page.status, 200);
  const sc = page.setCookie || '';
  assert.match(sc, /Path=\/panel\/A;/, 'Path della porta pannello, non del control plane');
  assert.ok(!/\/api\/panel/.test(sc), 'MAI il prefisso del control plane su questo mount');
});

// RFC 6265 §5.1.4 (path-match): un browser manda il cookie SOLO se il path
// della richiesta comincia col Path del cookie E (il Path finisce con '/',
// oppure il path della richiesta finisce esattamente li', oppure il
// carattere successivo e' '/'). Deliberatamente NON "estraggo il cookie e lo
// mando comunque" — quello bypasserebbe esattamente il meccanismo che fa
// scoprire il difetto, dando falsa sicurezza come un test verde che non
// discrimina niente.
function browserManderebbeIlCookie(cookiePath, requestPath) {
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/')
    || requestPath.length === cookiePath.length
    || requestPath[cookiePath.length] === '/';
}

// P1 (rilievo auditor sul MIO test): il path della sotto-risorsa non si
// inventa — si estrae dall'HTML che il pannello ha DAVVERO servito. Un test
// che hardcoda `requestPath` puo' restare verde su un prodotto rotto, se il
// valore inventato non e' quello che un browser costruirebbe: e' esattamente
// quello che l'auditor ha dimostrato cambiando solo quel valore.
function estraiSrcScript(html) {
  const m = /<script src="([^"]*)">/.exec(String(html || ''));
  return m ? m[1] : null;
}

// Il pannello REALE (AIDesktop) E' STATO usato come oracolo per questo: con
// la Basic auth temporaneamente rimossa dall'operatore, si e' letto l'HTML
// servito davvero — tutte risorse relative, nessun `<base>` (vedi sopra). Il
// pannello finto qui sotto riflette quella misura, non un'assunzione.

// R22 punto 3 — il test end-to-end che oggi manca: non basta che la PRIMA
// richiesta (col ticket) passi. Qui si simula la SECONDA — la sotto-risorsa
// — decidendo di mandare il cookie SOLO se il Path dichiarato dal server
// combacerebbe per un browser vero, contro un requestPath DERIVATO
// dall'HTML servito (mai inventato). Se il Path fosse quello del difetto
// originale (/api/panel/A), `browserManderebbeIlCookie` sarebbe false PRIMA
// ancora di arrivare alla richiesta, e l'assert sotto lo direbbe alla lettera
// — non un 401 generico da interpretare.
test('R22: porta pannello — la sotto-risorsa passa SOLO col cookie che un browser vero manderebbe per il path che la pagina servita dichiara davvero', async (t) => {
  const panel = await pannelloFinto(); // scriptSrc relativo di default, com'e' il pannello reale
  const lato = await latoNostro(panel.port);
  const porta = await latoNostroPortaPannello(lato.auth, async (cellId) => (
    cellId === 'A' ? `http://127.0.0.1:${panel.port}` : undefined
  ));
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); porta.server.close(); });

  const tk = await postTicket(lato.base, 'A', { authorization: `Bearer ${TOKEN}` });
  const pageUrl = `${porta.base}/panel/A/page.html`;
  const page = await richiedi(`${pageUrl}?ticket=${tk.body.ticket}`);
  assert.equal(page.status, 200);
  const src = estraiSrcScript(page.body);
  assert.ok(src, 'la pagina servita deve dichiarare la sua sotto-risorsa');
  // Risolto come farebbe il browser: relativo alla pagina, non alla root.
  const requestPath = new URL(src, pageUrl).pathname;
  assert.equal(requestPath, '/panel/A/assets/app.js', 'un src relativo si risolve sotto la directory della pagina');

  const sc = page.setCookie || '';
  const cookiePath = (/Path=([^;]+)/.exec(sc) || [])[1];
  assert.ok(cookiePath, 'il Set-Cookie deve dichiarare un Path');
  const cookiePair = sc.split(';')[0];

  const manderebbe = browserManderebbeIlCookie(cookiePath, requestPath);
  assert.ok(
    manderebbe,
    `Path=${cookiePath} non combacia con ${requestPath}: un browser vero non manderebbe MAI questo cookie qui — e' esattamente il difetto R22`,
  );

  const asset = await richiedi(`${porta.base}${requestPath}`, { headers: { cookie: cookiePair } });
  assert.equal(asset.status, 200, 'la sotto-risorsa passa: niente frame bianco sulla porta pannello');
  assert.match(asset.body, /panel/);
});

// SOLO DOCUMENTAZIONE, non un rischio aperto: il pannello reale usa risorse
// relative (misurato sopra), quindi questo caso non e' quello che AIDesktop
// serve oggi. Un path ASSOLUTO ignora la directory della pagina e si
// risolve alla ROOT del server — R22 (il Path del cookie) resta corretto,
// verificato sotto — ma la richiesta che un browser farebbe per QUESTO path
// non sarebbe nemmeno sotto `/panel`: cadrebbe nel catch-all 404 di
// `panelApp` (server.js:652) prima che panelAuth o il proxy vengano
// interpellati. Il test non "passa" nel senso di dimostrare successo — PINNA
// il comportamento per il caso non servito oggi, cosi' se un giorno il
// pannello cambiasse forma (un path assoluto ricomparisse) qualcuno se ne
// accorgerebbe da qui, non da un frame bianco in produzione.
test('R22 (documentazione — non il caso reale): un src ASSOLUTO non arriva nemmeno al middleware', async (t) => {
  const panel = await pannelloFinto({ scriptSrc: '/app.js' });
  const lato = await latoNostro(panel.port);
  const porta = await latoNostroPortaPannello(lato.auth, async (cellId) => (
    cellId === 'A' ? `http://127.0.0.1:${panel.port}` : undefined
  ));
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); porta.server.close(); });

  const tk = await postTicket(lato.base, 'A', { authorization: `Bearer ${TOKEN}` });
  const pageUrl = `${porta.base}/panel/A/page.html`;
  const page = await richiedi(`${pageUrl}?ticket=${tk.body.ticket}`);
  assert.equal(page.status, 200);
  const src = estraiSrcScript(page.body);
  assert.equal(src, '/app.js', 'banco di prova: il pannello finto serve davvero un path assoluto qui');
  const requestPath = new URL(src, pageUrl).pathname;
  assert.equal(
    requestPath, '/app.js',
    'un path assoluto ignora la directory della pagina: un browser vero lo chiede alla ROOT del server, non sotto /panel/A',
  );

  const sc = page.setCookie || '';
  assert.match(sc, /Path=\/panel\/A;/, 'R22 resta corretto: il Path del cookie segue comunque il mount');

  const asset = await richiedi(`${porta.base}${requestPath}`);
  assert.equal(asset.status, 404, 'pinnato: un path assoluto non arriva al pannello — non e\' un problema di cookie');
  assert.deepEqual(
    JSON.parse(asset.body),
    { error: 'not found' },
    'proprio il catch-all di panelApp (server.js:652), non un 404 generico qualunque',
  );
});

// R22 punto 5 — guardia: un mount non riconosciuto non deve MAI produrre un
// cookie con uno scope indovinato (Path=/ o Path=/panel nudo coprirebbero
// TUTTE le celle). mountPrefixOfForTest e' la whitelist stessa: qui si prova
// che rifiuta qualunque baseUrl fuori dai due noti, non solo quelli ovvi.
test('R22: un mount non riconosciuto non produce un Path — mai `/` ne\' `/panel` nudo', () => {
  const auth = createPanelAuth({ verifyToken: () => true, resolveCellPanel: async () => undefined });
  for (const baseUrl of [undefined, '', '/', '/api', '/api/panel/', '/PANEL', '/panel/A']) {
    assert.equal(
      auth.mountPrefixOfForTest({ baseUrl }),
      null,
      `baseUrl=${JSON.stringify(baseUrl)} deve essere rifiutato, non approssimato`,
    );
  }
  // E i due UNICI valori legittimi passano esattamente come se stessi, mai
  // riscritti o normalizzati verso qualcosa di piu' ampio.
  assert.equal(auth.mountPrefixOfForTest({ baseUrl: '/api/panel' }), '/api/panel');
  assert.equal(auth.mountPrefixOfForTest({ baseUrl: '/panel' }), '/panel');
});

test('dal vivo: il flusso dell\'iframe — ticket, cookie, sotto-risorsa — passa per intero', async (t) => {
  const panel = await pannelloFinto();
  const lato = await latoNostro(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); });

  // 1. La PWA (Bearer) chiede il ticket per la cella A.
  const tk = await postTicket(lato.base, 'A', { authorization: `Bearer ${TOKEN}` });
  assert.equal(tk.status, 200, 'emissione per la PWA autenticata');
  assert.ok(tk.body.ticket && tk.body.ticket.length >= 32, 'ticket opaco');

  // 2. L'iframe apre col ticket: HTML + Set-Cookie con lo SCOPO ESATTO del path.
  const page = await richiedi(`${lato.base}/api/panel/A/page.html?ticket=${tk.body.ticket}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /pannello/);
  const sc = page.setCookie || '';
  assert.match(sc, /Path=\/api\/panel\/A;/, 'cookie limitato al path della cella');
  assert.ok(!/Path=\/(;|$)/.test(sc), 'MAI Path=/ — lo scope largo e\' il difetto che non si vede');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.match(sc, /Max-Age=3600/);

  // 3. La pagina chiede la sotto-risorsa RELATIVA: nessuna query, solo il cookie.
  const cookie = sc.split(';')[0];
  const asset = await richiedi(`${lato.base}/api/panel/A/app.js`, { headers: { cookie } });
  assert.equal(asset.status, 200, 'la sotto-risorsa passa col cookie: niente frame bianco');
  assert.match(asset.body, /panel/);
});

test('dal vivo: il ticket e\' MONOUSO — il secondo uso cade, anche subito dopo', async (t) => {
  const panel = await pannelloFinto();
  const lato = await latoNostro(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); });
  const tk = await postTicket(lato.base, 'A', { authorization: `Bearer ${TOKEN}` });
  const primo = await richiedi(`${lato.base}/api/panel/A/page.html?ticket=${tk.body.ticket}`);
  assert.equal(primo.status, 200);
  const secondo = await richiedi(`${lato.base}/api/panel/A/page.html?ticket=${tk.body.ticket}`);
  assert.equal(secondo.status, 401, 'riuso dello stesso ticket: rifiutato, non tollerato');
});

test('dal vivo: il ticket vale per UNA cella — usato su un\'altra cella cade', async (t) => {
  const panel = await pannelloFinto();
  const lato = await latoNostro(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); });
  const tk = await postTicket(lato.base, 'A', { authorization: `Bearer ${TOKEN}` });
  const riuso = await richiedi(`${lato.base}/api/panel/B/page.html?ticket=${tk.body.ticket}`);
  assert.equal(riuso.status, 401, 'il ticket di A non apre B');
  // e resta consumato: nemmeno su A funziona piu'
  const suA = await richiedi(`${lato.base}/api/panel/A/page.html?ticket=${tk.body.ticket}`);
  assert.equal(suA.status, 401);
});

test('dal vivo: il cookie vale SOLO per la sua cella — su un\'altra cade', async (t) => {
  const panel = await pannelloFinto();
  const lato = await latoNostro(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); });
  const tk = await postTicket(lato.base, 'A', { authorization: `Bearer ${TOKEN}` });
  const page = await richiedi(`${lato.base}/api/panel/A/page.html?ticket=${tk.body.ticket}`);
  const cookie = (page.setCookie || '').split(';')[0];
  const suB = await richiedi(`${lato.base}/api/panel/B/app.js`, { headers: { cookie } });
  assert.equal(suB.status, 401, 'il cookie di A non autentica B: non e\' un\'auth dell\'origine');
});

test('dal vivo: scadenze — ticket e cookie scaduti cadono (orologio deterministico)', async (t) => {
  const panel = await pannelloFinto();
  const lato = await latoNostro(panel.port, { ticketTtlMs: 5_000, cookieTtlMs: 10_000 });
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); });
  const tk = await postTicket(lato.base, 'A', { authorization: `Bearer ${TOKEN}` });
  lato.avanza(6_000); // oltre la vita del ticket
  const scaduto = await richiedi(`${lato.base}/api/panel/A/page.html?ticket=${tk.body.ticket}`);
  assert.equal(scaduto.status, 401, 'ticket scaduto: rifiutato');

  // cookie: emesso ora, valido; poi il tempo passa oltre la sua vita.
  const tk2 = await postTicket(lato.base, 'A', { authorization: `Bearer ${TOKEN}` });
  const page = await richiedi(`${lato.base}/api/panel/A/page.html?ticket=${tk2.body.ticket}`);
  const cookie = (page.setCookie || '').split(';')[0];
  const vivo = await richiedi(`${lato.base}/api/panel/A/app.js`, { headers: { cookie } });
  assert.equal(vivo.status, 200);
  lato.avanza(11_000);
  const morto = await richiedi(`${lato.base}/api/panel/A/app.js`, { headers: { cookie } });
  assert.equal(morto.status, 401, 'cookie scaduto: la sessione di visione finisce');
});

test('dal vivo: nessuna credenziale raggiunge il pannello — niente ticket in query, niente referer, niente cookie', async (t) => {
  const panel = await pannelloFinto();
  const lato = await latoNostro(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); });
  const tk = await postTicket(lato.base, 'A', { authorization: `Bearer ${TOKEN}` });
  // La richiesta dell'iframe porta il ticket in query E un Referer (la PWA).
  await richiedi(`${lato.base}/api/panel/A/page.html?ticket=${tk.body.ticket}`, {
    headers: { referer: `${lato.base}/?segreto=${tk.body.ticket}` },
  });
  const page = panel.seen.requests.find((r) => r.url.startsWith('/page.html'));
  assert.ok(page, 'la pagina e\' arrivata al pannello');
  assert.ok(!page.url.includes('ticket='), 'il ticket NON prosegue in query verso il pannello');
  assert.ok(!('referer' in page.headers), 'il Referer non viene inoltrato: il ticket non arriva nemmeno di seconda mano');
  assert.ok(!('cookie' in page.headers), 'il cookie di visione resta dalla nostra parte');
  assert.ok(!('authorization' in page.headers), 'l\'Authorization non viene inoltrata');
});

test('dal vivo: emissione del ticket — solo la PWA autenticata, e solo per celle con pannello', async (t) => {
  const panel = await pannelloFinto();
  const lato = await latoNostro(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); });
  const anon = await postTicket(lato.base, 'A', {});
  assert.equal(anon.status, 401, 'senza Bearer non si emettono ticket');
  const sbagliato = await postTicket(lato.base, 'A', { authorization: 'Bearer sbagliato' });
  assert.equal(sbagliato.status, 401);
  const senzaPannello = await postTicket(lato.base, 'Spenta', { authorization: `Bearer ${TOKEN}` });
  assert.equal(senzaPannello.status, 404, 'cella senza pannello: nessun ticket per destinazioni che il proxy rifiuterebbe');
  const ignota = await postTicket(lato.base, 'Ignota', { authorization: `Bearer ${TOKEN}` });
  assert.equal(ignota.status, 404, 'cella sconosciuta: idem');
});

test('dal vivo: il Bearer della PWA continua a passare senza ticket (niente regressioni)', async (t) => {
  const panel = await pannelloFinto();
  const lato = await latoNostro(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); });
  const r = await richiedi(`${lato.base}/api/panel/A/page.html`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(r.status, 200);
  const nulla = await richiedi(`${lato.base}/api/panel/A/page.html`);
  assert.equal(nulla.status, 401, 'e senza niente si resta fuori');
});

test('dal vivo: il WebSocket del pannello si apre col COOKIE, e senza nulla cade', async (t) => {
  const panel = await pannelloFinto();
  const lato = await latoNostro(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); });
  const tk = await postTicket(lato.base, 'A', { authorization: `Bearer ${TOKEN}` });
  const page = await richiedi(`${lato.base}/api/panel/A/page.html?ticket=${tk.body.ticket}`);
  const cookie = (page.setCookie || '').split(';')[0];

  // La pagina nel frame apre la sua socket con URL relativo: porta solo il cookie.
  const ws = new WebSocket(`ws://127.0.0.1:${lato.port}/api/panel/A/websockify`, { headers: { cookie } });
  const ricevuti = await new Promise((resolve, reject) => {
    const out = [];
    const timer = setTimeout(() => reject(new Error('nessun frame: il pannello resterebbe nero')), 5000);
    ws.on('message', (data) => {
      out.push(String(data));
      if (out.length === 1) ws.send('ciao');
      if (out.length === 2) { clearTimeout(timer); resolve(out); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  ws.close();
  assert.equal(ricevuti[0], 'benvenuto');
  assert.equal(ricevuti[1], 'eco:ciao');

  // E il cookie dell'altra cella NON apre la socket di A.
  const tkB = await postTicket(lato.base, 'B', { authorization: `Bearer ${TOKEN}` });
  const pageB = await richiedi(`${lato.base}/api/panel/B/page.html?ticket=${tkB.body.ticket}`);
  const cookieB = (pageB.setCookie || '').split(';')[0];
  const wsSbagliato = new WebSocket(`ws://127.0.0.1:${lato.port}/api/panel/A/websockify`, { headers: { cookie: cookieB } });
  const esito = await new Promise((resolve) => {
    wsSbagliato.on('open', () => resolve('aperto'));
    wsSbagliato.on('error', () => resolve('rifiutato'));
  });
  assert.equal(esito, 'rifiutato', 'il cookie di B non apre la socket di A');
});

test('dal vivo: il ticket NON si usa sull\'upgrade WebSocket — serve il cookie (o il Bearer)', async (t) => {
  const panel = await pannelloFinto();
  const lato = await latoNostro(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); lato.server.close(); });
  const tk = await postTicket(lato.base, 'A', { authorization: `Bearer ${TOKEN}` });
  // Il ticket va consumato dalla PRIMA richiesta HTTP: se qualcuno lo mette
  // sulla socket, non vale (e non viene consumato a tradimento).
  const ws = new WebSocket(`ws://127.0.0.1:${lato.port}/api/panel/A/websockify?ticket=${tk.body.ticket}`);
  const esito = await new Promise((resolve) => {
    ws.on('open', () => resolve('aperto'));
    ws.on('error', () => resolve('rifiutato'));
  });
  assert.equal(esito, 'rifiutato', 'il ticket non e\' una chiave per l\'upgrade');
  // ...ma resta valido per la prima richiesta HTTP, che e' il flusso dell'iframe.
  const page = await richiedi(`${lato.base}/api/panel/A/page.html?ticket=${tk.body.ticket}`);
  assert.equal(page.status, 200, 'il ticket non consumato dall\'upgrade serve ancora all\'iframe');
});

// —— Il caso REMOTO: due nodi veri, la via federata allowlistata ————————
// HUB: /api/route dietro requireToken (la PWA) + routeHandler federato vero.
// REMOTO: peerRouter federato vero + server API vero (requireToken + panelAuth
// + proxy). Il pannello è quello finto di sempre. Questa è la prova che il
// cookie di visione sopravvive all'attraversamento: il nodo che lo emette lo
// scrive per il SUO path, il browser sta usando il path federato — senza la
// riscrittura del Set-Cookie le sotto-risorse remore resterebbero senza cookie
// e il frame sarebbe bianco con l'aria di funzionare.
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));

async function federazioneDiProva(panelPort, { panelAccess } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-panel-fed-'));
  const REMOTE_TOKEN = 'remoto-buono';
  // Token federativi nella forma richiesta dallo store (lunghi), e nodeId hex.
  const HUB_TOKEN = 'f'.repeat(40);      // hub -> remoto (presentato al peerRouter)
  const REMOTE_ACCEPT = HUB_TOKEN;       // il remoto riconosce l'hub da questo
  const REMOTE_TOKEN_OUT = 'e'.repeat(40); // remoto -> hub (non usato qui)
  const HUB_NODE_ID = 'a'.repeat(32);
  const REMOTE_NODE_ID = 'b'.repeat(32);

  // REMOTO: API vera + listener federato vero.
  const resolveCellPanel = async (cellId) => (cellId === 'A' ? `http://127.0.0.1:${panelPort}` : undefined);
  // Stesso segreto di hop del peerRouter qui sotto: come in server.js, dove
  // panelAuth e la federazione condividono il segreto per-processo. Cablarlo
  // e' parte del rimedio, non un aggiustamento del banco di prova — con un
  // segreto ASSENTE ogni federata sarebbe 'sospetta' e i casi cattivi
  // passerebbero per il motivo sbagliato. A discriminare i due rami e' il test
  // del ticket federato: resta 200 solo se l'hop viene davvero VERIFICATA.
  const auth = createPanelAuth({
    verifyToken: (t2) => t2 === REMOTE_TOKEN, resolveCellPanel, hopSecret: 'hopsegreto',
  });
  const proxy = createPanelProxy({ resolveCellPanel });
  const remoteApi = express();
  remoteApi.use('/api', requireToken({ get: () => REMOTE_TOKEN }));
  remoteApi.use('/api/panel', auth.panelAuthMiddleware, proxy);
  const remoteApiSrv = http.createServer(remoteApi);
  await listen(remoteApiSrv);

  const remoteNodesPath = path.join(dir, 'remote-nodes.json');
  const rst = nodesStore.addNode(nodesStore.emptyStore(REMOTE_NODE_ID), {
    name: 'hub', remotePort: 41820, localPort: 41820, direction: 'inbound', transport: 'inbound',
    autostart: true, shared: true, visibility: 'network', nodeId: HUB_NODE_ID,
    token: REMOTE_TOKEN_OUT, acceptToken: REMOTE_ACCEPT,
    ...(panelAccess !== undefined ? { panelAccess } : {}),
  });
  nodesStore.atomicWriteStore(remoteNodesPath, rst);
  const remoteFed = express();
  remoteFed.use('/federation', federation.peerRouter({
    nodesPath: remoteNodesPath, localPort: remoteApiSrv.address().port,
    localCredential: () => REMOTE_TOKEN, hopSecret: 'hopsegreto',
  }));
  const remoteFedSrv = http.createServer(remoteFed);
  await listen(remoteFedSrv);

  // HUB: la PWA entra con il Bearer, la risorsa viaggia sulla via federata.
  const hubNodesPath = path.join(dir, 'hub-nodes.json');
  const hst = nodesStore.addNode(nodesStore.emptyStore(HUB_NODE_ID), {
    name: 'remoto', remotePort: 41820, localPort: remoteFedSrv.address().port,
    direction: 'inbound', transport: 'inbound', autostart: true, shared: true,
    visibility: 'network', nodeId: REMOTE_NODE_ID, token: HUB_TOKEN, acceptToken: 'd'.repeat(40),
  });
  nodesStore.atomicWriteStore(hubNodesPath, hst);
  const hubApp = express();
  // Come in server.js: le panel-resource federate NON-ticket transitano PRIMA
  // del requireToken (l'iframe non porta header; il ticket lo valida il nodo
  // proprietario). L'emissione del ticket resta dietro Bearer.
  const hubRouter = federation.routeHandler({
    nodesPath: hubNodesPath, localPort: 1, localCredential: () => 'hub', ingress: null, hopSecret: 'hopsegreto',
  });
  hubApp.use('/api/route', (req, res, next) => {
    const i = req.url.indexOf('/_/');
    if (i !== -1) {
      const resource = req.url.slice(i + 2);
      if (/^\/panel\/[A-Za-z0-9._-]{1,32}(?:\/.*)?$/.test(resource)
        && !(req.method === 'POST' && /^\/panel\/[A-Za-z0-9._-]{1,32}\/ticket\/?$/.test(resource))) {
        return hubRouter(req, res, next);
      }
    }
    return requireToken({ get: () => TOKEN })(req, res, next);
  });
  hubApp.use('/api/route', requireToken({ get: () => TOKEN }), hubRouter);
  const hubSrv = http.createServer(hubApp);
  await listen(hubSrv);

  return {
    base: `http://127.0.0.1:${hubSrv.address().port}`,
    hubSrv, hubPort: hubSrv.address().port, hubNodesPath,
    remoteFedSrv, remoteNodesPath, remoteApiSrv, remoteApiPort: remoteApiSrv.address().port,
    remoteAuth: auth,
    close: async () => {
      for (const srv of [hubSrv, remoteFedSrv, remoteApiSrv]) await new Promise((r) => srv.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('dal vivo FEDERATO: ticket, cookie riscritto col prefisso della route, sotto-risorsa servita', async (t) => {
  const panel = await pannelloFinto();
  const fed = await federazioneDiProva(panel.port, { panelAccess: true });
  t.after(() => { panel.wss.close(); panel.server.close(); void fed.close(); });

  // 1. La PWA chiede il ticket per la cella A del nodo Remoto, via federata.
  const tk = await fetch(`${fed.base}/api/route/remoto/_/panel/A/ticket`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(tk.status, 200, 'emissione federata del ticket');
  const { ticket } = await tk.json();
  assert.ok(ticket, 'ticket in mano');

  // 2. L'iframe remoto: prima richiesta col ticket. Sotto, l'hop federato ha
  //    iniettato il Bearer del NODO — e il ticket ha precedenza, altrimenti
  //    verrebbe inghiottito dal Bearer e il cookie non nascerebbe mai.
  const page = await richiedi(`${fed.base}/api/route/remoto/_/panel/A/page.html?ticket=${ticket}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /pannello/);
  const sc = page.setCookie || '';
  assert.match(
    sc,
    /Path=\/api\/route\/remoto\/_\/panel\/A;/,
    'cookie riscritto col prefisso federato: è QUESTO path che il browser usa per le sotto-risorse',
  );

  // 3. La sotto-risorsa remota passa col cookie: il giro completo, non un frame bianco.
  const cookie = sc.split(';')[0];
  const asset = await richiedi(`${fed.base}/api/route/remoto/_/panel/A/app.js`, { headers: { cookie } });
  assert.equal(asset.status, 200, 'la sotto-risorsa remota è servita col cookie di visione');
  assert.match(asset.body, /panel/);
});

test('dal vivo FEDERATO: nodo che NON concede panelAccess → 403 panel-not-granted al browser, non un frame bianco', async (t) => {
  const panel = await pannelloFinto();
  const fed = await federazioneDiProva(panel.port, { panelAccess: false });
  t.after(() => { panel.wss.close(); panel.server.close(); void fed.close(); });

  // Il gate sta sul nodo che possiede il pannello: il rifiuto attraversa la
  // federazione e arriva al browser COME CAUSA con nome — è lo stato
  // 'not-granted' del CellPanel, con la sua azione (concedere sul nodo).
  const r = await richiedi(`${fed.base}/api/route/remoto/_/panel/A/page.html?ticket=quello-che-vuoi`);
  assert.equal(r.status, 403);
  assert.match(r.body, /panel-not-granted/, 'la causa è nominata, non collassata');
});

test('dal vivo FEDERATO: la WebSocket del pannello remoto attraversa l\'hub col cookie di visione', async (t) => {
  const panel = await pannelloFinto();
  const fed = await federazioneDiProva(panel.port, { panelAccess: true });
  t.after(() => { panel.wss.close(); panel.server.close(); void fed.close(); });
  // Gli upgrade dell'hub: come in server.js, le panel federate col cookie
  // transitano anche senza token (decide il nodo proprietario).
  fed.hubSrv.on('upgrade', (req, socket, head) => {
    const panelFed = /^\/api\/route\/[^?#]*\/_\/panel\/[A-Za-z0-9._-]{1,32}(?:\/.*)?$/.test(req.url)
      && /(?:^|;\s*)npanel=/.test(String(req.headers.cookie || ''));
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!panelFed && bearer !== TOKEN) return socket.destroy();
    federation.forwardUpgrade({
      req, socket, head, nodesPath: fed.hubNodesPath, localPort: 1,
      localCredential: () => 'hub', ingress: null, hopSecret: 'hopsegreto',
    });
  });
  // Gli upgrade del nodo remoto: il peer si identifica col token federativo.
  fed.remoteFedSrv.on('upgrade', (req, socket, head) => {
    const ingress = federation.peerFromToken(fed.remoteNodesPath, String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!ingress) return socket.destroy();
    federation.forwardUpgrade({
      req, socket, head, nodesPath: fed.remoteNodesPath, localPort: fed.remoteApiPort,
      localCredential: () => 'remoto-buono', ingress, hopSecret: 'hopsegreto',
    });
  });
  // E l'upgrade dell'API remota finisce nel pannello, come in server.js.
  fed.remoteApiSrv.on('upgrade', (req, socket, head) => {
    handlePanelUpgrade({
      req, socket, head, resolveCellPanel: async (id) => (id === 'A' ? `http://127.0.0.1:${panel.port}` : undefined),
      authorize: fed.remoteAuth.authorizeUpgrade,
    });
  });

  // Il flusso del browser: ticket federato → prima richiesta (cookie) → ws.
  const tk = await fetch(`${fed.base}/api/route/remoto/_/panel/A/ticket`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(tk.status, 200);
  const { ticket } = await tk.json();
  const page = await richiedi(`${fed.base}/api/route/remoto/_/panel/A/page.html?ticket=${ticket}`);
  assert.equal(page.status, 200);
  const cookie = (page.setCookie || '').split(';')[0];

  const ws = new WebSocket(`ws://127.0.0.1:${fed.hubPort}/api/route/remoto/_/panel/A/websockify`, { headers: { cookie } });
  const ricevuti = await new Promise((resolve, reject) => {
    const out = [];
    const timer = setTimeout(() => reject(new Error('nessun frame: il pannello remoto resterebbe nero')), 5000);
    ws.on('message', (data) => {
      out.push(String(data));
      if (out.length === 1) ws.send('ciao');
      if (out.length === 2) { clearTimeout(timer); resolve(out); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  ws.close();
  assert.equal(ricevuti[0], 'benvenuto');
  assert.equal(ricevuti[1], 'eco:ciao');
});

// —— I DUE CASI CATTIVI della via federata (chiusura di sicurezza) ————————
// ROSSI FINO AL RIMEDIO: riproducono la catena che l'audit ha aperto. Un
// processo locale dell'hub — di qualunque utente, perché il bind su loopback
// non isola per utente — raggiunge la via federata SENZA alcun token
// dell'hub. L'ultimo hop entra nell'API del nodo proprietario col BEARER
// DEL NODO, e il panelAuth di là lo accetta come fosse la PWA: il contenuto
// esce. Questi test lo provano in modo eseguibile: finché sono rossi, il
// difetto è aperto; il rimedio (hop proof VERIFICATA: federata ⇒ il Bearer
// del nodo non vale, servono ticket/cookie del proprietario) li gira verdi.
test('DIFETTO APERTO (finché rosso): solo il transito federato — nessun ticket, nessun cookie — NON deve servire il pannello', async (t) => {
  const panel = await pannelloFinto();
  const fed = await federazioneDiProva(panel.port, { panelAccess: true });
  t.after(() => { panel.wss.close(); panel.server.close(); void fed.close(); });
  const r = await richiedi(`${fed.base}/api/route/remoto/_/panel/A/page.html`);
  assert.equal(r.status, 401, 'chi non ha né ticket né cookie non vede il pannello di un nodo remoto');
  assert.ok(!/pannello/.test(r.body), 'e soprattutto non ne vede il CONTENUTO');
});

test('DIFETTO APERTO (finché rosso): cookie FABBRICATO più il Bearer dell\'hop NON deve servire il pannello', async (t) => {
  const panel = await pannelloFinto();
  const fed = await federazioneDiProva(panel.port, { panelAccess: true });
  t.after(() => { panel.wss.close(); panel.server.close(); void fed.close(); });
  const r = await richiedi(`${fed.base}/api/route/remoto/_/panel/A/page.html`, {
    headers: { cookie: 'npanel=valore-fabbricato-senza-aver-mai-preso-un-ticket' },
  });
  assert.equal(r.status, 401, 'un cookie inventato non è un ingresso');
  assert.ok(!/pannello/.test(r.body));
});

// E la stessa cosa sull'UPGRADE, che è un percorso separato: forwardUpgrade non
// passa dal middleware, quindi il confine va scritto due volte e provato due
// volte. Per un pannello questa è la porta che conta — i frame arrivano da qui —
// e senza questo caso la guardia dell'upgrade non avrebbe colore: si potrebbe
// toglierla e il gate resterebbe verde.
//
// Il cookie è FABBRICATO apposta: serve ad attraversare l'hub (che lascia
// transitare le panel federate che ne portano uno, perché a decidere è il nodo
// proprietario) e ad arrivare fin dove sta la guardia. Di là il Bearer è quello
// dell'hop, e da solo non deve aprire nulla.
test('DIFETTO se cade: la WebSocket federata col Bearer dell\'hop e un cookie fabbricato NON deve aprirsi', async (t) => {
  const panel = await pannelloFinto();
  const fed = await federazioneDiProva(panel.port, { panelAccess: true });
  t.after(() => { panel.wss.close(); panel.server.close(); void fed.close(); });

  fed.hubSrv.on('upgrade', (req, socket, head) => {
    const panelFed = /^\/api\/route\/[^?#]*\/_\/panel\/[A-Za-z0-9._-]{1,32}(?:\/.*)?$/.test(req.url)
      && /(?:^|;\s*)npanel=/.test(String(req.headers.cookie || ''));
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!panelFed && bearer !== TOKEN) return socket.destroy();
    federation.forwardUpgrade({
      req, socket, head, nodesPath: fed.hubNodesPath, localPort: 1,
      localCredential: () => 'hub', ingress: null, hopSecret: 'hopsegreto',
    });
  });
  fed.remoteFedSrv.on('upgrade', (req, socket, head) => {
    const ingress = federation.peerFromToken(fed.remoteNodesPath, String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!ingress) return socket.destroy();
    federation.forwardUpgrade({
      req, socket, head, nodesPath: fed.remoteNodesPath, localPort: fed.remoteApiPort,
      localCredential: () => 'remoto-buono', ingress, hopSecret: 'hopsegreto',
    });
  });
  fed.remoteApiSrv.on('upgrade', (req, socket, head) => {
    handlePanelUpgrade({
      req, socket, head, resolveCellPanel: async (id) => (id === 'A' ? `http://127.0.0.1:${panel.port}` : undefined),
      authorize: fed.remoteAuth.authorizeUpgrade,
    });
  });

  const ws = new WebSocket(`ws://127.0.0.1:${fed.hubPort}/api/route/remoto/_/panel/A/websockify`, {
    headers: { cookie: 'npanel=valore-fabbricato-senza-aver-mai-preso-un-ticket' },
  });
  const esito = await new Promise((resolve) => {
    // Un esito esplicito in entrambi i versi: aperta o messaggio = il pannello
    // remoto sarebbe servito; error/close = respinta. Il timer non decide nulla,
    // dichiara solo che nessuno dei due è arrivato.
    const timer = setTimeout(() => resolve('nessun esito'), 5000);
    const fine = (v) => { clearTimeout(timer); resolve(v); };
    ws.on('open', () => fine('aperta'));
    ws.on('message', () => fine('aperta'));
    ws.on('error', () => fine('respinta'));
    ws.on('close', () => fine('respinta'));
  });
  try { ws.close(); } catch (_) { /* già chiusa */ }
  assert.equal(esito, 'respinta', 'senza un cookie VERO la socket del pannello remoto non si apre');
});
