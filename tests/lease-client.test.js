'use strict';

// Test del lease-client lato supervisore (lib/fleet/lease-client.js) con seams
// (setTimeout/clearTimeout/net/now) e socket fake EventEmitter. Il tempo e'
// simulato: fire() fa avanzare l'orologio dei ms del timer che esegue.
// Copre:
//  - R3.3.4: il reconnect presenta la generation corrente via getter (cell-exec
//    la fa avanzare coi restart), non un valore fisso.
//  - R3.2: >=2 tentativi di reconnect STRETTAMENTE dentro la grace 60s anche se
//    il server e' muto (per-attempt timeout: senza, una socket appesa lasciava
//    1 solo tentativo e 0 timer successivi).
//  - R3.2: il retry dopo deny e' bounded dalla grace (oltre non si ritenta).

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');

function fakeSocket() {
  const s = new EventEmitter();
  s.setEncoding = () => {};
  s.write = (data) => { s.written = (s.written || '') + String(data); return true; };
  s.destroy = () => { if (s.destroyed) return; s.destroyed = true; s.emit('close'); };
  s.removeAllListeners = (ev) => EventEmitter.prototype.removeAllListeners.call(s, ev);
  s.writable = true;
  s.destroyed = false;
  return s;
}

// harness(info, { reply }): reply = 'hang' (muto) | 'deny' | 'lease'. Il server
// fake risponde (onConnect + reply) su un timer(0), cosi' i listener 'data' del
// client sono gia' registrati quando la reply arriva.
function harness(info, { reply = 'hang' } = {}) {
  let clock = 0;
  const now = () => clock;
  const timers = [];
  let timerId = 1;
  const setTimeout = (fn, ms) => { const id = timerId++; timers.push({ id, fn, ms: ms || 0 }); return id; };
  const clearTimeout = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const created = [];
  const net = {
    createConnection: (_path, onConnect) => {
      const s = fakeSocket();
      created.push({ s });
      setTimeout(() => {
        try { onConnect(); } catch (_) {}
        if (reply === 'deny') s.emit('data', `${JSON.stringify({ type: 'deny' })}\n`);
        else if (reply === 'lease') s.emit('data', `${JSON.stringify({ type: 'lease', leaseId: 'aa'.repeat(16) })}\n`);
        // 'hang': nessuna reply
      }, 0);
      return s;
    },
  };
  const initial = fakeSocket();
  const ctl = startLeaseClient(initial, info, { setTimeout, clearTimeout, net, now });
  return {
    initial, created, ctl,
    clock: () => clock,
    pending: () => timers.length,
    fire: () => { const t = timers.shift(); if (!t) return false; clock += t.ms; t.fn(); return true; },
  };
}

test('R3.3.4 lease-client: il reconnect presenta la generation corrente (getter che avanza)', () => {
  let gen = 0;
  const { initial, created, fire } = harness({
    stablePath: '/tmp/x.sock', launchEpoch: 'ep', capability: 'ab'.repeat(32),
    generation: () => gen,
  }, { reply: 'lease' });
  initial.emit('end');     // EOF
  fire(); fire();          // reconnect(0) + onConnect/lease(0) -> attempt1 settle
  assert.ok(created.length >= 1, 'almeno un tentativo');
  assert.equal(JSON.parse(created[0].s.written.trim()).generation, 0, 'primo reconnect: generation 0');
  gen = 3;                 // cell-exec ha riavviato il child
  created[0].s.emit('end'); // EOF sulla socket corrente
  fire(); fire();          // attempt2
  assert.ok(created.length >= 2, 'secondo tentativo');
  assert.equal(JSON.parse(created[1].s.written.trim()).generation, 3, 'secondo reconnect: generation avanzata a 3 via getter');
});

test('R3.2 lease-client: server muto -> almeno 2 tentativi dentro la grace (per-attempt timeout)', () => {
  const { initial, created, fire, clock } = harness({
    stablePath: '/tmp/x.sock', launchEpoch: 'ep', capability: 'ab'.repeat(32),
  }, { reply: 'hang' });
  initial.emit('end');     // EOF @0, grace deadline 60000
  let guard = 0;
  while (fire() && guard++ < 200) { /* svuota i timer */ }
  // Senza per-attempt timeout il client restava con 1 tentativo e 0 timer.
  assert.ok(created.length >= 2, `R3.2: >=2 tentativi dentro la grace anche con server muto, ottenuti ${created.length}`);
  // I tentativi si FERMANO entro la grace (non vanno oltre 60s).
  assert.ok(clock() <= 60_000 + 1, `R3.2: tentativi fermi entro la grace, clock=${clock()}`);
});

test('R3.2 lease-client: deny -> retry bounded dalla grace (oltre non si ritenta)', () => {
  const { initial, created, fire, clock } = harness({
    stablePath: '/tmp/x.sock', launchEpoch: 'ep', capability: 'ab'.repeat(32),
  }, { reply: 'deny' });
  initial.emit('end');     // EOF @0, grace deadline 60000
  let guard = 0;
  while (fire() && guard++ < 200) { /* svuota i timer */ }
  assert.ok(created.length >= 2, `retry dentro la grace, ottenuti ${created.length}`);
  assert.ok(clock() <= 60_000 + 1, `R3.2: deny non si ritenta oltre la grace, clock=${clock()}`);
});
