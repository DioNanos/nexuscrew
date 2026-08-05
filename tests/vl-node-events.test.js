'use strict';

// Passo 2, lato hub: gli eventi di sessione arrivano dentro il long poll che il
// device gia' fa. Contratto:
// DocsHub/projects/vl/2026-08-05_CONTRATTO_passo2_eventi_nodo_broker.md
//
// Le due garanzie che questi test devono davvero provare, perche' sono quelle
// che un'implementazione plausibile ma sbagliata romperebbe in silenzio:
//   1. ToolArgs/ToolResult NON entrano mai, nemmeno troncati (contengono file,
//      output di comandi, potenziali segreti);
//   2. il ring vive in memoria ed e' limitato, cosi' l'hub non accumula la
//      conversazione nel tempo (VPS3 e' l'host dei backup).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const {
  createBroker, PROTOCOL, sanitizeEvents, EVENT_KINDS,
  MAX_EVENTS_BYTES, RING_MAX_EVENTS,
} = require('../lib/vl-nodes/broker.js');

const node = { nodeId: 'a'.repeat(32), label: 'N900', pairedAt: 1 };
const SESSION = '1'.repeat(32);

function heartbeat(seq, over = {}) {
  return {
    protocol: PROTOCOL,
    nodeId: node.nodeId,
    sessionId: SESSION,
    seq,
    version: '0.1.0',
    capabilities: ['status'],
    health: { state: 'running', uptimeSec: 10, rssBytes: 2_000_000, processCount: 2, brokerReachable: true },
    ...over,
  };
}

function ev(seq, over = {}) {
  return { seq, kind: 'text', at: 1_000 + seq, text: `riga ${seq}`, ...over };
}

test('gli eventi arrivano col poll, entrano nel ring e il cursore torna al device', async () => {
  const broker = createBroker({ now: () => 10_000 });
  const res = await broker.poll(node, heartbeat(0, { events: [ev(1), ev(2), ev(3)] }), { waitMs: 1 });
  // Il cursore e' su OGNI risposta, non solo su quelle con comando: il device
  // deve poter liberare il buffer anche quando il poll scade a vuoto.
  assert.equal(res.eventsCursor, 3, 'la risposta al poll conferma fin dove ha accettato');

  const read = broker.events(node.nodeId, {});
  assert.equal(read.events.length, 3);
  assert.deepEqual(read.events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(read.events[0].text, 'riga 1');
  assert.equal(read.cursor, 3);
});

test('ToolArgs e ToolResult non entrano MAI nel ring, nemmeno troncati', () => {
  const out = sanitizeEvents([
    ev(1),
    { seq: 2, kind: 'tool_args', at: 1, text: 'password=hunter2' },
    { seq: 3, kind: 'tool_result', at: 1, text: 'contenuto di /etc/shadow' },
    ev(4, { kind: 'tool_end', name: 'read_file', isError: false }),
  ]);
  const kinds = out.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['text', 'tool_end'], 'i due kind proibiti sono scartati');
  const serialized = JSON.stringify(out.events);
  assert.ok(!serialized.includes('hunter2'), 'nessun frammento di tool_args sopravvive');
  assert.ok(!serialized.includes('shadow'), 'nessun frammento di tool_result sopravvive');
  assert.ok(!EVENT_KINDS.has('tool_args'));
  assert.ok(!EVENT_KINDS.has('tool_result'));
});

test('un kind sconosciuto viene scartato invece di passare per inerzia', () => {
  const out = sanitizeEvents([ev(1), { seq: 2, kind: 'inventato', text: 'x' }, ev(3)]);
  assert.deepEqual(out.events.map((e) => e.seq), [1, 3]);
});

test("gli eventi gia' visti non si duplicano: il dedup e' sul seq", async () => {
  const broker = createBroker({ now: () => 10_000 });
  await broker.poll(node, heartbeat(0, { events: [ev(1), ev(2)] }), { waitMs: 1 });
  // At-least-once: dopo un crash il device rimanda dall'ultimo checkpoint.
  const res = await broker.poll(node, heartbeat(1, { events: [ev(1), ev(2), ev(3)] }), { waitMs: 1 });
  assert.equal(res.eventsCursor, 3);
  const read = broker.events(node.nodeId, {});
  assert.deepEqual(read.events.map((e) => e.seq), [1, 2, 3], 'nessun duplicato nel ring');
});

test('il ring e limitato: oltre il tetto i piu vecchi escono, la conversazione non si accumula', async () => {
  const broker = createBroker({ now: () => 10_000 });
  const total = RING_MAX_EVENTS + 50;
  for (let i = 0; i < total; i += 1) {
    await broker.poll(node, heartbeat(i, { events: [ev(i + 1)] }), { waitMs: 1 });
  }
  const read = broker.events(node.nodeId, {});
  assert.equal(read.events.length, RING_MAX_EVENTS, 'il ring non supera il tetto');
  assert.equal(read.events[read.events.length - 1].seq, total, 'gli ultimi restano');
  assert.equal(read.events[0].seq, total - RING_MAX_EVENTS + 1, 'i piu vecchi sono usciti');
});

test('un poll troppo grosso viene troncato con un gap esplicito, mai in silenzio', () => {
  const big = 'x'.repeat(2_000);
  const events = [];
  for (let i = 1; i <= 40; i += 1) events.push(ev(i, { text: big }));
  const out = sanitizeEvents(events);
  assert.ok(JSON.stringify(out.events).length <= MAX_EVENTS_BYTES, 'il serializzato rientra nel bound');
  assert.ok(out.events.length < events.length, 'qualcosa e stato scartato');
  const gap = out.events.find((e) => e.kind === 'gap');
  assert.ok(gap, 'lo scarto produce un gap');
  assert.ok(gap.count > 0, 'il gap dice QUANTI eventi mancano');
});

test('gli eventi terminali non si perdono mai, nemmeno in overflow', () => {
  const big = 'x'.repeat(2_000);
  const events = [];
  for (let i = 1; i <= 40; i += 1) events.push(ev(i, { text: big }));
  events.push({ seq: 41, kind: 'turn_end', at: 2_000 });
  events.push({ seq: 42, kind: 'done', at: 2_001 });
  const out = sanitizeEvents(events);
  const kinds = out.events.map((e) => e.kind);
  assert.ok(kinds.includes('turn_end'), 'turn_end sopravvive all overflow');
  assert.ok(kinds.includes('done'), 'done sopravvive all overflow');
});

test('un poll senza events resta valido: il device vecchio continua a funzionare', async () => {
  const broker = createBroker({ now: () => 10_000 });
  const res = await broker.poll(node, heartbeat(0), { waitMs: 1 });
  assert.equal(res.type, 'idle');
  assert.equal(res.eventsCursor, 0, 'nessun evento, cursore a zero');
  assert.deepEqual(broker.events(node.nodeId, {}).events, []);
});

test('events(after) restituisce solo il nuovo: la UI non riscarica tutto a ogni giro', async () => {
  const broker = createBroker({ now: () => 10_000 });
  await broker.poll(node, heartbeat(0, { events: [ev(1), ev(2), ev(3)] }), { waitMs: 1 });
  const read = broker.events(node.nodeId, { after: 2 });
  assert.deepEqual(read.events.map((e) => e.seq), [3]);
});

test('il ring e per nodo: due device non si mescolano', async () => {
  const other = { nodeId: 'b'.repeat(32), label: 'altro', pairedAt: 1 };
  const broker = createBroker({ now: () => 10_000 });
  await broker.poll(node, heartbeat(0, { events: [ev(1)] }), { waitMs: 1 });
  await broker.poll(other, { ...heartbeat(0, { events: [ev(9)] }), nodeId: other.nodeId }, { waitMs: 1 });
  assert.deepEqual(broker.events(node.nodeId, {}).events.map((e) => e.seq), [1]);
  assert.deepEqual(broker.events(other.nodeId, {}).events.map((e) => e.seq), [9]);
});

test('forget() cancella anche gli eventi: niente conversazione superstite dopo il revoke', async () => {
  const broker = createBroker({ now: () => 10_000 });
  await broker.poll(node, heartbeat(0, { events: [ev(1), ev(2)] }), { waitMs: 1 });
  broker.forget(node.nodeId);
  assert.deepEqual(broker.events(node.nodeId, {}).events, []);
});

// Integrazione vera sul server HTTP: i test sopra provano il broker in
// isolamento, questo prova che gli eventi attraversino davvero la route del
// poll e tornino dalla route di lettura. Scritto DOPO l'implementazione (non
// TDD) e quindi verificato con un controllo negativo separato.
test('end-to-end HTTP: gli eventi entrano col poll ed escono dalla route di lettura', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vl-events-'));
  const configDir = path.join(home, '.nexuscrew');
  const nodesPath = path.join(configDir, 'nodes.json');
  const vlNodesPath = path.join(configDir, 'vl-nodes.json');
  const tokenPath = path.join(configDir, 'token');
  const ownerId = 'a'.repeat(32);
  nodesStore.atomicWriteStore(nodesPath, nodesStore.emptyStore(ownerId));
  const made = createServer({
    home, configDir, nodesPath, vlNodesPath, tokenPath,
    filesRoot: path.join(home, 'files'), fleetEnabled: false, autoUpdate: false,
    bind: '127.0.0.1', port: 0, log: () => {},
  });
  await new Promise((resolve) => made.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => made.server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${made.server.address().port}`;
  const ui = {
    authorization: `Bearer ${fs.readFileSync(tokenPath, 'utf8').trim()}`,
    'content-type': 'application/json',
  };

  const invite = await (await fetch(`${base}/api/vl-nodes/invite`, {
    method: 'POST', headers: ui, body: JSON.stringify({ label: 'N900', ttlSeconds: 60 }),
  })).json();
  const nodeId = 'b'.repeat(32);
  const paired = await (await fetch(`${base}/vl-node/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vl-invite': invite.invite },
    body: JSON.stringify({ protocol: 'vl-node/1', nodeId, label: 'N900' }),
  })).json();
  const device = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };

  const pollResponse = await fetch(`${base}/vl-node/v1/poll`, {
    method: 'POST',
    headers: { ...device, 'x-vl-wait-ms': '1' },
    body: JSON.stringify({
      protocol: PROTOCOL, nodeId, sessionId: 'c'.repeat(32), seq: 0, version: '0.1.0',
      capabilities: ['status'],
      health: { state: 'running', uptimeSec: 5, rssBytes: 2_000_000, processCount: 2, brokerReachable: true },
      events: [
        { seq: 1, kind: 'text', at: 1, text: 'ciao dal N900' },
        { seq: 2, kind: 'tool_start', at: 2, name: 'read_file' },
        { seq: 3, kind: 'tool_result', at: 3, text: 'SEGRETO-CHE-NON-DEVE-USCIRE' },
        { seq: 4, kind: 'tool_end', at: 4, name: 'read_file', isError: false },
        { seq: 5, kind: 'turn_end', at: 5 },
      ],
    }),
  });
  // Il poll scaduto a vuoto e' un 204 SENZA CORPO: il cursore non puo' stare
  // nel body, o il device non saprebbe mai cosa e' stato accettato.
  assert.equal(pollResponse.status, 204);
  assert.equal(pollResponse.headers.get('x-vl-events-cursor'), '5',
    'il cursore torna al device anche su una risposta senza corpo');

  const read = await (await fetch(`${base}/api/vl-nodes/${nodeId}/events`, { headers: ui })).json();
  assert.deepEqual(read.events.map((e) => e.kind), ['text', 'tool_start', 'tool_end', 'turn_end']);
  assert.equal(read.cursor, 5);
  assert.ok(!JSON.stringify(read).includes('SEGRETO-CHE-NON-DEVE-USCIRE'),
    'il tool_result non attraversa il confine nemmeno via HTTP');

  const incremental = await (await fetch(`${base}/api/vl-nodes/${nodeId}/events?after=2`, { headers: ui })).json();
  assert.deepEqual(incremental.events.map((e) => e.seq), [4, 5]);

  const unknown = await fetch(`${base}/api/vl-nodes/${'e'.repeat(32)}/events`, { headers: ui });
  assert.equal(unknown.status, 404, 'un nodo non accoppiato non ha eventi da mostrare');

  const unauthorized = await fetch(`${base}/api/vl-nodes/${nodeId}/events`);
  assert.equal(unauthorized.status, 401, 'la lettura resta dietro autenticazione');
});
