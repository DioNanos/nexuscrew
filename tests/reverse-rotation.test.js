'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const store = require('../lib/nodes/store.js');
const rotation = require('../lib/nodes/reverse-rotation.js');

function pool() { return store.reversePoolDefault(44003, { verification: 'verified', generation: 4 }); }

test('reverse rotation: reserve, commit, grace e replay della generation vecchia', () => {
  const base = pool();
  const prepared = rotation.prepareRotation(base, { slot: 1, now: 100, leaseId: 'a'.repeat(32), leaseMs: 60 });
  assert.equal(prepared.slots[1].state, 'reserved');
  assert.equal(prepared.slots[1].generation, 5);
  assert.equal(rotation.commitRotation(prepared, { leaseId: 'wrong', now: 110 }), null);
  const switched = rotation.commitRotation(prepared, { leaseId: 'a'.repeat(32), now: 110, graceMs: 30 });
  assert.equal(switched.activeSlot, 1);
  assert.equal(switched.slots[0].state, 'draining');
  assert.equal(switched.rotation.oldGeneration, 4);
  assert.equal(rotation.settleGrace(switched, { now: 139 }), null);
  const settled = rotation.settleGrace(switched, { now: 140 });
  assert.equal(settled.slots[0].state, 'ready');
  assert.equal(settled.activeGeneration, 5);
});

test('reverse rotation: pool non verificato, lease scaduto e candidate quarantinata non avanzano', () => {
  const unverified = store.reversePoolDefault(44003);
  assert.equal(rotation.prepareRotation(unverified, { slot: 1, now: 1, leaseId: 'b'.repeat(32) }), null);
  const prepared = rotation.prepareRotation(pool(), { slot: 1, now: 1, leaseId: 'b'.repeat(32), leaseMs: 10 });
  assert.equal(rotation.commitRotation(prepared, { leaseId: 'b'.repeat(32), now: 12 }), null);
  const quarantined = rotation.quarantineSlot(prepared, { slot: 1, now: 2 });
  assert.equal(quarantined.slots[1].state, 'quarantined');
  assert.equal(quarantined.rotation.phase, 'abandoned');
});

// --- chiusura parziale: la decisione, isolata dai processi ------------------
// Durante la grace di una rotazione lo slot vecchio e quello nuovo coesistono.
// Il difetto era dichiarare successo appena UNA entry si chiudeva, lasciando
// l'altra viva mentre chi chiama registrava il canale come privato. La logica
// vive ora in una funzione pura, testabile senza tunnel ne' processi.
test('summarizeStops: una chiusura parziale non e\' una chiusura', () => {
  const outcome = rotation.summarizeStops([
    { stopped: true },
    { stopped: false, reason: 'supervisor non attribuibile' },
  ]);
  assert.equal(outcome.stoppedAny, true);
  assert.equal(outcome.quarantinedAny, true);
  assert.equal(outcome.allClosed, false, 'una sola entry chiusa non basta');
});

test('summarizeStops: tutte spente in modo dimostrabile', () => {
  const outcome = rotation.summarizeStops([
    { stopped: true },
    { stopped: false, reason: 'no pidfile' },
    { stopped: false, reason: 'stale (pid dead)' },
  ]);
  assert.equal(outcome.allClosed, true, 'gia\' sparite conta come spente: non resta nulla di vivo');
  assert.equal(outcome.quarantinedAny, false);
});

test('summarizeStops: nessuna entry non dimostra nulla', () => {
  assert.equal(rotation.summarizeStops([]).allClosed, false);
  assert.equal(rotation.summarizeStops(undefined).allClosed, false);
});

test('summarizeStops: tutte in quarantena', () => {
  const outcome = rotation.summarizeStops([
    { stopped: false, reason: 'permesso negato' },
    { stopped: false, reason: 'pid di un altro processo' },
  ]);
  assert.equal(outcome.stoppedAny, false);
  assert.equal(outcome.allClosed, false);
});

test('stopWasDemonstrated: solo stopped o gia\' sparito', () => {
  assert.equal(rotation.stopWasDemonstrated({ stopped: true }), true);
  assert.equal(rotation.stopWasDemonstrated({ stopped: false, reason: 'no pidfile' }), true);
  assert.equal(rotation.stopWasDemonstrated({ stopped: false, reason: 'stale (pid dead)' }), true);
  assert.equal(rotation.stopWasDemonstrated({ stopped: false, reason: 'altro' }), false);
  assert.equal(rotation.stopWasDemonstrated(null), false);
});

// --- verifica del pool: cosa significa davvero "unverifiable" ----------------
// `verified` richiede TUTTI gli slot, ed e' deliberato: rotateRotatableReverse
// rifiuta di commutare dentro un pool non interamente provato. La conseguenza
// pero' e' pesante e finora taceva: senza pool verificato la rotazione
// automatica non parte e il watcher non viene nemmeno armato. In campo, su un
// link reale, questo significa autoriparazione spenta senza che nulla lo dica.
test('summarizePoolVerification: tutti provati -> verificato e rotazione attiva', () => {
  const out = rotation.summarizePoolVerification(
    [{ slot: 0, proven: true }, { slot: 1, proven: true }, { slot: 2, proven: true }], 3);
  assert.deepEqual(out.verifiedSlots, [0, 1, 2]);
  assert.equal(out.verification, 'verified');
  assert.equal(out.rotationActive, true);
  assert.deepEqual(out.failures, []);
});

test('summarizePoolVerification: uno slot guasto non nasconde i sani che seguono', () => {
  // Prima ci si fermava al primo fallimento: lo slot 2 sano restava invisibile
  // e la diagnosi diceva "uno solo provato" invece di "solo il numero 1 e' rotto".
  const out = rotation.summarizePoolVerification(
    [{ slot: 0, proven: true }, { slot: 1, proven: false, code: 'reverse-slot-proof-unavailable' }, { slot: 2, proven: true }], 3);
  assert.deepEqual(out.verifiedSlots, [0, 2], 'lo slot sano dopo il guasto resta contato');
  assert.deepEqual(out.failures, [{ slot: 1, code: 'reverse-slot-proof-unavailable' }]);
  assert.equal(out.verification, 'unverifiable', 'restano comunque necessari tutti gli slot');
  assert.equal(out.rotationActive, false);
});

test('summarizePoolVerification: il caso di campo — attivo provato, riserve mute', () => {
  const out = rotation.summarizePoolVerification([
    { slot: 0, proven: true },
    { slot: 1, proven: false, code: 'reverse-slot-proof-unavailable' },
    { slot: 2, proven: false, code: 'reverse-slot-proof-unavailable' },
  ], 3);
  assert.deepEqual(out.verifiedSlots, [0]);
  assert.equal(out.rotationActive, false, 'lo slot attivo provato NON basta ad attivare la rotazione');
  assert.equal(out.failures.length, 2);
});

test('summarizePoolVerification: un codice non valido non entra nella diagnosi', () => {
  const out = rotation.summarizePoolVerification(
    [{ slot: 0, proven: false, code: 'Bearer segreto-che-non-deve-uscire' }], 1);
  assert.deepEqual(out.failures, [{ slot: 0, code: 'reverse-slot-verify-failed' }]);
});

test('summarizePoolVerification: zero slot non e\' "tutto verificato"', () => {
  // Senza un pool da provare non c'e' nulla da cui ruotare: la verita' vacua
  // qui armerebbe un watcher su niente.
  assert.equal(rotation.summarizePoolVerification([], 0).verification, 'unverifiable');
  assert.equal(rotation.summarizePoolVerification([], 0).rotationActive, false);
  assert.equal(rotation.summarizePoolVerification(undefined, 3).verification, 'unverifiable');
});
