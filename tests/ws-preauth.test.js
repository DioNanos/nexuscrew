'use strict';
// B2 attach remoto — preauth WS via Authorization header (parita' col proxy).
// Il proxy /node/<name> inietta `Authorization: Bearer <token del nodo>` nella
// upgrade request (§4b(2)#3) mentre il frame attach porta il token del hub: il
// nodo deve accettare l'auth dall'header. I browser non possono settare header
// sui WS -> il flusso locale (token nel frame attach) resta identico.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const nodesStore = require('../lib/nodes/store.js');
const { createServer } = require('../lib/server.js');

async function bootServer(t, { nodesPath, ...over } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncpre-'));
  const { server, token, watcher, wss } = createServer({
    home: dir,
    tokenPath: path.join(dir, 'token'),
    filesRoot: path.join(dir, 'files'),
    nodesPath: nodesPath || path.join(dir, 'nodes.json'),
    fleetEnabled: false,
    autoUpdate: false,
    tunnelSpawnImpl: () => { throw new Error('ws-preauth tests must never autostart a tunnel'); },
    ...over,
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); if (watcher) watcher.close(); });
  return { server, token, dir, port: server.address().port, wss };
}

// Apre un WS, manda il frame attach e risolve col codice di chiusura.
function attachClose(url, frame, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    const timer = setTimeout(() => { try { ws.terminate(); } catch (_) {} reject(new Error('timeout WS')); }, 5000);
    ws.on('open', () => ws.send(JSON.stringify(frame)));
    ws.on('close', (c) => { clearTimeout(timer); resolve(c); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const GHOST = `nc-ghost-${process.pid}`; // sessione inesistente: 4404 = auth passata

test('heartbeat termina websocket half-open per attivare il reconnect browser', async (t) => {
  const { port, wss } = await bootServer(t, { wsHeartbeatMs: 10 });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const peer = [...wss.clients][0];
  assert.ok(peer);
  // Simula un VERO half-open: i pong non vengono piu' processati. Senza questo,
  // il solo `isAlive = false` era una race — il client ws auto-risponde ai ping
  // e un pong in volo (dal tick precedente) riportava isAlive a true DOPO il
  // set del test: il peer sopravviveva e il test falliva in timeout (flaky
  // sotto carico). Un socket half-open reale non consegna pong: rimuovere il
  // listener riproduce esattamente quella condizione, deterministicamente.
  peer.removeAllListeners('pong');
  peer.isAlive = false;
  const code = await new Promise((resolve, reject) => {
    // Soglia larga: la terminate arriva di norma in <50ms (tick 10ms), ma la
    // suite gira in parallelo su piu' processi e 500ms andava in starvation.
    const timer = setTimeout(() => reject(new Error('heartbeat non ha terminato il client')), 5000);
    ws.once('close', (value) => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 1006);
});

test('preauth: Bearer valido su upgrade + token frame errato -> passa auth (4404, non 4401)', async (t) => {
  const { token, port } = await bootServer(t);
  const code = await attachClose(
    `ws://127.0.0.1:${port}/ws`,
    { type: 'attach', session: GHOST, token: 'token-del-hub-non-valido-qui' },
    { authorization: `Bearer ${token}` },
  );
  assert.strictEqual(code, 4404, 'preauth dall\'header deve superare il check del token frame');
});

test('preauth: Bearer NON valido su upgrade + token frame errato -> 4401 (nessun bypass)', async (t) => {
  const { port } = await bootServer(t);
  const code = await attachClose(
    `ws://127.0.0.1:${port}/ws`,
    { type: 'attach', session: GHOST, token: 'sbagliato' },
    { authorization: 'Bearer sbagliato-anche-lui' },
  );
  assert.strictEqual(code, 4401);
});

test('flusso locale invariato: token valido nel frame attach, nessun header -> passa auth (4404)', async (t) => {
  const { token, port } = await bootServer(t);
  const code = await attachClose(
    `ws://127.0.0.1:${port}/ws`,
    { type: 'attach', session: GHOST, token },
  );
  assert.strictEqual(code, 4404);
});

// End-to-end hub -> nodo: due createServer reali, nodes.json del hub punta al
// loopback del "nodo" (come farebbe il tunnel SSH) col token del nodo salvato.
// Il browser parla SOLO col hub (token locale in query per l'upgrade + nel
// frame attach): se arriva 4404 dal nodo, tutta la catena ha funzionato
// (auth locale proxy -> inject Authorization remoto -> preauth del nodo).
test('e2e /node/<name>/ws: attach remoto col solo token del hub arriva al nodo (4404)', async (t) => {
  const remote = await bootServer(t); // il "nodo"
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncpre-hub-'));
  const nodesPath = path.join(dir, 'nodes.json');
  let st = nodesStore.emptyStore();
  st = nodesStore.addNode(st, {
    name: 'up1', ssh: 'u@h', remotePort: 1, localPort: remote.port,
    keyPath: '/tmp/k_ed25519', autostart: false, roles: { client: true, node: false },
  });
  st = nodesStore.setNodeToken(st, 'up1', remote.token);
  nodesStore.atomicWriteStore(nodesPath, st);
  const hub = await bootServer(t, { nodesPath });

  // token del hub in query (auth upgrade verso il proxy) + nel frame attach:
  // esattamente cio' che manda il ws-client del browser.
  const code = await attachClose(
    `ws://127.0.0.1:${hub.port}/node/up1/ws?token=${encodeURIComponent(hub.token)}`,
    { type: 'attach', session: GHOST, token: hub.token },
  );
  assert.strictEqual(code, 4404, 'il nodo deve accettare l\'auth iniettata dal proxy');

  // senza auth locale il proxy nega l'upgrade prima di toccare il nodo
  await assert.rejects(
    attachClose(`ws://127.0.0.1:${hub.port}/node/up1/ws`, { type: 'attach', session: GHOST, token: hub.token }),
    /401/,
  );
});
