'use strict';

const { piano } = require('./helpers/phase-plan.js');

// Host recovery exit barriers, server-absent qualification, and fail-closed tests (6.1 - 6.6).

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
const gruppo = require('../lib/fleet/group-stop.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const vlRoots = require('../lib/fleet/vl-roots.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const hostStop = require('../lib/fleet/vl-host-stop.js');

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

test('6.1a SIGTERM 0 con processo originale ancora vivo fallisce closed in recover senza scrivere successo', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '6.1a: export createHostRecovery mancante');

  // The syscall return value is never proof of death: integer 0, undefined and
  // true all leave the original alive in the kernel and must fail closed.
  for (const ritorno of [0, undefined, true]) {
    const tag = `6.1a(${String(ritorno)})`;
    const fx = creaUnitFixture(t);
    let clock = 30000;
    const killCalls = [];

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => {
        killCalls.push({ pid, sig });
        return ritorno;
      },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx.record.hostIdentity, pid, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: HOST_PID, pid_number_in_use: true } }),
    });
    assertFactoryMethods(factory, tag);

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true, `${tag}: openAttempt deve riuscire`);

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.ok(
      killCalls.some((c) => c.pid === HOST_PID && c.sig === 'SIGTERM'),
      `${tag}: SIGTERM deve essere tentato sul PID originale`,
    );
    assert.ok(
      !['host-stopped-attested', 'host-already-stopped', 'host-stopped-clean'].includes(res && res.outcome),
      `${tag}: il valore di ritorno non è prova di morte, atteso esito conservativo (ricevuto ${res && res.outcome})`,
    );

    const kinds = readRecoveryEvents(fx.stateDir).map((e) => e.event.kind);
    assert.ok(!kinds.includes('exited'), `${tag}: nessun evento exited finche originale vivo in /proc`);
    assert.ok(!kinds.includes('closed'), `${tag}: nessun evento closed finche originale vivo in /proc`);
  }
});

test('6.1b runtime down con SIGTERM 0 ma originale vivo fallisce closed lasciando claim e record intatti', async (t) => {
  const w = creaMondoBar(t, { budgetMs: 2800 });
  await attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  await w.attaccaSupervisore();

  const before = launchTarget.leggi(w.filesRoot, w.sessione);
  assert.equal(before.stato, 'presente', '6.1b: record iniziale presente');
  const lid = before.record.launchId;

  // Host riceve SIGTERM (syscall 0, nessun throw) ma resta vivo in /proc e su root lock.
  w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'lock' });

  let err = null;
  let res = null;
  try {
    res = await w.runtime.down(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    err = e;
  }

  assert.ok(
    w.killCalls.some((c) => c.pid === HOST_PID && c.sig === 'SIGTERM'),
    `6.1b: runtime down deve inoltrare SIGTERM al processo host prima del fail-closed (killCalls=${JSON.stringify(w.killCalls)}, err=${err && err.fleetCode})`,
  );
  assert.equal(res, null, '6.1b: down non deve chiudere positivo con originale vivo');
  assert.ok(
    err && ['HOST_ALIVE', 'HOST_STOP_FAILED'].includes(err.fleetCode),
    `6.1b: codice errore atteso HOST_ALIVE o HOST_STOP_FAILED (ricevuto ${err && err.fleetCode})`,
  );
  assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', '6.1b: record launch-target resta intatto');
  assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).record.launchId, lid, '6.1b: launchId invariato');
  const claim = vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella });
  assert.equal(claim, 'held', `6.1b: claim root non rilasciata (trovato ${claim})`);
});

test('6.2a host morto in kernel ma root lock o live di altro peer fallisce closed in recover senza rimozioni manuali', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '6.2a: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  for (const variant of [
    { label: 'lock', stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } },
    { label: 'altro-peer-live', stato: { ok: true, state: 'live', declared_pid: NEW_PEER_PID, pid_number_in_use: true } },
  ]) {
    const fx = creaUnitFixture(t);
    const sentinel = path.join(fx.serverRoot, 'sentinel-lock.dat');
    fs.writeFileSync(sentinel, 'intact', { mode: 0o600 });
    let clock = 20000;
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
      probeRoot: async () => ({ r: { ok: true }, stato: variant.stato }),
    });
    assertFactoryMethods(factory, '6.2a');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true, `6.2a (${variant.label}): openAttempt deve riuscire`);

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.ok(
      !['host-stopped-attested', 'host-already-stopped', 'host-stopped-clean'].includes(res && res.outcome),
      `6.2a (${variant.label}): host morto ma root non none deve fallire closed (ricevuto ${res && res.outcome})`,
    );
    assert.deepEqual(killCalls, [], `6.2a (${variant.label}): nessun segnale a originale gia morto ne ad altro peer`);
    assert.equal(fs.existsSync(sentinel), true, `6.2a (${variant.label}): zero rimozione manuale dei file root`);
    const kinds = readRecoveryEvents(fx.stateDir).map((e) => e.event.kind);
    assert.ok(!kinds.includes('closed'), `6.2a (${variant.label}): nessun evento closed senza root none`);
  }
});

test('6.2b runtime down con originale morto ma root lock o nuovo peer live fallisce closed con zero segnali e zero rimozioni', async (t) => {
  // Parte A: originale assente in /proc ma root ancora in lock (osservaKernel invocato da recovery).
  {
    const w = creaMondoBar(t, { budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.terminaSupervisoreESessione();
    await w.runtime.shutdown();
    w.mgr.close();

    const rt2Bundle = w.creaSecondoRuntime(2800);
    const sentinel = path.join(w.vlRoot, 'lock-marker');
    fs.mkdirSync(w.vlRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sentinel, 'held', { mode: 0o600 });

    w.syntheticHost.alive = false;
    w.setVlScenario({ hostState: 'lock', stopAction: 'timeout', declaredPidOverride: null });

    let err = null;
    let res = null;
    try {
      res = await rt2Bundle.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.ok(
      w.syntheticHost.kernelObsCount >= 1,
      `6.2b(lock): recovery runtime deve verificare osservaKernel prima della barriera root (kernelObsCount=${w.syntheticHost.kernelObsCount})`,
    );
    assert.equal(res, null, '6.2b(lock): down non deve completarsi positivo con root lock');
    assert.ok(err && (err.status === 500 || err.status === 409), '6.2b(lock): atteso rifiuto fail-closed');
    assert.deepEqual(w.killCalls, [], '6.2b(lock): zero segnali se originale gia morto');
    assert.equal(fs.existsSync(sentinel), true, '6.2b(lock): nessuna rimozione manuale della root');
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', '6.2b(lock): record intatto');
    assert.equal(
      vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella }),
      'held',
      '6.2b(lock): claim intatta',
    );
  }

  // Parte B: originale morto ma nuovo peer diverso occupa la root -> fail-closed, 0 segnali al nuovo peer.
  {
    const w = creaMondoBar(t, { budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.terminaSupervisoreESessione();
    await w.runtime.shutdown();
    w.mgr.close();

    const rt2Bundle = w.creaSecondoRuntime(2800);
    w.syntheticHost.alive = false;
    w.setVlScenario({
      hostState: 'live',
      stopAction: 'ack',
      afterAckState: 'lock',
      peerPidOverride: NEW_PEER_PID,
      peerStartTicksOverride: '99999',
    });

    let err = null;
    let res = null;
    try {
      res = await rt2Bundle.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.equal(res, null, '6.2b(nuovo-peer): down non deve chiudere con nuovo peer sulla root');
    assert.ok(err && (err.status === 500 || err.status === 409), '6.2b(nuovo-peer): rifiuto fail-closed atteso');
    assert.deepEqual(w.killCalls, [], '6.2b(nuovo-peer): zero segnali al nuovo peer o originale morto');
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', '6.2b(nuovo-peer): record intatto');
    assert.equal(
      vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella }),
      'held',
      '6.2b(nuovo-peer): claim intatta',
    );
  }
});

test('6.3 status none post-shutdown_ack con originale vivo in /proc non promuove host-stopped-clean senza prova uscita kernel', async (t) => {
  const f = creaUnitFixture(t);
  let clock = 30000;
  let statusCalls = 0;
  const killCalls = [];
  let kernelObsCalls = 0;

  const identitaNodo = () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS });
  const identitaCoordinatore = () => ({ pgid: COORD_PID, sid: COORD_PID });
  const osservaPeer = (pid, instanceId) => (pid === HOST_PID
    ? { ...f.record.hostIdentity, instanceId: instanceId || OWNER }
    : null);
  const osservaKernel = (pid, instanceId) => {
    kernelObsCalls += 1;
    return {
      state: 'observed',
      processState: 'S',
      identity: { ...f.record.hostIdentity, pid, instanceId: instanceId || OWNER },
    };
  };

  const spawnImpl = (_bin, args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      statusCalls += 1;
      // Primo probe (qualifica) live; dopo shutdown_ack lo status dichiara state: 'none' mentre /proc resta vivo!
      if (statusCalls <= 1) {
        return creaFakeChild(0, statusPayload({
          state: 'live',
          declaredPid: HOST_PID,
          pidInUse: true,
          peerIdentity: makeVerifiedPeer(f.record.hostIdentity),
        }));
      }
      return creaFakeChild(0, statusPayload({ state: 'none', declaredPid: null, pidInUse: null }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(0, { ok: true, reason: 'shutdown_ack' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  };

  const quali = await hostStop.qualificaIsolamentoHost({
    stateDir: f.stateDir,
    record: f.record,
    bin: f.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: () => clock,
    spawnImpl,
    osservaPeer,
    identitaNodo,
    identitaCoordinatore,
  });
  assert.equal(quali.isolamento, 'isolato', '6.3: isolamento iniziale atteso isolato');

  // Con allowHostRecovery: false, attendiNoneDopoAck non deve mai promuovere host-stopped-clean mentre /proc vede originale vivo.
  const resNoRec = await hostStop.fermaHost({
    stateDir: f.stateDir,
    record: f.record,
    bin: f.bin,
    budgetMs: quali.residuoMs,
    monoNow: () => clock,
    deadlineAt: clock + 8000,
    attesaImpl: async (ms) => { clock += Math.max(1, ms); },
    spawnImpl,
    isolamento: quali.isolamento,
    probeIniziale: quali.probe,
    allowHostRecovery: false,
    osservaKernel,
    identitaNodo,
    identitaCoordinatore,
    fsRecovery: fs,
    // The synthetic PID must never reach the real process.kill default.
    killProcess: (pid, sig) => { killCalls.push({ pid, sig }); return 0; },
  });

  assert.notEqual(
    resNoRec.outcome,
    'host-stopped-clean',
    '6.3: root none dopo shutdown_ack con originale vivo in /proc NON deve mai promuovere host-stopped-clean',
  );
  assert.ok(
    !['host-stopped-clean', 'host-already-stopped', 'host-stopped-attested'].includes(resNoRec.outcome),
    `6.3: atteso esito fail-closed (ricevuto ${resNoRec.outcome})`,
  );
  assert.ok(kernelObsCalls >= 1, '6.3: attendiNoneDopoAck deve verificare osservaKernel oltre al probe none');
  assert.deepEqual(killCalls, [], '6.3: nessun segnale con allowHostRecovery false');
});

// La prova del kernel dopo l'ack, sulla stessa fixture e sullo stesso
// spawn di 6.3: lo stop interno risponde ack e poi lo status dice none; quello
// che cambia, caso per caso, e' cosa risponde il kernel. Nessun segnale.
async function corsaAckProva(f, seams = {}) {
  let clock = 30000;
  let statusCalls = 0;
  let kernelObsCalls = 0;
  const killCalls = [];
  const identitaNodo = seams.nodo || (() => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }));
  // La qualifica usa il nodo del test in cui l'isolamento e' giudicabile; il
  // caso 6.3c (ii) vuole un nodo diverso SOLO per la prova dopo l'ack.
  const nodoQualifica = seams.nodoQualifica || identitaNodo;
  const osservaPeer = (pid, instanceId) => (pid === HOST_PID
    ? { ...f.record.hostIdentity, instanceId: instanceId || OWNER }
    : null);
  const osservaKernel = (pid, instanceId) => {
    kernelObsCalls += 1;
    if (typeof seams.osserva === 'function') return seams.osserva(pid, instanceId);
    return {
      state: 'observed',
      processState: 'S',
      identity: { ...f.record.hostIdentity, pid, instanceId: instanceId || OWNER },
    };
  };
  const spawnImpl = (_bin, args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      statusCalls += 1;
      if (statusCalls <= 1) {
        return creaFakeChild(0, statusPayload({
          state: 'live',
          declaredPid: HOST_PID,
          pidInUse: true,
          peerIdentity: makeVerifiedPeer(f.record.hostIdentity),
        }));
      }
      return creaFakeChild(0, statusPayload({ state: 'none', declaredPid: null, pidInUse: null }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(0, { ok: true, reason: 'shutdown_ack' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  };
  const quali = await hostStop.qualificaIsolamentoHost({
    stateDir: f.stateDir,
    record: f.record,
    bin: f.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: () => clock,
    spawnImpl,
    osservaPeer,
    identitaNodo: nodoQualifica,
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
  });
  assert.equal(quali.isolamento, 'isolato', 'la qualifica iniziale dice isolato');
  const res = await hostStop.fermaHost({
    record: f.record,
    bin: f.bin,
    budgetMs: quali.residuoMs,
    monoNow: () => clock,
    deadlineAt: clock + 8000,
    attesaImpl: async (ms) => { clock += Math.max(1, ms); },
    spawnImpl,
    isolamento: quali.isolamento,
    probeIniziale: quali.probe,
    osservaKernel,
    identitaNodo,
    // Doppio registrante: il pid sintetico non deve mai raggiungere il
    // process.kill reale. Oggi fermaHost non accetta questo seam: resta qui
    // come filo teso se un domani lo raggiungesse.
    killProcess: (pid, sig) => { killCalls.push({ pid, sig }); return 0; },
  });
  return { res, kernelObsCalls, killCalls };
}

test('6.3a positivo: root none dopo shutdown_ack con uscita provata nel dominio registrato chiude host-stopped-clean', async (t) => {
  const f = creaUnitFixture(t);
  const r = await corsaAckProva(f, {
    osserva: () => ({ state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
  });
  assert.equal(r.res.outcome, 'host-stopped-clean', 'l uscita provata promuove a pulito');
  assert.ok(r.kernelObsCalls >= 1, 'la prova interroga il kernel oltre al probe none');
  assert.deepEqual(r.killCalls, [], 'nessun segnale');
});

test('6.3b negativo: osservazione incerta dopo l ack non promuove mai host-stopped-clean', async (t) => {
  const f = creaUnitFixture(t);
  const r = await corsaAckProva(f, { osserva: () => ({ state: 'unverifiable', reason: 'io' }) });
  assert.notEqual(r.res.outcome, 'host-stopped-clean', 'l incertezza non e una prova');
  assert.ok(!['host-stopped-clean', 'host-already-stopped', 'host-stopped-attested'].includes(r.res.outcome),
    `atteso esito fail-closed (ricevuto ${r.res.outcome})`);
  assert.ok(r.kernelObsCalls >= 1, 'il kernel e stato interrogato');
  assert.deepEqual(r.killCalls, [], 'nessun segnale');
});

test('6.3c negativo: dominio diverso, nell osservazione e nel nodo, non promuove mai host-stopped-clean', async (t) => {
  // (i) l'assenza dichiarata riguarda un altro boot: non e prova.
  {
    const f = creaUnitFixture(t);
    const r = await corsaAckProva(f, {
      osserva: () => ({
        state: 'absent',
        node: { bootId: '32345678-1234-4234-8234-123456789abc', pidNamespaceInode: PID_NS },
      }),
    });
    assert.notEqual(r.res.outcome, 'host-stopped-clean', 'assente in un altro boot non promuove');
    assert.ok(r.kernelObsCalls >= 1, 'il kernel e stato interrogato');
    assert.deepEqual(r.killCalls, [], 'nessun segnale');
  }
  // (ii) il nodo che osserva non e quello registrato: nessuna promozione.
  {
    const f = creaUnitFixture(t);
    const r = await corsaAckProva(f, {
      nodo: () => ({ bootId: '32345678-1234-4234-8234-123456789abc', pidNamespaceInode: PID_NS }),
      nodoQualifica: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    });
    assert.notEqual(r.res.outcome, 'host-stopped-clean', 'un altro nodo non promuove');
    assert.ok(!['host-stopped-clean', 'host-already-stopped', 'host-stopped-attested'].includes(r.res.outcome),
      `atteso esito fail-closed (ricevuto ${r.res.outcome})`);
    assert.deepEqual(r.killCalls, [], 'nessun segnale');
  }
});

test('6.4a entry server-absent su recover chiude con root qualificata e blocca con base spostata o illeggibile', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '6.4a: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  // (1) Percorso server-absent con tupla v2 valida e root/base qualificata: ferma originale e chiude attested.
  {
    const fx = creaUnitFixture(t, { useCellBase: true });
    let alive = true;
    let clock = 40000;
    const killCalls = [];

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => {
        killCalls.push({ pid, sig });
        if (pid === HOST_PID && sig === 'SIGTERM') alive = false;
      },
      osservaKernel: (pid, instanceId) => (alive && pid === HOST_PID
        ? { state: 'observed', processState: 'S', identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER } }
        : { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({
        r: { ok: true },
        stato: { ok: true, state: alive ? 'server_absent' : 'none', declared_pid: null, pid_number_in_use: null },
      }),
    });
    assertFactoryMethods(factory, '6.4a');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'expected');
    assert.equal(opened && opened.ok, true, '6.4a(ok): openAttempt deve riuscire');

    let res;
    try {
      res = await factory.recover(opened.attempt, 'server-absent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(res && res.outcome, 'host-stopped-attested', '6.4a(ok): atteso host-stopped-attested');
    assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], '6.4a(ok): atteso SIGTERM su tupla v2');
  }

  // (2) Base/serverRoot sostituita da symlink (spostata) -> blocca fail-closed con zero segnali.
  {
    const fx = creaUnitFixture(t, { useCellBase: true });
    const relocated = path.join(fx.root, 'relocated-root');
    fs.mkdirSync(relocated, { recursive: true, mode: 0o700 });
    fs.rmSync(fx.serverRoot, { recursive: true, force: true });
    fs.symlinkSync(relocated, fx.serverRoot);

    let clock = 50000;
    const killCalls = [];
    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx.record.hostIdentity, pid, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({
        r: { ok: true },
        stato: { ok: true, state: 'server_absent', declared_pid: null, pid_number_in_use: null },
      }),
    });

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'expected');

    if (opened && opened.ok) {
      let res;
      try {
        res = await factory.recover(opened.attempt, 'server-absent');
      } finally {
        factory.closeAttempt(opened.attempt);
      }
      assert.ok(
        !['host-stopped-attested', 'host-already-stopped', 'host-stopped-clean'].includes(res && res.outcome),
        `6.4a(symlink): serverRoot spostata/symlinked non deve chiudere positivo (ricevuto ${res && res.outcome})`,
      );
    }
    assert.deepEqual(killCalls, [], '6.4a(symlink): zero segnali con base non qualificata');
  }
});

test('6.4b runtime down su server_absent verifica qualifica root e base e blocca se spostata o illeggibile', async (t) => {
  // Parte A: root/base sostituita da symlink durante server_absent deve rifiutare fail-closed (no falso host-already-stopped).
  {
    const w = creaMondoBar(t, { budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
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
      vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella }),
      'held',
      '6.4b(spostata): claim non rilasciata',
    );
  }

  // Parte B: root qualificata su server_absent ma originale vivo -> verifica kernel e ferma originale via recovery.
  {
    const w = creaMondoBar(t, { budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.terminaSupervisoreESessione();
    await w.runtime.shutdown();
    w.mgr.close();

    const rt2Bundle = w.creaSecondoRuntime(2800);
    fs.mkdirSync(w.vlRoot, { recursive: true, mode: 0o700 });
    w.syntheticHost.alive = true;
    w.setOnKillProcess((pid, sig) => {
      if (pid === HOST_PID && sig === 'SIGTERM') {
        w.syntheticHost.alive = false;
        w.setVlScenario({ hostState: 'none', afterAckState: 'none' });
      }
    });
    w.setVlScenario({ hostState: 'live', stopAction: 'server_absent', afterAckState: 'none' });

    let err = null;
    let res = null;
    try {
      res = await rt2Bundle.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.equal(err, null, `6.4b(qualificata): down con root qualificata e morte attestata deve riuscire (${err && err.fleetCode})`);
    assert.equal(res && res.ok, true, '6.4b(qualificata): atteso ok:true');
    assert.ok(w.syntheticHost.kernelObsCount >= 1, '6.4b(qualificata): deve verificare kernel su server_absent');
    assert.deepEqual(w.killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], '6.4b(qualificata): atteso SIGTERM su originale vivo');
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'assente', '6.4b(qualificata): record chiuso');
  }
});

test('6.5 esito host-stopped-attested distinto da host-stopped-clean e da killed tmux in chiudiHostPoiLease e downSerializzato', async (t) => {
  // Parte A: canale vivo (downSerializzato) -> host-stopped-attested method:term distinto da clean e da tmux killed.
  {
    const w = creaMondoBar(t, { budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.attaccaSupervisore();

    w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'lock' });
    w.setOnKillProcess((pid, sig) => {
      if (pid === HOST_PID && sig === 'SIGTERM') {
        w.syntheticHost.alive = false;
        w.setVlScenario({ hostState: 'none', afterAckState: 'none' });
      }
    });

    let err = null;
    let res = null;
    try {
      res = await w.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.equal(err, null, `6.5(canale-vivo): down dopo stop forzato attestato deve riuscire (${err && err.fleetCode})`);
    assert.equal(res && res.ok, true, '6.5(canale-vivo): ok:true atteso');
    assert.deepEqual(
      res && res.host,
      { outcome: 'host-stopped-attested', method: 'term' },
      '6.5(canale-vivo): res.host deve riportare host-stopped-attested method term',
    );
    assert.notEqual(res.host.outcome, 'host-stopped-clean', '6.5(canale-vivo): non collassare in clean');
    assert.equal(typeof res.killed, 'boolean', '6.5(canale-vivo): campo killed tmux separato da res.host');
  }

  // Parte B: canale assente (chiudiHostPoiLease) -> escalation SIGKILL accetta host-stopped-attested senza confonderlo con killed tmux/clean.
  {
    const w = creaMondoBar(t, { budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.terminaSupervisoreESessione();
    await w.runtime.shutdown();
    w.mgr.close();

    const rt2Bundle = w.creaSecondoRuntime(2800);
    w.setVlScenario({ hostState: 'lock', stopAction: 'timeout', declaredPidOverride: null });
    w.setOnKillProcess((pid, sig) => {
      if (pid === HOST_PID && sig === 'SIGKILL') {
        w.syntheticHost.alive = false;
        w.setVlScenario({ hostState: 'none' });
      }
    });

    let err = null;
    let res = null;
    try {
      res = await rt2Bundle.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.equal(err, null, `6.5(chiudiHostPoiLease): down dopo SIGKILL attestato deve chiudere (${err && err.fleetCode})`);
    assert.deepEqual(
      { ok: Boolean(res && res.ok), outcome: res && res.outcome },
      { ok: true, outcome: 'resolved-dead' },
      '6.5(chiudiHostPoiLease): atteso resolved-dead',
    );
    assert.equal(res && res.host && res.host.outcome, 'host-stopped-attested', '6.5(chiudiHostPoiLease): host attestato richiesto');
    assert.equal(res && res.host && res.host.method, 'kill', '6.5(chiudiHostPoiLease): metodo kill osservato');
    assert.notEqual(res && res.host && res.host.outcome, 'host-stopped-clean', '6.5(chiudiHostPoiLease): host non e clean');
    assert.notEqual(res.killed, true, '6.5(chiudiHostPoiLease): sessione gia assente, killed tmux resta false');
    assert.deepEqual(
      w.killCalls,
      [{ pid: HOST_PID, sig: 'SIGTERM' }, { pid: HOST_PID, sig: 'SIGKILL' }],
      '6.5(chiudiHostPoiLease): escalation SIGTERM poi SIGKILL eseguita',
    );
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'assente', '6.5(chiudiHostPoiLease): record chiuso');
  }
});

test('6.6 ogni caso non provato conserva claim e record intatti sia su downSerializzato sia su chiudiHostPoiLease', async (t) => {
  // Parte A: chiudiHostPoiLease con kernel unverifiable -> zero segnali, record e claim intatti.
  {
    const w = creaMondoBar(t, { budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.terminaSupervisoreESessione();
    await w.runtime.shutdown();
    w.mgr.close();

    const rt2Bundle = w.creaSecondoRuntime(2800);
    const lid = launchTarget.leggi(w.filesRoot, w.sessione).record.launchId;
    w.syntheticHost.kernelOverride = { state: 'unverifiable', reason: 'access' };
    w.setVlScenario({ hostState: 'lock', stopAction: 'timeout', declaredPidOverride: null });

    let err = null;
    let res = null;
    try {
      res = await rt2Bundle.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.ok(
      w.syntheticHost.kernelObsCount >= 1,
      `6.6(unverifiable): down deve interrogare osservaKernel prima del rifiuto (kernelObsCount=${w.syntheticHost.kernelObsCount})`,
    );
    assert.equal(res, null, '6.6(unverifiable): nessun esito positivo su stato non provato');
    assert.ok(err && (err.status === 500 || err.status === 409), '6.6(unverifiable): rifiuto fail-closed atteso');
    assert.deepEqual(w.killCalls, [], '6.6(unverifiable): zero segnali su kernel inverificabile');
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', '6.6(unverifiable): record non rimosso');
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).record.launchId, lid, '6.6(unverifiable): launchId invariato');
    assert.equal(
      vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella }),
      'held',
      '6.6(unverifiable): claim non rilasciata',
    );
  }

  // Parte B: downSerializzato con EPERM su killProcess -> esito non provato, claim e record preservati.
  {
    const w = creaMondoBar(t, { budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.attaccaSupervisore();

    const lid = launchTarget.leggi(w.filesRoot, w.sessione).record.launchId;
    w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'lock' });
    w.setOnKillProcess((_pid, sig) => {
      if (sig === 'SIGTERM') {
        const e = new Error('operation not permitted');
        e.code = 'EPERM';
        throw e;
      }
    });

    let err = null;
    let res = null;
    try {
      res = await w.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.ok(w.killCalls.some((c) => c.sig === 'SIGTERM'), '6.6(EPERM): SIGTERM deve essere tentato nel percorso recovery');
    assert.equal(res, null, '6.6(EPERM): down non deve chiudere positivo dopo EPERM');
    assert.ok(err && (err.status === 500 || err.status === 409), '6.6(EPERM): rifiuto fail-closed atteso');
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', '6.6(EPERM): record non rimosso');
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).record.launchId, lid, '6.6(EPERM): launchId invariato');
    assert.equal(
      vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella }),
      'held',
      '6.6(EPERM): claim non rilasciata',
    );
  }
});
