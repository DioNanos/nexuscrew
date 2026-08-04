'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createReverseSlotListeners } = require('../lib/nodes/reverse-slot-listeners.js');
const proof = require('../lib/nodes/reverse-slot-proof.js');
const { createServer } = require('../lib/server.js');
const store = require('../lib/nodes/store.js');

// attachUpgrade no-op per i test che non esercitano il canale WS.
const noopUpgrade = () => {};

// Invia un upgrade WS grezzo e restituisce la prima riga di stato piu' il
// blocco header, senza completare l'handshake.
function rawUpgrade(port, target, headers = {}) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.write([
        `GET ${target} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        'Connection: Upgrade',
        'Upgrade: websocket',
        '', '',
      ].join('\r\n'));
    });
    let buf = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      resolve(buf);
    };
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.includes('\r\n\r\n')) done();
    });
    // Un upgrade rifiutato chiude il socket senza rispondere: `close` ed
    // `error` (ECONNRESET) sono esiti attesi, non fallimenti del test.
    sock.on('close', done);
    sock.on('error', done);
    sock.setTimeout(4000, done);
  });
}

test('reverse slot listeners: ogni slot ha un target loopback distinto e prova solo la propria porta', async () => {
  const app = express(); app.use(express.json());
  const slots = createReverseSlotListeners({ app, attachUpgrade: noopUpgrade });
  app.post('/reverse-slot-proof', (req, res) => {
    if (!slots.respond(req, res)) res.status(404).end();
  });
  const common = { nodeName: 'hub', generation: 2, instanceId: 'a'.repeat(32), secret: 'directional-secret' };
  const old = await slots.open({ ...common, remotePort: 44103 });
  const fresh = await slots.open({ ...common, remotePort: 44203 });
  assert.notEqual(old.localPort, fresh.localPort);
  const ok = await proof.probeReverseSlot({ port: old.localPort, secret: common.secret, expected: { remotePort: 44103, generation: 2, instanceId: common.instanceId } });
  assert.equal(ok.owned, true);
  const relay = await proof.probeReverseSlot({ port: fresh.localPort, secret: common.secret, expected: { remotePort: 44103, generation: 2, instanceId: common.instanceId } });
  assert.equal(relay.owned, false);
  assert.equal(await slots.closePort(old.localPort), true);
  await slots.closeAll();
  assert.equal(slots.size(), 0);
});

// Guardia fail-closed: servire `app` non basta, il routing degli upgrade vive
// sull'istanza `server`. Senza questa dipendenza obbligatoria un listener
// nasce HTTP-only e degrada in silenzio. Nota: `lib/server.js` e' l'unico
// altro chiamante, quindi se smettesse di passarla il server non partirebbe
// affatto e le 22 suite che lo avviano fallirebbero.
test('reverse slot listeners: attachUpgrade e\' obbligatorio', () => {
  const app = express();
  assert.throws(() => createReverseSlotListeners({ app }), /attachUpgrade/);
  assert.throws(() => createReverseSlotListeners({ app, attachUpgrade: 'no' }), /attachUpgrade/);
});

test('reverse slot listeners: ogni server creato riceve il routing di upgrade', async () => {
  const app = express();
  const attached = [];
  const slots = createReverseSlotListeners({ app, attachUpgrade: (srv) => attached.push(srv) });
  const common = { nodeName: 'hub', generation: 1, instanceId: 'b'.repeat(32), secret: 's' };
  await slots.open({ ...common, remotePort: 44301 });
  await slots.open({ ...common, remotePort: 44302 });
  assert.equal(attached.length, 2);
  assert.equal(new Set(attached).size, 2, 'un server distinto per slot');
  await slots.closeAll();
});

// Regressione del difetto reale: l'app Express serve una SPA con catch-all, e
// prima del fix l'upgrade WS arrivato da un reverse slot listener cadeva su
// quel catch-all restituendo 200 + HTML invece di 101 -> terminale nero su
// ogni peer raggiunto via reverse pool.
test('reverse slot listeners: un upgrade sullo slot ottiene 101 e mai la SPA', async () => {
  const app = express();
  app.get(/^\/.*$/, (_req, res) => res.status(200).type('html').send('<!doctype html><html><body>SPA</body></html>'));
  const wss = new WebSocketServer({ noServer: true });
  const slots = createReverseSlotListeners({
    app,
    attachUpgrade: (srv) => srv.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url, 'http://127.0.0.1');
      if (pathname !== '/ws') { try { socket.destroy(); } catch (_) {} return; }
      wss.handleUpgrade(req, socket, head, (ws) => ws.close());
    }),
  });
  const slot = await slots.open({
    nodeName: 'hub', generation: 1, instanceId: 'c'.repeat(32), secret: 's', remotePort: 44401,
  });

  const upgraded = await rawUpgrade(slot.localPort, '/ws');
  assert.match(upgraded, /^HTTP\/1\.1 101 /, 'lo slot listener deve onorare l\'upgrade');
  assert.ok(!/<html/i.test(upgraded), 'nessun corpo HTML su un upgrade');

  // Un path non instradato non deve MAI degradare nella SPA: chiuso, non 200.
  const rejected = await rawUpgrade(slot.localPort, '/federation/route/_/ws');
  assert.ok(!/^HTTP\/1\.1 200 /.test(rejected), 'un upgrade non instradato non torna 200');
  assert.ok(!/<html/i.test(rejected), 'un upgrade non instradato non torna la SPA');

  // L'HTTP normale invece continua a servire la SPA dallo stesso listener.
  const page = await fetch(`http://127.0.0.1:${slot.localPort}/qualsiasi`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);

  wss.close();
  await slots.closeAll();
});

// Prova col ROUTER REALE, non con un handler fittizio: un wiring no-op
// soddisferebbe la guardia obbligatoria e il test dello slot, quindi qui si
// prende l'handler effettivamente registrato dal server sul listener primario
// e lo si applica a uno slot. E' anche la riproduzione del percorso federato
// che restava nero: peer -> slot listener -> upgrade -> 101.
test('reverse slot: il router reale del server porta un upgrade federato a 101', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-slot-real-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const nodesPath = path.join(configDir, 'nodes.json');
  store.initStore(nodesPath);
  let st = store.loadStoreStrict(nodesPath);
  st = store.addNode(st, {
    name: 'peer', remotePort: 41820, localPort: 44003,
    direction: 'inbound', transport: 'inbound', autostart: true, shared: true,
    visibility: 'network', nodeId: 'd'.repeat(32),
    token: 'hub-to-peer', acceptToken: 'peer-to-hub',
  });
  store.atomicWriteStore(nodesPath, st);

  const { server, app, watcher } = createServer({
    home: dir, configDir, nodesPath,
    configPath: path.join(configDir, 'config.json'),
    tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(dir, 'files'), fleetEnabled: false,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // L'handler registrato dal server sul proprio listener: e' esattamente
  // quello che server.js passa ai listener per-slot.
  const realRouter = server.listeners('upgrade')[0];
  assert.equal(typeof realRouter, 'function', 'il server primario registra un router di upgrade');

  const slots = createReverseSlotListeners({ app, attachUpgrade: (srv) => srv.on('upgrade', realRouter) });
  const slot = await slots.open({
    nodeName: 'peer', generation: 1, instanceId: 'd'.repeat(32), secret: 's', remotePort: 44003,
  });
  t.after(() => slots.closeAll());

  // Un peer autenticato col proprio acceptToken raggiunge lo slot e ottiene un
  // vero 101: prima del fix qui arrivava la SPA.
  // La catena `visited` deve terminare con il nodeId del peer autenticato:
  // e' il vincolo che impedisce a chi possiede un token di spacciarsi per un
  // altro mittente della rete. E' l'header che il peer aggiunge davvero
  // quando inoltra l'upgrade.
  const federated = await rawUpgrade(slot.localPort, '/federation/route/_/ws', {
    authorization: 'Bearer peer-to-hub',
    'x-nexuscrew-visited': 'd'.repeat(32),
  });
  assert.match(federated, /^HTTP\/1\.1 101 /, 'l\'upgrade federato sullo slot deve completare');
  assert.ok(!/<html/i.test(federated), 'nessun corpo HTML');

  // Un token di peer sconosciuto non passa, e non degrada nella SPA.
  const rejected = await rawUpgrade(slot.localPort, '/federation/route/_/ws', { authorization: 'Bearer non-un-peer' });
  assert.ok(!/^HTTP\/1\.1 (101|200) /.test(rejected), 'credenziale ignota: niente 101 e niente 200');
  assert.ok(!/<html/i.test(rejected), 'nessuna SPA su credenziale ignota');
});
