'use strict';
// Fetta 2b — superficie child (B5: tre metodi distinti register/refresh/recovery;
// B2: incarnationId per-registration; B3: l'unita' dell'attempt e' la
// presentazione di recovery). Test sul manager reale.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { verifyProof, loadOrCreateVerifier } = require('../lib/fleet/lease-verifier.js');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leasechild-'));
  const clock = { t: 10_000 };
  const mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  return { home, clock, mgr };
}

test('register su cella tracciata: registration con incarnationId + proof kind child', async () => {
  const { home, clock, mgr } = setup();
  try {
    await mgr.track('Dev');
    const out = mgr.childRegister('Dev');
    assert.equal(out.status, 'registered');
    assert.match(out.incarnationId, /^[a-f0-9]{16,64}$/);
    assert.equal(out.proof.kind, 'child');
    assert.equal(out.proof.cellId, 'Dev');
    assert.equal(out.proof.incarnationId, out.incarnationId);
    // il proof verifica con la chiave per-installazione
    const v = loadOrCreateVerifier({ dir: path.join(home, '.nexuscrew', 'run') });
    const o = verifyProof([v], out.proof, { now: () => clock.t + 1, expect: { kind: 'child', cellId: 'Dev', incarnationId: out.incarnationId } });
    assert.equal(o.ok, true, JSON.stringify(o));
  } finally { mgr.close(); }
});

test('register su cella NON tracciata: pending (solo register puo rispondere pending, B5)', async () => {
  const { mgr } = setup();
  try {
    const out = mgr.childRegister('Sconosciuta');
    assert.equal(out.status, 'pending');
    assert.ok(Number.isInteger(out.retryAfterMs) && out.retryAfterMs > 0, 'indicazione di retry');
    assert.equal('proof' in out, false, 'pending non consegna proof');
  } finally { mgr.close(); }
});

test('B2: incarnationId per-registration — celle diverse, incarnazioni indipendenti', async () => {
  const { clock, mgr } = setup();
  try {
    await mgr.track('Dev');
    await mgr.track('Research');
    const a = mgr.childRegister('Dev');
    const b = mgr.childRegister('Research');
    assert.notEqual(a.incarnationId, b.incarnationId);
    // il proof di Dev NON rinfresca la registration di Research (scope per-cell)
    const cross = mgr.childRefresh('Research', a.proof);
    assert.equal(cross.status, 'denied');
    const own = mgr.childRefresh('Dev', a.proof);
    assert.equal(own.status, 'live');
  } finally { mgr.close(); }
});

test('refresh: registration viva -> proof nuovo; senza registration -> no-registration, MAI pending (B5)', async () => {
  const { clock, mgr } = setup();
  try {
    await mgr.track('Dev');
    const reg = mgr.childRegister('Dev');
    clock.t += 5_000;
    const out = mgr.childRefresh('Dev', reg.proof);
    assert.equal(out.status, 'live');
    assert.notEqual(out.proof.jti, reg.proof.jti, 'proof nuovo a ogni refresh');
    // senza registration: esito esplicito, non uno stato pendente
    const none = mgr.childRefresh('Research', reg.proof);
    assert.equal(none.status, 'no-registration');
    assert.equal('pending' in none, false);
  } finally { mgr.close(); }
});

test('refresh con proof scaduto (senza recovery) -> denied: il refresh non e un recovery', async () => {
  const { clock, mgr } = setup();
  try {
    await mgr.track('Dev');
    const reg = mgr.childRegister('Dev');
    clock.t += 61_000; // proof scaduto (B8: 60s)
    const out = mgr.childRefresh('Dev', reg.proof);
    assert.equal(out.status, 'denied');
    assert.equal(out.reason, 'expired');
  } finally { mgr.close(); }
});

test('recovery: riprende la STESSA incarnazione con proof scaduto da poco (ResumeFirst)', async () => {
  const { clock, mgr } = setup();
  try {
    await mgr.track('Dev');
    const reg = mgr.childRegister('Dev');
    clock.t += 61_000; // il proof e' scaduto da 1s: dentro la finestra di grace
    const out = mgr.childRecovery('Dev', reg.proof);
    assert.equal(out.status, 'live');
    assert.equal(out.incarnationId, reg.incarnationId, 'stessa incarnazione: il recovery RIPRENDE, non re-registra');
    assert.ok(out.proof && out.proof.jti !== reg.proof.jti, 'proof nuovo');
  } finally { mgr.close(); }
});

test('recovery oltre la finestra di grace della registration -> expired: serve register', async () => {
  const { clock, mgr } = setup();
  try {
    await mgr.track('Dev');
    const reg = mgr.childRegister('Dev');
    clock.t += 61_000 + 60_000 + 1; // proof scaduto oltre la grace di recovery
    const out = mgr.childRecovery('Dev', reg.proof);
    assert.equal(out.status, 'expired');
  } finally { mgr.close(); }
});

test('B3: ogni PRESENTAZIONE di recovery conta; oltre il cap la registration e chiusa', async () => {
  const { clock, mgr } = setup();
  try {
    await mgr.track('Dev');
    const reg = mgr.childRegister('Dev');
    clock.t += 61_000;
    // presentazioni che NON riprendono (proof di un altra incarnazione): contano
    const bogus = { ...reg.proof, incarnationId: 'f'.repeat(16), proof: '0'.repeat(64) };
    let last = null;
    for (let i = 0; i < 12; i += 1) {
      last = mgr.childRecovery('Dev', bogus);
    }
    assert.equal(last.status, 'denied');
    assert.equal(last.reason, 'attempt-bound', 'il confine e' + ' il numero di presentazioni, non di connessioni');
    // Anche il proof BUONO ora e' chiuso: la registration e' stata consumata dai tentativi
    const good = mgr.childRecovery('Dev', reg.proof);
    assert.equal(good.status, 'denied');
    assert.equal(good.reason, 'attempt-bound');
  } finally { mgr.close(); }
});

test('scope separation: un proof supervisore (kind lease) non vale come proof child', async () => {
  const { home, clock, mgr } = setup();
  try {
    await mgr.track('Dev');
    const reg = mgr.childRegister('Dev');
    const leaseProof = (() => {
      const v = loadOrCreateVerifier({ dir: path.join(home, '.nexuscrew', 'run') });
      // firmato col kind supervisore: la firma e' valida, il kind no
      const { signProof } = require('../lib/fleet/lease-verifier.js');
      return signProof(v, { kind: 'lease', cellId: 'Dev', launchEpoch: 'a'.repeat(16), leaseId: 'b'.repeat(16), generation: '0', jti: 'c'.repeat(16), issuedAt: clock.t }, { now: () => clock.t });
    })();
    const out = mgr.childRefresh('Dev', leaseProof);
    assert.equal(out.status, 'denied');
    assert.equal(out.reason, 'kind');
  } finally { mgr.close(); }
});
