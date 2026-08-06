'use strict';
// tests/sw-skip-waiting.test.js — il service worker deve OBBEDIRE a SKIP_WAITING.
//
// Non e' una guardia testuale: sw.js viene eseguito davvero in una sandbox con
// un `self` finto, e si verifica il COMPORTAMENTO — quale listener registra e
// cosa fa quando arriva il messaggio. Un test che cercasse la stringa
// 'SKIP_WAITING' nel file passerebbe anche con un listener che non chiama
// skipWaiting, cioe' esattamente il difetto che questo test esiste per
// impedire.
//
// Perche' conta: applyUpdate() (frontend/src/lib/sw-update.js) manda quel
// messaggio a un worker in waiting e attende il controllerchange. Senza
// listener il banner "nuova versione disponibile" non si spegneva piu': il
// reload di fallback lasciava il worker in waiting, e al ricaricamento
// reg.waiting lo faceva ricomparire.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_PATH = path.join(__dirname, '..', 'frontend', 'public', 'sw.js');

// Esegue sw.js con un `self` strumentato e restituisce i listener registrati.
function runServiceWorker() {
  const listeners = new Map();
  const calls = { skipWaiting: 0, claim: 0 };
  const self = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    skipWaiting() { calls.skipWaiting += 1; },
    clients: { claim() { calls.claim += 1; }, matchAll: async () => [], openWindow: async () => {} },
    registration: { showNotification: () => {} },
  };
  const context = vm.createContext({ self, console });
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), context);
  return { listeners, calls, self };
}

test('sw.js obbedisce a SKIP_WAITING: il banner deve poter essere spento', () => {
  const { listeners, calls } = runServiceWorker();
  const onMessage = listeners.get('message');
  assert.ok(onMessage, 'sw.js deve registrare un listener `message`: applyUpdate() gli parla');

  const before = calls.skipWaiting;
  onMessage({ data: { type: 'SKIP_WAITING' } });
  assert.equal(calls.skipWaiting, before + 1, 'SKIP_WAITING deve attivare il worker in waiting');
});

test('sw.js ignora i messaggi che non riconosce, senza rompersi', () => {
  const { listeners, calls } = runServiceWorker();
  const onMessage = listeners.get('message');
  const before = calls.skipWaiting;
  // Un messaggio da un'altra origine o da un'estensione non deve ne' attivare
  // il worker ne' far lanciare un'eccezione dentro il SW.
  for (const bad of [undefined, {}, { data: null }, { data: 'SKIP_WAITING' }, { data: { type: 'ALTRO' } }]) {
    onMessage(bad);
  }
  assert.equal(calls.skipWaiting, before, 'solo {type:"SKIP_WAITING"} deve attivare');
});

test('install e activate restano quelli attesi da sw-update.js', () => {
  const { listeners, calls } = runServiceWorker();
  assert.ok(listeners.get('install'), 'install mancante');
  assert.ok(listeners.get('activate'), 'activate mancante');
  listeners.get('install')({});
  assert.equal(calls.skipWaiting, 1, 'install deve chiamare skipWaiting (auto-attivazione)');
  listeners.get('activate')({});
  assert.equal(calls.claim, 1, 'activate deve chiamare clients.claim');
});
