'use strict';
// 0.9.80 strato 2c — consultazione fresca, di sola lettura, del fence del
// proprietario sul lease autenticato. Lease manager e lease-client REALI su
// socket TCP di test (nessun tmux, nessun NC vivo).
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');
const snap = require('../lib/fleet/prompt-snapshot.js');

const LAUNCH = 'a1b2c3d4e5f60718';

function pair() {
  return new Promise((resolve, reject) => {
    let pending = null;
    const srv = net.createServer((sock) => { pending = sock; });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const client = net.createConnection(srv.address().port, '127.0.0.1', () => {
        const wait = () => {
          if (pending) { srv.close(() => {}); resolve({ serverSide: pending, client }); }
          else setTimeout(wait, 2);
        };
        wait();
      });
      client.once('error', reject);
    });
  });
}

function recv(client, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => { cleanup(); reject(new Error('recv timeout')); }, timeoutMs);
    function cleanup() { clearTimeout(to); client.removeListener('data', on); }
    function on(chunk) {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (!predicate || predicate(msg)) { cleanup(); resolve(msg); }
      }
    }
    client.on('data', on);
  });
}

function mondo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptauth-'));
  const clock = { t: 10_000 };
  const mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  return { home, clock, mgr };
}

// Lease vivo con un client "a mano": il test risponde (o no) alle richieste.
async function conClientGrezzo(mgr, cellId = 'Dev') {
  await mgr.track(cellId);
  const { serverSide, client } = await pair();
  assert.equal(mgr.attachInitial(cellId, serverSide, { generation: 0 }), true);
  return client;
}

const risposta = (nonce, extra = {}) => ({
  type: 'promptSnapshotResult', v: 1, nonce, launchId: LAUNCH, applicable: true, generation: 1, ...extra,
});

test('schema: richiesta e risposta a chiavi chiuse, nonce e launchId esatti', () => {
  const nonce = 'f'.repeat(32);
  assert.equal(snap.validRequest({ type: 'promptSnapshot', v: 1, nonce }), true);
  assert.equal(snap.validRequest({ type: 'promptSnapshot', v: 1, nonce, extra: 1 }), false);
  assert.equal(snap.validRequest({ type: 'promptSnapshot', v: 2, nonce }), false);
  assert.equal(snap.validRequest({ type: 'promptSnapshot', v: 1, nonce: 'ZZ' }), false);
  assert.equal(snap.validResult(risposta(nonce)), true);
  assert.equal(snap.validResult(risposta(nonce, { generation: null })), true);
  for (const male of [
    { launchId: '../etc/passwd' }, { launchId: 'ABCDEF0123456789' }, { generation: -1 },
    { generation: 1.5 }, { generation: '1' }, { applicable: 'yes' }, { path: '/x' },
    { mcp: { state: 'degraded', failed: ['x'.repeat(65)], pending: [] } },
    { mcp: { state: 'degraded', failed: Array.from({ length: 17 }, (_, i) => `s${i}`), pending: [] } },
    { mcp: { state: 'weird', failed: [], pending: [] } },
  ]) {
    assert.equal(snap.validResult(risposta(nonce, male)), false, JSON.stringify(male));
  }
  assert.equal(snap.validResult(risposta(nonce, { mcp: { state: 'degraded', failed: ['a'], pending: ['b'] } })), true);
});

test('la fotografia viene dal proprietario: gen 1 mentre la cache del lease annuncia 0', async () => {
  const { mgr } = mondo();
  await mgr.track('Dev');
  const { serverSide, client } = await pair();
  assert.equal(mgr.attachInitial('Dev', serverSide, { generation: 0 }), true);
  // Supervisore REALE: il lease cache dice 0, il fence del proprietario 1
  // (ammissione gen1 avvenuta, annuncio non ancora fatto o fallito).
  let fence = 1;
  const ctl = startLeaseClient(client, {
    stablePath: path.join(os.tmpdir(), 'nessuno.sock'), launchEpoch: 'a'.repeat(16), generation: () => 0,
    promptSnapshot: () => ({ launchId: LAUNCH, applicable: true, generation: fence }),
  }, {});
  try {
    assert.equal(mgr.status('Dev').generation, 0);
    const r = await mgr.readPromptSnapshot('Dev');
    assert.equal(r.ok, true);
    assert.equal(r.generation, 1);
    assert.equal(r.launchId, LAUNCH);
    assert.equal(r.applicable, true);
    assert.equal(mgr.promptSnapshotBinding('Dev', r), true);
    // Prima della prima ammissione: nessuna generazione, mai 0 inventata.
    fence = null;
    const prima = await mgr.readPromptSnapshot('Dev');
    assert.equal(prima.ok, true);
    assert.equal(prima.generation, null);
  } finally { ctl.stop(); mgr.close(); }
});

test('peer senza capacita\' (nessun hook) o fotografia non valida: timeout bounded, non successo', async () => {
  const { mgr } = mondo();
  await mgr.track('Dev');
  const { serverSide, client } = await pair();
  mgr.attachInitial('Dev', serverSide, { generation: 0 });
  const ctl = startLeaseClient(client, {
    stablePath: path.join(os.tmpdir(), 'nessuno.sock'), launchEpoch: 'a'.repeat(16), generation: () => 0,
  }, {});
  try {
    const t0 = process.hrtime.bigint();
    const r = await mgr.readPromptSnapshot('Dev', { timeoutMs: 60 });
    assert.deepEqual(r, { ok: false, reason: 'timeout' });
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 2000);
  } finally { ctl.stop(); mgr.close(); }
});

test('binding: nonce vecchio, nonce ripetuto, schema ostile e socket altrui sono scartati', async () => {
  const { mgr } = mondo();
  const client = await conClientGrezzo(mgr);
  try {
    const p1 = mgr.readPromptSnapshot('Dev', { timeoutMs: 150 });
    const req = await recv(client, (m) => m.type === 'promptSnapshot');
    assert.equal(snap.validRequest(req), true);
    // nonce sbagliato, chiave in piu', launchId ostile: nessuno risolve
    client.write(`${JSON.stringify(risposta('0'.repeat(32)))}\n`);
    client.write(`${JSON.stringify(risposta(req.nonce, { extra: true }))}\n`);
    client.write(`${JSON.stringify(risposta(req.nonce, { launchId: '../../x' }))}\n`);
    assert.deepEqual(await p1, { ok: false, reason: 'timeout' });
    // una risposta valida al nonce ormai scaduto non risolve niente di nuovo
    client.write(`${JSON.stringify(risposta(req.nonce))}\n`);
    const p2 = mgr.readPromptSnapshot('Dev', { timeoutMs: 150 });
    const req2 = await recv(client, (m) => m.type === 'promptSnapshot' && m.nonce !== req.nonce);
    client.write(`${JSON.stringify(risposta(req2.nonce))}\n`);
    const ok = await p2;
    assert.equal(ok.ok, true);
    // ripetuta: il waiter e' gia' consumato, nessun effetto
    client.write(`${JSON.stringify(risposta(req2.nonce, { generation: 7 }))}\n`);
    assert.equal(ok.generation, 1);
  } finally { client.destroy(); mgr.close(); }
});

test('connessione sostituita o persa durante la consultazione: nessun dato qualificato', async () => {
  const { mgr } = mondo();
  const client = await conClientGrezzo(mgr);
  try {
    const p = mgr.readPromptSnapshot('Dev', { timeoutMs: 250 });
    await recv(client, (m) => m.type === 'promptSnapshot');
    client.destroy();
    const r = await p;
    assert.equal(r.ok, false);
    assert.ok(['connection-lost', 'connection-replaced', 'timeout'].includes(r.reason), r.reason);
    // dopo la perdita nessuna nuova consultazione e' attestabile
    const dopo = await mgr.readPromptSnapshot('Dev', { timeoutMs: 50 });
    assert.equal(dopo.ok, false);
  } finally { mgr.close(); }
});

test('shutdown del manager durante la consultazione: waiter chiuso, nessun timer pendente', async () => {
  const { mgr } = mondo();
  const client = await conClientGrezzo(mgr);
  try {
    const p = mgr.readPromptSnapshot('Dev', { timeoutMs: 250 });
    await recv(client, (m) => m.type === 'promptSnapshot');
    mgr.close();
    assert.deepEqual(await p, { ok: false, reason: 'shutdown' });
  } finally { client.destroy(); }
});

test('tetto di consultazioni in volo per cella: la quinta e\' rifiutata senza accumulo', async () => {
  const { mgr } = mondo();
  const client = await conClientGrezzo(mgr);
  try {
    const volo = [1, 2, 3, 4].map(() => mgr.readPromptSnapshot('Dev', { timeoutMs: 120 }));
    const quinta = await mgr.readPromptSnapshot('Dev', { timeoutMs: 120 });
    assert.deepEqual(quinta, { ok: false, reason: 'busy' });
    for (const p of volo) assert.equal((await p).ok, false);
    // liberato: ora una nuova consultazione parte
    const nuova = mgr.readPromptSnapshot('Dev', { timeoutMs: 60 });
    assert.deepEqual(await nuova, { ok: false, reason: 'timeout' });
  } finally { client.destroy(); mgr.close(); }
});

test('cella senza lease: non attestabile, nessuna scrittura', async () => {
  const { mgr } = mondo();
  try {
    assert.deepEqual(await mgr.readPromptSnapshot('Dev'), { ok: false, reason: 'no-lease' });
    assert.deepEqual(await mgr.readPromptSnapshot('../x'), { ok: false, reason: 'invalid-cell' });
  } finally { mgr.close(); }
});
