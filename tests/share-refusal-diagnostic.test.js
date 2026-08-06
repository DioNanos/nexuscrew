'use strict';
// tests/share-refusal-diagnostic.test.js — un rifiuto che l'hub non scrive da
// nessuna parte non esiste.
//
// Caso reale (2026-08-06): un nodo non riusciva ad attivare Share. L'hub
// rifiutava con 409 `share-channel-not-ready` ad ogni tentativo — 30 volte —
// e non ne restava traccia da nessuna parte: l'errore viveva solo nel toast
// del dispositivo, cioe' nell'unico posto dove chi amministra l'hub non puo'
// guardarlo. La causa (un `permitlisten` che concedeva la porta di un altro
// peer) e' saltata fuori solo leggendo i log di sshd con i privilegi di root.
//
// Il record diagnostico non ripara il canale: rende leggibile il rifiuto a chi
// puo' ripararlo, e nomina la PORTA tentata — senza la quale «canale non
// pronto» non dice dove guardare.
const { test } = require('node:test');
const assert = require('node:assert');
const { activeReversePort } = require('../lib/proxy/federation.js');

const pool = (base, activeSlot = 0) => ({
  base,
  slots: [{ port: base, state: 'active', generation: 1 },
    { port: base + 100, state: 'ready', generation: 1 },
    { port: base + 200, state: 'ready', generation: 1 }],
  activeSlot,
  activeGeneration: 1,
  verification: 'unverifiable',
  verifiedSlots: [],
});

test('la porta riportata e\' quella dello SLOT ATTIVO, non la base del pool', () => {
  // Dopo una rotazione lo slot attivo non e' piu' il primo, e riportare la
  // base manderebbe a cercare sulla porta sbagliata — cioe' esattamente
  // l'errore che questo record esiste per evitare.
  assert.equal(activeReversePort({ reversePool: pool(44004, 1) }), 44104);
  assert.equal(activeReversePort({ reversePool: pool(44004, 0) }), 44004);
});

test('senza pool si ricade sulla localPort, che e\' cio\' che l\'hub sonda davvero', () => {
  // NON `reversePort`: quello vive sul client. Sull'hub e' assente, e usarlo
  // avrebbe prodotto un record senza porta proprio nei casi piu' vecchi —
  // quelli senza pool, cioe' quelli che hanno piu' bisogno di una diagnosi.
  assert.equal(activeReversePort({ localPort: 44002 }), 44002);
  // Il pool, quando c'e', vince: dopo una rotazione localPort e slot attivo
  // possono divergere per un istante.
  assert.equal(activeReversePort({ localPort: 44004, reversePool: pool(44004, 1) }), 44104);
});

test('quando non c\'e\' nulla da riportare, si riporta null e non un numero inventato', () => {
  assert.equal(activeReversePort({}), null);
  assert.equal(activeReversePort(null), null);
  // Slot fuori range: il pool c'e' ma l'indice non punta a niente, e non
  // esiste una localPort su cui ripiegare.
  assert.equal(activeReversePort({ reversePool: pool(44004, 9) }), null);
});

test('un pool malformato non fa esplodere il ramo di rifiuto', () => {
  // Questo codice gira DENTRO la gestione di un errore: se lancia, trasforma
  // un 409 diagnosticabile in un 500 muto.
  for (const peer of [
    { reversePool: {} },
    { reversePool: { slots: 'non-un-array', activeSlot: 0 } },
    { reversePool: { slots: [null], activeSlot: 0 } },
    { reversePool: { slots: [{ port: 'quarantaquattro' }], activeSlot: 0 } },
  ]) {
    assert.doesNotThrow(() => activeReversePort(peer));
    assert.equal(activeReversePort(peer), null);
  }
});

// --- il comportamento vero: il record viene emesso? ----------------------
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const fed = require('../lib/proxy/federation.js');
const store = require('../lib/nodes/store.js');

const listen = (app) => new Promise((r) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => r(s)); });
const close = (s) => new Promise((r) => s.close(r));

// Hub con un peer accoppiato il cui canale reverse NON risponde: e' il caso
// dell'Asus, riprodotto senza sshd.
async function hubWithUnreachablePeer(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-share-refusal-'));
  const nodesPath = path.join(dir, 'nodes.json');
  let st = store.emptyStore('a'.repeat(32));
  st = store.addNode(st, {
    name: 'asus', remotePort: 41820, localPort: 44004, direction: 'inbound',
    visibility: 'network', nodeId: 'b'.repeat(32), token: 'hub-to-asus', acceptToken: 'asus-to-hub',
  });
  store.atomicWriteStore(nodesPath, st);
  const app = express();
  app.use('/federation', fed.peerRouter({
    nodesPath, localPort: 1, localCredential: () => 'hub-main',
    // Il canale reverse non e' su: ogni probe fallisce, come quando sshd
    // rifiuta il bind.
    fetchImpl: async () => { const e = new Error('ECONNREFUSED'); throw e; },
    diagnostics: { record: (level, component, code, message, meta) => records.push({ level, component, code, meta }) },
  }));
  const hub = await listen(app);
  t.after(async () => { await close(hub); fs.rmSync(dir, { recursive: true, force: true }); });
  return hub;
}

const askShare = (hub) => fetch(`http://127.0.0.1:${hub.address().port}/federation/share`, {
  method: 'POST',
  headers: { authorization: 'Bearer asus-to-hub', 'content-type': 'application/json' },
  body: JSON.stringify({ shared: true }),
});

test('Share rifiutato: l\'hub lascia un record leggibile, con la porta tentata', async (t) => {
  const records = [];
  const hub = await hubWithUnreachablePeer(t, records);
  const res = await askShare(hub);
  assert.equal(res.status, 409);
  const refusal = records.find((r) => r.code === 'SHARE_CHANNEL_REFUSED');
  assert.ok(refusal, `nessun record di rifiuto; ricevuti: ${JSON.stringify(records.map((r) => r.code))}`);
  assert.equal(refusal.level, 'warn');
  assert.equal(refusal.meta.node, 'asus');
  assert.equal(refusal.meta.port, 44004, 'la porta tentata e\' il dato che mancava');
  assert.ok(typeof refusal.meta.code === 'string' && refusal.meta.code, 'il codice tipizzato accompagna il record');
});

test('il record non trasporta credenziali ne\' testo remoto', async (t) => {
  // I diagnostici sono bounded per contratto: un rifiuto non e' il posto dove
  // far entrare un token o il corpo di una risposta altrui.
  const records = [];
  const hub = await hubWithUnreachablePeer(t, records);
  await askShare(hub);
  const dumped = JSON.stringify(records);
  for (const secret of ['hub-to-asus', 'asus-to-hub', 'hub-main']) {
    assert.ok(!dumped.includes(secret), `credenziale trapelata nel diagnostico: ${secret}`);
  }
});

test('senza diagnostics il rifiuto resta un 409 e non un 500', async (t) => {
  // La dipendenza e' opzionale: un hub costruito senza store diagnostico non
  // deve rompersi proprio nel ramo di errore.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-share-refusal-nodiag-'));
  const nodesPath = path.join(dir, 'nodes.json');
  let st = store.emptyStore('a'.repeat(32));
  st = store.addNode(st, {
    name: 'asus', remotePort: 41820, localPort: 44004, direction: 'inbound',
    visibility: 'network', nodeId: 'b'.repeat(32), token: 'hub-to-asus', acceptToken: 'asus-to-hub',
  });
  store.atomicWriteStore(nodesPath, st);
  const app = express();
  app.use('/federation', fed.peerRouter({
    nodesPath, localPort: 1, localCredential: () => 'hub-main',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  }));
  const hub = await listen(app);
  t.after(async () => { await close(hub); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await askShare(hub)).status, 409);
});
