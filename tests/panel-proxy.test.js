'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { createPanelProxy, handlePanelUpgrade, resolveTarget } = require('../lib/proxy/panel-proxy.js');
function fakeRes() {
  const res = {
    headersSent: false, statusCode: 0, body: null, headers: null, written: [],
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; this.headersSent = true; return this; },
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; },
    destroy() { this.destroyed = true; },
  };
  return res;
}

function fakeReq(url, headers = {}) {
  const req = new EventEmitter();
  req.url = url; req.method = 'GET'; req.headers = headers;
  req.pipe = () => {};
  return req;
}

// Cattura le opzioni passate a http(s).request senza toccare la rete.
function captureRequest(seen, { emit = 'response' } = {}) {
  return function request(options, cb) {
    seen.push(options);
    const up = new EventEmitter();
    up.setTimeout = () => {}; up.end = () => {}; up.destroy = () => {};
    if (emit === 'response' && cb) {
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.pipe = () => {};
      setImmediate(() => cb(res));
    }
    return up;
  };
}

const PANEL = 'https://127.0.0.1:6901';

test('panel-proxy: la destinazione si risolve dalla cella, e i rifiuti restano distinti', async () => {
  const cases = [
    { panel: undefined, reason: 'cell-unknown' },
    { panel: '', reason: 'no-panel' },
    { panel: null, reason: 'fleet-unavailable' },
    { panel: 'https://esempio.invalido:6901', reason: 'panel-url-invalid' },
  ];
  for (const c of cases) {
    const logged = [];
    const proxy = createPanelProxy({
      resolveCellPanel: async () => c.panel,
      log: (e) => logged.push(e),
      requestImpl: captureRequest([]),
    });
    const res = fakeRes();
    await proxy(fakeReq('/Dev'), res);
    assert.equal(res.statusCode, 404, `${c.reason}: rifiuto`);
    assert.match(res.body.error, new RegExp(c.reason), `il motivo e' nominato: ${c.reason}`);
    assert.equal(logged.at(-1).reason, c.reason, 'e finisce nel log distinto, non collassato');
  }
});

test('panel-proxy: un cellId che non e\' un id di cella non arriva nemmeno al fleet', async () => {
  let interrogato = false;
  const proxy = createPanelProxy({
    resolveCellPanel: async () => { interrogato = true; return PANEL; },
    requestImpl: captureRequest([]),
  });
  const res = fakeRes();
  await proxy(fakeReq('/..%2F..%2Fetc'), res);
  assert.equal(res.statusCode, 404);
  assert.equal(interrogato, false, 'un id malformato e\' fermato prima della risoluzione');
});

test('panel-proxy: il token di NexusCrew NON prosegue verso il pannello', async () => {
  const seen = [];
  const proxy = createPanelProxy({
    resolveCellPanel: async () => PANEL,
    requestImpl: captureRequest(seen),
  });
  const res = fakeRes();
  await proxy(fakeReq('/Dev/vnc.html?token=segreto-locale&scale=1', {
    authorization: 'Bearer token-del-control-plane',
    cookie: 'sessione-del-pannello=1',
  }), res);

  assert.equal(seen.length, 1, 'la richiesta e\' partita');
  const sent = seen[0];
  const headerNames = Object.keys(sent.headers).map((h) => h.toLowerCase());
  assert.ok(!headerNames.includes('authorization'), 'nessuna Authorization verso il pannello');
  assert.ok(!/segreto-locale/.test(sent.path), 'nessun token locale nella query inoltrata');
  assert.match(sent.path, /scale=1/, 'gli altri parametri restano');
  // Avevo scritto il contrario, con la motivazione «i cookie sono del pannello»:
  // e' falsa. Dietro questo proxy l'origine e' la nostra, quindi quei cookie
  // sono i NOSTRI, e inoltrarli consegnerebbe al container la sessione del
  // control plane. Il test pinnava il difetto invece di impedirlo.
  assert.ok(!headerNames.includes('cookie'), 'nessun cookie del nostro dominio verso il pannello');
  assert.equal(sent.host, '127.0.0.1');
  assert.equal(String(sent.port), '6901');
});

test('panel-proxy: la verifica TLS si disattiva SOLO verso il loopback', async () => {
  const seen = [];
  const proxy = createPanelProxy({ resolveCellPanel: async () => PANEL, requestImpl: captureRequest(seen) });
  await proxy(fakeReq('/Dev'), fakeRes());
  assert.equal(seen[0].rejectUnauthorized, false, 'verso il container loopback la verifica e\' disattivata di proposito');

  // Il ramo opposto non e' raggiungibile dal validatore (che ammette solo
  // loopback): lo si prova sulla funzione che decide, cosi' la guardia non e'
  // una promessa scritta in un commento.
  const remoto = await resolveTarget(async () => 'https://127.0.0.1:6901', 'Dev');
  assert.equal(remoto.loopback, true);
  const t = await resolveTarget(async () => 'http://localhost:6900', 'Dev');
  assert.equal(t.loopback, true);
  assert.equal(t.secure, false, 'http resta http: nessuna opzione TLS da disattivare');
});

test('panel-proxy: un pannello che rifiuta l\'upgrade chiude, invece di lasciare il frame in attesa', async () => {
  const logged = [];
  const socket = new EventEmitter();
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = () => true;

  let upstream;
  handlePanelUpgrade({
    req: { url: '/api/panel/Dev/websockify', headers: { authorization: 'Bearer buono' } },
    socket, head: Buffer.alloc(0),
    resolveCellPanel: async () => PANEL,
    verifyToken: () => true,
    log: (e) => logged.push(e),
    requestImpl: (options) => {
      upstream = new EventEmitter();
      upstream.end = () => {};
      upstream.destroy = () => {};
      return upstream;
    },
  });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(upstream, 'la richiesta di upgrade e\' partita');
  upstream.emit('response', { statusCode: 200, headers: {} });
  assert.equal(socket.destroyed, true, 'senza upgrade il socket si chiude');
  assert.equal(logged.at(-1).reason, 'upgrade-refused', 'e il motivo lo dice');
});

test('panel-proxy: senza token valido l\'upgrade non parte nemmeno', async () => {
  const socket = new EventEmitter();
  socket.destroy = () => { socket.destroyed = true; };
  let partita = false;
  handlePanelUpgrade({
    req: { url: '/api/panel/Dev/websockify', headers: {} },
    socket, head: Buffer.alloc(0),
    resolveCellPanel: async () => { partita = true; return PANEL; },
    verifyToken: () => false,
    requestImpl: () => { partita = true; return new EventEmitter(); },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(socket.destroyed, true);
  assert.equal(partita, false, 'niente risoluzione e niente richiesta senza token');
});

// La trappola che questa feature poteva introdurre: /node/<name>/ inoltra
// QUALSIASI path verso un peer pairato. Una route nuova diventa raggiungibile da
// ogni peer nel momento in cui esiste, senza che nessuno l'abbia deciso.
test('panel-proxy: /api/panel non attraversa il pass-through generico verso i peer', () => {
  const { createNodeProxy } = require('../lib/proxy/node-proxy.js');
  const proxy = createNodeProxy({ resolveNode: () => ({ localPort: 1, token: 't' }) });
  const res = fakeRes();
  proxy({ url: '/pixel/api/panel/Dev/vnc.html', method: 'GET', headers: {}, on: () => {}, pipe: () => {} }, res);
  assert.equal(res.statusCode, 403, 'un peer non apre il pannello di questo nodo dal pass-through');
  assert.match(res.body.error, /local-only/);
});

// --- Gate federato -----------------------------------------------------------
// Il permesso non si eredita dal pairing: `panelAccess` e' per-peer e default
// negato. Due percorsi separati da coprire — HTTP e upgrade WebSocket — perche'
// il secondo non passa dal primo.
const federation = require('../lib/proxy/federation.js');

test('federazione: un peer senza panelAccess riceve un rifiuto che lo nomina', () => {
  const handler = federation.routeHandler({
    nodesPath: '/percorso/che/non/esiste.json',
    localPort: 1, localCredential: () => 't',
    ingress: { name: 'peer', panelAccess: false },
  });
  const res = fakeRes();
  handler({ url: '/_/panel/Dev/vnc.html', method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.reason, 'panel-not-granted');
});

test('federazione: con il permesso concesso il pannello prosegue oltre il gate', () => {
  const handler = federation.routeHandler({
    nodesPath: '/percorso/che/non/esiste.json',
    localPort: 1, localCredential: () => 't',
    ingress: { name: 'peer', panelAccess: true },
  });
  const res = fakeRes();
  handler({ url: '/_/panel/Dev/vnc.html', method: 'GET', headers: {} }, res);
  // Oltre il gate si ferma piu' avanti (store assente): cio' che conta e' che
  // NON sia il 403 del permesso.
  assert.notEqual(res.statusCode, 403);
  assert.equal(res.statusCode, 503);
});

test('federazione: il proprietario non e\' soggetto al gate (ingress nullo)', () => {
  const handler = federation.routeHandler({
    nodesPath: '/percorso/che/non/esiste.json',
    localPort: 1, localCredential: () => 't',
  });
  const res = fakeRes();
  handler({ url: '/_/panel/Dev/vnc.html', method: 'GET', headers: {} }, res);
  assert.notEqual(res.statusCode, 403);
});

test('federazione: anche l\'upgrade WebSocket ha il suo gate, non solo l\'HTTP', () => {
  // `reject` chiude scrivendo una risposta HTTP con socket.end(): la prova e'
  // quel codice, non un destroy che qui non arriva mai.
  function fakeSocket() {
    const sock = new EventEmitter();
    sock.scritto = '';
    sock.end = (chunk) => { sock.scritto += String(chunk || ''); sock.chiuso = true; };
    sock.write = (chunk) => { sock.scritto += String(chunk || ''); return true; };
    sock.destroy = () => { sock.chiuso = true; };
    return sock;
  }
  const negato = fakeSocket();
  federation.forwardUpgrade({
    req: { url: '/federation/route/_/panel/Dev/websockify', headers: {}, method: 'GET' },
    socket: negato, head: Buffer.alloc(0),
    nodesPath: '/percorso/che/non/esiste.json',
    localPort: 1, localCredential: () => 't',
    ingress: { name: 'peer', panelAccess: false },
  });
  assert.match(negato.scritto, /403/, 'senza permesso: rifiutato');

  // Con il permesso supera il gate e si ferma piu' avanti (store assente): la
  // differenza prova che a decidere e' stato il gate, non un errore qualsiasi
  // che assolveva per caso.
  const concesso = fakeSocket();
  federation.forwardUpgrade({
    req: { url: '/federation/route/_/panel/Dev/websockify', headers: {}, method: 'GET' },
    socket: concesso, head: Buffer.alloc(0),
    nodesPath: '/percorso/che/non/esiste.json',
    localPort: 1, localCredential: () => 't',
    ingress: { name: 'peer', panelAccess: true },
  });
  assert.match(concesso.scritto, /503/, 'oltre il gate: si ferma sullo store assente, non sul permesso');
  assert.doesNotMatch(concesso.scritto, /403/);

  // E la risorsa storica non deve essere stata toccata: /ws continua a passare
  // il primo controllo come prima.
  const ws = fakeSocket();
  federation.forwardUpgrade({
    req: { url: '/federation/route/_/ws', headers: {}, method: 'GET' },
    socket: ws, head: Buffer.alloc(0),
    nodesPath: '/percorso/che/non/esiste.json',
    localPort: 1, localCredential: () => 't',
    ingress: { name: 'peer', panelAccess: false },
  });
  assert.doesNotMatch(ws.scritto, /40[34]/, '/ws non e\' soggetto al gate del pannello');
});

test('panel-proxy: gli header che un client puo\' fingere non proseguono', async () => {
  const seen = [];
  const proxy = createPanelProxy({ resolveCellPanel: async () => PANEL, requestImpl: captureRequest(seen) });
  await proxy(fakeReq('/Dev', {
    'x-forwarded-for': '10.0.0.9',
    'x-forwarded-proto': 'https',
    forwarded: 'for=10.0.0.9',
    'proxy-authorization': 'Basic abc',
    'user-agent': 'browser-vero',
  }), fakeRes());
  const names = Object.keys(seen[0].headers).map((h) => h.toLowerCase());
  for (const vietato of ['x-forwarded-for', 'x-forwarded-proto', 'forwarded', 'proxy-authorization']) {
    assert.ok(!names.includes(vietato), `${vietato} non prosegue: un pannello potrebbe crederci`);
  }
  assert.ok(names.includes('user-agent'), 'cio\' che non impersona nessuno resta');
});

test('panel-proxy: un segmento .. si ferma qui, non lo normalizza il pannello', async () => {
  let interrogato = false;
  const proxy = createPanelProxy({
    resolveCellPanel: async () => { interrogato = true; return PANEL; },
    requestImpl: captureRequest([]),
  });
  const res = fakeRes();
  await proxy(fakeReq('/Dev/app/../../etc/segreto'), res);
  assert.equal(res.statusCode, 404);
  assert.equal(interrogato, false);

  const res2 = fakeRes();
  await proxy(fakeReq('/Dev/app/%2e%2e/altro'), res2);
  assert.equal(res2.statusCode, 404, 'anche codificato');
});

// IL BYPASS, trovato da un audit indipendente ed e' il rilievo migliore della
// nottata: l'origine di una richiesta veniva dedotta dal PATH. `/api/route` e'
// il canale del proprietario e non applica gate per-peer — ma un peer poteva
// fare arrivare quella forma attraverso il pass-through generico, e il nodo di
// destinazione la vedeva come locale. Gate saltato senza toccarlo.
test('panel-proxy: un peer non puo\' rientrare dal canale del proprietario', () => {
  const { createNodeProxy } = require('../lib/proxy/node-proxy.js');
  const proxy = createNodeProxy({ resolveNode: () => ({ localPort: 1, token: 't' }) });
  // Anche nelle forme codificate: il blocklist confronta il path grezzo E quello
  // decodificato, e un audit ha fatto notare che il test copriva solo le prime
  // due. Una lacuna di copertura su una guardia di sicurezza va chiusa: se un
  // giorno il confronto perdesse la forma decodificata, nessuno se ne
  // accorgerebbe.
  for (const url of [
    '/pixel/api/route/_/panel/Dev/vnc.html',
    '/pixel/federation/route/_/panel/Dev/vnc.html',
    '/pixel/api%2Froute/_/panel/Dev/vnc.html',
    '/pixel/api/rou%74e/_/panel/Dev/vnc.html',
  ]) {
    const res = fakeRes();
    proxy({ url, method: 'GET', headers: {}, on: () => {}, pipe: () => {} }, res);
    assert.equal(res.statusCode, 403, `${url}: la catena ha un canale suo, non passa da qui`);
    assert.match(res.body.error, /local-only/);
  }
});
