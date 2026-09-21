'use strict';
// tests/federation-hub-ws.test.js — i casi di PROTOCOLLO della ripresa, con
// `ws` VERA da entrambi i lati. I test a TCP finto non vedevano il difetto:
// scrivevano testo nudo, quindi un payload de-mascherabile o un frame
// re-incapsulato passavano per buoni. Qui un frame sbagliato fa chiudere il
// peer con 1002, e il test lo vede.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { WebSocketServer, WebSocket } = require('ws');
const federation = require('../lib/proxy/federation.js');
const store = require('../lib/nodes/store.js');

const PEER_ID = 'b'.repeat(32);
const ATTACH_ID = 'a'.repeat(32);
const TOKEN = 'TOK';

function bootStore(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncws-proto-'));
  const nodesPath = path.join(dir, 'nodes.json');
  store.initStore(nodesPath);
  let st = store.loadStoreStrict(nodesPath);
  st = store.addNode(st, {
    name: 'peer-a', remotePort: 41999, localPort: 44999, nodeId: PEER_ID,
    acceptToken: 'ACC', direction: 'inbound', shared: true, visibility: 'network', token: 'PEER-TOKEN',
    ...over,
  });
  store.atomicWriteStore(nodesPath, st);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { nodesPath };
}

// Upstream VERO: un WebSocketServer. Conta le attach, registra i messaggi.
async function realUpstream(t) {
  const state = { connections: 0, received: [], sockets: [], codes: [] };
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    state.connections += 1;
    state.sockets.push(ws);
    ws.on('error', () => {});
    ws.on('close', (code) => state.codes.push(code));
    ws.on('message', (data, isBinary) => { state.received.push({ data: data.toString(), isBinary }); });
  });
  await new Promise((res) => wss.once('listening', res));
  t.after(() => { for (const ws of state.sockets) { try { ws.terminate(); } catch (_) { /* idem */ } } wss.close(); });
  return { port: wss.address().port, state };
}

// Proxy: net server che legge l'handshake VERO del client (la sua
// Sec-WebSocket-Key deve essere quella che finisce nell'Accept) e chiama
// forwardUpgrade con una req costruita sulla query che serve al caso.
async function proxyFor(t, { nodesPath, port, hubAttaches, url, ingress }) {
  // `url` puo' essere una funzione: alcuni casi cambiano identita' fra un
  // upgrade e il successivo.
  const urlOf = typeof url === 'function' ? url : () => url;
  const srv = net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      sock.removeListener('data', onData);
      const lines = buf.split('\r\n');
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      federation.forwardUpgrade({
        req: { url: urlOf(), method: 'GET', headers: { ...headers, 'x-nexuscrew-visited': PEER_ID } },
        socket: sock, head: null, nodesPath, localPort: port,
        localCredential: () => 'LOCAL-TOKEN',
        ingress: ingress || { nodeId: PEER_ID, visibility: 'network', shared: true, peerOperatorAccess: true },
        hubAttaches,
      });
    };
    sock.on('data', onData);
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  t.after(() => srv.close());
  return srv.address().port;
}

function connectClient(t, proxyPort) {
  const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws`);
  ws.on('error', () => {});
  const state = { messages: [], codes: [] };
  ws.on('message', (data, isBinary) => state.messages.push({ data: data.toString(), isBinary }));
  ws.on('close', (code) => state.codes.push(code));
  t.after(() => { try { ws.terminate(); } catch (_) { /* idem */ } });
  return { ws, state };
}

const query = ({ token = TOKEN, attachId = ATTACH_ID, session = 'work-build' } = {}) =>
  `/federation/route/_/ws?token=${encodeURIComponent(token)}&attachId=${attachId}&attachSession=${encodeURIComponent(session)}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(10); }
  return false;
};

test('protocollo: la ripresa e\' un passthrough di frame (niente 1002, round-trip vivo)', async (t) => {
  const { nodesPath } = bootStore(t);
  const { port, state } = await realUpstream(t);
  const hubAttaches = federation.createHubAttachStore({ graceMs: 3000, maxAttaches: 8, ringBytes: 4096 });
  const proxyPort = await proxyFor(t, { nodesPath, port, hubAttaches, url: query() });

  // Attach iniziale.
  const a = connectClient(t, proxyPort);
  await waitFor(() => a.ws.readyState === WebSocket.OPEN);
  await waitFor(() => state.connections === 1);
  assert.equal(state.connections, 1, 'una attach upstream');
  await waitFor(() => state.sockets.length === 1);
  state.sockets[0].send('PRIMA');
  await waitFor(() => a.state.messages.some((m) => m.data === 'PRIMA'));

  // Il client cade: l'upstream resta vivo e l'output va nel ring.
  a.ws.terminate();
  await wait(80);
  assert.equal(state.codes.includes(1006), false, 'nessuna chiusura anomala lato upstream');
  state.sockets[0].send('DURANTE-1');
  state.sockets[0].send('DURANTE-2');
  await wait(60);

  // Torna con la stessa identita'.
  const b = connectClient(t, proxyPort);
  await waitFor(() => b.ws.readyState === WebSocket.OPEN);
  await waitFor(() => b.state.messages.length >= 2);

  assert.equal(state.connections, 1, 'nessuna nuova attach: si e\' agganciata la stessa');
  assert.deepEqual(
    b.state.messages.slice(0, 2).map((m) => m.data),
    ['DURANTE-1', 'DURANTE-2'],
    'i messaggi dell\'assenza arrivano INTERI e in ordine',
  );
  assert.ok(b.state.messages.every((m) => m.isBinary === false), 'e sono messaggi TESTO, non binari incapsulati');

  // Round-trip: quello che scrive il nuovo client arriva all'upstream.
  b.ws.send('CIAO-DAL-CLIENT');
  await waitFor(() => state.received.some((m) => m.data === 'CIAO-DAL-CLIENT'));
  assert.ok(state.received.some((m) => m.data === 'CIAO-DAL-CLIENT'), 'il frame mascherato del nuovo client passa invariato');

  // Output live dopo la ripresa.
  state.sockets[0].send('DOPO');
  await waitFor(() => b.state.messages.some((m) => m.data === 'DOPO'));
  assert.ok(b.state.messages.some((m) => m.data === 'DOPO'), 'lo stream live riprende');

  // Nessuna chiusura anomala da nessuno dei due lati.
  await wait(500);
  assert.equal(b.state.codes.filter((c) => c !== 1000 && c !== 1005).length, 0, `nessuna chiusura 1002/1006 sul client: ${JSON.stringify(b.state.codes)}`);
  assert.equal(state.codes.filter((c) => c !== 1000 && c !== 1005).length, 0, `nessuna chiusura anomala sull'upstream: ${JSON.stringify(state.codes)}`);
});

test('protocollo: un record ANCORA ATTACCATO non si lascia rubare (attach nuova)', async (t) => {
  const { nodesPath } = bootStore(t);
  const { port, state } = await realUpstream(t);
  const hubAttaches = federation.createHubAttachStore({ graceMs: 3000, maxAttaches: 8, ringBytes: 4096 });
  const proxyPort = await proxyFor(t, { nodesPath, port, hubAttaches, url: query() });

  const a = connectClient(t, proxyPort);
  // Ogni attesa e' ASSERITA: sotto carico un waitFor che scade in silenzio
  // faceva fallire l'assert dopo, per un motivo che non era quello in prova.
  assert.ok(await waitFor(() => a.ws.readyState === WebSocket.OPEN, 6000), 'il primo client deve aprire');
  assert.ok(await waitFor(() => state.connections === 1, 6000), 'la prima attach deve arrivare all\'upstream');
  assert.ok(await waitFor(() => state.sockets.length === 1, 3000), 'il socket dell\'upstream deve esserci');

  // A e' VIVO in modo OSSERVABILE (non per un sleep): l'upstream gli manda un
  // messaggio e lui lo riceve. Solo cosi' «record attaccato» e' un fatto, non
  // un'assunzione di timing.
  state.sockets[0].send('VIVO');
  assert.ok(await waitFor(() => a.state.messages.some((m) => m.data === 'VIVO'), 3000),
    'il primo client deve essere vivo e servito');

  // Un secondo upgrade con la STESSA identita' non deve prendersi il suo stream.
  const b = connectClient(t, proxyPort);
  assert.ok(await waitFor(() => state.connections === 2, 6000),
    `record attaccato: attach nuova, non furto (connessioni upstream = ${state.connections})`);
  assert.equal(state.connections, 2, 'record attaccato: attach nuova, non furto');
  assert.ok(await waitFor(() => b.ws.readyState === WebSocket.OPEN, 3000), 'il secondo client e\' comunque servito');
});

test('protocollo: identita\' diversa fa una attach nuova', async (t) => {
  const { nodesPath } = bootStore(t);
  const { port, state } = await realUpstream(t);
  const hubAttaches = federation.createHubAttachStore({ graceMs: 3000, maxAttaches: 8, ringBytes: 4096 });
  let currentUrl = query();
  const proxyPort = await proxyFor(t, { nodesPath, port, hubAttaches, url: () => currentUrl });

  const a = connectClient(t, proxyPort);
  await waitFor(() => a.ws.readyState === WebSocket.OPEN);
  await waitFor(() => state.connections === 1);
  a.ws.terminate();
  await wait(80);

  // Stesso attachId, token diverso: nessun aggancio.
  currentUrl = query({ token: 'ALTRO' });
  const b = connectClient(t, proxyPort);
  await waitFor(() => state.connections === 2, 6000);
  assert.equal(state.connections, 2, 'token diverso: attach nuova');
});

test('sicurezza: la ripresa non scavalca il gate d\'ingresso (route che non passa canTransit)', async (t) => {
  const { nodesPath } = bootStore(t);
  const { port, state } = await realUpstream(t);
  const hubAttaches = federation.createHubAttachStore({ graceMs: 3000, maxAttaches: 8, ringBytes: 4096 });
  const proxyPort = await proxyFor(t, { nodesPath, port, hubAttaches, url: query() });

  const a = connectClient(t, proxyPort);
  await waitFor(() => a.ws.readyState === WebSocket.OPEN);
  await waitFor(() => state.connections === 1);
  a.ws.terminate();
  await wait(80);
  const held = hubAttaches.get(ATTACH_ID);
  assert.ok(held && held.socket === null, 'il record e\' in grazia');

  // Upgrade con la STESSA identita' ma una route che il gate rifiuta: l'ingress
  // non puo' transitare verso quel nodo. Deve essere rifiutato PRIMA del take.
  const otherProxy = await proxyFor(t, {
    nodesPath, port, hubAttaches,
    url: `/federation/route/peer-a/_/ws?token=${TOKEN}&attachId=${ATTACH_ID}&attachSession=work-build`,
    ingress: { nodeId: PEER_ID, visibility: 'network', shared: true, peerOperatorAccess: true, name: 'peer-a' },
  });
  const c = connectClient(t, otherProxy);
  await wait(200);
  assert.equal(state.connections, 1, 'nessuna nuova attach upstream: il gate ha rifiutato prima');
  assert.equal(hubAttaches.get(ATTACH_ID).socket, null, 'il record e\' ancora in grazia, non consumato dal take');
  c.ws.terminate();
});

test('ring: l\'overflow non consegna mai un frame a meta\' (nessun 1002)', async (t) => {
  const { nodesPath } = bootStore(t);
  const { port, state } = await realUpstream(t);
  // Ring minuscolo: qualche messaggio lo fa traboccare di sicuro.
  const hubAttaches = federation.createHubAttachStore({ graceMs: 3000, maxAttaches: 8, ringBytes: 64 });
  const proxyPort = await proxyFor(t, { nodesPath, port, hubAttaches, url: query() });

  const a = connectClient(t, proxyPort);
  await waitFor(() => a.ws.readyState === WebSocket.OPEN);
  await waitFor(() => state.connections === 1);
  await waitFor(() => state.sockets.length === 1);
  a.ws.terminate();
  await wait(80);
  for (let i = 0; i < 12; i += 1) state.sockets[0].send(`RIGA-${i}`);
  await wait(80);

  const b = connectClient(t, proxyPort);
  await waitFor(() => b.ws.readyState === WebSocket.OPEN);
  await wait(300);
  // I frame consegnati sono INTERI (un taglio a meta' farebbe chiudere con 1002).
  assert.equal(b.state.codes.filter((c) => c === 1002).length, 0, `nessun 1002 dopo l'overflow: ${JSON.stringify(b.state.codes)}`);
  assert.ok(b.state.messages.every((m) => /^RIGA-\d+$/.test(m.data)), 'ogni messaggio replayato e\' intero');
  state.sockets[0].send('ULTIMA');
  await waitFor(() => b.state.messages.some((m) => m.data === 'ULTIMA'));
  assert.ok(b.state.messages.some((m) => m.data === 'ULTIMA'), 'e lo stream live riprende');
});

test('se l\'upstream muore mentre il client e\' attaccato, il client lo sa subito', async (t) => {
  const { nodesPath } = bootStore(t);
  const { port, state } = await realUpstream(t);
  const hubAttaches = federation.createHubAttachStore({ graceMs: 3000, maxAttaches: 8, ringBytes: 4096 });
  const proxyPort = await proxyFor(t, { nodesPath, port, hubAttaches, url: query() });

  const a = connectClient(t, proxyPort);
  await waitFor(() => a.ws.readyState === WebSocket.OPEN);
  await waitFor(() => state.sockets.length === 1);

  // L'upstream muore in modo BRUTALE (tunnel caduto, nessun frame di close):
  // e' il caso in cui il browser resterebbe appeso senza il 4402.
  state.sockets[0].terminate();
  await waitFor(() => a.state.codes.length > 0, 800);
  assert.equal(a.state.codes[0], 4402, `il client deve ricevere 4402, non restare appeso: ${JSON.stringify(a.state.codes)}`);
});

test('vale anche per il client ripreso', async (t) => {
  const { nodesPath } = bootStore(t);
  const { port, state } = await realUpstream(t);
  const hubAttaches = federation.createHubAttachStore({ graceMs: 3000, maxAttaches: 8, ringBytes: 4096 });
  const proxyPort = await proxyFor(t, { nodesPath, port, hubAttaches, url: query() });

  const a = connectClient(t, proxyPort);
  await waitFor(() => a.ws.readyState === WebSocket.OPEN);
  await waitFor(() => state.sockets.length === 1);
  a.ws.terminate();
  await wait(80);

  const b = connectClient(t, proxyPort);
  await waitFor(() => b.ws.readyState === WebSocket.OPEN);
  assert.equal(state.connections, 1, 'ripreso sulla stessa attach');

  state.sockets[0].terminate(); // l'upstream muore DOPO la ripresa, senza frame
  await waitFor(() => b.state.codes.length > 0, 800);
  assert.equal(b.state.codes[0], 4402, `anche il ripreso deve ricevere 4402: ${JSON.stringify(b.state.codes)}`);
});

// Frame di testo costruito a mano (server->client, non mascherato): serve per
// spezzarlo in due chunk TCP, cosa che un WebSocket vero non permette.
function textFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

test('un frame spezzato in due chunk durante la grazia arriva intero', async (t) => {
  const { nodesPath } = bootStore(t);
  const { port, state } = await realUpstream(t);
  // Ring PICCOLO: cosi' l'eviction entra in gioco e il caso vero (un chunk
  // parziale scartato, che farebbe partire il replay a meta' frame) si vede.
  const hubAttaches = federation.createHubAttachStore({ graceMs: 3000, maxAttaches: 8, ringBytes: 8 });
  const proxyPort = await proxyFor(t, { nodesPath, port, hubAttaches, url: query() });

  const a = connectClient(t, proxyPort);
  await waitFor(() => a.ws.readyState === WebSocket.OPEN);
  await waitFor(() => state.sockets.length === 1);
  a.ws.terminate();
  await waitFor(() => hubAttaches.get(ATTACH_ID) && hubAttaches.get(ATTACH_ID).socket === null, 3000);

  // Durante la grazia l'upstream manda UN frame, spezzato in due scritture TCP.
  const raw = state.sockets[0]._socket;
  const frame = textFrame('SPEZZATO-IN-DUE-PARTI-MOLTO-LUNGHE');
  raw.write(frame.subarray(0, 3)); // header + 1 byte del payload: chunk PARZIALE
  await wait(60);
  raw.write(frame.subarray(3));
  await wait(80);
  // Il ring (30 B) e' piu' piccolo del frame (32 B): l'eviction deve scartare
  // il FRAME piu' vecchio, non il primo chunk — altrimenti il replay partirebbe
  // da 29 byte a meta' frame.

  const b = connectClient(t, proxyPort);
  await waitFor(() => b.ws.readyState === WebSocket.OPEN);
  await wait(300);
  assert.equal(b.state.codes.filter((c) => c === 1002).length, 0, 'nessun 1002: il replay non parte a meta\' frame');
  const replays = b.state.messages.map((m) => m.data);
  assert.ok(replays.includes('SPEZZATO-IN-DUE-PARTI-MOLTO-LUNGHE'),
    `il messaggio spezzato deve arrivare INTERO: ${JSON.stringify(replays)}`);
  assert.ok(replays.every((d) => d === 'SPEZZATO-IN-DUE-PARTI-MOLTO-LUNGHE'),
    `nessun messaggio spurio dal replay a meta' frame: ${JSON.stringify(replays)}`);
});
