'use strict';
// Unit of the incarnation cleanup function (function only, no wiring).
//
// The quiescence proof is a SYNTHETIC input built by these tests: the real
// global proof, its Fleet conservation, the coordinator clock adapter and
// the hook that interprets this outcome belong to the wiring step and are
// declared NOT verified here. Everything runs in throwaway directories and
// child processes: never the installed instance, never the live Fleet, no
// signal to any real process.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const PERCORSO_MODULO = require.resolve('../lib/fleet/vl-node-runtime.js');
const PERCORSO_FIGLIO = path.join(__dirname, 'helpers', 'vl-node-cleanup-child.js');

function copiaFrescaModulo() {
  delete require.cache[PERCORSO_MODULO];
  return require(PERCORSO_MODULO);
}

function mondo(t, { bin = '#!/bin/sh\nexit 0\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-clean-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true, mode: 0o755 });
  const exec = path.join(root, 'bin', 'node');
  fs.writeFileSync(exec, bin);
  fs.chmodSync(exec, 0o755);
  const deps = {
    execPath: exec,
    versionsNode: '26.12.1',
    tmpdir: path.join(root, 'stage'),
    probe: () => ({ status: 0, stdout: 'v26.12.1\n', stderr: '', error: null }),
  };
  return { root, exec, deps };
}

// A secondary source with different bytes so every qualification targets its
// own absent destination name.
function eseguiSecondario(d, contenuto) {
  const exec2 = path.join(d.root, 'bin', `node-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(exec2, contenuto);
  fs.chmodSync(exec2, 0o755);
  return exec2;
}

// Deterministic clock seam in its own domain: the proof deadline and the
// clock readings belong to the same numbers. A `salto` jumps the clock from
// the SECOND read on, so the admission reading stays coherent with the proof
// that was just built.
function orologio(inizio = 1000) {
  const o = { t: inizio, letture: 0, salto: null };
  o.now = () => {
    o.letture += 1;
    if (o.salto !== null && o.letture >= 2) { o.t = o.salto; o.salto = null; }
    return o.t;
  };
  return o;
}

function provaValida(mod, deadlineMono, override = {}) {
  return {
    nonce: mod.getCreationRegistry().nonce,
    processDisarmed: true,
    processQuiescent: true,
    fleetDisarmed: true,
    timedOut: false,
    producers: 0,
    claims: 0,
    consumers: 0,
    canCleanupOwnedResources: true,
    deadlineMono,
    ...override,
  };
}

// Recording cleanup seams (the Sync names only), with optional fault hooks:
// each hook returns an errno string for the calls it must fail, or null.
function depsCleanup(orologioUsato, guasti = {}, agganci = {}) {
  const registro = {
    lstat: 0, fstat: 0, close: 0, fsync: 0,
    unlink: [], rmdir: [], open: [],
    fdPerPath: new Map(),
  };
  const deps = {
    monotonicNow: orologioUsato.now,
    lstatSync: (p) => {
      registro.lstat += 1;
      const c = guasti.lstat && guasti.lstat(p);
      if (c) { const e = new Error(c); e.code = c; throw e; }
      return fs.lstatSync(p);
    },
    unlinkSync: (p) => {
      registro.unlink.push(p);
      const c = guasti.unlink && guasti.unlink(p);
      if (c) { const e = new Error(c); e.code = c; throw e; }
      return fs.unlinkSync(p);
    },
    rmdirSync: (p) => {
      registro.rmdir.push(p);
      const c = guasti.rmdir && guasti.rmdir(p);
      if (c) { const e = new Error(c); e.code = c; throw e; }
      return fs.rmdirSync(p);
    },
    openSync: (p, flags, mode) => {
      if (agganci.open) agganci.open(p);
      const fd = fs.openSync(p, flags, mode);
      registro.open.push(p);
      registro.fdPerPath.set(p, fd);
      return fd;
    },
    fstatSync: (fd) => {
      registro.fstat += 1;
      return fs.fstatSync(fd);
    },
    fsyncSync: (fd) => {
      registro.fsync += 1;
      const c = guasti.fsync && guasti.fsync(fd);
      if (c) { const e = new Error(c); e.code = c; throw e; }
      return fs.fsyncSync(fd);
    },
    closeSync: (fd) => {
      registro.close += 1;
      const c = guasti.close && guasti.close(fd);
      if (c) { const e = new Error(c); e.code = c; throw e; }
      return fs.closeSync(fd);
    },
  };
  return { deps, registro };
}

const ident = (p) => {
  const st = fs.lstatSync(p);
  return { dev: st.dev, ino: st.ino };
};

function contaOggetti(dir) {
  let n = 0;
  const walk = (d) => {
    for (const nome of fs.readdirSync(d)) {
      n += 1;
      const p = path.join(d, nome);
      if (fs.lstatSync(p).isDirectory()) walk(p);
    }
  };
  walk(dir);
  return n;
}

// A world with one snapshot (plus its removed temporary), one residual
// temporary from a failed second qualification, and two home publications
// (one via link, one via exclusive create with link denied).
function mondoRicco(t, mod, d) {
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true, JSON.stringify(q1));
  const origFstat = fs.fstatSync;
  const r2 = mod.qualifica({
    ...d.deps,
    execPath: eseguiSecondario(d, '#!/bin/sh\nexit 7\n'),
    fsync: (fd) => {
      if (origFstat(fd).isFile()) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
      fs.fsyncSync(fd);
    },
    unlink: () => { const e = new Error('EIO'); e.code = 'EIO'; throw e; },
  });
  assert.equal(r2.ok, false);
  const residuoTmp = mod.getCreationRegistry().tempFiles.find((e) => e.unlinked === false);
  assert.ok(residuoTmp, 'the residual temporary must be censused');
  const homes = [];
  for (const esito of ['link', 'wx']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `nc-clean-${esito}-`));
    t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
    fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
    const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
    let p;
    if (esito === 'wx') {
      const origLink = fs.linkSync;
      fs.linkSync = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
      try {
        p = mod.pubblica(q1, staging, d.deps);
      } finally {
        fs.linkSync = origLink;
      }
    } else {
      p = mod.pubblica(q1, staging, d.deps);
    }
    assert.equal(p.ok, true, JSON.stringify(p));
    homes.push({ home, staging, pubblicato: p });
  }
  return { q1, residuoTmp, homes, dir: path.dirname(q1.path) };
}

// ---------------------------------------------------------------- positives

test('cleanup: a clean incarnation removes exactly its own names, measured on disk', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const mondo1 = mondoRicco(t, mod, d);
  const { q1, residuoTmp, homes, dir } = mondo1;
  const uid = process.getuid();
  const parentPerUid = path.join(d.deps.tmpdir, `nc-vl-node-${uid}`);
  const oggettiPrima = contaOggetti(d.root)
    + contaOggetti(homes[0].home)
    + contaOggetti(homes[1].home);
  assert.ok(oggettiPrima > 0);

  const orol = orologio();
  const { deps, registro } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);

  assert.deepEqual(Object.keys(esito), ['schema', 'outcome', 'reason', 'counts', 'replayed']);
  assert.equal(esito.schema, 1);
  assert.equal(esito.outcome, 'done');
  assert.equal(esito.reason, null);
  assert.equal(esito.replayed, false);
  assert.deepEqual(esito.counts, {
    candidates: 7, removed: 7, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
  });
  // EFFECTS: the own names are really gone, the shared parents really stay.
  assert.equal(fs.existsSync(q1.path), false, 'snapshot must be removed');
  assert.equal(fs.existsSync(residuoTmp.path), false, 'residual temporary must be removed');
  assert.equal(fs.existsSync(dir), false, 'instance directory must be removed');
  for (const { pubblicato } of homes) {
    assert.equal(fs.existsSync(pubblicato.path), false, 'home final must be removed');
    assert.equal(fs.existsSync(path.dirname(pubblicato.path)), false, 'namespace must be removed');
  }
  assert.equal(fs.existsSync(parentPerUid), true, 'the per-uid shared parent must survive');
  for (const { staging } of homes) {
    assert.equal(fs.existsSync(staging), true, 'the shared staging must survive');
  }
  const oggettiDopo = contaOggetti(d.root)
    + contaOggetti(homes[0].home)
    + contaOggetti(homes[1].home);
  assert.ok(oggettiDopo < oggettiPrima, 'the number of objects on disk must decrease');
  assert.equal(oggettiPrima - oggettiDopo, 7, 'exactly the seven own names must disappear');
  // Durability: every modified parent was synced (own dir before its rmdir,
  // shared parent after each rmdir).
  assert.ok(registro.fsync >= 6, `expected at least one fsync per modified parent, got ${registro.fsync}`);
  const registroDopo = mod.getCreationRegistry();
  for (const e of registroDopo.entries) {
    if (['instance-dir', 'snapshot-file', 'home-namespace', 'home-final'].includes(e.kind)) {
      assert.equal(e.unlinked, true, `${e.kind} must be marked removed`);
    }
  }

  // Idempotency: the second call replays the terminal data with zero new
  // removal syscalls, whatever proof and deadline it carries.
  const unlinkPrima = registro.unlink.length;
  const rmdirPrima = registro.rmdir.length;
  const fsyncPrima = registro.fsync;
  const esito2 = mod.cleanupInstance(provaValida(mod, orol.t + 1e9), deps);
  assert.equal(esito2.replayed, true);
  assert.equal(esito2.outcome, 'done');
  assert.equal(esito2.reason, null);
  assert.deepEqual(esito2.counts, esito.counts);
  assert.equal(registro.unlink.length, unlinkPrima, 'the replay must not unlink');
  assert.equal(registro.rmdir.length, rmdirPrima, 'the replay must not rmdir');
  assert.equal(registro.fsync, fsyncPrima, 'the replay must not fsync');
});

test('cleanup: an empty registry with nonce null concludes done without filesystem', (t) => {
  const mod = copiaFrescaModulo();
  const orol = orologio();
  const { deps, registro } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000, { nonce: null }), deps);
  assert.equal(esito.outcome, 'done');
  assert.equal(esito.reason, null);
  assert.equal(esito.replayed, false);
  assert.deepEqual(esito.counts, {
    candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
  });
  assert.equal(registro.lstat, 0);
  assert.equal(registro.open.length, 0);
  assert.equal(registro.unlink.length, 0);
  assert.equal(registro.rmdir.length, 0);
  assert.equal(registro.fsync, 0);
  // The never-used module is now permanently disarmed.
  const d = mondo(t);
  const r = mod.qualifica(d.deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_STAGE');
  assert.equal(r.motivo, 'cleanup-started');
});

// ------------------------------------------------------------------- disarm

test('cleanup: after the admitted round the module refuses new work without effects', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const mondo1 = mondoRicco(t, mod, d);
  const orol = orologio();
  // The synthetic clock is passed to the function too, so the deadline built
  // from it belongs to the same domain as the readings.
  const { deps } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'done');

  const vociPrima = mod.getCreationRegistry().entries.length;
  const exec3 = eseguiSecondario(d, '#!/bin/sh\nexit 9\n');
  const staging3 = path.join(mondo1.homes[0].home, 'altro', 'vl-claim-pin');
  fs.mkdirSync(path.dirname(staging3), { recursive: true, mode: 0o700 });
  const oggettiPrima = contaOggetti(d.root) + contaOggetti(mondo1.homes[0].home) + contaOggetti(mondo1.homes[1].home);
  // The cleanup-started guard fires before the isDisarmed seam and before
  // every effect or census.
  const rQ = mod.qualifica({ ...d.deps, execPath: exec3, isDisarmed: () => false });
  assert.equal(rQ.ok, false);
  assert.equal(rQ.code, 'PIN_STAGE');
  assert.equal(rQ.motivo, 'cleanup-started');
  const rP = mod.pubblica(mondo1.q1, staging3, { isDisarmed: () => false });
  assert.equal(rP.ok, false);
  assert.equal(rP.code, 'PIN_STAGE');
  assert.equal(rP.motivo, 'cleanup-started');
  assert.equal(mod.getCreationRegistry().entries.length, vociPrima, 'no new census entries');
  const oggettiDopo = contaOggetti(d.root) + contaOggetti(mondo1.homes[0].home) + contaOggetti(mondo1.homes[1].home);
  assert.equal(oggettiDopo, oggettiPrima, 'the refused calls must have no effect on disk');
  assert.equal(fs.existsSync(staging3), false, 'no new directory may be created');
});

// --------------------------------------------------------- proof validation

test('cleanup: an invalid proof refuses without effects, without disarm, and is never stored', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true, JSON.stringify(q1));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-clean-prova-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  const p1 = mod.pubblica(q1, staging, d.deps);
  assert.equal(p1.ok, true, JSON.stringify(p1));

  const orol = orologio();
  const { deps, registro } = depsCleanup(orol);
  const base = () => provaValida(mod, orol.t + 60000);
  const senza = (campo) => (p) => { const q = { ...p }; delete q[campo]; return q; };
  const casi = [
    ['missing nonce', senza('nonce'), 'proof-invalid'],
    ['missing processDisarmed', senza('processDisarmed'), 'proof-invalid'],
    ['missing processQuiescent', senza('processQuiescent'), 'proof-invalid'],
    ['missing fleetDisarmed', senza('fleetDisarmed'), 'proof-invalid'],
    ['missing timedOut', senza('timedOut'), 'proof-invalid'],
    ['missing producers', senza('producers'), 'proof-invalid'],
    ['missing claims', senza('claims'), 'proof-invalid'],
    ['missing consumers', senza('consumers'), 'proof-invalid'],
    ['missing canCleanupOwnedResources', senza('canCleanupOwnedResources'), 'proof-invalid'],
    ['missing deadlineMono', senza('deadlineMono'), 'proof-invalid'],
    ['extra seq field', (p) => ({ ...p, seq: 1 }), 'proof-invalid'],
    ['extra snapshot field', (p) => ({ ...p, snapshot: { entries: [] } }), 'proof-invalid'],
    ['extra entries field', (p) => ({ ...p, entries: [] }), 'proof-invalid'],
    ['extra plan field', (p) => ({ ...p, plan: [] }), 'proof-invalid'],
    ['inherited nonce', (p) => {
      const proprie = { ...p };
      delete proprie.nonce;
      return Object.assign(Object.create({ nonce: p.nonce }), proprie);
    }, 'proof-invalid'],
    ['nonce of wrong type', (p) => ({ ...p, nonce: 123 }), 'proof-invalid'],
    ['nonce empty string', (p) => ({ ...p, nonce: '' }), 'nonce-mismatch'],
    ['flag not boolean', (p) => ({ ...p, processDisarmed: 1 }), 'proof-invalid'],
    ['flag string', (p) => ({ ...p, fleetDisarmed: 'true' }), 'proof-invalid'],
    ['timedOut not boolean', (p) => ({ ...p, timedOut: 0 }), 'proof-invalid'],
    ['count not integer', (p) => ({ ...p, producers: 1.5 }), 'proof-invalid'],
    ['count string', (p) => ({ ...p, consumers: '0' }), 'proof-invalid'],
    ['deadline not number', (p) => ({ ...p, deadlineMono: '500' }), 'proof-invalid'],
    ['deadline NaN', (p) => ({ ...p, deadlineMono: NaN }), 'proof-invalid'],
    ['deadline Infinity', (p) => ({ ...p, deadlineMono: Infinity }), 'proof-invalid'],
    ['deadline null', (p) => ({ ...p, deadlineMono: null }), 'proof-invalid'],
    ['process not disarmed', (p) => ({ ...p, processDisarmed: false }), 'not-quiescent'],
    ['process not quiescent', (p) => ({ ...p, processQuiescent: false }), 'not-quiescent'],
    ['fleet not disarmed', (p) => ({ ...p, fleetDisarmed: false }), 'not-quiescent'],
    ['timed out', (p) => ({ ...p, timedOut: true }), 'not-quiescent'],
    ['a producer still alive', (p) => ({ ...p, producers: 1 }), 'not-quiescent'],
    ['a claim still live', (p) => ({ ...p, claims: 1 }), 'not-quiescent'],
    ['a consumer still live', (p) => ({ ...p, consumers: 2 }), 'not-quiescent'],
    ['cannot cleanup owned resources', (p) => ({ ...p, canCleanupOwnedResources: false }), 'not-quiescent'],
    ['nonce null on a used module', (p) => ({ ...p, nonce: null }), 'nonce-mismatch'],
  ];
  for (const [nome, muta, motivo] of casi) {
    const e = mod.cleanupInstance(muta(base()), deps);
    assert.equal(e.outcome, 'refused', nome);
    assert.equal(e.reason, motivo, nome);
    assert.equal(e.replayed, false, nome);
    assert.deepEqual(e.counts, {
      candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
    }, nome);
  }
  // Zero filesystem activity for every refusal.
  assert.equal(registro.lstat, 0);
  assert.equal(registro.open.length, 0);
  assert.equal(registro.unlink.length, 0);
  assert.equal(registro.rmdir.length, 0);
  assert.equal(registro.fsync, 0);
  // No disarm: the module still works, and nothing was stored: a valid call
  // can follow the refusals and admits normally.
  const riuso = mod.qualifica(d.deps);
  assert.equal(riuso.ok, true, 'a refused proof must never disarm the module');
  const esito = mod.cleanupInstance(base(), deps);
  assert.equal(esito.outcome, 'done', JSON.stringify(esito));
  assert.equal(esito.replayed, false);
  assert.equal(fs.existsSync(q1.path), false);
});

test('cleanup: malformed deps and own-key violations refuse before a terminal and never disarm', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const orol = orologio();
  const { deps, registro } = depsCleanup(orol);
  // Explicitly malformed deps (null, array, non-object) refuses closed,
  // before admission, with zero counts and no exception thrown.
  for (const cattivi of [null, [], 'deps', 7, true, () => {}]) {
    const e = mod.cleanupInstance(provaValida(mod, orol.t + 60000), cattivi);
    assert.equal(e.outcome, 'refused', JSON.stringify(String(cattivi)));
    assert.equal(e.reason, 'proof-invalid');
    assert.equal(e.replayed, false);
    assert.deepEqual(e.counts, {
      candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
    });
  }
  // Own-key violations: a Symbol own key and a non-enumerable extra key are
  // counted by the proof validation and refuse the same closed way.
  const conSimbolo = provaValida(mod, orol.t + 60000);
  conSimbolo[Symbol('seq')] = 1;
  const conNonEnumerabile = provaValida(mod, orol.t + 60000);
  Object.defineProperty(conNonEnumerabile, 'plan', {
    value: [], enumerable: false, writable: true, configurable: true,
  });
  for (const p of [conSimbolo, conNonEnumerabile]) {
    const e = mod.cleanupInstance(p, deps);
    assert.equal(e.outcome, 'refused');
    assert.equal(e.reason, 'proof-invalid');
    assert.equal(e.replayed, false);
    assert.deepEqual(e.counts, {
      candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
    });
  }
  // Zero effects so far: no seam I/O, nothing removed on disk and no disarm;
  // a valid call may follow the refusals and admits normally.
  assert.equal(registro.lstat, 0);
  assert.equal(registro.unlink.length, 0);
  assert.equal(registro.rmdir.length, 0);
  assert.equal(registro.open.length, 0);
  assert.equal(fs.existsSync(q1.path), true, 'a malformed deps must remove nothing');
  assert.equal(mod.qualifica(d.deps).ok, true, 'a malformed deps must never disarm the module');
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'done', JSON.stringify(esito));
  assert.equal(esito.replayed, false);
  assert.equal(fs.existsSync(q1.path), false);
  // After the terminal the replay ignores proof AND deps entirely: a
  // malformed deps returns the frozen data with no effects whatsoever.
  const rimosse = registro.unlink.length;
  const esito2 = mod.cleanupInstance({ garbage: true }, null);
  assert.equal(esito2.replayed, true);
  assert.equal(esito2.outcome, 'done');
  assert.deepEqual(esito2.counts, esito.counts);
  const conSimbolo2 = provaValida(mod, orol.t + 1e9);
  conSimbolo2[Symbol('extra')] = 1;
  const esito3 = mod.cleanupInstance(conSimbolo2, []);
  assert.equal(esito3.replayed, true);
  assert.equal(esito3.outcome, 'done');
  assert.deepEqual(esito3.counts, esito.counts);
  assert.equal(registro.unlink.length, rimosse, 'the replay must not unlink');
});

test('cleanup: an omitted or undefined deps keeps the default empty object', (t) => {
  // A never-used module with an empty registry concludes done with the
  // default {} deps: no seam is required and nothing is touched.
  const mod = copiaFrescaModulo();
  const esito = mod.cleanupInstance(provaValida(mod, Number.MAX_SAFE_INTEGER, { nonce: null }));
  assert.equal(esito.outcome, 'done', JSON.stringify(esito));
  assert.equal(esito.reason, null);
  assert.equal(esito.replayed, false);
  assert.deepEqual(esito.counts, {
    candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
  });
  // The module is disarmed for good: the default deps round is terminal.
  const d = mondo(t);
  assert.equal(mod.qualifica(d.deps).ok, false);
});

test('cleanup: a clock that throws or is non-finite refuses before admission', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  assert.equal(mod.qualifica(d.deps).ok, true);
  const lancia = { now: () => { throw new Error('clock broken'); } };
  const nonFinito = { now: () => Number.NaN };
  for (const orol of [lancia, nonFinito]) {
    const e = mod.cleanupInstance(provaValida(mod, 5000), { monotonicNow: orol.now });
    assert.equal(e.outcome, 'refused');
    assert.equal(e.reason, 'proof-invalid');
    assert.equal(e.replayed, false);
  }
  // No disarm, no terminal stored.
  assert.equal(mod.qualifica(d.deps).ok, true);
});

test('cleanup: a backwards clock after admission stops conservatively', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const orol = orologio(1000);
  orol.salto = 900; // the second read (first gate) goes back in time
  const { deps, registro } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, 100000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'proof-invalid');
  assert.equal(esito.replayed, false);
  assert.equal(esito.counts.removed, 0);
  assert.equal(esito.counts.residues, 2);
  assert.equal(fs.existsSync(q1.path), true, 'no removal may run on a broken clock');
  assert.equal(registro.unlink.length, 0);
  assert.equal(registro.rmdir.length, 0);
});

// ----------------------------------------------------------------- deadlines

test('cleanup: a deadline already expired at entry admits nothing and is never renewed', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const dir = path.dirname(q1.path);
  const orol = orologio(1000);
  const { deps, registro } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t - 1), deps);
  // Effects first: an exhausted entry removes nothing at all.
  assert.equal(fs.existsSync(q1.path), true, 'an exhausted deadline must remove nothing');
  assert.equal(fs.existsSync(dir), true);
  assert.equal(registro.lstat, 0);
  assert.equal(registro.open.length, 0);
  assert.equal(registro.fsync, 0);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'deadline-exhausted');
  assert.equal(esito.replayed, false);
  assert.deepEqual(esito.counts, {
    candidates: 2, removed: 0, alreadyAbsent: 0, skipped: 2, residues: 2, durabilityUnattested: 0,
  });
  // The second call, with an unreasonably late deadline, replays instead of
  // renewing: nothing changes on disk.
  const esito2 = mod.cleanupInstance(provaValida(mod, orol.t + 1e9), deps);
  assert.equal(esito2.replayed, true);
  assert.deepEqual(esito2.counts, esito.counts);
  assert.equal(esito2.reason, 'deadline-exhausted');
  assert.equal(fs.existsSync(q1.path), true);
  assert.equal(fs.existsSync(dir), true);
});

test('cleanup: a live producer or an alive fleet keeps the module armed and its objects in place', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const dir = path.dirname(q1.path);
  const orol = orologio();
  const { deps, registro } = depsCleanup(orol);
  const vive = [
    { producers: 1 },
    { claims: 1 },
    { consumers: 1 },
    { fleetDisarmed: false },
    { processQuiescent: false },
  ];
  for (const extra of vive) {
    const e = mod.cleanupInstance(provaValida(mod, orol.t + 60000, extra), deps);
    // Effects first: a refused global proof moves nothing and disarms
    // nothing, so the module keeps working and the objects stay in place.
    assert.equal(fs.existsSync(q1.path), true, 'a live producer must keep every object in place');
    assert.equal(fs.existsSync(dir), true);
    assert.equal(mod.qualifica(d.deps).ok, true, 'a refused proof must never disarm the module');
    assert.equal(e.outcome, 'refused');
    assert.equal(e.reason, 'not-quiescent');
    assert.equal(e.replayed, false);
    assert.deepEqual(e.counts, {
      candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
    });
  }
  assert.equal(registro.unlink.length, 0);
  assert.equal(registro.rmdir.length, 0);
  // Nothing was stored by the refusals: a later valid proof runs for real.
  const poi = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(poi.outcome, 'done', JSON.stringify(poi));
  assert.equal(poi.replayed, false);
  assert.equal(fs.existsSync(q1.path), false);
});

test('cleanup: the budget expiring mid-round counts executed removals and leaves the rest', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-clean-mid-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  const p1 = mod.pubblica(q1, staging, d.deps);
  assert.equal(p1.ok, true);
  const orol = orologio(1000);
  // The clock jumps past the deadline right after the first unlink: the
  // removal is counted, its fsync never runs, the rest stays as residue.
  const { deps, registro } = depsCleanup(orol, {}, {
    open: () => {},
  });
  const aggancioUnlink = (p) => { if (p === q1.path) orol.salto = 100000; };
  const guastiOriginali = deps.unlinkSync;
  deps.unlinkSync = (p) => { aggancioUnlink(p); return guastiOriginali(p); };
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'deadline-exhausted');
  assert.equal(esito.replayed, false);
  // Snapshot and namespace finals: snapshot removed (1), the instance dir,
  // the namespace and the final stay because the global expiry stops
  // everything, and the unsynced removal is counted once.
  assert.deepEqual(esito.counts, {
    candidates: 4, removed: 1, alreadyAbsent: 0, skipped: 3, residues: 3, durabilityUnattested: 1,
  });
  assert.equal(fs.existsSync(q1.path), false, 'the executed removal stays executed');
  assert.equal(fs.existsSync(path.dirname(q1.path)), true, 'the instance dir must remain');
  assert.equal(fs.existsSync(p1.path), true, 'the independent branch must remain');
  assert.equal(registro.rmdir.length, 0, 'no rmdir may run after the expiry');
  assert.equal(registro.fsync, 0, 'no fsync may run after the expiry');
  // No renewal on the second call.
  const esito2 = mod.cleanupInstance(provaValida(mod, orol.t + 1e9), deps);
  assert.equal(esito2.replayed, true);
  assert.deepEqual(esito2.counts, esito.counts);
});

test('cleanup: an expiry between the rmdir and its fsync never turns green', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const orol = orologio(1000);
  const { deps, registro } = depsCleanup(orol);
  // The clock jumps past the deadline right after the rmdir of the own
  // directory: the removal is executed and counted, its durability is not
  // attested, and the outcome stays incomplete.
  const rmdirOriginale = deps.rmdirSync;
  deps.rmdirSync = (p) => {
    const r = rmdirOriginale(p);
    orol.salto = 100000;
    return r;
  };
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'deadline-exhausted');
  assert.deepEqual(esito.counts, {
    candidates: 2, removed: 2, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 1,
  });
  assert.equal(fs.existsSync(q1.path), false);
  assert.equal(fs.existsSync(path.dirname(q1.path)), false);
  assert.equal(registro.fsync, 1, 'only the directory fsync may have run, never the shared parent one');
});

test('cleanup: an lstat that crosses the deadline never starts its unlink', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true, JSON.stringify(q1));
  const orol = orologio(1000);
  const { deps, registro } = depsCleanup(orol);
  // The file lstat consumes the whole budget: the identity check passes, but
  // the unlink may not START once the deadline is behind it.
  const lstatOriginale = deps.lstatSync;
  deps.lstatSync = (p) => {
    if (p === q1.path) orol.salto = 100000;
    return lstatOriginale(p);
  };
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(fs.existsSync(q1.path), true, 'the file must be preserved when its lstat crosses the deadline');
  assert.equal(registro.unlink.length, 0);
  assert.equal(registro.rmdir.length, 0);
  assert.equal(registro.fsync, 0);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'deadline-exhausted');
  assert.deepEqual(esito.counts, {
    candidates: 2, removed: 0, alreadyAbsent: 0, skipped: 2, residues: 2, durabilityUnattested: 0,
  });
});

test('cleanup: a clock failing once after an unlink stops every later mutation for good', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true, JSON.stringify(q1));
  const dir = path.dirname(q1.path);
  // One non-finite reading right after the first (and only) unlink; every
  // later reading is forward, finite and inside the budget again.
  const scatta = { si: false };
  let giaConsumato = false;
  const orol = {
    now: () => {
      if (scatta.si && !giaConsumato) { giaConsumato = true; return Number.NaN; }
      return 1000;
    },
  };
  const { deps, registro } = depsCleanup(orol);
  const unlinkOriginale = deps.unlinkSync;
  deps.unlinkSync = (p) => {
    const r = unlinkOriginale(p);
    if (p === q1.path) scatta.si = true;
    return r;
  };
  const esito = mod.cleanupInstance(provaValida(mod, 100000), deps);
  assert.equal(fs.existsSync(q1.path), false, 'the executed removal stays executed');
  assert.equal(fs.existsSync(dir), true, 'no rmdir may follow the clock failure');
  assert.equal(registro.fsync, 0, 'no fsync may follow the clock failure');
  assert.equal(registro.rmdir.length, 0);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'proof-invalid');
  assert.deepEqual(esito.counts, {
    candidates: 2, removed: 1, alreadyAbsent: 0, skipped: 1, residues: 1, durabilityUnattested: 1,
  });
});

test('cleanup: an empty module whose clock expires before the answer is never done', (t) => {
  const mod = copiaFrescaModulo();
  const orol = orologio(1000);
  orol.salto = 2000; // the second reading (the final one) lands past the deadline
  const { deps, registro } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, 1001, { nonce: null }), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'deadline-exhausted');
  assert.equal(esito.replayed, false);
  assert.deepEqual(esito.counts, {
    candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
  });
  assert.equal(registro.lstat, 0, 'no filesystem activity at all');
  const esito2 = mod.cleanupInstance(provaValida(mod, 1e9, { nonce: null }), deps);
  assert.equal(esito2.replayed, true);
  assert.equal(esito2.outcome, 'incomplete');
  assert.equal(esito2.reason, 'deadline-exhausted');
});

test('cleanup: the last fsync returning after the deadline never turns the round green', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true, JSON.stringify(q1));
  const parentPerUid = path.join(d.deps.tmpdir, `nc-vl-node-${process.getuid()}`);
  const inoParent = fs.lstatSync(parentPerUid).ino;
  const orol = orologio(1000);
  const { deps, registro } = depsCleanup(orol);
  // The jump lands DURING the final fsync of the shared parent: the call
  // itself completes successfully, but after the deadline.
  const fsyncOriginale = deps.fsyncSync;
  deps.fsyncSync = (fd) => {
    const r = fsyncOriginale(fd);
    if (fs.fstatSync(fd).ino === inoParent) orol.salto = 100000;
    return r;
  };
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'deadline-exhausted');
  assert.deepEqual(esito.counts, {
    candidates: 2, removed: 2, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
  });
  assert.equal(fs.existsSync(q1.path), false);
  assert.equal(fs.existsSync(path.dirname(q1.path)), false);
  assert.ok(registro.fsync >= 2, 'both parent syncs really ran');
});

// ------------------------------------------------------------ syscall errors

test('cleanup: the first unlink error stops that directory and an independent branch continues', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const q2 = mod.qualifica({ ...d.deps, execPath: eseguiSecondario(d, '#!/bin/sh\nexit 3\n') });
  assert.equal(q2.ok, true, JSON.stringify(q2));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-clean-err-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  const p1 = mod.pubblica(q1, staging, d.deps);
  assert.equal(p1.ok, true);
  const dir = path.dirname(q1.path);

  const orol = orologio();
  const { deps } = depsCleanup(orol, {
    unlink: (p) => (p === q1.path ? 'EIO' : null),
  });
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'io-error');
  // The failed snapshot and its sibling stay; the namespace branch (an
  // independent chain) completes instead.
  assert.deepEqual(esito.counts, {
    candidates: 5, removed: 2, alreadyAbsent: 0, skipped: 3, residues: 3, durabilityUnattested: 0,
  });
  assert.equal(fs.existsSync(q1.path), true, 'the failed name must stay');
  assert.equal(fs.existsSync(q2.path), true, 'the sibling of the same directory must stay');
  assert.equal(fs.existsSync(dir), true, 'the directory of the failure must stay');
  assert.equal(fs.existsSync(p1.path), false, 'the independent branch must complete');
  assert.equal(fs.existsSync(path.dirname(p1.path)), false);
});

test('cleanup: a failed directory fsync leaves removals counted but unattested and the rmdir blocked', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const dir = path.dirname(q1.path);
  const devDir = fs.lstatSync(dir).dev;
  const orol = orologio();
  const { deps, registro } = depsCleanup(orol, {
    fsync: (fd) => (fs.fstatSync(fd).isDirectory() && fs.fstatSync(fd).dev === devDir ? 'EIO' : null),
  });
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'io-error');
  assert.deepEqual(esito.counts, {
    candidates: 2, removed: 1, alreadyAbsent: 0, skipped: 1, residues: 1, durabilityUnattested: 1,
  });
  assert.equal(fs.existsSync(q1.path), false, 'the executed removal stays counted');
  assert.equal(fs.existsSync(dir), true, 'the directory of the failed sync must stay');
  assert.equal(registro.rmdir.length, 0, 'no rmdir may follow a failed fsync');
});

test('cleanup: a stranger entry leaves the directory in place with ENOTEMPTY, never deleted', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const dir = path.dirname(q1.path);
  const estraneo = path.join(dir, 'stranger.txt');
  fs.writeFileSync(estraneo, 'keep me', { mode: 0o400 });
  const orol = orologio();
  const { deps } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'residues', 'an ENOTEMPTY is a residue, not an I/O error');
  assert.deepEqual(esito.counts, {
    candidates: 2, removed: 1, alreadyAbsent: 0, skipped: 1, residues: 1, durabilityUnattested: 0,
  });
  assert.equal(fs.existsSync(q1.path), false);
  assert.equal(fs.existsSync(dir), true, 'the non-empty own directory must stay');
  assert.equal(fs.readFileSync(estraneo, 'utf8'), 'keep me', 'the stranger must be untouched');
});

test('cleanup: a real rmdir failure is an I/O error with the directory left in place', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const dir = path.dirname(q1.path);
  const orol = orologio();
  const { deps } = depsCleanup(orol, {
    rmdir: (p) => (p === dir ? 'EIO' : null),
  });
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'io-error');
  assert.deepEqual(esito.counts, {
    candidates: 2, removed: 1, alreadyAbsent: 0, skipped: 1, residues: 1, durabilityUnattested: 0,
  });
  assert.equal(fs.existsSync(q1.path), false);
  assert.equal(fs.existsSync(dir), true);
});

test('cleanup: a failed close after a successful fsync blocks the directory removal', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const dir = path.dirname(q1.path);
  const orol = orologio();
  const { deps, registro } = depsCleanup(orol);
  deps.closeSync = (fd) => {
    if (fd === registro.fdPerPath.get(dir)) {
      registro.close += 1;
      const e = new Error('EIO'); e.code = 'EIO'; throw e;
    }
    return fs.closeSync(fd);
  };
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'io-error');
  // The snapshot was really removed and synced; the directory is still
  // present and censused, and no rmdir may run on it after the failed close.
  assert.deepEqual(esito.counts, {
    candidates: 2, removed: 1, alreadyAbsent: 0, skipped: 1, residues: 1, durabilityUnattested: 0,
  });
  assert.equal(fs.existsSync(q1.path), false);
  assert.equal(fs.existsSync(dir), true, 'the directory must stay: no rmdir may follow the failed close');
  assert.equal(registro.rmdir.length, 0, 'no rmdir may run on the directory of the failed close');
  const dirEntry = mod.getCreationRegistry().instanceDirs.find((e) => e.path === dir);
  assert.ok(dirEntry, 'the directory must stay censused');
  assert.equal(dirEntry.unlinked, false, 'the directory must stay censused as not removed');
  assert.ok(registro.fsync >= 1, 'the fsync had succeeded before the failed close');
});

// ------------------------------------------------- substitutions and chains

test('cleanup: a substituted file stops the whole directory without touching the substitute', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const q2 = mod.qualifica({ ...d.deps, execPath: eseguiSecondario(d, '#!/bin/sh\nexit 4\n') });
  assert.equal(q2.ok, true, JSON.stringify(q2));
  const dir = path.dirname(q1.path);
  // Substitute the first-planned file with a byte-identical stranger and
  // keep the original alive under a test name.
  const tenuta = `${q1.path}.tenuta`;
  fs.renameSync(q1.path, tenuta);
  fs.writeFileSync(q1.path, fs.readFileSync(tenuta), { mode: 0o500 });
  fs.chmodSync(q1.path, 0o500);
  const orol = orologio();
  const { deps, registro } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  // Effects first: the substitute and every sibling of its directory must
  // survive untouched.
  assert.equal(fs.existsSync(q1.path), true, 'the substitute must be preserved');
  assert.equal(fs.existsSync(q2.path), true, 'the sibling of the same directory must stay');
  assert.equal(fs.existsSync(dir), true);
  assert.notEqual(fs.lstatSync(q1.path).ino, fs.lstatSync(tenuta).ino, 'precondition: a real substitute');
  assert.equal(registro.unlink.length, 0, 'no unlink may run on a substituted name');
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'residues');
  assert.deepEqual(esito.counts, {
    candidates: 3, removed: 0, alreadyAbsent: 0, skipped: 3, residues: 3, durabilityUnattested: 0,
  });
});

test('cleanup: a symlink in place of the file is refused and its target untouched', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const dir = path.dirname(q1.path);
  const vittima = path.join(d.root, 'vittima.txt');
  fs.writeFileSync(vittima, 'target content', { mode: 0o400 });
  fs.renameSync(q1.path, `${q1.path}.tenuta`);
  fs.symlinkSync(vittima, q1.path);
  const orol = orologio();
  const { deps } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'residues');
  assert.equal(esito.counts.removed, 0);
  assert.equal(fs.lstatSync(q1.path).isSymbolicLink(), true, 'the symlink must stay');
  assert.equal(fs.readFileSync(vittima, 'utf8'), 'target content', 'the target must be untouched');
  assert.equal(fs.existsSync(dir), true);
});

test('cleanup: a replaced own parent stops the subtree and keeps the objects reachable', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const dir = path.dirname(q1.path);
  const tenuta = `${dir}.tenuta`;
  fs.renameSync(dir, tenuta);
  fs.mkdirSync(dir, { mode: 0o700 });
  const orol = orologio();
  const { deps, registro } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  // Effects first: the snapshot stays reachable under the kept directory and
  // the substitute directory is never touched.
  assert.equal(fs.existsSync(path.join(tenuta, path.basename(q1.path))), true, 'the snapshot must survive under the kept directory');
  assert.equal(fs.existsSync(dir), true, 'the substitute directory must stay untouched');
  assert.equal(registro.unlink.length, 0);
  assert.equal(registro.rmdir.length, 0);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'residues');
  assert.deepEqual(esito.counts, {
    candidates: 2, removed: 0, alreadyAbsent: 0, skipped: 2, residues: 2, durabilityUnattested: 0,
  });
});

test('cleanup: a replaced shared parent stops the branch and never syncs or removes through it', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-clean-shr-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  const p1 = mod.pubblica(q1, staging, d.deps);
  assert.equal(p1.ok, true);
  const ns = path.dirname(p1.path);
  const nonce = mod.getCreationRegistry().nonce;

  // Replace the shared staging with a coherent 0700 substitute that carries
  // a planted stranger namespace at the own namespace's exact name.
  const tenuta = `${staging}.tenuta`;
  fs.renameSync(staging, tenuta);
  fs.mkdirSync(staging, { mode: 0o700 });
  fs.mkdirSync(path.join(staging, `inst-${nonce}`), { mode: 0o700 });

  const orol = orologio();
  const { deps, registro } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'residues');
  // The instance-dir branch (independent chain) completes; the namespace
  // branch is stopped by the shared parent substitution.
  assert.deepEqual(esito.counts, {
    candidates: 4, removed: 2, alreadyAbsent: 0, skipped: 2, residues: 2, durabilityUnattested: 0,
  });
  assert.equal(fs.existsSync(path.join(tenuta, path.basename(ns), path.basename(p1.path))), true,
    'the real final must survive under the kept staging');
  assert.equal(fs.lstatSync(path.join(staging, `inst-${nonce}`)).isDirectory(), true,
    'the stranger namespace inside the substitute staging must never be removed');
  assert.equal(fs.existsSync(q1.path), false, 'the independent instance-dir branch completes');
  assert.equal(registro.rmdir.includes(ns), false, 'the own namespace must not be removed through the substitute');
  assert.equal(registro.fsync, 2, 'only the instance-dir branch syncs may run, never on the substitute');
});

test('cleanup: a substitution between the lstat and the open of the shared parent causes no effect', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-clean-gap-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  const p1 = mod.pubblica(q1, staging, d.deps);
  assert.equal(p1.ok, true);
  const ns = path.dirname(p1.path);
  const identNsPrima = ident(ns);
  const orol = orologio();
  const { deps, registro } = depsCleanup(orol, {}, {
    // The swap runs exactly between the name-level qualification and the
    // open/fstat of the shared parent.
    open: (p) => {
      if (p === staging && !fs.existsSync(`${staging}.tenuta`)) {
        fs.renameSync(staging, `${staging}.tenuta`);
        fs.mkdirSync(staging, { mode: 0o700 });
      }
    },
  });
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  // The final inside the namespace is legitimately removed through its intact
  // chain; the namespace itself survives because the rmdir of its parent
  // chain is refused at the substituted shared parent.
  assert.deepEqual(esito.counts, {
    candidates: 4, removed: 3, alreadyAbsent: 0, skipped: 1, residues: 1, durabilityUnattested: 0,
  });
  assert.equal(fs.existsSync(path.join(`${staging}.tenuta`, path.basename(ns))), true,
    'the namespace must survive inside the kept staging');
  assert.equal(fs.lstatSync(path.join(`${staging}.tenuta`, path.basename(ns))).ino, identNsPrima.ino,
    'the namespace must be the original directory, only moved');
  assert.equal(registro.rmdir.includes(ns), false, 'no rmdir through the substituted parent');
  assert.equal(registro.fsync, 3, 'no fsync on the substitute: only the legitimate chain syncs run');
});

test('cleanup: a target substituted while its parent descriptor opens is never removed', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true, JSON.stringify(q1));
  const dir = path.dirname(q1.path);
  const parentPerUid = path.join(d.deps.tmpdir, `nc-vl-node-${process.getuid()}`);
  const tenuta = `${dir}.tenuta`;
  // The swap runs exactly while the shared parent descriptor is opened for the
  // rmdir: the own directory A is renamed to a held name and an empty same-uid
  // 0700 stranger B takes its place. The parent stays intact, so its open and
  // fstat keep passing: only the target re-verification can refuse the rmdir.
  let identSostituto = null;
  const orol = orologio();
  const { deps, registro } = depsCleanup(orol, {}, {
    open: (p) => {
      if (p === parentPerUid && !fs.existsSync(tenuta)) {
        fs.renameSync(dir, tenuta);
        fs.mkdirSync(dir, { mode: 0o700 });
        identSostituto = ident(dir);
      }
    },
  });
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  // Effects first: the substitute keeps its identity, the renamed original
  // stays alive and censused, and no rmdir ever ran on either.
  assert.ok(identSostituto, 'precondition: the substitute was created during the parent open');
  assert.equal(fs.existsSync(dir), true, 'the substitute directory must be preserved');
  assert.deepEqual(ident(dir), identSostituto, 'the substitute directory must be preserved with its identity');
  assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700, 'the substitute must stay untouched');
  assert.equal(fs.existsSync(tenuta), true, 'the renamed original directory must stay alive');
  assert.equal(fs.existsSync(q1.path), false, 'the snapshot was removed from the original before the swap');
  assert.ok(registro.unlink.includes(q1.path), 'the earlier snapshot removal really ran');
  const dirEntry = mod.getCreationRegistry().instanceDirs.find((e) => e.path === dir);
  assert.ok(dirEntry, 'the directory must stay censused');
  assert.equal(dirEntry.unlinked, false, 'the renamed original must stay censused as not removed');
  assert.equal(registro.rmdir.length, 0, 'no rmdir may run on the substitute');
  assert.notEqual(esito.outcome, 'done');
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'residues');
  assert.deepEqual(esito.counts, {
    candidates: 2, removed: 1, alreadyAbsent: 0, skipped: 1, residues: 1, durabilityUnattested: 0,
  });
});

test('cleanup: a shared ancestor swapped while the own namespace opens stops the branch before any unlink', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true, JSON.stringify(q1));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-clean-anc-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  const p1 = mod.pubblica(q1, staging, d.deps);
  assert.equal(p1.ok, true, JSON.stringify(p1));
  const ns = path.dirname(p1.path);
  const identNsPrima = ident(ns);
  const tenuta = `${staging}.tenuta`;
  // While the own namespace descriptor is being opened, the shared staging is
  // renamed away, a new same-uid 0700 staging takes its name and the ORIGINAL
  // namespace is moved back inside it: the namespace keeps its inode, so its
  // own name qualification still passes, but the registered ancestor link is
  // gone and no mutation may pass through the new staging.
  const orol = orologio();
  const { deps, registro } = depsCleanup(orol, {}, {
    open: (p) => {
      if (p === ns && !fs.existsSync(tenuta)) {
        fs.renameSync(staging, tenuta);
        fs.mkdirSync(staging, { mode: 0o700 });
        fs.renameSync(path.join(tenuta, path.basename(ns)), ns);
      }
    },
  });
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  // Effects first: the final is never unlinked through the new staging, the
  // namespace survives with its original identity, and the independent
  // instance-dir branch keeps completing.
  assert.equal(fs.existsSync(p1.path), true, 'the final must not be removed through the new staging');
  assert.equal(registro.unlink.includes(p1.path), false, 'no unlink of the final through the unqualified chain');
  assert.equal(fs.existsSync(ns), true, 'the namespace must survive');
  assert.deepEqual(ident(ns), identNsPrima, 'the namespace must keep its original identity');
  assert.equal(fs.existsSync(q1.path), false, 'the independent instance-dir branch completes');
  assert.equal(fs.existsSync(path.dirname(q1.path)), false, 'the independent instance-dir branch completes');
  assert.equal(registro.fsync, 2, 'no fsync through the unqualified chain: only the instance-dir branch syncs');
  const registroDopo = mod.getCreationRegistry();
  const voceNs = registroDopo.entries.find((e) => e.path === ns);
  assert.ok(voceNs, 'the namespace must stay censused');
  assert.equal(voceNs.unlinked, false, 'the namespace must stay censused as not removed');
  const voceFinale = registroDopo.entries.find((e) => e.path === p1.path);
  assert.ok(voceFinale, 'the final must stay censused');
  assert.equal(voceFinale.unlinked, false, 'the final must stay censused as not removed');
  assert.notEqual(esito.outcome, 'done');
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'residues');
  assert.deepEqual(esito.counts, {
    candidates: 4, removed: 2, alreadyAbsent: 0, skipped: 2, residues: 2, durabilityUnattested: 0,
  });
});

test('cleanup: an unknown identity as the only current entry is never done', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const origFstat = fs.fstatSync;
  const r = mod.qualifica({
    ...d.deps,
    fstat: (fd) => {
      const st = origFstat(fd);
      if (st.size === 0) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
      return st;
    },
  });
  assert.equal(r.ok, false);
  const snap = mod.getCreationRegistry();
  const ignoto = snap.tempFiles.find((e) => e.state === 'created-identity-unknown');
  assert.ok(ignoto, 'the unknown residual must be censused');
  const dir = path.dirname(ignoto.path);
  const orol = orologio();
  const { deps, registro } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.notEqual(esito.outcome, 'done');
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'residues');
  assert.equal(esito.counts.removed, 0);
  assert.equal(esito.counts.residues, 2);
  assert.equal(fs.existsSync(ignoto.path), true, 'the unknown residual must stay');
  assert.equal(fs.existsSync(dir), true, 'the non-empty own directory must stay');
  assert.equal(registro.unlink.length, 0);
});

test('cleanup: an unqualified own directory is always a residue and is never repaired', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const uid = process.getuid();
  const parent = path.join(d.deps.tmpdir, `nc-vl-node-${uid}`);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const prev = process.umask(0o177);
  let r;
  try {
    r = mod.qualifica(d.deps);
  } finally {
    process.umask(prev);
  }
  assert.equal(r.ok, false);
  const dirEntry = mod.getCreationRegistry().instanceDirs[0];
  assert.ok(dirEntry);
  assert.equal(dirEntry.state, 'created-unqualified');
  const orol = orologio();
  const { deps } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'residues');
  assert.equal(esito.counts.candidates, 0);
  assert.equal(esito.counts.residues, 1);
  // skipped covers the whole domain: the unqualified directory is a domain
  // name not brought to removal, even if it was never a candidate.
  assert.equal(esito.counts.skipped, 1);
  assert.equal(fs.existsSync(dirEntry.path), true, 'the unqualified directory must stay');
  assert.equal(fs.lstatSync(dirEntry.path).mode & 0o777, 0o600, 'the residue must never be chmod-ed');
});

test('cleanup: a read failure of the qualification lstat is an io-error, not a mismatch residue', (t) => {
  // Case 1: EIO of the file lstat after the admission.
  {
    const mod = copiaFrescaModulo();
    const d = mondo(t);
    const q1 = mod.qualifica(d.deps);
    assert.equal(q1.ok, true);
    const orol = orologio();
    const { deps } = depsCleanup(orol, {
      lstat: (p) => (p === q1.path ? 'EIO' : null),
    });
    const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
    assert.equal(fs.existsSync(q1.path), true, 'the unreadable file must stay');
    assert.equal(esito.outcome, 'incomplete');
    assert.equal(esito.reason, 'io-error', 'a read error is not a mismatch residue');
    assert.deepEqual(esito.counts, {
      candidates: 2, removed: 0, alreadyAbsent: 0, skipped: 2, residues: 2, durabilityUnattested: 0,
    });
  }
  // Case 2: EIO of the own-directory lstat through the boolean helper.
  {
    const mod = copiaFrescaModulo();
    const d = mondo(t);
    const q1 = mod.qualifica(d.deps);
    assert.equal(q1.ok, true);
    const dir = path.dirname(q1.path);
    const orol = orologio();
    const { deps } = depsCleanup(orol, {
      lstat: (p) => (p === dir ? 'EIO' : null),
    });
    const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
    assert.equal(fs.existsSync(dir), true, 'the unreadable directory must stay');
    assert.equal(esito.outcome, 'incomplete');
    assert.equal(esito.reason, 'io-error', 'a read error is not a mismatch residue');
    assert.deepEqual(esito.counts, {
      candidates: 2, removed: 0, alreadyAbsent: 0, skipped: 2, residues: 2, durabilityUnattested: 0,
    });
  }
});

test('cleanup: a foreign EEXIST object is neither counted nor touched', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true);
  const nonce = mod.getCreationRegistry().nonce;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-clean-eex-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  fs.mkdirSync(staging, { mode: 0o700 });
  const estraneo = path.join(staging, `inst-${nonce}`);
  fs.mkdirSync(estraneo, { mode: 0o700 });
  fs.writeFileSync(path.join(estraneo, 'sentinel.txt'), 'foreign');
  const p = mod.pubblica(q1, staging, d.deps);
  assert.equal(p.ok, false);
  assert.equal(p.code, 'PIN_DIR');
  const orol = orologio();
  const { deps, registro } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  // The foreign namespace is not owned: it is not in the domain and the rest
  // of the incarnation cleans completely.
  assert.equal(esito.outcome, 'done', JSON.stringify(esito));
  assert.equal(fs.lstatSync(estraneo).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(estraneo, 'sentinel.txt'), 'utf8'), 'foreign');
  assert.equal(registro.rmdir.includes(estraneo), false);
});

test('cleanup: a historical generation never authorizes the current name', (t) => {
  const origFstat = fs.fstatSync;
  const origUnlink = fs.unlinkSync;
  const origRandom = crypto.randomBytes;
  const mod = copiaFrescaModulo();
  const d = mondo(t);

  // Generation 1: a qualified temporary of a refused publication whose unlink
  // is interrupted after moving the object aside; the module keeps it
  // censused, unremoved, and no snapshot is published.
  const origLink = fs.linkSync;
  let tenuta1 = null;
  const deps1 = {
    ...d.deps,
    unlink: (p) => {
      if (typeof p === 'string' && p.includes('.tmp-')) {
        tenuta1 = `${p}.tenuta1`;
        fs.renameSync(p, tenuta1);
        const e = new Error('EIO'); e.code = 'EIO'; throw e;
      }
      return origUnlink(p);
    },
  };
  // An EIO link failure is not a link denial: the publication fails before
  // creating anything and the module's own temporary removal runs.
  fs.linkSync = () => { const e = new Error('EIO: link denied'); e.code = 'EIO'; throw e; };
  let r1;
  try {
    r1 = mod.qualifica(deps1);
  } finally {
    fs.linkSync = origLink;
  }
  assert.equal(r1.ok, false, JSON.stringify(r1));
  const gen1 = mod.getCreationRegistry().tempFiles.find((e) => e.unlinked === false);
  assert.ok(gen1, 'generation 1 must stay censused');
  assert.equal(gen1.generation, 1);
  const nomeTmp = gen1.path;
  const suffisso = nomeTmp.split('.tmp-')[1];
  assert.ok(/^[0-9a-f]{12}$/.test(suffisso));

  // Generation 2 on the same name: the same bytes in a secondary copy give
  // the same destination hash, so the forced suffix reuses the full
  // temporary name; the identity read fails and the object stays under the
  // name. The original generation 1 object is then placed back under it.
  crypto.randomBytes = (n) => (n === 6 ? Buffer.from(suffisso, 'hex') : origRandom(n));
  let r2;
  try {
    r2 = mod.qualifica({
      ...d.deps,
      execPath: eseguiSecondario(d, '#!/bin/sh\nexit 0\n'),
      fstat: (fd) => {
        const st = origFstat(fd);
        if (st.size === 0) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
        return st;
      },
    });
  } finally {
    crypto.randomBytes = origRandom;
  }
  assert.equal(r2.ok, false);
  fs.renameSync(nomeTmp, `${nomeTmp}.tenuta2`);
  fs.renameSync(tenuta1, nomeTmp);
  const stNome = fs.lstatSync(nomeTmp);
  assert.equal(stNome.dev, gen1.dev, 'precondition: the generation 1 object is back under the name');
  assert.equal(stNome.ino, gen1.ino, 'precondition: the generation 1 object is back under the name');

  // The current entry (highest seq) is the unknown generation 2: no removal
  // may be authorized through the historical generation 1 identity.
  const orol = orologio();
  const { deps, registro } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'residues');
  assert.deepEqual(esito.counts, {
    candidates: 1, removed: 0, alreadyAbsent: 0, skipped: 2, residues: 2, durabilityUnattested: 0,
  });
  assert.equal(fs.lstatSync(nomeTmp).ino, gen1.ino, 'the object under the name must never be removed');
  assert.equal(registro.unlink.includes(nomeTmp), false);
});

test('cleanup: a substitute in the saturation residue is refused by the reverification', (t) => {
  const origFstat = fs.fstatSync;
  const origOpen = fs.openSync;
  const origClose = fs.closeSync;
  const origRename = fs.renameSync;
  const origWriteFile = fs.writeFileSync;
  const mod = copiaFrescaModulo();
  const d = mondo(t);

  // Fill the live census to the cap with present-but-unknown temporaries.
  const q0 = mod.qualifica(d.deps);
  assert.equal(q0.ok, true, JSON.stringify(q0));
  fs.rmSync(q0.path);
  const depsUnknown = {
    ...d.deps,
    execPath: eseguiSecondario(d, '#!/bin/sh\nexit 21\n'),
    fstat: (fd) => {
      const st = origFstat(fd);
      if (st.size === 0) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
      return st;
    },
  };
  for (let i = 0; i < 253; i += 1) {
    assert.equal(mod.qualifica(depsUnknown).ok, false);
  }
  // The 256th, non-compactable entry: a fully qualified temporary whose name
  // is substituted with a sentinel while its descriptor closes, and whose
  // destination reservation then refuses for saturation.
  let tmpFd = null;
  let tmpPath = null;
  const depsSat = {
    ...d.deps,
    execPath: eseguiSecondario(d, '#!/bin/sh\nexit 22\n'),
    open: (p, flags, mode) => {
      const fd = origOpen(p, flags, mode);
      if (typeof p === 'string' && p.includes('.tmp-') && typeof flags === 'string' && flags.includes('wx')) {
        tmpFd = fd;
        tmpPath = p;
      }
      return fd;
    },
    close: (fd) => {
      if (fd === tmpFd && tmpPath !== null) {
        const target = tmpPath;
        tmpPath = null;
        origRename(target, `${target}.originale`);
        origWriteFile(target, 'sentinel', { mode: 0o500 });
      }
      return origClose(fd);
    },
  };
  const r = mod.qualifica(depsSat);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'registry-saturated');
  assert.ok(tmpPath === null);
  const snapPrima = mod.getCreationRegistry();
  const saturato = snapPrima.tempFiles.find((e) => e.unlinked === false && e.fileSynced === true);
  assert.ok(saturato, 'the saturated temporary must be censused');
  const nomeSat = saturato.path;

  const orol = orologio();
  const { deps, registro } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'residues');
  // The clean snapshot was removed by the test itself: its positive absence
  // through a qualified chain is counted as alreadyAbsent, never as a
  // removal. The saturated substitute and everything else stay residues.
  assert.deepEqual(esito.counts, {
    candidates: 3, removed: 0, alreadyAbsent: 1, skipped: 255, residues: 255, durabilityUnattested: 0,
  });
  assert.equal(fs.readFileSync(nomeSat, 'utf8'), 'sentinel', 'the substitute must be preserved');
  assert.ok(fs.existsSync(`${nomeSat}.originale`), 'the original must stay alive, never hunted');
  assert.equal(registro.unlink.length, 0, 'no unlink may run through the whole saturated round');
  assert.equal(registro.rmdir.length, 0);
});

// ------------------------------------------------------------------- schema

test('cleanup: the outcome is a closed frozen record without identifiers', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondo(t);
  const mondo1 = mondoRicco(t, mod, d);
  const orol = orologio();
  const { deps } = depsCleanup(orol);
  const esito = mod.cleanupInstance(provaValida(mod, orol.t + 60000), deps);
  const modR = copiaFrescaModulo();
  const dR = mondo(t);
  const qR = modR.qualifica(dR.deps);
  assert.equal(qR.ok, true);
  const orolR = orologio();
  const rifiutato = modR.cleanupInstance(provaValida(modR, orolR.t + 60000, { producers: 1 }));
  const esempi = [esito, rifiutato];
  for (const e of esempi) {
    assert.ok(Object.isFrozen(e));
    assert.ok(Object.isFrozen(e.counts));
    assert.deepEqual(Object.keys(e), ['schema', 'outcome', 'reason', 'counts', 'replayed']);
    assert.deepEqual(Object.keys(e.counts).sort(), [
      'alreadyAbsent', 'candidates', 'durabilityUnattested', 'removed', 'residues', 'skipped',
    ]);
    assert.ok(['done', 'incomplete', 'refused'].includes(e.outcome));
    assert.ok(e.reason === null
      || ['proof-invalid', 'nonce-mismatch', 'not-quiescent', 'deadline-exhausted', 'io-error', 'residues'].includes(e.reason));
    assert.equal(typeof e.replayed, 'boolean');
    for (const v of Object.values(e.counts)) {
      assert.ok(Number.isSafeInteger(v) && v >= 0 && v <= 256, `count out of range: ${v}`);
    }
    const serializzato = JSON.stringify(e);
    for (const frammento of [d.root, mondo1.dir, mod.getCreationRegistry().nonce, String(process.getuid()), os.tmpdir(), os.hostname()]) {
      assert.equal(serializzato.includes(String(frammento)), false,
        `the outcome must never contain identifiers: ${frammento}`);
    }
  }
});

// ----------------------------------------------- two live child incarnations

class Figlio {
  constructor() {
    this.proc = spawn(process.execPath, [PERCORSO_FIGLIO], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.prossimo = 1;
    this.attese = new Map();
    this.uscito = false;
    this.proc.on('exit', () => { this.uscito = true; });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (_) { return; }
      const risolvi = this.attese.get(msg.id);
      if (risolvi) { this.attese.delete(msg.id); risolvi(msg); }
    });
  }
  invia(op, extra = {}) {
    return new Promise((resolve, reject) => {
      if (this.uscito) { reject(new Error(`child already exited: ${op}`)); return; }
      const id = `m${this.prossimo++}`;
      const timer = setTimeout(() => {
        this.attese.delete(id);
        reject(new Error(`child barrier timeout: ${op}`));
      }, 30000);
      timer.unref();
      this.attese.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(`${JSON.stringify({ id, op, ...extra })}\n`);
    });
  }
  async chiudi() {
    try { await this.invia('exit'); } catch (_) { /* already gone or timed out */ }
    if (this.uscito) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      timer.unref();
      this.proc.once('exit', resolve);
    });
  }
}

test('cleanup: two live incarnations in distinct processes, A cleanup preserves B', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-clean-e2e-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });
  const stageDir = path.join(root, 'stage');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true, mode: 0o755 });
  const exec = path.join(root, 'bin', 'node');
  fs.writeFileSync(exec, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(exec, 0o755);
  const homes = [0, 1].map((i) => {
    const base = path.join(root, `home${i}`, '.nexuscrew');
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    return path.join(base, 'vl-claim-pin');
  });

  const A = new Figlio();
  const B = new Figlio();
  t.after(async () => { await A.chiudi(); await B.chiudi(); });
  const init = (figlio) => figlio.invia('init', { modulePath: PERCORSO_MODULO, execPath: exec, stageDir });

  await init(A);
  const qa = await A.invia('qualifica');
  assert.equal(qa.ok, true, JSON.stringify(qa));
  const pa1 = await A.invia('pubblica', { staging: homes[0] });
  assert.equal(pa1.ok, true, JSON.stringify(pa1));
  await A.invia('deny-link');
  const pa2 = await A.invia('pubblica', { staging: homes[1] });
  assert.equal(pa2.ok, true, JSON.stringify(pa2));
  await A.invia('allow-link');

  await init(B);
  const qb = await B.invia('qualifica');
  assert.equal(qb.ok, true, JSON.stringify(qb));
  const pb1 = await B.invia('pubblica', { staging: homes[0] });
  assert.equal(pb1.ok, true, JSON.stringify(pb1));
  const pb2 = await B.invia('pubblica', { staging: homes[1] });
  assert.equal(pb2.ok, true, JSON.stringify(pb2));

  // Physical identity and bytes of B, recorded while B stays alive.
  const identB = {
    snap: ident(qb.path), f1: ident(pb1.path), f2: ident(pb2.path),
    ns1: ident(path.dirname(pb1.path)), ns2: ident(path.dirname(pb2.path)),
  };
  const byteB = {
    snap: fs.readFileSync(qb.path),
    f1: fs.readFileSync(pb1.path),
    f2: fs.readFileSync(pb2.path),
  };
  const oggettiPrima = contaOggetti(root);

  const esito = await A.invia('cleanup');
  // Effects first: A's own names are gone, via link and via wx, without
  // touching the shared parents, and B stays byte-identical and alive.
  assert.equal(fs.existsSync(qa.path), false, 'A snapshot removed');
  assert.equal(fs.existsSync(path.dirname(qa.path)), false, 'A instance dir removed');
  assert.equal(fs.existsSync(pa1.path), false, 'A link final removed');
  assert.equal(fs.existsSync(path.dirname(pa1.path)), false, 'A link namespace removed');
  assert.equal(fs.existsSync(pa2.path), false, 'A wx final removed');
  assert.equal(fs.existsSync(path.dirname(pa2.path)), false, 'A wx namespace removed');
  assert.equal(fs.existsSync(path.join(stageDir, `nc-vl-node-${process.getuid()}`)), true,
    'the shared per-uid parent must survive');
  assert.equal(fs.existsSync(homes[0]), true);
  assert.equal(fs.existsSync(homes[1]), true);
  // B's own names exist, explicitly, before any identity comparison: this is
  // the oracle a preservation mutant must fall on.
  assert.equal(fs.existsSync(qb.path), true, 'B snapshot must survive');
  assert.equal(fs.existsSync(pb1.path), true, 'B link final must survive');
  assert.equal(fs.existsSync(pb2.path), true, 'B wx final must survive');
  assert.equal(fs.existsSync(path.dirname(pb1.path)), true, 'B link namespace must survive');
  assert.equal(fs.existsSync(path.dirname(pb2.path)), true, 'B wx namespace must survive');
  assert.deepEqual(ident(qb.path), identB.snap);
  assert.deepEqual(fs.readFileSync(qb.path), byteB.snap);
  assert.deepEqual(ident(pb1.path), identB.f1);
  assert.deepEqual(fs.readFileSync(pb1.path), byteB.f1);
  assert.deepEqual(ident(pb2.path), identB.f2);
  assert.deepEqual(fs.readFileSync(pb2.path), byteB.f2);
  assert.deepEqual(ident(path.dirname(pb1.path)), identB.ns1);
  assert.deepEqual(ident(path.dirname(pb2.path)), identB.ns2);
  const vb = await B.invia('verify');
  assert.equal(vb.ok, true, JSON.stringify(vb));
  assert.equal(vb.path, qb.path);
  assert.equal(contaOggetti(root), oggettiPrima - 6, 'exactly the six names of A must disappear');
  assert.equal(esito.outcome, 'done', JSON.stringify(esito));
  assert.equal(esito.reason, null);
  assert.deepEqual(esito.counts, {
    candidates: 6, removed: 6, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
  });

  // A fresh incarnation on the same shared world adopts none of the old
  // names and B is still fine afterwards.
  const A2 = new Figlio();
  t.after(async () => { await A2.chiudi(); });
  await init(A2);
  const qa2 = await A2.invia('qualifica');
  assert.equal(qa2.ok, true, JSON.stringify(qa2));
  assert.notEqual(path.dirname(qa2.path), path.dirname(qa.path));
  assert.match(path.basename(path.dirname(qa2.path)), /^inst-[0-9a-f]{32}$/);
  const vb2 = await B.invia('verify');
  assert.equal(vb2.ok, true);
  assert.equal(vb2.path, qb.path);
});

test('cleanup: a proof of another incarnation is refused before any terminal and the own proof still runs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-clean-inc-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });
  const stageDir = path.join(root, 'stage');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true, mode: 0o755 });
  const exec = path.join(root, 'bin', 'node');
  fs.writeFileSync(exec, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(exec, 0o755);
  const homes = [0, 1].map((i) => {
    const base = path.join(root, `home${i}`, '.nexuscrew');
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    return path.join(base, 'vl-claim-pin');
  });

  const A = new Figlio();
  const B = new Figlio();
  t.after(async () => { await A.chiudi(); await B.chiudi(); });
  const init = (figlio) => figlio.invia('init', { modulePath: PERCORSO_MODULO, execPath: exec, stageDir });

  const ia = await init(A);
  const qa = await A.invia('qualifica');
  assert.equal(qa.ok, true, JSON.stringify(qa));
  const pa1 = await A.invia('pubblica', { staging: homes[0] });
  assert.equal(pa1.ok, true, JSON.stringify(pa1));

  const ib = await init(B);
  const qb = await B.invia('qualifica');
  assert.equal(qb.ok, true, JSON.stringify(qb));
  const pb1 = await B.invia('pubblica', { staging: homes[1] });
  assert.equal(pb1.ok, true, JSON.stringify(pb1));

  // Two fresh incarnations number their registry entries from the same base:
  // the crossed case is exactly the same first seq with different nonces.
  // The nonce exists only after the first censused entry, so both are read
  // here, after the qualifications.
  const nonceA = await A.invia('nonce');
  const nonceB = await B.invia('nonce');
  assert.ok(nonceA.nonce && nonceB.nonce, 'precondition: both incarnations have a nonce');
  assert.notEqual(nonceA.nonce, nonceB.nonce, 'precondition: distinct incarnation nonces');
  const identB = { snap: ident(qb.path), f1: ident(pb1.path) };
  const byteB = { snap: fs.readFileSync(qb.path), f1: fs.readFileSync(pb1.path) };
  const oggettiPrima = contaOggetti(root);

  // B's proof reaches A BEFORE any terminal of A: the refusal is
  // nonce-mismatch, with zero effects and no disarm.
  const rifiuto = await A.invia('cleanup-foreign', { nonce: nonceB.nonce });
  assert.equal(rifiuto.outcome, 'refused');
  assert.equal(rifiuto.reason, 'nonce-mismatch');
  assert.equal(rifiuto.replayed, false);
  assert.equal(fs.existsSync(qa.path), true, 'A snapshot untouched by the refused proof');
  assert.equal(fs.existsSync(pa1.path), true, 'A final untouched by the refused proof');
  assert.equal(contaOggetti(root), oggettiPrima, 'the refused proof must move nothing');
  const va = await A.invia('verify');
  assert.equal(va.ok, true, 'a refused foreign proof must never disarm the module');

  // A's own valid proof runs afterwards and removes only A's names; B stays
  // byte-identical and requalifiable.
  const esito = await A.invia('cleanup');
  assert.equal(esito.outcome, 'done', JSON.stringify(esito));
  assert.equal(fs.existsSync(qa.path), false);
  assert.equal(fs.existsSync(pa1.path), false);
  assert.deepEqual(ident(qb.path), identB.snap, 'B snapshot preserved');
  assert.deepEqual(fs.readFileSync(qb.path), byteB.snap, 'B snapshot byte-identical');
  assert.deepEqual(ident(pb1.path), identB.f1, 'B final preserved');
  assert.deepEqual(fs.readFileSync(pb1.path), byteB.f1, 'B final byte-identical');
  const vb = await B.invia('verify');
  assert.equal(vb.ok, true, JSON.stringify(vb));
  assert.equal(vb.path, qb.path);
});

test('cleanup: a residue scenario keeps the old directories and a new incarnation adopts nothing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-clean-res-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });
  const stageDir = path.join(root, 'stage');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true, mode: 0o755 });
  const exec = path.join(root, 'bin', 'node');
  fs.writeFileSync(exec, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(exec, 0o755);
  const base = path.join(root, 'home', '.nexuscrew');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const staging = path.join(base, 'vl-claim-pin');

  const R = new Figlio();
  t.after(async () => { await R.chiudi(); });
  await R.invia('init', { modulePath: PERCORSO_MODULO, execPath: exec, stageDir });
  const qr = await R.invia('qualifica');
  assert.equal(qr.ok, true);
  const pr = await R.invia('pubblica', { staging });
  assert.equal(pr.ok, true);
  const dirR = path.dirname(qr.path);
  // A stranger inside R's instance dir makes its rmdir a residue that MUST
  // stay present: the old directory really remains on disk.
  const estraneo = path.join(dirR, 'stranger.txt');
  fs.writeFileSync(estraneo, 'residue keep', { mode: 0o400 });

  const esito = await R.invia('cleanup');
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'residues');
  assert.deepEqual(esito.counts, {
    candidates: 4, removed: 3, alreadyAbsent: 0, skipped: 1, residues: 1, durabilityUnattested: 0,
  });
  assert.equal(fs.existsSync(dirR), true, 'the residue directory must really stay');
  assert.equal(fs.readFileSync(estraneo, 'utf8'), 'residue keep');
  assert.equal(fs.existsSync(path.join(stageDir, `nc-vl-node-${process.getuid()}`)), true);

  // A new incarnation on the same world creates its own directory and never
  // adopts the residue; its own cleanup removes only its own objects.
  const R2 = new Figlio();
  t.after(async () => { await R2.chiudi(); });
  await R2.invia('init', { modulePath: PERCORSO_MODULO, execPath: exec, stageDir });
  const qr2 = await R2.invia('qualifica');
  assert.equal(qr2.ok, true);
  assert.notEqual(path.dirname(qr2.path), dirR);
  assert.equal(fs.existsSync(dirR), true, 'the residue must survive the new incarnation');
  assert.equal(fs.readFileSync(estraneo, 'utf8'), 'residue keep');
  const esito2 = await R2.invia('cleanup');
  assert.equal(esito2.outcome, 'done', JSON.stringify(esito2));
  assert.equal(fs.existsSync(path.dirname(qr2.path)), false);
  assert.equal(fs.existsSync(dirR), true, 'another incarnation residue is never touched');
  assert.equal(fs.readFileSync(estraneo, 'utf8'), 'residue keep');
});
