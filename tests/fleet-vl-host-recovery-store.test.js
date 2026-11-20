'use strict';

// Store boundaries of the recovery module: the reservation authority is shared
// in the process per qualified store, the chain must be attestable also without
// the private boundary component, the phase plan must be the normative one, a
// truncated read is never an event, and admission re-checks the clock after the
// synchronous work it has already done.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { piano } = require('./helpers/phase-plan.js');
const { publishExclusive, pubblicaEsclusiva } = require('../lib/fleet/exclusive-publish.js');
const hostStop = require('../lib/fleet/vl-host-stop.js');

const MODULE_PATH = path.join(__dirname, '../lib/fleet/vl-host-recovery.js');
const PUB_EXCL = pubblicaEsclusiva || publishExclusive;

// Every factory of this file that can reach the signal seam takes an observable
// double: what it answers is the register an assertion reads. A double that only
// swallows the call would hide the effect instead of proving its absence.
function doppioSegnale() {
  const chiamate = [];
  return {
    chiamate,
    killProcess: (pid, sig) => { chiamate.push({ pid, sig }); },
  };
}

// File sentinel: a run that still reaches process.kill is a test defect, not a
// delivery. It counts and throws, and the global hook below asserts that no test
// ever got there and restores the original.
const SENTINELLA_FILE = { colpi: 0 };
const processKillVero = process.kill;
process.kill = function killSentinellaDiFile(pid, signal) {
  SENTINELLA_FILE.colpi += 1;
  const errore = new Error(`the store test reached process.kill pid=${String(pid)} signal=${String(signal)}`);
  errore.code = 'ESENTINEL';
  throw errore;
};
after(() => {
  process.kill = processKillVero;
  assert.equal(SENTINELLA_FILE.colpi, 0, 'no test of this file reaches the production signal seam');
});

const OWNER = 'cd'.repeat(16);
const BOOT_ID = '42345678-1234-4234-8234-123456789abc';
const PID_NS = '4026531836';
const HOST_PID = 7171;
const COORD_PID = 99995;
const UID = typeof process.getuid === 'function' ? process.getuid() : 1000;

function caricaModuloRecovery() {
  let resolved;
  try {
    resolved = require.resolve(MODULE_PATH);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null;
    throw e;
  }
  return require(resolved);
}

function hexId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function makeHostIdentity(overrides = {}) {
  return {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId: OWNER,
    pid: HOST_PID,
    uid: UID,
    bootId: BOOT_ID,
    pidNamespaceInode: PID_NS,
    startTicks: '3690',
    pgid: HOST_PID,
    sid: HOST_PID,
    ...overrides,
  };
}

function computeContextDigest(record) {
  const h = record.hostIdentity;
  const tuple = [
    record.launchId, record.vlBinSha256, record.serverRoot, h.source, h.instanceId,
    h.pid, h.uid, h.bootId, h.pidNamespaceInode, h.startTicks, h.pgid, h.sid,
  ];
  return crypto.createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex');
}

function canonicalEventLine({ version = 1, launchId, attemptId, seq, kind, contextDigest, method, reason }) {
  const ordered = { version, launchId, attemptId, seq, kind, contextDigest };
  if (method !== undefined) ordered.method = method;
  if (reason !== undefined) ordered.reason = reason;
  return `${JSON.stringify(ordered)}\n`;
}

function seedEvent(stateDir, ev) {
  const dir = path.join(stateDir, 'recovery-events');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const name = `${String(ev.seq).padStart(8, '0')}-${ev.kind}.json`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, canonicalEventLine(ev), { mode: 0o600 });
  fs.chmodSync(full, 0o600);
  return full;
}

// An admissible history: every attempt is opened and closed by its own terminal
// event, so nothing is left blocking and the seeded entries are never the reason
// a boundary refuses.
function seedStoria(stateDir, record, count) {
  const contextDigest = computeContextDigest(record);
  let seq = 1;
  let resto = count;
  const gruppi = [];
  if (resto % 2 === 1) { gruppi.push(3); resto -= 3; }
  while (resto > 0) { gruppi.push(2); resto -= 2; }
  for (const size of gruppi) {
    const attemptId = hexId(16);
    const base = { launchId: record.launchId, attemptId, contextDigest };
    seedEvent(stateDir, { ...base, seq: seq++, kind: 'cli-attempt' });
    if (size === 3) seedEvent(stateDir, { ...base, seq: seq++, kind: 'cli-failed', reason: 'spawn' });
    seedEvent(stateDir, { ...base, seq: seq++, kind: 'cli-ack', reason: 'shutdown_ack' });
  }
  assert.equal(seq - 1, count, `seeded ${count} entries`);
}

function creaFixture(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-store-'));
  fs.chmodSync(root, 0o700);
  t.after(() => {
    try { fs.chmodSync(path.join(root, 'home', '.nexuscrew'), 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home');
  const ncDir = path.join(home, '.nexuscrew');
  const ownerDir = path.join(ncDir, 'vl-instances', OWNER);
  const cellId = opts.cellId || 'CellaStore';
  const stateDir = opts.stateDir || path.join(ownerDir, cellId);
  const serverRoot = path.join(ncDir, 'vl-roots', cellId);
  const xdgState = path.join(home, '.local', 'state');

  for (const d of [home, ncDir, path.join(ncDir, 'vl-instances'), ownerDir, stateDir, serverRoot, xdgState]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }

  const vlBin = path.join(root, 'vl');
  fs.writeFileSync(vlBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const pin = hostStop.pinBinario({ source: vlBin, home, owner: OWNER, cellId });

  const record = {
    launchId: hexId(8),
    vlBin,
    vlBinSha256: pin.sha256,
    XDG_STATE_HOME: xdgState,
    XDG_DATA_HOME: xdgState,
    XDG_CONFIG_HOME: xdgState,
    HOME: home,
    uid: UID,
    serverRoot,
    ts: 1000,
    version: 2,
    hostIdentity: makeHostIdentity(),
  };
  hostStop.scriviContesto(stateDir, record);
  return { root, home, ncDir, stateDir, serverRoot, record };
}

function creaFactory(mod, fx, extra = {}) {
  const killCalls = [];
  const factory = mod.createHostRecovery({
    fsRecovery: extra.fsRecovery || fs,
    publishExclusive: PUB_EXCL,
    killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
    osservaKernel: () => ({ state: 'observed', processState: 'S', identity: fx.record.hostIdentity }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: extra.monoNow || (() => 60000),
    attesaImpl: async () => {},
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
  });
  return { factory, killCalls };
}

function ctxPer(fx, extra = {}) {
  return {
    record: fx.record,
    stateDir: extra.stateDir === undefined ? fx.stateDir : extra.stateDir,
    deadlineAt: 68000,
    phasePlan: extra.phasePlan === undefined ? piano(8000, 68000) : extra.phasePlan,
    allowHostRecovery: extra.allowHostRecovery === undefined ? true : extra.allowHostRecovery,
    fenceCheck: extra.fenceCheck || (() => true),
  };
}

test('the admission re-checks the clock after the reads and the fence it has already done', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);

  for (const [caso, secondo] of [['past the deadline', 70000], ['backwards', 50000]]) {
    let letture = 0;
    const mono = () => {
      letture += 1;
      return letture === 1 ? 60000 : secondo;
    };
    const { factory, killCalls } = creaFactory(mod, fx, { monoNow: mono });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(Boolean(opened && opened.ok), false, `the clock moved ${caso} before the admission: refused`);
    assert.equal(typeof (opened && opened.code), 'string', 'the refusal carries a code');
    assert.deepEqual(killCalls, [], 'zero signals');

    // A refused admission leaves no reservation behind.
    const sano = creaFactory(mod, fx);
    const dopo = sano.factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(dopo && dopo.ok, true, 'the reservation is still free after the refusal');
    sano.factory.closeAttempt(dopo.attempt);
  }
});

test('a read that ends before the qualified size is never an event, and short reads that complete are', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const digest = computeContextDigest(fx.record);
  const evento = {
    version: 1,
    launchId: fx.record.launchId,
    attemptId: hexId(16),
    seq: 1,
    kind: 'closed',
    contextDigest: digest,
    method: null,
  };
  const linea = canonicalEventLine(evento);
  const file = path.join(dir, '00000001-closed.json');
  fs.writeFileSync(file, linea, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const dimensione = fs.statSync(file).size;

  // Short reads that still recompose every byte of the qualified object are
  // admitted: a short read is progress, not a defect.
  const corto = {
    ...fs,
    readSync: (fd, buf, off, len, pos) => fs.readSync(fd, buf, off, Math.min(len, 7), pos),
  };
  const fabCorto = creaFactory(mod, fx, { fsRecovery: corto });
  assert.equal(
    fabCorto.factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
    'clear',
    'short reads that complete the object are accepted',
  );

  // The same canonical line plus a tail, truncated to the line after the size
  // was qualified: the bytes read are a complete valid event, but they are not
  // the object that was qualified. An early end of file is a detected change.
  const fileDue = path.join(dir, '00000002-closed.json');
  const seconda = { ...evento, seq: 2, attemptId: hexId(16) };
  const lineaDue = canonicalEventLine(seconda);
  fs.writeFileSync(fileDue, lineaDue + 'x'.repeat(10), { mode: 0o600 });
  fs.chmodSync(fileDue, 0o600);
  const taglia = {
    ...fs,
    readSync: (fd, buf, off, len, pos) => {
      if (pos >= dimensione) return 0;
      const n = fs.readSync(fd, buf, off, Math.min(len, dimensione - pos), pos);
      return n;
    },
  };
  const fabTaglia = creaFactory(mod, fx, { fsRecovery: taglia });
  assert.equal(
    fabTaglia.factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
    'uncertain',
    'a read ending before the qualified size is a change, not an event',
  );

  // A read error after valid bytes stays uncertain.
  let chiamate = 0;
  const errore = {
    ...fs,
    readSync: (fd, buf, off, len, pos) => {
      chiamate += 1;
      if (chiamate > 1) { const e = new Error('eio'); e.code = 'EIO'; throw e; }
      return fs.readSync(fd, buf, off, Math.min(len, 5), pos);
    },
  };
  const fabErrore = creaFactory(mod, fx, { fsRecovery: errore });
  assert.equal(
    fabErrore.factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
    'uncertain',
    'an I/O error after five valid bytes stays uncertain',
  );
});

test('the admitted plan is the normative one: caps come from the scaling, the remainder only to the last phase', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const { factory } = creaFactory(mod, fx);

  // A pair of caps moved by one with the sum unchanged is not a partition of
  // the budget the contract fixes: it is refused before any effect.
  const base = piano(8000, 68000);
  const spostato = {
    ...base,
    phases: base.phases.map((f, i) => {
      if (i === 0) return { ...f, capMs: f.capMs + 1, allowanceMs: Math.min(f.allowanceMs, f.capMs + 1) };
      if (i === 8) return { ...f, capMs: f.capMs - 1, allowanceMs: Math.min(f.allowanceMs, f.capMs - 1) };
      return f;
    }),
  };
  const sommaBase = base.phases.reduce((a, f) => a + f.capMs, 0) + base.marginMs;
  const sommaSpostata = spostato.phases.reduce((a, f) => a + f.capMs, 0) + spostato.marginMs;
  assert.equal(sommaSpostata, sommaBase, 'the mutated plan keeps the same sum');
  const openedSpostato = factory.openAttempt(ctxPer(fx, { phasePlan: spostato }), 'silent');
  assert.equal(Boolean(openedSpostato && openedSpostato.ok), false, 'a cap moved off the scaling is refused');

  // Exact normative plans are admitted at every sampled budget, including the
  // extremes of the admitted range.
  for (const budget of [200, 2800, 8000, 15000]) {
    const opened = factory.openAttempt(ctxPer(fx, { phasePlan: piano(budget, 68000) }), 'silent');
    assert.equal(opened && opened.ok, true, `the normative plan for B=${budget} is admitted`);
    factory.closeAttempt(opened.attempt);
  }
});

test('without the private boundary every traversed ring is qualified, so an intermediate link is refused', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const base = path.join(fx.root, 'diretto');
  const reale = path.join(base, 'reale');
  const cella = path.join(reale, 'cella');
  fs.mkdirSync(cella, { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o700);
  fs.chmodSync(reale, 0o700);
  fs.chmodSync(cella, 0o700);
  const alias = path.join(base, 'alias');
  fs.symlinkSync(reale, alias);
  const { factory, killCalls } = creaFactory(mod, fx);

  // Direct path: no `.nexuscrew` component, but every ring is a real directory
  // of ours, so the store is qualified and an empty one reads clear.
  const trOk = factory.readTrace({ stateDir: cella, record: fx.record });
  assert.equal(trOk.state, 'clear', 'a direct store on a qualified chain reads clear');

  // Same store reached through an intermediate symbolic link: the leaf is
  // real, the component above it is not, and the classification must not be
  // built on a path we do not control.
  const trLink = factory.readTrace({ stateDir: path.join(alias, 'cella'), record: fx.record });
  assert.equal(trLink.state, 'uncertain', 'an intermediate link makes the chain unattestable');

  const ctx = ctxPer(fx, { stateDir: path.join(alias, 'cella') });
  const opened = factory.openAttempt(ctx, 'silent');
  assert.equal(Boolean(opened && opened.ok), false, 'the attempt is refused on a chain we cannot attest');
  assert.deepEqual(killCalls, [], 'zero signals');
  assert.equal(fs.existsSync(path.join(cella, 'recovery-events')), false, 'nothing was created');
});

test('a pre-existing store directory at 0755 is refused as a store', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o755);
  const { factory, killCalls } = creaFactory(mod, fx);

  const tr = factory.readTrace({ stateDir: fx.stateDir, record: fx.record });
  assert.equal(tr.state, 'uncertain', 'a store writable by others is never clear');
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(Boolean(opened && opened.ok), false, 'a store writable by others is not admitted');
  assert.deepEqual(killCalls, [], 'zero signals');
});

test('the store descriptor must be the directory the no-follow lstat qualified', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  // A store swapped between the lstat and the open: the descriptor belongs to a
  // different object, and the classification must never be clear.
  const percorsi = new Map();
  const impl = {
    ...fs,
    openSync: (p, flags, mode) => {
      const fd = fs.openSync(p, flags, mode);
      percorsi.set(fd, path.resolve(p));
      return fd;
    },
    closeSync: (fd) => { percorsi.delete(fd); return fs.closeSync(fd); },
    fstatSync: (fd, opts) => {
      const st = fs.fstatSync(fd, opts);
      if (percorsi.get(fd) !== path.resolve(dir)) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 });
    },
  };
  const { factory, killCalls } = creaFactory(mod, fx, { fsRecovery: impl });

  const tr = factory.readTrace({ stateDir: fx.stateDir, record: fx.record });
  assert.equal(tr.state, 'uncertain', 'a substituted store descriptor is never clear');
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(Boolean(opened && opened.ok), false, 'the admission refuses an unattestable store');
  assert.deepEqual(killCalls, [], 'zero signals');
});

test('a store replaced during the enumeration is not clear', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const evento = {
    version: 1,
    launchId: fx.record.launchId,
    attemptId: hexId(16),
    seq: 1,
    kind: 'closed',
    contextDigest: computeContextDigest(fx.record),
    method: null,
  };
  fs.writeFileSync(path.join(dir, '00000001-closed.json'), canonicalEventLine(evento), { mode: 0o600 });
  fs.chmodSync(path.join(dir, '00000001-closed.json'), 0o600);
  // The name is qualified before the reads and again after them: the second
  // observation answers with a different object, so the entries read cannot be
  // attributed to the store we qualified.
  let letture = 0;
  const impl = {
    ...fs,
    lstatSync: (p, opts) => {
      const st = fs.lstatSync(p, opts);
      if (path.resolve(p) !== path.resolve(dir)) return st;
      letture += 1;
      if (letture !== 2) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: st.ino + 1 });
    },
  };
  const { factory } = creaFactory(mod, fx, { fsRecovery: impl });

  assert.equal(
    factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
    'uncertain',
    'a store that is no longer the qualified one after the reads is never clear',
  );
  assert.equal(letture, 2, 'the store name was qualified before and after the enumeration');
});

test('a store whose mode changes at the final qualification is not clear', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const evento = {
    version: 1,
    launchId: fx.record.launchId,
    attemptId: hexId(16),
    seq: 1,
    kind: 'closed',
    contextDigest: computeContextDigest(fx.record),
    method: null,
  };
  const file = path.join(dir, '00000001-closed.json');
  fs.writeFileSync(file, canonicalEventLine(evento), { mode: 0o600 });
  fs.chmodSync(file, 0o600);

  // Only the mode changes in the last observation, with the same device and
  // inode: the object is the one read, but it is no longer a store. Both the
  // descriptor and the name are checked.
  const varianti = [
    ['fstat', (metti) => ({
      ...fs,
      openSync: (p, flags, mode) => { const fd = fs.openSync(p, flags, mode); metti.fd.set(fd, path.resolve(p)); return fd; },
      closeSync: (fd) => { metti.fd.delete(fd); return fs.closeSync(fd); },
      fstatSync: (fd, opts) => metti.dopo(fd, fs.fstatSync(fd, opts)),
    })],
    ['lstat', (metti) => ({
      ...fs,
      lstatSync: (p, opts) => metti.dopo(p, fs.lstatSync(p, opts)),
    })],
  ];
  for (const [caso, costruisci] of varianti) {
    let letture = 0;
    const metti = {
      fd: new Map(),
      dopo: (chiave, st) => {
        const percorso = typeof chiave === 'number' ? metti.fd.get(chiave) : chiave;
        if (percorso !== path.resolve(dir)) return st;
        letture += 1;
        if (letture !== 2) return st;
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mode: 0o40755 });
      },
    };
    const { factory } = creaFactory(mod, fx, { fsRecovery: costruisci(metti) });
    assert.equal(
      factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
      'uncertain',
      `a store that is no longer 0700 at the final ${caso} is never clear`,
    );
    assert.equal(letture, 2, `the store was qualified before and after the reads (${caso})`);
  }

  // The same history with a store that stays 0700 is clear.
  const { factory: stabile } = creaFactory(mod, fx);
  assert.equal(
    stabile.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
    'clear',
    'a stable store is still clear',
  );
});

test('without a private anchor a shared ring writable by others makes the store unattestable', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  // The fixture root answers as root writable by group and without the sticky
  // bit, and the ancestors above it as root at 0755 (the run's TMPDIR is a 0700
  // ring of ours and would otherwise be an anchor): a chain with no anchor and a
  // shared ring anyone can write is not traversed.
  const sopra = {};
  for (let p = path.dirname(path.resolve(fx.root));;) {
    sopra[p] = { uid: 0, mode: 0o40755 };
    const padre = path.dirname(p);
    if (padre === p) break;
    p = padre;
  }
  const impl = {
    ...fs,
    lstatSync: (p, opts) => {
      const st = fs.lstatSync(p, opts);
      const patch = path.resolve(p) === path.resolve(fx.root)
        ? { uid: 0, mode: 0o40777 }
        : sopra[path.resolve(p)];
      return patch ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, patch) : st;
    },
  };
  const { factory } = creaFactory(mod, fx, { fsRecovery: impl });

  assert.equal(
    factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
    'uncertain',
    'a shared ring writable by group without sticky is not traversed',
  );
});

test('the record format accepts a group and a session id of one, which are not signal targets', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const conUno = { ...fx.record, hostIdentity: { ...fx.record.hostIdentity, pgid: 1, sid: 1 } };
  assert.equal(mod.guardRecord(conUno), true, 'pgid and sid follow the stop module format: a positive integer, 1 included');
  const conPidUno = { ...fx.record, hostIdentity: { ...fx.record.hostIdentity, pid: 1 } };
  assert.equal(mod.guardRecord(conPidUno), false, 'pid stays above one: it is the signal target');
  const conZero = { ...fx.record, hostIdentity: { ...fx.record.hostIdentity, pgid: 0 } };
  assert.equal(mod.guardRecord(conZero), false, 'a group id of zero is not a format');
});

test('the object is qualified again after the read, so a mode or link change is refused', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const evento = {
    version: 1,
    launchId: fx.record.launchId,
    attemptId: hexId(16),
    seq: 1,
    kind: 'closed',
    contextDigest: computeContextDigest(fx.record),
    method: null,
  };
  const file = path.join(dir, '00000001-closed.json');
  fs.writeFileSync(file, canonicalEventLine(evento), { mode: 0o600 });
  fs.chmodSync(file, 0o600);

  for (const [caso, patch] of [
    ['modo', { mode: 0o100644 }],
    ['link', { nlink: 2 }],
  ]) {
    // The second qualification of the file is the one doctored: the counter is
    // per descriptor, so the store directory's own qualification is untouched.
    const letture = new Map();
    const percorsi = new Map();
    const impl = {
      ...fs,
      openSync: (p, flags, mode) => {
        const fd = fs.openSync(p, flags, mode);
        percorsi.set(fd, path.resolve(p));
        return fd;
      },
      closeSync: (fd) => { percorsi.delete(fd); return fs.closeSync(fd); },
      fstatSync: (fd) => {
        const st = fs.fstatSync(fd);
        if (percorsi.get(fd) !== path.resolve(file)) return st;
        const n = (letture.get(fd) || 0) + 1;
        letture.set(fd, n);
        if (n !== 2) return st;
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, patch);
      },
    };
    const { factory } = creaFactory(mod, fx, { fsRecovery: impl });
    assert.equal(
      factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
      'uncertain',
      `a change of ${caso} detected at the end of the read is refused`,
    );
  }

  // A stable object read in short slices stays admitted.
  const corto = { ...fs, readSync: (fd, buf, off, len, pos) => fs.readSync(fd, buf, off, Math.min(len, 7), pos) };
  const { factory: stabile } = creaFactory(mod, fx, { fsRecovery: corto });
  assert.equal(stabile.readTrace({ stateDir: fx.stateDir, record: fx.record }).state, 'clear', 'a stable object read in slices stays clear');
});

test('the reservation authority is per store in the process, not per factory, and only the owner releases it', (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', 'export createHostRecovery missing');

  const fx = creaFixture(t);
  seedStoria(fx.stateDir, fx.record, 54); // 54 + 10 = 64: exactly the admitted boundary
  const a = creaFactory(mod, fx);
  const b = creaFactory(mod, fx);

  const openedA = a.factory.openAttempt(ctxPer(fx), 'expected');
  assert.equal(openedA && openedA.ok, true, 'A admitted at the boundary 54 + 10');

  // A second factory on the same qualified store must see the reservation held
  // by A: the authority belongs to the store, not to the object that asked.
  const openedB = b.factory.openAttempt(ctxPer(fx), 'expected');
  assert.equal(Boolean(openedB && openedB.ok), false, 'a second factory is refused on the same store');
  assert.equal(typeof (openedB && openedB.code), 'string', 'the refusal carries a code');

  // A foreign look-alike handle must not release A's reservation.
  const lookAlike = { mode: 'expected', stateDir: fx.stateDir, need: 10 };
  b.factory.closeAttempt(lookAlike);
  b.factory.closeAttempt(openedB && openedB.attempt);
  const ancoraRefused = b.factory.openAttempt(ctxPer(fx), 'expected');
  assert.equal(Boolean(ancoraRefused && ancoraRefused.ok), false, 'a foreign handle does not free the store');

  // Only the exact owner closes it.
  a.factory.closeAttempt(openedA.attempt);
  const openedBAfter = b.factory.openAttempt(ctxPer(fx), 'expected');
  assert.equal(openedBAfter && openedBAfter.ok, true, 'once the owner closes, the store admits again');
  b.factory.closeAttempt(openedBAfter.attempt);

  assert.deepEqual(a.killCalls, [], 'zero signals on the admission path');
  assert.deepEqual(b.killCalls, [], 'zero signals on the admission path');
});

test('validateEvent reads the object own keys only and refuses inherited, hidden and symbolic ones', (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.validateEvent, 'function', 'validateEvent: missing export');

  const fx = creaFixture(t);
  const contextDigest = computeContextDigest(fx.record);
  const attemptId = hexId(16);
  // One admissible event per kind: the closed schema is the same for all of
  // them, and the own-key requirement is not a property of the common fields
  // only.
  const extraPerKind = {
    'cli-attempt': {},
    'peer-verified': {},
    'cli-ack': { reason: 'shutdown_ack' },
    'cli-refusal': { reason: 'peer_unknown' },
    'cli-failed': { reason: 'io' },
    'intent-term': { method: 'term' },
    'signaled-term': { method: 'term', reason: 'sent' },
    'intent-kill': { method: 'kill' },
    'signaled-kill': { method: 'kill', reason: 'esrch' },
    exited: { method: 'term', reason: 'absent' },
    closed: { method: null },
  };

  for (const [kind, extra] of Object.entries(extraPerKind)) {
    const valido = {
      version: 1,
      launchId: fx.record.launchId,
      attemptId,
      seq: 1,
      kind,
      contextDigest,
      ...extra,
    };
    assert.equal(mod.validateEvent(valido), true, `${kind}: a plain object with every own field is accepted`);

    // Every field is readable through the prototype and none of them is own:
    // the closed schema must not be built on inherited values.
    assert.equal(mod.validateEvent(Object.create(valido)), false, `${kind}: inherited fields are not fields`);

    // An own key that exists without being enumerable escapes the key
    // comparison of a check built on Object.keys.
    const nascosto = { ...valido };
    Object.defineProperty(nascosto, 'token', { value: 'x', enumerable: false });
    assert.equal(mod.validateEvent(nascosto), false, `${kind}: a hidden own key is refused`);

    // A common field made non-enumerable is the same hole on a required field.
    const comune = { ...valido };
    delete comune.version;
    Object.defineProperty(comune, 'version', { value: 1, enumerable: false });
    assert.equal(mod.validateEvent(comune), false, `${kind}: a hidden common field is refused`);

    // A symbol key is not a string key, and the schema is closed over names.
    assert.equal(
      mod.validateEvent({ ...valido, [Symbol('token')]: 'x' }),
      false,
      `${kind}: a symbolic key is refused`,
    );

    // A plain extra field is refused like any other kind already did.
    assert.equal(mod.validateEvent({ ...valido, token: 'x' }), false, `${kind}: an extra field is refused`);
  }
});

test('a refusal or an open CLI attempt blocks the silence until a proof is recorded after it', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  const launchId = fx.record.launchId;
  const A = hexId(16);
  const B = hexId(16);
  const tr = () => mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fx.stateDir, record: fx.record });

  // A refusal is a blocking marker: the attempt reached its outcome, and only
  // a new positive proof removes the block. A later `closed` is the host
  // barrier of that same attempt, not a new proof.
  seedEvent(fx.stateDir, { launchId, attemptId: A, seq: 1, kind: 'cli-attempt', contextDigest: digest });
  seedEvent(fx.stateDir, { launchId, attemptId: A, seq: 2, kind: 'cli-refusal', contextDigest: digest, reason: 'peer_mismatch' });
  assert.equal(tr().state, 'blocked', 'a refusal blocks the silence');
  seedEvent(fx.stateDir, { launchId, attemptId: A, seq: 3, kind: 'closed', contextDigest: digest, method: null });
  assert.equal(tr().state, 'blocked', 'a closed after the refusal does not lift the block');

  // The proof of the same context recorded AFTER the marker is what lifts it.
  seedEvent(fx.stateDir, { launchId, attemptId: B, seq: 4, kind: 'peer-verified', contextDigest: digest });
  assert.equal(tr().state, 'clear', 'a fresh proof recorded after the refusal lifts the block');

  // A refusal of another launch is not the refusal of this one.
  const fxAltra = creaFixture(t);
  const digestAltra = computeContextDigest(fxAltra.record);
  seedEvent(fxAltra.stateDir, {
    launchId: 'ab'.repeat(8), attemptId: hexId(16), seq: 1, kind: 'cli-refusal', contextDigest: digestAltra, reason: 'peer_unknown',
  });
  assert.equal(
    mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fxAltra.stateDir, record: fxAltra.record }).state,
    'clear',
    'a refusal of another launch does not block this context',
  );

  // A proof recorded BEFORE the marker does not lift it, and a proof of another
  // launch does not lift it either.
  const fxPrima = creaFixture(t);
  const digestPrima = computeContextDigest(fxPrima.record);
  const P = hexId(16);
  seedEvent(fxPrima.stateDir, { launchId: fxPrima.record.launchId, attemptId: P, seq: 1, kind: 'peer-verified', contextDigest: digestPrima });
  seedEvent(fxPrima.stateDir, { launchId: fxPrima.record.launchId, attemptId: P, seq: 2, kind: 'cli-refusal', contextDigest: digestPrima, reason: 'expected_invalid' });
  assert.equal(
    mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fxPrima.stateDir, record: fxPrima.record }).state,
    'blocked',
    'a proof recorded before the refusal does not lift it',
  );
  seedEvent(fxPrima.stateDir, { launchId: 'cd'.repeat(8), attemptId: hexId(16), seq: 3, kind: 'peer-verified', contextDigest: digestPrima });
  assert.equal(
    mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fxPrima.stateDir, record: fxPrima.record }).state,
    'blocked',
    'a proof of another launch does not lift the refusal of this one',
  );

  // An intent is not a CLI trace and does not block: a crash between the intent
  // and the signal is the point a resume starts from.
  const fxIntent = creaFixture(t);
  const digestIntent = computeContextDigest(fxIntent.record);
  seedEvent(fxIntent.stateDir, {
    launchId: fxIntent.record.launchId, attemptId: hexId(16), seq: 1, kind: 'intent-term', contextDigest: digestIntent, method: 'term',
  });
  assert.equal(
    mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fxIntent.stateDir, record: fxIntent.record }).state,
    'clear',
    'an intent alone does not block the silence',
  );

  // A CLI attempt whose own last event is the attempt never reached an outcome:
  // it blocks, and here too only a later proof lifts it.
  const fxAperto = creaFixture(t);
  const digestAperto = computeContextDigest(fxAperto.record);
  const O = hexId(16);
  seedEvent(fxAperto.stateDir, { launchId: fxAperto.record.launchId, attemptId: O, seq: 1, kind: 'cli-attempt', contextDigest: digestAperto });
  assert.equal(
    mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fxAperto.stateDir, record: fxAperto.record }).state,
    'blocked',
    'an open CLI attempt blocks',
  );
  seedEvent(fxAperto.stateDir, { launchId: fxAperto.record.launchId, attemptId: hexId(16), seq: 2, kind: 'peer-verified', contextDigest: digestAperto });
  assert.equal(
    mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fxAperto.stateDir, record: fxAperto.record }).state,
    'clear',
    'a proof recorded after the open attempt lifts the block',
  );
});

test('a silent attempt without consent reserves nothing and does not hold the store', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  // A store exactly at the cap: no place is free for even one event.
  seedStoria(fx.stateDir, fx.record, 64);
  const { factory, killCalls } = creaFactory(mod, fx);

  // The read-only branch is the historical adapter without authorization: it
  // writes nothing, so it holds no slot and cannot be refused by the capacity
  // its own entry would never consume.
  const solaLettera = {
    record: fx.record,
    stateDir: fx.stateDir,
    deadlineAt: 68000,
    allowHostRecovery: false,
    fenceCheck: () => true,
  };
  const primo = factory.openAttempt(solaLettera, 'silent');
  assert.equal(Boolean(primo && primo.ok), true, 'the read-only branch is admitted on a full store');
  const secondo = factory.openAttempt(solaLettera, 'silent');
  assert.equal(Boolean(secondo && secondo.ok), true, 'the read-only branch takes no place, so a second one is admitted too');

  // The store is still free: an attempt that writes is refused for capacity,
  // not because a place was held by the read-only branch.
  const scrittura = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(Boolean(scrittura && scrittura.ok), false, 'a full store does not admit an attempt that writes');
  assert.equal(scrittura && scrittura.code, 'STORE_CAPACITY', 'the refusal is the capacity, not a place held by the read-only branch');

  if (primo && primo.ok) factory.closeAttempt(primo.attempt);
  if (secondo && secondo.ok) factory.closeAttempt(secondo.attempt);
  assert.deepEqual(killCalls, [], 'zero signals on the read-only admission');
});

test('a read-only attempt is admitted while an attempt that writes holds the store', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  seedStoria(fx.stateDir, fx.record, 54); // 54 + 10 = 64, the admitted boundary
  const a = creaFactory(mod, fx);
  const b = creaFactory(mod, fx);

  const scrittore = a.factory.openAttempt(ctxPer(fx), 'expected');
  assert.equal(scrittore && scrittore.ok, true, 'the attempt that writes takes its ten places');

  const solaLettera = {
    record: fx.record,
    stateDir: fx.stateDir,
    deadlineAt: 68000,
    allowHostRecovery: false,
    fenceCheck: () => true,
  };
  const lettore = b.factory.openAttempt(solaLettera, 'silent');
  assert.equal(
    Boolean(lettore && lettore.ok),
    true,
    'the read-only branch is neither refused nor a second writer: it holds no place',
  );

  if (lettore && lettore.ok) b.factory.closeAttempt(lettore.attempt);
  // Releasing the read-only handle must not free the writer's places.
  const ancora = b.factory.openAttempt(ctxPer(fx), 'expected');
  assert.equal(Boolean(ancora && ancora.ok), false, 'the writer still holds its place after the read-only release');

  a.factory.closeAttempt(scrittore.attempt);
  const dopo = b.factory.openAttempt(ctxPer(fx), 'expected');
  assert.equal(Boolean(dopo && dopo.ok), true, 'once the writer closes, the store admits again');
  if (dopo && dopo.ok) b.factory.closeAttempt(dopo.attempt);
  assert.deepEqual(a.killCalls, [], 'zero signals');
  assert.deepEqual(b.killCalls, [], 'zero signals');
});

test('the durable append syncs the temporary before naming it and the directories after', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dirRec = path.resolve(path.join(fx.stateDir, 'recovery-events'));
  const stateDir = path.resolve(fx.stateDir);

  // The order of the primitives is what makes an append durable: the temporary
  // is synced before its name exists, and the two directories are synced after
  // the name appeared. Both are observed on the same fake the writer uses.
  const ordine = [];
  const percorsi = new Map();
  const impl = {
    ...fs,
    openSync(p, ...rest) {
      const fd = fs.openSync(p, ...rest);
      percorsi.set(fd, path.resolve(String(p)));
      return fd;
    },
    closeSync(fd) { percorsi.delete(fd); return fs.closeSync(fd); },
    fsyncSync(fd) {
      ordine.push({ che: 'fsync', p: percorsi.get(fd) || '' });
      return fs.fsyncSync(fd);
    },
  };
  const segnale = doppioSegnale();
  const factory = mod.createHostRecovery({
    fsRecovery: impl,
    publishExclusive: (opts) => {
      ordine.push({ che: 'publish', dest: path.resolve(String(opts.dest)) });
      return PUB_EXCL(opts);
    },
    killProcess: segnale.killProcess,
    // A zombie at the entry proves the exit without any signal, so the two
    // events of the barrier go through the writer.
    osservaKernel: () => ({ state: 'observed', processState: 'Z', identity: { ...fx.record.hostIdentity } }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 60000,
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
  });

  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'openAttempt expected ok');

  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }
  assert.equal(out.outcome, 'host-stopped-attested', 'the zombie is attested without a signal');
  assert.deepEqual(segnale.chiamate, [], 'the proved exit needs no signal at all');

  const pubblicazioni = [];
  ordine.forEach((voce, i) => { if (voce.che === 'publish') pubblicazioni.push(i); });
  assert.equal(pubblicazioni.length, 2, 'two events are published by the barrier');
  for (let k = 0; k < pubblicazioni.length; k += 1) {
    const da = pubblicazioni[k];
    const a = k + 1 < pubblicazioni.length ? pubblicazioni[k + 1] : ordine.length;
    const prima = ordine.slice(0, da);
    const dopo = ordine.slice(da + 1, a);
    assert.ok(
      prima.some((v) => v.che === 'fsync' && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(v.p)),
      `publication ${k + 1} comes after the sync of the temporary`,
    );
    assert.ok(
      dopo.some((v) => v.che === 'fsync' && v.p === dirRec),
      `publication ${k + 1} is followed by the sync of the store directory`,
    );
    assert.ok(
      dopo.some((v) => v.che === 'fsync' && v.p === stateDir),
      `publication ${k + 1} is followed by the sync of the chain`,
    );
  }

  const nomi = fs.readdirSync(dirRec).sort();
  assert.deepEqual(
    nomi,
    ['00000001-exited.json', '00000002-closed.json'],
    'no temporary is left behind and both events are in the store',
  );
});

test('a fresh peer proof is persisted before the blocking trace is lifted', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  const rifiuto = hexId(16);
  seedEvent(fx.stateDir, { launchId: fx.record.launchId, attemptId: rifiuto, seq: 1, kind: 'cli-attempt', contextDigest: digest });
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: rifiuto, seq: 2, kind: 'cli-refusal', contextDigest: digest, reason: 'peer_mismatch',
  });

  const h = fx.record.hostIdentity;
  const peer = {
    schema_version: 1,
    state: 'verified',
    pid: h.pid,
    uid: h.uid,
    boot_id: h.bootId,
    pidns: h.pidNamespaceInode,
    starttime: h.startTicks,
    pgid: h.pgid,
    sid: h.sid,
  };
  const eventiOra = () => {
    const dir = path.join(fx.stateDir, 'recovery-events');
    return fs.readdirSync(dir).sort().map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
  };

  const segnale = doppioSegnale();

  function creaConSonda(probeRoot) {
    return mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      // The signal and the wait are doubles: a test never reaches the kernel,
      // and the proof is about the trace, not about the delivery.
      killProcess: segnale.killProcess,
      attesaImpl: async () => {},
      osservaKernel: () => ({ state: 'observed', processState: 'S', identity: { ...h } }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => 60000,
      probeRoot,
    });
  }

  async function prova(factory) {
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted on a blocking trace: the proof needs a place');
    try {
      return await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
  }

  // The absence of the socket, and a live peer that does not verify its own
  // identity, are not a proof: the trace stays blocked and nothing is written.
  const negative = [
    ['socket absent', async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } })],
    ['peer not verified', async () => ({ r: { ok: true }, stato: { ok: true, state: 'live', peer_identity: { ...peer, state: 'unverified' } } })],
    ['coherent peer with a different birth', async () => ({ r: { ok: true }, stato: { ok: true, state: 'live', peer_identity: { ...peer, starttime: '999999' } } })],
  ];
  for (const [caso, sonda] of negative) {
    const out = await prova(creaConSonda(sonda));
    assert.equal(out.outcome, 'host-stop-failed', `${caso}: the silence is not lifted`);
    assert.equal(out.code, 'TRACE_BLOCKED', `${caso}: the refusal names the block`);
    assert.equal(
      eventiOra().some((ev) => ev.kind === 'peer-verified'),
      false,
      `${caso}: no proof is written`,
    );
  }

  // The fresh positive proof of the original peer lifts the block, and it is in
  // the store BEFORE the entry can act on it.
  const positiva = creaConSonda(async () => ({ r: { ok: true }, stato: { ok: true, state: 'live', peer_identity: { ...peer } } }));
  const out = await prova(positiva);
  assert.notEqual(out.code, 'TRACE_BLOCKED', 'a verified peer of the same process lifts the block');
  const eventi = eventiOra();
  const prova1 = eventi.filter((ev) => ev.kind === 'peer-verified');
  assert.equal(prova1.length, 1, 'exactly one proof is recorded');
  assert.ok(prova1[0].seq > 2, 'the proof is recorded after the refusal it lifts');
  assert.equal(prova1[0].launchId, fx.record.launchId, 'the proof belongs to this context');
  assert.equal(prova1[0].contextDigest, digest, 'the proof is bound to the registered tuple');
  assert.equal(
    mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
    'clear',
    'with the proof persisted the trace reads clear',
  );
  // The negatives never reached the seam; the positive lifted the block and the
  // entry then delivered the first signal of the context, exactly once.
  assert.deepEqual(
    segnale.chiamate,
    [{ pid: HOST_PID, sig: 'SIGTERM' }, { pid: HOST_PID, sig: 'SIGKILL' }],
    'the proof lifts the block, one TERM follows, and the kill follows the term',
  );
});

test('an existing name with different bytes is a conflict, not a confirmation of the append', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dirRec = path.join(fx.stateDir, 'recovery-events');
  fs.mkdirSync(dirRec, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirRec, 0o700);
  const digest = computeContextDigest(fx.record);

  // A valid event of ANOTHER launch already occupies the name this append would
  // publish. The bytes are canonical and the object is qualified: only the
  // identity inside them differs, and that is exactly the case where an
  // existing name must not be read as "already done".
  const estraneo = `${JSON.stringify({
    version: 1,
    launchId: 'ef'.repeat(8),
    attemptId: hexId(16),
    seq: 1,
    kind: 'intent-term',
    contextDigest: digest,
    method: 'term',
  })}\n`;
  const dest = path.join(dirRec, '00000001-intent-term.json');
  let iniettato = false;

  const segnale = doppioSegnale();
  const factory = mod.createHostRecovery({
    fsRecovery: fs,
    publishExclusive: (opts) => {
      if (!iniettato && String(opts.dest).endsWith('intent-term.json')) {
        iniettato = true;
        fs.writeFileSync(opts.dest, estraneo, { mode: 0o600 });
        fs.chmodSync(opts.dest, 0o600);
      }
      return PUB_EXCL(opts);
    },
    killProcess: segnale.killProcess,
    osservaKernel: () => ({ state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity } }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 60000,
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
  });

  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'openAttempt expected ok');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(iniettato, true, 'the collision on the intent name was actually injected');
  assert.equal(out.outcome, 'host-stop-failed', 'a discordant name stops the attempt');
  assert.equal(out.code, 'STORE', 'the conflict is a store failure, not a later step');
  assert.deepEqual(segnale.chiamate, [], 'the conflict stops before any signal');
  assert.equal(fs.readFileSync(dest, 'utf8'), estraneo, 'the existing name is never overwritten');
  assert.ok(
    fs.readdirSync(dirRec).some((n) => /^\.tmp-[a-f0-9]{32}$/.test(n)),
    'the temporary of the failed append is left in place',
  );
  assert.equal(
    mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
    'uncertain',
    'the leftover temporary leaves the trace uncertain',
  );
});

test('a blocking trace refuses an attempt that could never lift it', (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  const A = hexId(16);
  seedEvent(fx.stateDir, { launchId: fx.record.launchId, attemptId: A, seq: 1, kind: 'cli-attempt', contextDigest: digest });
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: A, seq: 2, kind: 'cli-refusal', contextDigest: digest, reason: 'peer_mismatch',
  });
  const { factory } = creaFactory(mod, fx);

  // The read-only branch cannot take a proof and cannot write: on a blocking
  // trace it is refused at admission, before any attempt exists.
  const solaLettera = {
    record: fx.record,
    stateDir: fx.stateDir,
    deadlineAt: 68000,
    allowHostRecovery: false,
    fenceCheck: () => true,
  };
  const rifiutato = factory.openAttempt(solaLettera, 'silent');
  assert.equal(Boolean(rifiutato && rifiutato.ok), false, 'the read-only branch is refused on a blocking trace');
  assert.equal(rifiutato && rifiutato.code, 'TRACE_BLOCKED', 'the refusal names the block');

  // An attempt with consent is admitted, because the proof that lifts the block
  // needs a place to be persisted under; the entry then refuses unless the
  // proof succeeds.
  const ammesso = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(Boolean(ammesso && ammesso.ok), true, 'the attempt that may take the proof is admitted');
  if (ammesso && ammesso.ok) factory.closeAttempt(ammesso.attempt);
});

test('an absence or a reused pid in another domain is no evidence about the registered process', async (t) => {
  const mod = caricaModuloRecovery();
  const ALTRO_BOOT = '52345678-1234-4234-8234-123456789abc';
  const ALTRO_NS = '4026532999';
  const fx = creaFixture(t);
  const h = fx.record.hostIdentity;

  const eventiOra = () => {
    const dir = path.join(fx.stateDir, 'recovery-events');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir);
  };

  const segnale = doppioSegnale();

  function factoryCon({ osservatore, nodo }) {
    return mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: segnale.killProcess,
      osservaKernel: osservatore,
      identitaNodo: () => nodo,
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => 60000,
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
    });
  }

  async function prova(factory) {
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted: the domain is not an admission question');
    try {
      return await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
  }

  // The registered domain is A; the reading machine and the observer both say
  // B. They agree with each other and disagree with the record: that is no
  // evidence about the record's process.
  const negativo = [
    ['absence in another boot', () => ({ state: 'absent', node: { bootId: ALTRO_BOOT, pidNamespaceInode: PID_NS } }), { bootId: ALTRO_BOOT, pidNamespaceInode: PID_NS }],
    ['absence in another namespace', () => ({ state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: ALTRO_NS } }), { bootId: BOOT_ID, pidNamespaceInode: ALTRO_NS }],
    ['different birth in another boot', () => ({ state: 'observed', processState: 'S', identity: { ...h, bootId: ALTRO_BOOT, startTicks: '99999' } }), { bootId: ALTRO_BOOT, pidNamespaceInode: PID_NS }],
    ['different birth in another namespace', () => ({ state: 'observed', processState: 'S', identity: { ...h, pidNamespaceInode: ALTRO_NS, startTicks: '99999' } }), { bootId: BOOT_ID, pidNamespaceInode: ALTRO_NS }],
    // The observing machine is in the registered domain and the observation
    // still carries another one: the divergence is in what the observer saw.
    ['observation in another boot', () => ({ state: 'observed', processState: 'S', identity: { ...h, bootId: ALTRO_BOOT, startTicks: '99999' } }), { bootId: BOOT_ID, pidNamespaceInode: PID_NS }],
    ['observation in another namespace', () => ({ state: 'observed', processState: 'S', identity: { ...h, pidNamespaceInode: ALTRO_NS, startTicks: '99999' } }), { bootId: BOOT_ID, pidNamespaceInode: PID_NS }],
  ];
  for (const [caso, osservatore, nodo] of negativo) {
    const out = await prova(factoryCon({ osservatore, nodo }));
    assert.equal(out.outcome, 'host-stop-failed', `${caso}: the entry must not attest anything`);
    assert.equal(out.code, 'IDENTITY_UNKNOWN', `${caso}: the refusal names the unknown domain`);
    assert.deepEqual(eventiOra(), [], `${caso}: no exited, no closed, nothing written`);
  }

  // A uid difference in the registered domain is still a mutation of the same
  // process, not a death, and not a reused pid.
  const soloUid = await prova(factoryCon({
    osservatore: () => ({ state: 'observed', processState: 'S', identity: { ...h, uid: UID + 1 } }),
    nodo: { bootId: BOOT_ID, pidNamespaceInode: PID_NS },
  }));
  assert.equal(soloUid.outcome, 'host-stop-failed', 'a uid difference is no death');
  assert.equal(soloUid.code, 'IDENTITY', 'a uid difference stays an unproved identity');
  assert.deepEqual(eventiOra(), [], 'a uid difference writes nothing');

  // The same domain, the same absence: the proof stands and the barrier writes.
  const positivo = await prova(factoryCon({
    osservatore: () => ({ state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
    nodo: { bootId: BOOT_ID, pidNamespaceInode: PID_NS },
  }));
  assert.equal(positivo.outcome, 'host-stopped-attested', 'an absence in the registered domain is a proved exit');
  assert.equal(positivo.method, null, 'no signal is needed for a proved exit');
  assert.deepEqual(eventiOra().sort(), ['00000001-exited.json', '00000002-closed.json'], 'the barrier records exited and closed');
  assert.deepEqual(segnale.chiamate, [], 'no case of the domain test reaches the signal');
});

test('during a publication the temporary and the final name both occupy a place', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  // 56 entries plus the eight places of a silent attempt is exactly the cap:
  // the attempt is admitted and its appends must stop with two places free.
  seedStoria(fx.stateDir, fx.record, 56);
  const dir = path.join(fx.stateDir, 'recovery-events');
  let massimo = 56;

  const segnale = doppioSegnale();
  const factory = mod.createHostRecovery({
    fsRecovery: fs,
    publishExclusive: (opts) => {
      const esito = PUB_EXCL(opts);
      // The temporary is still in the namespace when the final name appears:
      // this is the peak the cap must bound.
      massimo = Math.max(massimo, fs.readdirSync(dir).length);
      return esito;
    },
    killProcess: segnale.killProcess,
    attesaImpl: async () => {},
    // The original is already a zombie: the barrier is reached with no signal
    // and the exit and the close are what contend for the last places.
    osservaKernel: () => ({ state: 'observed', processState: 'Z', identity: { ...fx.record.hostIdentity } }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 60000,
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
  });

  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, '56 + 8 = 64: the attempt is admitted at the boundary');

  // Other admissible entries appear while the attempt is open: the places were
  // taken at admission, and the writer below sees the store where it is now.
  const digest = computeContextDigest(fx.record);
  for (let i = 0; i < 3; i += 1) {
    const id = hexId(16);
    seedEvent(fx.stateDir, { launchId: fx.record.launchId, attemptId: id, seq: 57 + i * 2, kind: 'cli-attempt', contextDigest: digest });
    seedEvent(fx.stateDir, { launchId: fx.record.launchId, attemptId: id, seq: 58 + i * 2, kind: 'cli-ack', contextDigest: digest, reason: 'shutdown_ack' });
  }
  assert.equal(fs.readdirSync(dir).length, 62, 'sixty-two entries before the publication');

  // The exit is published with 62 entries on disk, so the interval holds the
  // temporary and the final name over exactly 64: the peak is the cap, and it
  // is reached rather than merely bounded. The close that would follow has no
  // two places and is refused before creating anything.
  const primo = await factory.recover(opened.attempt, 'silent');
  const nomiPrima = fs.readdirSync(dir).sort();
  const secondo = await factory.recover(opened.attempt, 'silent');
  const nomiDopo = fs.readdirSync(dir).sort();
  factory.closeAttempt(opened.attempt);

  assert.equal(massimo, 64, `the peak of the namespace during a publication is the cap (measured: ${massimo})`);
  assert.equal(primo.code, 'STORE_CAPACITY', 'the close finds no two places');
  assert.equal(secondo.code, 'STORE_CAPACITY', 'the repeated close still finds no two places');
  assert.deepEqual(nomiDopo, nomiPrima, 'the refused close creates nothing');
  assert.equal(nomiDopo.length, 63, 'sixty-two seeded entries plus the recorded exit');
  assert.ok(nomiDopo.includes('00000063-exited.json'), 'the published event is the exit the barrier recorded');
  assert.deepEqual(segnale.chiamate, [], 'the zombie path needs no signal');
});

test('a sync that fails after the temporary is removed spends the attempt and leaves a residual', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  let rimosso = false;
  let iniettato = false;
  const impl = {
    ...fs,
    unlinkSync(p) {
      const esito = fs.unlinkSync(p);
      if (/\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(String(p))) rimosso = true;
      return esito;
    },
    fsyncSync(fd) {
      if (rimosso && !iniettato) {
        iniettato = true;
        const e = new Error('EIO injected after the removal');
        e.code = 'EIO';
        throw e;
      }
      return fs.fsyncSync(fd);
    },
  };
  const segnale = doppioSegnale();
  const factory = mod.createHostRecovery({
    fsRecovery: impl,
    publishExclusive: PUB_EXCL,
    killProcess: segnale.killProcess,
    // A zombie proves the exit without a signal, so the barrier goes straight
    // to the two appends.
    osservaKernel: () => ({ state: 'observed', processState: 'Z', identity: { ...fx.record.hostIdentity } }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 60000,
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
  });

  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'openAttempt expected ok');

  const out = await factory.recover(opened.attempt, 'silent');
  assert.equal(out.outcome, 'host-stop-failed', 'a cleanup that cannot be made durable is a failure');
  assert.equal(out.code, 'STORE', 'the failure is a store failure');
  assert.equal(iniettato, true, 'the failure fell on the sync that follows the removal');

  // The event bytes were synced before its name appeared, so the event is
  // there; what is not there is the durable record of the removal.
  const nomi = fs.readdirSync(dir);
  assert.ok(nomi.includes('00000001-exited.json'), 'the published event is the one whose cleanup failed');
  assert.ok(
    nomi.some((n) => /^\.tmp-[a-f0-9]{32}$/.test(n)),
    'a residual is recreated so that the store cannot be read clear',
  );

  const traccia = factory.readTrace({ stateDir: fx.stateDir, record: fx.record });
  assert.notEqual(traccia.state, 'clear', 'a failed removal sync never leaves a clear trace');
  assert.equal(traccia.state, 'uncertain', 'the residual makes the trace uncertain');

  // The handle is spent: the same attempt may not act again on that store.
  const prima = fs.readdirSync(dir).sort();
  const seconda = await factory.recover(opened.attempt, 'silent');
  const dopo = fs.readdirSync(dir).sort();
  factory.closeAttempt(opened.attempt);
  assert.equal(seconda.outcome, 'host-stop-failed', 'the spent handle does not resume');
  assert.equal(seconda.code, 'STORE', 'every later operation on a spent handle is a store failure');
  assert.deepEqual(dopo, prima, 'the refused call writes nothing');
  assert.deepEqual(segnale.chiamate, [], 'the zombie path sends no signal');
});

test('a CLI attempt without its own outcome stays blocking whatever recovery does after it', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  const dir = path.join(fx.stateDir, 'recovery-events');
  const A = hexId(16);
  const tr = () => mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fx.stateDir, record: fx.record });

  // The CLI never received its own answer, and an intent does not answer for
  // it: the attempt is still open.
  seedEvent(fx.stateDir, { launchId: fx.record.launchId, attemptId: A, seq: 1, kind: 'cli-attempt', contextDigest: digest });
  seedEvent(fx.stateDir, { launchId: fx.record.launchId, attemptId: A, seq: 2, kind: 'intent-term', contextDigest: digest, method: 'term' });
  assert.equal(tr().state, 'blocked', 'an intent is not the missing CLI outcome');

  // The entry admits the attempt — the proof needs a place — and refuses it
  // without a proof, writing nothing.
  const { factory } = creaFactory(mod, fx);
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted on the block');
  const out = await factory.recover(opened.attempt, 'silent');
  factory.closeAttempt(opened.attempt);
  assert.equal(out.outcome, 'host-stop-failed', 'without a proof the entry does not proceed');
  assert.equal(out.code, 'TRACE_BLOCKED', 'the refusal names the block');
  assert.equal(fs.readdirSync(dir).length, 2, 'no third event is written');

  // A fresh proof recorded after the open attempt is what lifts it.
  seedEvent(fx.stateDir, { launchId: fx.record.launchId, attemptId: hexId(16), seq: 3, kind: 'peer-verified', contextDigest: digest });
  assert.equal(tr().state, 'clear', 'a proof recorded after the open attempt lifts the block');

  // A CLI that received its own answer is not blocking: the recovery continues
  // where the CLI left it.
  for (const [caso, esito] of [
    ['ack', { kind: 'cli-ack', reason: 'shutdown_ack' }],
    ['failure', { kind: 'cli-failed', reason: 'io' }],
  ]) {
    const fxCaso = creaFixture(t);
    const d = computeContextDigest(fxCaso.record);
    const B = hexId(16);
    seedEvent(fxCaso.stateDir, { launchId: fxCaso.record.launchId, attemptId: B, seq: 1, kind: 'cli-attempt', contextDigest: d });
    seedEvent(fxCaso.stateDir, { launchId: fxCaso.record.launchId, attemptId: B, seq: 2, kind: esito.kind, contextDigest: d, reason: esito.reason });
    seedEvent(fxCaso.stateDir, { launchId: fxCaso.record.launchId, attemptId: B, seq: 3, kind: 'intent-term', contextDigest: d, method: 'term' });
    assert.equal(
      mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fxCaso.stateDir, record: fxCaso.record }).state,
      'clear',
      `a CLI ${caso} closes the CLI: the trace is resumable`,
    );
  }
});

test('a failure of the random source is a store failure, never a thrown promise', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  const segnale = doppioSegnale();
  const factory = mod.createHostRecovery({
    fsRecovery: fs,
    publishExclusive: PUB_EXCL,
    killProcess: segnale.killProcess,
    osservaKernel: () => ({ state: 'observed', processState: 'Z', identity: { ...fx.record.hostIdentity } }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 60000,
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
  });

  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'openAttempt expected ok');

  // The random source is reached through the module object that every loader
  // shares: replacing it for the duration of the call is the only injection
  // point this path has, and it is restored in finally.
  const originale = crypto.randomBytes;
  let out;
  try {
    crypto.randomBytes = () => { throw Object.assign(new Error('no entropy'), { code: 'EIO' }); };
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    crypto.randomBytes = originale;
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out && out.outcome, 'host-stop-failed', 'the entry answers a failure instead of rejecting its promise');
  assert.equal(out.code, 'STORE', 'a failure of the random source is a store failure');
  const nomi = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepEqual(nomi, [], 'nothing is created');
  assert.deepEqual(segnale.chiamate, [], 'the failed source never reaches the signal');
});

test('the barrier records one exit per context, not one per operation', async (t) => {
  const mod = caricaModuloRecovery();

  function creaConAssenza(segnale) {
    return mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: segnale.killProcess,
      osservaKernel: () => ({ state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => 60000,
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
    });
  }

  function eventiDi(fx) {
    const dir = path.join(fx.stateDir, 'recovery-events');
    return fs.readdirSync(dir).sort().map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
  }

  // A previous operation of the same launch and context already recorded the
  // exit: the barrier must not record it a second time and goes to the close.
  {
    const fx = creaFixture(t);
    const digest = computeContextDigest(fx.record);
    seedEvent(fx.stateDir, {
      launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'exited', contextDigest: digest, method: null, reason: 'absent',
    });
    const segnale = doppioSegnale();
    const factory = creaConAssenza(segnale);
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'openAttempt expected ok');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stopped-attested', 'the proved absence is attested');
    assert.equal(out.method, null, 'no signal is needed');
    const eventi = eventiDi(fx);
    assert.deepEqual(eventi.map((e) => e.kind), ['exited', 'closed'], 'one exit and one close, in that order');
    assert.equal(eventi.filter((e) => e.kind === 'exited').length, 1, 'the existing exit is not duplicated');
    assert.deepEqual(segnale.chiamate, [], 'the proved absence sends no signal');
  }

  // An exit recorded in another context is not this context's exit: it does
  // not count, and the barrier records its own.
  {
    const fx = creaFixture(t);
    seedEvent(fx.stateDir, {
      launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'exited', contextDigest: 'f'.repeat(64), method: null, reason: 'absent',
    });
    const segnale = doppioSegnale();
    const factory = creaConAssenza(segnale);
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'openAttempt expected ok');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stopped-attested', 'the proved absence is attested');
    const eventi = eventiDi(fx);
    assert.deepEqual(eventi.map((e) => e.kind), ['exited', 'exited', 'closed'], 'the foreign exit does not count');
    assert.equal(eventi[1].contextDigest, computeContextDigest(fx.record), 'the second exit belongs to this context');
    assert.deepEqual(segnale.chiamate, [], 'the proved absence sends no signal');
  }
});

test('the block follows the unresolved CLI attempt, not the last recovery event', (t) => {
  const mod = caricaModuloRecovery();
  const tr = (fx) => mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fx.stateDir, record: fx.record });

  // The proof is recorded after the attempt: from then on the attempt is no
  // longer an open CLI, and what recovery writes for it does not move the
  // marker back behind the proof.
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  const launchId = fx.record.launchId;
  const A = hexId(16);
  const B = hexId(16);
  seedEvent(fx.stateDir, { launchId, attemptId: A, seq: 1, kind: 'cli-attempt', contextDigest: digest });
  seedEvent(fx.stateDir, { launchId, attemptId: B, seq: 2, kind: 'peer-verified', contextDigest: digest });
  assert.equal(tr(fx).state, 'clear', 'a proof recorded after the attempt lifts the block');
  seedEvent(fx.stateDir, { launchId, attemptId: A, seq: 3, kind: 'intent-term', contextDigest: digest, method: 'term' });
  assert.equal(tr(fx).state, 'clear', 'an intent of that attempt does not revoke a proof already recorded');

  // A NEW attempt is a new protected marker and blocks again.
  const C = hexId(16);
  seedEvent(fx.stateDir, { launchId, attemptId: C, seq: 4, kind: 'cli-attempt', contextDigest: digest });
  assert.equal(tr(fx).state, 'blocked', 'a new open attempt after the proof blocks again');

  // A refusal after the proof blocks as well, and for its own position.
  const fxR = creaFixture(t);
  const dR = computeContextDigest(fxR.record);
  const AR = hexId(16);
  const BR = hexId(16);
  seedEvent(fxR.stateDir, { launchId: fxR.record.launchId, attemptId: AR, seq: 1, kind: 'cli-attempt', contextDigest: dR });
  seedEvent(fxR.stateDir, { launchId: fxR.record.launchId, attemptId: BR, seq: 2, kind: 'peer-verified', contextDigest: dR });
  seedEvent(fxR.stateDir, { launchId: fxR.record.launchId, attemptId: AR, seq: 3, kind: 'intent-term', contextDigest: dR, method: 'term' });
  assert.equal(tr(fxR).state, 'clear', 'the same story reads clear before the refusal');
  seedEvent(fxR.stateDir, { launchId: fxR.record.launchId, attemptId: AR, seq: 4, kind: 'cli-refusal', contextDigest: dR, reason: 'peer_mismatch' });
  assert.equal(tr(fxR).state, 'blocked', 'a refusal after the proof blocks again');

  // Without a proof the attempt stays blocking whatever recovery writes after
  // it: the position of the block is the attempt itself.
  const fxN = creaFixture(t);
  const dN = computeContextDigest(fxN.record);
  const AN = hexId(16);
  seedEvent(fxN.stateDir, { launchId: fxN.record.launchId, attemptId: AN, seq: 1, kind: 'cli-attempt', contextDigest: dN });
  seedEvent(fxN.stateDir, { launchId: fxN.record.launchId, attemptId: AN, seq: 2, kind: 'intent-term', contextDigest: dN, method: 'term' });
  seedEvent(fxN.stateDir, { launchId: fxN.record.launchId, attemptId: AN, seq: 3, kind: 'exited', contextDigest: dN, method: null, reason: 'absent' });
  assert.equal(tr(fxN).state, 'blocked', 'an exit of the same attempt does not become the marker either');
});

test('the residual left by a cleanup error is synced itself and as an entry of the store', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.resolve(path.join(fx.stateDir, 'recovery-events'));
  const ordine = [];
  const percorsi = new Map();
  let rimosso = false;
  let iniettato = false;

  const impl = {
    ...fs,
    openSync(p, ...rest) {
      const fd = fs.openSync(p, ...rest);
      const abs = path.resolve(String(p));
      percorsi.set(fd, abs);
      if (rimosso && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && (Number(rest[0]) & fs.constants.O_CREAT)) {
        ordine.push({ che: 'residuo', p: abs });
      }
      return fd;
    },
    closeSync(fd) { percorsi.delete(fd); return fs.closeSync(fd); },
    unlinkSync(p) {
      const esito = fs.unlinkSync(p);
      if (/\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(String(p))) rimosso = true;
      return esito;
    },
    fsyncSync(fd) {
      ordine.push({ che: 'fsync', p: percorsi.get(fd) || '' });
      if (rimosso && !iniettato) {
        iniettato = true;
        throw Object.assign(new Error('EIO injected after the removal'), { code: 'EIO' });
      }
      return fs.fsyncSync(fd);
    },
  };

  const segnale = doppioSegnale();
  const factory = mod.createHostRecovery({
    fsRecovery: impl,
    publishExclusive: PUB_EXCL,
    killProcess: segnale.killProcess,
    osservaKernel: () => ({ state: 'observed', processState: 'Z', identity: { ...fx.record.hostIdentity } }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 60000,
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
  });

  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'openAttempt expected ok');
  const out = await factory.recover(opened.attempt, 'silent');
  factory.closeAttempt(opened.attempt);
  assert.equal(out.code, 'STORE', 'the cleanup error is a store failure');

  const indice = ordine.findIndex((v) => v.che === 'residuo');
  assert.ok(indice >= 0, 'a residual was created after the removal');
  const residuo = ordine[indice].p;
  const dopo = ordine.slice(indice + 1);
  assert.ok(
    dopo.some((v) => v.che === 'fsync' && v.p === residuo),
    'the residual itself is synced after its creation',
  );
  assert.ok(
    dopo.some((v) => v.che === 'fsync' && v.p === dir),
    'the store directory is synced after the residual is created',
  );
  assert.equal(
    mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
    'uncertain',
    'while the residual is there the store reads uncertain',
  );
  assert.deepEqual(segnale.chiamate, [], 'the zombie path sends no signal');
});

test('the cleanup erratum: a residual that cannot be left lets a new handle resume from clear', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  let rimosso = false;
  let iniettato = false;

  const impl = {
    ...fs,
    openSync(p, ...rest) {
      const abs = path.resolve(String(p));
      // The residual cannot be created at all: a filesystem that says there is
      // no space left.
      if (rimosso && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && (Number(rest[0]) & fs.constants.O_CREAT)) {
        throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      }
      return fs.openSync(p, ...rest);
    },
    unlinkSync(p) {
      const esito = fs.unlinkSync(p);
      if (/\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(String(p))) rimosso = true;
      return esito;
    },
    fsyncSync(fd) {
      if (rimosso && !iniettato) {
        iniettato = true;
        throw Object.assign(new Error('EIO injected after the removal'), { code: 'EIO' });
      }
      return fs.fsyncSync(fd);
    },
  };

  const crea = (segnale) => mod.createHostRecovery({
    fsRecovery: impl,
    publishExclusive: PUB_EXCL,
    killProcess: segnale.killProcess,
    osservaKernel: () => ({ state: 'observed', processState: 'Z', identity: { ...fx.record.hostIdentity } }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 60000,
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
  });

  const segnalePrimo = doppioSegnale();
  const factory = crea(segnalePrimo);
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'openAttempt expected ok');

  const primo = await factory.recover(opened.attempt, 'silent');
  assert.equal(primo.code, 'STORE', 'the first entry fails on the cleanup');
  const dopoPrimo = fs.readdirSync(dir).sort();
  const contenuto = new Map(dopoPrimo.map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
  assert.deepEqual(dopoPrimo, ['00000001-exited.json'], 'only the published event is in the store');

  // The spent handle does not act again, and it writes nothing.
  const secondo = await factory.recover(opened.attempt, 'silent');
  assert.equal(secondo.code, 'STORE', 'the spent handle answers a store failure');
  assert.deepEqual(fs.readdirSync(dir).sort(), dopoPrimo, 'the spent handle writes nothing');
  for (const [n, testo] of contenuto) {
    assert.equal(fs.readFileSync(path.join(dir, n), 'utf8'), testo, `the published event ${n} is byte-identical`);
  }

  // The erratum: with no residual the store reads clear, and a new handle is
  // admitted and resumes from the durable events already there.
  assert.equal(
    mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
    'clear',
    'the erratum says the residual is a best effort: without it the store reads clear',
  );
  factory.closeAttempt(opened.attempt);
  const segnaleNuovo = doppioSegnale();
  const nuovo = crea(segnaleNuovo);
  const ammesso = nuovo.openAttempt(ctxPer(fx), 'silent');
  assert.equal(ammesso && ammesso.ok, true, 'a new handle is admitted on the store left by the cleanup error');
  if (ammesso && ammesso.ok) nuovo.closeAttempt(ammesso.attempt);
  assert.deepEqual(segnalePrimo.chiamate, [], 'the failed cleanup never reaches the signal');
  assert.deepEqual(segnaleNuovo.chiamate, [], 'the resumed handle signals nothing either');
});

function eventiStore(stateDir) {
  const dir = path.join(stateDir, 'recovery-events');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort()
    .filter((n) => /^\d{8}-[a-z-]+\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
}

// A factory whose signal and wait are always doubles and whose seams are
// otherwise the store's own: a run is never allowed to reach the kernel.
function creaPerCli(mod, fx, extra = {}) {
  const killCalls = [];
  const factory = mod.createHostRecovery({
    fsRecovery: extra.fsRecovery || fs,
    publishExclusive: extra.publishExclusive || PUB_EXCL,
    killProcess: (pid, sig) => {
      killCalls.push({ pid, sig });
      if (extra.onKill) extra.onKill(pid, sig);
    },
    attesaImpl: async () => {},
    osservaKernel: extra.osservaKernel
      || (() => ({ state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity } })),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: extra.monoNow || (() => 60000),
    probeRoot: extra.probeRoot
      || (async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } })),
  });
  return { factory, killCalls };
}

test('the expected run persists the attempt before the single CLI call and the outcome after it', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const { factory, killCalls } = creaPerCli(mod, fx);
  const opened = factory.openAttempt(ctxPer(fx), 'expected');
  assert.equal(opened && opened.ok, true, 'the expected attempt is admitted');

  const chiamate = [];
  let out;
  try {
    out = await factory.runExpected(opened.attempt, async (arg) => {
      chiamate.push({ arg, kinds: eventiStore(fx.stateDir).map((e) => e.kind) });
      return { result: { code: 7 }, event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
    });
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out && out.ok, true, 'the run answers ok');
  assert.deepEqual(out.result, { code: 7 }, 'the raw result stays in the caller');
  assert.equal(chiamate.length, 1, 'the callback is invoked exactly once');
  assert.deepEqual(chiamate[0].arg, { deadlineAt: 68000, budgetMs: 1000 }, 'the CLI receives the deadline and the phase limit');
  assert.deepEqual(chiamate[0].kinds, ['cli-attempt'], 'the attempt is durable before the call');
  assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['cli-attempt', 'cli-ack'], 'the outcome follows the attempt');
  assert.equal(factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state, 'clear', 'the context reads clear after the ack');
  assert.deepEqual(killCalls, [], 'a run never signals');
});

test('a rejected run leaves the open attempt blocking and nothing is repeated', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const { factory, killCalls } = creaPerCli(mod, fx);
  const opened = factory.openAttempt(ctxPer(fx), 'expected');
  assert.equal(opened && opened.ok, true, 'the expected attempt is admitted');

  let chiamate = 0;
  let primo;
  try {
    primo = await factory.runExpected(opened.attempt, async () => {
      chiamate += 1;
      throw new Error('the run rejected');
    });
  } finally {
    // The handle stays usable for the checks below and is released at the end.
  }
  assert.equal(primo && primo.ok, false, 'a rejected run is a refusal');
  assert.equal(primo.code, 'CLI', 'the refusal names the run');
  assert.equal(factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state, 'blocked', 'the open attempt blocks the silence');

  const nomiPrima = fs.readdirSync(path.join(fx.stateDir, 'recovery-events')).sort();
  const secondo = await factory.runExpected(opened.attempt, async () => {
    chiamate += 1;
    return { result: null, event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
  });
  const rec = await factory.recover(opened.attempt, 'silent');
  factory.closeAttempt(opened.attempt);

  assert.equal(secondo && secondo.code, 'CLI_USED', 'the run is already consumed, and no second CLI starts');
  assert.equal(rec.outcome, 'host-stop-failed', 'recovery fails on the block');
  assert.equal(rec.code, 'TRACE_BLOCKED', 'the refusal names the block');
  assert.equal(chiamate, 1, 'the callback is not invoked again');
  assert.deepEqual(killCalls, [], 'no signal is sent on a blocked trace');
  assert.deepEqual(fs.readdirSync(path.join(fx.stateDir, 'recovery-events')).sort(), nomiPrima, 'nothing is rewritten');
});

test('a run without the pre-CLI reserve refuses before writing anything', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const { factory, killCalls } = creaPerCli(mod, fx);
  const deadline = 60599;
  const opened = factory.openAttempt({
    record: fx.record,
    stateDir: fx.stateDir,
    deadlineAt: deadline,
    phasePlan: piano(8000, deadline),
    allowHostRecovery: true,
    fenceCheck: () => true,
  }, 'expected');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted below the reserve');

  let chiamate = 0;
  let out;
  try {
    out = await factory.runExpected(opened.attempt, async () => {
      chiamate += 1;
      return { result: null, event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
    });
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out && out.code, 'BUDGET', 'the missing reserve is a budget refusal');
  assert.equal(chiamate, 0, 'no CLI without the reserve');
  assert.deepEqual(eventiStore(fx.stateDir), [], 'no event is written');
  assert.deepEqual(killCalls, [], 'no signal');
});

test('an outcome the schema cannot carry is never written', async (t) => {
  const mod = caricaModuloRecovery();

  for (const [caso, evento] of [
    ['extra field', { kind: 'cli-ack', reason: 'shutdown_ack', method: 'term' }],
    ['reason outside the vocabulary', { kind: 'cli-failed', reason: 'invented' }],
    ['not a CLI outcome', { kind: 'intent-term', method: 'term' }],
  ]) {
    const fx = creaFixture(t);
    const { factory, killCalls } = creaPerCli(mod, fx);
    const opened = factory.openAttempt(ctxPer(fx), 'expected');
    assert.equal(opened && opened.ok, true, `${caso}: the attempt is admitted`);
    let out;
    try {
      out = await factory.runExpected(opened.attempt, async () => ({ result: null, event: evento }));
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out && out.code, 'STORE', `${caso}: the invalid outcome is a store refusal`);
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['cli-attempt'], `${caso}: only the attempt is written`);
    assert.deepEqual(killCalls, [], `${caso}: no signal`);
  }
});

test('a run is admitted only on an expected handle, and an asynchronous delivery is refused at the source', async (t) => {
  const mod = caricaModuloRecovery();

  {
    const fx = creaFixture(t);
    const { factory, killCalls } = creaPerCli(mod, fx);
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the silent attempt is admitted');
    let chiamate = 0;
    let out;
    try {
      out = await factory.runExpected(opened.attempt, async () => {
        chiamate += 1;
        return { result: null, event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
      });
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out && out.code, 'MODE', 'a silent handle does not run a CLI');
    assert.equal(chiamate, 0, 'the callback is never invoked');

    const ignoto = await factory.runExpected({}, async () => { chiamate += 1; });
    assert.equal(ignoto && ignoto.code, 'HANDLE', 'an unknown handle is refused by name');
    assert.equal(chiamate, 0, 'the callback is still never invoked');
    assert.deepEqual(eventiStore(fx.stateDir), [], 'no event is written');
    assert.deepEqual(killCalls, [], 'no signal');
  }

  {
    const fx = creaFixture(t);
    let chiamate = 0;
    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: async () => { chiamate += 1; },
      attesaImpl: async () => {},
      osservaKernel: () => ({ state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity } }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => 60000,
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, false, 'a promise-returning delivery is not a delivery');
    assert.equal(opened && opened.code, 'CONTEXT', 'the refusal names the contract');
    assert.equal(chiamate, 0, 'the asynchronous seam is never called');
    assert.deepEqual(eventiStore(fx.stateDir), [], 'no event is written');
  }
});

test('an empty store, a live original and a fresh none end on the term', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  let alive = true;
  const { factory, killCalls } = creaPerCli(mod, fx, {
    osservaKernel: (pid, instanceId) => (alive
      ? { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } }
      : { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
    probeRoot: async () => ({
      r: { ok: true },
      stato: { ok: true, state: alive ? 'lock' : 'none', declared_pid: null, pid_number_in_use: null },
    }),
    onKill: (_pid, sig) => { if (sig === 'SIGTERM') alive = false; },
  });
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted on an empty store');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out.outcome, 'host-stopped-attested', 'the stop is attested');
  assert.equal(out.method, 'term', 'the method is the signal the context attempted');
  assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], 'exactly one TERM');
  assert.deepEqual(
    eventiStore(fx.stateDir).map((e) => e.kind),
    ['intent-term', 'signaled-term', 'exited', 'closed'],
    'intent, signal, exit and close, in that order',
  );
  assert.equal(factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state, 'clear', 'the context reads clear');
});

test('a durable intent already in the context is not written again before the term', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'intent-term', contextDigest: digest, method: 'term',
  });

  const ordine = [];
  const killCalls = [];
  // Every seam schedules a microtask and remembers its epoch: a microtask that
  // has run before the syscall is an await that stood in the final window.
  let epoca = 0;
  let flushati = 0;
  let ultimoClock = 0;
  // The epoch of the LAST snapshot taken before the syscall: no microtask armed
  // from that snapshot on — by the snapshot, the fence or the clock — may have
  // run when the signal is delivered.
  let ultimaFoto = 0;
  let microFlush = null;
  let microFoto = null;
  const arma = (label) => {
    epoca += 1;
    const e = epoca;
    ordine.push(label);
    Promise.resolve().then(() => { flushati = Math.max(flushati, e); });
    return e;
  };

  const factory = mod.createHostRecovery({
    fsRecovery: fs,
    publishExclusive: PUB_EXCL,
    killProcess: (pid, sig) => {
      killCalls.push({ pid, sig });
      ordine.push(`kill:${sig}`);
      microFlush = flushati >= ultimoClock;
      microFoto = flushati >= ultimaFoto;
    },
    attesaImpl: async () => {},
    osservaKernel: () => {
      ultimaFoto = arma('osserva');
      return { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity } };
    },
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => { ultimoClock = arma('clock'); return 60000; },
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
  });

  const ctxOrdinato = { ...ctxPer(fx), fenceCheck: () => { arma('fence'); return true; } };
  const opened = factory.openAttempt(ctxOrdinato, 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted on the intent alone');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.deepEqual(
    killCalls,
    [{ pid: HOST_PID, sig: 'SIGTERM' }, { pid: HOST_PID, sig: 'SIGKILL' }],
    'the term of the context is delivered once and the kill follows it',
  );
  assert.equal(eventiStore(fx.stateDir).filter((e) => e.kind === 'intent-term').length, 1, 'the intent is not written a second time');
  const iKill = ordine.indexOf('kill:SIGTERM');
  assert.ok(iKill > 2, 'the syscall is in the trace');
  assert.deepEqual(
    ordine.slice(iKill - 3, iKill),
    ['osserva', 'fence', 'clock'],
    'the fresh snapshot, the fence and the last clock precede the syscall',
  );
  assert.equal(microFlush, false, 'no microtask or await stands between the last clock and the syscall');
  assert.equal(microFoto, false, 'no microtask or await stands between the last snapshot and the syscall');
  assert.equal(out.outcome, 'host-stop-failed', 'a still alive original ends in failure');
});

test('a term already recorded with an original still alive opens the kill window once', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'signaled-term', contextDigest: digest, method: 'term', reason: 'sent',
  });
  const { factory, killCalls } = creaPerCli(mod, fx);
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out.outcome, 'host-stop-failed', 'a still alive original ends in failure');
  assert.equal(out.hostAlive, true, 'the last reading of the original was positive');
  assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGKILL' }], 'the term is not replayed: one kill');
  assert.deepEqual(
    eventiStore(fx.stateDir).map((e) => e.kind),
    ['signaled-term', 'intent-kill', 'signaled-kill'],
    'the kill intent and the kill follow the recorded term',
  );
});

test('a term already recorded is resolved by the absence and the barrier carries the method', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'signaled-term', contextDigest: digest, method: 'term', reason: 'sent',
  });
  const { factory, killCalls } = creaPerCli(mod, fx, {
    osservaKernel: () => ({ state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
  });
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out.outcome, 'host-stopped-attested', 'the absence resolves the signal');
  assert.equal(out.method, 'term', 'the method is the recorded signal');
  assert.deepEqual(killCalls, [], 'no second signal');
  const eventi = eventiStore(fx.stateDir);
  assert.deepEqual(eventi.map((e) => e.kind), ['signaled-term', 'exited', 'closed'], 'exit and close follow the signal');
  assert.deepEqual(eventi.slice(1).map((e) => e.method), ['term', 'term'], 'both carry the recorded method');
});

test('an exit already recorded is closed without a second exit', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'exited', contextDigest: digest, method: null, reason: 'absent',
  });
  const { factory } = creaPerCli(mod, fx, {
    osservaKernel: () => ({ state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
  });
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out.outcome, 'host-stopped-attested', 'the proved absence is attested');
  assert.equal(out.method, null, 'no signal was attempted');
  const eventi = eventiStore(fx.stateDir);
  assert.deepEqual(eventi.map((e) => e.kind), ['exited', 'closed'], 'only the close is added');
  assert.equal(eventi[1].method, null, 'the close carries no method');
});

test('an exit and a close already recorded are attested without new events', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'exited', contextDigest: digest, method: null, reason: 'absent',
  });
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: hexId(16), seq: 2, kind: 'closed', contextDigest: digest, method: null,
  });
  let pubblicazioni = 0;
  const { factory, killCalls } = creaPerCli(mod, fx, {
    publishExclusive: (opts) => { pubblicazioni += 1; return PUB_EXCL(opts); },
    osservaKernel: () => ({ state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
  });
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out.outcome, 'host-stopped-attested', 'a complete history is already attested');
  assert.equal(out.method, null, 'no signal is invented');
  assert.equal(pubblicazioni, 0, 'no event is written');
  assert.deepEqual(killCalls, [], 'no signal');
  assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['exited', 'closed'], 'the store is unchanged');
});

test('the cleanup erratum on the signal leaves the marker and a new handle does not proceed', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  let armato = false;
  let rimosso = false;
  let eio = false;
  let enospc = false;

  const impl = {
    ...fs,
    openSync(p, ...rest) {
      const abs = path.resolve(String(p));
      if (armato && rimosso && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && (Number(rest[0]) & fs.constants.O_CREAT)) {
        enospc = true;
        throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      }
      return fs.openSync(p, ...rest);
    },
    unlinkSync(p) {
      const esito = fs.unlinkSync(p);
      if (/\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(String(p))) rimosso = true;
      return esito;
    },
    fsyncSync(fd) {
      if (armato && rimosso && !eio) {
        eio = true;
        throw Object.assign(new Error('EIO injected after the removal'), { code: 'EIO' });
      }
      return fs.fsyncSync(fd);
    },
  };

  const crea = () => mod.createHostRecovery({
    fsRecovery: impl,
    publishExclusive: PUB_EXCL,
    killProcess: (pid, sig) => {
      killCalls.push({ pid, sig });
      if (sig === 'SIGTERM') { armato = true; rimosso = false; }
    },
    attesaImpl: async () => {},
    osservaKernel: () => ({ state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity } }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 60000,
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
  });
  const killCalls = [];

  const factory = crea();
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  const primo = await factory.recover(opened.attempt, 'silent');
  assert.equal(primo.code, 'STORE', 'the cleanup failure is a store failure');
  assert.equal(eio, true, 'the failure fell on the sync after the removal');
  assert.equal(enospc, true, 'the residual could not be created');
  // The post-event append failed, so the marker of the window stays: every
  // reader — a new factory, another process — must see the store as uncertain.
  assert.equal(
    mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
    'uncertain',
    'the marker of the window keeps the store uncertain',
  );
  const nomiPrima = fs.readdirSync(dir).sort();
  assert.deepEqual(
    nomiPrima.filter((n) => /^\d{8}-/.test(n)),
    ['00000001-intent-term.json', '00000002-signaled-term.json'],
    'the published events are the two durable ones',
  );
  assert.equal(nomiPrima.filter((n) => /^\.tmp-[a-f0-9]{32}$/.test(n)).length, 1, 'the marker is still there');

  const secondo = await factory.recover(opened.attempt, 'silent');
  assert.equal(secondo.code, 'STORE', 'the spent handle does not act again');
  factory.closeAttempt(opened.attempt);

  armato = false;
  rimosso = false;
  const nuovo = crea();
  const ammesso = nuovo.openAttempt(ctxPer(fx), 'silent');
  assert.equal(ammesso && ammesso.ok, false, 'a new handle does not proceed on an uncertain store');
  assert.equal(ammesso && ammesso.code, 'TRACE_UNCERTAIN', 'the refusal names the uncertainty');
  assert.equal(killCalls.filter((k) => k.sig === 'SIGTERM').length, 1, 'exactly one TERM across both handles');
  assert.deepEqual(fs.readdirSync(dir).sort(), nomiPrima, 'nothing is rewritten, removed or duplicated');
});

test('the cleanup erratum with a residual in place: the new handle does not proceed', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  let armato = false;
  let rimosso = false;
  let eio = false;

  const impl = {
    ...fs,
    unlinkSync(p) {
      const esito = fs.unlinkSync(p);
      if (/\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(String(p))) rimosso = true;
      return esito;
    },
    fsyncSync(fd) {
      if (armato && rimosso && !eio) {
        eio = true;
        throw Object.assign(new Error('EIO injected after the removal'), { code: 'EIO' });
      }
      return fs.fsyncSync(fd);
    },
  };

  const killCalls = [];
  const crea = () => mod.createHostRecovery({
    fsRecovery: impl,
    publishExclusive: PUB_EXCL,
    killProcess: (pid, sig) => {
      killCalls.push({ pid, sig });
      if (sig === 'SIGTERM') { armato = true; rimosso = false; }
    },
    attesaImpl: async () => {},
    osservaKernel: () => ({ state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity } }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 60000,
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
  });

  const factory = crea();
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  const primo = await factory.recover(opened.attempt, 'silent');
  assert.equal(primo.code, 'STORE', 'the cleanup failure is a store failure');
  factory.closeAttempt(opened.attempt);

  assert.equal(
    mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
    'uncertain',
    'the residual keeps the store uncertain',
  );
  const nomiPrima = fs.readdirSync(dir).sort();
  armato = false;
  const nuovo = crea();
  const ammesso = nuovo.openAttempt(ctxPer(fx), 'silent');
  assert.equal(ammesso && ammesso.ok, false, 'a new handle does not proceed on an uncertain store');
  assert.equal(ammesso.code, 'TRACE_UNCERTAIN', 'the refusal names the uncertainty');
  assert.equal(killCalls.filter((k) => k.sig === 'SIGTERM').length, 1, 'no second signal');
  assert.deepEqual(fs.readdirSync(dir).sort(), nomiPrima, 'nothing is written');
});

test('the cleanup erratum on the intent: the new handle delivers the first term and not a replay', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  let armato = true;
  let rimosso = false;
  let eio = false;
  let enospc = false;

  const impl = {
    ...fs,
    openSync(p, ...rest) {
      const abs = path.resolve(String(p));
      if (armato && rimosso && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && (Number(rest[0]) & fs.constants.O_CREAT)) {
        enospc = true;
        throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      }
      return fs.openSync(p, ...rest);
    },
    unlinkSync(p) {
      const esito = fs.unlinkSync(p);
      if (/\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(String(p))) rimosso = true;
      return esito;
    },
    fsyncSync(fd) {
      if (armato && rimosso && !eio) {
        eio = true;
        throw Object.assign(new Error('EIO injected after the removal'), { code: 'EIO' });
      }
      return fs.fsyncSync(fd);
    },
  };

  const killCalls = [];
  let alive = true;
  const crea = () => mod.createHostRecovery({
    fsRecovery: impl,
    publishExclusive: PUB_EXCL,
    killProcess: (pid, sig) => {
      killCalls.push({ pid, sig });
      if (sig === 'SIGTERM') alive = false;
    },
    attesaImpl: async () => {},
    osservaKernel: (pid, instanceId) => (alive
      ? { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } }
      : { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 60000,
    probeRoot: async () => ({
      r: { ok: true },
      stato: { ok: true, state: alive ? 'lock' : 'none', declared_pid: null, pid_number_in_use: null },
    }),
  });

  const factory = crea();
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  const primo = await factory.recover(opened.attempt, 'silent');
  assert.equal(primo.code, 'STORE', 'the cleanup failure is a store failure');
  assert.equal(eio, true, 'the failure fell on the sync after the removal of the intent');
  assert.equal(enospc, true, 'the residual could not be created');
  assert.deepEqual(killCalls, [], 'no signal was delivered by the failed run');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['00000001-intent-term.json'], 'only the intent is durable');
  factory.closeAttempt(opened.attempt);

  armato = false;
  rimosso = false;
  const nuovo = crea();
  const ammesso = nuovo.openAttempt(ctxPer(fx), 'silent');
  assert.equal(ammesso && ammesso.ok, true, 'a new handle is admitted on the durable intent');
  let ripresa;
  try {
    ripresa = await nuovo.recover(ammesso.attempt, 'silent');
  } finally {
    nuovo.closeAttempt(ammesso.attempt);
  }
  assert.equal(ripresa.outcome, 'host-stopped-attested', 'the first signal resolves the stop');
  assert.equal(ripresa.method, 'term', 'the method is the delivered signal');
  assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], 'the first signal is delivered once, not replayed');
  assert.equal(eventiStore(fx.stateDir).filter((e) => e.kind === 'intent-term').length, 1, 'the intent is not duplicated');
});

test('an expected context that enters after an acknowledgement needs its CLI outcome', async (t) => {
  const mod = caricaModuloRecovery();

  {
    const fx = creaFixture(t);
    const { factory, killCalls } = creaPerCli(mod, fx);
    const opened = factory.openAttempt(ctxPer(fx), 'expected');
    assert.equal(opened && opened.ok, true, 'the expected attempt is admitted on an empty store');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'after-ack');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stop-failed', 'the entry is refused');
    assert.equal(out.code, 'ENTRY', 'the refusal names the missing transition');
    assert.deepEqual(killCalls, [], 'no signal');
    assert.deepEqual(eventiStore(fx.stateDir), [], 'no effect');
  }

  {
    const fx = creaFixture(t);
    const digest = computeContextDigest(fx.record);
    const A = hexId(16);
    seedEvent(fx.stateDir, { launchId: fx.record.launchId, attemptId: A, seq: 1, kind: 'cli-attempt', contextDigest: digest });
    seedEvent(fx.stateDir, {
      launchId: fx.record.launchId, attemptId: A, seq: 2, kind: 'cli-ack', contextDigest: digest, reason: 'shutdown_ack',
    });
    let alive = true;
    const { factory, killCalls } = creaPerCli(mod, fx, {
      osservaKernel: (pid, instanceId) => (alive
        ? { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } }
        : { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
      probeRoot: async () => ({
        r: { ok: true },
        stato: { ok: true, state: alive ? 'lock' : 'none', declared_pid: null, pid_number_in_use: null },
      }),
      onKill: (_pid, sig) => { if (sig === 'SIGTERM') alive = false; },
    });
    const opened = factory.openAttempt(ctxPer(fx), 'expected');
    assert.equal(opened && opened.ok, true, 'the expected attempt is admitted');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'after-ack');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stopped-attested', 'with the CLI outcome the entry proceeds');
    assert.equal(out.method, 'term', 'the stop is attested on the term');
    assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], 'exactly one TERM');
  }
});

test('the wait phase ends on its own when the clock stands still', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  let osservazioni = 0;
  const { factory, killCalls } = creaPerCli(mod, fx, {
    osservaKernel: () => {
      osservazioni += 1;
      return { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity } };
    },
  });
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  const pianoCaso = piano(8000, 68000);
  const credito = pianoCaso.phases
    .filter((f) => ['p1', 'p2', 'p3', 'p4'].includes(f.id))
    .reduce((acc, f) => acc + f.allowanceMs, 0);
  const p5 = pianoCaso.phases.find((f) => f.id === 'p5').allowanceMs;
  const p6 = pianoCaso.phases.find((f) => f.id === 'p6').allowanceMs;
  const saldo = Math.min(p5 + credito, 68000 - 60000 - pianoCaso.marginMs - 200);
  const n = Math.min(301, 1 + Math.ceil(Math.max(0, Math.floor(saldo)) / 50));
  // The kill phase starts from the credit the term wait did not consume and is
  // bounded by the real residual minus the margin and the later phases.
  const creditoResiduo = Math.max(0, p5 + credito);
  const saldoKill = Math.min(p6 + creditoResiduo, 68000 - 60000 - pianoCaso.marginMs - 150);
  const nKill = Math.min(301, 1 + Math.ceil(Math.max(0, Math.floor(saldoKill)) / 50));

  assert.equal(out.outcome, 'host-stop-failed', 'a frozen clock ends in failure');
  assert.equal(out.code, 'BUDGET', 'the refusal names the budget');
  assert.equal(out.hostAlive, true, 'the last reading of the original was positive');
  assert.deepEqual(
    killCalls,
    [{ pid: HOST_PID, sig: 'SIGTERM' }, { pid: HOST_PID, sig: 'SIGKILL' }],
    'the term is delivered once and the kill follows it',
  );
  assert.equal(osservazioni, 3 + n + nKill, `each wait makes its own observations and terminates (${n} + ${nKill} + 3)`);
  const kinds = eventiStore(fx.stateDir).map((e) => e.kind);
  assert.ok(!kinds.includes('exited'), 'no exit without a proof');
  assert.ok(!kinds.includes('closed'), 'no close without a proof');
});

test('an unreadable snapshot during the wait is not an exit', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  let morto = false;
  let incerte = 0;
  const { factory, killCalls } = creaPerCli(mod, fx, {
    osservaKernel: (pid, instanceId) => {
      if (!morto) {
        return { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } };
      }
      if (incerte < 2) {
        incerte += 1;
        return { state: 'unverifiable', reason: 'io' };
      }
      return { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } };
    },
    probeRoot: async () => ({
      r: { ok: true },
      stato: { ok: true, state: morto ? 'none' : 'lock', declared_pid: null, pid_number_in_use: null },
    }),
    onKill: (_pid, sig) => { if (sig === 'SIGTERM') morto = true; },
  });
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out.outcome, 'host-stopped-attested', 'the absence, once observed, is attested');
  assert.equal(out.method, 'term', 'the method is the delivered signal');
  assert.equal(incerte, 2, 'the unreadable snapshots were really met during the wait');
  assert.equal(eventiStore(fx.stateDir).filter((e) => e.kind === 'exited').length, 1, 'one exit, recorded when the proof arrived');
  assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], 'no new signal');
});

test('every wait of the phase is a whole interval between one and fifty milliseconds', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  let clock = 60000;
  const attese = [];
  // The wait seam advances the clock so the loop can only end on its own bound
  // or on the deadline; every interval it receives is recorded.
  const segnale = doppioSegnale();
  const factoryConAttesa = mod.createHostRecovery({
    fsRecovery: fs,
    publishExclusive: PUB_EXCL,
    killProcess: segnale.killProcess,
    attesaImpl: async (ms) => { attese.push(ms); clock += Math.max(1, ms); },
    osservaKernel: () => ({ state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity } }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => clock,
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
  });
  const opened = factoryConAttesa.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factoryConAttesa.recover(opened.attempt, 'silent');
  } finally {
    factoryConAttesa.closeAttempt(opened.attempt);
  }

  assert.equal(out.outcome, 'host-stop-failed', 'a live original ends in failure');
  assert.ok(attese.length >= 1, 'the wait phase was entered');
  for (const ms of attese) {
    assert.equal(Number.isInteger(ms), true, `whole interval (received ${ms})`);
    assert.ok(ms >= 1 && ms <= 50, `interval between 1 and 50 (received ${ms})`);
  }
});
test('a fence lost while the attempt is persisted stops the run before the CLI', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  let fenceOk = true;
  const { factory, killCalls } = creaPerCli(mod, fx, {
    publishExclusive: (opts) => {
      let kind = null;
      try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
      const esito = PUB_EXCL(opts);
      // The fence is lost exactly while the durable attempt is being published.
      if (kind === 'cli-attempt') fenceOk = false;
      return esito;
    },
  });
  const opened = factory.openAttempt({ ...ctxPer(fx), fenceCheck: () => fenceOk }, 'expected');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted while the fence is valid');

  let chiamate = 0;
  let out;
  try {
    out = await factory.runExpected(opened.attempt, async () => {
      chiamate += 1;
      return { result: null, event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
    });
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out && out.ok, false, 'the run is refused');
  assert.equal(out.code, 'FENCE', 'the refusal names the lost fence');
  assert.equal(chiamate, 0, 'the CLI is never invoked after the fence is lost');
  assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['cli-attempt'], 'only the durable attempt is written');
  assert.equal(factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state, 'blocked', 'the open attempt blocks the trace');
  assert.deepEqual(killCalls, [], 'no signal is sent');
});
test('the expected run is consumed once per attempt', async (t) => {
  const mod = caricaModuloRecovery();

  async function crea() {
    const fx = creaFixture(t);
    const { factory, killCalls } = creaPerCli(mod, fx);
    const opened = factory.openAttempt(ctxPer(fx), 'expected');
    assert.equal(opened && opened.ok, true, 'the expected attempt is admitted');
    return { fx, factory, killCalls, attempt: opened.attempt };
  }

  const ack = { result: null, event: { kind: 'cli-ack', reason: 'shutdown_ack' } };

  // After a valid ack the run is already consumed.
  {
    const c = await crea();
    const primo = await c.factory.runExpected(c.attempt, async () => ack);
    assert.equal(primo && primo.ok, true, 'the first run succeeds');
    let seconde = 0;
    const secondo = await c.factory.runExpected(c.attempt, async () => { seconde += 1; return ack; });
    c.factory.closeAttempt(c.attempt);
    assert.equal(secondo && secondo.code, 'CLI_USED', 'a second run on the same attempt is refused by name');
    assert.equal(seconde, 0, 'the callback is never invoked again');
    assert.deepEqual(eventiStore(c.fx.stateDir).map((e) => e.kind), ['cli-attempt', 'cli-ack'], 'nothing is appended');
    assert.deepEqual(c.killCalls, [], 'no signal');
  }

  // After a declared failure the run is consumed as well.
  {
    const c = await crea();
    const primo = await c.factory.runExpected(c.attempt, async () => ({ result: null, event: { kind: 'cli-failed', reason: 'spawn' } }));
    assert.equal(primo && primo.ok, true, 'the failed CLI is still a consumed run');
    const secondo = await c.factory.runExpected(c.attempt, async () => ack);
    c.factory.closeAttempt(c.attempt);
    assert.equal(secondo && secondo.code, 'CLI_USED', 'the declared failure does not reopen the run');
  }

  // After a rejected callback the run is consumed.
  {
    const c = await crea();
    const primo = await c.factory.runExpected(c.attempt, async () => { throw new Error('rejected'); });
    assert.equal(primo && primo.code, 'CLI', 'the rejection is named');
    let seconde = 0;
    const secondo = await c.factory.runExpected(c.attempt, async () => { seconde += 1; return ack; });
    c.factory.closeAttempt(c.attempt);
    assert.equal(secondo && secondo.code, 'CLI_USED', 'a rejected run is not retried');
    assert.equal(seconde, 0, 'the callback is never invoked again');
  }

  // While the first run is still waiting the second one does not start a CLI.
  {
    const c = await crea();
    let rilascia = null;
    const attesa = new Promise((resolve) => { rilascia = resolve; });
    const primoPendente = c.factory.runExpected(c.attempt, async () => {
      await attesa;
      return ack;
    });
    let seconde = 0;
    const secondo = await c.factory.runExpected(c.attempt, async () => { seconde += 1; return ack; });
    assert.equal(secondo && secondo.code, 'CLI_USED', 'a run in progress owns the attempt');
    assert.equal(seconde, 0, 'no second CLI starts while the first waits');
    rilascia();
    const primo = await primoPendente;
    c.factory.closeAttempt(c.attempt);
    assert.equal(primo && primo.ok, true, 'the first run completes normally');
  }

  // After a persistence error the run is consumed too: the mark precedes the
  // durable write.
  {
    const fx = creaFixture(t);
    const { factory } = creaPerCli(mod, fx, {
      publishExclusive: (opts) => {
        let kind = null;
        try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
        if (kind === 'cli-attempt') return { status: 'failed-before-create', via: 'exclusive', code: 'EIO', created: false };
        return PUB_EXCL(opts);
      },
    });
    const opened = factory.openAttempt(ctxPer(fx), 'expected');
    assert.equal(opened && opened.ok, true, 'the expected attempt is admitted');
    let chiamate = 0;
    const primo = await factory.runExpected(opened.attempt, async () => { chiamate += 1; return ack; });
    assert.equal(primo && primo.ok, false, 'the persistence failure refuses the run');
    let seconde = 0;
    const secondo = await factory.runExpected(opened.attempt, async () => { seconde += 1; return ack; });
    factory.closeAttempt(opened.attempt);
    assert.equal(secondo && secondo.code, 'CLI_USED', 'a failed persistence does not reopen the run');
    assert.equal(chiamate + seconde, 0, 'the callback was never invoked');
    assert.deepEqual(eventiStore(fx.stateDir), [], 'no event is written');
  }
});

test('an entry refusal does not consume the expected run', async (t) => {
  const mod = caricaModuloRecovery();
  const ack = { result: null, event: { kind: 'cli-ack', reason: 'shutdown_ack' } };

  // A silent handle never runs a CLI: the refusal is the mode, twice.
  {
    const fx = creaFixture(t);
    const { factory } = creaPerCli(mod, fx);
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the silent attempt is admitted');
    let chiamate = 0;
    const primo = await factory.runExpected(opened.attempt, async () => { chiamate += 1; return ack; });
    const secondo = await factory.runExpected(opened.attempt, async () => { chiamate += 1; return ack; });
    factory.closeAttempt(opened.attempt);
    assert.equal(primo && primo.code, 'MODE', 'the mode refuses the run');
    assert.equal(secondo && secondo.code, 'MODE', 'the mode still refuses it: the refusal did not consume');
    assert.equal(chiamate, 0, 'no CLI on a silent handle');
  }

  // A lost fence at the entry refuses without consuming: once the fence is back
  // the same handle runs.
  {
    const fx = creaFixture(t);
    let fenceOk = true;
    const { factory } = creaPerCli(mod, fx);
    const opened = factory.openAttempt({ ...ctxPer(fx), fenceCheck: () => fenceOk }, 'expected');
    assert.equal(opened && opened.ok, true, 'the expected attempt is admitted while the fence is valid');
    fenceOk = false;
    const primo = await factory.runExpected(opened.attempt, async () => ack);
    assert.equal(primo && primo.code, 'FENCE', 'the entry fence refuses the run');
    fenceOk = true;
    let chiamate = 0;
    const secondo = await factory.runExpected(opened.attempt, async () => { chiamate += 1; return ack; });
    factory.closeAttempt(opened.attempt);
    assert.equal(secondo && secondo.ok, true, `the run is still available (code=${secondo && secondo.code})`);
    assert.equal(chiamate, 1, 'the callback is invoked once');
  }

  // The pre-CLI reserve refuses without consuming: the same handle answers the
  // same budget refusal, never CLI_USED.
  {
    const fx = creaFixture(t);
    const { factory } = creaPerCli(mod, fx);
    const deadline = 60599;
    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: deadline,
      phasePlan: piano(8000, deadline),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'expected');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted below the reserve');
    let chiamate = 0;
    const primo = await factory.runExpected(opened.attempt, async () => { chiamate += 1; return ack; });
    const secondo = await factory.runExpected(opened.attempt, async () => { chiamate += 1; return ack; });
    factory.closeAttempt(opened.attempt);
    assert.equal(primo && primo.code, 'BUDGET', 'the reserve refuses the run');
    assert.equal(secondo && secondo.code, 'BUDGET', 'the reserve still refuses it: the refusal did not consume');
    assert.equal(chiamate, 0, 'no CLI without the reserve');
    assert.deepEqual(eventiStore(fx.stateDir), [], 'no event is written');
  }

  // An unknown handle is refused by name.
  {
    const fx = creaFixture(t);
    const { factory } = creaPerCli(mod, fx);
    let chiamate = 0;
    const out = await factory.runExpected({}, async () => { chiamate += 1; return ack; });
    assert.equal(out && out.code, 'HANDLE', 'an unknown handle is refused');
    assert.equal(chiamate, 0, 'no CLI on an unknown handle');
  }
});

test('a clock that moves backwards in the final window is refused before the signal', async (t) => {
  const mod = caricaModuloRecovery();

  // The intent is published at 60000; the fresh snapshot that follows it reads
  // a clock behind the last accepted value. The window must close before the
  // syscall, not after it.
  {
    const fx = creaFixture(t);
    let arretrato = false;
    const { factory, killCalls } = creaPerCli(mod, fx, {
      publishExclusive: (opts) => {
        let kind = null;
        try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
        const esito = PUB_EXCL(opts);
        if (kind === 'intent-term') arretrato = true;
        return esito;
      },
      monoNow: () => (arretrato ? 59999 : 60000),
    });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted at 60000');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stop-failed', 'the backwards clock is a failure');
    assert.equal(out.code, 'BUDGET', 'the refusal names the clock');
    assert.deepEqual(killCalls, [], 'no signal after the clock went backwards');
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['intent-term'], 'only the durable intent is written');
  }

  // Positive control: a clock that stands still, or only moves forward, leaves
  // the window intact and a single TERM follows.
  {
    const fx = creaFixture(t);
    let alive = true;
    const { factory, killCalls } = creaPerCli(mod, fx, {
      monoNow: () => 60000,
      osservaKernel: (pid, instanceId) => (alive
        ? { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } }
        : { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
      probeRoot: async () => ({
        r: { ok: true },
        stato: { ok: true, state: alive ? 'lock' : 'none', declared_pid: null, pid_number_in_use: null },
      }),
      onKill: (_pid, sig) => { if (sig === 'SIGTERM') alive = false; },
    });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stopped-attested', 'a still clock keeps the window');
    assert.equal(out.method, 'term', 'the method is the signal');
    assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], 'exactly one TERM');
  }
});

// ---------------------------------------------------------------------------
// The marker of the TERM window
// ---------------------------------------------------------------------------

function creaConMarcatore(mod, fx, extra = {}) {
  const reg = doppioSegnale();
  let vivo = extra.vivo !== false;
  const factory = mod.createHostRecovery({
    fsRecovery: extra.fsRecovery || fs,
    publishExclusive: extra.publishExclusive || PUB_EXCL,
    killProcess: (pid, sig) => {
      reg.chiamate.push({ pid, sig });
      if (sig === 'SIGTERM') {
        if (extra.onKill) extra.onKill(pid, sig);
        else vivo = false;
      }
    },
    attesaImpl: async () => {},
    osservaKernel: extra.osservaKernel || ((pid, instanceId) => (vivo
      ? { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } }
      : { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } })),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: extra.monoNow || (() => 60000),
    probeRoot: extra.probeRoot || (async () => ({
      r: { ok: true },
      stato: { ok: true, state: vivo ? 'lock' : 'none', declared_pid: null, pid_number_in_use: null },
    })),
  });
  return { factory, reg };
}

function nomiTemporanei(stateDir) {
  const dir = path.join(stateDir, 'recovery-events');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^\.tmp-[a-f0-9]{32}$/.test(n)).sort();
}

test('a marker that cannot be created stops the window with no signal', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  let guasto = false;
  const impl = {
    ...fs,
    openSync(p, ...rest) {
      const abs = path.resolve(String(p));
      if (!guasto && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs)
        && (Number(rest[0]) & fs.constants.O_CREAT)
        && fs.existsSync(path.join(dir, '00000001-intent-term.json'))) {
        guasto = true;
        throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      }
      return fs.openSync(p, ...rest);
    },
  };
  const { factory, reg } = creaConMarcatore(mod, fx, { fsRecovery: impl });
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }
  assert.equal(out.outcome, 'host-stop-failed', 'the missing marker is a failure');
  assert.equal(out.code, 'STORE', 'the refusal names the store');
  assert.deepEqual(reg.chiamate, [], 'no signal without the marker');
  assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['intent-term'], 'only the intent is written');
  assert.equal(nomiTemporanei(fx.stateDir).length, 0, 'no marker is left when creation failed');
});

test('a marker whose sync fails stops the window and stays on disk', async (t) => {
  const mod = caricaModuloRecovery();
  for (const dove of ['file', 'directory']) {
    const fx = creaFixture(t);
    const dir = path.join(fx.stateDir, 'recovery-events');
    const percorsi = new Map();
    let fdMarcatore = null;
    let guasto = false;
    const impl = {
      ...fs,
      openSync(p, ...rest) {
        const abs = path.resolve(String(p));
        const fd = fs.openSync(p, ...rest);
        percorsi.set(fd, abs);
        if (!fdMarcatore && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs)
          && fs.existsSync(path.join(dir, '00000001-intent-term.json'))) {
          fdMarcatore = fd;
        }
        return fd;
      },
      closeSync(fd) { percorsi.delete(fd); const r = fs.closeSync(fd); if (fd === fdMarcatore) fdMarcatore = null; return r; },
      fsyncSync(fd) {
        const p = percorsi.get(fd) || '';
        if (dove === 'file' && fd === fdMarcatore && !guasto) {
          guasto = true;
          throw Object.assign(new Error('EIO on the marker file'), { code: 'EIO' });
        }
        if (dove === 'directory' && guasto && p === dir) {
          guasto = false;
          throw Object.assign(new Error('EIO on the marker directory'), { code: 'EIO' });
        }
        const esito = fs.fsyncSync(fd);
        if (dove === 'directory' && fd === fdMarcatore) guasto = true;
        return esito;
      },
    };
    const { factory, reg } = creaConMarcatore(mod, fx, { fsRecovery: impl });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, `${dove}: the attempt is admitted`);
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.code, 'STORE', `${dove}: the failed sync is a store failure`);
    assert.deepEqual(reg.chiamate, [], `${dove}: no signal`);
    assert.equal(nomiTemporanei(fx.stateDir).length, 1, `${dove}: the created marker stays on disk`);
  }
});

test('a post-event that cannot be persisted after the TERM leaves one signal and an uncertain store', async (t) => {
  const mod = caricaModuloRecovery();
  const casi = ['preflight', 'enospc', 'write', 'file-sync', 'publish', 'directory-sync'];
  for (const caso of casi) {
    const fx = creaFixture(t);
    const dir = path.join(fx.stateDir, 'recovery-events');
    let armato = false;
    let dopoPubblicazione = false;
    const percorsi = new Map();
    const impl = {
      ...fs,
      openSync(p, ...rest) {
        const abs = path.resolve(String(p));
        if (caso === 'enospc' && armato && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && (Number(rest[0]) & fs.constants.O_CREAT)) {
          armato = false;
          throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
        }
        const fd = fs.openSync(p, ...rest);
        percorsi.set(fd, abs);
        return fd;
      },
      closeSync(fd) { percorsi.delete(fd); return fs.closeSync(fd); },
      writeSync(fd, ...rest) {
        if (caso === 'write' && armato && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(percorsi.get(fd) || '')) {
          armato = false;
          throw Object.assign(new Error('EIO on the write'), { code: 'EIO' });
        }
        return fs.writeSync(fd, ...rest);
      },
      fsyncSync(fd) {
        const p = percorsi.get(fd) || '';
        if (caso === 'file-sync' && armato && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(p)) {
          armato = false;
          throw Object.assign(new Error('EIO on the file sync'), { code: 'EIO' });
        }
        if (caso === 'directory-sync' && armato && dopoPubblicazione && p === dir) {
          armato = false;
          dopoPubblicazione = false;
          throw Object.assign(new Error('EIO on the directory sync'), { code: 'EIO' });
        }
        return fs.fsyncSync(fd);
      },
    };
    const publishExclusive = (opts) => {
      let kind = null;
      try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
      if (caso === 'publish' && armato && kind === 'signaled-term') {
        armato = false;
        return { status: 'failed-before-create', via: 'exclusive', code: 'EIO', created: false };
      }
      const esito = PUB_EXCL(opts);
      if (caso === 'directory-sync' && armato && kind === 'signaled-term') dopoPubblicazione = true;
      return esito;
    };
    const ctx = caso === 'preflight'
      ? { ...ctxPer(fx), fenceCheck: () => !armato }
      : ctxPer(fx);
    const { factory, reg } = creaConMarcatore(mod, fx, {
      fsRecovery: impl,
      publishExclusive,
      onKill: () => { armato = true; },
    });
    const opened = factory.openAttempt(ctx, 'silent');
    assert.equal(opened && opened.ok, true, `${caso}: the attempt is admitted`);
    const out = await factory.recover(opened.attempt, 'silent');
    assert.deepEqual(reg.chiamate, [{ pid: HOST_PID, sig: 'SIGTERM' }], `${caso}: exactly one TERM`);

    const nomi = fs.readdirSync(dir).sort();
    const secondo = await factory.recover(opened.attempt, 'silent');
    assert.equal(secondo.code, 'STORE', `${caso}: the spent handle does not act again`);
    assert.deepEqual(fs.readdirSync(dir).sort(), nomi, `${caso}: the spent handle writes nothing`);
    factory.closeAttempt(opened.attempt);

    const nuovo = mod.createHostRecovery({ fsRecovery: fs, monoNow: () => 60000 });
    assert.equal(
      nuovo.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
      'uncertain',
      `${caso}: a new reader sees the store as uncertain (code=${out.code})`,
    );
    const ammesso = nuovo.openAttempt(ctxPer(fx), 'silent');
    assert.equal(ammesso && ammesso.ok, false, `${caso}: a new handle does not proceed`);
    assert.equal(ammesso && ammesso.code, 'TRACE_UNCERTAIN', `${caso}: the refusal names the uncertainty`);
  }
});

test('the successful window creates and removes its marker in the pinned order', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.resolve(path.join(fx.stateDir, 'recovery-events'));
  const ordine = [];
  const percorsi = new Map();
  let fdMarcatore = null;
  let nomeMarcatore = null;
  let foto = 0;
  const impl = {
    ...fs,
    openSync(p, ...rest) {
      const abs = path.resolve(String(p));
      const fd = fs.openSync(p, ...rest);
      percorsi.set(fd, abs);
      if (!nomeMarcatore && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && fs.existsSync(path.join(dir, '00000001-intent-term.json'))) {
        fdMarcatore = fd;
        nomeMarcatore = path.basename(abs);
        ordine.push('marker:creato');
      }
      return fd;
    },
    closeSync(fd) { percorsi.delete(fd); const r = fs.closeSync(fd); if (fd === fdMarcatore) fdMarcatore = null; return r; },
    fsyncSync(fd) {
      const p = percorsi.get(fd) || '';
      if (fd === fdMarcatore) ordine.push('marker:sync-file');
      else if (p === dir && ordine.includes('marker:creato') && !ordine.includes('marker:sync-dir') && !ordine.includes('marker:rimosso')) ordine.push('marker:sync-dir');
      return fs.fsyncSync(fd);
    },
    unlinkSync(p) {
      if (nomeMarcatore && path.basename(String(p)) === nomeMarcatore && ordine.includes('marker:sync-dir')) ordine.push('marker:rimosso');
      return fs.unlinkSync(p);
    },
  };
  const { factory, reg } = creaConMarcatore(mod, fx, {
    fsRecovery: impl,
    osservaKernel: (pid, instanceId) => {
      foto += 1;
      ordine.push(`foto:${foto}`);
      return foto >= 3
        ? { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }
        : { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } };
    },
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
    onKill: () => { ordine.push('syscall'); },
  });
  const ctx = { ...ctxPer(fx), fenceCheck: () => { ordine.push('fence'); return true; } };
  const opened = factory.openAttempt(ctx, 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }
  assert.equal(out.outcome, 'host-stopped-attested', 'the stop is attested');
  assert.deepEqual(reg.chiamate, [{ pid: HOST_PID, sig: 'SIGTERM' }], 'exactly one TERM');
  const iCreato = ordine.indexOf('marker:creato');
  const iSyncDir = ordine.indexOf('marker:sync-dir');
  const iFoto = ordine.findIndex((v) => v === 'foto:2');
  const iFence = ordine.indexOf('fence', iFoto);
  const iSys = ordine.indexOf('syscall');
  const iRim = ordine.indexOf('marker:rimosso');
  assert.ok(iCreato >= 0 && iSyncDir > iCreato, 'the marker is created, then synced');
  assert.ok(iSyncDir < iFoto, 'the marker is durable before the last snapshot');
  assert.ok(iFoto < iFence && iFence < iSys, 'snapshot, fence, syscall, in that order');
  assert.ok(iSys < iRim, 'the marker is removed only after the syscall and its durable event');
  assert.equal(nomiTemporanei(fx.stateDir).length, 0, 'no temporary is left at the end');
});

test('a marker that cannot be removed spends the handle and keeps the uncertainty', async (t) => {
  const mod = caricaModuloRecovery();
  {
    const fx = creaFixture(t);
    let fdMarcatore = null;
    let nomeMarcatore = null;
    const percorsi = new Map();
    let dopoPubblicazione = false;
    const impl = {
      ...fs,
      openSync(p, ...rest) {
        const abs = path.resolve(String(p));
        const fd = fs.openSync(p, ...rest);
        percorsi.set(fd, abs);
        if (!nomeMarcatore && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && fs.existsSync(path.join(fx.stateDir, 'recovery-events', '00000001-intent-term.json'))) {
          fdMarcatore = fd;
          nomeMarcatore = path.basename(abs);
        }
        return fd;
      },
      closeSync(fd) { percorsi.delete(fd); const r = fs.closeSync(fd); if (fd === fdMarcatore) fdMarcatore = null; return r; },
      unlinkSync(p) {
        if (nomeMarcatore && path.basename(String(p)) === nomeMarcatore && dopoPubblicazione) {
          throw Object.assign(new Error('EIO on the unlink'), { code: 'EIO' });
        }
        return fs.unlinkSync(p);
      },
    };
    const publishExclusive = (opts) => {
      let kind = null;
      try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
      const esito = PUB_EXCL(opts);
      if (kind === 'signaled-term') dopoPubblicazione = true;
      return esito;
    };
    const { factory, reg } = creaConMarcatore(mod, fx, { fsRecovery: impl, publishExclusive });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.code, 'STORE', 'the failed unlink is a store failure');
    assert.deepEqual(reg.chiamate, [{ pid: HOST_PID, sig: 'SIGTERM' }], 'the signal was delivered once');
    assert.equal(nomiTemporanei(fx.stateDir).length, 1, 'the marker stays');
    assert.equal(
      mod.createHostRecovery({ fsRecovery: fs }).readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
      'uncertain',
      'the store reads uncertain',
    );
    const nuovo = mod.createHostRecovery({ fsRecovery: fs, monoNow: () => 60000 });
    const ammesso = nuovo.openAttempt(ctxPer(fx), 'silent');
    assert.equal(ammesso && ammesso.ok, false, 'a new handle does not proceed on an uncertain store');
  }
  {
    // Unlink succeeds, the directory sync fails and the residual cannot be left:
    // the post-event is durable, so a new handle resumes at the barrier.
    const fx = creaFixture(t);
    const dir = path.resolve(path.join(fx.stateDir, 'recovery-events'));
    const percorsi = new Map();
    let fdMarcatore = null;
    let nomeMarcatore = null;
    let rimossoMarcatore = false;
    let guasto = false;
    const impl = {
      ...fs,
      openSync(p, ...rest) {
        const abs = path.resolve(String(p));
        if (guasto && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && (Number(rest[0]) & fs.constants.O_CREAT)) {
          throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
        }
        const fd = fs.openSync(p, ...rest);
        percorsi.set(fd, abs);
        if (!nomeMarcatore && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && fs.existsSync(path.join(dir, '00000001-intent-term.json'))) {
          fdMarcatore = fd;
          nomeMarcatore = path.basename(abs);
        }
        return fd;
      },
      closeSync(fd) { percorsi.delete(fd); const r = fs.closeSync(fd); if (fd === fdMarcatore) fdMarcatore = null; return r; },
      unlinkSync(p) {
        const esito = fs.unlinkSync(p);
        if (nomeMarcatore && path.basename(String(p)) === nomeMarcatore) rimossoMarcatore = true;
        return esito;
      },
      fsyncSync(fd) {
        const p = percorsi.get(fd) || '';
        if (rimossoMarcatore && !guasto && p === dir) {
          guasto = true;
          throw Object.assign(new Error('EIO after the marker removal'), { code: 'EIO' });
        }
        return fs.fsyncSync(fd);
      },
    };
    const { factory, reg } = creaConMarcatore(mod, fx, { fsRecovery: impl });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.code, 'STORE', 'the cleanup failure is a store failure');
    assert.deepEqual(reg.chiamate, [{ pid: HOST_PID, sig: 'SIGTERM' }], 'one TERM');
    const nuovo = creaConMarcatore(mod, fx, { fsRecovery: fs, vivo: false, onKill: () => {} });
    const ammesso = nuovo.factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(ammesso && ammesso.ok, true, `without the residual the store reads clear and admits (code=${ammesso && ammesso.code})`);
    let ripresa;
    try {
      ripresa = await nuovo.factory.recover(ammesso.attempt, 'silent');
    } finally {
      nuovo.factory.closeAttempt(ammesso.attempt);
    }
    assert.equal(ripresa.outcome, 'host-stopped-attested', 'the proved absence closes the history');
    assert.equal(ripresa.method, 'term', 'the method is the signaled already recorded');
    assert.deepEqual(nuovo.reg.chiamate, [], 'the durable signaled prevents a second TERM');
    const dopoResume = eventiStore(fx.stateDir).map((e) => e.kind);
    assert.deepEqual(dopoResume.slice(0, 2), ['intent-term', 'signaled-term'], 'the durable events are not rewritten');
    assert.equal(dopoResume.filter((k) => k === 'signaled-term').length, 1, 'no second signal is recorded');
    assert.equal(fs.readdirSync(dir).filter((n) => /^\.tmp-/.test(n)).length, 0, 'no temporary is left');
  }
});

test('a foreign temporary or a replaced marker is never ignored and never removed', async (t) => {
  const mod = caricaModuloRecovery();
  {
    const fx = creaFixture(t);
    const dir = path.join(fx.stateDir, 'recovery-events');
    const estraneo = path.join(dir, `.tmp-${'ab'.repeat(16)}`);
    const publishExclusive = (opts) => {
      let kind = null;
      try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
      const esito = PUB_EXCL(opts);
      if (kind === 'intent-term') fs.writeFileSync(estraneo, '', { mode: 0o600 });
      return esito;
    };
    const { factory, reg } = creaConMarcatore(mod, fx, { publishExclusive });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.code, 'STORE', 'the foreign temporary stops the window');
    assert.deepEqual(reg.chiamate, [], 'no signal with a foreign temporary');
    assert.ok(fs.existsSync(estraneo), 'the foreign object is never removed');
  }
  {
    const fx = creaFixture(t);
    const dir = path.join(fx.stateDir, 'recovery-events');
    let nomeMarcatore = null;
    let fdMarcatore = null;
    let sostituito = false;
    const impl = {
      ...fs,
      openSync(p, ...rest) {
        const abs = path.resolve(String(p));
        const fd = fs.openSync(p, ...rest);
        if (!nomeMarcatore && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && fs.existsSync(path.join(dir, '00000001-intent-term.json'))) {
          fdMarcatore = fd;
          nomeMarcatore = path.basename(abs);
        }
        return fd;
      },
      closeSync(fd) { const r = fs.closeSync(fd); if (fd === fdMarcatore) fdMarcatore = null; return r; },
    };
    const osservaKernel = (pid, instanceId) => {
      if (nomeMarcatore && !sostituito) {
        sostituito = true;
        const altro = path.join(dir, `.altro-${'ef'.repeat(16)}`);
        fs.writeFileSync(altro, '', { mode: 0o600 });
        fs.renameSync(altro, path.join(dir, nomeMarcatore));
      }
      return { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } };
    };
    const { factory, reg } = creaConMarcatore(mod, fx, { fsRecovery: impl, osservaKernel });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.code, 'TRACE_UNCERTAIN', 'the replaced marker stops the post-event');
    assert.deepEqual(reg.chiamate, [{ pid: HOST_PID, sig: 'SIGTERM' }], 'the signal was already delivered');
    assert.ok(fs.existsSync(path.join(dir, nomeMarcatore)), 'the replaced object is never removed');
  }
});

test('the marker fits the places of the store and its peak never passes the cap', async (t) => {
  const mod = caricaModuloRecovery();
  {
    const fx = creaFixture(t);
    seedStoria(fx.stateDir, fx.record, 56);
    const dir = path.join(fx.stateDir, 'recovery-events');
    let massimo = 56;
    const publishExclusive = (opts) => {
      const esito = PUB_EXCL(opts);
      massimo = Math.max(massimo, fs.readdirSync(dir).length);
      return esito;
    };
    const { factory, reg } = creaConMarcatore(mod, fx, {
      publishExclusive,
      vivo: true,
      onKill: () => {},
    });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'admitted at the boundary');
    const digest = computeContextDigest(fx.record);
    const gruppo = (attemptId, seq, kind, extra = {}) => seedEvent(fx.stateDir, {
      launchId: fx.record.launchId, attemptId, seq, kind, contextDigest: digest, ...extra,
    });
    const A = hexId(16);
    const B = hexId(16);
    gruppo(A, 57, 'cli-attempt');
    gruppo(A, 58, 'cli-ack', { reason: 'shutdown_ack' });
    gruppo(B, 59, 'cli-attempt');
    gruppo(B, 60, 'cli-ack', { reason: 'shutdown_ack' });
    assert.equal(fs.readdirSync(dir).length, 60, 'sixty entries before the window');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stop-failed', `a still alive host ends in failure (code=${out.code})`);
    assert.deepEqual(reg.chiamate, [{ pid: HOST_PID, sig: 'SIGTERM' }], `one TERM (code=${out.code})`);
    assert.equal(massimo, 64, `the peak of the namespace during the window is the cap (measured ${massimo})`);
    assert.equal(nomiTemporanei(fx.stateDir).length, 0, 'the marker is removed');
  }
  {
    const fx = creaFixture(t);
    seedStoria(fx.stateDir, fx.record, 56);
    const dir = path.join(fx.stateDir, 'recovery-events');
    const { factory, reg } = creaConMarcatore(mod, fx, { vivo: true, onKill: () => {} });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'admitted at the boundary');
    const digest = computeContextDigest(fx.record);
    for (let i = 0; i < 3; i += 1) {
      const id = hexId(16);
      seedEvent(fx.stateDir, { launchId: fx.record.launchId, attemptId: id, seq: 57 + i * 2, kind: 'cli-attempt', contextDigest: digest });
      seedEvent(fx.stateDir, { launchId: fx.record.launchId, attemptId: id, seq: 58 + i * 2, kind: 'cli-ack', contextDigest: digest, reason: 'shutdown_ack' });
    }
    assert.equal(fs.readdirSync(dir).length, 62, 'sixty-two entries: three places are missing');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.code, 'STORE_CAPACITY', 'the marker refuses without its three places');
    assert.deepEqual(reg.chiamate, [], 'no signal without the places');
    assert.equal(nomiTemporanei(fx.stateDir).length, 0, 'no marker is created');
  }
});

test('a marker found at the start is a residue: the store stays uncertain and the file stays', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const dir = path.join(fx.stateDir, 'recovery-events');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const seme = path.join(dir, `.tmp-${'cd'.repeat(16)}`);
  fs.writeFileSync(seme, '', { mode: 0o600 });
  const factory = mod.createHostRecovery({ fsRecovery: fs, monoNow: () => 60000 });
  assert.equal(factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state, 'uncertain', 'a marker is a residue');
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, false, 'no entry proceeds');
  assert.equal(opened && opened.code, 'TRACE_UNCERTAIN', 'the refusal names the uncertainty');
  assert.ok(fs.existsSync(seme), 'the foreign marker is never removed');
});

// ---------------------------------------------------------------------------
// Possession and revocation of the marker
// ---------------------------------------------------------------------------

// A window abandoned before the syscall leaves the marker, spends the handle and
// gives no other operation of that handle a way to write. The exclusion belongs
// to the post-event of the window that created the marker and to nothing else.
test('every refusal of the window that precedes the syscall leaves the marker and spends the handle', async (t) => {
  const mod = caricaModuloRecovery();
  const casi = ['fence', 'clock', 'reserve', 'snapshot-uncertain', 'snapshot-exited', 'foreign-temporary'];
  for (const caso of casi) {
    const fx = creaFixture(t);
    const dir = path.join(fx.stateDir, 'recovery-events');
    const reg = doppioSegnale();
    const oss = { foto: 0, sonde: 0 };
    const vivo = () => ({ state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: OWNER } });
    let fence = true;
    let mono = () => 60000;
    let osservaKernel = () => vivo();
    let publishExclusive = PUB_EXCL;
    if (caso === 'fence') {
      publishExclusive = (opts) => {
        let kind = null;
        try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
        const esito = PUB_EXCL(opts);
        if (kind === 'intent-term') fence = false;
        return esito;
      };
    } else if (caso === 'clock') {
      publishExclusive = (opts) => {
        let kind = null;
        try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
        const esito = PUB_EXCL(opts);
        if (kind === 'intent-term') mono = () => 59999;
        return esito;
      };
    } else if (caso === 'reserve') {
      publishExclusive = (opts) => {
        let kind = null;
        try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
        const esito = PUB_EXCL(opts);
        if (kind === 'intent-term') mono = () => 67501;
        return esito;
      };
    } else if (caso === 'snapshot-uncertain') {
      osservaKernel = () => {
        oss.foto += 1;
        return oss.foto >= 2 ? { state: 'unverifiable' } : vivo();
      };
    } else if (caso === 'snapshot-exited') {
      osservaKernel = () => {
        oss.foto += 1;
        return oss.foto >= 2
          ? { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }
          : vivo();
      };
    } else if (caso === 'foreign-temporary') {
      const estraneo = path.join(dir, `.tmp-${'ab'.repeat(16)}`);
      publishExclusive = (opts) => {
        let kind = null;
        try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
        const esito = PUB_EXCL(opts);
        if (kind === 'intent-term') fs.writeFileSync(estraneo, '', { mode: 0o600 });
        return esito;
      };
    }
    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive,
      killProcess: reg.killProcess,
      attesaImpl: async () => {},
      osservaKernel: (...a) => osservaKernel(...a),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => mono(),
      probeRoot: async () => {
        oss.sonde += 1;
        return { r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } };
      },
    });
    const ctx = { ...ctxPer(fx), fenceCheck: () => fence };
    const opened = factory.openAttempt(ctx, 'expected');
    assert.equal(opened && opened.ok, true, `${caso}: the attempt is admitted`);
    const out = await factory.recover(opened.attempt, 'silent');
    assert.equal(out.outcome, 'host-stop-failed', `${caso}: the abandoned window is a failure`);
    assert.deepEqual(reg.chiamate, [], `${caso}: no signal without completing the window`);
    assert.equal(oss.sonde, 0, `${caso}: no probe`);
    assert.equal(
      nomiTemporanei(fx.stateDir).length,
      caso === 'foreign-temporary' ? 2 : 1,
      `${caso}: the marker stays on disk`,
    );
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['intent-term'], `${caso}: only the intent is written`);

    // The handle is spent: the expected run cannot slide past its own residue.
    fence = true;
    let chiamate = 0;
    const run = await factory.runExpected(opened.attempt, async () => {
      chiamate += 1;
      return { event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
    });
    assert.equal(run && run.ok, false, `${caso}: the expected run is refused`);
    assert.equal(run && run.code, 'STORE', `${caso}: the refusal names the store`);
    assert.equal(chiamate, 0, `${caso}: the callback is never invoked`);
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['intent-term'], `${caso}: no cli-attempt is written`);

    const secondo = await factory.recover(opened.attempt, 'silent');
    assert.equal(secondo.code, 'STORE', `${caso}: the second recover is refused`);
    assert.deepEqual(reg.chiamate, [], `${caso}: still zero signals`);
    assert.equal(
      factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
      'uncertain',
      `${caso}: the public reader sees the residue`,
    );
    const nuovo = mod.createHostRecovery({ fsRecovery: fs, monoNow: () => 60000 });
    const ammesso = nuovo.openAttempt(ctxPer(fx), 'silent');
    assert.equal(ammesso && ammesso.ok, false, `${caso}: a new handle does not proceed`);
    assert.equal(ammesso && ammesso.code, 'TRACE_UNCERTAIN', `${caso}: the refusal names the uncertainty`);
    factory.closeAttempt(opened.attempt);
  }
});

// A regression in its own right: an expected handle enters a
// recover, loses the fence at the last snapshot, keeps the marker, and then
// tries to use the same handle for its one expected run.
test('an expected handle that abandoned its window cannot start a CLI through its own exclusion', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const reg = doppioSegnale();
  let fence = true;
  const publishExclusive = (opts) => {
    let kind = null;
    try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
    const esito = PUB_EXCL(opts);
    if (kind === 'intent-term') fence = false;
    return esito;
  };
  const factory = mod.createHostRecovery({
    fsRecovery: fs,
    publishExclusive,
    killProcess: reg.killProcess,
    attesaImpl: async () => {},
    osservaKernel: () => ({ state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity } }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 60000,
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
  });
  const ctx = { ...ctxPer(fx), fenceCheck: () => fence };
  const opened = factory.openAttempt(ctx, 'expected');
  assert.equal(opened && opened.ok, true, 'the expected attempt is admitted');
  const out = await factory.recover(opened.attempt, 'silent');
  assert.equal(out.outcome, 'host-stop-failed', 'the lost fence is a failure');
  assert.equal(out.code, 'FENCE', 'the refusal names the fence');
  assert.deepEqual(reg.chiamate, [], 'no signal');
  assert.equal(nomiTemporanei(fx.stateDir).length, 1, 'the marker stays');

  fence = true;
  let chiamate = 0;
  const run = await factory.runExpected(opened.attempt, async () => {
    chiamate += 1;
    return { event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
  });
  assert.equal(run && run.ok, false, 'the expected run is refused');
  assert.equal(run && run.code, 'STORE', 'the refusal names the store');
  assert.equal(chiamate, 0, 'the callback is never invoked');
  assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['intent-term'], 'no cli-attempt is written');
  factory.closeAttempt(opened.attempt);
});

// The private read requires the marker it owns: presence, and the same object.
test('the private read requires the marker: absent, unreadable and replaced are all uncertain', async (t) => {
  const mod = caricaModuloRecovery();
  // The marker is removed after its directory sync and before the private read.
  {
    const fx = creaFixture(t);
    const dir = path.resolve(path.join(fx.stateDir, 'recovery-events'));
    const percorsi = new Map();
    let nomeMarcatore = null;
    let rimosso = false;
    const impl = {
      ...fs,
      openSync(p, ...rest) {
        const abs = path.resolve(String(p));
        const fd = fs.openSync(p, ...rest);
        percorsi.set(fd, abs);
        if (!nomeMarcatore && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs)
          && fs.existsSync(path.join(dir, '00000001-intent-term.json'))) {
          nomeMarcatore = path.basename(abs);
        }
        return fd;
      },
      closeSync(fd) { percorsi.delete(fd); return fs.closeSync(fd); },
      fsyncSync(fd) {
        const esito = fs.fsyncSync(fd);
        if (!rimosso && nomeMarcatore && percorsi.get(fd) === dir) {
          rimosso = true;
          fs.unlinkSync(path.join(dir, nomeMarcatore));
        }
        return esito;
      },
    };
    const { factory, reg } = creaConMarcatore(mod, fx, { fsRecovery: impl });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    const out = await factory.recover(opened.attempt, 'silent');
    assert.equal(out.outcome, 'host-stop-failed', 'the vanished marker stops the window');
    assert.equal(out.code, 'STORE', 'the refusal names the store');
    assert.deepEqual(reg.chiamate, [], 'no signal without the marker it owns');
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['intent-term'], 'only the intent is written');
    const secondo = await factory.recover(opened.attempt, 'silent');
    assert.equal(secondo.code, 'STORE', 'the handle is spent');
    factory.closeAttempt(opened.attempt);
  }
  // The lstat of the marker fails at the same point.
  {
    const fx = creaFixture(t);
    const dir = path.resolve(path.join(fx.stateDir, 'recovery-events'));
    const percorsi = new Map();
    let nomeMarcatore = null;
    let armato = false;
    const impl = {
      ...fs,
      openSync(p, ...rest) {
        const abs = path.resolve(String(p));
        const fd = fs.openSync(p, ...rest);
        percorsi.set(fd, abs);
        if (!nomeMarcatore && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs)
          && fs.existsSync(path.join(dir, '00000001-intent-term.json'))) {
          nomeMarcatore = path.basename(abs);
        }
        return fd;
      },
      closeSync(fd) { percorsi.delete(fd); return fs.closeSync(fd); },
      lstatSync(p, ...rest) {
        if (armato && nomeMarcatore && path.basename(String(p)) === nomeMarcatore) {
          armato = false;
          throw Object.assign(new Error('EIO on the marker lstat'), { code: 'EIO' });
        }
        return fs.lstatSync(p, ...rest);
      },
      fsyncSync(fd) {
        const esito = fs.fsyncSync(fd);
        if (!armato && nomeMarcatore && percorsi.get(fd) === dir) armato = true;
        return esito;
      },
    };
    const { factory, reg } = creaConMarcatore(mod, fx, { fsRecovery: impl });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    const out = await factory.recover(opened.attempt, 'silent');
    assert.equal(out.outcome, 'host-stop-failed', 'the unreadable marker stops the window');
    assert.equal(out.code, 'STORE', 'the refusal names the store');
    assert.deepEqual(reg.chiamate, [], 'no signal with an unreadable marker');
    assert.equal(nomiTemporanei(fx.stateDir).length, 1, 'the marker is left untouched');
    factory.closeAttempt(opened.attempt);
  }
  // A different object under the same name before the private read.
  {
    const fx = creaFixture(t);
    const dir = path.resolve(path.join(fx.stateDir, 'recovery-events'));
    const percorsi = new Map();
    let nomeMarcatore = null;
    let sostituito = false;
    const impl = {
      ...fs,
      openSync(p, ...rest) {
        const abs = path.resolve(String(p));
        const fd = fs.openSync(p, ...rest);
        percorsi.set(fd, abs);
        if (!nomeMarcatore && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs)
          && fs.existsSync(path.join(dir, '00000001-intent-term.json'))) {
          nomeMarcatore = path.basename(abs);
        }
        return fd;
      },
      closeSync(fd) { percorsi.delete(fd); return fs.closeSync(fd); },
      fsyncSync(fd) {
        const esito = fs.fsyncSync(fd);
        if (!sostituito && nomeMarcatore && percorsi.get(fd) === dir) {
          sostituito = true;
          const altro = path.join(dir, `.altro-${'ef'.repeat(16)}`);
          fs.writeFileSync(altro, '', { mode: 0o600 });
          fs.renameSync(altro, path.join(dir, nomeMarcatore));
        }
        return esito;
      },
    };
    const { factory, reg } = creaConMarcatore(mod, fx, { fsRecovery: impl });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    const out = await factory.recover(opened.attempt, 'silent');
    assert.equal(out.outcome, 'host-stop-failed', 'the replaced marker stops the window');
    assert.equal(out.code, 'STORE', 'the refusal names the store');
    assert.deepEqual(reg.chiamate, [], 'no signal on a replaced marker');
    assert.ok(fs.existsSync(path.join(dir, nomeMarcatore)), 'the replacing object is never removed');
    factory.closeAttempt(opened.attempt);
  }
});

// The final snapshot that finds the original exited is the conservative stop of
// the design: the marker is on disk, so nothing is probed and nothing attested.
test('the final snapshot that finds the original exited stops without a probe and keeps the marker', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  let sonde = 0;
  let foto = 0;
  const { factory, reg } = creaConMarcatore(mod, fx, {
    osservaKernel: () => {
      foto += 1;
      return foto >= 2
        ? { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }
        : { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity } };
    },
    probeRoot: async () => {
      sonde += 1;
      return { r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } };
    },
  });
  const opened = factory.openAttempt(ctxPer(fx), 'expected');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  const out = await factory.recover(opened.attempt, 'silent');
  assert.equal(out.outcome, 'host-stop-failed', 'the exited snapshot is a failure');
  assert.equal(out.code, 'STORE', 'the refusal names the store');
  assert.deepEqual(reg.chiamate, [], 'no signal');
  assert.equal(sonde, 0, 'the barrier is never asked');
  assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['intent-term'], 'no exit and no close are written');
  assert.equal(nomiTemporanei(fx.stateDir).length, 1, 'the marker stays for a manual cleanup');
  const secondo = await factory.recover(opened.attempt, 'silent');
  assert.equal(secondo.code, 'STORE', 'the handle is spent');
  factory.closeAttempt(opened.attempt);
});

// A signal of the same context recorded while the window is being prepared is
// seen by the fresh private read: the window closes before the syscall.
test('a signal recorded while the window is prepared stops it before the syscall', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  const publishExclusive = (opts) => {
    let kind = null;
    try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
    const esito = PUB_EXCL(opts);
    if (kind === 'intent-term') {
      seedEvent(fx.stateDir, {
        launchId: fx.record.launchId,
        attemptId: hexId(16),
        seq: 2,
        kind: 'signaled-term',
        contextDigest: digest,
        method: 'term',
        reason: 'sent',
      });
    }
    return esito;
  };
  const { factory, reg } = creaConMarcatore(mod, fx, { publishExclusive });
  const opened = factory.openAttempt(ctxPer(fx), 'expected');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted on a trace without the signal');
  const out = await factory.recover(opened.attempt, 'silent');
  assert.equal(out.outcome, 'host-stop-failed', 'the fresh signal stops the window');
  assert.equal(out.code, 'ESCALATION', 'the refusal names the escalation');
  assert.deepEqual(reg.chiamate, [], 'no second signal');
  assert.equal(nomiTemporanei(fx.stateDir).length, 1, 'the marker stays');
  assert.deepEqual(
    eventiStore(fx.stateDir).map((e) => e.kind),
    ['intent-term', 'signaled-term'],
    'nothing is written by the window',
  );
  const secondo = await factory.recover(opened.attempt, 'silent');
  assert.equal(secondo.code, 'STORE', 'the handle is spent');
  factory.closeAttempt(opened.attempt);
});

// The pid of the syscall is the one guarded at admission.
test('the syscall uses the pid guarded at admission, not the caller object', async (t) => {
  const mod = caricaModuloRecovery();
  for (const mutazione of [1, -5, 4242]) {
    const fx = creaFixture(t);
    const vera = { ...fx.record.hostIdentity };
    const { factory, reg } = creaConMarcatore(mod, fx, {
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...vera, instanceId: instanceId || OWNER },
      }),
    });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, `${mutazione}: the attempt is admitted`);
    // The caller rewrites the object it passed: pid, instance and birth move.
    fx.record.hostIdentity.pid = mutazione;
    fx.record.hostIdentity.instanceId = 'ff'.repeat(16);
    fx.record.hostIdentity.startTicks = '1';
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.deepEqual(
      reg.chiamate,
      [{ pid: HOST_PID, sig: 'SIGTERM' }, { pid: HOST_PID, sig: 'SIGKILL' }],
      `${mutazione}: both signals use the admitted pid (outcome=${out && out.outcome} code=${out && out.code})`,
    );
  }
});

// The answer of the CLI is read under a guard: a throwing field is a refusal,
// never a rejected promise and never a written outcome.
test('an answer whose fields throw is a store refusal, never a rejected run', async (t) => {
  const mod = caricaModuloRecovery();
  {
    const fx = creaFixture(t);
    const { factory, reg } = creaConMarcatore(mod, fx);
    const opened = factory.openAttempt(ctxPer(fx), 'expected');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    const bugiardo = {};
    Object.defineProperty(bugiardo, 'event', {
      enumerable: true,
      get() { throw new Error('event getter'); },
    });
    let out;
    try {
      out = await factory.runExpected(opened.attempt, async () => bugiardo);
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out && out.ok, false, 'the throwing event is a refusal');
    assert.equal(out && out.code, 'STORE', 'the refusal names the store');
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['cli-attempt'], 'the attempt stays open and blocking');
    assert.deepEqual(reg.chiamate, [], 'no signal');
  }
  {
    const fx = creaFixture(t);
    const { factory, reg } = creaConMarcatore(mod, fx);
    const opened = factory.openAttempt(ctxPer(fx), 'expected');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    const bugiardo = {
      event: { kind: 'cli-ack', reason: 'shutdown_ack' },
      get result() { throw new Error('result getter'); },
    };
    let out;
    try {
      out = await factory.runExpected(opened.attempt, async () => bugiardo);
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out && out.ok, false, 'the throwing result is a refusal');
    assert.equal(out && out.code, 'STORE', 'the refusal names the store');
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['cli-attempt'], 'no CLI outcome is written');
    assert.deepEqual(reg.chiamate, [], 'no signal');
  }
});

// A store that disappears entirely while the private capability expects
// its marker is not a clean store.
test('the private read refuses a store directory that went away with the marker', async (t) => {
  const mod = caricaModuloRecovery();
  {
    const fx = creaFixture(t);
    const dir = path.resolve(path.join(fx.stateDir, 'recovery-events'));
    const spostata = path.join(fx.root, 'recovery-events');
    const percorsi = new Map();
    let nomeMarcatore = null;
    let spostato = false;
    const impl = {
      ...fs,
      openSync(p, ...rest) {
        const abs = path.resolve(String(p));
        const fd = fs.openSync(p, ...rest);
        percorsi.set(fd, abs);
        if (!nomeMarcatore && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs)
          && fs.existsSync(path.join(dir, '00000001-intent-term.json'))) {
          nomeMarcatore = path.basename(abs);
        }
        return fd;
      },
      closeSync(fd) { percorsi.delete(fd); return fs.closeSync(fd); },
      fsyncSync(fd) {
        const esito = fs.fsyncSync(fd);
        if (!spostato && nomeMarcatore && percorsi.get(fd) === dir) {
          spostato = true;
          fs.renameSync(dir, spostata);
        }
        return esito;
      },
    };
    const { factory, reg } = creaConMarcatore(mod, fx, { fsRecovery: impl });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(spostato, true, 'the whole store was moved before the private read');
    assert.equal(out.outcome, 'host-stop-failed', 'the vanishing store stops the window');
    assert.equal(out.code, 'STORE', 'the refusal names the store');
    assert.deepEqual(reg.chiamate, [], 'no signal when the marker it owns is gone');
    assert.equal(nomiTemporanei(fx.root).length, 1, 'the marker stays in the displaced store');
  }
  {
    // Control: for the public reader, which declares no marker, an absent store
    // keeps its historical answer.
    const fx = creaFixture(t);
    fs.rmSync(path.join(fx.stateDir, 'recovery-events'), { recursive: true, force: true });
    const factory = mod.createHostRecovery({ fsRecovery: fs });
    assert.equal(
      factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
      'clear',
      'the public reader on a missing store answers clear',
    );
  }
});

// The kind of the CLI answer is acquired once, inside the guard, and the
// append writes that value. The caller's object is never read again.
test('the kind of the CLI answer is read once and never again after the guard', async (t) => {
  const mod = caricaModuloRecovery();
  {
    // A getter that answers twice and throws on the third read: with a single
    // acquisition the third read never happens, so the run ends normally. It is
    // the contract of the fix, declared here and not a tolerated rejection.
    const fx = creaFixture(t);
    const { factory, reg } = creaConMarcatore(mod, fx);
    const opened = factory.openAttempt(ctxPer(fx), 'expected');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    let letture = 0;
    let chiamate = 0;
    const evento = { reason: 'shutdown_ack' };
    Object.defineProperty(evento, 'kind', {
      enumerable: true,
      get() {
        letture += 1;
        if (letture === 3) throw new Error('third kind access');
        return 'cli-ack';
      },
    });
    let out;
    try {
      out = await factory.runExpected(opened.attempt, async () => { chiamate += 1; return { event: evento }; });
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(letture, 1, 'the kind is acquired exactly once');
    assert.equal(out && out.ok, true, 'the single read never reaches the throwing third access');
    assert.equal(chiamate, 1, 'the CLI ran once');
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['cli-attempt', 'cli-ack'], 'the answer is durable');
    assert.deepEqual(reg.chiamate, [], 'no signal');
  }
  {
    // A proxy that throws on the kind read: the refusal is a code, never a
    // rejected promise, and the open attempt keeps the store blocked.
    const fx = creaFixture(t);
    const { factory, reg } = creaConMarcatore(mod, fx);
    const opened = factory.openAttempt(ctxPer(fx), 'expected');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    let chiamate = 0;
    const evento = new Proxy({ reason: 'shutdown_ack' }, {
      get(target, prop, receiver) {
        if (prop === 'kind') throw new Error('kind getter');
        return Reflect.get(target, prop, receiver);
      },
    });
    let out;
    let rigettata = null;
    try {
      out = await factory.runExpected(opened.attempt, async () => { chiamate += 1; return { event: evento }; });
    } catch (e) {
      rigettata = e && e.message;
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(rigettata, null, 'the run never rejects');
    assert.equal(out && out.code, 'STORE', 'the throwing kind is a store refusal');
    assert.equal(chiamate, 1, 'the CLI ran once');
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['cli-attempt'], 'no CLI outcome is written');
    assert.deepEqual(reg.chiamate, [], 'no signal');
  }
});

// The private capability belongs to the window, so a CLI asked while that
// window is still active cannot use it. This is the regression that separates
// the product from the mutant that widens the exclusion to every append.
test('a CLI asked during the final snapshot is refused by the private capability', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const reg = doppioSegnale();
  let factory = null;
  let handle = null;
  let foto = 0;
  let chiamate = 0;
  let cliPromise = null;
  factory = mod.createHostRecovery({
    fsRecovery: fs,
    publishExclusive: PUB_EXCL,
    killProcess: reg.killProcess,
    attesaImpl: async () => {},
    osservaKernel: (pid, instanceId) => {
      foto += 1;
      if (foto === 2) {
        // The final snapshot of the window runs while the marker is on disk:
        // the expected run of the same handle is legitimate to ask and must be
        // refused by the trace, not authorized by the private exclusion.
        cliPromise = factory.runExpected(handle, async () => {
          chiamate += 1;
          return { event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
        });
      }
      return { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } };
    },
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 60000,
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
  });
  const opened = factory.openAttempt(ctxPer(fx), 'expected');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  handle = opened.attempt;
  try {
    const out = await factory.recover(opened.attempt, 'silent');
    assert.ok(cliPromise, 'the reentrant run was started during the final snapshot');
    const cli = await cliPromise;
    assert.equal(chiamate, 0, 'a private marker cannot authorize a CLI while its window is active');
    assert.equal(cli && cli.ok, false, 'the reentrant run is refused');
    assert.equal(cli && cli.code, 'TRACE_UNCERTAIN', 'the refusal names the residue of the window');
    assert.deepEqual(
      reg.chiamate,
      [{ pid: HOST_PID, sig: 'SIGTERM' }, { pid: HOST_PID, sig: 'SIGKILL' }],
      'the term window delivers its one TERM and the kill window follows it',
    );
    assert.equal(out.outcome, 'host-stop-failed', 'a still alive original ends in failure');
  } finally {
    factory.closeAttempt(opened.attempt);
  }
});

// ---------------------------------------------------------------------------
// The kill window: store-level regressions
// ---------------------------------------------------------------------------

// A factory whose TERM is registered and ignored and whose KILL is delivered:
// the original leaves at the kill unless the caller keeps it alive or answers
// its own snapshots. The double is the only signal seam a run of this file may
// reach.
function creaKill(mod, fx, extra = {}) {
  const reg = doppioSegnale();
  let alive = true;
  const stato = () => alive;
  const osservaBase = (pid, instanceId) => (stato()
    ? { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } }
    : { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } });
  const factory = mod.createHostRecovery({
    fsRecovery: extra.fsRecovery || fs,
    publishExclusive: extra.publishExclusive || PUB_EXCL,
    killProcess: (pid, sig) => {
      reg.chiamate.push({ pid, sig });
      if (extra.onKill) extra.onKill(pid, sig);
      if (sig === 'SIGKILL' && extra.aliveSempre !== true) alive = false;
    },
    attesaImpl: extra.attesaImpl || (async () => {}),
    osservaKernel: extra.osservaKernel ? (...a) => extra.osservaKernel(...a, osservaBase) : osservaBase,
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: extra.monoNow || (() => 60000),
    probeRoot: extra.probeRoot || (async () => ({
      r: { ok: true },
      stato: { ok: true, state: stato() ? 'lock' : 'none', declared_pid: null, pid_number_in_use: null },
    })),
  });
  return { factory, reg };
}

function seedSignaledTerm(fx, reason = 'sent') {
  const digest = computeContextDigest(fx.record);
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'signaled-term', contextDigest: digest, method: 'term', reason,
  });
  return digest;
}

// 1 — an empty store, a term the original ignores, one kill, attested by kill.
test('a term the original ignores is followed by exactly one kill and the exit is attested by that method', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const { factory, reg } = creaKill(mod, fx);
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.deepEqual(reg.chiamate, [{ pid: HOST_PID, sig: 'SIGTERM' }, { pid: HOST_PID, sig: 'SIGKILL' }], 'exactly one TERM and one KILL');
  const eventi = eventiStore(fx.stateDir);
  assert.deepEqual(
    eventi.map((e) => e.kind),
    ['intent-term', 'signaled-term', 'intent-kill', 'signaled-kill', 'exited', 'closed'],
    'the durable order of the two windows',
  );
  assert.equal(eventi[1].reason, 'sent', 'the term records its delivery');
  assert.equal(eventi[3].reason, 'sent', 'the kill records its delivery');
  assert.equal(eventi[4].method, 'kill', 'the exit carries the kill method');
  assert.equal(eventi[5].method, 'kill', 'the close carries the kill method');
  assert.equal(out.outcome, 'host-stopped-attested', 'the stop is attested');
  assert.equal(out.method, 'kill', 'the method is the second signal');
  assert.equal(nomiTemporanei(fx.stateDir).length, 0, 'no temporary is left');
});

// 2 — a term already recorded: no replay, the kill window writes its own intent.
test('a recorded term with a live original opens the kill window without replaying the term', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  seedSignaledTerm(fx);
  const ordine = [];
  let epoca = 0;
  let ultimaFoto = 0;
  let ultimoClock = 0;
  let ultimoFence = 0;
  let catturato = null;
  const { factory, reg } = creaKill(mod, fx, {
    osservaKernel: (pid, instanceId, base) => { epoca += 1; ultimaFoto = epoca; ordine.push('foto'); return base(pid, instanceId); },
    monoNow: () => { epoca += 1; ultimoClock = epoca; ordine.push('clock'); return 60000; },
    onKill: (_pid, sig) => {
      if (sig === 'SIGKILL') catturato = { foto: ultimaFoto, fence: ultimoFence, clock: ultimoClock };
    },
  });
  // The fence is the context's, not the factory's: replace it on the context.
  const ctx = {
    ...ctxPer(fx),
    fenceCheck: () => { epoca += 1; ultimoFence = epoca; ordine.push('fence'); return true; },
  };
  const opened = factory.openAttempt(ctx, 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted on the recorded term');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.deepEqual(reg.chiamate, [{ pid: HOST_PID, sig: 'SIGKILL' }], 'the term is not replayed: one KILL');
  assert.equal(eventiStore(fx.stateDir).filter((e) => e.kind === 'signaled-term').length, 1, 'one term in the trace');
  assert.equal(eventiStore(fx.stateDir).filter((e) => e.kind === 'intent-kill').length, 1, 'one kill intent');
  assert.ok(catturato, 'the kill was observed');
  assert.ok(catturato.foto < catturato.fence && catturato.fence < catturato.clock, 'the fresh snapshot precedes the fence, the fence the last clock');
  assert.equal(out.outcome, 'host-stopped-attested', 'the stop is attested after the kill');
  assert.equal(out.method, 'kill', 'the method is the kill');
});

// 3 — a kill intent already durable is not written a second time.
test('a durable kill intent already in the context is not written again before the kill', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = seedSignaledTerm(fx);
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: hexId(16), seq: 2, kind: 'intent-kill', contextDigest: digest, method: 'kill',
  });
  const { factory, reg } = creaKill(mod, fx);
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.deepEqual(reg.chiamate, [{ pid: HOST_PID, sig: 'SIGKILL' }], 'one KILL, no new term');
  assert.equal(eventiStore(fx.stateDir).filter((e) => e.kind === 'intent-kill').length, 1, 'the intent is not written again');
  assert.equal(eventiStore(fx.stateDir).filter((e) => e.kind === 'signaled-kill').length, 1, 'the kill is recorded once');
  assert.equal(out.outcome, 'host-stopped-attested', 'attested after the kill');
});

// 4 — a kill already recorded with the original still alive is never escalated again.
test('a recorded kill with a live original is refused as an escalation and declares the host alive', async (t) => {
  const mod = caricaModuloRecovery();
  {
    const fx = creaFixture(t);
    const digest = computeContextDigest(fx.record);
    seedEvent(fx.stateDir, {
      launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'signaled-kill', contextDigest: digest, method: 'kill', reason: 'sent',
    });
    const { factory, reg } = creaKill(mod, fx, { aliveSempre: true });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stop-failed', 'the refusal is a failure');
    assert.equal(out.code, 'ESCALATION', 'the refusal names the escalation');
    assert.equal(out.hostAlive, true, 'a positive reading of the original is reported');
    assert.deepEqual(reg.chiamate, [], 'no third signal');
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['signaled-kill'], 'nothing is written');
  }
  {
    const fx = creaFixture(t);
    const digest = computeContextDigest(fx.record);
    seedEvent(fx.stateDir, {
      launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'signaled-kill', contextDigest: digest, method: 'kill', reason: 'sent',
    });
    const { factory, reg } = creaKill(mod, fx, { osservaKernel: () => ({ state: 'unverifiable', reason: 'io' }) });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stop-failed', 'an uncertain reading is a failure');
    assert.notEqual(out.hostAlive, true, 'an uncertain reading never declares the host alive');
    assert.deepEqual(reg.chiamate, [], 'no signal on an uncertain reading');
  }
});

// 5 — a kill already recorded and an original that is gone: attested kill, no new signal.
test('a recorded kill with the original gone is attested by the kill without a second exit', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'signaled-kill', contextDigest: digest, method: 'kill', reason: 'sent',
  });
  const { factory, reg } = creaKill(mod, fx, {
    osservaKernel: () => ({ state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
  });
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }
  assert.equal(out.outcome, 'host-stopped-attested', 'the stop is attested');
  assert.equal(out.method, 'kill', 'the method is the recorded kill');
  assert.deepEqual(reg.chiamate, [], 'no signal is added');
  const eventi = eventiStore(fx.stateDir);
  assert.equal(eventi.filter((e) => e.kind === 'exited').length, 1, 'one exit');
  assert.equal(eventi.filter((e) => e.kind === 'closed').length, 1, 'one close');
  assert.equal(eventi.find((e) => e.kind === 'exited').method, 'kill', 'the exit carries the kill');
});

// 6 — the kill marker of the second window: creation and sync failures stop it.
test('a kill marker that cannot be created or synced stops the kill window with no signal', async (t) => {
  const mod = caricaModuloRecovery();
  for (const caso of ['creazione', 'sync-file', 'sync-dir']) {
    const fx = creaFixture(t);
    seedSignaledTerm(fx);
    const dir = path.join(fx.stateDir, 'recovery-events');
    let creato = false;
    let fdMarcatore = null;
    const impl = {
      ...fs,
      openSync(p, ...rest) {
        const abs = path.resolve(String(p));
        if (caso === 'creazione' && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs)
          && (Number(rest[0]) & fs.constants.O_CREAT) && fs.existsSync(path.join(dir, '00000002-intent-kill.json'))) {
          throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
        }
        const fd = fs.openSync(p, ...rest);
        if (/\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && fs.existsSync(path.join(dir, '00000002-intent-kill.json'))) {
          fdMarcatore = fd;
          creato = true;
        }
        return fd;
      },
      closeSync(fd) { if (fd === fdMarcatore) fdMarcatore = null; return fs.closeSync(fd); },
      fsyncSync(fd) {
        if (caso === 'sync-file' && fd === fdMarcatore) throw Object.assign(new Error('io'), { code: 'EIO' });
        if (caso === 'sync-dir' && creato && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('io'), { code: 'EIO' });
        return fs.fsyncSync(fd);
      },
    };
    const { factory, reg } = creaKill(mod, fx, { fsRecovery: impl });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, `${caso}: the attempt is admitted`);
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stop-failed', `${caso}: the refusal is a failure`);
    assert.equal(out.code, 'STORE', `${caso}: the refusal names the store`);
    assert.deepEqual(reg.chiamate, [], `${caso}: no signal without the marker`);
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['signaled-term', 'intent-kill'], `${caso}: the intent precedes the marker and nothing follows`);
  }
});

// 7 — a post-event that cannot be made durable after the kill: one kill, no replay.
test('a killed original whose event cannot be made durable ends with one kill and no replay', async (t) => {
  const mod = caricaModuloRecovery();
  for (const caso of ['fence', 'open', 'write', 'fsync-file', 'publish', 'fsync-dir']) {
    const fx = creaFixture(t);
    seedSignaledTerm(fx);
    const dir = path.join(fx.stateDir, 'recovery-events');
    let armato = false;
    let fence = true;
    const impl = {
      ...fs,
      openSync(p, ...rest) {
        const abs = path.resolve(String(p));
        if (armato && caso === 'open' && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && (Number(rest[0]) & fs.constants.O_CREAT)) {
          throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
        }
        return fs.openSync(p, ...rest);
      },
      writeSync(fd, ...rest) {
        if (armato && caso === 'write') throw Object.assign(new Error('io'), { code: 'EIO' });
        return fs.writeSync(fd, ...rest);
      },
      fsyncSync(fd) {
        if (armato && caso === 'fsync-file') throw Object.assign(new Error('io'), { code: 'EIO' });
        if (armato && caso === 'fsync-dir' && fs.fstatSync(fd).isDirectory()) {
          throw Object.assign(new Error('io'), { code: 'EIO' });
        }
        return fs.fsyncSync(fd);
      },
    };
    const publishExclusive = (opts) => {
      if (armato && caso === 'publish') throw new Error('publish failed');
      return PUB_EXCL(opts);
    };
    const { factory, reg } = creaKill(mod, fx, {
      fsRecovery: impl,
      publishExclusive,
      onKill: (pid, sig) => {
        if (sig === 'SIGKILL') { armato = true; if (caso === 'fence') fence = false; }
      },
    });
    const ctx = { ...ctxPer(fx), fenceCheck: () => fence };
    const opened = factory.openAttempt(ctx, 'expected');
    assert.equal(opened && opened.ok, true, `${caso}: the attempt is admitted`);
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      // The handle is spent: nothing more may happen on it.
    }
    assert.equal(out.outcome, 'host-stop-failed', `${caso}: the window ends in failure`);
    assert.deepEqual(
      reg.chiamate.map((c) => c.sig),
      ['SIGKILL'],
      `${caso}: exactly one kill, and no term before it (the term is seeded)`,
    );
    const chiamate = [];
    const run = await factory.runExpected(opened.attempt, async () => {
      chiamate.push('cli');
      return { event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
    });
    assert.equal(run && run.ok, false, `${caso}: the spent handle cannot run`);
    assert.equal(run && run.code, 'STORE', `${caso}: the refusal names the store`);
    assert.equal(chiamate.length, 0, `${caso}: the callback is never invoked`);
    factory.closeAttempt(opened.attempt);

    const { factory: altra, reg: altro } = creaKill(mod, fx, { aliveSempre: true });
    const ammesso = altra.openAttempt(ctxPer(fx), 'silent');
    assert.equal(ammesso && ammesso.ok, false, `${caso}: a new handle does not proceed`);
    assert.deepEqual(altro.chiamate, [], `${caso}: a new handle sends no signal`);
  }
});

// 8 — the full success: the pinned order of the second window.
test('the successful kill window creates and removes its marker in the pinned order', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  seedSignaledTerm(fx);
  const dir = path.resolve(path.join(fx.stateDir, 'recovery-events'));
  const ordine = [];
  const percorsi = new Map();
  let fdMarcatore = null;
  let nomeMarcatore = null;
  let foto = 0;
  const impl = {
    ...fs,
    openSync(p, ...rest) {
      const abs = path.resolve(String(p));
      const fd = fs.openSync(p, ...rest);
      percorsi.set(fd, abs);
      if (!nomeMarcatore && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && fs.existsSync(path.join(dir, '00000002-intent-kill.json'))) {
        fdMarcatore = fd;
        nomeMarcatore = path.basename(abs);
        ordine.push('marker:creato');
      }
      return fd;
    },
    closeSync(fd) { percorsi.delete(fd); const r = fs.closeSync(fd); if (fd === fdMarcatore) fdMarcatore = null; return r; },
    fsyncSync(fd) {
      const p = percorsi.get(fd) || '';
      if (fd === fdMarcatore) ordine.push('marker:sync-file');
      else if (p === dir && ordine.includes('marker:creato') && !ordine.includes('marker:sync-dir') && !ordine.includes('marker:rimosso')) ordine.push('marker:sync-dir');
      return fs.fsyncSync(fd);
    },
    unlinkSync(p) {
      if (nomeMarcatore && path.basename(String(p)) === nomeMarcatore && ordine.includes('marker:sync-dir')) ordine.push('marker:rimosso');
      return fs.unlinkSync(p);
    },
  };
  const { factory, reg } = creaKill(mod, fx, {
    fsRecovery: impl,
    onKill: () => { ordine.push('syscall'); },
    osservaKernel: (pid, instanceId, base) => {
      foto += 1;
      ordine.push(`foto:${foto}`);
      // The kill window's snapshot is the second reading: after it the original
      // is gone, so the wait that follows attests the stop.
      if (foto >= 3) return { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } };
      return base(pid, instanceId);
    },
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
  });
  const ctx = { ...ctxPer(fx), fenceCheck: () => { ordine.push('fence'); return true; } };
  const opened = factory.openAttempt(ctx, 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }
  assert.equal(out.outcome, 'host-stopped-attested', 'the stop is attested');
  assert.deepEqual(reg.chiamate, [{ pid: HOST_PID, sig: 'SIGKILL' }], 'exactly one KILL');
  const iCreato = ordine.indexOf('marker:creato');
  const iSyncFile = ordine.indexOf('marker:sync-file');
  const iSyncDir = ordine.indexOf('marker:sync-dir');
  const iFoto = ordine.findIndex((v) => v === 'foto:2');
  const iFence = ordine.indexOf('fence', iFoto);
  const iSys = ordine.indexOf('syscall');
  const iRim = ordine.indexOf('marker:rimosso');
  assert.ok(iCreato >= 0 && iSyncFile > iCreato, 'the marker is created, then its file synced');
  assert.ok(iSyncDir > iSyncFile && iSyncDir < iFoto, 'its directory is synced before the last snapshot');
  assert.ok(iFoto < iFence && iFence < iSys, 'snapshot, fence, syscall, in that order');
  assert.ok(iSys < iRim, 'the marker is removed only after the syscall and its durable event');
  assert.equal(nomiTemporanei(fx.stateDir).length, 0, 'no temporary is left at the end');
});

// 9 — the cleanup of the kill marker: a failed unlink, and a failed sync after it.
test('a kill marker that cannot be removed stays, spends the handle and never replays the kill', async (t) => {
  const mod = caricaModuloRecovery();
  for (const caso of ['unlink', 'fsync-dopo-unlink']) {
    const fx = creaFixture(t);
    seedSignaledTerm(fx);
    const dir = path.resolve(path.join(fx.stateDir, 'recovery-events'));
    let rimosso = false;
    let fdMarcatore = null;
    let nomeMarcatore = null;
    const impl = {
      ...fs,
      openSync(p, ...rest) {
        const abs = path.resolve(String(p));
        const fd = fs.openSync(p, ...rest);
        if (!nomeMarcatore && /\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && fs.existsSync(path.join(dir, '00000002-intent-kill.json'))) {
          fdMarcatore = fd;
          nomeMarcatore = path.basename(abs);
        }
        return fd;
      },
      closeSync(fd) { if (fd === fdMarcatore) fdMarcatore = null; return fs.closeSync(fd); },
      unlinkSync(p) {
        const base = path.basename(String(p));
        if (nomeMarcatore && base === nomeMarcatore) {
          if (caso === 'unlink') throw Object.assign(new Error('io'), { code: 'EIO' });
          rimosso = true;
        }
        return fs.unlinkSync(p);
      },
      fsyncSync(fd) {
        if (caso === 'fsync-dopo-unlink' && rimosso && fs.fstatSync(fd).isDirectory()) {
          rimosso = false;
          throw Object.assign(new Error('io'), { code: 'EIO' });
        }
        return fs.fsyncSync(fd);
      },
    };
    const { factory, reg } = creaKill(mod, fx, { fsRecovery: impl, onKill: () => {} });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, `${caso}: the attempt is admitted`);
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stop-failed', `${caso}: the erratum is a failure`);
    assert.equal(out.code, 'STORE', `${caso}: the refusal names the store`);
    assert.deepEqual(reg.chiamate.map((c) => c.sig), ['SIGKILL'], `${caso}: one kill, no third signal`);
    assert.equal(eventiStore(fx.stateDir).filter((e) => e.kind === 'signaled-kill').length, 1, `${caso}: the kill event is durable`);

    // A new handle on the same store can never replay the kill.
    const { factory: altra, reg: altro } = creaKill(mod, fx, { aliveSempre: true });
    const ammesso = altra.openAttempt(ctxPer(fx), 'silent');
    if (ammesso && ammesso.ok) {
      let secondo;
      try {
        secondo = await altra.recover(ammesso.attempt, 'silent');
      } finally {
        altra.closeAttempt(ammesso.attempt);
      }
      assert.equal(secondo.outcome, 'host-stop-failed', `${caso}: the new handle cannot attest a stop`);
      assert.equal(secondo.code, 'ESCALATION', `${caso}: the new handle sees the recorded kill`)
    } else {
      assert.equal(ammesso.code, 'TRACE_UNCERTAIN', `${caso}: the residue makes the store uncertain`);
    }
    assert.deepEqual(altro.chiamate, [], `${caso}: the new handle sends no signal`);
  }
});

// 10 — a foreign temporary and a substituted object under the kill marker.
test('a foreign temporary or a replaced kill marker is never ignored and never removed', async (t) => {
  const mod = caricaModuloRecovery();
  {
    const fx = creaFixture(t);
    seedSignaledTerm(fx);
    const dir = path.join(fx.stateDir, 'recovery-events');
    const estraneo = path.join(dir, `.tmp-${'cd'.repeat(16)}`);
    const publishExclusive = (opts) => {
      let kind = null;
      try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
      const esito = PUB_EXCL(opts);
      if (kind === 'intent-kill') fs.writeFileSync(estraneo, '', { mode: 0o600 });
      return esito;
    };
    const { factory, reg } = creaKill(mod, fx, { publishExclusive, onKill: () => {} });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.code, 'STORE', 'the foreign temporary refuses the window');
    assert.deepEqual(reg.chiamate, [], 'zero signals');
    assert.equal(nomiTemporanei(fx.stateDir).length, 2, 'both the marker and the foreign temporary stay');
    assert.equal(fs.existsSync(estraneo), true, 'the foreign temporary is never removed');
  }
  {
    const fx = creaFixture(t);
    seedSignaledTerm(fx);
    const dir = path.join(fx.stateDir, 'recovery-events');
    let sostituito = false;
    let fdMarcatore = null;
    const impl = {
      ...fs,
      openSync(p, ...rest) {
        const abs = path.resolve(String(p));
        const fd = fs.openSync(p, ...rest);
        if (/\/recovery-events\/\.tmp-[a-f0-9]{32}$/.test(abs) && fs.existsSync(path.join(dir, '00000002-intent-kill.json'))) fdMarcatore = fd;
        return fd;
      },
      closeSync(fd) { if (fd === fdMarcatore) fdMarcatore = null; return fs.closeSync(fd); },
      fsyncSync(fd) {
        if (fd === fdMarcatore && !sostituito) {
          sostituito = true;
          const nome = fs.readlinkSync(`/proc/self/fd/${fd}`);
          fs.unlinkSync(nome);
          fs.writeFileSync(nome, '', { mode: 0o600 });
        }
        return fs.fsyncSync(fd);
      },
    };
    const { factory, reg } = creaKill(mod, fx, { fsRecovery: impl, onKill: () => {} });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.code, 'STORE', 'the substituted object refuses the window');
    assert.deepEqual(reg.chiamate, [], 'zero signals');
    assert.equal(nomiTemporanei(fx.stateDir).length, 1, 'the substituted object stays where it is');
  }
});

// 11 — the exclusion is circumscribed: an abandoned kill window cannot authorize a run.
test('a handle that abandons the kill window cannot start a CLI through its own exclusion', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  seedSignaledTerm(fx);
  let fence = true;
  const publishExclusive = (opts) => {
    let kind = null;
    try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
    const esito = PUB_EXCL(opts);
    if (kind === 'intent-kill') fence = false;
    return esito;
  };
  const { factory, reg } = creaKill(mod, fx, { publishExclusive, onKill: () => {} });
  const ctx = { ...ctxPer(fx), fenceCheck: () => fence };
  const opened = factory.openAttempt(ctx, 'expected');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    // The handle stays open for the reentrant run below.
  }
  assert.equal(out.code, 'FENCE', 'the abandoned window names the fence it lost');
  assert.deepEqual(reg.chiamate, [], 'no signal');
  assert.equal(nomiTemporanei(fx.stateDir).length, 1, 'the kill marker stays');

  fence = true;
  let chiamate = 0;
  const run = await factory.runExpected(opened.attempt, async () => {
    chiamate += 1;
    return { event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
  });
  assert.equal(run && run.ok, false, 'the expected run is refused');
  assert.equal(run && run.code, 'STORE', 'the refusal names the store');
  assert.equal(chiamate, 0, 'the callback is never invoked');
  assert.equal(eventiStore(fx.stateDir).filter((e) => e.kind === 'cli-attempt').length, 0, 'no cli-attempt is written');

  const secondo = await factory.recover(opened.attempt, 'silent');
  assert.equal(secondo.code, 'STORE', 'the second recover is refused');
  assert.deepEqual(reg.chiamate, [], 'still zero signals');
  factory.closeAttempt(opened.attempt);
});

// 12 — the kill window's final snapshot finds the original gone: no kill, no probe.
test('a kill window whose final snapshot finds the original exited stops without a probe', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  seedSignaledTerm(fx);
  let foto = 0;
  let sonde = 0;
  const { factory, reg } = creaKill(mod, fx, {
    osservaKernel: (pid, instanceId, base) => {
      foto += 1;
      if (foto >= 2) return { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } };
      return base(pid, instanceId);
    },
    probeRoot: async () => {
      sonde += 1;
      return { r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } };
    },
    onKill: () => {},
  });
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }
  assert.equal(out.code, 'STORE', 'the exited snapshot is a store failure');
  assert.deepEqual(reg.chiamate, [], 'no kill is sent');
  assert.equal(sonde, 0, 'no probe follows the marker');
  assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['signaled-term', 'intent-kill'], 'no exit and no close');
  assert.equal(nomiTemporanei(fx.stateDir).length, 1, 'the marker stays');
});

// 13 — the kill wait is bounded with a frozen clock, and its credit is finite.
test('the kill wait terminates on a frozen clock within the bounds of both phases', async (t) => {
  const mod = caricaModuloRecovery();
  const N = (ms) => Math.min(301, 1 + Math.ceil(Math.max(0, Math.floor(ms)) / 50));
  {
    // The full flow from an empty store: the term wait and then the kill wait,
    // both on a clock that stands still.
    const fx = creaFixture(t);
    const attese = [];
    let ucciso = false;
    const { factory, reg } = creaKill(mod, fx, {
      aliveSempre: true,
      attesaImpl: async (ms) => { attese.push({ ms, kill: ucciso }); },
      onKill: (_pid, sig) => { if (sig === 'SIGKILL') ucciso = true; },
    });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stop-failed', 'a frozen clock ends in failure');
    assert.equal(out.code, 'BUDGET', 'the refusal names the budget');
    assert.deepEqual(reg.chiamate.map((c) => c.sig), ['SIGTERM', 'SIGKILL'], 'the term and the kill, once each');
    const dopoKill = attese.filter((a) => a.kill);
    assert.ok(attese.length <= N(3500) + N(4000), `total waits ${attese.length} within N(3500)+N(4000)`);
    assert.ok(dopoKill.length >= N(4000) - 1, `the kill wait really ran (${dopoKill.length})`);
    assert.ok(dopoKill.length <= N(4000), `the kill wait ${dopoKill.length} within N(4000)`);
    for (const a of attese) {
      assert.equal(Number.isInteger(a.ms), true, `whole wait (${a.ms})`);
      assert.ok(a.ms >= 1 && a.ms <= 50, `wait between 1 and 50 (${a.ms})`);
    }
  }
  {
    const fx = creaFixture(t);
    // The earlier phases are declared consumed: the clock already carries their
    // cost, and the kill wait can only count on its own balance.
    const pianoCaso = piano(8000, 68000);
    const saldiZero = {
      ...pianoCaso,
      phases: pianoCaso.phases.map((f) => (['p1', 'p2', 'p3', 'p4'].includes(f.id) ? { ...f, allowanceMs: 0 } : f)),
    };
    let clock = 60000;
    const attese = [];
    let ucciso = false;
    const { factory, reg } = creaKill(mod, fx, {
      aliveSempre: true,
      monoNow: () => clock,
      attesaImpl: async (ms) => { attese.push({ ms, kill: ucciso }); clock += ms; },
      onKill: (_pid, sig) => { if (sig === 'SIGKILL') ucciso = true; },
    });
    const opened = factory.openAttempt({ ...ctxPer(fx), phasePlan: saldiZero }, 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted with the zero-credit plan');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stop-failed', 'the run ends in failure');
    assert.deepEqual(reg.chiamate.map((c) => c.sig), ['SIGTERM', 'SIGKILL'], 'the term and the kill, once each');
    const dopoKill = attese.filter((a) => a.kill);
    assert.ok(attese.length <= N(21 * 50) + N(1500), `waits ${attese.length} within the term and kill bounds`);
    assert.ok(dopoKill.length <= N(1500), `kill waits ${dopoKill.length} within N(1500)`);
  }
});

// 14 — the reserve of the kill window, exactly at its value and one below.
test('the kill window is admitted exactly at its reserve and refused one millisecond below with no write', async (t) => {
  const mod = caricaModuloRecovery();
  for (const [caso, residuo, attesi] of [
    ['sotto-riserva', 200 + 250 - 1, []],
    ['alla-riserva', 200 + 250, ['SIGKILL']],
  ]) {
    const fx = creaFixture(t);
    seedSignaledTerm(fx);
    const clock = 68000 - residuo;
    const { factory, reg } = creaKill(mod, fx, { monoNow: () => clock, aliveSempre: true, onKill: () => {} });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, `${caso}: the attempt is admitted`);
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.deepEqual(reg.chiamate.map((c) => c.sig), attesi, `${caso}: residuo ${residuo} contro riserva 450`);
    assert.equal(out.outcome, 'host-stop-failed', `${caso}: the outcome is a failure`);
    if (attesi.length === 0) {
      assert.equal(out.code, 'BUDGET', `${caso}: the refusal names the budget`);
      assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['signaled-term'], `${caso}: nothing new is written`);
      assert.equal(nomiTemporanei(fx.stateDir).length, 0, `${caso}: no marker is created`);
    } else {
      assert.deepEqual(
        eventiStore(fx.stateDir).map((e) => e.kind),
        ['signaled-term', 'intent-kill', 'signaled-kill'],
        `${caso}: the intent and the kill are written, nothing else`,
      );
      assert.equal(out.hostAlive, true, `${caso}: the host is declared alive by the last reading`);
    }
  }
});

// 15 — hostAlive only on the last reading, never on an uncertain one.
test('the exhausted kill wait reports the host alive only when its last reading was positive', async (t) => {
  const mod = caricaModuloRecovery();
  {
    const fx = creaFixture(t);
    seedSignaledTerm(fx);
    const { factory } = creaKill(mod, fx, { aliveSempre: true, onKill: () => {} });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.hostAlive, true, 'a last positive reading declares the host alive');
  }
  {
    const fx = creaFixture(t);
    seedSignaledTerm(fx);
    let ucciso = false;
    const { factory } = creaKill(mod, fx, {
      onKill: (_pid, sig) => { if (sig === 'SIGKILL') ucciso = true; },
      osservaKernel: (pid, instanceId, base) => (ucciso ? { state: 'unverifiable', reason: 'io' } : base(pid, instanceId)),
    });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, 'the attempt is admitted');
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(out.outcome, 'host-stop-failed', 'an uncertain wait ends in failure');
    assert.notEqual(out.hostAlive, true, 'an uncertain last reading never declares the host alive');
  }
});

// 16 — every wait of the kill phase is a whole interval in [1, 50].
test('every wait of the kill phase is a whole interval between one and fifty milliseconds', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  seedSignaledTerm(fx);
  let clock = 60000;
  const attese = [];
  const { factory } = creaKill(mod, fx, {
    aliveSempre: true,
    onKill: () => {},
    monoNow: () => clock,
    attesaImpl: async (ms) => { attese.push(ms); clock += ms; },
  });
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }
  assert.equal(out.outcome, 'host-stop-failed', 'a live original ends in failure');
  assert.ok(attese.length >= 1, 'the kill wait was entered');
  for (const ms of attese) {
    assert.equal(Number.isInteger(ms), true, `whole interval (${ms})`);
    assert.ok(ms >= 1 && ms <= 50, `interval between 1 and 50 (${ms})`);
  }
});

// 17 — a kill intent without the term that authorizes it: no signal at all.
test('a kill intent without its term is an incoherent trace and delivers no signal', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'intent-kill', contextDigest: digest, method: 'kill',
  });
  const { factory, reg } = creaKill(mod, fx, { onKill: () => {} });
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    // The handle stays open for the check that it is spent.
  }
  assert.equal(out.outcome, 'host-stop-failed', 'the refusal is a failure');
  assert.equal(out.code, 'TRACE_UNCERTAIN', 'the refusal names the trace');
  assert.deepEqual(reg.chiamate, [], 'zero signals on an incoherent trace');
  const secondo = await factory.recover(opened.attempt, 'silent');
  assert.equal(secondo.code, 'STORE', 'the handle is spent');
  assert.deepEqual(reg.chiamate, [], 'still zero signals');
  factory.closeAttempt(opened.attempt);
  assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['intent-kill'], 'nothing is written');
});

// 18 — a term whose syscall answered ESRCH, with the original visible again.
test('a term that answered ESRCH with the original alive again delivers no signal', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'signaled-term', contextDigest: digest, method: 'term', reason: 'esrch',
  });
  const { factory, reg } = creaKill(mod, fx, { onKill: () => {} });
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    // The handle stays open for the check that it is spent.
  }
  assert.equal(out.outcome, 'host-stop-failed', 'the contradiction is a failure');
  assert.equal(out.code, 'IDENTITY_UNKNOWN', 'the refusal names the identity it cannot reconcile');
  assert.deepEqual(reg.chiamate, [], 'zero signals on a contradiction');
  const secondo = await factory.recover(opened.attempt, 'silent');
  assert.equal(secondo.code, 'STORE', 'the handle is spent');
  factory.closeAttempt(opened.attempt);
  assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['signaled-term'], 'nothing is written');
});

// ---------------------------------------------------------------------------
// The escalation of a term: only a delivered signal authorizes it
// ---------------------------------------------------------------------------

// A term that failed at the kernel — the permission of the signal, an unknown
// error — is a stop of the escalation and never an authorization: the refusal
// carries the code the operational window answers after that failure, no signal
// is sent, nothing is written, and the handle is spent.
test('a term that failed at the kernel never authorizes the kill from a new handle', async (t) => {
  const mod = caricaModuloRecovery();
  for (const [reason, code] of [['eperm', 'EPERM'], ['error', 'SIGNAL']]) {
    const fx = creaFixture(t);
    const digest = computeContextDigest(fx.record);
    seedEvent(fx.stateDir, {
      launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'signaled-term', contextDigest: digest, method: 'term', reason,
    });
    const { factory, reg } = creaKill(mod, fx, { onKill: () => {} });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, `${reason}: the attempt is admitted on the durable term`);
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      // The handle stays open for the check that it is spent.
    }
    assert.equal(out.outcome, 'host-stop-failed', `${reason}: the escalation is refused`);
    assert.equal(out.code, code, `${reason}: the refusal names the failed delivery`);
    assert.deepEqual(reg.chiamate, [], `${reason}: zero signals`);
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['signaled-term'], `${reason}: nothing is written`);
    assert.equal(nomiTemporanei(fx.stateDir).length, 0, `${reason}: no marker is created`);
    const secondo = await factory.recover(opened.attempt, 'silent');
    assert.equal(secondo.code, 'STORE', `${reason}: the handle is spent`);
    assert.deepEqual(reg.chiamate, [], `${reason}: still zero signals`);
    factory.closeAttempt(opened.attempt);
  }
});

// A reason outside the closed vocabulary does not make the event readable at
// all: the store is uncertain, no handle is admitted and no signal is sent.
test('a term reason outside the closed vocabulary leaves the store unreadable and sends no signal', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const digest = computeContextDigest(fx.record);
  seedEvent(fx.stateDir, {
    launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'signaled-term', contextDigest: digest, method: 'term', reason: 'mystery',
  });
  const { factory, reg } = creaKill(mod, fx);
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, false, 'the store cannot be read');
  assert.equal(opened && opened.code, 'TRACE_UNCERTAIN', 'the refusal names the uncertainty');
  assert.deepEqual(reg.chiamate, [], 'zero signals');
  assert.deepEqual(
    fs.readdirSync(path.join(fx.stateDir, 'recovery-events')).sort(),
    ['00000001-signaled-term.json'],
    'nothing is written',
  );
});

// The control: a term whose syscall answered that the signal was delivered still
// opens the kill window from a new handle, once.
test('a delivered term still opens the kill window from a new handle', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  seedSignaledTerm(fx, 'sent');
  const { factory, reg } = creaKill(mod, fx);
  const opened = factory.openAttempt(ctxPer(fx), 'silent');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');
  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }
  assert.equal(out.outcome, 'host-stopped-attested', 'the stop is attested after the kill');
  assert.equal(out.method, 'kill', 'the method is the kill');
  assert.deepEqual(reg.chiamate, [{ pid: HOST_PID, sig: 'SIGKILL' }], 'exactly one kill, no new term');
  assert.deepEqual(
    eventiStore(fx.stateDir).map((e) => e.kind),
    ['signaled-term', 'intent-kill', 'signaled-kill', 'exited', 'closed'],
    'the kill follows the delivered term and the exit is attested by it',
  );
});

// A kill intent without its term is incoherent whatever the kernel says about
// the original: an absence, a zombie and a reused pid are not a closed stop of
// that trace, and no barrier is reached.
test('a kill intent without its term is refused for any state of the original', async (t) => {
  const mod = caricaModuloRecovery();
  for (const caso of ['assente', 'zombie', 'riuso']) {
    const fx = creaFixture(t);
    const digest = computeContextDigest(fx.record);
    seedEvent(fx.stateDir, {
      launchId: fx.record.launchId, attemptId: hexId(16), seq: 1, kind: 'intent-kill', contextDigest: digest, method: 'kill',
    });
    const osserva = (pid, instanceId) => {
      if (caso === 'assente') return { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } };
      if (caso === 'zombie') {
        return { state: 'observed', processState: 'Z', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } };
      }
      return {
        state: 'observed',
        processState: 'S',
        identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER, startTicks: '998877' },
      };
    };
    let sonde = 0;
    const { factory, reg } = creaKill(mod, fx, {
      osservaKernel: osserva,
      probeRoot: async () => {
        sonde += 1;
        return { r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } };
      },
      onKill: () => {},
    });
    const opened = factory.openAttempt(ctxPer(fx), 'silent');
    assert.equal(opened && opened.ok, true, `${caso}: the attempt is admitted on the incoherent trace`);
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      // The handle stays open for the check that it is spent.
    }
    assert.equal(out.outcome, 'host-stop-failed', `${caso}: the incoherent trace is refused`);
    assert.equal(out.code, 'TRACE_UNCERTAIN', `${caso}: the refusal names the trace`);
    assert.equal(out.method, undefined, `${caso}: no method is declared`);
    assert.deepEqual(reg.chiamate, [], `${caso}: zero signals`);
    assert.equal(sonde, 0, `${caso}: no probe is reached`);
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['intent-kill'], `${caso}: nothing is written`);
    const secondo = await factory.recover(opened.attempt, 'silent');
    assert.equal(secondo.code, 'STORE', `${caso}: the handle is spent`);
    factory.closeAttempt(opened.attempt);
  }
});

// ---------------------------------------------------------------------------
// The historical path of the expected run: no plan, no recovery consent
// ---------------------------------------------------------------------------

function ctxStorico(fx, extra = {}) {
  return {
    record: fx.record,
    stateDir: fx.stateDir,
    deadlineAt: 68000,
    phasePlan: undefined,
    allowHostRecovery: false,
    fenceCheck: extra.fenceCheck || (() => true),
  };
}

test('the historical path gives the single run the whole residual above the margin', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const { factory, killCalls } = creaPerCli(mod, fx);
  const opened = factory.openAttempt(ctxStorico(fx), 'expected');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted without a plan');

  const chiamate = [];
  let out;
  try {
    out = await factory.runExpected(opened.attempt, async (arg) => {
      chiamate.push({ arg, kinds: eventiStore(fx.stateDir).map((e) => e.kind) });
      return { event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
    });
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out && out.ok, true, 'the run answers ok');
  assert.equal(chiamate.length, 1, 'the callback is invoked exactly once');
  assert.deepEqual(chiamate[0].arg, { deadlineAt: 68000, budgetMs: 7750 }, 'the limit is the residual above the margin');
  assert.deepEqual(chiamate[0].kinds, ['cli-attempt'], 'the attempt is durable before the call');
  assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['cli-attempt', 'cli-ack'], 'the outcome follows the attempt');
  assert.deepEqual(killCalls, [], 'a run never signals');
});

test('the historical path refuses below the margin before writing anything', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const { factory } = creaPerCli(mod, fx, { monoNow: () => 67751 });
  const opened = factory.openAttempt(ctxStorico(fx), 'expected');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');

  let chiamate = 0;
  let out;
  try {
    out = await factory.runExpected(opened.attempt, async () => {
      chiamate += 1;
      return { event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
    });
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out && out.ok, false, 'the run is refused');
  assert.equal(out && out.code, 'BUDGET', 'the refusal names the budget');
  assert.equal(chiamate, 0, 'the callback is never invoked');
  assert.deepEqual(eventiStore(fx.stateDir), [], 'nothing is written');
});

test('a persistence that consumes the residual leaves the attempt open and blocking', async (t) => {
  const mod = caricaModuloRecovery();
  for (const [caso, dopo] of [['zero', 67750], ['negativo', 67751]]) {
    const fx = creaFixture(t);
    let clock = 60000;
    const publishExclusive = (opts) => {
      let kind = null;
      try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
      const esito = PUB_EXCL(opts);
      if (kind === 'cli-attempt') clock = dopo;
      return esito;
    };
    const { factory } = creaPerCli(mod, fx, { monoNow: () => clock, publishExclusive });
    const opened = factory.openAttempt(ctxStorico(fx), 'expected');
    assert.equal(opened && opened.ok, true, `${caso}: the attempt is admitted`);

    let chiamate = 0;
    let out;
    try {
      out = await factory.runExpected(opened.attempt, async () => {
        chiamate += 1;
        return { event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
      });
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(out && out.ok, false, `${caso}: the run is refused`);
    assert.equal(out && out.code, 'BUDGET', `${caso}: the refusal names the budget`);
    assert.equal(chiamate, 0, `${caso}: the callback is never invoked`);
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['cli-attempt'], `${caso}: the attempt stays durable`);
    assert.equal(
      factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
      'blocked',
      `${caso}: the trace is blocking`,
    );

    // Nothing is replayed or deleted by a new handle on the same store.
    const nuova = mod.createHostRecovery({ fsRecovery: fs, monoNow: () => 60000 });
    assert.equal(nuova.readTrace({ stateDir: fx.stateDir, record: fx.record }).state, 'blocked', `${caso}: a new reader sees the block`);
    const ammesso = nuova.openAttempt(ctxStorico(fx), 'silent');
    assert.equal(ammesso && ammesso.ok, false, `${caso}: a new handle does not proceed`);
    assert.equal(ammesso && ammesso.code, 'TRACE_BLOCKED', `${caso}: the refusal names the block`);
    assert.deepEqual(eventiStore(fx.stateDir).map((e) => e.kind), ['cli-attempt'], `${caso}: nothing was replayed`);
  }
});

test('the historical limit never passes the residual and the deadline stays the one admitted', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  let clock = 60000;
  const publishExclusive = (opts) => {
    let kind = null;
    try { kind = JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind; } catch (_) { kind = null; }
    const esito = PUB_EXCL(opts);
    if (kind === 'cli-attempt') clock = 68000 - 250 - 1;
    return esito;
  };
  const { factory } = creaPerCli(mod, fx, { monoNow: () => clock, publishExclusive });
  const opened = factory.openAttempt(ctxStorico(fx), 'expected');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted');

  const argomenti = [];
  let out;
  try {
    out = await factory.runExpected(opened.attempt, async (arg) => {
      argomenti.push(arg);
      return { event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
    });
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out && out.ok, true, 'the run answers ok with one unit left');
  assert.equal(argomenti.length, 1, 'the callback is invoked once');
  assert.equal(argomenti[0].budgetMs, 1, 'the limit is exactly the residual above the margin, with no floor');
  assert.equal(argomenti[0].deadlineAt, 68000, 'the deadline is the one admitted');
  assert.ok(argomenti[0].budgetMs <= 68000 - (68000 - 250 - 1), 'the limit never passes the real residual');
});

test('with a plan the single run keeps the limit of the phase balance', async (t) => {
  const mod = caricaModuloRecovery();
  const fx = creaFixture(t);
  const { factory } = creaPerCli(mod, fx);
  const opened = factory.openAttempt(ctxPer(fx), 'expected');
  assert.equal(opened && opened.ok, true, 'the attempt is admitted with the plan');

  const argomenti = [];
  let out;
  try {
    out = await factory.runExpected(opened.attempt, async (arg) => {
      argomenti.push(arg);
      return { event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
    });
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(out && out.ok, true, 'the run answers ok');
  assert.equal(argomenti.length, 1, 'the callback is invoked once');
  assert.deepEqual(argomenti[0], { deadlineAt: 68000, budgetMs: 1000 }, 'the planned limit is unchanged');
});
