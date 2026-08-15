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
async function pannelloFinto() {
  const seen = { requests: [] };
  const server = http.createServer((req, res) => {
    seen.requests.push({ url: req.url, headers: { ...req.headers } });
    if (req.url.startsWith('/page.html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><script src="/app.js"></script>pannello</html>');
      return;
    }
    if (req.url.startsWith('/app.js')) {
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
  const proxy = createPanelProxy({ resolveCellPanel });
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/api/panel/')) { res.writeHead(404); res.end(); return; }
    req.url = req.url.slice('/api/panel'.length);
    auth.panelAuthMiddleware(req, res, () => proxy(req, res));
  });
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

const richiedi = (url, { headers = {} } = {}) => fetch(url, { headers, redirect: 'manual' })
  .then(async (r) => ({ status: r.status, setCookie: r.headers.get('set-cookie'), body: await r.text() }));

// fetch POST senza body: la route del ticket non legge body.
async function postTicket(base, cell, headers = {}) {
  const r = await fetch(`${base}/api/panel/${cell}/ticket`, { method: 'POST', headers });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

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
  const auth = createPanelAuth({ verifyToken: (t2) => t2 === REMOTE_TOKEN, resolveCellPanel });
  const proxy = createPanelProxy({ resolveCellPanel });
  const remoteApi = express();
  remoteApi.use('/api', requireToken({ get: () => REMOTE_TOKEN }));
  remoteApi.use('/api/panel', auth.panelAuthMiddleware, proxy);
  const remoteApiSrv = http.createServer(remoteApi);
  await listen(remoteApiSrv);

  const remoteNodesPath = path.join(dir, 'remote-nodes.json');
  const rst = nodesStore.addNode(nodesStore.emptyStore(REMOTE_NODE_ID), {
    name: 'HUB', remotePort: 41820, localPort: 41820, direction: 'inbound', transport: 'inbound',
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
    name: 'Remoto', remotePort: 41820, localPort: remoteFedSrv.address().port,
    direction: 'inbound', transport: 'inbound', autostart: true, shared: true,
    visibility: 'network', nodeId: REMOTE_NODE_ID, token: HUB_TOKEN, acceptToken: 'd'.repeat(40),
  });
  nodesStore.atomicWriteStore(hubNodesPath, hst);
  const hubApp = express();
  hubApp.use('/api/route', requireToken({ get: () => TOKEN }), federation.routeHandler({
    nodesPath: hubNodesPath, localPort: 1, localCredential: () => 'hub', ingress: null, hopSecret: 'hopsegreto',
  }));
  const hubSrv = http.createServer(hubApp);
  await listen(hubSrv);

  return {
    base: `http://127.0.0.1:${hubSrv.address().port}`,
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
  const tk = await fetch(`${fed.base}/api/route/Remoto/_/panel/A/ticket`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(tk.status, 200, 'emissione federata del ticket');
  const { ticket } = await tk.json();
  assert.ok(ticket, 'ticket in mano');

  // 2. L'iframe remoto: prima richiesta col ticket. Sotto, l'hop federato ha
  //    iniettato il Bearer del NODO — e il ticket ha precedenza, altrimenti
  //    verrebbe inghiottito dal Bearer e il cookie non nascerebbe mai.
  const page = await richiedi(`${fed.base}/api/route/Remoto/_/panel/A/page.html?ticket=${ticket}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /pannello/);
  const sc = page.setCookie || '';
  assert.match(
    sc,
    /Path=\/api\/route\/Remoto\/_\/panel\/A;/,
    'cookie riscritto col prefisso federato: è QUESTO path che il browser usa per le sotto-risorse',
  );

  // 3. La sotto-risorsa remota passa col cookie: il giro completo, non un frame bianco.
  const cookie = sc.split(';')[0];
  const asset = await richiedi(`${fed.base}/api/route/Remoto/_/panel/A/app.js`, { headers: { cookie } });
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
  const r = await richiedi(`${fed.base}/api/route/Remoto/_/panel/A/page.html?ticket=quello-che-vuoi`);
  assert.equal(r.status, 403);
  assert.match(r.body, /panel-not-granted/, 'la causa è nominata, non collassata');
});
