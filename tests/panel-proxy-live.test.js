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
    // Un pannello che prova a posare un cookie sulla NOSTRA origine. Non e'
    // una cattiveria teorica: qualunque applicazione web lo fa per la propria
    // sessione, e servita sotto la nostra origine finirebbe li'.
    if (req.url.startsWith('/mette-cookie')) {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': ['npanel=forgiato; Path=/api/panel/Dev', 'altro=x; Path=/'],
        'x-innocuo': 'passa',
      });
      res.end('ok');
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server, path: '/websockify' });
  // Lo stesso tentativo di `/mette-cookie`, ma nell'HANDSHAKE: la 101 e' una
  // risposta come le altre e il browser ne persiste i cookie. Passa anche un
  // header innocuo, che serve da controprova — filtrare tutto romperebbe
  // l'upgrade e un test scritto male non se ne accorgerebbe.
  wss.on('headers', (headers) => {
    headers.push('Set-Cookie: npanel=forgiato-nell-handshake; Path=/');
    headers.push('X-Innocuo-Ws: passa');
  });
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

test('dal vivo: il cookie posato nell\'HANDSHAKE non arriva al browser', async (t) => {
  const panel = await pannelloFinto();
  const proxy = await proxyVero(panel.port);
  t.after(() => { panel.wss.close(); panel.server.close(); proxy.server.close(); });

  // Il ramo HTTP toglieva `set-cookie` da sempre; il ramo upgrade copiava ogni
  // header della 101 tale e quale, quindi la stessa proprieta' valeva su una
  // via e non sull'altra. Un pannello WebSocket poteva SOVRASCRIVERE il cookie
  // di visione legittimo e rompere il pannello dell'utente dal di dentro.
  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/panel/Dev/websockify?token=buono`);
  const res = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nessun upgrade entro 5s')), 5000);
    ws.on('upgrade', (r) => { clearTimeout(timer); resolve(r); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  ws.close();

  assert.equal(res.headers['set-cookie'], undefined,
    'il pannello ha posato un cookie nella 101 e il proxy lo ha inoltrato: la porta separata protegge il DOM, non gli header');
  // Controprova: se questa fallisse, staremmo filtrando troppo — e il test
  // sopra passerebbe per il motivo sbagliato.
  assert.equal(res.headers['x-innocuo-ws'], 'passa',
    'un header innocuo dell\'handshake e\' stato tolto: il filtro e\' troppo largo');
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

test('dal vivo: panelUrl CON path — il pathname non si raddoppia', async (t) => {
  // Contratto D8 (CellPanel.jsx): il frame carica /api/panel/<cella> + il
  // pathname del panelUrl, e il browser risolve le sotto-risorse relative
  // rispetto a quell'origine: al proxy arrivano SEMPRE path assoluti del
  // pannello. Se il proxy ricompone basePath + rest, la pagina stessa diventa
  // /vnc/lite.html/vnc/lite.html: il pannello risponde 404 e il frame resta
  // su «not found». Provato nel browser vero (harness d8, cella sottovia):
  // il difetto c'e', ed e' questo.
  const panel = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/vnc/lite.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>lite</html>'); return; }
    if (u === '/vnc/app.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('ok'); return; }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => panel.listen(0, '127.0.0.1', r));
  const proxy = createPanelProxy({
    resolveCellPanel: async (cellId) => (cellId === 'Dev' ? `http://127.0.0.1:${panel.address().port}/vnc/lite.html` : undefined),
  });
  const srv = http.createServer((req, res) => {
    if (!req.url.startsWith('/api/panel/')) { res.writeHead(404); res.end(); return; }
    req.url = req.url.slice('/api/panel'.length);
    proxy(req, res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { panel.close(); srv.close(); });

  const get = (p) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${srv.address().port}${p}`, (res) => {
      let acc = ''; res.on('data', (c) => { acc += c; }); res.on('end', () => resolve({ status: res.statusCode, acc }));
    }).on('error', reject);
  });
  const page = await get('/api/panel/Dev/vnc/lite.html');
  assert.equal(page.status, 200, 'la pagina arriva: rest e gia il path del pannello, non si ricompone col basePath');
  assert.match(page.acc, /lite/);
  const sub = await get('/api/panel/Dev/vnc/app.js');
  assert.equal(sub.status, 200, 'la sotto-risorsa arriva col suo path assoluto (il browser l\'ha gia risolta)');
});

// Il pannello e' servito sotto la NOSTRA origine: un suo `Set-Cookie` atterra
// li'. Non gli aprirebbe il pannello di un'altra cella — il cookie di visione
// non e' autoportante, `verifyCookie` cerca il valore in una mappa del server
// e un valore inventato non c'e' — ma puo' sovrascrivere quello legittimo e
// rompere il pannello dell'utente dal di dentro.
//
// Il filtro riguarda SOLO `set-cookie`: gli altri header devono passare, o si
// romperebbero i pannelli veri. Percio' il test guarda i due versi.
test('dal vivo: il Set-Cookie del pannello NON raggiunge la nostra origine, gli altri header si', async (t) => {
  const { server: panel, wss } = await pannelloFinto();
  const { server: nostro } = await proxyVero(panel.address().port);
  t.after(() => { for (const c of wss.clients) c.terminate(); wss.close(); panel.close(); nostro.close(); });

  const risposta = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${nostro.address().port}/api/panel/Dev/mette-cookie`, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject);
  });

  assert.equal(risposta.status, 200, 'la richiesta arriva al pannello: il filtro non deve rompere il transito');
  assert.equal(risposta.headers['set-cookie'], undefined,
    'set-cookie del pannello filtrato: non deve poter posare cookie sulla nostra origine');
  assert.equal(risposta.headers['x-innocuo'], 'passa',
    'gli altri header passano: filtrare tutto romperebbe i pannelli veri');
});
