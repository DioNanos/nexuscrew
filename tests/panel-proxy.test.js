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
  assert.ok(headerNames.includes('cookie'), 'i cookie del pannello proseguono: sono suoi');
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
