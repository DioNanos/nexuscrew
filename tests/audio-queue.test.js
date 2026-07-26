'use strict';
// tests/audio-queue.test.js — coda enunciati: serializzazione, dedup,
// prelazione, watchdog dell'ack e stop locale sovrano. Nessun audio riprodotto:
// l'adapter e' un fake con seam espliciti.
const { test } = require('node:test');
const assert = require('node:assert');
const { createSpeakQueue } = require('../lib/audio/queue.js');

// Adapter fake: registra le chiamate e lascia al test il controllo di quando un
// enunciato "finisce". `startFails` simula uno spawn fallito.
function fakeAdapter({ startFails = false } = {}) {
  const calls = [];
  let resolveDone = null;
  return {
    calls,
    finish: () => { if (resolveDone) { const r = resolveDone; resolveDone = null; r({ code: 0 }); } },
    speak(args) {
      calls.push(args);
      if (startFails) return { started: false, reason: 'adapter-spawn-failed' };
      const done = new Promise((res) => { resolveDone = res; });
      return { started: true, done, kill: () => { if (resolveDone) { const r = resolveDone; resolveDone = null; r({ signal: 'SIGTERM' }); } } };
    },
  };
}

// Timer fake: nessuna attesa reale, il test decide quando scatta il watchdog.
function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return {
    setTimeoutImpl: (fn, ms) => { id += 1; timers.set(id, { fn, ms }); return id; },
    clearTimeoutImpl: (h) => timers.delete(h),
    fireAll: () => { for (const [h, t] of [...timers]) { timers.delete(h); t.fn(); } },
    size: () => timers.size,
  };
}

const statusLog = () => { const log = []; return { log, onStatus: (id, s, r) => log.push([id, s, r]) }; };

test('coda: accepted poi spoken quando l adapter conferma l avvio', () => {
  const a = fakeAdapter();
  const { log, onStatus } = statusLog();
  const q = createSpeakQueue({ adapter: a, onStatus, ...fakeTimers() });
  assert.deepEqual(q.enqueue({ utteranceId: 'u1', text: 'ciao' }), { status: 'accepted' });
  assert.deepEqual(log, [['u1', 'spoken', undefined]]);
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].text, 'ciao');
});

test('coda: un solo enunciato per volta — il secondo parte quando il primo finisce', () => {
  const a = fakeAdapter();
  const { onStatus } = statusLog();
  const q = createSpeakQueue({ adapter: a, onStatus, ...fakeTimers() });
  q.enqueue({ utteranceId: 'u1', text: 'primo' });
  q.enqueue({ utteranceId: 'u2', text: 'secondo' });
  assert.equal(a.calls.length, 1, 'un nodo ha una voce sola: gli enunciati non si sovrappongono');
  assert.equal(q.pendingSize(), 1);
});

test('coda: dedup — lo stesso utteranceId non viene pronunciato due volte', () => {
  const a = fakeAdapter();
  const q = createSpeakQueue({ adapter: a, ...fakeTimers() });
  q.enqueue({ utteranceId: 'u1', text: 'ciao' });
  const again = q.enqueue({ utteranceId: 'u1', text: 'ciao' });
  assert.deepEqual(again, { status: 'accepted', reason: 'duplicate' });
  assert.equal(a.calls.length, 1, 'un retry idempotente non produce una seconda voce');
});

test('coda: bounded — oltre il massimo in attesa si rifiuta invece di accumulare', () => {
  const a = fakeAdapter();
  const q = createSpeakQueue({ adapter: a, maxPending: 1, ...fakeTimers() });
  q.enqueue({ utteranceId: 'u1', text: 'a' });   // corrente
  q.enqueue({ utteranceId: 'u2', text: 'b' });   // in attesa
  assert.deepEqual(q.enqueue({ utteranceId: 'u3', text: 'c' }), { status: 'refused', reason: 'queue-full' });
});

test('prelazione: urgency high ferma il corrente e lo marca refused/preempted, mai spoken a posteriori', () => {
  const a = fakeAdapter();
  const transitions = [];
  const q = createSpeakQueue({
    adapter: a,
    onStatus: (id, s, r) => transitions.push(`${id}:${s}${r ? `/${r}` : ''}`),
    ...fakeTimers(),
  });
  q.enqueue({ utteranceId: 'u1', text: 'lungo' });
  q.enqueue({ utteranceId: 'u2', text: 'urgente', urgency: 'high' });
  assert.ok(transitions.includes('u1:refused/preempted'),
    `il prelazionato non diventa spoken a posteriori (${transitions.join(', ')})`);
  assert.ok(transitions.includes('u2:spoken'));
});

test('watchdog: senza ack entro il timeout lo stato e unknown, non spoken', () => {
  const a = fakeAdapter({ startFails: true });
  const transitions = [];
  const timers = fakeTimers();
  const q = createSpeakQueue({
    adapter: {
      speak: () => { throw new Error('boom'); },
    },
    onStatus: (id, s, r) => transitions.push(`${id}:${s}/${r}`),
    ...timers,
  });
  q.enqueue({ utteranceId: 'u1', text: 'x' });
  assert.ok(transitions.includes('u1:refused/adapter-error'),
    `un adapter che esplode e un rifiuto onesto (${transitions.join(', ')})`);
  void a;
});

test('watchdog: un enunciato che resta in attesa oltre il timeout diventa unknown', () => {
  const a = fakeAdapter();
  const transitions = [];
  const timers = fakeTimers();
  const q = createSpeakQueue({
    adapter: a, onStatus: (id, s, r) => transitions.push(`${id}:${s}/${r}`), ...timers,
  });
  q.enqueue({ utteranceId: 'u1', text: 'primo' });
  q.enqueue({ utteranceId: 'u2', text: 'in coda' });
  timers.fireAll();
  assert.ok(transitions.includes('u2:unknown/ack-timeout'),
    `senza conferma si dice unknown, non si promette (${transitions.join(', ')})`);
});

test('stop: locale sovrano — ferma il corrente e svuota la coda senza rete', () => {
  const a = fakeAdapter();
  const transitions = [];
  const q = createSpeakQueue({
    adapter: a, onStatus: (id, s, r) => transitions.push(`${id}:${s}/${r}`), ...fakeTimers(),
  });
  q.enqueue({ utteranceId: 'u1', text: 'a' });
  q.enqueue({ utteranceId: 'u2', text: 'b' });
  assert.equal(q.stopAll(), true);
  assert.ok(transitions.includes('u1:refused/stopped'));
  assert.ok(transitions.includes('u2:refused/stopped'));
  assert.equal(q.isBusy(), false);
  assert.equal(q.pendingSize(), 0);
});

test('stop: per utteranceId ferma solo quello indicato', () => {
  const a = fakeAdapter();
  const transitions = [];
  const q = createSpeakQueue({
    adapter: a, onStatus: (id, s, r) => transitions.push(`${id}:${s}/${r}`), ...fakeTimers(),
  });
  q.enqueue({ utteranceId: 'u1', text: 'a' });
  q.enqueue({ utteranceId: 'u2', text: 'b' });
  assert.equal(q.stop('u2'), true);
  assert.ok(transitions.includes('u2:refused/stopped'));
  assert.equal(q.currentId(), 'u1', 'il corrente non viene toccato');
});

test('coda: senza adapter si rifiuta esplicitamente, non si finge un accepted', () => {
  const q = createSpeakQueue({ adapter: null, ...fakeTimers() });
  assert.deepEqual(q.enqueue({ utteranceId: 'u1', text: 'x' }), { status: 'refused', reason: 'no-adapter' });
});
