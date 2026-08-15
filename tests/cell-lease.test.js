'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const lease = require('../lib/fleet/cell-lease.js');

const NOW = 10_000;
const LID_A = 'aa'.repeat(16);
const LID_B = 'bb'.repeat(16);

function open(now = NOW, leaseId = LID_A, generation = 0) {
  return lease.openLease({ cellId: 'Dev', launchEpoch: 'ep1', generation, leaseId, now });
}

test('openLease: nasce live, senza grace; argomenti invalidi -> null (fail-closed)', () => {
  const l = open();
  assert.equal(l.state, 'live');
  assert.equal(l.graceDeadline, null);
  assert.equal(l.eofArmedAt, null);
  assert.equal(l.lastRefreshedAt, NOW);
  assert.equal(l.cellId, 'Dev');
  assert.equal(l.launchEpoch, 'ep1');
  assert.equal(l.generation, 0);
  assert.equal(lease.openLease({ cellId: 'X', launchEpoch: 'e', generation: -1, leaseId: LID_A, now: 1 }), null);
  assert.equal(lease.openLease({ cellId: 'X', launchEpoch: 'e', generation: 0, leaseId: 'nothex', now: 1 }), null);
  assert.equal(lease.openLease({ cellId: '', launchEpoch: 'e', generation: 0, leaseId: LID_A, now: 1 }), null);
});

test('armGrace: EOF arma UNA sola transizione Live->Grace; deadline NON estendibile', () => {
  const l = open();
  const eofAt = NOW + 5;
  const g1 = lease.armGrace(l, { now: eofAt });
  assert.equal(g1.state, 'grace');
  assert.equal(g1.eofArmedAt, eofAt);
  assert.equal(g1.graceDeadline, eofAt + lease.GRACE_MS);
  // Un secondo EOF molto piu' tardi: no-op, deadline immutabile (non estendibile)
  const g2 = lease.armGrace(g1, { now: eofAt + 45_000 });
  assert.equal(g2.state, 'grace');
  assert.equal(g2.graceDeadline, g1.graceDeadline, 'la grace deadline NON si estende con un secondo EOF');
  assert.equal(g2.eofArmedAt, g1.eofArmedAt);
  assert.equal(lease.armGrace(null, { now: 1 }), null);
});

test('monotonia per-lease: nessuna operazione riporta in Live un lease in Grace', () => {
  const l = open();
  const g = lease.armGrace(l, { now: NOW + 5 });
  assert.equal(lease.refresh(g, { now: NOW + 10 }).state, 'grace', 'refresh non riporta in live');
  assert.equal(lease.armGrace(g, { now: NOW + 20 }).state, 'grace', 'armGrace non riporta in live');
  // Non esiste in questo modulo alcuna funzione che, dato un lease in Grace,
  // restituisca lo STESSO lease in Live: solo reattach crea un lease diverso.
});

test('refresh: aggiorna lastRefreshedAt senza cambiare state', () => {
  const l = open();
  const r = lease.refresh(l, { now: NOW + 1000 });
  assert.equal(r.state, 'live');
  assert.equal(r.lastRefreshedAt, NOW + 1000);
  // Su grace aggiorna lastRefreshedAt ma resta in grace
  const g = lease.armGrace(l, { now: NOW + 5 });
  const rg = lease.refresh(g, { now: NOW + 5000 });
  assert.equal(rg.state, 'grace');
  assert.equal(rg.lastRefreshedAt, NOW + 5000);
  assert.equal(rg.graceDeadline, g.graceDeadline);
});

test('reattach: lease NUOVO (leaseId diverso), stessa identita', () => {
  const l = open(NOW, LID_A, 0);
  const g = lease.armGrace(l, { now: NOW + 5 });
  const re = lease.reattach(g, { leaseId: LID_B, generation: 0, now: NOW + 10_000 });
  assert.equal(re.state, 'live');
  assert.equal(re.leaseId, LID_B);
  assert.notEqual(re.leaseId, l.leaseId, 'lease NUOVO, non resurrezione del precedente');
  assert.equal(re.cellId, l.cellId, 'stessa identita cellId');
  assert.equal(re.launchEpoch, l.launchEpoch, 'stessa identita launchEpoch');
  assert.equal(re.generation, 0);
  assert.equal(re.graceDeadline, null);
  // Il vecchio lease resta nella sua grace: la monotonia per-lease e' intatta
  assert.equal(g.state, 'grace');
  assert.equal(g.leaseId, LID_A);
  // Generation avanzata al reconnect (child restartato): comunque stesso launchEpoch
  const re2 = lease.reattach(g, { leaseId: 'cc'.repeat(16), generation: 1, now: NOW + 11_000 });
  assert.equal(re2.generation, 1);
  assert.equal(re2.launchEpoch, l.launchEpoch);
  // Argomenti invalidi -> null
  assert.equal(lease.reattach(g, { leaseId: 'nothex', generation: 0, now: 1 }), null);
});

test('reattach: oltre la grace il reconnect e rifiutato (R3.3.5)', () => {
  const l = open(NOW, LID_A, 0);
  const g = lease.armGrace(l, { now: NOW });
  // reconnect entro la grace -> ok
  assert.ok(lease.reattach(g, { leaseId: LID_B, generation: 0, now: NOW + lease.GRACE_MS - 1 }));
  // reconnect alla/deadline scaduta -> null (ineligible)
  assert.equal(lease.reattach(g, { leaseId: LID_B, generation: 0, now: g.graceDeadline }), null);
  assert.equal(lease.reattach(g, { leaseId: LID_B, generation: 0, now: g.graceDeadline + 1 }), null);
});

test('isLive/isGrace/isExpired: transizione temporale', () => {
  const l = open(NOW);
  assert.equal(lease.isLive(l), true);
  assert.equal(lease.isGrace(l), false);
  assert.equal(lease.isExpired(l), false);
  const g = lease.armGrace(l, { now: NOW });
  assert.equal(lease.isLive(g), false);
  assert.equal(lease.isGrace(g, { now: NOW + 1000 }), true);
  assert.equal(lease.isExpired(g, { now: NOW + 1000 }), false);
  assert.equal(lease.isGrace(g, { now: g.graceDeadline }), false);
  assert.equal(lease.isExpired(g, { now: g.graceDeadline }), true);
  assert.equal(lease.isExpired(g, { now: g.graceDeadline + 1 }), true);
});

test('identityKey: chiave composita cellId:launchEpoch:generation', () => {
  assert.equal(lease.identityKey('Dev', 'ep1', 3), 'Dev:ep1:3');
  assert.equal(lease.identityKey('', 'ep1', 0), null);
  assert.equal(lease.identityKey('Dev', 'ep1', -1), null);
});

test('costanti del contratto fissate (non lasciate a Worker)', () => {
  assert.equal(lease.GRACE_MS, 60_000, 'grace 60s (R3.2)');
  assert.equal(lease.REFRESH_MS, 20_000, 'refresh 20s (R3.2)');
  // >=2 tentativi strettamente dentro la grace (rev13 S3.3): cadenza 20s in 60s
  const attemptsInGrace = Math.floor(lease.GRACE_MS / lease.RECONNECT_CADENCE_MS);
  assert.ok(attemptsInGrace >= 2, 'almeno due tentativi strettamente dentro la grace');
});
