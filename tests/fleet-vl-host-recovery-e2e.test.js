'use strict';

// End-to-end host recovery tests (1.1, 1.2, 1.3).
// All cases run in isolated per-test directories with synthetic fake-tmux,
// synthetic fake-vl, real createLeaseManager + Unix control socket pair,
// real launch-target / vl-roots / host-context.json, and synthetic
// vlIsolationSeams (zero real signals to unowned PIDs, zero live Fleet).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { atomicWrite, loadDefinitions, sharedGroupId } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');
const gruppo = require('../lib/fleet/group-stop.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const vlRoots = require('../lib/fleet/vl-roots.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const { leggiContesto } = require('../lib/fleet/vl-host-stop.js');

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

test('1.1 E2E prepare->prepare-ack->shutdown_ack con host vivo in lock invia TERM alla tupla, osserva uscita+none e chiude host-stopped-attested (method:term) con zero cambi VL', async (t) => {
  const w = creaMondoE2E(t, { budgetMs: 8000 });
  await attesaPgrpFiglio(w.paneChild.pid);
  const vlShaBefore = sha256File(w.vlBin);

  const upRes = await w.runtime.up(CELLA);
  assert.equal(upRes && upRes.ok, true, '1.1: up iniziale deve riuscire');

  const ctxAfterUp = leggiContesto(w.cellBase);
  assert.equal(ctxAfterUp && ctxAfterUp.version, 2);
  assert.equal(ctxAfterUp.hostIdentity && ctxAfterUp.hostIdentity.state, 'live');
  assert.equal(ctxAfterUp.hostIdentity && ctxAfterUp.hostIdentity.pid, HOST_PID);

  const sup = await attaccaSupervisore(t, w);
  w.setVlScenario({ hostState: 'live', stopMode: 'shutdown_ack_keep_lock' });

  let downRes = null;
  let downErr = null;
  try {
    downRes = await w.runtime.down(CELLA);
  } catch (e) {
    if (!e || e.fleetCode !== 'HOST_STOP_FAILED' || !e.data || e.data.outcome !== 'host-stop-failed') {
      throw e;
    }
    downErr = e;
  }

  assert.deepEqual(
    {
      err: downErr ? { fleetCode: downErr.fleetCode, data: downErr.data } : null,
      ok: Boolean(downRes && downRes.ok),
      host: downRes ? downRes.host : null,
    },
    {
      err: null,
      ok: true,
      host: { outcome: 'host-stopped-attested', method: 'term' },
    },
    '1.1: down deve completarsi senza errore con host:{outcome:host-stopped-attested,method:term}',
  );
  assert.equal(downRes && downRes.ok, true, '1.1: down deve completarsi ok:true');
  assert.deepEqual(
    downRes.host,
    { outcome: 'host-stopped-attested', method: 'term' },
    '1.1: esito host deve attestare stop forzato con method:term',
  );
  assert.ok(
    sup.framesRicevuti.some((f) => f.op === 'prepare'),
    '1.1: coordinatore deve ricevere prepare sul canale di controllo',
  );
  assert.ok(
    sup.framesInviati.some((f) => f.op === 'prepare-ack'),
    '1.1: coordinatore deve emettere prepare-ack sul canale di controllo',
  );

  const vlCalls = w.readVlCalls();
  assert.ok(
    vlCalls.some((c) => c[0] === 'internal' && c[1] === 'host-stop' && c.includes('--expected')),
    '1.1: CLI internal host-stop --expected deve essere invocata una volta prima del recovery',
  );
  assert.deepEqual(
    w.syntheticHost.killCalls,
    [{ pid: HOST_PID, signal: 'SIGTERM' }],
    '1.1: solo SIGTERM alla tupla host v2 viva in lock, zero SIGKILL',
  );
  assert.ok(
    w.syntheticHost.kernelObsPostKill.length >= 1,
    '1.1: uscita originale provata da osservaKernel dopo SIGTERM',
  );

  const idxTerm = w.syntheticHost.eventOrder.indexOf(`signal:SIGTERM:${HOST_PID}`);
  const idxSupStop = w.syntheticHost.eventOrder.indexOf('supervisor-kill:SIGTERM');
  assert.ok(idxTerm >= 0 && idxSupStop > idxTerm, '1.1: stop host attestato precede chiusura supervisore/sessione');

  assert.equal(launchTarget.leggi(w.filesRoot, SESSIONE).stato, 'assente', '1.1: record launch-target chiuso e rimosso');
  const claimState = vlRoots.osservaClaim({
    home: w.home,
    root: w.vlRoot,
    ownerInstanceId: OWNER_INSTANCE_ID,
    cellId: CELLA,
  });
  assert.ok(['released', 'none'].includes(claimState), `1.1: claim root rilasciata (trovato ${claimState})`);

  // Nessun intervento manuale/force sui file VL né mutazione del binario pinnato.
  assert.equal(sha256File(w.vlBin), vlShaBefore, '1.1: binario VL pinnato invariato byte-per-byte');
  assert.ok(
    !vlCalls.some((c) => c.includes('--force')),
    '1.1: zero cambi VL forzati',
  );
});

test('1.2 seconda /down con lock_held_socket_silent recupera da tupla v2: (a) host vivo riceve TERM e chiude; (b) morte gia provata dopo commit fallito chiude senza re-TERM', async (t) => {
  // Premessa separata (a): retry silent con host ancora vivo in lock_held_socket_silent.
  {
    let leaseStateOverride = 'grace';
    const w = creaMondoE2E(t, {
      budgetMs: 8000,
      mgrWrapper: (mgrReale) => new Proxy(mgrReale, {
        get(target, prop) {
          if (prop === 'status') {
            return (id) => {
              const s = target.status(id);
              if (id === CELLA && leaseStateOverride) return { ...s, state: leaseStateOverride };
              return s;
            };
          }
          const v = target[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
    });

    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(CELLA);
    const sup = await attaccaSupervisore(t, w);

    // Supervisore e sessione terminano; lease in grace blocca il 1° down,
    // poi il socket host diventa silente (lock_held_socket_silent) con PID dichiarato fuorviante.
    await terminaSupervisoreESessione(w, sup);
    w.setVlScenario({
      hostState: 'lock_held_socket_silent',
      stopMode: 'timeout',
      stopFailReason: 'timeout',
      declaredPidOverride: 999991,
    });
    // La premessa del caso e' «canale di controllo gia' morto PRIMA del down»:
    // non un fatto che un tempo fisso possa garantire (sotto carico il canale
    // moriva DURANTE la verifica e il primo down rispondeva con l'esito
    // sbagliato). Si spegne il runtime che possedeva il canale e i down che
    // seguono partono da un runtime nuovo: il canale e' assente per
    // costruzione e non puo' riagganciarsi, perche' il pane child e' morto.
    w.runtime.shutdown();
    const rt2 = w.creaRuntimeInstance();
    t.after(() => { try { rt2.shutdown(); } catch (_) {} });

    await assert.rejects(
      () => rt2.down(CELLA),
      (err) => err
        && typeof err.fleetCode === 'string'
        && err.data && err.data.prove
        && err.data.prove.blocchi
        && err.data.prove.blocchi.length === 1
        && err.data.prove.blocchi[0] === 'LEASE_BLOCKS',
      '1.2(a): primo down durante grace rifiuta solo per LEASE_BLOCKS senza toccare host',
    );
    assert.equal(w.syntheticHost.killCalls.length, 0, '1.2(a): zero segnali durante il blocco grace');

    // Lease scaduta: secondo down su stato lock_held_socket_silent deve recuperare dalla tupla v2 (HOST_PID).
    leaseStateOverride = 'expired';
    let res2 = null;
    let err2 = null;
    try {
      res2 = await rt2.down(CELLA);
    } catch (e) {
      if (!e || e.fleetCode !== 'HOST_STOP_FAILED' || !e.data || e.data.outcome !== 'host-stop-failed') {
        throw e;
      }
      err2 = e;
    }

    assert.deepEqual(
      {
        err: err2 ? { fleetCode: err2.fleetCode, data: err2.data } : null,
        ok: Boolean(res2 && res2.ok),
        outcome: res2 ? res2.outcome : null,
      },
      {
        err: null,
        ok: true,
        outcome: 'resolved-dead',
      },
      '1.2(a): secondo down con lock_held_socket_silent deve chiudere ok:true con outcome resolved-dead',
    );
    assert.equal(res2 && res2.ok, true, '1.2(a): secondo down deve chiudere ok:true');
    assert.deepEqual(
      w.syntheticHost.killCalls,
      [{ pid: HOST_PID, signal: 'SIGTERM' }],
      '1.2(a): recovery silent deve inviare SIGTERM al PID della tupla v2 ignorando declared_pid',
    );
    assert.equal(launchTarget.leggi(w.filesRoot, SESSIONE).stato, 'assente', '1.2(a): record launch-target chiuso');
    const claimA = vlRoots.osservaClaim({
      home: w.home,
      root: w.vlRoot,
      ownerInstanceId: OWNER_INSTANCE_ID,
      cellId: CELLA,
    });
    assert.ok(['released', 'none'].includes(claimA), `1.2(a): claim rilasciata (trovato ${claimA})`);
  }

  // Premessa separata (b): morte gia provata durante 1ª /down + errore commit quarantena -> 2ª /down chiude senza re-TERM.
  {
    let leaseStateOverride = 'expired';
    const w = creaMondoE2E(t, {
      budgetMs: 8000,
      mgrWrapper: (mgrReale) => new Proxy(mgrReale, {
        get(target, prop) {
          if (prop === 'status') {
            return (id) => {
              const s = target.status(id);
              if (id === CELLA && leaseStateOverride) return { ...s, state: leaseStateOverride };
              return s;
            };
          }
          const v = target[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
    });

    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(CELLA);
    const sup = await attaccaSupervisore(t, w);
    await terminaSupervisoreESessione(w, sup);

    w.setVlScenario({
      hostState: 'lock_held_socket_silent',
      stopMode: 'timeout',
      stopFailReason: 'timeout',
    });

    // Forza fallimento del solo commit quarantena dopo che la barriera host ha ucciso/provato l'uscita dell'host.
    const quarantineDir = path.join(w.filesRoot, '.launch-targets', 'quarantine');
    fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o500 });
    fs.chmodSync(quarantineDir, 0o500);

    let err1 = null;
    try {
      await w.runtime.down(CELLA);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && typeof e.code !== 'string')) throw e;
      err1 = e;
    }
    assert.ok(err1, '1.2(b): primo down deve fallire al commit quarantena');
    assert.deepEqual(
      w.syntheticHost.killCalls,
      [{ pid: HOST_PID, signal: 'SIGTERM' }],
      '1.2(b): prima /down deve avere provato l uscita dell host via SIGTERM prima del fallimento commit',
    );
    assert.equal(w.syntheticHost.alive, false, '1.2(b): host deve risultare morto dopo il primo down');
    const afterFail = launchTarget.leggi(w.filesRoot, SESSIONE);
    assert.equal(afterFail.stato, 'presente', '1.2(b): record resta presente dopo errore commit');
    assert.equal(afterFail.record.incerto, true, '1.2(b): incerto:true conservato');

    // Ripristina la directory di quarantena ed esegue seconda /down su prove fresche senza nuovo segnale.
    fs.chmodSync(quarantineDir, 0o700);
    const killsBeforeSecond = w.syntheticHost.killCalls.length;
    const kernelObsBeforeSecond = w.syntheticHost.kernelObsCount;
    const vlCallsBeforeSecond = w.readVlCalls();
    const statusCountBefore = vlCallsBeforeSecond.filter((c) => c[0] === 'host' && c[1] === 'status').length;
    const stopCountBefore = vlCallsBeforeSecond.filter((c) => c[0] === 'internal' && c[1] === 'host-stop').length;

    let res2 = null;
    let err2 = null;
    try {
      res2 = await w.runtime.down(CELLA);
    } catch (e) {
      if (!e || e.fleetCode !== 'HOST_STOP_FAILED' || !e.data || e.data.outcome !== 'host-stop-failed') {
        throw e;
      }
      err2 = e;
    }

    assert.deepEqual(
      {
        err: err2 ? { fleetCode: err2.fleetCode, data: err2.data } : null,
        ok: Boolean(res2 && res2.ok),
        outcome: res2 ? res2.outcome : null,
      },
      {
        err: null,
        ok: true,
        outcome: 'resolved-dead',
      },
      '1.2(b): seconda /down deve chiudere ok:true con outcome resolved-dead dopo commit ripristinato',
    );
    assert.equal(res2 && res2.ok, true, '1.2(b): seconda /down chiude ok:true dopo commit ripristinato');
    assert.equal(
      w.syntheticHost.killCalls.length,
      killsBeforeSecond,
      '1.2(b): zero re-TERM o altri segnali sul secondo down quando la morte e gia provata',
    );
    const vlCallsAfterSecond = w.readVlCalls();
    const statusCountAfter = vlCallsAfterSecond.filter((c) => c[0] === 'host' && c[1] === 'status').length;
    const stopCountAfter = vlCallsAfterSecond.filter((c) => c[0] === 'internal' && c[1] === 'host-stop').length;
    assert.ok(
      w.syntheticHost.kernelObsCount > kernelObsBeforeSecond && statusCountAfter > statusCountBefore,
      '1.2(b): seconda /down verifica prove fresche (kernel + sonda root none), nessun replay da sola traccia',
    );
    assert.equal(
      stopCountAfter,
      stopCountBefore,
      '1.2(b): nessuna nuova invocazione CLI socket se host gia morto/none',
    );
    assert.equal(launchTarget.leggi(w.filesRoot, SESSIONE).stato, 'assente', '1.2(b): record chiuso definitivamente');
    const claimB = vlRoots.osservaClaim({
      home: w.home,
      root: w.vlRoot,
      ownerInstanceId: OWNER_INSTANCE_ID,
      cellId: CELLA,
    });
    assert.ok(['released', 'none'].includes(claimB), `1.2(b): claim rilasciata (trovato ${claimB})`);
  }
});

test('1.3 seconda /down da prepared chiude (host:never-materialized) entro budget, zero segnali host', async (t) => {
  // Parte A: coordinatore gia preparato dopo prepare->prepare-ack sul 1° down fallito;
  // il 2° down non deve restare bloccato su STOP_UNKNOWN sul 2° prepare
  // e deve chiudere entro budget con zero segnali host.
  {
    const budgetMs = 4000;
    const w = creaMondoE2E(t, { budgetMs });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(CELLA);
    const sup = await attaccaSupervisore(t, w);

    // Primo down esegue prepare->prepare-ack sul coordinatore, poi fallisce allo step host
    // per status corrotto (senza segnali host né chiusura del coordinatore/canale).
    w.setVlScenario({ hostState: 'live', corruptStatusOnce: true });
    let err1 = null;
    try {
      await w.runtime.down(CELLA);
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

    // Host ora none/absent: il 2° down non invia segnali host e deve concludersi senza STOP_UNKNOWN.
    w.syntheticHost.alive = false;
    w.setVlScenario({ hostState: 'none', hostAlive: false });

    const t0 = Date.now();
    let res2 = null;
    let err2 = null;
    try {
      res2 = await w.runtime.down(CELLA);
    } catch (e) {
      if (!e || e.fleetCode !== 'STOP_UNKNOWN' || !e.data || e.data.outcome !== 'stop-unknown') {
        throw e;
      }
      err2 = e;
    }
    const elapsedMs = Date.now() - t0;

    assert.deepEqual(
      {
        err: err2 ? { fleetCode: err2.fleetCode, data: err2.data } : null,
        ok: Boolean(res2 && res2.ok),
        outcome: res2 ? res2.outcome : null,
      },
      {
        err: null,
        ok: true,
        outcome: 'attested-exit',
      },
      '1.3(a): secondo down da coordinatore preparato deve chiudere ok:true con outcome attested-exit',
    );
    assert.equal(res2 && res2.ok, true, '1.3(a): secondo down da coordinatore preparato deve chiudere ok:true');
    assert.ok(elapsedMs < budgetMs, `1.3(a): secondo down completato entro budget (${elapsedMs}ms < ${budgetMs}ms)`);
    assert.equal(w.syntheticHost.killCalls.length, 0, '1.3(a): zero segnali host');
    assert.equal(launchTarget.leggi(w.filesRoot, SESSIONE).stato, 'assente', '1.3(a): record chiuso');
    const claimA = vlRoots.osservaClaim({
      home: w.home,
      root: w.vlRoot,
      ownerInstanceId: OWNER_INSTANCE_ID,
      cellId: CELLA,
    });
    assert.ok(['released', 'none'].includes(claimA), `1.3(a): claim rilasciata (trovato ${claimA})`);
  }

  // Parte B: launch-target v2 in phase=prepared mai materializzato -> down chiude host:'never-materialized'.
  {
    const budgetMs = 4000;
    const w = creaMondoE2E(t, { budgetMs });
    w.syntheticHost.alive = false;
    w.setVlScenario({ hostState: 'none', hostAlive: false });

    const lid = hexId(8);
    const prep = launchTarget.registraPrepared(w.filesRoot, SESSIONE, {
      launchId: lid,
      family: 'vl',
      cellId: CELLA,
      ownerInstanceId: OWNER_INSTANCE_ID,
      tmuxSocket: path.join(w.root, 'tmux.sock'),
      bootId: REAL_BOOT_ID,
      pidNs: REAL_NS_INODE,
      daemonInc: 'inc-e2e-13',
      res: { vlOwner: OWNER_INSTANCE_ID, vlRoot: w.vlRoot },
    });
    assert.equal(prep && prep.ok, true, '1.3(b): record prepared scritto');

    const t0 = Date.now();
    let resPrep = null;
    let errPrep = null;
    try {
      resPrep = await w.runtime.down(CELLA);
    } catch (e) {
      if (!e || typeof e.fleetCode !== 'string') throw e;
      errPrep = e;
    }
    const elapsedMs = Date.now() - t0;

    assert.deepEqual(
      {
        err: errPrep ? { fleetCode: errPrep.fleetCode, data: errPrep.data } : null,
        ok: Boolean(resPrep && resPrep.ok),
        host: resPrep ? resPrep.host : null,
        outcome: resPrep ? resPrep.outcome : null,
      },
      {
        err: null,
        ok: true,
        host: 'never-materialized',
        outcome: 'resolved-unlaunched',
      },
      '1.3(b): down su phase=prepared deve chiudere ok:true con host:never-materialized',
    );
    assert.equal(resPrep && resPrep.ok, true, '1.3(b): down su phase=prepared deve chiudere ok:true');
    assert.equal(resPrep.host, 'never-materialized', '1.3(b): esito host deve essere never-materialized');
    assert.equal(resPrep.outcome, 'resolved-unlaunched', '1.3(b): outcome resolved-unlaunched');
    assert.ok(elapsedMs < budgetMs, `1.3(b): down prepared entro budget (${elapsedMs}ms < ${budgetMs}ms)`);
    assert.equal(w.syntheticHost.killCalls.length, 0, '1.3(b): zero segnali host su phase=prepared');
    assert.equal(launchTarget.leggi(w.filesRoot, SESSIONE).stato, 'assente', '1.3(b): record prepared chiuso');
  }
});
