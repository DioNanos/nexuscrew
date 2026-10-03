'use strict';
// tests/event-feed-snapshot-gap-property.test.js — test di PROPRIETÀ per
// l'invariante della finestra minima: QUALUNQUE sequenza di esiti (snapshot
// ok / false / throw / 500, frame malformato, frame oversize, seq
// discontinua, stream che cade) deve rispettare il tetto
// «snapshot per owner ≤ tempo trascorso / MIN_SNAPSHOT_INTERVAL + 1».
// Il clock è finto e i round sono guidati a mano: niente attese reali.
// PRNG a seme fisso: un corridore che rompe la proprietà si riproduce.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodesStore = require('../lib/nodes/store.js');
const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');

const OWNER = 'a'.repeat(32);
const INTERVAL = 1000;   // finestra, in ms finti
const TICKS = 60;        // round per sequenza
const SEQUENCES = 200;   // sequenze casuali richieste dal mandato
const SEED = 20260929;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const healthResp = () => ({ ok: true, status: 200, json: async () => ({ ok: true, instanceId: OWNER, eventFeedV1: true }) });
const smallSnap = () => ({ ok: true, status: 200, text: async () => JSON.stringify({
  ownerId: OWNER, cursor: '1:1', viewEpoch: 1, notifications: [], asks: [],
}) });
const snapResyncRequired = () => ({ ok: true, status: 200, text: async () => JSON.stringify({
  ownerId: OWNER, cursor: '1:1', viewEpoch: 1, notifications: [], asks: [], resyncRequired: true,
}) });
const snap500 = () => ({ ok: false, status: 500, json: async () => ({ error: 'owner exploded' }) });
const sseBody = (chunks) => ({ ok: true, status: 200, body: { getReader: () => ({
  read: async () => chunks.length ? { done: false, value: Buffer.from(chunks.shift()) } : { done: true },
}) }, text: async () => '', json: async () => ({}) });
const validFrame = (seqNo) => `id: 1:${seqNo}\ndata: {"v":1,"ownerId":"${OWNER}","eventId":"e${seqNo}","scope":"node","cellId":null,"hop":1,"emittedAt":1,"frame":{"type":"notify","title":"x"}}\n\n`;

test(`proprietà: ${SEQUENCES} sequenze casuali di esiti stanno nel tetto di uno snapshot per finestra`, async (t) => {
  const rnd = mulberry32(SEED);
  const calls = [];
  let fakeNow = 1_000_000;
  let seqNo = 0;
  let pendingStream = null;
  const fetchImpl = async (url) => {
    calls.push({ url, at: fakeNow });
    if (url.includes('/federation/health')) return healthResp();
    if (url.includes('/event-feed/snapshot')) {
      const outcome = rnd();
      if (outcome < 0.15) { pendingStream = () => sseBody([]); return smallSnap(); } // ok
      if (outcome < 0.30) { pendingStream = () => sseBody([]); return snapResyncRequired(); } // false
      if (outcome < 0.42) { pendingStream = () => sseBody([]); throw new Error('rete giù'); } // throw
      if (outcome < 0.54) { pendingStream = () => sseBody([]); return snap500(); } // 500
      if (outcome < 0.66) { pendingStream = () => sseBody([`data: {"rotta"\n\n`]); return smallSnap(); } // frame malformato
      if (outcome < 0.78) { pendingStream = () => sseBody([`id: 1:1\ndata: {"v":1,"x":"${'y'.repeat(20 * 1024)}"}\n\n`]); return smallSnap(); } // frame oversize
      if (outcome < 0.90) { pendingStream = () => sseBody([validFrame(++seqNo), validFrame(seqNo + 7)]); return smallSnap(); } // seq discontinua
      pendingStream = () => sseBody([]); // stream che cade subito
      return smallSnap();
    }
    // stream: se lo snapshot del round ha preparato un esito lo usa; altrimenti
    // il round è solo-stream (cursore valido) e DEVE poterlo far cadere di
    // nuovo, altrimenti dopo il primo snapshot l'escersizer non chiede mai più
    // nulla e la proprietà resterebbe disoccupata.
    const out = pendingStream ? pendingStream() : (() => {
      const o = rnd();
      if (o < 0.35) return sseBody([validFrame(++seqNo)]);
      if (o < 0.55) return sseBody([`data: {"rotta"\n\n`]);
      if (o < 0.70) return sseBody([`id: 1:1\ndata: {"v":1,"x":"${'y'.repeat(20 * 1024)}"}\n\n`]);
      if (o < 0.85) return sseBody([validFrame(++seqNo), validFrame(seqNo + 7)]);
      return sseBody([]);
    })();
    pendingStream = null;
    return out;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncgap-prop-'));
  const nodesPath = path.join(dir, 'nodes.json');
  nodesStore.initStore(nodesPath);
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(nodesPath), {
    name: 'owner', remotePort: 41999, localPort: 44777, nodeId: OWNER,
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
    eventsReceive: true,
  });
  st = nodesStore.updateNode(st, 'owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(nodesPath, st);
  const ref = { value: null };
  t.after(async () => {
    try { if (ref.value) ref.value.stop(); } catch (_) { /* il teardown non dipende dal client */ }
    await new Promise((resolve) => setImmediate(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const client = createEventFeedClient({
    loadStore: () => nodesStore.loadStoreStrict(nodesPath), fetchImpl,
    now: () => fakeNow,
    minSnapshotIntervalMs: INTERVAL,
    resyncCooldownStepsMs: [2000, 5000, 10000],
    eventsHub: { broadcast: () => {} },
  });
  ref.value = client;
  const snapshots = () => calls.filter((c) => c.url.includes('/event-feed/snapshot')).length;
  let checked = 0;
  for (let s = 0; s < SEQUENCES; s++) {
    const before = snapshots();
    const start = fakeNow;
    for (let tick = 0; tick < TICKS; tick++) {
      fakeNow += Math.floor(rnd() * 400); // avanzamento a salti, anche zero
      await client.poll();
    }
    const elapsed = fakeNow - start;
    const made = snapshots() - before;
    // Il tetto: uno snapshot per finestra, più il primo della sequenza.
    assert.ok(made <= Math.floor(elapsed / INTERVAL) + 1,
      `sequenza ${s}: ${made} snapshot in ${elapsed} ms fake (tetto ${Math.floor(elapsed / INTERVAL) + 1})`);
    checked += 1;
  }
  assert.equal(checked, SEQUENCES, 'all sequences were checked');
  assert.ok(snapshots() > 100, 'the exerciser actually requested snapshots: ' + snapshots());
});
