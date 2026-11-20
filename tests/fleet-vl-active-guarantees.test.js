'use strict';
// Garanzie ATTIVE estratte dai test rossi di caratterizzazione futura: il
// comportamento che ciascuna esercita e' raggiungibile OGGI e deve restare
// provato quando quei test entrano nell'elenco chiuso dei rossi futuri. Ogni
// test copia la preparazione del suo d'origine e tiene SOLO gli assert della
// parte attiva, fermandosi prima della capacita' rinviata. I file d'origine
// non si toccano.
//
// Preparazioni copiate (byte per byte, dentro un ambito proprio per non
// confondere i nomi omonimi dei cinque moduli):
//   BAR = tests/fleet-vl-host-recovery-barriers.test.js (creaMondoBar)
//   LEA = tests/fleet-vl-host-recovery-lease.test.js (creaMondoLea)
//   BUD = tests/fleet-vl-host-recovery-budget.test.js (creaMondoBud)
//   FEN = tests/fleet-vl-host-recovery-fence.test.js (creaMondoE2E del fence)
//   E2E = tests/fleet-vl-host-recovery-e2e.test.js (creaMondoE2E)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { publishExclusive, pubblicaEsclusiva } = require('../lib/fleet/exclusive-publish.js');
const { atomicWrite, loadDefinitions, sharedGroupId } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');
const causes = require('../lib/fleet/causes.js');
const gruppo = require('../lib/fleet/group-stop.js');
const hostStop = require('../lib/fleet/vl-host-stop.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const vlRoots = require('../lib/fleet/vl-roots.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');

const BAR = (function () {
const MODULE_PATH = path.join(__dirname, '../lib/fleet/vl-host-recovery.js');
const PUB_EXCL = pubblicaEsclusiva || publishExclusive;

const OWNER = 'b2'.repeat(16);
const BOOT_ID = '22345678-1234-4234-8234-123456789abc';
const PID_NS = '4026531836';
const HOST_PID = 51515;
const NEW_PEER_PID = 61616;
const COORD_PID = 99996;
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
    startTicks: '4321',
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

function assertFactoryMethods(factory, id) {
  assert.equal(typeof factory?.openAttempt, 'function', `${id}: factory.openAttempt mancante`);
  assert.equal(typeof factory?.runExpected, 'function', `${id}: factory.runExpected mancante`);
  assert.equal(typeof factory?.recover, 'function', `${id}: factory.recover mancante`);
  assert.equal(typeof factory?.readTrace, 'function', `${id}: factory.readTrace mancante`);
  assert.equal(typeof factory?.closeAttempt, 'function', `${id}: factory.closeAttempt mancante`);
}

function creaUnitFixture(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bar-'));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  const ncDir = path.join(home, '.nexuscrew');
  const ownerDir = path.join(ncDir, 'vl-instances', OWNER);
  const cellId = opts.cellId || 'CellaBar';
  const cellBase = vlCellBaseDir(home, OWNER, cellId);
  const stateDir = opts.useCellBase ? cellBase : path.join(ownerDir, cellId);
  const serverRoot = opts.useCellBase
    ? vlRoots.radiceServer(home, OWNER, cellId)
    : path.join(ncDir, 'vl-roots', cellId);
  const xdgState = path.join(home, '.local', 'state');
  const xdgData = path.join(home, '.local', 'share');
  const xdgConfig = path.join(home, '.config');

  for (const d of [
    home,
    ncDir,
    path.join(ncDir, 'vl-instances'),
    ownerDir,
    stateDir,
    path.join(cellBase, 'state'),
    path.join(cellBase, 'state', 'vl'),
    serverRoot,
    xdgState,
    xdgData,
    xdgConfig,
  ]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }

  t.after(() => {
    for (const target of [serverRoot, path.join(cellBase, 'state', 'vl'), stateDir, root]) {
      try { fs.chmodSync(target, 0o700); } catch (_) {}
    }
    try { fs.chmodSync(path.join(stateDir, 'recovery-events'), 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const vlBin = path.join(root, 'vl');
  fs.writeFileSync(vlBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const pin = hostStop.pinBinario({ source: vlBin, home, owner: OWNER, cellId });
  assert.equal(pin.ok, true);

  const record = {
    launchId: hexId(8),
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

  return { root, home, ncDir, cellId, cellBase, stateDir, serverRoot, bin: pin.path, record };
}

function statusPayload({ state = 'live', declaredPid = HOST_PID, pidInUse = true, peerIdentity } = {}) {
  const base = {
    schema_version: 1,
    explicit_root: true,
    profile: 'work',
    profile_source: 'config',
    residual_lock: null,
    error: null,
    capabilities: ['host_stop_v1', 'host_peer_identity_v1', 'host_stop_expected_v1'],
    peer_identity_support: 'supported',
    state,
    declared_pid: declaredPid,
    pid_number_in_use: pidInUse,
  };
  if (peerIdentity !== undefined) {
    base.peer_identity = peerIdentity;
  }
  return base;
}

function makeVerifiedPeer(hostId) {
  return {
    schema_version: 1,
    state: 'verified',
    pid: hostId.pid,
    uid: hostId.uid,
    starttime: Number(hostId.startTicks),
    boot_id: hostId.bootId,
    pidns: Number(hostId.pidNamespaceInode),
    pgid: hostId.pgid,
    sid: hostId.sid,
  };
}

function creaFakeChild(code, stdoutObj) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killedSignals = [];
  child.kill = (sig) => {
    child.killedSignals.push(sig);
    return true;
  };
  process.nextTick(() => {
    if (stdoutObj !== undefined && stdoutObj !== null) {
      const text = typeof stdoutObj === 'string' ? stdoutObj : `${JSON.stringify(stdoutObj)}\n`;
      child.stdout.emit('data', Buffer.from(text, 'utf8'));
    }
    child.stdout.emit('end');
    child.stderr.emit('end');
    child.emit('close', code);
  });
  return child;
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
const SID = '$6';
const WID = '@6';
const PID = '%6';
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
      const emit = (body) => process.stdout.write('%begin 1 ' + seq + ' 1\\n' + body + '%end 1 ' + seq + ' 1\\n');
      const emitErr = (body) => process.stdout.write('%begin 1 ' + seq + ' 1\\n' + body + '%error 1 ' + seq + ' 1\\n');
      if (line.startsWith('has-session')) {
        const idxT = line.indexOf('-t ');
        const target = idxT >= 0 ? line.slice(idxT + 3).trim() : '';
        if (alive(target)) emit('');
        else emitErr("can't find session: " + target + '\\n');
      } else if (line.startsWith('display-message')) {
        if (line.includes('#{socket_path}')) emit(sockPath + '\\t' + SERVER_PID + '\\n');
        else if (line.includes('#{session_id}') && line.includes('#{pane_pid}')) emit(SERVER_PID + ' ' + SID + ' ' + PID + ' ' + PANE_PID + '\\n');
        else if (line.includes('#{pane_pid}')) emit(SERVER_PID + '\\t' + PANE_PID + '\\n');
        else emit('0\\t0\\t' + PID + '\\n');
      } else if (line.startsWith('capture-pane')) {
        emit('vivling [o]  esc quit · ^y yield\\n');
      } else if (line.startsWith('kill-session')) {
        save([]);
        emit('');
      } else {
        emit('');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
if (args[0] === 'new-session') {
  save([{ name: SESSION_NAME, id: SID, w: WID, p: PID }]);
  process.stdout.write(SID + ' ' + WID + ' ' + PID + '\\n');
  process.exit(0);
}
if (args[0] === 'has-session') {
  const idxT = args.indexOf('-t');
  const target = idxT >= 0 ? args[idxT + 1] : '';
  process.exit(alive(target) ? 0 : 1);
}
if (args[0] === 'display-message') {
  const fmt = args[args.length - 1] || '';
  if (fmt.includes('#{socket_path}')) process.stdout.write(sockPath + '\\t' + SERVER_PID + '\\n');
  else if (fmt.includes('#{session_id}') && fmt.includes('#{pane_pid}')) process.stdout.write(SERVER_PID + ' ' + SID + ' ' + PID + ' ' + PANE_PID + '\\n');
  else if (fmt.includes('#{pane_pid}')) process.stdout.write(SERVER_PID + '\\t' + PANE_PID + '\\n');
  else process.stdout.write('0\\t0\\t' + PID + '\\n');
  process.exit(0);
}
if (args[0] === 'capture-pane') {
  process.stdout.write('vivling [o]  esc quit · ^y yield\\n');
  process.exit(0);
}
if (args[0] === 'kill-session') {
  save([]);
  process.exit(0);
}
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
}

function createFakeVlScript(vlBin, { vlRoot, scenarioPath, uid, bootId, nsInode, startTicks }) {
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const CAPS = ['host_stop_v1', 'host_peer_identity_v1', 'host_stop_expected_v1'];
const readScen = () => {
  try { return JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf8')); }
  catch (_) { return { hostState: 'live', stopAction: 'ack' }; }
};
if (args[0] === 'host' && args[1] === 'status') {
  const sc = readScen();
  const idxSr = args.indexOf('--server-root');
  const sr = idxSr >= 0 ? args[idxSr + 1] : '';
  if (sr !== ${JSON.stringify(vlRoot)}) {
    process.stdout.write(JSON.stringify({ ok: true, state: 'none', peer_identity_support: 'supported', capabilities: CAPS }) + '\\n');
    process.exit(0);
  }
  const st = sc.ackSeen && sc.afterAckState ? sc.afterAckState : sc.hostState;
  if (st === 'none' || st === 'server_absent') {
    process.stdout.write(JSON.stringify({ ok: true, state: st, peer_identity_support: 'supported', capabilities: CAPS }) + '\\n');
    process.exit(0);
  }
  if (st === 'lock') {
    const pidVal = sc.declaredPidOverride !== undefined ? sc.declaredPidOverride : null;
    process.stdout.write(JSON.stringify({
      ok: true,
      state: 'lock',
      peer_identity_support: 'supported',
      capabilities: CAPS,
      declared_pid: pidVal,
      pid_number_in_use: pidVal !== null,
    }) + '\\n');
    process.exit(0);
  }
  const peerPid = sc.peerPidOverride !== undefined ? Number(sc.peerPidOverride) : ${Number(HOST_PID)};
  const peerTicks = sc.peerStartTicksOverride !== undefined ? String(sc.peerStartTicksOverride) : ${JSON.stringify(String(startTicks))};
  process.stdout.write(JSON.stringify({
    ok: true,
    state: st,
    peer_identity_support: 'supported',
    capabilities: CAPS,
    declared_pid: sc.declaredPidOverride !== undefined ? sc.declaredPidOverride : peerPid,
    pid_number_in_use: true,
    peer_identity: {
      schema_version: 1,
      state: 'verified',
      pid: peerPid,
      uid: ${Number(uid)},
      boot_id: ${JSON.stringify(bootId)},
      pidns: ${JSON.stringify(String(nsInode))},
      starttime: peerTicks,
      pgid: peerPid,
      sid: peerPid,
    },
  }) + '\\n');
  process.exit(0);
}
if (args[0] === 'internal' && args[1] === 'host-stop') {
  const sc = readScen();
  if (sc.stopAction === 'server_absent') {
    if (sc.relocateTo && sc.vlRootPath) {
      try { fs.rmSync(sc.vlRootPath, { recursive: true, force: true }); } catch (_) {}
      try { fs.symlinkSync(sc.relocateTo, sc.vlRootPath); } catch (_) {}
    }
    if (sc.afterAckState) {
      sc.ackSeen = true;
      fs.writeFileSync(${JSON.stringify(scenarioPath)}, JSON.stringify(sc));
    }
    process.stdout.write(JSON.stringify({ ok: false, reason: 'server_absent' }) + '\\n');
    process.exit(1);
  }
  if (sc.stopAction === 'refuse') {
    process.stdout.write(JSON.stringify({ ok: false, reason: sc.stopFailReason || 'peer_mismatch' }) + '\\n');
    process.exit(1);
  }
  if (sc.stopAction === 'timeout') {
    process.stdout.write(JSON.stringify({ ok: false, reason: sc.stopFailReason || 'timeout' }) + '\\n');
    process.exit(1);
  }
  if (sc.afterAckState) {
    sc.ackSeen = true;
    fs.writeFileSync(${JSON.stringify(scenarioPath)}, JSON.stringify(sc));
  }
  process.stdout.write(JSON.stringify({ ok: true, reason: 'shutdown_ack' }) + '\\n');
  process.exit(0);
}
process.exit(1);
`;
  fs.writeFileSync(vlBin, script, { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
}

async function attesaPgrpFiglio(pid) {
  const deadline = Date.now() + 3000;
  while (gruppo.leggiPgrp(pid) === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.notEqual(gruppo.leggiPgrp(pid), null, 'figlio dummy di test deve avere pgrp leggibile');
}

function creaMondoBar(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-be2e-'));
  fs.chmodSync(root, 0o755);
  const home = path.join(root, 'home');
  const cella = opts.cella || 'CellaBarE2E';
  const sessione = `cloud-${cella}`;
  const cellBase = vlCellBaseDir(home, OWNER, cella);
  const vlRoot = vlRoots.radiceServer(home, OWNER, cella);
  const cwd = path.join(home, cella);
  const filesRoot = path.join(home, 'NexusFiles');

  for (const d of [
    home,
    path.join(home, '.local'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.local', 'share'),
    path.join(home, '.nexuscrew'),
    path.join(home, '.nexuscrew', 'vl-cells'),
    path.join(home, '.config'),
    path.join(home, '.config', 'vl'),
    cwd,
    filesRoot,
    cellBase,
  ]) {
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
  createFakeTmuxScript(tmuxBin, {
    sessionsPath,
    deathMarkerPath,
    panePid: paneChild.pid,
    serverPid: serverProc.pid,
    sessionName: sessione,
  });

  const scenarioPath = path.join(root, 'vl-scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({ hostState: 'live', stopAction: 'ack' }));
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  createFakeVlScript(vlBin, {
    vlRoot,
    scenarioPath,
    uid: UID,
    bootId: REAL_BOOT_ID,
    nsInode: REAL_NS_INODE,
    startTicks: '4321',
  });

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'vl.native', label: 'VL', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' } }],
    cells: [{ id: cella, tmuxSession: sessione, cwd, engine: 'vl.native', boot: false }],
  });

  const syntheticHost = {
    alive: true,
    kernelObsCount: 0,
    kernelOverride: null,
  };
  const killCalls = [];
  const hostIdReal = {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId: OWNER,
    pid: HOST_PID,
    uid: UID,
    bootId: REAL_BOOT_ID,
    pidNamespaceInode: REAL_NS_INODE,
    startTicks: '4321',
    pgid: HOST_PID,
    sid: HOST_PID,
  };

  let onObservePeer = opts.onObservePeer || null;
  let onObserveKernel = opts.onObserveKernel || null;
  let onKillProcess = opts.onKillProcess || null;
  let lastPayload = null;
  const cleanupFns = [];

  function makeRuntimeInstance(budgetOverride) {
    const mgr = createLeaseManager({ home, log: () => {} });
    cleanupFns.push(() => { try { mgr.close(); } catch (_) {} });
    const runtime = createBuiltinRuntime({
      cfg: {
        launchReadyMs: 0,
        filesRoot,
        activityHooks: false,
        vlLaunchCooldownMs: 0,
        groupStopBudgetMs: budgetOverride || opts.budgetMs || 2800,
        log: () => {},
        env: {},
        vlIsolationSeams: {
          identitaNodo: () => ({ bootId: REAL_BOOT_ID, pidNamespaceInode: REAL_NS_INODE }),
          identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
          osservaPeer: (pid, instanceId) => {
            if (typeof onObservePeer === 'function') {
              const ov = onObservePeer(pid, instanceId);
              if (ov !== undefined) return ov;
            }
            return syntheticHost.alive && pid === HOST_PID
              ? { ...hostIdReal, instanceId: instanceId || OWNER }
              : null;
          },
          osservaKernel: (pid, instanceId) => {
            syntheticHost.kernelObsCount += 1;
            if (typeof onObserveKernel === 'function') {
              const ov = onObserveKernel(pid, instanceId);
              if (ov !== undefined) return ov;
            }
            if (syntheticHost.kernelOverride) return syntheticHost.kernelOverride;
            if (!syntheticHost.alive || pid !== HOST_PID) {
              return { state: 'absent', node: { bootId: REAL_BOOT_ID, pidNamespaceInode: REAL_NS_INODE } };
            }
            return {
              state: 'observed',
              processState: 'S',
              identity: { ...hostIdReal, instanceId: instanceId || OWNER },
            };
          },
          killProcess: (pid, sig) => {
            killCalls.push({ pid, sig });
            if (typeof onKillProcess === 'function') {
              onKillProcess(pid, sig);
            }
          },
        },
      },
      identityOwnerInstanceId: OWNER,
      home,
      defsPath,
      tmuxBin,
      readonly: () => false,
      launchBroker: {
        issue: async (req) => { lastPayload = req; return { socketPath: path.join(root, 'broker.sock'), nonce: 'c'.repeat(64) }; },
        revoke: async () => {},
        close: async () => {},
      },
      leaseManager: mgr,
      boot: loadDefinitions(defsPath),
    });
    cleanupFns.push(() => { try { runtime.shutdown(); } catch (_) {} });
    return { mgr, runtime };
  }

  const primary = makeRuntimeInstance();

  t.after(() => {
    for (let i = cleanupFns.length - 1; i >= 0; i -= 1) {
      cleanupFns[i]();
    }
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    try { process.kill(serverProc.pid, 'SIGKILL'); } catch (_) {}
    try { fs.chmodSync(path.dirname(vlRoot), 0o700); } catch (_) {}
    try { fs.chmodSync(vlRoot, 0o700); } catch (_) {}
    try { fs.chmodSync(root, 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function attaccaSupervisore({
    mgr = primary.mgr,
    launchId,
    token,
    autoKillGroup = true,
  } = {}) {
    const payloadCtl = (lastPayload && lastPayload.control) || {};
    const useLaunchId = launchId || payloadCtl.launchId;
    const useToken = token || payloadCtl.token;
    const pairPath = path.join(root, `pair-${hexId(4)}.sock`);
    let serverSide = null;
    const srv = net.createServer((sock) => { serverSide = sock; });
    await new Promise((resolve) => srv.listen(pairPath, resolve));
    const clientSide = await new Promise((resolve, reject) => {
      const c = net.connect(pairPath, () => resolve(c));
      c.once('error', reject);
    });
    while (!serverSide) await new Promise((r) => setTimeout(r, 10));
    assert.equal(mgr.attachInitial(cella, serverSide, { generation: 0 }), true);

    let morto = false;
    const coord = gruppo.creaCoordinatore({
      token: useToken,
      launchId: useLaunchId,
      monoNow: () => Number(process.hrtime.bigint() / 1000000n),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      killGruppo: (sig) => {
        if (!autoKillGroup || sig !== 'SIGTERM' || morto) return;
        morto = true;
        try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
        fs.writeFileSync(sessionsPath, '[]');
      },
      osserva: () => (morto
        ? { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }
        : { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }),
      invia: (frame) => leaseCtl.sendControl(frame),
      svuota: async () => { await leaseCtl.svuota(); try { clientSide.end(); } catch (_) {} },
      cancellaDelivery: async () => null,
      scriviLog: () => {},
      dichiaraStopping: () => {},
      disarmaLegacy: () => {},
      installaIgnoraTerm: () => {},
    });
    const leaseCtl = startLeaseClient(clientSide, {
      stablePath: (lastPayload && lastPayload.lease && lastPayload.lease.stablePath) || path.join(root, 'no-lease.sock'),
      launchEpoch: (lastPayload && lastPayload.lease && lastPayload.lease.launchEpoch) || hexId(8),
      onControlFrame: (frame) => coord.onFrame(frame),
    });

    const close = () => {
      try { leaseCtl.stop(); } catch (_) {}
      try { clientSide.destroy(); } catch (_) {}
      try { serverSide.destroy(); } catch (_) {}
      try { srv.close(); } catch (_) {}
    };
    cleanupFns.push(close);
    return { coord, leaseCtl, close, launchId: useLaunchId, token: useToken };
  }

  async function terminaSupervisoreESessione() {
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    const fine = Date.now() + 3000;
    while (gruppo.leggiPgrp(paneChild.pid) !== null && Date.now() < fine) {
      await new Promise((r) => setTimeout(r, 15));
    }
    fs.writeFileSync(sessionsPath, '[]');
    fs.writeFileSync(deathMarkerPath, '1');
  }

  return {
    root,
    home,
    cella,
    sessione,
    cellBase,
    vlRoot,
    filesRoot,
    sessionsPath,
    deathMarkerPath,
    paneChild,
    serverProc,
    syntheticHost,
    killCalls,
    mgr: primary.mgr,
    runtime: primary.runtime,
    creaSecondoRuntime: makeRuntimeInstance,
    attaccaSupervisore,
    terminaSupervisoreESessione,
    setOnObservePeer: (fn) => { onObservePeer = fn; },
    setOnObserveKernel: (fn) => { onObserveKernel = fn; },
    setOnKillProcess: (fn) => { onKillProcess = fn; },
    setVlScenario: (patch) => {
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')); } catch (_) {}
      fs.writeFileSync(scenarioPath, JSON.stringify({ ...cur, ...patch }));
    },
    sharedGroupId,
  };
}

  return { creaMondoBar, attesaPgrpFiglio, OWNER, HOST_PID };
})();

const LEA = (function () {

const OWNER = 'c3'.repeat(16);
const HOST_PID = 52525;
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

function hexId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function createFakeTmuxScript(tmuxBin, { sessionsPath, deathMarkerPath, crashMarkerPath, panePid, serverPid, sessionName }) {
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const sockIdx = argv.indexOf('-S');
const sockPath = sockIdx >= 0 ? argv[sockIdx + 1] : ${JSON.stringify(sharedTmuxSocketPath())};
const args = sockIdx >= 0 ? argv.slice(sockIdx + 2) : argv;
const SESSIONS_PATH = ${JSON.stringify(sessionsPath)};
const DEATH_MARKER = ${JSON.stringify(deathMarkerPath)};
const CRASH_MARKER = ${JSON.stringify(crashMarkerPath)};
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
      const emit = (body) => process.stdout.write('%begin 1 ' + seq + ' 1\\n' + body + '%end 1 ' + seq + ' 1\\n');
      const emitErr = (body) => process.stdout.write('%begin 1 ' + seq + ' 1\\n' + body + '%error 1 ' + seq + ' 1\\n');
      if (line.startsWith('has-session')) {
        const idxT = line.indexOf('-t ');
        const target = idxT >= 0 ? line.slice(idxT + 3).trim() : '';
        if (alive(target)) emit('');
        else emitErr("can't find session: " + target + '\\n');
      } else if (line.startsWith('display-message')) {
        if (line.includes('#{socket_path}')) emit(sockPath + '\\t' + SERVER_PID + '\\n');
        else if (line.includes('#{session_id}') && line.includes('#{pane_pid}')) emit(SERVER_PID + ' ' + SID + ' ' + PID + ' ' + PANE_PID + '\\n');
        else if (line.includes('#{pane_pid}')) emit(SERVER_PID + '\\t' + PANE_PID + '\\n');
        else emit('0\\t0\\t' + PID + '\\n');
      } else if (line.startsWith('capture-pane')) {
        emit('vivling [o]  esc quit · ^y yield\\n');
      } else if (line.startsWith('kill-session')) {
        if (fs.existsSync(CRASH_MARKER)) process.exit(1);
        save([]);
        emit('');
      } else {
        emit('');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
if (args[0] === 'new-session') {
  save([{ name: SESSION_NAME, id: SID, w: WID, p: PID }]);
  process.stdout.write(SID + ' ' + WID + ' ' + PID + '\\n');
  process.exit(0);
}
if (args[0] === 'has-session') {
  const idxT = args.indexOf('-t');
  const target = idxT >= 0 ? args[idxT + 1] : '';
  if (alive(target)) process.exit(0);
  process.stderr.write("can't find session: " + target + '\\n');
  process.exit(1);
}
if (args[0] === 'display-message') {
  const semiIdx = args.indexOf(';');
  const dmArgs = semiIdx >= 0 ? args.slice(1, semiIdx) : args.slice(1);
  const fmt = dmArgs[dmArgs.length - 1] || '';
  if (fmt.includes('#{socket_path}')) process.stdout.write(sockPath + '\\t' + SERVER_PID + '\\n');
  else if (fmt.includes('#{session_id}') && fmt.includes('#{pane_pid}')) process.stdout.write(SERVER_PID + ' ' + SID + ' ' + PID + ' ' + PANE_PID + '\\n');
  else if (fmt.includes('#{pane_pid}')) process.stdout.write(SERVER_PID + '\\t' + PANE_PID + '\\n');
  else if (fmt.includes('#{pid}')) process.stdout.write(SERVER_PID + '\\n');
  else process.stdout.write('0\\t0\\t' + PID + '\\n');
  if (semiIdx >= 0 && args[semiIdx + 1] === 'has-session') {
    const rest = args.slice(semiIdx + 2);
    const idxT = rest.indexOf('-t');
    const target = idxT >= 0 ? rest[idxT + 1] : '';
    if (alive(target)) process.exit(0);
    process.stderr.write("can't find session: " + target + '\\n');
    process.exit(1);
  }
  if (semiIdx >= 0 && args[semiIdx + 1] === 'list-panes') {
    // Il pane originale vive solo finche' vive la sessione che lo conteneva:
    // con la sessione rimossa tmux dichiara l'assenza del PANE (exit 1), non
    // l'assenza della sessione.
    const rest = args.slice(semiIdx + 2);
    const idxT = rest.indexOf('-t');
    const target = idxT >= 0 ? rest[idxT + 1] : '';
    if (target === PID && alive('')) { process.stdout.write(target + '\\n'); process.exit(0); }
    process.stderr.write("can't find pane: " + target + '\\n');
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === 'capture-pane') {
  process.stdout.write('vivling [o]  esc quit · ^y yield\\n');
  process.exit(0);
}
if (args[0] === 'kill-session') {
  if (fs.existsSync(CRASH_MARKER)) process.exit(1);
  save([]);
  process.exit(0);
}
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
}

function createFakeVlScript(vlBin, { vlRoot, scenarioPath, uid, bootId, nsInode, startTicks }) {
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const CAPS = ['host_stop_v1', 'host_peer_identity_v1', 'host_stop_expected_v1'];
const readScen = () => {
  try { return JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf8')); }
  catch (_) { return { hostState: 'live', stopAction: 'ack' }; }
};
if (args[0] === 'host' && args[1] === 'status') {
  const sc = readScen();
  const idxSr = args.indexOf('--server-root');
  const sr = idxSr >= 0 ? args[idxSr + 1] : '';
  if (sr !== ${JSON.stringify(vlRoot)}) {
    process.stdout.write(JSON.stringify({ ok: true, state: 'none', peer_identity_support: 'supported', capabilities: CAPS }) + '\\n');
    process.exit(0);
  }
  const st = sc.ackSeen && sc.afterAckState ? sc.afterAckState : sc.hostState;
  if (st === 'none' || st === 'server_absent') {
    process.stdout.write(JSON.stringify({ ok: true, state: st, peer_identity_support: 'supported', capabilities: CAPS }) + '\\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    state: st,
    peer_identity_support: 'supported',
    capabilities: CAPS,
    declared_pid: ${Number(HOST_PID)},
    pid_number_in_use: true,
    peer_identity: {
      schema_version: 1,
      state: 'verified',
      pid: ${Number(HOST_PID)},
      uid: ${Number(uid)},
      boot_id: ${JSON.stringify(bootId)},
      pidns: ${JSON.stringify(String(nsInode))},
      starttime: ${JSON.stringify(String(startTicks))},
      pgid: ${Number(HOST_PID)},
      sid: ${Number(HOST_PID)},
    },
  }) + '\\n');
  process.exit(0);
}
if (args[0] === 'internal' && args[1] === 'host-stop') {
  const sc = readScen();
  if (sc.stopAction === 'stopped') {
    process.stdout.write(JSON.stringify({ ok: true, reason: 'already_stopped' }) + '\\n');
    process.exit(0);
  }
  if (sc.afterAckState) {
    sc.ackSeen = true;
    fs.writeFileSync(${JSON.stringify(scenarioPath)}, JSON.stringify(sc));
  }
  process.stdout.write(JSON.stringify({ ok: true, reason: 'shutdown_ack' }) + '\\n');
  process.exit(0);
}
process.exit(1);
`;
  fs.writeFileSync(vlBin, script, { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
}

async function attesaPgrpFiglio(pid) {
  const deadline = Date.now() + 3000;
  while (gruppo.leggiPgrp(pid) === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.notEqual(gruppo.leggiPgrp(pid), null, 'figlio dummy di test deve avere pgrp leggibile');
}

async function untilNotLive(mgr, cellId, timeoutMs = 2000) {
  const t0 = Date.now();
  for (;;) {
    const st = mgr.status(cellId);
    if (st.state !== 'live') return st;
    if (Date.now() - t0 > timeoutMs) return st;
    await new Promise((r) => setTimeout(r, 5));
  }
}

function sendJsonLine(socket, msg, predicate) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => { cleanup(); reject(new Error('recv timeout')); }, 3000);
    function cleanup() { clearTimeout(to); socket.removeListener('data', onData); }
    function onData(chunk) {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let parsed;
        try { parsed = JSON.parse(line); } catch (_) { continue; }
        if (!predicate || predicate(parsed)) { cleanup(); resolve(parsed); return; }
      }
    }
    socket.on('data', onData);
    socket.write(`${JSON.stringify(msg)}\n`);
  });
}

function creaMondoLea(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-le2e-'));
  fs.chmodSync(root, 0o755);
  const home = path.join(root, 'home');
  const cella = opts.cella || 'CellaLeaE2E';
  const sessione = `cloud-${cella}`;
  const cellBase = vlCellBaseDir(home, OWNER, cella);
  const vlRoot = vlRoots.radiceServer(home, OWNER, cella);
  const cwd = path.join(home, cella);
  const filesRoot = path.join(home, 'NexusFiles');

  for (const d of [
    home,
    path.join(home, '.local'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.local', 'share'),
    path.join(home, '.nexuscrew'),
    path.join(home, '.nexuscrew', 'vl-cells'),
    path.join(home, '.config'),
    path.join(home, '.config', 'vl'),
    cwd,
    filesRoot,
    cellBase,
  ]) {
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
  const crashMarkerPath = path.join(root, 'tmux-crash');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  createFakeTmuxScript(tmuxBin, {
    sessionsPath,
    deathMarkerPath,
    crashMarkerPath,
    panePid: paneChild.pid,
    serverPid: serverProc.pid,
    sessionName: sessione,
  });

  const scenarioPath = path.join(root, 'vl-scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({ hostState: 'live', stopAction: 'ack' }));
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  createFakeVlScript(vlBin, {
    vlRoot,
    scenarioPath,
    uid: UID,
    bootId: REAL_BOOT_ID,
    nsInode: REAL_NS_INODE,
    startTicks: '5432',
  });

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'vl.native', label: 'VL', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' } }],
    cells: [{ id: cella, tmuxSession: sessione, cwd, engine: 'vl.native', boot: false }],
  });

  const leaseClock = {
    now: Number.isFinite(opts.initialLeaseNow) ? opts.initialLeaseNow : 10000,
    mono: Number.isFinite(opts.initialLeaseMono) ? opts.initialLeaseMono : 10000,
  };
  const runtimeMono = {
    now: Number.isFinite(opts.initialRuntimeMono) ? opts.initialRuntimeMono : 20000,
  };
  let monoTick = 0;

  const syntheticHost = {
    alive: true,
    kernelObsCount: 0,
  };
  const killCalls = [];
  const revokeControlCalls = [];
  let statusOverride = null;
  let onKillProcess = null;

  const hostIdReal = {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId: OWNER,
    pid: HOST_PID,
    uid: UID,
    bootId: REAL_BOOT_ID,
    pidNamespaceInode: REAL_NS_INODE,
    startTicks: '5432',
    pgid: HOST_PID,
    sid: HOST_PID,
  };

  let lastPayload = null;
  const cleanupFns = [];

  function wrapLeaseManager(mgrRaw) {
    return new Proxy(mgrRaw, {
      get(target, prop) {
        if (prop === 'status') {
          return (id) => {
            const base = target.status(id);
            if (typeof statusOverride === 'function') {
              return statusOverride(id, base);
            }
            return base;
          };
        }
        if (prop === 'revokeControl') {
          return (id) => {
            const rec = launchTarget.leggi(filesRoot, sessione);
            revokeControlCalls.push({
              cellId: id,
              recordPresent: rec.stato === 'presente',
              at: Date.now(),
            });
            return target.revokeControl(id);
          };
        }
        return Reflect.get(target, prop);
      },
    });
  }

  const sharedMgrRaw = opts.mgrRaw || createLeaseManager(
    { home, log: () => {} },
    { now: () => leaseClock.now, monotonicNow: () => leaseClock.mono },
  );
  if (!opts.mgrRaw) {
    cleanupFns.push(() => { try { sharedMgrRaw.close(); } catch (_) {} });
  }

  function makeRuntimeInstance(budgetMs = opts.budgetMs || 2800) {
    const mgrRaw = sharedMgrRaw;
    const mgr = wrapLeaseManager(mgrRaw);

    const runtime = createBuiltinRuntime({
      cfg: {
        filesRoot,
        // The vl catalog path is resolved from XDG_CONFIG_HOME first: pin it to
        // this fixture's home so the test never reads the runner's HOME/XDG.
        env: { ...process.env, XDG_CONFIG_HOME: path.join(home, '.config') },
        groupStopBudgetMs: budgetMs,
        ...(opts.customMono ? { monotonicNow: () => runtimeMono.now } : {
          monotonicNow: () => {
            monoTick += 1;
            return Number(process.hrtime.bigint() / 1000000n) + monoTick;
          },
        }),
        vlIsolationSeams: {
          identitaNodo: () => ({ bootId: REAL_BOOT_ID, pidNamespaceInode: REAL_NS_INODE }),
          identitaCoordinatore: () => ({ pgid: process.pid, sid: process.pid }),
          osservaPeer: (pid, instanceId) => {
            if (!syntheticHost.alive || pid !== HOST_PID) return null;
            return { ...hostIdReal, instanceId: instanceId || OWNER };
          },
          osservaKernel: (pid, instanceId) => {
            syntheticHost.kernelObsCount += 1;
            if (!syntheticHost.alive || pid !== HOST_PID) {
              return { state: 'absent', node: { bootId: REAL_BOOT_ID, pidNamespaceInode: REAL_NS_INODE } };
            }
            return {
              state: 'observed',
              processState: 'S',
              identity: { ...hostIdReal, instanceId: instanceId || OWNER },
            };
          },
          killProcess: (pid, sig) => {
            killCalls.push({ pid, sig });
            if (typeof onKillProcess === 'function') onKillProcess(pid, sig);
          },
        },
      },
      identityOwnerInstanceId: OWNER,
      home,
      defsPath,
      tmuxBin,
      readonly: () => false,
      launchBroker: {
        issue: async (req) => { lastPayload = req; return { socketPath: path.join(root, 'broker.sock'), nonce: 'd'.repeat(64) }; },
        revoke: async () => {},
        close: async () => {},
      },
      leaseManager: mgr,
      boot: loadDefinitions(defsPath),
    });
    cleanupFns.push(() => { try { runtime.shutdown(); } catch (_) {} });
    return { mgrRaw, mgr, runtime };
  }

  const primary = makeRuntimeInstance();

  t.after(() => {
    for (let i = cleanupFns.length - 1; i >= 0; i -= 1) {
      cleanupFns[i]();
    }
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    try { process.kill(serverProc.pid, 'SIGKILL'); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function attaccaSupervisore({ captureProof = false, mgr = primary.mgrRaw } = {}) {
    const payloadCtl = (lastPayload && lastPayload.control) || {};
    const pairPath = path.join(root, `pair-${hexId(4)}.sock`);
    let serverSide = null;
    const srv = net.createServer((sock) => { serverSide = sock; });
    await new Promise((resolve) => srv.listen(pairPath, resolve));
    const clientSide = await new Promise((resolve, reject) => {
      const c = net.connect(pairPath, () => resolve(c));
      c.once('error', reject);
    });
    while (!serverSide) await new Promise((r) => setTimeout(r, 10));
    assert.equal(mgr.attachInitial(cella, serverSide, { generation: 0 }), true);

    let proof = null;
    if (captureProof) {
      const ack = await sendJsonLine(clientSide, { type: 'refresh' }, (m) => m.type === 'ack' && m.proof);
      proof = ack.proof;
    }

    let morto = false;
    let leaseCtl = null;
    const coord = gruppo.creaCoordinatore({
      token: payloadCtl.token,
      launchId: payloadCtl.launchId,
      monoNow: () => Number(process.hrtime.bigint() / 1000000n),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      killGruppo: (sig) => {
        if (sig !== 'SIGTERM' || morto) return;
        morto = true;
        try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
        fs.writeFileSync(sessionsPath, '[]');
      },
      osserva: () => (morto
        ? { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }
        : { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }),
      invia: (frame) => leaseCtl.sendControl(frame),
      svuota: async () => { await leaseCtl.svuota(); try { clientSide.end(); } catch (_) {} },
      cancellaDelivery: async () => null,
      scriviLog: () => {},
      dichiaraStopping: () => {},
      disarmaLegacy: () => {},
      installaIgnoraTerm: () => {},
    });

    leaseCtl = startLeaseClient(clientSide, {
      stablePath: (lastPayload && lastPayload.lease && lastPayload.lease.stablePath) || path.join(root, 'no-lease.sock'),
      launchEpoch: (lastPayload && lastPayload.lease && lastPayload.lease.launchEpoch) || hexId(8),
      onControlFrame: (frame) => coord.onFrame(frame),
    });

    const close = () => {
      try { leaseCtl.stop(); } catch (_) {}
      try { clientSide.destroy(); } catch (_) {}
      try { serverSide.destroy(); } catch (_) {}
      try { srv.close(); } catch (_) {}
    };
    cleanupFns.push(close);
    return {
      proof,
      stablePath: lastPayload && lastPayload.lease && lastPayload.lease.stablePath,
      close,
    };
  }

  async function terminaSupervisoreESessione() {
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    const fine = Date.now() + 3000;
    while (gruppo.leggiPgrp(paneChild.pid) !== null && Date.now() < fine) {
      await new Promise((r) => setTimeout(r, 15));
    }
    fs.writeFileSync(sessionsPath, '[]');
    fs.writeFileSync(deathMarkerPath, '1');
  }

  return {
    root,
    home,
    cella,
    sessione,
    vlRoot,
    filesRoot,
    crashMarkerPath,
    paneChild,
    leaseClock,
    runtimeMono,
    syntheticHost,
    killCalls,
    revokeControlCalls,
    mgr: primary.mgr,
    mgrRaw: primary.mgrRaw,
    runtime: primary.runtime,
    creaSecondoRuntime: (budgetMs = 2800) => makeRuntimeInstance(budgetMs),
    attaccaSupervisore,
    terminaSupervisoreESessione,
    setStatusOverride: (fn) => { statusOverride = fn; },
    setOnKillProcess: (fn) => { onKillProcess = fn; },
    setVlScenario: (patch) => {
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')); } catch (_) {}
      fs.writeFileSync(scenarioPath, JSON.stringify({ ...cur, ...patch }));
    },
  };
}

  return { creaMondoLea, attesaPgrpFiglio, untilNotLive, sendJsonLine, HOST_PID };
})();

const BUD = (function () {

const MODULE_PATH = path.join(__dirname, '../lib/fleet/vl-host-recovery.js');
const PUB_EXCL = pubblicaEsclusiva || publishExclusive;

const OWNER = 'd4'.repeat(16);
const BOOT_ID = '33345678-1234-4234-8234-123456789abc';
const PID_NS = '4026531836';
const HOST_PID = 53535;
const COORD_PID = 99994;
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
    startTicks: '6543',
    pgid: HOST_PID,
    sid: HOST_PID,
    ...overrides,
  };
}

function assertFactoryMethods(factory, id) {
  assert.equal(typeof factory?.openAttempt, 'function', `${id}: factory.openAttempt mancante`);
  assert.equal(typeof factory?.runExpected, 'function', `${id}: factory.runExpected mancante`);
  assert.equal(typeof factory?.recover, 'function', `${id}: factory.recover mancante`);
  assert.equal(typeof factory?.readTrace, 'function', `${id}: factory.readTrace mancante`);
  assert.equal(typeof factory?.closeAttempt, 'function', `${id}: factory.closeAttempt mancante`);
}

// A stop that could not complete answers with an outcome of the failure family
// the contract provides, carrying a code; never a success and never a free
// string.
function assertEsitoFallimento(out, id) {
  assert.ok(out && typeof out === 'object', `${id}: recover deve restituire un oggetto`);
  assert.equal(out.outcome, 'host-stop-failed', `${id}: esito della famiglia di fallimento prevista`);
  assert.equal(typeof out.code, 'string', `${id}: il fallimento porta un codice`);
  assert.ok(out.code.length > 0, `${id}: il codice del fallimento non e' vuoto`);
}

function creaUnitFixture(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bud-'));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  const ncDir = path.join(home, '.nexuscrew');
  const ownerDir = path.join(ncDir, 'vl-instances', OWNER);
  const cellId = opts.cellId || 'CellaBud';
  const cellBase = vlCellBaseDir(home, OWNER, cellId);
  const stateDir = opts.useCellBase ? cellBase : path.join(ownerDir, cellId);
  const serverRoot = opts.useCellBase
    ? vlRoots.radiceServer(home, OWNER, cellId)
    : path.join(ncDir, 'vl-roots', cellId);
  const xdgState = path.join(home, '.local', 'state');
  const xdgData = path.join(home, '.local', 'share');
  const xdgConfig = path.join(home, '.config');

  for (const d of [
    home,
    ncDir,
    path.join(ncDir, 'vl-instances'),
    ownerDir,
    stateDir,
    path.join(cellBase, 'state'),
    path.join(cellBase, 'state', 'vl'),
    serverRoot,
    xdgState,
    xdgData,
    xdgConfig,
  ]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const vlBin = path.join(root, 'vl');
  fs.writeFileSync(vlBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const pin = hostStop.pinBinario({ source: vlBin, home, owner: OWNER, cellId });
  assert.equal(pin.ok, true);

  const record = {
    launchId: hexId(8),
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

  return { root, home, ncDir, cellId, cellBase, stateDir, serverRoot, bin: pin.path, record };
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
const SID = '$9';
const WID = '@9';
const PID = '%9';
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
      const emit = (body) => process.stdout.write('%begin 1 ' + seq + ' 1\\n' + body + '%end 1 ' + seq + ' 1\\n');
      const emitErr = (body) => process.stdout.write('%begin 1 ' + seq + ' 1\\n' + body + '%error 1 ' + seq + ' 1\\n');
      if (line.startsWith('has-session')) {
        const idxT = line.indexOf('-t ');
        const target = idxT >= 0 ? line.slice(idxT + 3).trim() : '';
        if (alive(target)) emit('');
        else emitErr("can't find session: " + target + '\\n');
      } else if (line.startsWith('display-message')) {
        if (line.includes('#{socket_path}')) emit(sockPath + '\\t' + SERVER_PID + '\\n');
        else if (line.includes('#{session_id}') && line.includes('#{pane_pid}')) emit(SERVER_PID + ' ' + SID + ' ' + PID + ' ' + PANE_PID + '\\n');
        else if (line.includes('#{pane_pid}')) emit(SERVER_PID + '\\t' + PANE_PID + '\\n');
        else emit('0\\t0\\t' + PID + '\\n');
      } else if (line.startsWith('capture-pane')) {
        emit('vivling [o]  esc quit · ^y yield\\n');
      } else if (line.startsWith('kill-session')) {
        save([]);
        emit('');
      } else {
        emit('');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
if (args[0] === 'new-session') {
  save([{ name: SESSION_NAME, id: SID, w: WID, p: PID }]);
  process.stdout.write(SID + ' ' + WID + ' ' + PID + '\\n');
  process.exit(0);
}
if (args[0] === 'has-session') {
  const idxT = args.indexOf('-t');
  const target = idxT >= 0 ? args[idxT + 1] : '';
  if (alive(target)) process.exit(0);
  process.stderr.write("can't find session: " + target + '\\n');
  process.exit(1);
}
if (args[0] === 'display-message') {
  const semiIdx = args.indexOf(';');
  const dmArgs = semiIdx >= 0 ? args.slice(1, semiIdx) : args.slice(1);
  const fmt = dmArgs[dmArgs.length - 1] || '';
  if (fmt.includes('#{socket_path}')) process.stdout.write(sockPath + '\\t' + SERVER_PID + '\\n');
  else if (fmt.includes('#{session_id}') && fmt.includes('#{pane_pid}')) process.stdout.write(SERVER_PID + ' ' + SID + ' ' + PID + ' ' + PANE_PID + '\\n');
  else if (fmt.includes('#{pane_pid}')) process.stdout.write(SERVER_PID + '\\t' + PANE_PID + '\\n');
  else if (fmt.includes('#{pid}')) process.stdout.write(SERVER_PID + '\\n');
  else process.stdout.write('0\\t0\\t' + PID + '\\n');
  if (semiIdx >= 0 && args[semiIdx + 1] === 'has-session') {
    const rest = args.slice(semiIdx + 2);
    const idxT = rest.indexOf('-t');
    const target = idxT >= 0 ? rest[idxT + 1] : '';
    if (alive(target)) process.exit(0);
    process.stderr.write("can't find session: " + target + '\\n');
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === 'capture-pane') {
  process.stdout.write('vivling [o]  esc quit · ^y yield\\n');
  process.exit(0);
}
if (args[0] === 'kill-session') {
  save([]);
  process.exit(0);
}
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
}

function createFakeVlScript(vlBin, { vlRoot, scenarioPath, uid, bootId, nsInode, startTicks, stopLogPath }) {
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const CAPS = ['host_stop_v1', 'host_peer_identity_v1', 'host_stop_expected_v1'];
const readScen = () => {
  try { return JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf8')); }
  catch (_) { return { hostState: 'live', stopAction: 'ack' }; }
};
const bumpClock = (ms) => {
  if (!ms) return;
  const sc = readScen();
  sc.clockBumpMs = Number(sc.clockBumpMs || 0) + Number(ms);
  fs.writeFileSync(${JSON.stringify(scenarioPath)}, JSON.stringify(sc));
};
if (args[0] === 'host' && args[1] === 'status') {
  const sc = readScen();
  if (sc.statusAdvanceMs) bumpClock(sc.statusAdvanceMs);
  const idxSr = args.indexOf('--server-root');
  const sr = idxSr >= 0 ? args[idxSr + 1] : '';
  if (sr !== ${JSON.stringify(vlRoot)}) {
    process.stdout.write(JSON.stringify({ ok: true, state: 'none', peer_identity_support: 'supported', capabilities: CAPS }) + '\\n');
    process.exit(0);
  }
  const st = sc.ackSeen && sc.afterAckState ? sc.afterAckState : sc.hostState;
  if (st === 'none' || st === 'server_absent') {
    process.stdout.write(JSON.stringify({ ok: true, state: st, peer_identity_support: 'supported', capabilities: CAPS }) + '\\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    state: st,
    peer_identity_support: 'supported',
    capabilities: CAPS,
    declared_pid: ${Number(HOST_PID)},
    pid_number_in_use: true,
    peer_identity: sc.badPeerIdentity ? { schema_version: 1, state: 'unverified' } : {
      schema_version: 1,
      state: 'verified',
      pid: ${Number(HOST_PID)},
      uid: ${Number(uid)},
      boot_id: ${JSON.stringify(bootId)},
      pidns: ${JSON.stringify(String(nsInode))},
      starttime: ${JSON.stringify(String(startTicks))},
      pgid: ${Number(HOST_PID)},
      sid: ${Number(HOST_PID)},
    },
  }) + '\\n');
  process.exit(0);
}
if (args[0] === 'internal' && args[1] === 'host-stop') {
  const sc = readScen();
  fs.appendFileSync(${JSON.stringify(stopLogPath)}, JSON.stringify({ args }) + '\\n');
  if (sc.stopAdvanceMs) {
    sc.clockBumpMs = Number(sc.clockBumpMs || 0) + Number(sc.stopAdvanceMs);
  }
  if (sc.afterAckState) {
    sc.ackSeen = true;
  }
  if (sc.stopAdvanceMs || sc.afterAckState) {
    fs.writeFileSync(${JSON.stringify(scenarioPath)}, JSON.stringify(sc));
  }
  if (sc.stopAction === 'stopped') {
    process.stdout.write(JSON.stringify({ ok: true, reason: 'already_stopped' }) + '\\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ ok: true, reason: 'shutdown_ack' }) + '\\n');
  process.exit(0);
}
process.exit(1);
`;
  fs.writeFileSync(vlBin, script, { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
}

async function attesaPgrpFiglio(pid) {
  const deadline = Date.now() + 3000;
  while (gruppo.leggiPgrp(pid) === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.notEqual(gruppo.leggiPgrp(pid), null, 'figlio dummy di test deve avere pgrp leggibile');
}

function creaMondoBud(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-be9e-'));
  fs.chmodSync(root, 0o755);
  const home = path.join(root, 'home');
  const cella = opts.cella || 'CellaBudE2E';
  const sessione = `cloud-${cella}`;
  const cellBase = vlCellBaseDir(home, OWNER, cella);
  const vlRoot = vlRoots.radiceServer(home, OWNER, cella);
  const cwd = path.join(home, cella);
  const filesRoot = path.join(home, 'NexusFiles');

  for (const d of [
    home,
    path.join(home, '.local'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.local', 'share'),
    path.join(home, '.nexuscrew'),
    path.join(home, '.nexuscrew', 'vl-cells'),
    path.join(home, '.config'),
    path.join(home, '.config', 'vl'),
    cwd,
    filesRoot,
    cellBase,
  ]) {
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
  createFakeTmuxScript(tmuxBin, {
    sessionsPath,
    deathMarkerPath,
    panePid: paneChild.pid,
    serverPid: serverProc.pid,
    sessionName: sessione,
  });

  const scenarioPath = path.join(root, 'vl-scenario.json');
  const stopLogPath = path.join(root, 'vl-stop-calls.jsonl');
  fs.writeFileSync(scenarioPath, JSON.stringify({ hostState: 'live', stopAction: 'ack', clockBumpMs: 0 }));
  fs.writeFileSync(stopLogPath, '');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  createFakeVlScript(vlBin, {
    vlRoot,
    scenarioPath,
    uid: UID,
    bootId: REAL_BOOT_ID,
    nsInode: REAL_NS_INODE,
    startTicks: '6543',
    stopLogPath,
  });

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'vl.native', label: 'VL', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' } }],
    cells: [{ id: cella, tmuxSession: sessione, cwd, engine: 'vl.native', boot: false }],
  });

  const hostIdReal = {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId: OWNER,
    pid: HOST_PID,
    uid: UID,
    bootId: REAL_BOOT_ID,
    pidNamespaceInode: REAL_NS_INODE,
    startTicks: '6543',
    pgid: HOST_PID,
    sid: HOST_PID,
  };

  const syntheticHost = {
    alive: true,
    kernelObsCount: 0,
    kernelOverride: null,
  };
  const killCalls = [];
  const brokerState = { issueCount: 0, lastPayload: null };
  let baseMono = 100000;
  let monoTick = 0;
  let onObservePeer = null;
  let onObserveKernel = null;
  let onKillProcess = null;
  let onBrokerIssue = null;

  const cleanupFns = [];
  const mgr = createLeaseManager({ home, log: () => {} });
  cleanupFns.push(() => { try { mgr.close(); } catch (_) {} });

  function readMono() {
    if (opts.useScenarioClock) {
      let bump = 0;
      try { bump = Number(JSON.parse(fs.readFileSync(scenarioPath, 'utf8')).clockBumpMs || 0); } catch (_) {}
      return baseMono + bump;
    }
    monoTick += 1;
    return Number(process.hrtime.bigint() / 1000000n) + monoTick;
  }

  function makeRuntimeInstance(budgetMs = opts.budgetMs || 2800) {
    const runtime = createBuiltinRuntime({
      cfg: {
        filesRoot,
        groupStopBudgetMs: budgetMs,
        ...(Number.isFinite(opts.readinessRollbackMs) ? { readinessRollbackMs: opts.readinessRollbackMs } : {}),
        ...(opts.readinessRollbackSeams ? { readinessRollbackSeams: opts.readinessRollbackSeams } : {}),
        monotonicNow: readMono,
        vlIsolationSeams: {
          identitaNodo: () => ({ bootId: REAL_BOOT_ID, pidNamespaceInode: REAL_NS_INODE }),
          identitaCoordinatore: () => ({ pgid: process.pid, sid: process.pid }),
          osservaPeer: (pid, instanceId) => {
            if (typeof onObservePeer === 'function') {
              const ov = onObservePeer(pid, instanceId);
              if (ov !== undefined) return ov;
            }
            if (!syntheticHost.alive || pid !== HOST_PID) return null;
            return { ...hostIdReal, instanceId: instanceId || OWNER };
          },
          osservaKernel: (pid, instanceId) => {
            syntheticHost.kernelObsCount += 1;
            if (typeof onObserveKernel === 'function') {
              const ov = onObserveKernel(pid, instanceId);
              if (ov !== undefined) return ov;
            }
            if (syntheticHost.kernelOverride) return syntheticHost.kernelOverride;
            if (!syntheticHost.alive || pid !== HOST_PID) {
              return { state: 'absent', node: { bootId: REAL_BOOT_ID, pidNamespaceInode: REAL_NS_INODE } };
            }
            return {
              state: 'observed',
              processState: 'S',
              identity: { ...hostIdReal, instanceId: instanceId || OWNER },
            };
          },
          killProcess: (pid, sig) => {
            killCalls.push({ pid, sig });
            if (typeof onKillProcess === 'function') onKillProcess(pid, sig);
          },
        },
      },
      identityOwnerInstanceId: OWNER,
      home,
      defsPath,
      tmuxBin,
      readonly: () => false,
      launchBroker: {
        issue: async (req) => {
          brokerState.issueCount += 1;
          brokerState.lastPayload = req;
          if (typeof onBrokerIssue === 'function') await onBrokerIssue(req);
          return { socketPath: path.join(root, 'broker.sock'), nonce: 'e'.repeat(64) };
        },
        revoke: async () => {},
        close: async () => {},
      },
      leaseManager: mgr,
      boot: loadDefinitions(defsPath),
    });
    cleanupFns.push(() => { try { runtime.shutdown(); } catch (_) {} });
    return { mgr, runtime };
  }

  const primary = makeRuntimeInstance();

  t.after(() => {
    for (let i = cleanupFns.length - 1; i >= 0; i -= 1) {
      cleanupFns[i]();
    }
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    try { process.kill(serverProc.pid, 'SIGKILL'); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function attaccaSupervisore(payloadOverride = null) {
    const payload = payloadOverride || brokerState.lastPayload || {};
    const payloadCtl = payload.control || {};
    const pairPath = path.join(root, `pair-${hexId(4)}.sock`);
    let serverSide = null;
    const srv = net.createServer((sock) => { serverSide = sock; });
    await new Promise((resolve) => srv.listen(pairPath, resolve));
    const clientSide = await new Promise((resolve, reject) => {
      const c = net.connect(pairPath, () => resolve(c));
      c.once('error', reject);
    });
    while (!serverSide) await new Promise((r) => setTimeout(r, 10));
    assert.equal(mgr.attachInitial(cella, serverSide, { generation: 0 }), true);

    let morto = false;
    let leaseCtl = null;
    const coord = gruppo.creaCoordinatore({
      token: payloadCtl.token,
      launchId: payloadCtl.launchId,
      monoNow: () => Number(process.hrtime.bigint() / 1000000n),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      killGruppo: (sig) => {
        if (sig !== 'SIGTERM' || morto) return;
        morto = true;
        try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
        fs.writeFileSync(sessionsPath, '[]');
      },
      osserva: () => (morto
        ? { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }
        : { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }),
      invia: (frame) => leaseCtl.sendControl(frame),
      svuota: async () => { await leaseCtl.svuota(); try { clientSide.end(); } catch (_) {} },
      cancellaDelivery: async () => null,
      scriviLog: () => {},
      dichiaraStopping: () => {},
      disarmaLegacy: () => {},
      installaIgnoraTerm: () => {},
    });

    leaseCtl = startLeaseClient(clientSide, {
      stablePath: (payload.lease && payload.lease.stablePath) || path.join(root, 'no-lease.sock'),
      launchEpoch: (payload.lease && payload.lease.launchEpoch) || hexId(8),
      onControlFrame: (frame) => coord.onFrame(frame),
    });

    const close = () => {
      try { leaseCtl.stop(); } catch (_) {}
      try { clientSide.destroy(); } catch (_) {}
      try { serverSide.destroy(); } catch (_) {}
      try { srv.close(); } catch (_) {}
    };
    cleanupFns.push(close);
    return { close };
  }

  async function terminaSupervisoreESessione() {
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    const fine = Date.now() + 3000;
    while (gruppo.leggiPgrp(paneChild.pid) !== null && Date.now() < fine) {
      await new Promise((r) => setTimeout(r, 15));
    }
    fs.writeFileSync(sessionsPath, '[]');
    fs.writeFileSync(deathMarkerPath, '1');
  }

  return {
    root,
    home,
    cella,
    sessione,
    vlRoot,
    filesRoot,
    paneChild,
    hostIdReal,
    syntheticHost,
    killCalls,
    brokerState,
    mgr,
    runtime: primary.runtime,
    creaSecondoRuntime: (budgetMs = 2800) => makeRuntimeInstance(budgetMs),
    attaccaSupervisore,
    terminaSupervisoreESessione,
    advanceBaseMono: (ms) => { baseMono += Number(ms); },
    setOnObservePeer: (fn) => { onObservePeer = fn; },
    setOnObserveKernel: (fn) => { onObserveKernel = fn; },
    setOnKillProcess: (fn) => { onKillProcess = fn; },
    setOnBrokerIssue: (fn) => { onBrokerIssue = fn; },
    setVlScenario: (patch) => {
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')); } catch (_) {}
      fs.writeFileSync(scenarioPath, JSON.stringify({ ...cur, ...patch }));
    },
    readStopCalls: () => fs.readFileSync(stopLogPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

  return { creaMondoBud, attesaPgrpFiglio, HOST_PID };
})();

const FEN = (function () {
const MODULE_PATH = path.join(__dirname, '../lib/fleet/vl-host-recovery.js');
const PUB_EXCL = pubblicaEsclusiva || publishExclusive;

const OWNER = 'ef'.repeat(16);
const BOOT_ID = '32345678-1234-4234-8234-123456789abc';
const PID_NS = '4026531836';
const HOST_PID = 6161;
const COORD_PID = 99997;
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

const EVENT_KINDS = [
  'cli-attempt',
  'peer-verified',
  'cli-ack',
  'cli-refusal',
  'cli-failed',
  'intent-term',
  'signaled-term',
  'intent-kill',
  'signaled-kill',
  'exited',
  'closed',
];

const CONTEXT_ALLOWED_KEYS = [
  'launchId',
  'vlBin',
  'vlBinSha256',
  'XDG_STATE_HOME',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'HOME',
  'uid',
  'serverRoot',
  'ts',
  'version',
  'hostIdentity',
];

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
    startTicks: '2468',
    pgid: HOST_PID,
    sid: HOST_PID,
    ...overrides,
  };
}

function computeContextDigest(record) {
  const h = record.hostIdentity;
  const tuple = [
    record.launchId,
    record.vlBinSha256,
    record.serverRoot,
    h.source,
    h.instanceId,
    h.pid,
    h.uid,
    h.bootId,
    h.pidNamespaceInode,
    h.startTicks,
    h.pgid,
    h.sid,
  ];
  return crypto.createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex');
}

function canonicalEventLine({
  version = 1,
  launchId,
  attemptId,
  seq,
  kind,
  contextDigest,
  method,
  reason,
}) {
  const ordered = {
    version,
    launchId,
    attemptId,
    seq,
    kind,
    contextDigest,
  };
  if (method !== undefined) ordered.method = method;
  if (reason !== undefined) ordered.reason = reason;
  return `${JSON.stringify(ordered)}\n`;
}

function recoveryEventFilename(seq, kind) {
  return `${String(seq).padStart(8, '0')}-${kind}.json`;
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

function seedRecoveryEvent(stateDir, ev) {
  const dir = path.join(stateDir, 'recovery-events');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const full = path.join(dir, recoveryEventFilename(ev.seq, ev.kind));
  const line = canonicalEventLine(ev);
  fs.writeFileSync(full, line, { mode: 0o600 });
  fs.chmodSync(full, 0o600);
  return { path: full, line };
}

// Seed of an admissible history of exactly `count` store entries: every attempt
// is opened and then closed by its own terminal event, so no attempt is left
// open and no refusal is left unresolved. A single three-event group is used
// when the requested count is odd, because the boundary counts files, not
// attempts. Callers use this at the capacity boundary, where the seeded
// history must not be the reason a preflight is refused.
function seedStoriaAmmissibile(stateDir, record, count) {
  const contextDigest = computeContextDigest(record);
  const gruppi = [];
  let resto = count;
  if (resto % 2 === 1) {
    gruppi.push(3);
    resto -= 3;
  }
  while (resto > 0) {
    gruppi.push(2);
    resto -= 2;
  }
  assert.ok(resto === 0 && gruppi.length > 0, `storia ammissibile: ${count} voci rappresentabili`);
  let seq = 1;
  for (const size of gruppi) {
    const attemptId = hexId(16);
    const base = { launchId: record.launchId, attemptId, contextDigest };
    seedRecoveryEvent(stateDir, { ...base, seq: seq++, kind: 'cli-attempt' });
    if (size === 3) {
      seedRecoveryEvent(stateDir, { ...base, seq: seq++, kind: 'cli-failed', reason: 'spawn' });
    }
    seedRecoveryEvent(stateDir, { ...base, seq: seq++, kind: 'closed', method: null });
  }
  assert.equal(seq - 1, count, `storia ammissibile: ${count} voci seminate`);
}

function assertFactoryMethods(factory, id) {
  assert.equal(typeof factory?.openAttempt, 'function', `${id}: factory.openAttempt mancante`);
  assert.equal(typeof factory?.recover, 'function', `${id}: factory.recover mancante`);
  assert.equal(typeof factory?.readTrace, 'function', `${id}: factory.readTrace mancante`);
  assert.equal(typeof factory?.closeAttempt, 'function', `${id}: factory.closeAttempt mancante`);
}

// A recovery that could not complete the stop answers with an outcome of the
// failure family the contract already provides for that case, carrying a code.
// The assertion is closed on purpose: a free string, and in particular any
// outcome that reads as a success ("clean", "already stopped", "not vl"), must
// not pass where the trace, the store or the intent publication failed.
function assertEsitoFallimento(out, id) {
  assert.ok(out && typeof out === 'object', `${id}: recover deve restituire un oggetto`);
  assert.equal(out.outcome, 'host-stop-failed', `${id}: esito della famiglia di fallimento prevista`);
  assert.equal(typeof out.code, 'string', `${id}: il fallimento porta un codice`);
  assert.ok(out.code.length > 0, `${id}: il codice del fallimento non e' vuoto`);
}

function creaUnitFixture(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fen-'));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  const ncDir = path.join(home, '.nexuscrew');
  const ownerDir = path.join(ncDir, 'vl-instances', OWNER);
  const cellId = opts.cellId || 'CellaFen';
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
    try { fs.chmodSync(path.join(stateDir, 'recovery-events'), 0o700); } catch (_) {}
    try { fs.chmodSync(stateDir, 0o700); } catch (_) {}
    try { fs.chmodSync(root, 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const vlBin = path.join(root, 'vl');
  fs.writeFileSync(vlBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const pin = hostStop.pinBinario({ source: vlBin, home, owner: OWNER, cellId });
  assert.equal(pin.ok, true);

  const record = {
    launchId: hexId(8),
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

  return { root, home, ncDir, cellId, stateDir, serverRoot, bin: pin.path, record };
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
      const emit = (body) => process.stdout.write('%begin 1 ' + seq + ' 1\\n' + body + '%end 1 ' + seq + ' 1\\n');
      const emitErr = (body) => process.stdout.write('%begin 1 ' + seq + ' 1\\n' + body + '%error 1 ' + seq + ' 1\\n');
      if (line.startsWith('has-session')) {
        const idxT = line.indexOf('-t ');
        const target = idxT >= 0 ? line.slice(idxT + 3).trim() : '';
        if (alive(target)) emit('');
        else emitErr("can't find session: " + target + '\\n');
      } else if (line.startsWith('display-message')) {
        if (line.includes('#{socket_path}')) emit(sockPath + '\\t' + SERVER_PID + '\\n');
        else if (line.includes('#{session_id}') && line.includes('#{pane_pid}')) emit(SERVER_PID + ' ' + SID + ' ' + PID + ' ' + PANE_PID + '\\n');
        else if (line.includes('#{pane_pid}')) emit(SERVER_PID + '\\t' + PANE_PID + '\\n');
        else emit('0\\t0\\t' + PID + '\\n');
      } else if (line.startsWith('kill-session')) {
        save([]);
        emit('');
      } else {
        emit('');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
const cmd = args[0] || '';
if (cmd === 'has-session') {
  const target = args[args.indexOf('-t') + 1] || '';
  if (alive(target)) process.exit(0);
  process.stderr.write("can't find session: " + target + '\\n');
  process.exit(1);
}
if (cmd === 'kill-session') { save([]); process.exit(0); }
if (cmd === 'display-message') {
  const f = args[args.indexOf('-F') + 1] || '';
  if (args.includes(';')) {
    process.stdout.write(SERVER_PID + '\\n');
    if (alive(SESSION_NAME)) process.exit(0);
    process.stderr.write("can't find session: " + SESSION_NAME + '\\n');
    process.exit(1);
  }
  if (f.includes('#{socket_path}')) { process.stdout.write(sockPath + '\\t' + SERVER_PID + '\\n'); process.exit(0); }
  if (f.includes('#{session_id}') && f.includes('#{pane_pid}')) { process.stdout.write(SERVER_PID + ' ' + SID + ' ' + PID + ' ' + PANE_PID + '\\n'); process.exit(0); }
  if (f.includes('pane_pid')) { process.stdout.write(SERVER_PID + '\\t' + PANE_PID + '\\n'); process.exit(0); }
  process.stdout.write('0\\t0\\t' + PID + '\\n');
  process.exit(0);
}
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
}

function createFakeVlScript(vlBin, { vlRoot, scenarioPath, cliCallsPath, hostPid, uid, bootId, nsInode, startTicks }) {
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const sr = args[args.indexOf('--server-root') + 1];
const CAPS = ['host_peer_identity_v1', 'host_stop_expected_v1'];
let sc = { hostState: 'live', afterAckState: 'none', stopAction: 'ack' };
try { sc = { ...sc, ...JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf8')) }; } catch (_) {}
if (args[0] === 'host' && args[1] === 'status') {
  if (sr !== ${JSON.stringify(vlRoot)}) {
    process.stdout.write(JSON.stringify({ ok: true, state: 'none', peer_identity_support: 'supported', capabilities: CAPS }) + '\\n');
    process.exit(0);
  }
  const st = sc.ackSeen && sc.afterAckState ? sc.afterAckState : sc.hostState;
  if (st === 'none' || st === 'server_absent') {
    process.stdout.write(JSON.stringify({ ok: true, state: st, peer_identity_support: 'supported', capabilities: CAPS }) + '\\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    state: st,
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
  let count = 0;
  try { count = Number(fs.readFileSync(${JSON.stringify(cliCallsPath)}, 'utf8')) || 0; } catch (_) {}
  fs.writeFileSync(${JSON.stringify(cliCallsPath)}, String(count + 1));
  if (sc.stopAction === 'refuse') {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'peer_mismatch' }) + '\\n');
    process.exit(1);
  }
  if (sc.afterAckState) {
    sc.ackSeen = true;
    fs.writeFileSync(${JSON.stringify(scenarioPath)}, JSON.stringify(sc));
  }
  process.stdout.write(JSON.stringify({ ok: true, reason: 'shutdown_ack' }) + '\\n');
  process.exit(0);
}
process.exit(1);
`;
  fs.writeFileSync(vlBin, script, { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
}

async function attesaPgrpFiglio(pid) {
  const deadline = Date.now() + 3000;
  while (gruppo.leggiPgrp(pid) === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
  }
}

function creaMondoE2E(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fe2e-'));
  fs.chmodSync(root, 0o755);
  const home = path.join(root, 'home');
  const cella = opts.cella || 'CellaFenE2E';
  const sessione = `cloud-${cella}`;
  const cellBase = vlCellBaseDir(home, OWNER, cella);
  const vlRoot = vlRoots.radiceServer(home, OWNER, cella);
  const cwd = path.join(home, cella);
  const filesRoot = path.join(home, 'NexusFiles');

  for (const d of [
    home,
    path.join(home, '.local'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.local', 'share'),
    path.join(home, '.nexuscrew'),
    path.join(home, '.nexuscrew', 'vl-cells'),
    path.join(home, '.config'),
    path.join(home, '.config', 'vl'),
    cwd,
    filesRoot,
    cellBase,
  ]) {
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
  createFakeTmuxScript(tmuxBin, {
    sessionsPath,
    deathMarkerPath,
    panePid: paneChild.pid,
    serverPid: serverProc.pid,
    sessionName: sessione,
  });

  const scenarioPath = path.join(root, 'vl-scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({ hostState: 'live', afterAckState: 'none', stopAction: 'ack' }));
  const cliCallsPath = path.join(root, 'vl-cli-calls.txt');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  createFakeVlScript(vlBin, {
    vlRoot,
    scenarioPath,
    cliCallsPath,
    hostPid: HOST_PID,
    uid: UID,
    bootId: REAL_BOOT_ID,
    nsInode: REAL_NS_INODE,
    startTicks: '2468',
  });

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'vl.native', label: 'VL', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' } }],
    cells: [{ id: cella, tmuxSession: sessione, cwd, engine: 'vl.native', boot: false }],
  });

  const syntheticHost = { alive: true };
  const killCalls = [];
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

  let onObserveKernel = opts.onObserveKernel || null;
  let onKillProcess = opts.onKillProcess || null;
  let lastPayload = null;
  const cleanupFns = [];

  // revokeControl e' osservabile: un revoke improprio non cambia ne' il record
  // ne' i segnali, quindi senza spy resterebbe invisibile al caso 7.1.
  const revokeControlCalls = [];
  function osservaRevoke(raw) {
    return new Proxy(raw, {
      get(target, prop) {
        if (prop === 'revokeControl') {
          return (id) => {
            revokeControlCalls.push({ cellId: id, at: Date.now() });
            return target.revokeControl(id);
          };
        }
        const valore = Reflect.get(target, prop);
        return typeof valore === 'function' ? valore.bind(target) : valore;
      },
    });
  }

  function makeRuntimeInstance() {
    const mgr = osservaRevoke(createLeaseManager({ home, log: () => {} }));
    cleanupFns.push(() => { try { mgr.close(); } catch (_) {} });
    const runtime = createBuiltinRuntime({
      cfg: {
        launchReadyMs: 0,
        filesRoot,
        activityHooks: false,
        vlLaunchCooldownMs: 0,
        groupStopBudgetMs: opts.budgetMs || 2500,
        log: () => {},
        env: {},
        vlIsolationSeams: {
          identitaNodo: () => ({ bootId: REAL_BOOT_ID, pidNamespaceInode: REAL_NS_INODE }),
          identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
          osservaPeer: (pid, instanceId) => (syntheticHost.alive && pid === HOST_PID
            ? { ...hostIdReal, instanceId: instanceId || OWNER }
            : null),
          osservaKernel: (pid, instanceId) => {
            if (typeof onObserveKernel === 'function') {
              onObserveKernel(pid, instanceId);
            }
            if (!syntheticHost.alive) {
              return { state: 'absent', node: { bootId: REAL_BOOT_ID, pidNamespaceInode: REAL_NS_INODE } };
            }
            return {
              state: 'observed',
              processState: 'S',
              identity: { ...hostIdReal, instanceId: instanceId || OWNER },
            };
          },
          killProcess: (pid, sig) => {
            killCalls.push({ pid, sig });
            if (typeof onKillProcess === 'function') {
              onKillProcess(pid, sig);
            }
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
    cleanupFns.push(() => { try { runtime.shutdown(); } catch (_) {} });
    return { mgr, runtime };
  }

  const primary = makeRuntimeInstance();

  t.after(() => {
    for (let i = cleanupFns.length - 1; i >= 0; i -= 1) {
      cleanupFns[i]();
    }
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    try { process.kill(serverProc.pid, 'SIGKILL'); } catch (_) {}
    try { fs.chmodSync(path.join(filesRoot, launchTarget.DIR, launchTarget.DIR_QUARANTENA), 0o700); } catch (_) {}
    try { fs.chmodSync(root, 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function attaccaSupervisore({
    mgr = primary.mgr,
    launchId,
    token,
    withholdPrepareAck = false,
    onPrepareAck,
  } = {}) {
    const payloadCtl = (lastPayload && lastPayload.control) || {};
    const useLaunchId = launchId || payloadCtl.launchId;
    const useToken = token || payloadCtl.token;
    const pairPath = path.join(root, `pair-${hexId(4)}.sock`);
    let serverSide = null;
    const srv = net.createServer((sock) => { serverSide = sock; });
    await new Promise((resolve) => srv.listen(pairPath, resolve));
    const clientSide = await new Promise((resolve, reject) => {
      const c = net.connect(pairPath, () => resolve(c));
      c.once('error', reject);
    });
    while (!serverSide) await new Promise((r) => setTimeout(r, 10));
    assert.equal(mgr.attachInitial(cella, serverSide, { generation: 0 }), true);

    let morto = false;
    const coord = gruppo.creaCoordinatore({
      token: useToken,
      launchId: useLaunchId,
      monoNow: () => Number(process.hrtime.bigint() / 1000000n),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      killGruppo: () => {
        morto = true;
        try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
        fs.writeFileSync(sessionsPath, '[]');
      },
      osserva: () => (morto
        ? { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }
        : { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }),
      invia: (frame) => {
        if (withholdPrepareAck && frame && frame.op === 'prepare-ack') return true;
        if (frame && frame.op === 'prepare-ack' && typeof onPrepareAck === 'function') onPrepareAck(frame);
        return leaseCtl.sendControl(frame);
      },
      svuota: async () => { await leaseCtl.svuota(); try { clientSide.end(); } catch (_) {} },
      cancellaDelivery: async () => null,
      scriviLog: () => {},
      dichiaraStopping: () => {},
      disarmaLegacy: () => {},
      installaIgnoraTerm: () => {},
    });
    const leaseCtl = startLeaseClient(clientSide, {
      stablePath: (lastPayload && lastPayload.lease && lastPayload.lease.stablePath) || path.join(root, 'no-lease.sock'),
      launchEpoch: (lastPayload && lastPayload.lease && lastPayload.lease.launchEpoch) || hexId(8),
      onControlFrame: (frame) => coord.onFrame(frame),
    });

    const close = () => {
      try { leaseCtl.stop(); } catch (_) {}
      try { clientSide.destroy(); } catch (_) {}
      try { serverSide.destroy(); } catch (_) {}
      try { srv.close(); } catch (_) {}
    };
    cleanupFns.push(close);
    return { coord, leaseCtl, close, launchId: useLaunchId, token: useToken };
  }

  return {
    root,
    home,
    cella,
    sessione,
    cellBase,
    vlRoot,
    filesRoot,
    sessionsPath,
    deathMarkerPath,
    serverProc,
    paneChild,
    syntheticHost,
    killCalls,
    revokeControlCalls,
    mgr: primary.mgr,
    runtime: primary.runtime,
    creaSecondoRuntime: makeRuntimeInstance,
    attaccaSupervisore,
    getLastPayload: () => lastPayload,
    setOnObserveKernel: (fn) => { onObserveKernel = fn; },
    setOnKillProcess: (fn) => { onKillProcess = fn; },
    setVlScenario: (patch) => {
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')); } catch (_) {}
      fs.writeFileSync(scenarioPath, JSON.stringify({ ...cur, ...patch }));
    },
    getCliStopCalls: () => {
      try { return Number(fs.readFileSync(cliCallsPath, 'utf8')) || 0; } catch (_) { return 0; }
    },
  };
}

  return { creaMondoE2E, attesaPgrpFiglio, seedRecoveryEvent, computeContextDigest, hexId };
})();

const E2E = (function () {
const CELLA = 'CellaE2E';
const SESSIONE = 'cloud-CellaE2E';
const OWNER_INSTANCE_ID = 'a1'.repeat(16);
const HOST_PID = 424242;
const HOST_START_TICKS = '987654321';
const COORD_PGID = 77777;
const COORD_SID = 77778;

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

const REAL_UID = typeof process.getuid === 'function' ? process.getuid() : 1000;

function hexId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function attendi(predicato, { timeoutMs = 4000, stepMs = 15 } = {}) {
  const fine = Date.now() + timeoutMs;
  while (Date.now() < fine) {
    const v = await predicato();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

function mkdirExact(dirPath, mode) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  fs.chmodSync(dirPath, mode);
}

function creaFakeTmux({
  tmuxBin,
  sessionsPath,
  callsLogPath,
  deathMarkerPath,
  panePid,
  serverPid,
  sessionName,
}) {
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const sockIdx = argv.indexOf('-S');
const sockPath = sockIdx >= 0 ? argv[sockIdx + 1] : ${JSON.stringify(sharedTmuxSocketPath())};
const args = sockIdx >= 0 ? argv.slice(sockIdx + 2) : argv;
const SESSIONS_PATH = ${JSON.stringify(sessionsPath)};
const LOG_PATH = ${JSON.stringify(callsLogPath)};
const DEATH_MARKER = ${JSON.stringify(deathMarkerPath)};
const PANE_PID = ${Number(panePid)};
const SERVER_PID = ${Number(serverPid)};
const SESSION_NAME = ${JSON.stringify(sessionName)};
const SID = '$5';
const WID = '@7';
const PID = '%7';

function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')); } catch (_) { return []; }
}
function saveSessions(list) {
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(list));
}
function logCall(entry) {
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\\n'); } catch (_) {}
}
function sessionAlive(target) {
  const list = loadSessions();
  if (!target) return list.some((s) => s.id === SID || s.name === SESSION_NAME);
  const clean = String(target).replace(/^=/, '');
  return list.some((s) => s.id === clean || s.name === clean);
}

function runControlCmd(line, seq) {
  const trimmed = line.trim();
  logCall({ ctrl: trimmed });
  const parts = trimmed.split(/\\s+/);
  const cmd = parts[0];
  const emit = (body, ok) => {
    const out = '%begin 1 ' + seq + ' 1\\n' + body + (ok ? '%end 1 ' + seq + ' 1\\n' : '%error 1 ' + seq + ' 1\\n');
    process.stdout.write(out);
  };
  if (cmd === 'display-message') {
    if (trimmed.includes('#{socket_path}')) {
      return emit(sockPath + '\\t' + SERVER_PID + '\\n', true);
    }
    if (trimmed.includes('#{session_id}') && trimmed.includes('#{pane_id}') && trimmed.includes('#{pane_pid}')) {
      return emit(SERVER_PID + ' ' + SID + ' ' + PID + ' ' + PANE_PID + '\\n', true);
    }
    if (trimmed.includes('pane_pid')) {
      return emit(SERVER_PID + '\\t' + PANE_PID + '\\n', true);
    }
    if (trimmed.includes('pane_dead')) {
      return emit('0\\t0\\t' + PID + '\\n', true);
    }
    return emit('0\\t\\t' + PID + '\\n', true);
  }
  if (cmd === 'respawn-pane') {
    return emit('', true);
  }
  if (cmd === 'set-option') {
    return emit('', true);
  }
  if (cmd === 'has-session') {
    const tIdx = parts.indexOf('-t');
    const target = tIdx >= 0 ? parts[tIdx + 1] : SID;
    if (sessionAlive(target)) return emit('', true);
    return emit("can't find session: " + target + '\\n', false);
  }
  if (cmd === 'kill-session') {
    const tIdx = parts.indexOf('-t');
    const target = tIdx >= 0 ? parts[tIdx + 1] : parts[parts.length - 1];
    saveSessions(loadSessions().filter((s) => s.id !== target && s.name !== target && '=' + s.name !== target));
    return emit('', true);
  }
  if (cmd === 'capture-pane') {
    return emit('vivling [o] esc quit · ^y yield\\n', true);
  }
  return emit('', true);
}

logCall(args);

if (args[0] === '-C') {
  const isNewSession = args.includes('new-session');
  if (!isNewSession && fs.existsSync(DEATH_MARKER)) process.exit(1);
  if (isNewSession) {
    saveSessions(loadSessions().filter((s) => s.name !== SESSION_NAME).concat([{ name: SESSION_NAME, id: SID, w: WID, p: PID }]));
    process.stdout.write('%begin 1 0 1\\n' + SID + ' ' + WID + ' ' + PID + '\\n%end 1 0 1\\n');
  } else {
    process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  const timer = setInterval(() => {
    if (fs.existsSync(DEATH_MARKER)) process.exit(0);
  }, 15);
  let buf = '';
  let seq = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed || trimmed.includes('nc-control-open')) continue;
      if (fs.existsSync(DEATH_MARKER)) process.exit(0);
      seq += 1;
      runControlCmd(trimmed, seq);
    }
  });
  process.stdin.on('end', () => { clearInterval(timer); process.exit(0); });
  return;
}

const cmd = args[0] || '';
if (cmd === 'new-session') {
  saveSessions(loadSessions().filter((s) => s.name !== SESSION_NAME).concat([{ name: SESSION_NAME, id: SID, w: WID, p: PID }]));
  process.stdout.write(SID + '\\t' + WID + '\\t' + PID + '\\n');
  process.exit(0);
}
if (cmd === 'list-sessions') {
  if (sessionAlive()) process.stdout.write(SESSION_NAME + '\\t1\\n');
  process.exit(0);
}
if (cmd === 'has-session') {
  const tIdx = args.indexOf('-t');
  const target = tIdx >= 0 ? args[tIdx + 1] : args[args.length - 1];
  if (sessionAlive(target)) process.exit(0);
  process.stderr.write("can't find session: " + target + '\\n');
  process.exit(1);
}
if (cmd === 'kill-session') {
  const tIdx = args.indexOf('-t');
  const target = tIdx >= 0 ? args[tIdx + 1] : args[args.length - 1];
  saveSessions(loadSessions().filter((s) => s.id !== target && s.name !== target && '=' + s.name !== target));
  process.exit(0);
}
if (cmd === 'display-message') {
  if (args.includes(';')) {
    const semiIdx = args.indexOf(';');
    const sub = args[semiIdx + 1] || '';
    const rest = args.slice(semiIdx + 2);
    const tIdx = rest.indexOf('-t');
    const target = tIdx >= 0 ? rest[tIdx + 1] : SESSION_NAME;
    process.stdout.write(SERVER_PID + '\\n');
    if (sub === 'list-panes') {
      // Il pane originale vive solo finche' vive la sessione che lo conteneva:
      // rimosso il mondo, tmux dichiara l'assenza del PANE (exit 1), non
      // l'assenza della sessione: cosi' il valutatore non legge
      // SESSION_UNKNOWN dove c'e' solo un pane uscito.
      if (target === PID && sessionAlive()) { process.stdout.write(target + '\\n'); process.exit(0); }
      process.stderr.write("can't find pane: " + target + '\\n');
      process.exit(1);
    }
    if (sessionAlive(target)) process.exit(0);
    process.stderr.write("can't find session: " + target + '\\n');
    process.exit(1);
  }
  const fIdx = args.indexOf('-F');
  const fmt = fIdx >= 0 ? args[fIdx + 1] : args[args.length - 1] || '';
  if (fmt.includes('#{socket_path}')) {
    process.stdout.write(sockPath + '\\t' + SERVER_PID + '\\n');
    process.exit(0);
  }
  if (fmt.includes('pane_pid')) {
    process.stdout.write(SERVER_PID + '\\t' + PANE_PID + '\\n');
    process.exit(0);
  }
  if (fmt.includes('pane_dead')) {
    process.stdout.write('0\\t0\\t' + PID + '\\n');
    process.exit(0);
  }
  process.stdout.write('0\\t\\t' + PID + '\\n');
  process.exit(0);
}
if (cmd === 'capture-pane') {
  process.stdout.write('vivling [o] esc quit · ^y yield\\n');
  process.exit(0);
}
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
}

function creaFakeVl({
  vlBin,
  vlRoot,
  vlStatePath,
  vlCallsLogPath,
  hostPid,
  uid,
  bootId,
  nsInode,
  startTicks,
}) {
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const CELL_ROOT = ${JSON.stringify(vlRoot)};
const STATE_PATH = ${JSON.stringify(vlStatePath)};
const LOG_PATH = ${JSON.stringify(vlCallsLogPath)};
const HOST_PID = ${Number(hostPid)};
const UID = ${Number(uid)};
const BOOT_ID = ${JSON.stringify(bootId)};
const NS_INODE = ${JSON.stringify(String(nsInode))};
const START_TICKS = ${JSON.stringify(String(startTicks))};

try { fs.appendFileSync(LOG_PATH, JSON.stringify(args) + '\\n'); } catch (_) {}

function readScen() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (_) { return {}; }
}
function writeScen(next) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(next));
}

const srIdx = args.indexOf('--server-root');
const serverRoot = srIdx >= 0 ? args[srIdx + 1] : null;
const CAPS = ['host_peer_identity_v1', 'host_stop_expected_v1'];

if (args[0] === 'host' && args[1] === 'status') {
  // Preflight capability probe on disposable /tmp root returns none + capabilities.
  if (serverRoot !== CELL_ROOT) {
    process.stdout.write(JSON.stringify({
      ok: true,
      state: 'none',
      peer_identity_support: 'supported',
      capabilities: CAPS,
    }) + '\\n');
    process.exit(0);
  }
  const sc = readScen();
  if (sc.corruptStatusOnce) {
    writeScen({ ...sc, corruptStatusOnce: false });
    process.stdout.write('{broken-status');
    process.exit(0);
  }
  const hostState = sc.hostState || 'live';
  if (hostState === 'none') {
    process.stdout.write(JSON.stringify({
      ok: true,
      state: 'none',
      peer_identity_support: 'supported',
      capabilities: CAPS,
    }) + '\\n');
    process.exit(0);
  }
  if (hostState === 'lock') {
    process.stdout.write(JSON.stringify({
      ok: true,
      state: 'lock',
      peer_identity_support: 'supported',
      capabilities: CAPS,
      declared_pid: sc.declaredPidOverride !== undefined ? sc.declaredPidOverride : HOST_PID,
      peer_identity: {
        schema_version: 1,
        state: 'verified',
        pid: HOST_PID,
        uid: UID,
        boot_id: BOOT_ID,
        pidns: NS_INODE,
        starttime: START_TICKS,
        pgid: HOST_PID,
        sid: HOST_PID,
      },
    }) + '\\n');
    process.exit(0);
  }
  if (hostState === 'lock_held_socket_silent') {
    process.stdout.write(JSON.stringify({
      ok: true,
      state: 'lock_held_socket_silent',
      peer_identity_support: 'supported',
      capabilities: CAPS,
      declared_pid: sc.declaredPidOverride !== undefined ? sc.declaredPidOverride : null,
      peer_identity: { schema_version: 1, state: 'unverified' },
    }) + '\\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    state: 'live',
    peer_identity_support: 'supported',
    capabilities: CAPS,
    declared_pid: sc.declaredPidOverride !== undefined ? sc.declaredPidOverride : HOST_PID,
    peer_identity: {
      schema_version: 1,
      state: 'verified',
      pid: HOST_PID,
      uid: UID,
      boot_id: BOOT_ID,
      pidns: NS_INODE,
      starttime: START_TICKS,
      pgid: HOST_PID,
      sid: HOST_PID,
    },
  }) + '\\n');
  process.exit(0);
}

if (args[0] === 'internal' && args[1] === 'host-stop') {
  const sc = readScen();
  const mode = sc.stopMode || 'shutdown_ack_keep_lock';
  if (mode === 'shutdown_ack_clean') {
    writeScen({ ...sc, hostState: 'none', hostAlive: false });
    process.stdout.write(JSON.stringify({ ok: true, reason: 'shutdown_ack' }) + '\\n');
    process.exit(0);
  }
  if (mode === 'shutdown_ack_keep_lock') {
    writeScen({ ...sc, hostState: 'lock' });
    process.stdout.write(JSON.stringify({ ok: true, reason: 'shutdown_ack' }) + '\\n');
    process.exit(0);
  }
  const reason = sc.stopFailReason || 'timeout';
  process.stdout.write(JSON.stringify({ ok: false, reason }) + '\\n');
  process.exit(1);
}

process.stdout.write(JSON.stringify({ ok: false, reason: 'usage' }) + '\\n');
process.exit(1);
`;
  fs.writeFileSync(vlBin, script, { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
}

function creaMondoE2E(t, { budgetMs = 8000, mgrWrapper = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-e2e-'));
  fs.chmodSync(root, 0o755);

  const home = path.join(root, 'home');
  mkdirExact(home, 0o755);
  mkdirExact(path.join(home, '.local'), 0o755);
  mkdirExact(path.join(home, '.local', 'bin'), 0o755);
  mkdirExact(path.join(home, '.local', 'share'), 0o755);
  mkdirExact(path.join(home, '.nexuscrew'), 0o700);
  mkdirExact(path.join(home, '.nexuscrew', 'vl-cells'), 0o700);
  mkdirExact(path.join(home, '.config'), 0o755);
  mkdirExact(path.join(home, '.config', 'vl'), 0o755);
  fs.writeFileSync(path.join(home, '.config', 'vl', 'config.toml'), '[profiles.work]\nmodel = "m"\n', { mode: 0o644 });

  const cwd = path.join(home, CELLA);
  mkdirExact(cwd, 0o755);
  const filesRoot = path.join(home, 'NexusFiles');
  mkdirExact(filesRoot, 0o700);

  const cellBase = vlCellBaseDir(home, OWNER_INSTANCE_ID, CELLA);
  mkdirExact(cellBase, 0o700);
  const vlRoot = vlRoots.radiceServer(home, OWNER_INSTANCE_ID, CELLA);

  // Owned placeholder dummy children solely for /proc tmux & pane starttime reads
  // (never signaled outside test teardown and coordinator stop simulation).
  const serverProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'], {
    detached: true,
    stdio: 'ignore',
  });
  serverProc.unref();
  const paneChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'], {
    detached: true,
    stdio: 'ignore',
  });
  paneChild.unref();

  const sessionsPath = path.join(root, 'sessions.json');
  fs.writeFileSync(sessionsPath, '[]');
  const tmuxCallsPath = path.join(root, 'tmux-calls.jsonl');
  fs.writeFileSync(tmuxCallsPath, '');
  const deathMarkerPath = path.join(root, 'tmux-dead');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  creaFakeTmux({
    tmuxBin,
    sessionsPath,
    callsLogPath: tmuxCallsPath,
    deathMarkerPath,
    panePid: paneChild.pid,
    serverPid: serverProc.pid,
    sessionName: SESSIONE,
  });

  const vlStatePath = path.join(root, 'vl-state.json');
  const vlCallsPath = path.join(root, 'vl-calls.jsonl');
  fs.writeFileSync(vlCallsPath, '');
  const vlBin = path.join(home, '.local', 'bin', 'vl');

  const syntheticHost = {
    alive: true,
    killCalls: [],
    kernelObsCount: 0,
    kernelObsPostKill: [],
    probeCalls: 0,
    eventOrder: [],
  };

  function setVlScenario(patch) {
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(vlStatePath, 'utf8')); } catch (_) { cur = {}; }
    const next = { hostState: 'live', stopMode: 'shutdown_ack_keep_lock', ...cur, ...patch };
    fs.writeFileSync(vlStatePath, JSON.stringify(next));
  }
  setVlScenario({ hostState: 'live', stopMode: 'shutdown_ack_keep_lock' });

  creaFakeVl({
    vlBin,
    vlRoot,
    vlStatePath,
    vlCallsLogPath: vlCallsPath,
    hostPid: HOST_PID,
    uid: REAL_UID,
    bootId: REAL_BOOT_ID,
    nsInode: REAL_NS_INODE,
    startTicks: HOST_START_TICKS,
  });

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'vl.native',
      label: 'VL',
      managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }],
    cells: [{ id: CELLA, tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false }],
  });

  const mgrReale = createLeaseManager({ home, log: () => {} });
  const mgr = mgrWrapper ? mgrWrapper(mgrReale) : mgrReale;
  let lastLaunchPayload = null;

  function buildHostIdentity(instanceId) {
    return {
      state: 'live',
      source: 'kernel-peer-v1',
      instanceId: instanceId || OWNER_INSTANCE_ID,
      pid: HOST_PID,
      uid: REAL_UID,
      bootId: REAL_BOOT_ID,
      pidNamespaceInode: REAL_NS_INODE,
      startTicks: HOST_START_TICKS,
      pgid: HOST_PID,
      sid: HOST_PID,
    };
  }

  const vlIsolationSeams = {
    identitaNodo: () => ({ bootId: REAL_BOOT_ID, pidNamespaceInode: REAL_NS_INODE }),
    identitaCoordinatore: () => ({ pgid: COORD_PGID, sid: COORD_SID }),
    osservaPeer: (pid, instanceId) => {
      if (pid !== HOST_PID || !syntheticHost.alive) return null;
      return buildHostIdentity(instanceId);
    },
    osservaKernel: (pid, instanceId) => {
      syntheticHost.kernelObsCount += 1;
      if (syntheticHost.killCalls.length > 0) {
        syntheticHost.kernelObsPostKill.push({ pid, alive: syntheticHost.alive });
      }
      if (pid !== HOST_PID || !syntheticHost.alive) {
        return { state: 'absent', node: { bootId: REAL_BOOT_ID, pidNamespaceInode: REAL_NS_INODE } };
      }
      return {
        state: 'observed',
        processState: 'S',
        identity: buildHostIdentity(instanceId),
      };
    },
    killProcess: (pid, signal) => {
      syntheticHost.killCalls.push({ pid, signal });
      syntheticHost.eventOrder.push(`signal:${signal}:${pid}`);
      if (pid === HOST_PID && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        syntheticHost.alive = false;
        setVlScenario({ hostState: 'none', hostAlive: false });
      }
    },
  };

  function creaRuntimeInstance(extraCfg = {}) {
    return createBuiltinRuntime({
      cfg: {
        launchReadyMs: 0,
        filesRoot,
        activityHooks: false,
        vlLaunchCooldownMs: 0,
        groupStopBudgetMs: budgetMs,
        log: () => {},
        env: {},
        vlIsolationSeams,
        ...extraCfg,
      },
      identityOwnerInstanceId: OWNER_INSTANCE_ID,
      home,
      defsPath,
      tmuxBin,
      readonly: () => false,
      launchBroker: {
        issue: async (req) => {
          lastLaunchPayload = req;
          return { socketPath: path.join(root, 'broker.sock'), nonce: 'b'.repeat(64) };
        },
        revoke: async () => {},
        close: async () => {},
      },
      leaseManager: mgr,
      boot: loadDefinitions(defsPath),
    });
  }

  const runtime = creaRuntimeInstance();
  const cleanupHandles = [];

  t.after(() => {
    for (const fn of cleanupHandles) {
      try { fn(); } catch (_) {}
    }
    try { runtime.shutdown(); } catch (_) {}
    try { mgrReale.close(); } catch (_) {}
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    try { process.kill(serverProc.pid, 'SIGKILL'); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    root,
    home,
    filesRoot,
    defsPath,
    tmuxBin,
    vlBin,
    vlRoot,
    cellBase,
    sessionsPath,
    deathMarkerPath,
    paneChild,
    serverProc,
    mgr,
    mgrReale,
    runtime,
    creaRuntimeInstance,
    syntheticHost,
    setVlScenario,
    readVlCalls: () => fs.readFileSync(vlCallsPath, 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    readTmuxCalls: () => fs.readFileSync(tmuxCallsPath, 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    payloadLancio: () => lastLaunchPayload,
    registerCleanup: (fn) => cleanupHandles.push(fn),
  };
}

async function attaccaSupervisore(t, w) {
  const payload = w.payloadLancio();
  const control = payload && payload.control;
  assert.ok(control && control.launchId && control.token, 'payload del lancio deve includere control');

  const pairPath = path.join(w.root, `pair-${hexId(4)}.sock`);
  let serverSide = null;
  const srv = net.createServer((sock) => { serverSide = sock; });

  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(pairPath, () => {
      const clientSide = net.connect(pairPath, () => {
        (async () => {
          const attached = await attendi(() => serverSide);
          assert.ok(attached, 'socket coppia connesso');
          assert.equal(w.mgr.attachInitial(CELLA, serverSide, { generation: 0 }), true);

          const framesRicevuti = [];
          const framesInviati = [];
          let gruppoMorto = false;
          let cancellaCount = 0;

          let leaseCtl = null;
          const coord = gruppo.creaCoordinatore({
            token: control.token,
            launchId: control.launchId,
            monoNow: () => Number(process.hrtime.bigint() / 1000000n),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            killGruppo: (sig) => {
              w.syntheticHost.eventOrder.push(`supervisor-kill:${sig}`);
              if (sig !== 'SIGTERM' || gruppoMorto) return;
              gruppoMorto = true;
              try { process.kill(w.paneChild.pid, 'SIGKILL'); } catch (_) {}
              fs.writeFileSync(w.sessionsPath, '[]');
              try { fs.writeFileSync(w.deathMarkerPath, '1'); } catch (_) {}
            },
            osserva: () => (gruppoMorto
              ? { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }
              : { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }),
            invia: (frame) => {
              framesInviati.push(frame);
              w.syntheticHost.eventOrder.push(`tx:${frame.op}`);
              return leaseCtl.sendControl(frame);
            },
            svuota: async () => {
              await leaseCtl.svuota();
              try { clientSide.end(); } catch (_) {}
            },
            cancellaDelivery: async () => {
              cancellaCount += 1;
              return null;
            },
            scriviLog: () => {},
            dichiaraStopping: () => {},
            disarmaLegacy: () => {},
            installaIgnoraTerm: () => {},
          });

          leaseCtl = startLeaseClient(clientSide, {
            stablePath: (payload.lease && payload.lease.stablePath) || path.join(w.root, 'no-lease.sock'),
            launchEpoch: (payload.lease && payload.lease.launchEpoch) || hexId(),
            onControlFrame: (frame) => {
              framesRicevuti.push(frame);
              w.syntheticHost.eventOrder.push(`rx:${frame.op}`);
              coord.onFrame(frame);
            },
          });

          const spegni = () => {
            try { leaseCtl.stop(); } catch (_) {}
            try { clientSide.destroy(); } catch (_) {}
            try { serverSide.destroy(); } catch (_) {}
            try { srv.close(); } catch (_) {}
          };
          w.registerCleanup(spegni);
          t.after(spegni);

          resolve({
            coord,
            spegni,
            framesRicevuti,
            framesInviati,
            cancellaCount: () => cancellaCount,
          });
        })().catch(reject);
      });
      clientSide.once('error', reject);
    });
  });
}

async function attesaPgrpFiglio(pid) {
  const ok = await attendi(() => {
    try {
      process.kill(pid, 0);
      return Number.isSafeInteger(sharedGroupId) || true;
    } catch (_) {
      return false;
    }
  });
  assert.ok(ok, 'figlio dummy di test deve essere vivo prima di up');
  await attendi(() => gruppo.leggiPgrp(pid) !== null);
}

async function terminaSupervisoreESessione(w, sup) {
  sup.spegni();
  try { process.kill(w.paneChild.pid, 'SIGKILL'); } catch (_) {}
  await attendi(() => {
    try { process.kill(w.paneChild.pid, 0); return false; } catch (_) { return true; }
  });
  fs.writeFileSync(w.sessionsPath, '[]');
  fs.writeFileSync(w.deathMarkerPath, '1');
  // Attende chiusura del processo fake-tmux -C (poll 15ms + EOF sul socket di controllo)
  // prima che downSerializzato avvii has-session sul canale gia morto.
  await new Promise((r) => setTimeout(r, 120));
}

// Stesso helper del file d'origine (E2E:59-61): impronta del binario pinnato.
function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

  return { creaMondoE2E, attaccaSupervisore, terminaSupervisoreESessione, attesaPgrpFiglio, sha256File, CELLA };
})();

// --- le sette garanzie attive ----------------------------------------------

test('down on server_absent with a moved root refuses fail-closed', async (t) => {
  const w = BAR.creaMondoBar(t, { budgetMs: 2800 });
  await BAR.attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  await w.terminaSupervisoreESessione();
  await w.runtime.shutdown();
  w.mgr.close();

  const rt2Bundle = w.creaSecondoRuntime(2800);
  const moved = path.join(w.root, 'alt-host-root');
  fs.mkdirSync(moved, { recursive: true, mode: 0o700 });

  w.setVlScenario({
    hostState: 'live',
    stopAction: 'server_absent',
    afterAckState: 'none',
    vlRootPath: w.vlRoot,
    relocateTo: moved,
  });

  let err = null;
  let res = null;
  try {
    res = await rt2Bundle.runtime.down(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    err = e;
  }

  assert.equal(
    res,
    null,
    `6.4b(spostata): down su server_absent con root symlinked deve rifiutare e NON chiudere (res=${JSON.stringify(res)})`,
  );
  assert.ok(err && (err.status === 500 || err.status === 409), '6.4b(spostata): atteso rifiuto fail-closed');
  assert.deepEqual(w.killCalls, [], '6.4b(spostata): zero segnali con base non qualificata');
  assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', '6.4b(spostata): record intatto');
  if (fs.existsSync(w.vlRoot) && fs.lstatSync(w.vlRoot).isSymbolicLink()) {
    fs.rmSync(w.vlRoot, { force: true });
    fs.mkdirSync(w.vlRoot, { recursive: true, mode: 0o700 });
  }
  assert.equal(
    vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: BAR.OWNER, cellId: w.cella }),
    'held',
    '6.4b(spostata): claim non rilasciata',
  );
});

test('a resolved host with a live supervisor keeps SUPERVISOR_ALIVE as its own barrier', async (t) => {
  const w = LEA.creaMondoLea(t);
  await LEA.attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  await w.runtime.shutdown();
  fs.writeFileSync(path.join(w.root, 'tmux-dead'), '1');
  w.syntheticHost.alive = false;
  w.setVlScenario({ hostState: 'none', afterAckState: 'none' });

  const rt2 = w.creaSecondoRuntime(2800);
  let err = null;
  let res = null;
  try {
    res = await rt2.runtime.down(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    err = e;
  }

  assert.equal(res, null, '8.1(host-risolto): con supervisore alive down senza canale deve rifiutare');
  assert.ok(err && err.status === 409, '8.1(host-risolto): atteso 409');
  assert.ok(
    err.data && err.data.prove && Array.isArray(err.data.prove.blocchi)
      && err.data.prove.blocchi.includes('SUPERVISOR_ALIVE'),
    '8.1(host-risolto): SUPERVISOR_ALIVE deve restare barriera anche con host risolto',
  );
  assert.deepEqual(w.killCalls, [], '8.1(host-risolto): zero segnali host');
  assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', '8.1(host-risolto): record intatto');
});

test('down during lease grace is blocked and a late proof never reactivates the lease', async (t) => {
  const w = LEA.creaMondoLea(t, { initialLeaseNow: 10000, budgetMs: 2800 });
  await LEA.attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  const sup = await w.attaccaSupervisore({ captureProof: true });
  assert.ok(sup.proof, '8.3: proof acquisito dal supervisore');

  sup.close();
  await w.terminaSupervisoreESessione();
  await LEA.untilNotLive(w.mgrRaw, w.cella);
  w.leaseClock.now = 15000;
  await w.runtime.shutdown();

  const rt2 = w.creaSecondoRuntime(2800);
  let err1 = null;
  try {
    await rt2.runtime.down(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    err1 = e;
  }
  assert.ok(err1 && err1.status === 409, '8.3(1a-down): atteso 409');
  assert.equal(w.revokeControlCalls.length, 0, '8.3(1a-down): zero revokeControl prima del commit');

  w.leaseClock.now = 75000;
  assert.equal(w.mgrRaw.status(w.cella).state, 'expired', '8.3: lease deve risultare expired');
  if (sup.stablePath) {
    const tardy = await new Promise((resolve, reject) => {
      const s = net.connect(sup.stablePath, async () => {
        try {
          const msg = await LEA.sendJsonLine(s, { type: 'reconnect', cellId: w.cella, proof: sup.proof, generation: 0 });
          s.destroy();
          resolve(msg);
        } catch (er) {
          s.destroy();
          reject(er);
        }
      });
      s.once('error', reject);
    });
    assert.equal(tardy && tardy.type, 'deny', '8.3: proof tardivo post-grace negato');
    assert.equal(w.mgrRaw.status(w.cella).state, 'expired', '8.3: proof tardivo non riattiva lease');
  }
});

test('restart with a live host keeps host recovery disarmed, sends no signal and calls no up', async (t) => {
  const w = BUD.creaMondoBud(t, { budgetMs: 2800 });
  // The vl catalog is resolved from XDG_CONFIG_HOME first: pin it to the
  // fixture's own .config so the test never reads the runner's environment.
  const xdgPrec = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(w.home, '.config');
  t.after(() => {
    if (xdgPrec === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = xdgPrec;
  });
  await BUD.attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  await w.attaccaSupervisore();
  assert.equal(w.brokerState.issueCount, 1, '9.6: un solo avvio iniziale');

  w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live' });
  w.setOnKillProcess((pid, sig) => {
    if (pid === BUD.HOST_PID && sig === 'SIGTERM') {
      w.syntheticHost.alive = false;
      w.setVlScenario({ hostState: 'none', afterAckState: 'none' });
    }
  });

  let rstErr = null;
  let rstRes = null;
  try {
    rstRes = await w.runtime.restart(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    rstErr = e;
  }

  assert.equal(rstRes, null, '9.6(restart): restart con host vivo non deve rilanciare');
  assert.ok(rstErr !== null, '9.6(restart): atteso errore da restart');
  assert.deepEqual(w.killCalls, [], '9.6(restart): zero segnali recovery con allowHostRecovery false');
  assert.equal(w.brokerState.issueCount, 1, '9.6(restart): non deve chiamare up()');
});

test('a reattached coordinator without a fresh prepare-ack refuses STOP_UNKNOWN and promotes no disk file', async (t) => {
  const w = FEN.creaMondoE2E(t, { cella: 'CellaFen75a', budgetMs: 1500 });
  await FEN.attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  const sup1 = await w.attaccaSupervisore();

  const ctx = hostStop.leggiContesto(w.cellBase);
  FEN.seedRecoveryEvent(w.cellBase, {
    launchId: ctx.launchId,
    attemptId: FEN.hexId(16),
    seq: 1,
    kind: 'cli-attempt',
    contextDigest: FEN.computeContextDigest(ctx),
  });

  await w.runtime.shutdown();
  sup1.close();
  w.mgr.close();

  const rt2Bundle = w.creaSecondoRuntime();
  rt2Bundle.mgr.boot();
  assert.ok(rt2Bundle.mgr.armControl(w.cella, { launchId: sup1.launchId, token: sup1.token }), '7.5(a): armControl su mgr2');
  await w.attaccaSupervisore({
    mgr: rt2Bundle.mgr,
    launchId: sup1.launchId,
    token: sup1.token,
    withholdPrepareAck: true,
  });

  let errA = null;
  let resA = null;
  try {
    resA = await rt2Bundle.runtime.down(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    errA = e;
  }

  assert.equal(errA && errA.fleetCode, 'STOP_UNKNOWN', `7.5(a): senza prepare-ack sul canale nuovo deve fallire STOP_UNKNOWN (resA=${Boolean(resA)})`);
  assert.equal(w.killCalls.length, 0, '7.5(a): nessuna promozione da file recovery o segnali host');
});

test('a down during grace refuses on the single raw LEASE_BLOCKS block and sends no host signal', async (t) => {
  let leaseStateOverride = 'grace';
  const w = E2E.creaMondoE2E(t, {
    budgetMs: 8000,
    mgrWrapper: (mgrReale) => new Proxy(mgrReale, {
      get(target, prop) {
        if (prop === 'status') {
          return (id) => {
            const s = target.status(id);
            if (id === E2E.CELLA && leaseStateOverride) return { ...s, state: leaseStateOverride };
            return s;
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }),
  });

  await E2E.attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(E2E.CELLA);
  const sup = await E2E.attaccaSupervisore(t, w);

  await E2E.terminaSupervisoreESessione(w, sup);
  w.setVlScenario({
    hostState: 'lock_held_socket_silent',
    stopMode: 'timeout',
    stopFailReason: 'timeout',
    declaredPidOverride: 999991,
  });

  await assert.rejects(
    () => w.runtime.down(E2E.CELLA),
    (err) => err
      && typeof err.fleetCode === 'string'
      && err.data && err.data.prove
      && err.data.prove.blocchi
      && err.data.prove.blocchi.length === 1
      && err.data.prove.blocchi[0] === 'LEASE_BLOCKS',
    '1.2(a): primo down durante grace rifiuta solo per LEASE_BLOCKS senza toccare host',
  );
  assert.equal(w.syntheticHost.killCalls.length, 0, '1.2(a): zero segnali durante il blocco grace');
});

test('a down with a corrupt status fails at the host step after exactly one prepare-ack', async (t) => {
  const budgetMs = 4000;
  const w = E2E.creaMondoE2E(t, { budgetMs });
  await E2E.attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(E2E.CELLA);
  const sup = await E2E.attaccaSupervisore(t, w);

  w.setVlScenario({ hostState: 'live', corruptStatusOnce: true });
  let err1 = null;
  try {
    await w.runtime.down(E2E.CELLA);
  } catch (e) {
    if (!e || typeof e.fleetCode !== 'string') throw e;
    err1 = e;
  }
  assert.ok(err1, '1.3(a): primo down fallisce allo step host dopo prepare-ack');
  assert.notEqual(err1.fleetCode, 'STOP_UNKNOWN', '1.3(a): primo down non deve fallire su prepare');
  assert.equal(
    sup.framesInviati.filter((f) => f.op === 'prepare-ack').length,
    1,
    '1.3(a): primo prepare-ack gia emesso, coordinatore resta in stato preparato',
  );
});

// --- tre garanzie attive estratte dopo il primo fallimento (MISTO) ---------
//
// Assert ATTIVI che nei test d'origine stanno DOPO la prima assert fallita e
// non erano quindi mai raggiunti: qui la preparazione e' la stessa, l'esito
// atteso della capacita' rinviata e' assorbito come fa l'originale, e restano
// solo gli assert attivi, identici.

test('a down that cannot attest the host close leaves the pinned VL binary untouched and forces no change', async (t) => {
  // E2E 1.1 :826 e :827-830. La down non chiude (capacita' rinviata): restano
  // la guardia anti-mutazione del pin e lo zero cambi forzati.
  const w = E2E.creaMondoE2E(t, { budgetMs: 8000 });
  await E2E.attesaPgrpFiglio(w.paneChild.pid);
  const vlShaBefore = E2E.sha256File(w.vlBin);

  const upRes = await w.runtime.up(E2E.CELLA);
  assert.equal(upRes && upRes.ok, true, '1.1: up iniziale deve riuscire');

  await E2E.attaccaSupervisore(t, w);
  w.setVlScenario({ hostState: 'live', stopMode: 'shutdown_ack_keep_lock' });

  let downErr = null;
  try {
    await w.runtime.down(E2E.CELLA);
  } catch (e) {
    if (!e || e.fleetCode !== 'HOST_STOP_FAILED' || !e.data || e.data.outcome !== 'host-stop-failed') {
      throw e;
    }
    downErr = e;
  }
  assert.ok(downErr, '1.1: senza la chiusura attestata la down rifiuta (capacita rinviata)');

  const vlCalls = w.readVlCalls();
  assert.equal(E2E.sha256File(w.vlBin), vlShaBefore, '1.1: binario VL pinnato invariato byte-per-byte');
  assert.ok(
    !vlCalls.some((c) => c.includes('--force')),
    '1.1: zero cambi VL forzati',
  );
});

test('an up during a grace lease is refused with 409 and opens nothing', async (t) => {
  // LEA 8.2(grace) :714 e :715: la up resta bloccata finche' la lease e' in
  // grace, con lo stesso 409 del rifiuto della down.
  const w = LEA.creaMondoLea(t, { initialLeaseNow: 10000 });
  await LEA.attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  const sup = await w.attaccaSupervisore();
  sup.close();
  await w.terminaSupervisoreESessione();
  await LEA.untilNotLive(w.mgrRaw, w.cella);

  w.leaseClock.now = 15000;
  const pre = w.mgrRaw.status(w.cella);
  assert.equal(pre.state, 'grace', '8.2(grace): prerequisito lease in grace');
  await w.runtime.shutdown();

  const rt2 = w.creaSecondoRuntime(2800);
  let err = null;
  try {
    await rt2.runtime.down(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    err = e;
  }
  assert.ok(err && err.status === 409, '8.2(grace): atteso 409');

  let upErr = null;
  let upRes = null;
  try {
    upRes = await rt2.runtime.up(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    upErr = e;
  }
  assert.equal(upRes, null, '8.2(grace)(/up): up bloccata durante lease grace');
  assert.ok(upErr && upErr.status === 409, '8.2(grace)(/up): atteso 409 su up');
  // Nessun duplicato provato: il pane originale e' assente sul server
  // qualificato, resta la sola lease grace come blocco -> STOP_UNKNOWN.
  assert.equal(upErr.fleetCode, 'STOP_UNKNOWN', '8.2(grace)(/up): senza duplicato provato il rifiuto e\' STOP_UNKNOWN');
  assert.ok(upErr.data && upErr.data.prove, '8.2(grace)(/up): le prove viaggiano nel data');
  assert.equal(upErr.data.prove.proofs.lease, 'grace', '8.2(grace)(/up): la lease e\' grace');
  assert.deepEqual(upErr.data.prove.blocchi, ['LEASE_BLOCKS'], '8.2(grace)(/up): il blocco e\' quello della lease');
});

test('an unreadable lease as the only residual block is conserved alone in prove.blocchi', async (t) => {
  // LEA 8.8a :1124: la forma a blocco unico delle prove, non solo la presenza
  // del codice fra altri blocchi.
  const w = LEA.creaMondoLea(t, { budgetMs: 2800 });
  await LEA.attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  await w.terminaSupervisoreESessione();
  await w.runtime.shutdown();

  const rt2 = w.creaSecondoRuntime(2800);
  w.setStatusOverride(() => ({ cellId: w.cella, state: 'strano' }));
  let err = null;
  try {
    await rt2.runtime.down(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    err = e;
  }

  assert.ok(err && err.status === 409, '8.8a(strano): status 409 atteso');
  assert.deepEqual(err.data && err.data.prove && err.data.prove.blocchi, ['LEASE_UNREADABLE']);
});
