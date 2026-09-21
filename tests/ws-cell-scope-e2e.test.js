'use strict';
// tests/ws-cell-scope-e2e.test.js — l'attach al terminale rispetta lo scope.
//
// DUE server reali, WebSocket federato vero. E' il test che rende non
// decorativo tutto il resto: `/ws` attacca un PTY per NOME DI SESSIONE, quindi
// se questo canale non filtra basta indovinare `cloud-Dev` e ogni permesso
// sugli elenchi diventa una tenda davanti a una porta aperta.
//
// Nota di metodo: senza il seam `sessionExistsSeam` questo test sarebbe un
// verde che non prova nulla — ogni sessione risulterebbe assente e il rifiuto
// arriverebbe comunque, anche con lo scope disattivato.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const { createServer } = require('../lib/server.js');
const store = require('../lib/nodes/store.js');

const ROOT_ID = 'a'.repeat(32);
const DEST_ID = 'd'.repeat(32);

const close = (s) => new Promise((res) => s.close(res));
const freePort = async () => {
  const s = http.createServer((_q, r) => r.end());
  await new Promise((res) => s.listen(0, '127.0.0.1', res));
  const p = s.address().port;
  await close(s);
  return p;
};

// Attach federato: root -> dest. Ritorna il codice di chiusura, oppure `null`
// se entro il tempo non arriva alcuna chiusura — che e' un esito legittimo:
// una sessione CONCESSA non viene rifiutata, e il socket resta aperto in
// attesa di un PTY che in questo ambiente non esiste. Aspettare una chiusura
// che non deve arrivare lascerebbe socket appesi e farebbe scadere l'intero
// file invece di dire cosa e' successo.
function attach(rootPort, token, session, waitMs = 2500) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${rootPort}/api/route/mac/_/ws?token=${encodeURIComponent(token)}`);
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch (_) { /* gia' chiuso */ }
      resolve(code);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'attach', session, token, cols: 80, rows: 24 })));
    ws.on('close', (c) => finish(c));
    ws.on('error', () => { /* la chiusura o il timeout decidono l'esito */ });
  });
}

async function pair(t, destPeerExtra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ws-scope-'));
  const destPort = await freePort();
  const rootPort = await freePort();

  // Il nodo DEST possiede le celle e decide chi ne vede quali.
  const destNodes = path.join(dir, 'dest-nodes.json');
  let ds = store.emptyStore(DEST_ID);
  ds = store.addNode(ds, {
    name: 'root', remotePort: rootPort, localPort: 44001, direction: 'inbound', transport: 'inbound',
    autostart: true, visibility: 'network', nodeId: ROOT_ID, token: 'dest-to-root', acceptToken: 'root-to-dest',
    ...destPeerExtra,
  });
  store.atomicWriteStore(destNodes, ds);
  const dest = createServer({
    home: dir, nodesPath: destNodes, tokenPath: path.join(dir, 'dest.token'),
    filesRoot: path.join(dir, 'dest-files'), fleetEnabled: false, port: destPort,
    // Sulle sessioni di cella il gate deve poter dire di no: qui esistono tutte.
    sessionExistsSeam: (name) => ['cloud-Dev', 'cloud-Research'].includes(name),
  });
  await new Promise((res) => dest.server.listen(destPort, '127.0.0.1', res));

  const rootNodes = path.join(dir, 'root-nodes.json');
  let rs = store.emptyStore(ROOT_ID);
  rs = store.addNode(rs, {
    name: 'mac', ssh: 'mac', remotePort: destPort, localPort: destPort, direction: 'outbound',
    transport: 'ssh', autostart: false, visibility: 'network', nodeId: DEST_ID,
    token: 'root-to-dest', acceptToken: 'dest-to-root',
  });
  store.atomicWriteStore(rootNodes, rs);
  const root = createServer({
    home: dir, nodesPath: rootNodes, tokenPath: path.join(dir, 'root.token'),
    filesRoot: path.join(dir, 'root-files'), fleetEnabled: false, port: rootPort,
  });
  await new Promise((res) => root.server.listen(rootPort, '127.0.0.1', res));

  t.after(async () => {
    await close(root.server); await close(dest.server);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { root, dest, rootPort };
}

test('un peer con scope ristretto non puo\' attaccarsi a una cella non concessa', async (t) => {
  const { root, rootPort } = await pair(t, { cellVisibility: 'selected', cells: ['Research'], peerOperatorAccess: true });
  // Fuori scope: deve chiudersi come se la sessione non esistesse. Dire "esiste
  // ma non puoi" rivelerebbe proprio cio' che lo scope nasconde.
  assert.equal(await attach(rootPort, root.token, 'cloud-Dev'), 4404);
});

test('scope none: nessuna sessione e\' attaccabile', async (t) => {
  const { root, rootPort } = await pair(t, { cellVisibility: 'none', peerOperatorAccess: true });
  assert.equal(await attach(rootPort, root.token, 'cloud-Dev'), 4404);
  assert.equal(await attach(rootPort, root.token, 'cloud-Research'), 4404);
});

// Il rifiuto fuori scope sull'upgrade deve essere INDISTINGUABILE da
// «sessione inesistente»: stessi byte sul socket (status line dell'upgrade e
// frame di close), altrimenti la risposta rivela lo stato della risorsa.
const net = require('node:net');
const nodeCrypto = require('node:crypto');

function attachRawBytes(rootPort, token, session, { sendAttach = true } = {}) {
  return new Promise((resolve) => {
    const key = nodeCrypto.randomBytes(16).toString('base64');
    const sock = net.connect(rootPort, '127.0.0.1', () => {
      sock.write(`GET /api/route/mac/_/ws?token=${encodeURIComponent(token)} HTTP/1.1\r\nHost: 127.0.0.1:${rootPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0); let statusLine = null; let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* gia' chiuso */ }
      resolve({ statusLine: statusLine || '', rest: buf });
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (statusLine === null) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep >= 0) {
          statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString();
          buf = buf.subarray(sep + 4);
          if (sendAttach) {
            const payload = Buffer.from(JSON.stringify({ type: 'attach', session, token, cols: 80, rows: 24 }));
            const mask = nodeCrypto.randomBytes(4);
            const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
            sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
          }
          setTimeout(finish, 250);
        }
      }
    });
    sock.on('error', () => finish());
    setTimeout(finish, 2000);
  });
}

test('il rifiuto fuori scope e\' indistinguibile da una sessione inesistente (stessi byte)', async (t) => {
  const conOperator = await pair(t, { peerOperatorAccess: true });
  const senza = await pair(t, {});
  const inesistente = await attachRawBytes(conOperator.rootPort, conOperator.root.token, 'cloud-NONEXISTENTE', { sendAttach: true });
  const fuoriScope = await attachRawBytes(senza.rootPort, senza.root.token, 'cloud-Dev', { sendAttach: false });
  assert.equal(inesistente.statusLine, fuoriScope.statusLine, 'stessa status line dell\'upgrade');
  assert.ok(inesistente.rest.equals(fuoriScope.rest), 'stessi byte dopo l\'handshake (frame di close)');
  assert.equal(fuoriScope.rest.subarray(fuoriScope.rest.length - 17).readUInt16BE(0), 4404, 'il frame di close e\' 4404');
});
