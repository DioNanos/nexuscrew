'use strict';
// Prova dal vivo dell'inoltro del pannello: socket veri, nessun mock del
// trasporto. Serve perche' un pannello che si apre senza ricevere i propri
// frame e' NERO, e un inoltro solo-HTTP darebbe esattamente quello — con
// l'aria di funzionare. La suite mockata prova le decisioni; questa prova che
// i byte passino.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');
const { createPanelProxy, handlePanelUpgrade } = require('../lib/proxy/panel-proxy.js');

// Un "pannello" vero: HTTP + WebSocket sulla stessa porta loopback, come fa un
// desktop in container.
async function pannelloFinto() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/vnc.html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>pannello</html>');
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
  return { server, wss, port: server.address().port };
}

// Il nostro lato: monta il proxy su un server vero, con l'upgrade instradato
// come in produzione.
async function proxyVero(panelPort) {
  const resolveCellPanel = async (cellId) => (cellId === 'Dev' ? `http://127.0.0.1:${panelPort}` : undefined);
  const proxy = createPanelProxy({ resolveCellPanel });
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/api/panel/')) { res.writeHead(404); res.end(); return; }
    req.url = req.url.slice('/api/panel'.length);
    proxy(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    handlePanelUpgrade({ req, socket, head, resolveCellPanel, verifyToken: (t) => t === 'buono' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

test('dal vivo: il contenuto del pannello arriva attraverso il proxy', async (t) => {
  const panel = await pannelloFinto();
  const proxy = await proxyVero(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); proxy.server.close(); });

  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxy.port}/api/panel/Dev/vnc.html`, (res) => {
      let acc = ''; res.on('data', (c) => { acc += c; }); res.on('end', () => resolve({ status: res.statusCode, acc }));
    }).on('error', reject);
  });
  assert.equal(body.status, 200);
  assert.match(body.acc, /pannello/);
});

test('dal vivo: i frame WebSocket attraversano il proxy nei DUE sensi', async (t) => {
  const panel = await pannelloFinto();
  const proxy = await proxyVero(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); proxy.server.close(); });

  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/panel/Dev/websockify?token=buono`);
  const ricevuti = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nessun frame entro 5s: il pannello resterebbe nero')), 5000);
    ws.on('message', (data) => {
      ricevuti.push(String(data));
      if (ricevuti.length === 1) ws.send('ciao');
      if (ricevuti.length === 2) { clearTimeout(timer); resolve(); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  ws.close();

  // Il primo arriva dal pannello senza che nessuno lo chieda (server -> client),
  // il secondo e' la risposta a cio' che abbiamo mandato noi (client -> server
  // -> client). Insieme provano il piping nei due sensi: un proxy solo-HTTP non
  // avrebbe consegnato nessuno dei due.
  assert.equal(ricevuti[0], 'benvenuto');
  assert.equal(ricevuti[1], 'eco:ciao');
});

test('dal vivo: senza token valido l\'upgrade non si apre', async (t) => {
  const panel = await pannelloFinto();
  const proxy = await proxyVero(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); proxy.server.close(); });

  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/panel/Dev/websockify?token=sbagliato`);
  const esito = await new Promise((resolve) => {
    ws.on('open', () => resolve('aperto'));
    ws.on('error', () => resolve('rifiutato'));
  });
  assert.equal(esito, 'rifiutato');
});

test('dal vivo: una cella senza pannello non apre nulla, e non e\' un errore generico', async (t) => {
  const panel = await pannelloFinto();
  const proxy = await proxyVero(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); proxy.server.close(); });

  const res = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxy.port}/api/panel/Ignota/vnc.html`, (r) => {
      let acc = ''; r.on('data', (c) => { acc += c; }); r.on('end', () => resolve({ status: r.statusCode, acc }));
    }).on('error', reject);
  });
  assert.equal(res.status, 404);
  assert.match(res.acc, /cell-unknown/, 'il motivo e\' nella risposta, non solo nei log');
});
