'use strict';
// tests/event-feed-resync-exit.test.js — estensione R5: `resync-exhausted`
// ferma il loop (il tappo di R5 resta, vedi tests/event-feed-fixes.test.js)
// ma NON parcheggia la view per sempre. Dopo un cooldown a gradini (30 s →
// 2 min → 5 min, poi fisso) il client paga UN tentativo di snapshot fresco:
// uno snapshot pulito azzera streak, stale e lastError e lo stream riparte;
// un frame sano riporta la scala del cooldown a zero. Il caso reale è la
// card ask che sopravvive al dismiss in una view congelata (Pixel 2026-09-29).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodesStore = require('../lib/nodes/store.js');
const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');

// Stub di client identico a tests/event-feed-fixes.test.js (stessa igiene di
// teardown), con i gradini di cooldown iniettabili: timer veri, passi piccoli.
function stubClient(t, responses = [], extra = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const next = responses.shift();
    if (!next) return { ok: false, status: 500, json: async () => ({ error: 'no stub' }), text: async () => '' };
    if (next.error) throw next.error;
    return typeof next === 'function' ? next(opts) : next;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncresync-'));
  const nodesPath = path.join(dir, 'nodes.json');
  nodesStore.initStore(nodesPath);
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(nodesPath), {
    name: 'owner', remotePort: 41999, localPort: 44777, nodeId: 'a'.repeat(32),
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
    eventsReceive: true,
  });
  st = nodesStore.updateNode(st, 'owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(nodesPath, st);
  const ref = { value: null };
  t.after(async () => {
    try { if (ref.value) ref.value.stop(); } catch (_) { /* un client gia' fermo non ferma il teardown */ }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const hub = [];
  const client = createEventFeedClient({
    loadStore: () => nodesStore.loadStoreStrict(nodesPath), fetchImpl, pollMs: 15, minSnapshotIntervalMs: 50,
    eventsHub: { broadcast: (e) => hub.push(e) },
    ...extra,
  });
  ref.value = client;
  return { client, calls, hub };
}

const sse = (chunks) => ({
  ok: true, status: 200,
  body: { getReader: () => ({
    read: async () => chunks.length ? { done: false, value: Buffer.from(chunks.shift()) } : { done: true },
  }) },
  text: async () => chunks.join(''),
  json: async () => JSON.parse(chunks.join('')),
});

// Stream che resta aperto finché il client non lo abortisce: il read pendente
// si sblocca col segnale, così lo stop() fa uscire streamOnce dal suo finally
// (che libera il timer idle) e il processo di test esce da solo.
const hang = (opts = {}) => ({ ok: true, status: 200, body: { getReader: () => {
  let kill = () => {};
  const pending = new Promise((_resolve, reject) => { kill = reject; });
  try { opts.signal.addEventListener('abort', () => kill(new Error('client stopped')), { once: true }); } catch (_) {}
  return { read: () => pending };
} } });

const OWNER = 'a'.repeat(32);
const health = { ok: true, status: 200, json: async () => ({ ok: true, instanceId: OWNER, eventFeedV1: true }) };
const snapWithAsk = () => ({ ok: true, status: 200, text: async () => JSON.stringify({
  ownerId: OWNER, cursor: '5:0', viewEpoch: 5, notifications: [],
  asks: [{ id: 'ask11111', question: 'procedo?', session: 's' }],
}) });
const snapClean = () => ({ ok: true, status: 200, text: async () => JSON.stringify({
  ownerId: OWNER, cursor: '5:0', viewEpoch: 5, asks: [], notifications: [],
}) });
const reset409 = { ok: false, status: 409, json: async () => ({ error: 'cursor is too old', reason: 'reset-required' }) };
const snap409pairs = (n) => Array.from({ length: n }, () => [snapWithAsk(), reset409]).flat();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitExhausted(client) {
  for (let i = 0; i < 400; i++) {
    const view = client.state().views.find((v) => v.ownerId === OWNER);
    if (view && view.lastError === 'resync-exhausted') return view;
    await sleep(10);
  }
  return client.state().views.find((v) => v.ownerId === OWNER);
}

// Cooldown residuo letto subito all'esaurimento: è la misura del gradino.
async function remaining(client) {
  const view = await waitExhausted(client);
  assert.ok(view && view.lastError === 'resync-exhausted', 'exhausted as expected');
  return view.resyncBlockedUntil - Date.now();
}

test('R5+: esaurito il resync il loop si ferma, e dopo il cooldown uno snapshot fresco ripristina la view', async (t) => {
  // Un cooldown da 250 ms: durante la finestra NESSUNA richiesta (R5 resta),
  // alla scadenza UN tentativo: snapshot pulito → stale=false, lastError=null,
  // la ask chiusa sparita dalla view.
  const { client, calls } = stubClient(t,
    [health, ...snap409pairs(3), snapClean(), hang],
    { resyncCooldownStepsMs: [250, 500, 1000] });
  client.start();
  const view = await waitExhausted(client);
  assert.ok(view, 'the view exists');
  assert.equal(view.lastError, 'resync-exhausted', 'three reset rounds exhaust the resync (R5 unchanged)');
  const snapshots = () => calls.filter((c) => c.url.includes('/event-feed/snapshot')).length;
  const atExhaustion = calls.length;
  await sleep(120); // dentro il cooldown (250 ms)
  assert.equal(calls.length, atExhaustion, 'during the cooldown the loop is stopped: no request');
  await sleep(400); // il cooldown (250 ms) scade, il tick (15 ms) passa il gate
  assert.ok(snapshots() >= 4, 'after the cooldown a fresh snapshot is paid: ' + snapshots());
  const recovered = client.state().views.find((v) => v.ownerId === OWNER);
  assert.equal(recovered.stale, false, 'a clean snapshot clears stale');
  assert.equal(recovered.lastError, null, 'a clean snapshot clears lastError');
  assert.equal(recovered.asks.length, 0, 'the closed ask is gone from the recovered view');
  client.stop();
});

test('R5+: la scala del cooldown cresce al secondo esaurimento', async (t) => {
  // Gradini [200, 500]: primo esaurimento → ~200 ms; dopo la scadenza tre
  // nuovi round senza frame sano → secondo esaurimento → ~500 ms.
  const { client } = stubClient(t, [health, ...snap409pairs(3), ...snap409pairs(3)],
    { resyncCooldownStepsMs: [200, 500, 1000] });
  client.start();
  const first = await remaining(client);
  assert.ok(first > 80 && first <= 300, 'first cooldown is the first step: ' + first);
  await sleep(400);
  const second = await remaining(client);
  assert.ok(second > 300 && second <= 700, 'second cooldown grows to the second step: ' + second);
  assert.ok(second > first + 100, 'the ladder grows, it does not restart: ' + first + ' → ' + second);
  client.stop();
});

test('R5+: un frame sano riporta la scala al primo gradino', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  // Primo esaurimento (scala 200); alla scadenza il recovery porta uno stream
  // CON un frame valido (streak e scala azzerati); tre nuovi round di reset →
  // il secondo esaurimento torna al PRIMO gradino, non a quello cresciuto.
  const frameStream = sse(['id: 5:9\ndata: {"v":1,"ownerId":"' + OWNER + '","eventId":"e1","scope":"node","cellId":null,"hop":1,"emittedAt":1,"frame":{"type":"notify","title":"x"}}\n\n']);
  const { client } = stubClient(t,
    [health, ...snap409pairs(3), snapWithAsk(), frameStream, snapWithAsk(), reset409, ...snap409pairs(2)],
    { resyncCooldownStepsMs: [200, 500, 1000] });
  client.start();
  const first = await remaining(client);
  assert.ok(first > 80 && first <= 300, 'first cooldown is the first step: ' + first);
  await sleep(400);
  const second = await remaining(client);
  assert.ok(second <= first + 150, 'after a healthy frame the ladder is back at the first step: ' + first + ' → ' + second);
  client.stop();
});

test('R5+: un recupero fallito riarma il cooldown — un solo snapshot per scadenza', async (t) => {
  // La prova dell'audit (reaudit 2026-09-29): snapshotOnce che torna FALSE
  // senza throw (oversize qui; anche owner-mismatch o resyncRequired) non
  // armava più il cooldown: 13 snapshot in ~300 ms con poll a 15 ms. Il
  // tentativo di recupero è UNO per scadenza, e il gradino cresce.
  const oversizeSnap = () => ({ ok: true, status: 200, text: async () => JSON.stringify({
    ownerId: OWNER, cursor: '5:0', viewEpoch: 5, asks: [], notifications: [],
    filler: 'x'.repeat(4 * 1024 * 1024),
  }) });
  const { client, calls } = stubClient(t,
    [health, ...snap409pairs(3), oversizeSnap(), oversizeSnap(), oversizeSnap()],
    { resyncCooldownStepsMs: [200, 500, 1000] });
  client.start();
  await waitExhausted(client);
  await sleep(400);  // scade il primo cooldown (200 ms) → UN tentativo
  await sleep(500);  // scade il secondo (500 ms) → UN altro tentativo
  await sleep(200);  // margine: nessun altro tentativo prima del terzo gradino
  const snaps = calls.filter((c) => c.url.includes('/event-feed/snapshot')).length;
  assert.ok(snaps <= 5, 'at most one snapshot per expiry (3 + 2 recovery): ' + snaps);
  const v = client.state().views.find((x) => x.ownerId === OWNER);
  assert.equal(v.lastError, 'snapshot-oversize', 'the diagnostic carries the cause');
  assert.ok(v.resyncBlockedUntil, 'the cooldown is re-armed after the failed recovery');
  assert.equal(v.resyncExhaustions, 3, 'the ladder grew across the failed recoveries');
  client.stop();
});

test('recupero che LANCIA (reti/500): stesso punto di uscita, stesso riarma', async (t) => {
  // Lo snapshot di recupero può fallire anche LANCIANDO (HTTP 500, rete,
  // abort): il riarma non può vivere solo nel ramo false, altrimenti il catch
  // esterno lascia il gate aperto e il tick di start() ripete lo snapshot a
  // ogni pollMs, aggirando il backoff. Un solo punto di uscita, tutti i modi.
  const { client, calls } = stubClient(t,
    [health, ...snap409pairs(3), { error: new Error('boom di rete') }, { error: new Error('boom di rete') }],
    { resyncCooldownStepsMs: [200, 500, 1000] });
  client.start();
  await waitExhausted(client);
  await sleep(400);  // prima scadenza: UN tentativo che lancia → riarma
  await sleep(500);  // seconda scadenza: UN altro
  await sleep(200);
  const snaps = calls.filter((c) => c.url.includes('/event-feed/snapshot')).length;
  assert.ok(snaps <= 5, 'a throwing recovery is capped at one attempt per expiry: ' + snaps);
  const v = client.state().views.find((x) => x.ownerId === OWNER);
  assert.equal(v.lastError, 'boom di rete', 'the cause lands in lastError');
  assert.ok(v.resyncBlockedUntil, 'the cooldown is re-armed after a thrown recovery');
  client.stop();
});
