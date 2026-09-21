'use strict';
// tests/hub-attach-server-e2e.test.js — lo store della ripresa deve esistere nel
// SERVER VERO, non solo nei test. Qui non si chiama forwardUpgrade a mano: si
// avvia `lib/server.js`, si apre il ws federato come farebbe il browser, e si
// verifica che una caduta e un ritorno con la stessa identita' non riaprano
// l'upstream. Sul codice in cui lo store non e' cablato questo test e' ROSSO
// (due connessioni invece di una).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');

const PEER_ID = 'b'.repeat(32);
const ATTACH_ID = 'c'.repeat(32);

async function bootHub(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nchub-e2e-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
    topologyCachePath: path.join(configDir, 'topology-cache.json'),
  };
  nodesStore.initStore(paths.nodesPath);
  const { server, token } = createServer({ ...paths, filesRoot: path.join(dir, 'files'), port: 0 });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { try { server.close(); } catch (_) { /* idem */ } });
  return { dir, nodesPath: paths.nodesPath, port: server.address().port, token };
}

// Upstream finto che sta al posto del nodo owner: un WebSocketServer vero sulla
// porta che il peer dichiara come localPort.
async function bootUpstream(t) {
  const state = { connections: 0, sockets: [] };
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    state.connections += 1;
    state.sockets.push(ws);
    ws.on('error', () => {});
  });
  await new Promise((res) => wss.once('listening', res));
  t.after(() => { for (const ws of state.sockets) { try { ws.terminate(); } catch (_) { /* idem */ } } wss.close(); });
  return { port: wss.address().port, state };
}

const PEER_B_ID = 'e'.repeat(32);
const PEER_B_TOKEN = 'peer-b-token-abcdefghijklmnopqrstuvwxyz0123';

function addPeer(nodesPath, upstreamPort) {
  let st = nodesStore.loadStoreStrict(nodesPath);
  st = nodesStore.addNode(st, {
    name: 'peer-a', ssh: 'user@peer-a', remotePort: upstreamPort, localPort: upstreamPort, nodeId: PEER_ID,
    direction: 'outbound', shared: true, visibility: 'network', token: 'PEER-TOKEN', peerOperatorAccess: true,
  });
  // L'ingress federato: un peer diverso da quello di destinazione (canTransit
  // non ammette che un peer transiti verso se stesso).
  st = nodesStore.addNode(st, {
    name: 'peer-b', remotePort: 41998, localPort: 44998, nodeId: PEER_B_ID,
    acceptToken: PEER_B_TOKEN, direction: 'inbound', shared: true, visibility: 'network', peerOperatorAccess: true,
  });
  nodesStore.atomicWriteStore(nodesPath, st);
}

// Upgrade sul percorso FEDERATO: Bearer = acceptToken di un peer e catena
// visited, come lo costruisce il proxy di un altro nodo.
function openInboundFederatedWs(t, { port, attachId = ATTACH_ID, session = 'work-build' }) {
  const url = `ws://127.0.0.1:${port}/federation/route/peer-a/_/ws?attachId=${attachId}&attachSession=${encodeURIComponent(session)}`;
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${PEER_B_TOKEN}`, 'x-nexuscrew-visited': PEER_B_ID } });
  ws.on('error', () => {});
  const state = { messages: [], codes: [] };
  ws.on('message', (d, isBinary) => state.messages.push({ data: d.toString(), isBinary }));
  ws.on('close', (code) => state.codes.push(code));
  t.after(() => { try { ws.terminate(); } catch (_) { /* idem */ } });
  return { ws, state };
}

function openFederatedWs(t, { port, token, attachId = ATTACH_ID, session = 'work-build' }) {
  const url = `ws://127.0.0.1:${port}/api/route/peer-a/_/ws?token=${encodeURIComponent(token)}`
    + `&attachId=${attachId}&attachSession=${encodeURIComponent(session)}`;
  const ws = new WebSocket(url);
  ws.on('error', () => {});
  const state = { messages: [], codes: [] };
  ws.on('message', (d, isBinary) => state.messages.push({ data: d.toString(), isBinary }));
  ws.on('close', (code) => state.codes.push(code));
  t.after(() => { try { ws.terminate(); } catch (_) { /* idem */ } });
  return { ws, state };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(10); }
  return false;
};

test('server vero: la ripresa federata non riapre l\'upstream (lo store e\' cablato)', async (t) => {
  const { nodesPath, port, token } = await bootHub(t);
  const { port: upstreamPort, state } = await bootUpstream(t);
  addPeer(nodesPath, upstreamPort);

  const a = openFederatedWs(t, { port, token });
  await waitFor(() => a.ws.readyState === WebSocket.OPEN);
  await waitFor(() => state.connections === 1);
  assert.equal(state.connections, 1, 'la prima attach arriva all\'upstream');
  await waitFor(() => state.sockets.length === 1);
  state.sockets[0].send('PRIMA');
  await waitFor(() => a.state.messages.some((m) => m.data === 'PRIMA'));

  // Caduta del browser: l'hub deve TRATTENERE l'attach. La chiusura del TCP
  // non e' istantanea lato server, quindi si attende che l'hub la rilevi (e'
  // l'evento che fa partire la grazia).
  a.ws.terminate();
  await wait(1500);
  assert.equal(state.sockets[0]._socket ? state.sockets[0]._socket.destroyed : false, false, 'upstream trattenuta');

  // Il browser torna con la stessa identita' entro la grazia.
  const b = openFederatedWs(t, { port, token });
  await waitFor(() => b.ws.readyState === WebSocket.OPEN);
  await waitFor(() => state.connections === 2, 1500);
  assert.equal(state.connections, 1, 'nessuna nuova attach: lo store del server ha agganciato quella trattenuta');
  state.sockets[0].send('DOPO');
  await waitFor(() => b.state.messages.some((m) => m.data === 'DOPO'));
  assert.ok(b.state.messages.some((m) => m.data === 'DOPO'), 'e lo stream live riprende sul nuovo client');
});

test('server vero: un\'identita\' diversa NON aggancia (attach nuova)', async (t) => {
  const { nodesPath, port, token } = await bootHub(t);
  const { port: upstreamPort, state } = await bootUpstream(t);
  addPeer(nodesPath, upstreamPort);

  const a = openFederatedWs(t, { port, token });
  await waitFor(() => a.ws.readyState === WebSocket.OPEN);
  await waitFor(() => state.connections === 1);
  a.ws.terminate();
  await wait(1500);

  // Stessa sessione ma un attachId diverso: nessun aggancio.
  const b = openFederatedWs(t, { port, token, attachId: 'd'.repeat(32) });
  await waitFor(() => b.ws.readyState === WebSocket.OPEN);
  await waitFor(() => state.connections === 2, 2500);
  assert.equal(state.connections, 2, 'identita\' diversa: attach nuova');
});

test('server vero: anche l\'ingresso FEDERATO usa lo store (ramo /federation/route)', async (t) => {
  const { nodesPath, port } = await bootHub(t);
  const { port: upstreamPort, state } = await bootUpstream(t);
  addPeer(nodesPath, upstreamPort);

  const a = openInboundFederatedWs(t, { port });
  assert.ok(await waitFor(() => a.ws.readyState === WebSocket.OPEN, 6000), 'il primo client federato deve aprire');
  assert.ok(await waitFor(() => state.connections === 1, 6000), 'la prima attach federata arriva all\'upstream');
  a.ws.terminate();
  await wait(400);

  const b = openInboundFederatedWs(t, { port });
  assert.ok(await waitFor(() => b.ws.readyState === WebSocket.OPEN, 6000), 'il ritorno federato deve aprire');
  await waitFor(() => state.connections === 2, 1500);
  assert.equal(state.connections, 1, 'anche sul percorso federato si riprende la stessa attach');
});
