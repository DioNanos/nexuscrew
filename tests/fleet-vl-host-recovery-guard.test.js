'use strict';

const { piano } = require('./helpers/phase-plan.js');

// Host recovery pure guards, isolation refusal, fence check, and double-/proc read tests (4.1 - 4.6).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pubblicaEsclusiva } = require('../lib/fleet/exclusive-publish.js');
const hostStop = require('../lib/fleet/vl-host-stop.js');

const MODULE_PATH = path.join(__dirname, '../lib/fleet/vl-host-recovery.js');

const OWNER = 'ab'.repeat(16);
const BOOT_ID = '12345678-1234-4234-8234-123456789abc';
const PID_NS = '4026531836';
const HOST_PID = 4242;
const COORD_PID = 99999;
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

function makeHostIdentity(overrides = {}) {
  return {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId: OWNER,
    pid: HOST_PID,
    uid: UID,
    bootId: BOOT_ID,
    pidNamespaceInode: PID_NS,
    startTicks: '1234',
    pgid: HOST_PID,
    sid: HOST_PID,
    ...overrides,
  };
}

function makeValidRecord(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-gua-'));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  const ncDir = path.join(home, '.nexuscrew');
  const vlInstances = path.join(ncDir, 'vl-instances');
  const ownerDir = path.join(vlInstances, OWNER);
  const cellId = overrides.cellId || 'CellaGua';
  const stateDir = path.join(ownerDir, cellId);
  const serverRoot = path.join(ncDir, 'vl-roots', cellId);
  const xdgState = path.join(home, '.local', 'state');
  const xdgData = path.join(home, '.local', 'share');
  const xdgConfig = path.join(home, '.config');

  for (const d of [home, ncDir, vlInstances, ownerDir, stateDir, serverRoot, xdgState, xdgData, xdgConfig]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }

  t.after(() => {
    try { fs.chmodSync(stateDir, 0o700); } catch (_) {}
    try { fs.chmodSync(root, 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const vlBin = path.join(root, 'vl');
  fs.writeFileSync(vlBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const pin = hostStop.pinBinario({ source: vlBin, home, owner: OWNER, cellId });
  assert.equal(pin.ok, true);

  const record = {
    launchId: crypto.randomBytes(8).toString('hex'),
    vlBin,
    vlBinSha256: pin.sha256,
    XDG_STATE_HOME: xdgState,
    XDG_DATA_HOME: xdgData,
    XDG_CONFIG_HOME: xdgConfig,
    HOME: home,
    uid: UID,
    serverRoot,
    ts: 1000,
    version: 2,
    hostIdentity: makeHostIdentity(overrides.hostIdentity),
    ...(overrides.recordPatch || {}),
  };
  hostStop.scriviContesto(stateDir, record);

  return { root, home, stateDir, serverRoot, bin: pin.path, record };
}

function makeStatLine(pid, { state = 'S', pgid = pid, sid = pid, startTicks = '1234' } = {}) {
  // Campi 0..22 dopo ') ': 0=state 1=ppid 2=pgid 3=sid 4..14(11)=0..100..0 15=20 16=0 17=1 18=0 19=starttime.
  return `${pid} (vl) ${state} 1 ${pgid} ${sid} 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 ${startTicks} 1024 10 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n`;
}

function createProcInterceptFs({ onTargetStatRead, targetPid = HOST_PID, coordPid = COORD_PID } = {}) {
  let targetStatCount = 0;
  let nextSyntheticFd = 900000;
  const openSynthetic = new Map();

  const resolveProcContent = (filePath) => {
    const p = String(filePath);
    if (p === `/proc/${targetPid}/stat`) {
      targetStatCount += 1;
      return Buffer.from(onTargetStatRead(targetStatCount), 'utf8');
    }
    if (p === `/proc/${targetPid}/status`) {
      return Buffer.from(`Name:\tvl\nState:\tS (sleeping)\nPid:\t${targetPid}\nUid:\t${UID}\t${UID}\t${UID}\t${UID}\n`, 'utf8');
    }
    if (p === '/proc/sys/kernel/random/boot_id') {
      return Buffer.from(`${BOOT_ID}\n`, 'utf8');
    }
    if (p === '/proc/self/stat') {
      return Buffer.from(makeStatLine(coordPid, { pgid: coordPid, sid: coordPid, startTicks: '100' }), 'utf8');
    }
    return null;
  };

  const resolveProcStat = (filePath) => {
    const p = String(filePath);
    if (p === `/proc/${targetPid}/ns/pid` || p === '/proc/self/ns/pid') {
      return {
        dev: 4,
        ino: Number(PID_NS),
        mode: fs.constants.S_IFREG | 0o444,
        nlink: 1,
        uid: UID,
        gid: UID,
        size: 0,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      };
    }
    if (p.startsWith('/proc/')) {
      const content = resolveProcContent(p);
      if (content !== null) {
        return {
          dev: 4,
          ino: 12345,
          mode: fs.constants.S_IFREG | 0o444,
          nlink: 1,
          uid: UID,
          gid: UID,
          size: content.length,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        };
      }
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    }
    return null;
  };

  const fsRecovery = {
    constants: fs.constants,
    statSync(p, opts) {
      const st = resolveProcStat(p);
      if (st) return st;
      return fs.statSync(p, opts);
    },
    lstatSync(p, opts) {
      const st = resolveProcStat(p);
      if (st) return st;
      return fs.lstatSync(p, opts);
    },
    readFileSync(p, opts) {
      if (typeof p === 'number' && openSynthetic.has(p)) {
        const entry = openSynthetic.get(p);
        const enc = typeof opts === 'string' ? opts : (opts && opts.encoding);
        return enc ? entry.buf.toString(enc) : Buffer.from(entry.buf);
      }
      if (typeof p === 'string' && p.startsWith('/proc/')) {
        const content = resolveProcContent(p);
        if (content === null) {
          const err = new Error(`ENOENT: ${p}`);
          err.code = 'ENOENT';
          throw err;
        }
        const enc = typeof opts === 'string' ? opts : (opts && opts.encoding);
        return enc ? content.toString(enc) : content;
      }
      return fs.readFileSync(p, opts);
    },
    openSync(p, flags, mode) {
      if (typeof p === 'string' && p.startsWith('/proc/')) {
        const content = resolveProcContent(p);
        if (content === null) {
          const err = new Error(`ENOENT: ${p}`);
          err.code = 'ENOENT';
          throw err;
        }
        const fd = nextSyntheticFd;
        nextSyntheticFd += 1;
        openSynthetic.set(fd, { path: p, buf: content, pos: 0 });
        return fd;
      }
      return fs.openSync(p, flags, mode);
    },
    readSync(fd, buffer, offset, length, position) {
      if (openSynthetic.has(fd)) {
        const entry = openSynthetic.get(fd);
        const start = position !== null && position !== undefined ? position : entry.pos;
        if (start >= entry.buf.length) return 0;
        const n = Math.min(length, entry.buf.length - start);
        entry.buf.copy(buffer, offset, start, start + n);
        if (position === null || position === undefined) entry.pos = start + n;
        return n;
      }
      return fs.readSync(fd, buffer, offset, length, position);
    },
    fstatSync(fd, opts) {
      if (openSynthetic.has(fd)) {
        const entry = openSynthetic.get(fd);
        return resolveProcStat(entry.path);
      }
      return fs.fstatSync(fd, opts);
    },
    closeSync(fd) {
      if (openSynthetic.has(fd)) {
        openSynthetic.delete(fd);
        return;
      }
      fs.closeSync(fd);
    },
    fchmodSync: (...args) => fs.fchmodSync(...args),
    fsyncSync: (fd) => {
      if (openSynthetic.has(fd)) return;
      fs.fsyncSync(fd);
    },
    mkdirSync: (...args) => fs.mkdirSync(...args),
    readdirSync: (...args) => fs.readdirSync(...args),
    writeSync: (...args) => fs.writeSync(...args),
    writeFileSync: (...args) => fs.writeFileSync(...args),
    unlinkSync: (...args) => fs.unlinkSync(...args),
    renameSync: (...args) => fs.renameSync(...args),
    linkSync: (...args) => fs.linkSync(...args),
    chmodSync: (...args) => fs.chmodSync(...args),
    readlinkSync(p, opts) {
      if (p === `/proc/${targetPid}/ns/pid` || p === '/proc/self/ns/pid') {
        return `pid:[${PID_NS}]`;
      }
      return fs.readlinkSync(p, opts);
    },
  };

  return {
    fsRecovery,
    getTargetStatCount: () => targetStatCount,
  };
}

test('4.1 guardPid rifiuta PID non interi sicuri o <= 1 con zero segnali ed accetta solo interi sicuri > 1', () => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.guardPid, 'function', '4.1: export guardPid mancante in lib/fleet/vl-host-recovery.js');

  const invalidi = [0, 1, -1, -4242, NaN, Infinity, -Infinity, 12.5, '4242', null, undefined, true, false, {}, [],
    Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2, 2 ** 53, -(2 ** 53)];
  for (const cand of invalidi) {
    assert.equal(
      mod.guardPid(cand),
      false,
      `4.1: guardPid deve rifiutare ${JSON.stringify(cand)}`,
    );
  }

  // Un intero sicuro, anche ai bordi del dominio, deve essere accettato.
  for (const valido of [2, 3, Number.MAX_SAFE_INTEGER]) {
    assert.equal(mod.guardPid(valido), true, `4.1: guardPid deve accettare l'intero sicuro ${valido}`);
  }

  for (const valido of [2, 4242, 65535, 4194304]) {
    assert.equal(
      mod.guardPid(valido),
      true,
      `4.1: guardPid deve accettare intero sicuro > 1 (${valido})`,
    );
  }
});

test('4.2 guardRecord rifiuta record pending, none, versione diversa da 2, legacy o malformati senza mutare il record valido', () => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.guardRecord, 'function', '4.2: export guardRecord mancante in lib/fleet/vl-host-recovery.js');

  const baseValido = {
    launchId: '0123456789abcdef',
    vlBin: '/tmp/vl',
    vlBinSha256: 'a'.repeat(64),
    XDG_STATE_HOME: '/tmp/state',
    XDG_DATA_HOME: '/tmp/data',
    XDG_CONFIG_HOME: '/tmp/cfg',
    HOME: '/tmp/home',
    uid: UID,
    serverRoot: '/tmp/root',
    ts: 1000,
    version: 2,
    hostIdentity: makeHostIdentity(),
  };

  const fotoPrima = structuredClone(baseValido);
  assert.equal(mod.guardRecord(baseValido), true, '4.2: record v2 live completo deve essere accettato');
  assert.deepEqual(baseValido, fotoPrima, '4.2: guardRecord non deve mutare il record in ingresso');

  const invalidi = [
    ['null', null],
    ['undefined', undefined],
    ['array', []],
    ['oggetto vuoto', {}],
    ['pending', { ...baseValido, hostIdentity: { state: 'pending' } }],
    ['none', { ...baseValido, hostIdentity: { state: 'none' } }],
    ['version 1', { ...baseValido, version: 1 }],
    ['version 3', { ...baseValido, version: 3 }],
    ['legacy senza version/hostIdentity', (() => { const c = { ...baseValido }; delete c.version; delete c.hostIdentity; return c; })()],
    ['launchId invalido', { ...baseValido, launchId: 'bad-id' }],
    ['vlBinSha256 invalido', { ...baseValido, vlBinSha256: 'abc' }],
    ['serverRoot vuoto', { ...baseValido, serverRoot: '' }],
    ['hostIdentity assente', { version: 2, launchId: baseValido.launchId, vlBinSha256: baseValido.vlBinSha256, serverRoot: '/tmp/root' }],
    ['hostIdentity source non kernel', { ...baseValido, hostIdentity: makeHostIdentity({ source: 'declared' }) }],
    ['hostIdentity pid 1', { ...baseValido, hostIdentity: makeHostIdentity({ pid: 1, pgid: 1, sid: 1 }) }],
    ['hostIdentity pgid 0', { ...baseValido, hostIdentity: makeHostIdentity({ pgid: 0 }) }],
    ['hostIdentity sid -1', { ...baseValido, hostIdentity: makeHostIdentity({ sid: -1 }) }],
    ['hostIdentity uid -1', { ...baseValido, hostIdentity: makeHostIdentity({ uid: -1 }) }],
    ['hostIdentity bootId non UUID', { ...baseValido, hostIdentity: makeHostIdentity({ bootId: 'not-a-uuid' }) }],
    ['hostIdentity startTicks non decimale', { ...baseValido, hostIdentity: makeHostIdentity({ startTicks: '12ab' }) }],
    ['hostIdentity campo extra', { ...baseValido, hostIdentity: { ...makeHostIdentity(), extra: 1 } }],
  ];

  for (const [label, candidate] of invalidi) {
    assert.equal(
      mod.guardRecord(candidate),
      false,
      `4.2: guardRecord deve rifiutare ${label}`,
    );
  }
});

test('4.3 confrontaTupla rileva il mismatch di un singolo campo alla volta su tutti i campi di identita e solo l esatta coincidenza e true', () => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.confrontaTupla, 'function', '4.3: export confrontaTupla mancante in lib/fleet/vl-host-recovery.js');

  const registrata = makeHostIdentity();
  assert.equal(mod.confrontaTupla(registrata, { ...registrata }), true, '4.3: tuple identiche devono combaciare');

  const variantiMismatch = [
    ['uid', { uid: UID + 1 }],
    ['bootId', { bootId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }],
    ['pidNamespaceInode', { pidNamespaceInode: '4026539999' }],
    ['startTicks', { startTicks: '9999' }],
    ['pgid', { pgid: HOST_PID + 1 }],
    ['sid', { sid: HOST_PID + 2 }],
    ['source', { source: 'other-source' }],
    ['instanceId', { instanceId: 'cd'.repeat(16) }],
    ['pid', { pid: HOST_PID + 10 }],
  ];

  for (const [campo, patch] of variantiMismatch) {
    assert.equal(
      mod.confrontaTupla(registrata, { ...registrata, ...patch }),
      false,
      `4.3: mismatch del solo campo ${campo} deve restituire false`,
    );
  }

  for (const invalida of [null, undefined, {}, { ...registrata, state: 'pending' }, { ...registrata, startTicks: 1234 }]) {
    assert.equal(mod.confrontaTupla(registrata, invalida), false, '4.3: input osservato invalido deve dare false');
    assert.equal(mod.confrontaTupla(invalida, registrata), false, '4.3: identita in archivio invalida deve dare false');
  }
});

test('4.4 recover rifiuta con zero segnali quando host condivide pgid o sid con il coordinatore o non soddisfa pid===pgid===sid', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '4.4: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  const varianti = [
    {
      label: 'stesso pgid del coordinatore',
      hostPatch: { pid: HOST_PID, pgid: HOST_PID, sid: HOST_PID },
      coord: { pgid: HOST_PID, sid: 77777 },
      expectedCode: 'HOST_IN_GROUP',
    },
    {
      label: 'stesso sid del coordinatore',
      hostPatch: { pid: HOST_PID, pgid: HOST_PID, sid: HOST_PID },
      coord: { pgid: 77776, sid: HOST_PID },
      expectedCode: 'IDENTITY_UNKNOWN',
    },
    {
      label: 'host non leader di gruppo/sessione (!(pid===pgid===sid))',
      hostPatch: { pid: HOST_PID, pgid: HOST_PID + 10, sid: HOST_PID },
      coord: { pgid: 77776, sid: 77777 },
      expectedCode: 'IDENTITY_UNKNOWN',
    },
  ];

  for (const v of varianti) {
    const fx = makeValidRecord(t, { hostIdentity: v.hostPatch });
    const killCalls = [];
    let clock = 10000;

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: pubblicaEsclusiva,
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => v.coord,
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });

    assert.equal(typeof factory?.openAttempt, 'function', '4.4: factory.openAttempt mancante');
    assert.equal(typeof factory?.recover, 'function', '4.4: factory.recover mancante');
    assert.equal(typeof factory?.closeAttempt, 'function', '4.4: factory.closeAttempt mancante');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true, `4.4 (${v.label}): openAttempt atteso ok:true`);

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res.outcome, 'host-stop-failed', `4.4 (${v.label}): atteso rifiuto host-stop-failed`);
    assert.equal(res.code, v.expectedCode, `4.4 (${v.label}): atteso code ${v.expectedCode}`);
    assert.deepEqual(killCalls, [], `4.4 (${v.label}): zero killProcess attesi`);
  }
});

test('4.5 openAttempt e recover rifiutano con zero segnali quando fenceCheck fallisce o muta prima del segnale per root unsafe, pin alterato o launchId sostituito', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '4.5: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  const makeFactory = (fx, killCalls, clockRef) => mod.createHostRecovery({
    fsRecovery: fs,
    publishExclusive: pubblicaEsclusiva,
    killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
    osservaKernel: (pid, instanceId) => ({
      state: 'observed',
      processState: 'S',
      identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
    }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => clockRef.now,
    attesaImpl: async (ms) => { clockRef.now += Math.max(1, ms); },
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
  });

  // Parte A: fenceCheck invalida all ingresso di openAttempt (false, throw, non-boolean, thenable) oppure allowHostRecovery false.
  {
    const fx = makeValidRecord(t);
    const killCalls = [];
    const clockRef = { now: 10000 };
    const factory = makeFactory(fx, killCalls, clockRef);
    assert.equal(typeof factory?.openAttempt, 'function', '4.5: factory.openAttempt mancante');
    assert.equal(typeof factory?.recover, 'function', '4.5: factory.recover mancante');
    assert.equal(typeof factory?.closeAttempt, 'function', '4.5: factory.closeAttempt mancante');

    const invalidFences = [
      () => false,
      () => undefined,
      () => 'true',
      () => ({ then: (cb) => cb(true) }),
      () => { throw new Error('root-unsafe'); },
    ];
    for (const fenceFn of invalidFences) {
      const denied = factory.openAttempt({
        record: fx.record,
        stateDir: fx.stateDir,
        deadlineAt: clockRef.now + 8000,
        phasePlan: piano(8000, clockRef.now + 8000),
        allowHostRecovery: true,
        fenceCheck: fenceFn,
      }, 'silent');
      assert.equal(denied && denied.ok, false, '4.5: openAttempt deve rifiutare fenceCheck non strictly-true o throw');
      if (denied && denied.attempt) factory.closeAttempt(denied.attempt);
    }

    const noConsent = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clockRef.now + 8000,
      allowHostRecovery: false,
      fenceCheck: () => true,
    }, 'silent');
    if (noConsent && noConsent.ok) {
      let res;
      try {
        res = await factory.recover(noConsent.attempt, 'silent');
      } finally {
        factory.closeAttempt(noConsent.attempt);
      }
      assert.equal(res.outcome, 'host-stop-failed', '4.5: recover con allowHostRecovery:false deve rifiutare');
    }
    assert.deepEqual(killCalls, [], '4.5: Parte A deve produrre zero segnali');
  }

  // Parte B: fenceCheck valida in openAttempt ma muta a false prima del segnale (launchId/pin/root mutati pre-send).
  {
    const fx = makeValidRecord(t);
    const killCalls = [];
    const clockRef = { now: 10000 };
    let fenceValid = true;
    let fenceCalls = 0;

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: pubblicaEsclusiva,
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => {
        // Simula mutazione del record/pin/root appena prima del verdetto pre-send.
        fenceValid = false;
        return {
          state: 'observed',
          processState: 'S',
          identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
        };
      },
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clockRef.now,
      attesaImpl: async (ms) => { clockRef.now += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clockRef.now + 8000,
      phasePlan: piano(8000, clockRef.now + 8000),
      allowHostRecovery: true,
      fenceCheck: () => {
        fenceCalls += 1;
        return fenceValid;
      },
    }, 'silent');
    assert.equal(opened && opened.ok, true, '4.5: openAttempt iniziale deve riuscire con fence true');

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res.outcome, 'host-stop-failed', '4.5: mutazione pre-send del fence deve impedire recupero e segnali');
    assert.ok(fenceCalls >= 2, '4.5: fenceCheck deve essere ricontrollata prima del segnale');
    assert.deepEqual(killCalls, [], '4.5: zero segnali quando fence muta prima del send');
  }
});

test('4.6 recover con osservatore predefinito scarta la fotografia kernel con zero segnali se /proc stat diverge tra inizio e fine raccolta', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '4.6: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  const fx = makeValidRecord(t);
  const killCalls = [];
  let clock = 10000;

  const procFs = createProcInterceptFs({
    onTargetStatRead: (readIndex) => {
      // Prima lettura coerente con il record; seconda lettura intorno a uid/ns/boot_id diverge su startTicks.
      const ticks = readIndex % 2 === 1 ? '1234' : '9999';
      return makeStatLine(HOST_PID, { state: 'S', pgid: HOST_PID, sid: HOST_PID, startTicks: ticks });
    },
  });

  // osservaKernel volutamente omesso per esercitare l osservatore predefinito su /proc tramite fsRecovery.
  const factory = mod.createHostRecovery({
    fsRecovery: procFs.fsRecovery,
    publishExclusive: pubblicaEsclusiva,
    killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => clock,
    attesaImpl: async (ms) => { clock += Math.max(1, ms); },
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
  });

  assert.equal(typeof factory?.openAttempt, 'function', '4.6: factory.openAttempt mancante');
  assert.equal(typeof factory?.recover, 'function', '4.6: factory.recover mancante');
  assert.equal(typeof factory?.closeAttempt, 'function', '4.6: factory.closeAttempt mancante');

  const opened = factory.openAttempt({
    record: fx.record,
    stateDir: fx.stateDir,
    deadlineAt: clock + 8000,
    phasePlan: piano(8000, clock + 8000),
    allowHostRecovery: true,
    fenceCheck: () => true,
  }, 'silent');
  assert.equal(opened && opened.ok, true, '4.6: openAttempt atteso ok:true');

  let res;
  try {
    res = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(res.outcome, 'host-stop-failed', '4.6: snapshot /proc discordante deve rifiutare il recovery');
  assert.ok(procFs.getTargetStatCount() >= 2, '4.6: l osservatore predefinito deve rileggere /proc/<pid>/stat inizio e fine');
  assert.deepEqual(killCalls, [], '4.6: zero segnali su fotografia kernel divergente');
});
