'use strict';

const { piano } = require('./helpers/phase-plan.js');
const { verificaContrattoUi } = require('./helpers/ui-power-i18n.js');

// Host recovery signal escalation, kernel state classification, and synchronous delivery tests (5.1 - 5.8).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { publishExclusive, pubblicaEsclusiva } = require('../lib/fleet/exclusive-publish.js');
const causes = require('../lib/fleet/causes.js');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');
const gruppo = require('../lib/fleet/group-stop.js');
const vlRoots = require('../lib/fleet/vl-roots.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const hostStop = require('../lib/fleet/vl-host-stop.js');

const MODULE_PATH = path.join(__dirname, '../lib/fleet/vl-host-recovery.js');
const PUB_EXCL = pubblicaEsclusiva || publishExclusive;

const OWNER = 'cd'.repeat(16);
const BOOT_ID = '22345678-1234-4234-8234-123456789abc';
const PID_NS = '4026531836';
const HOST_PID = 5151;
const COORD_PID = 99998;
const UID = typeof process.getuid === 'function' ? process.getuid() : 1000;

const REAL_BOOT_ID = (() => {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch (_) {
    return '11111111-1111-4111-8111-111111111111';
  }
})();

const REAL_NS_INODE = (() => {
  try {
    return String(fs.statSync('/proc/self/ns/pid').ino);
  } catch (_) {
    return '4026531836';
  }
})();

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
    startTicks: '2468',
    pgid: HOST_PID,
    sid: HOST_PID,
    ...overrides,
  };
}

function readRecoveryEvents(stateDir) {
  const dir = path.join(stateDir, 'recovery-events');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => /^\d{8}-[a-z-]+\.json$/.test(n))
    .sort()
    .map((name) => {
      const full = path.join(dir, name);
      const raw = fs.readFileSync(full, 'utf8');
      return { name, path: full, raw, event: JSON.parse(raw) };
    });
}

function creaUnitFixture(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sig-'));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  const ncDir = path.join(home, '.nexuscrew');
  const ownerDir = path.join(ncDir, 'vl-instances', OWNER);
  const cellId = opts.cellId || 'CellaSig';
  const stateDir = path.join(ownerDir, cellId);
  const serverRoot = path.join(ncDir, 'vl-roots', cellId);
  const xdgState = path.join(home, '.local', 'state');
  const xdgData = path.join(home, '.local', 'share');
  const xdgConfig = path.join(home, '.config');

  for (const d of [home, ncDir, path.join(ncDir, 'vl-instances'), ownerDir, stateDir, serverRoot, xdgState, xdgData, xdgConfig]) {
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
    hostIdentity: makeHostIdentity(opts.hostIdentity),
  };
  hostStop.scriviContesto(stateDir, record);

  return { root, home, stateDir, serverRoot, bin: pin.path, record };
}

function assertFactoryMethods(factory, id) {
  assert.equal(typeof factory?.openAttempt, 'function', `${id}: factory.openAttempt mancante`);
  assert.equal(typeof factory?.recover, 'function', `${id}: factory.recover mancante`);
  assert.equal(typeof factory?.readTrace, 'function', `${id}: factory.readTrace mancante`);
  assert.equal(typeof factory?.closeAttempt, 'function', `${id}: factory.closeAttempt mancante`);
}

function createFakeTmuxScript(tmuxBin, { sessionsPath, deathMarkerPath, panePid, serverPid, sessionName }) {
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const sockIdx = argv.indexOf('-S');
const sockPath = sockIdx >= 0 ? argv[sockIdx + 1] : ${JSON.stringify(sharedTmuxSocketPath())};
const args = sockIdx >= 0 ? argv.slice(sockIdx + 2) : argv;
const SESSIONS_PATH = ${JSON.stringify(sessionsPath)};
const DEATH_MARKER = ${JSON.stringify(deathMarkerPath)};
const PANE_PID = ${Number(panePid)};
const SERVER_PID = ${Number(serverPid)};
const SESSION_NAME = ${JSON.stringify(sessionName)};
const SID = '$8';
const WID = '@8';
const PID = '%8';
const load = () => { try { return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')); } catch (_) { return []; } };
const save = (l) => fs.writeFileSync(SESSIONS_PATH, JSON.stringify(l));
const alive = (t) => {
  const clean = t ? String(t).replace(/^=/, '') : '';
  return load().some((s) => (!clean ? (s.id === SID || s.name === SESSION_NAME) : (s.id === clean || s.name === clean)));
};
if (args[0] === '-C') {
  if (!args.includes('new-session') && fs.existsSync(DEATH_MARKER)) process.exit(1);
  if (args.includes('new-session')) {
    save([{ name: SESSION_NAME, id: SID, w: WID, p: PID }]);
    process.stdout.write('%begin 1 0 1\\n' + SID + ' ' + WID + ' ' + PID + '\\n%end 1 0 1\\n');
  } else {
    process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  let buf = '';
  let seq = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || line.includes('nc-control-open')) continue;
      seq += 1;
      const emit = (body, ok) => process.stdout.write('%begin 1 ' + seq + ' 1\\n' + body + '%end 1 ' + seq + ' 1\\n' + (ok ? '' : ''));
      if (line.startsWith('display-message')) {
        if (line.includes('#{socket_path}')) emit(sockPath + '\\t' + SERVER_PID + '\\n', true);
        else if (line.includes('#{pane_pid}')) emit(SERVER_PID + '\\t' + PANE_PID + '\\n', true);
        else emit('0\\t0\\t' + PID + '\\n', true);
      } else if (line.startsWith('kill-session')) {
        save([]);
        emit('', true);
      } else {
        emit('', true);
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
const cmd = args[0] || '';
if (cmd === 'has-session') {
  if (alive(args[args.indexOf('-t') + 1])) process.exit(0);
  process.exit(1);
}
if (cmd === 'kill-session') { save([]); process.exit(0); }
if (cmd === 'display-message') {
  const f = args[args.indexOf('-F') + 1] || '';
  if (args.includes(';')) { process.stdout.write(SERVER_PID + '\\n'); process.exit(alive(SESSION_NAME) ? 0 : 1); }
  if (f.includes('#{socket_path}')) { process.stdout.write(sockPath + '\\t' + SERVER_PID + '\\n'); process.exit(0); }
  if (f.includes('pane_pid')) { process.stdout.write(SERVER_PID + '\\t' + PANE_PID + '\\n'); process.exit(0); }
  process.stdout.write('0\\t0\\t' + PID + '\\n');
  process.exit(0);
}
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
}

function createFakeVlScript(vlBin, { vlRoot, hostPid, uid, bootId, nsInode, startTicks }) {
  const script = `#!${process.execPath}
'use strict';
const args = process.argv.slice(2);
const sr = args[args.indexOf('--server-root') + 1];
const CAPS = ['host_peer_identity_v1', 'host_stop_expected_v1'];
if (args[0] === 'host' && args[1] === 'status') {
  if (sr !== ${JSON.stringify(vlRoot)}) {
    process.stdout.write(JSON.stringify({ ok: true, state: 'none', peer_identity_support: 'supported', capabilities: CAPS }) + '\\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    state: 'live',
    peer_identity_support: 'supported',
    capabilities: CAPS,
    declared_pid: ${Number(hostPid)},
    peer_identity: {
      schema_version: 1,
      state: 'verified',
      pid: ${Number(hostPid)},
      uid: ${Number(uid)},
      boot_id: ${JSON.stringify(bootId)},
      pidns: ${JSON.stringify(String(nsInode))},
      starttime: ${JSON.stringify(String(startTicks))},
      pgid: ${Number(hostPid)},
      sid: ${Number(hostPid)},
    },
  }) + '\\n');
  process.exit(0);
}
if (args[0] === 'internal' && args[1] === 'host-stop') {
  process.stdout.write(JSON.stringify({ ok: true, reason: 'shutdown_ack' }) + '\\n');
  process.exit(0);
}
process.exit(1);
`;
  fs.writeFileSync(vlBin, script, { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
}

test('5.1 SIGTERM sufficiente chiude host-stopped-attested con method term, zero SIGKILL e tracce complete', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '5.1: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  const fx = creaUnitFixture(t);
  let alive = true;
  let clock = 10000;
  let rootState = 'lock';
  const killCalls = [];
  let probeCalls = 0;

  const factory = mod.createHostRecovery({
    fsRecovery: fs,
    publishExclusive: PUB_EXCL,
    killProcess: (pid, sig) => {
      killCalls.push({ pid, sig });
      if (pid === HOST_PID && sig === 'SIGTERM') {
        alive = false;
        rootState = 'none';
      }
    },
    osservaKernel: (pid, instanceId) => (alive && pid === HOST_PID
      ? { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } }
      : { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => clock,
    attesaImpl: async (ms) => { clock += Math.max(1, ms); },
    probeRoot: async () => {
      probeCalls += 1;
      return { r: { ok: true }, stato: { ok: true, state: rootState, declared_pid: null, pid_number_in_use: null } };
    },
  });
  assertFactoryMethods(factory, '5.1');

  const opened = factory.openAttempt({
    record: fx.record,
    stateDir: fx.stateDir,
    deadlineAt: clock + 8000,
    phasePlan: piano(8000, clock + 8000),
    allowHostRecovery: true,
    fenceCheck: () => true,
  }, 'silent');
  assert.equal(opened && opened.ok, true, '5.1: openAttempt atteso ok:true');

  let res;
  try {
    res = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(res.outcome, 'host-stopped-attested', '5.1: atteso host-stopped-attested');
  assert.equal(res.method, 'term', '5.1: atteso method term');
  assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], '5.1: un solo SIGTERM e zero SIGKILL');
  assert.ok(probeCalls >= 1, '5.1: probeRoot deve attestare root none');

  const events = readRecoveryEvents(fx.stateDir);
  const kinds = events.map((e) => e.event.kind);
  assert.deepEqual(
    kinds,
    ['intent-term', 'signaled-term', 'exited', 'closed'],
    '5.1: sequenza tracce attesa per stop su SIGTERM',
  );
  assert.equal(factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state, 'clear');
});

test('5.2 SIGTERM ignorato esegue nuovo intent-kill e fresca osservazione prima di un solo SIGKILL e chiude method kill', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '5.2: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  const fx = creaUnitFixture(t);
  let alive = true;
  let clock = 10000;
  let rootState = 'lock';
  const killCalls = [];
  let obsCount = 0;
  let obsAtTerm = 0;
  let obsBeforeKill = 0;
  let fenceChecks = 0;
  let fenceChecksAtTerm = 0;
  let eventsBeforeKill = [];

  const factory = mod.createHostRecovery({
    fsRecovery: fs,
    publishExclusive: PUB_EXCL,
    killProcess: (pid, sig) => {
      killCalls.push({ pid, sig });
      if (sig === 'SIGTERM') {
        obsAtTerm = obsCount;
        // Host ignora SIGTERM e resta vivo.
      }
      if (sig === 'SIGKILL') {
        obsBeforeKill = obsCount;
        eventsBeforeKill = readRecoveryEvents(fx.stateDir).map((e) => e.event.kind);
        alive = false;
        rootState = 'none';
      }
    },
    osservaKernel: (pid, instanceId) => {
      obsCount += 1;
      return alive && pid === HOST_PID
        ? { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } }
        : { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } };
    },
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => clock,
    attesaImpl: async (ms) => { clock += Math.max(1, ms); },
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: rootState, declared_pid: null, pid_number_in_use: null } }),
  });
  assertFactoryMethods(factory, '5.2');

  const opened = factory.openAttempt({
    record: fx.record,
    stateDir: fx.stateDir,
    deadlineAt: clock + 8000,
    phasePlan: piano(8000, clock + 8000),
    allowHostRecovery: true,
    fenceCheck: () => {
      fenceChecks += 1;
      if (killCalls.length === 0) fenceChecksAtTerm = fenceChecks;
      return true;
    },
  }, 'silent');
  assert.equal(opened && opened.ok, true, '5.2: openAttempt atteso ok:true');

  let res;
  try {
    res = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(res.outcome, 'host-stopped-attested', '5.2: atteso host-stopped-attested dopo SIGKILL');
  assert.equal(res.method, 'kill', '5.2: atteso method kill');
  assert.deepEqual(
    killCalls,
    [{ pid: HOST_PID, sig: 'SIGTERM' }, { pid: HOST_PID, sig: 'SIGKILL' }],
    '5.2: attesi esattamente un SIGTERM e un SIGKILL',
  );
  assert.ok(eventsBeforeKill.includes('intent-kill'), '5.2: intent-kill deve essere persistito prima di SIGKILL');
  assert.ok(obsBeforeKill > obsAtTerm, '5.2: prima di SIGKILL serve una nuova fotografia kernel');
  assert.ok(fenceChecks > fenceChecksAtTerm, '5.2: prima di SIGKILL serve un nuovo fenceCheck');

  const events = readRecoveryEvents(fx.stateDir).map((e) => e.event);
  assert.ok(events.some((e) => e.kind === 'signaled-kill' && e.reason === 'sent'));
  assert.ok(events.some((e) => e.kind === 'exited' && e.method === 'kill' && e.reason === 'absent'));
  assert.ok(events.some((e) => e.kind === 'closed' && e.method === 'kill'));
});

test('5.3 (a) PID reuse su stesso nodo e ns prova uscita originale con zero SIGKILL; (b) solo UID diverso a startTicks invariata rifiuta incerto senza SIGKILL', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '5.3: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');
  assert.equal(typeof mod?.confrontaTupla, 'function', '5.3: export confrontaTupla mancante');

  // Sottocaso (a): nascita diversa sullo stesso nodo/ns dopo SIGTERM -> originale uscito, zero SIGKILL al nuovo processo.
  {
    const fx = creaUnitFixture(t);
    let clock = 10000;
    let termSent = false;
    const killCalls = [];

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => {
        killCalls.push({ pid, sig });
        if (sig === 'SIGTERM') termSent = true;
      },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: {
          ...fx.record.hostIdentity,
          instanceId: instanceId || OWNER,
          startTicks: termSent ? '998877' : fx.record.hostIdentity.startTicks,
        },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory, '5.3(a)');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true, '5.3(a): openAttempt atteso ok:true');

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res.outcome, 'host-stopped-attested', '5.3(a): PID reuse su stesso nodo/ns deve provare uscita originale');
    assert.equal(
      killCalls.some((k) => k.sig === 'SIGKILL'),
      false,
      '5.3(a): zero SIGKILL verso il nuovo processo su PID reuse',
    );
    const events = readRecoveryEvents(fx.stateDir).map((e) => e.event);
    assert.ok(events.some((e) => e.kind === 'exited' && e.reason === 'pid-reused'), '5.3(a): atteso evento exited reason pid-reused');
  }

  // Sottocaso (b): solo UID diverso a startTicks invariata -> NON prova reuse/uscita, rifiuto incerto senza SIGKILL.
  {
    const fx = creaUnitFixture(t);
    let clock = 10000;
    const killCalls = [];
    const uidMutato = { ...fx.record.hostIdentity, uid: UID + 1 };
    assert.equal(mod.confrontaTupla(fx.record.hostIdentity, uidMutato), false, '5.3(b): confrontaTupla deve rilevare solo UID diverso');

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER, uid: UID + 1 },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory, '5.3(b)');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true, '5.3(b): openAttempt atteso ok:true');

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res.outcome, 'host-stop-failed', '5.3(b): solo UID diverso con stessa nascita deve rifiutare come incerto');
    assert.deepEqual(killCalls, [], '5.3(b): zero segnali quando sola UID diverge a nascita invariata');
  }
});

test('5.4 errori /proc EACCES o EIO e kill EPERM fermano l escalation e restano incerti senza SIGKILL', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '5.4: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  // Variante A: /proc EACCES/EIO dopo SIGTERM -> stop escalation, zero SIGKILL.
  for (const reason of ['access', 'io']) {
    const fx = creaUnitFixture(t);
    let clock = 10000;
    let signaled = false;
    const killCalls = [];

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => {
        killCalls.push({ pid, sig });
        if (sig === 'SIGTERM') signaled = true;
      },
      osservaKernel: (pid, instanceId) => (signaled
        ? { state: 'unverifiable', reason }
        : { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory, `5.4(${reason})`);

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true);

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res.outcome, 'host-stop-failed', `5.4 (${reason}): /proc non leggibile deve restare host-stop-failed`);
    assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], `5.4 (${reason}): zero SIGKILL dopo /proc ${reason}`);
  }

  // Variante B: killProcess lancia EPERM -> incerto, zero SIGKILL, signaled-term eperm.
  {
    const fx = creaUnitFixture(t);
    let clock = 10000;
    const killCalls = [];

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => {
        killCalls.push({ pid, sig });
        const err = new Error('EPERM');
        err.code = 'EPERM';
        throw err;
      },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory, '5.4(EPERM)');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true);

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res.outcome, 'host-stop-failed', '5.4(EPERM): EPERM deve chiudere incerto/failed');
    assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], '5.4(EPERM): zero SIGKILL dopo EPERM');
    const events = readRecoveryEvents(fx.stateDir).map((e) => e.event);
    assert.ok(events.some((e) => e.kind === 'signaled-term' && e.reason === 'eperm'), '5.4(EPERM): atteso signaled-term reason eperm');
  }
});

test('5.5 processo originale zombie in stato Z con stessa startTicks attesta uscita con verifica root none e zero segnali inutili', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '5.5: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  // Variante A: gia zombie all ingresso e root none -> chiusura attested con method null.
  {
    const fx = creaUnitFixture(t);
    let clock = 10000;
    const killCalls = [];
    let probeCalls = 0;

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'Z',
        identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => {
        probeCalls += 1;
        return { r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } };
      },
    });
    assertFactoryMethods(factory, '5.5');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true);

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res.outcome, 'host-stopped-attested', '5.5: zombie + root none deve chiudere host-stopped-attested');
    assert.equal(res.method, null, '5.5: zombie preesistente non richiede nuovo segnale (method null)');
    assert.deepEqual(killCalls, [], '5.5: zero segnali inutili allo zombie');
    assert.ok(probeCalls >= 1, '5.5: probeRoot none deve essere verificato');
    const events = readRecoveryEvents(fx.stateDir).map((e) => e.event);
    assert.ok(events.some((e) => e.kind === 'exited' && e.method === null && e.reason === 'zombie'));
  }

  // Variante B: zombie originale MA root resta lock -> fail-closed senza promozione.
  {
    const fx = creaUnitFixture(t);
    let clock = 10000;
    const killCalls = [];

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'Z',
        identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory, '5.5-neg');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true);

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res.outcome, 'host-stop-failed', '5.5: zombie con root lock deve restare fail-closed');
    assert.deepEqual(killCalls, []);
  }
});

test('5.6a recover con processo in stato D che sopravvive a SIGKILL termina incompleto senza 3o segnale o loop e segnala hostAlive interno solo su prova positiva', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '5.6a: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  // Positivo: processo in stato D resta positivamente osservabile vivo dopo SIGKILL -> hostAlive:true interno.
  {
    const fx = creaUnitFixture(t);
    let clock = 10000;
    let obsCount = 0;
    const killCalls = [];

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => {
        obsCount += 1;
        return {
          state: 'observed',
          processState: 'D',
          identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
        };
      },
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory, '5.6a');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true);

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res.outcome, 'host-stop-failed', '5.6a: processo vivo in D dopo SIGKILL deve terminare incompleto');
    assert.equal(res.hostAlive, true, '5.6a: esito interno deve attestare hostAlive:true quando positivamente vivo');
    assert.deepEqual(
      killCalls,
      [{ pid: HOST_PID, sig: 'SIGTERM' }, { pid: HOST_PID, sig: 'SIGKILL' }],
      '5.6a: nessun terzo segnale dopo SIGKILL',
    );
    assert.ok(obsCount < 100, '5.6a: nessun loop infinito sulle osservazioni in D');
  }

  // Negativo: osservazione post-SIGKILL diventa incerta (unverifiable) -> MAI hostAlive:true.
  {
    const fx = creaUnitFixture(t);
    let clock = 10000;
    const killCalls = [];

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => {
        if (killCalls.some((k) => k.sig === 'SIGKILL')) {
          return { state: 'unverifiable', reason: 'io' };
        }
        return {
          state: 'observed',
          processState: 'D',
          identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
        };
      },
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory, '5.6a-neg');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true);

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res.outcome, 'host-stop-failed');
    assert.notEqual(res.hostAlive, true, '5.6a: lettura incerta post-SIGKILL non deve dichiarare hostAlive:true');
  }
});

test('5.6b runtime down con host sopravvissuto in stato D emette fleetCode HOST_ALIVE con catalogo e chiavi i18n paritarie it/en/es', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sig56b-'));
  fs.chmodSync(root, 0o755);
  const home = path.join(root, 'home');
  const cella = 'CellaSig56b';
  const sessione = 'cloud-CellaSig56b';
  const cellBase = vlCellBaseDir(home, OWNER, cella);
  const vlRoot = vlRoots.radiceServer(home, OWNER, cella);
  const cwd = path.join(home, cella);
  const filesRoot = path.join(home, 'NexusFiles');

  for (const d of [home, path.join(home, '.local'), path.join(home, '.local', 'bin'), path.join(home, '.local', 'share'), path.join(home, '.nexuscrew'), path.join(home, '.nexuscrew', 'vl-cells'), path.join(home, '.config'), path.join(home, '.config', 'vl'), cwd, filesRoot, cellBase]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(path.join(home, '.config', 'vl', 'config.toml'), '[profiles.work]\nmodel = "m"\n', { mode: 0o644 });

  const serverProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'], { detached: true, stdio: 'ignore' });
  serverProc.unref();
  const paneChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'], { detached: true, stdio: 'ignore' });
  paneChild.unref();

  const sessionsPath = path.join(root, 'sessions.json');
  fs.writeFileSync(sessionsPath, '[]');
  const deathMarkerPath = path.join(root, 'tmux-dead');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  createFakeTmuxScript(tmuxBin, { sessionsPath, deathMarkerPath, panePid: paneChild.pid, serverPid: serverProc.pid, sessionName: sessione });

  const vlBin = path.join(home, '.local', 'bin', 'vl');
  createFakeVlScript(vlBin, { vlRoot, hostPid: HOST_PID, uid: UID, bootId: REAL_BOOT_ID, nsInode: REAL_NS_INODE, startTicks: '2468' });

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'vl.native', label: 'VL', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' } }],
    cells: [{ id: cella, tmuxSession: sessione, cwd, engine: 'vl.native', boot: false }],
  });

  const mgr = createLeaseManager({ home, log: () => {} });
  let lastPayload = null;
  let serverSide = null;
  let clientSide = null;
  let srv = null;
  let leaseCtl = null;
  let runtime = null;

  t.after(() => {
    try { if (leaseCtl) leaseCtl.stop(); } catch (_) {}
    try { if (clientSide) clientSide.destroy(); } catch (_) {}
    try { if (serverSide) serverSide.destroy(); } catch (_) {}
    try { if (srv) srv.close(); } catch (_) {}
    try { if (runtime) runtime.shutdown(); } catch (_) {}
    try { mgr.close(); } catch (_) {}
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    try { process.kill(serverProc.pid, 'SIGKILL'); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const hostIdReal = {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId: OWNER,
    pid: HOST_PID,
    uid: UID,
    bootId: REAL_BOOT_ID,
    pidNamespaceInode: REAL_NS_INODE,
    startTicks: '2468',
    pgid: HOST_PID,
    sid: HOST_PID,
  };
  const killCalls = [];

  runtime = createBuiltinRuntime({
    cfg: {
      launchReadyMs: 0,
      filesRoot,
      activityHooks: false,
      vlLaunchCooldownMs: 0,
      groupStopBudgetMs: 1200,
      log: () => {},
      env: {},
      vlIsolationSeams: {
        identitaNodo: () => ({ bootId: REAL_BOOT_ID, pidNamespaceInode: REAL_NS_INODE }),
        identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
        osservaPeer: (pid, instanceId) => (pid === HOST_PID ? { ...hostIdReal, instanceId: instanceId || OWNER } : null),
        osservaKernel: (pid, instanceId) => ({
          state: 'observed',
          processState: 'D',
          identity: { ...hostIdReal, instanceId: instanceId || OWNER },
        }),
        killProcess: (pid, sig) => {
          killCalls.push({ pid, sig });
          // Stato D: processo sopravvive a SIGTERM e SIGKILL.
        },
      },
    },
    identityOwnerInstanceId: OWNER,
    home,
    defsPath,
    tmuxBin,
    readonly: () => false,
    launchBroker: {
      issue: async (req) => { lastPayload = req; return { socketPath: path.join(root, 'broker.sock'), nonce: 'b'.repeat(64) }; },
      revoke: async () => {},
      close: async () => {},
    },
    leaseManager: mgr,
    boot: loadDefinitions(defsPath),
  });

  const deadTime = Date.now() + 3000;
  while (gruppo.leggiPgrp(paneChild.pid) === null && Date.now() < deadTime) {
    await new Promise((r) => setTimeout(r, 15));
  }
  await runtime.up(cella);

  const pairPath = path.join(root, 'pair.sock');
  srv = net.createServer((sock) => { serverSide = sock; });
  await new Promise((resolve) => srv.listen(pairPath, resolve));
  clientSide = await new Promise((resolve, reject) => {
    const c = net.connect(pairPath, () => resolve(c));
    c.once('error', reject);
  });
  while (!serverSide) await new Promise((r) => setTimeout(r, 10));
  assert.equal(mgr.attachInitial(cella, serverSide, { generation: 0 }), true);

  let coord = null;
  coord = gruppo.creaCoordinatore({
    token: lastPayload.control.token,
    launchId: lastPayload.control.launchId,
    monoNow: () => Number(process.hrtime.bigint() / 1000000n),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    killGruppo: () => {},
    osserva: () => ({ inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }),
    invia: (frame) => leaseCtl.sendControl(frame),
    svuota: async () => { await leaseCtl.svuota(); try { clientSide.end(); } catch (_) {} },
    cancellaDelivery: async () => null,
    scriviLog: () => {},
    dichiaraStopping: () => {},
    disarmaLegacy: () => {},
    installaIgnoraTerm: () => {},
  });
  leaseCtl = startLeaseClient(clientSide, {
    stablePath: (lastPayload.lease && lastPayload.lease.stablePath) || path.join(root, 'no-lease.sock'),
    launchEpoch: (lastPayload.lease && lastPayload.lease.launchEpoch) || 'epoch',
    onControlFrame: (frame) => coord.onFrame(frame),
  });

  let downErr = null;
  let downRes = null;
  try {
    downRes = await runtime.down(cella);
  } catch (e) {
    if (!e || typeof e.fleetCode !== 'string') throw e;
    downErr = e;
  }

  assert.equal(
    downErr && downErr.fleetCode,
    'HOST_ALIVE',
    `5.6b: down con stessa incarnazione viva in stato D dopo SIGKILL deve emettere HOST_ALIVE (ricevuto ${downErr && downErr.fleetCode}, res=${Boolean(downRes)})`,
  );
  assert.equal(causes.CODES.includes('HOST_ALIVE'), true, '5.6b: HOST_ALIVE deve appartenere a causes.CODES');
  assert.equal(causes.codeOf('HOST_ALIVE'), 'HOST_ALIVE', '5.6b: codeOf(HOST_ALIVE) deve restituire HOST_ALIVE');

  // The interface contract is proved on the function the UI already calls:
  // real errors keep rejecting with their structured cause and carry the
  // locale text; the attested host result is presented and term/kill stay
  // distinct. Unknown or missing methods are never promoted.
  await verificaContrattoUi('5.6b');
});

test('5.7 scomparsa pre-segnale sul medesimo dominio kernel o ESRCH su killProcess attesta uscita con zero segnali dopo morte', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '5.7: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  // Variante A: absent su medesimo dominio kernel pre-segnale + root none -> zero segnali, method null.
  {
    const fx = creaUnitFixture(t);
    let clock = 10000;
    const killCalls = [];

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: () => ({ state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory, '5.7-absent');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true);

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res.outcome, 'host-stopped-attested', '5.7: absent su medesimo dominio + root none deve attestare stop');
    assert.equal(res.method, null, '5.7: uscita pre-segnale deve avere method null');
    assert.deepEqual(killCalls, [], '5.7: nessun segnale inviato quando gia absent');
  }

  // Variante B: domain mismatch su absent NON promuove uscita (fail-closed).
  {
    const fx = creaUnitFixture(t);
    let clock = 10000;
    const killCalls = [];

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: () => ({
        state: 'absent',
        node: { bootId: '99999999-9999-4999-8999-999999999999', pidNamespaceInode: PID_NS },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'none', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory, '5.7-domain');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true);

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res.outcome, 'host-stop-failed', '5.7: absent con bootId diverso non prova uscita originale');
    assert.deepEqual(killCalls, []);
  }

  // Variante C: ESRCH al SIGTERM -> zero SIGKILL successivo; con root none chiude attested, signaled-term reason esrch.
  {
    const fx = creaUnitFixture(t);
    let clock = 10000;
    let gone = false;
    const killCalls = [];

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => {
        killCalls.push({ pid, sig });
        gone = true;
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      },
      osservaKernel: (pid, instanceId) => (gone
        ? { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }
        : { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: gone ? 'none' : 'lock', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory, '5.7-esrch');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true);

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res.outcome, 'host-stopped-attested', '5.7(ESRCH): con kernel absent e root none chiude attested');
    assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], '5.7(ESRCH): zero SIGKILL dopo ESRCH');
    const events = readRecoveryEvents(fx.stateDir).map((e) => e.event);
    assert.ok(events.some((e) => e.kind === 'signaled-term' && e.reason === 'esrch'), '5.7(ESRCH): atteso signaled-term reason esrch');
  }
});

test('5.8 recover consegna il segnale in modo sincrono dopo ricontrollo /proc, fence e deadline senza await microtask o scrittura journal nel mezzo', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '5.8: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  // Il confine finale va provato DUE volte: con TERM risolutivo e con
  // escalation a KILL. La traccia I/O copre anche writeSync/fsyncSync su fd
  // (mappati al loro percorso) e il publisher, altrimenti un write/fsync
  // sincrono dopo l'ultima fotografia resterebbe invisibile.
  for (const termUccide of [true, false]) {
    await t.test(termUccide ? '5.8(term)' : '5.8(kill)', (t2) => eseguiConfine(t2, termUccide));
  }

  async function eseguiConfine(t2, termUccide) {
  const tag = termUccide ? '5.8(term)' : '5.8(kill)';
  const fx = creaUnitFixture(t2);
  let clock = 10000;
  let alive = true;
  let seq = 0;
  const timeline = [];
  let pendingMicrotaskEpoch = 0;
  let flushedMicrotaskEpoch = 0;

  const armMicrotaskProbe = (label) => {
    seq += 1;
    const epoch = seq;
    pendingMicrotaskEpoch = epoch;
    timeline.push({ seq: epoch, op: label });
    Promise.resolve().then(() => {
      flushedMicrotaskEpoch = Math.max(flushedMicrotaskEpoch, epoch);
      timeline.push({ seq: -epoch, op: `microtask-after-${label}` });
    });
    return epoch;
  };

  let lastObsSeqBeforeSignal = 0;
  let lastFenceSeqBeforeSignal = 0;
  let lastClockSeqBeforeSignal = 0;
  let termSignalCheck = null;

  const fdPaths = new Map();
  // La catena pertinente e' tutta la stateDir: oltre alla directory degli
  // eventi conta la sua entry e il parent, la cui sincronizzazione fa parte
  // della durabilita' e non deve restare invisibile.
  const nellaCatena = (p) => typeof p === 'string' && (p === fx.stateDir || p.startsWith(`${fx.stateDir}${path.sep}`));
  const fsWrapped = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'openSync') {
        return (...args) => {
          const fd = target.openSync(...args);
          fdPaths.set(fd, String(args[0]));
          if (nellaCatena(args[0])) {
            seq += 1;
            timeline.push({ seq, op: 'fs-openSync' });
          }
          return fd;
        };
      }
      if (prop === 'closeSync') {
        return (fd) => { fdPaths.delete(fd); return target.closeSync(fd); };
      }
      if (prop === 'writeSync' || prop === 'fsyncSync' || prop === 'readSync' || prop === 'fstatSync') {
        return (...args) => {
          const p = fdPaths.get(args[0]) || '';
          if (nellaCatena(p)) {
            seq += 1;
            timeline.push({ seq, op: `fs-${String(prop)}:${path.basename(p)}` });
          }
          return target[prop](...args);
        };
      }
      if (prop === 'writeFileSync' || prop === 'linkSync' || prop === 'renameSync') {
        return (...args) => {
          if (args.some(nellaCatena)) {
            seq += 1;
            timeline.push({ seq, op: `fs-${String(prop)}` });
          }
          return target[prop](...args);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  const publishObserved = [];
  const publishExclusiveOsservato = (opts) => {
    let kind = null;
    try { kind = opts && opts.bytes ? JSON.parse(Buffer.from(opts.bytes).toString('utf8')).kind : null; } catch (_) { kind = null; }
    seq += 1;
    publishObserved.push({ seq, kind });
    timeline.push({ seq, op: `pub:${kind}` });
    return PUB_EXCL(opts);
  };

  const factory = mod.createHostRecovery({
    fsRecovery: fsWrapped,
    publishExclusive: publishExclusiveOsservato,
    killProcess: (pid, sig) => {
      seq += 1;
      const killSeq = seq;
      timeline.push({ seq: killSeq, op: `kill:${sig}` });
      const bersaglio = termUccide ? 'SIGTERM' : 'SIGKILL';
      if (sig === bersaglio) {
        const journalWritesAfterObs = timeline.filter(
          (e) => e.seq > lastObsSeqBeforeSignal && e.seq < killSeq
            && (e.op.startsWith('fs-') || e.op.startsWith('pub:')),
        );
        // Quale intento era durevole prima della syscall: si guarda la
        // pubblicazione del kind bersaglio, non il solo fatto che il publisher
        // sia stato usato.
        const kindBersaglio = termUccide ? 'intent-term' : 'intent-kill';
        const pubs = publishObserved.filter((x) => x.seq < killSeq && x.kind === kindBersaglio);
        termSignalCheck = {
          pid,
          sig,
          killSeq,
          lastObsSeqBeforeSignal,
          lastFenceSeqBeforeSignal,
          lastClockSeqBeforeSignal,
          intentSeq: pubs.length ? pubs[pubs.length - 1].seq : null,
          kindBersaglio,
          microtaskFlushedAfterFence: flushedMicrotaskEpoch >= lastFenceSeqBeforeSignal,
          microtaskFlushedAfterObs: flushedMicrotaskEpoch >= lastObsSeqBeforeSignal,
          journalWritesAfterObs,
        };
      }
      if (sig === 'SIGKILL' || (sig === 'SIGTERM' && termUccide)) alive = false;
    },
    osservaKernel: (pid, instanceId) => {
      const e = armMicrotaskProbe('osservaKernel');
      if (termSignalCheck === null) lastObsSeqBeforeSignal = e;
      return alive && pid === HOST_PID
        ? { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } }
        : { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } };
    },
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => {
      const e = armMicrotaskProbe('monoNow');
      if (termSignalCheck === null) lastClockSeqBeforeSignal = e;
      return clock;
    },
    attesaImpl: async (ms) => { clock += Math.max(1, ms); },
    probeRoot: async () => ({
      r: { ok: true },
      stato: { ok: true, state: alive ? 'lock' : 'none', declared_pid: null, pid_number_in_use: null },
    }),
  });
  assertFactoryMethods(factory, '5.8');

  const opened = factory.openAttempt({
    record: fx.record,
    stateDir: fx.stateDir,
    deadlineAt: clock + 8000,
    phasePlan: piano(8000, clock + 8000),
    allowHostRecovery: true,
    fenceCheck: () => {
      const e = armMicrotaskProbe('fenceCheck');
      if (termSignalCheck === null) lastFenceSeqBeforeSignal = e;
      return true;
    },
  }, 'silent');
  assert.equal(opened && opened.ok, true);

  let res;
  try {
    res = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assert.equal(res.outcome, 'host-stopped-attested', `${tag}: atteso completamento attested`);
  if (res && typeof res.method === 'string') {
    assert.equal(res.method, termUccide ? 'term' : 'kill', `${tag}: metodo ${termUccide ? 'term' : 'kill'} atteso`);
  }
  assert.ok(termSignalCheck, `${tag}: il segnale bersaglio deve essere stato invocato`);
  assert.equal(termSignalCheck.pid, HOST_PID);
  assert.equal(termSignalCheck.sig, termUccide ? 'SIGTERM' : 'SIGKILL', `${tag}: segnale bersaglio`);
  assert.equal(termSignalCheck.microtaskFlushedAfterObs, false, `${tag}: zero microtask/await tra ultima osservazione kernel e il segnale`);
  assert.equal(termSignalCheck.microtaskFlushedAfterFence, false, `${tag}: zero microtask/await tra fence finale e il segnale`);
  assert.deepEqual(termSignalCheck.journalWritesAfterObs, [], `${tag}: nessuna scrittura journal o pubblicazione tra ultima fotografia kernel e il segnale`);
  // Indici della sequenza normativa, per TERM e per KILL: intento durevole,
  // poi fotografia kernel completa, poi fence sincrono, poi ultimo clock e
  // riserve, infine la syscall. Scambiare fence e fotografia, o mettere
  // l'ultimo clock prima della fotografia, non puo' restare verde.
  assert.ok(
    Number.isInteger(termSignalCheck.intentSeq),
    `${tag}: l'intento ${termSignalCheck.kindBersaglio} deve essere pubblicato prima del segnale`,
  );
  assert.ok(
    termSignalCheck.intentSeq < termSignalCheck.lastObsSeqBeforeSignal,
    `${tag}: intento ${termSignalCheck.kindBersaglio} (${termSignalCheck.intentSeq}) deve precedere l'ultima fotografia kernel (${termSignalCheck.lastObsSeqBeforeSignal})`,
  );
  assert.ok(
    termSignalCheck.lastObsSeqBeforeSignal < termSignalCheck.lastFenceSeqBeforeSignal,
    `${tag}: fotografia kernel (${termSignalCheck.lastObsSeqBeforeSignal}) deve precedere il fence (${termSignalCheck.lastFenceSeqBeforeSignal})`,
  );
  assert.ok(
    termSignalCheck.lastFenceSeqBeforeSignal < termSignalCheck.lastClockSeqBeforeSignal,
    `${tag}: fence (${termSignalCheck.lastFenceSeqBeforeSignal}) deve precedere l'ultimo clock (${termSignalCheck.lastClockSeqBeforeSignal})`,
  );
  assert.ok(
    termSignalCheck.lastClockSeqBeforeSignal < termSignalCheck.killSeq,
    `${tag}: ultimo clock (${termSignalCheck.lastClockSeqBeforeSignal}) deve precedere la syscall (${termSignalCheck.killSeq})`,
  );
  assert.ok(pendingMicrotaskEpoch >= termSignalCheck.lastObsSeqBeforeSignal);
  assert.ok(publishObserved.length > 0, `${tag}: il publisher deve essere osservato, non aggirato con un fs proprio`);
  }
});
