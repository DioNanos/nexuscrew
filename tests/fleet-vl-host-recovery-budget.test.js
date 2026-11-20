'use strict';

const { piano } = require('./helpers/phase-plan.js');
const { verificaContrattoUi } = require('./helpers/ui-power-i18n.js');

// Host recovery budget partitioning, DM-11/DM-12 caps, passive surface guards, and diagnostics tests (9.1 - 9.7b).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
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
const { publishExclusive, pubblicaEsclusiva } = require('../lib/fleet/exclusive-publish.js');

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

test('9.1 tempo CLI scala dalla stessa deadline con riserve minime pre-CLI e budget insufficiente rifiuta prima di segnalare', async (t) => {
  // Parte A: con budget condiviso (2800 ms) dopo host-stop senza uscita raggiunge SIGTERM.
  {
    const w = creaMondoBud(t, { budgetMs: 2800, useScenarioClock: true });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.attaccaSupervisore();

    w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live', stopAdvanceMs: 200 });
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

    assert.equal(
      err,
      null,
      `9.1(cli-budget): con budget residuo > riserva SIGTERM deve completare recovery senza errore (${err && err.fleetCode})`,
    );
    assert.equal(res && res.ok, true, '9.1(cli-budget): atteso ok:true');
    assert.deepEqual(w.killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], '9.1(cli-budget): atteso SIGTERM entro deadline');
  }

  // Parte B: il consumo del CLI eccede l'allowance della fase CLI -> rifiuta
  // senza segnali. Premessa corretta: qui supervisore e sessione sono già
  // terminati, quindi la fase P8 non si prenota e la riserva pre-TERM è
  // 200 + M = 287, non 337. I ~300 ms che restano sono sopra i 287: il caso
  // NON isola la riserva, e il rifiuto non viene dal residuo post-CLI ma dal
  // consumo del CLI rispetto alla sua allowance. Asserisce il contratto
  // osservabile — nessun segnale, record intatto — e la soglia si prova a 9.3
  // chiamando il confine con clock governato.
  {
    const w = creaMondoBud(t, { budgetMs: 2800, useScenarioClock: true });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.terminaSupervisoreESessione();
    await w.runtime.shutdown();

    const rt2 = w.creaSecondoRuntime(2800);
    // Il probe+CLI consuma quasi tutto il budget: e' il CONSUMO del CLI a
    // eccedere la sua allowance, non il residuo post-CLI a essere la causa. I
    // ~300 ms che restano sono sopra i 287 della riserva pre-TERM (200 + M),
    // quindi il caso non isola la riserva; la soglia si prova a 9.3 con il
    // clock governato.
    w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live', stopAdvanceMs: 2500 });

    let err = null;
    let res = null;
    try {
      res = await rt2.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.equal(res, null, '9.1(pre-term-reserve): budget sotto riserva minima deve rifiutare');
    assert.ok(err && (err.status === 409 || err.status === 500), '9.1(pre-term-reserve): status errore atteso');
    assert.deepEqual(w.killCalls, [], '9.1(pre-term-reserve): zero segnali se manca riserva pre-SIGTERM');
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', '9.1(pre-term-reserve): record intatto');
  }
});

test('9.2 scadenza prima del segnale, tra SIGTERM e SIGKILL o prima del commit incluso none tardivo produce zero segnali o commit tardivi', async (t) => {
  // Parte A: scadenza raggiunta dopo SIGTERM con < (200+M) residuo -> zero SIGKILL tardivo.
  {
    const w = creaMondoBud(t, { budgetMs: 2800, useScenarioClock: true });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.terminaSupervisoreESessione();
    await w.runtime.shutdown();

    const rt2 = w.creaSecondoRuntime(2800);
    w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live' });
    w.setOnKillProcess((_pid, sig) => {
      if (sig === 'SIGTERM') {
        w.advanceBaseMono(2600); // lascia < 200+M prima di SIGKILL
      }
    });

    let err = null;
    let res = null;
    try {
      res = await rt2.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.equal(res, null, '9.2(tra-term-kill): scadenza tra TERM e KILL non deve chiudere');
    assert.deepEqual(
      w.killCalls,
      [{ pid: HOST_PID, sig: 'SIGTERM' }],
      `9.2(tra-term-kill): atteso solo SIGTERM e zero SIGKILL tardivo (killCalls=${JSON.stringify(w.killCalls)})`,
    );
    assert.ok(err !== null, '9.2(tra-term-kill): errore atteso');
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', '9.2(tra-term-kill): record intatto');
  }

  // Parte B: morte/none tardivo osservato oltre deadline non puo committare il record.
  {
    const w = creaMondoBud(t, { budgetMs: 2800, useScenarioClock: true });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.terminaSupervisoreESessione();
    await w.runtime.shutdown();

    const rt2 = w.creaSecondoRuntime(2800);
    w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live' });
    w.setOnKillProcess((pid, sig) => {
      if (pid === HOST_PID && sig === 'SIGTERM') {
        w.syntheticHost.alive = false;
        w.setVlScenario({ hostState: 'none', afterAckState: 'none' });
        w.advanceBaseMono(4000); // oltre deadlineAt al ritorno/commit
      }
    });

    let err = null;
    let res = null;
    try {
      res = await rt2.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.equal(res, null, '9.2(none-tardivo): none oltre deadline non deve MAI promuovere chiusura');
    assert.ok(err !== null, '9.2(none-tardivo): errore fail-closed atteso');
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', '9.2(none-tardivo): record non committato');
    assert.equal(vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella }), 'held', '9.2(none-tardivo): claim intatta');
  }
});

test('9.3 clock finto fermo su recover rispetta il cap finito di iterazioni senza loop infinito', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '9.3: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  // Le soglie si provano CHIAMANDO il confine con un clock governato, non
  // confrontando costanti del test: per ogni budget la riserva pre-TERM
  // (250+M) ammette esattamente al suo valore e rifiuta un millisecondo sotto,
  // con zero effetti; lo stesso per la riserva pre-KILL (200+M), governando il
  // clock dentro la syscall del TERM. Il clock e' fermo, quindi il residuo non
  // cambia per effetto di attese. B=200 resta fuori da queste coppie: le sue
  // riserve (256 e 206) superano l'intero budget, quindi un residuo alla
  // riserva porrebbe il clock prima di T0=D-B, fuori dalla finestra
  // autorizzata. Per B=200 si prova il rifiuto all'origine (blocco sotto).
  const SOGLIE_PROVATE = [2800, 8000, 15000];
  const sondaConfine = async ({ budget, residuoIniziale, dopoTerm }) => {
    const fx2 = creaUnitFixture(t);
    const deadline = 400000 + budget;
    let clock = deadline - residuoIniziale;
    const killCalls2 = [];
    const factory2 = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => {
        killCalls2.push({ pid, sig });
        if (sig === 'SIGTERM' && typeof dopoTerm === 'number') clock = deadline - dopoTerm;
      },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx2.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async () => {},
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory2, '9.3(soglie)');
    const opened2 = factory2.openAttempt({
      record: fx2.record,
      stateDir: fx2.stateDir,
      deadlineAt: deadline,
      phasePlan: piano(budget, deadline),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    return { factory2, opened2, killCalls2 };
  };

  for (const budget of SOGLIE_PROVATE) {
    const p = piano(budget, 400000 + budget);
    const m = p.marginMs;
    // Riserva pre-TERM: 250 + M.
    for (const [caso, residuoIniziale, attesi] of [
      ['sotto-riserva', 250 + m - 1, []],
      ['alla-riserva', 250 + m, ['SIGTERM', 'SIGKILL']],
    ]) {
      const s = await sondaConfine({ budget, residuoIniziale });
      assert.equal(s.opened2 && s.opened2.ok, true, `9.3(B=${budget}/${caso}): openAttempt atteso ammesso`);
      let out2;
      try {
        out2 = await s.factory2.recover(s.opened2.attempt, 'silent');
      } finally {
        s.factory2.closeAttempt(s.opened2.attempt);
      }
      assert.deepEqual(
        s.killCalls2.map((c) => c.sig),
        attesi,
        `9.3(B=${budget}/${caso}): residuo ${residuoIniziale} contro riserva pre-TERM ${250 + m}`,
      );
      if (attesi.length === 0) {
        assert.equal(out2.outcome, 'host-stop-failed', `9.3(B=${budget}/${caso}): senza riserva l'esito e' un fallimento`);
      }
    }
    // Riserva pre-KILL: 200 + M, con il clock governato dentro la syscall TERM.
    for (const [caso, dopoTerm, attesi] of [
      ['kill-sotto-riserva', 200 + m - 1, ['SIGTERM']],
      ['kill-alla-riserva', 200 + m, ['SIGTERM', 'SIGKILL']],
    ]) {
      const s = await sondaConfine({ budget, residuoIniziale: 250 + m, dopoTerm });
      assert.equal(s.opened2 && s.opened2.ok, true, `9.3(B=${budget}/${caso}): openAttempt atteso ammesso`);
      let out2;
      try {
        out2 = await s.factory2.recover(s.opened2.attempt, 'silent');
      } finally {
        s.factory2.closeAttempt(s.opened2.attempt);
      }
      assert.deepEqual(
        s.killCalls2.map((c) => c.sig),
        attesi,
        `9.3(B=${budget}/${caso}): dopo il TERM, residuo ${dopoTerm} contro riserva pre-KILL ${200 + m}`,
      );
      if (attesi.length === 1) {
        assertEsitoFallimento(out2, `9.3(B=${budget}/${caso})`);
      }
    }
  }

  // B=200: le riserve pre-TERM (250+M) e pre-CLI (350+M) non entrano nel
  // budget. Qualunque residuo maggiore di B metterebbe il clock prima di
  // T0=D-B, cioe' fuori dalla finestra autorizzata: si prova invece il rifiuto
  // ALL'origine, con clock esattamente a T0 e residuo pari all'intero budget.
  {
    const budget = 200;
    const deadline = 600000 + budget;
    const t0 = deadline - budget;
    const piano200 = piano(budget, deadline);
    const m = piano200.marginMs;
    assert.ok(250 + m > budget, '9.3(B=200): la riserva pre-TERM non entra nel budget');
    assert.ok(350 + m > budget, '9.3(B=200): la riserva pre-CLI non entra nel budget');

    const fx200 = creaUnitFixture(t);
    let clock200 = t0;
    const killCalls200 = [];
    const factory200 = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCalls200.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx200.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock200,
      attesaImpl: async () => {},
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory200, '9.3(B=200)');
    const opened200 = factory200.openAttempt({
      record: fx200.record,
      stateDir: fx200.stateDir,
      deadlineAt: deadline,
      phasePlan: piano200,
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    if (opened200 && opened200.ok === true) {
      // Strada (ii): tentativo ammesso, rifiuto al confine operativo.
      let out200;
      try {
        out200 = await factory200.recover(opened200.attempt, 'silent');
      } finally {
        factory200.closeAttempt(opened200.attempt);
      }
      assert.deepEqual(killCalls200, [], "9.3(B=200): all'origine, con residuo pari al budget, zero segnali");
      assert.equal(out200 && out200.outcome, 'host-stop-failed', "9.3(B=200): senza riserve l'esito e' un fallimento");
    } else {
      // Strada (i): rifiuto anticipato per budget attestato, codice chiuso.
      assert.equal(opened200?.ok, false, '9.3(B=200): il rifiuto anticipato ha forma {ok:false}');
      assert.equal(
        opened200 && opened200.code,
        'BUDGET',
        '9.3(B=200): il rifiuto anticipato deve essere BUDGET, nessun errore generico',
      );
      assert.deepEqual(killCalls200, [], '9.3(B=200): il rifiuto anticipato non produce effetti');
    }

    // Stesso bordo per il confine pre-CLI: nessuna invocazione, rifiuto.
    const fx201 = creaUnitFixture(t);
    let cli200 = 0;
    const segnali201 = [];
    const factory201 = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { segnali201.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx201.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock200,
      attesaImpl: async () => {},
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory201, '9.3(B=200/cli)');
    const opened201 = factory201.openAttempt({
      record: fx201.record,
      stateDir: fx201.stateDir,
      deadlineAt: deadline,
      phasePlan: piano200,
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'expected');
    if (opened201 && opened201.ok === true) {
      let out201;
      try {
        out201 = await factory201.runExpected(opened201.attempt, async () => {
          cli200 += 1;
          return { result: { ok: true }, event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
        });
      } finally {
        factory201.closeAttempt(opened201.attempt);
      }
      assert.equal(cli200, 0, '9.3(B=200/cli): nessuna CLI senza riserve');
      assert.equal(out201 && out201.ok, false, "9.3(B=200/cli): runExpected rifiuta all'origine");
    } else {
      assert.equal(opened201?.ok, false, '9.3(B=200/cli): il rifiuto anticipato ha forma {ok:false}');
      assert.equal(
        opened201 && opened201.code,
        'BUDGET',
        '9.3(B=200/cli): il rifiuto anticipato deve essere BUDGET, nessun errore generico',
      );
      assert.equal(cli200, 0, '9.3(B=200/cli): il rifiuto anticipato non invoca la CLI');
    }
    // Both paths above — admitted then refused at the operating boundary, and
    // refused early — must leave the signal seam untouched.
    assert.deepEqual(segnali201, [], '9.3(B=200/cli): zero segnali in entrambi i percorsi');
  }

  // Riserva pre-CLI (P8 attiva): 350 + M. Il confine e' runExpected, e gli
  // argomenti concessi al CLI si osservano direttamente.
  for (const budget of [8000]) {
    const p = piano(budget, 500000 + budget);
    const m = p.marginMs;
    for (const [caso, residuoIniziale, invocato] of [
      ['cli-sotto-riserva', 350 + m - 1, false],
      ['cli-alla-riserva', 350 + m, true],
    ]) {
      const fx3 = creaUnitFixture(t);
      const deadline = 500000 + budget;
      const clock = deadline - residuoIniziale;
      let cliCalls = 0;
      const concessi = [];
      const factory3 = mod.createHostRecovery({
        fsRecovery: fs,
        publishExclusive: PUB_EXCL,
        killProcess: () => {},
        osservaKernel: () => ({ state: 'observed', processState: 'S', identity: fx3.record.hostIdentity }),
        identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
        identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
        monoNow: () => clock,
        attesaImpl: async () => {},
        probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
      });
      assertFactoryMethods(factory3, '9.3(pre-CLI)');
      const opened3 = factory3.openAttempt({
        record: fx3.record,
        stateDir: fx3.stateDir,
        deadlineAt: deadline,
        phasePlan: piano(budget, deadline),
        allowHostRecovery: true,
        fenceCheck: () => true,
      }, 'expected');
      assert.equal(opened3 && opened3.ok, true, `9.3(B=${budget}/${caso}): openAttempt atteso ammesso`);
      let out3;
      try {
        out3 = await factory3.runExpected(opened3.attempt, async (arg) => {
          cliCalls += 1;
          concessi.push(arg);
          return { result: { ok: true }, event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
        });
      } finally {
        factory3.closeAttempt(opened3.attempt);
      }
      assert.equal(
        cliCalls,
        invocato ? 1 : 0,
        `9.3(B=${budget}/${caso}): residuo ${residuoIniziale} contro riserva pre-CLI ${350 + m}`,
      );
      if (!invocato) {
        assert.equal(out3 && out3.ok, false, `9.3(B=${budget}/${caso}): senza riserva runExpected rifiuta`);
      } else {
        assert.equal(out3 && out3.ok, true, `9.3(B=${budget}/${caso}): con la riserva il CLI parte`);
        assert.equal(concessi.length, 1, `9.3(B=${budget}/${caso}): argomenti concessi al CLI osservati`);
        assert.equal(concessi[0] && concessi[0].deadlineAt, deadline, `9.3(B=${budget}/${caso}): il CLI riceve la stessa deadline`);
        // Limite effettivamente concesso (DM-11): min(saldo+credito della fase,
        // residuo reale meno M e riserve delle fasi future). Qui il clock e'
        // fermo, nessuna fase ha consumato o saltato e non c'e' credito: il
        // saldo e' il cap di P3 e le fasi future attive sono P4..P9 (6 x 50).
        const saldoP3 = p.phases.find((f) => f.id === 'p3').allowanceMs;
        const riserveFuture = 50 * 6;
        const limiteAtteso = Math.min(saldoP3, residuoIniziale - m - riserveFuture);
        assert.equal(
          concessi[0] && concessi[0].budgetMs,
          limiteAtteso,
          `9.3(B=${budget}/${caso}): il CLI riceve il limite effettivo min(saldo, residuo-M-riserve future) = ${limiteAtteso}`,
        );
      }
    }
  }

  // Phase oracle v2. The seams observe effects, not phase labels: the clock
  // reads, the waits of the polling loops, the two syscalls, the kernel
  // observations and the barrier probe. A segment between two syscalls is NOT
  // synonymous with a phase: the seams do not distinguish every purpose and
  // every accounting entry of a phase, so the limits below are upper bounds,
  // never a measurement of a separate phase counter.
  const N_FASE = (allowance) => Math.min(301, 1 + Math.ceil(Math.max(0, Math.floor(allowance)) / 50));

  // Overall fuse, the same order of magnitude as the one the old base case had:
  // it bounds the whole run, not a segment. A controlled synthetic loop proves
  // it trips at the boundary and nowhere else, without any real infinite loop.
  const FUSIBILE_ATTESE = 700;
  {
    let n = 0;
    let fermato = false;
    for (;;) {
      n += 1;
      if (n > FUSIBILE_ATTESE) { fermato = true; break; }
    }
    assert.equal(fermato, true, '9.3(fasi): the fuse stops a runaway loop');
    assert.equal(n, FUSIBILE_ATTESE + 1, '9.3(fasi): the fuse trips on the first wait beyond its bound');
  }

  // One run of the silent path with the clock governed by the test.
  //   clockIniziale  where the clock stands when the attempt starts
  //   avanzaMs       whether a wait moves the clock by its own milliseconds
  //   muoriAl        'TERM' | 'KILL': the original leaves after that signal
  //   probeStato     what the barrier probe answers ('lock' | 'none')
  // The kill segment closes when recover resolves: nothing is called after it.
  const misuraFasi = async ({ budget, saldi, clockIniziale, avanzaMs, muoriAl = null, probeStato = 'lock' }) => {
    const deadline = 608000;
    const base = piano(budget, deadline);
    const pianoCaso = { ...base, phases: base.phases.map((f) => ({ ...f, allowanceMs: saldi[f.id] })) };
    const fx = creaUnitFixture(t);
    let clock = clockIniziale;
    let segmento = 'pre';
    const atteseMs = { pre: [], tk: [], pk: [] };
    const obs = { pre: 0, tk: 0, pk: 0 };
    const probe = { pre: 0, tk: 0, pk: 0 };
    const eventi = [];
    const killCalls = [];
    const visti = new Set();
    let atteseTotali = 0;
    let fusibileScattato = false;
    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => {
        killCalls.push({ pid, sig });
        visti.add(sig);
        eventi.push({ tipo: 'segnale', sig, segmento });
        if (sig === 'SIGTERM') segmento = 'tk';
        if (sig === 'SIGKILL') segmento = 'pk';
      },
      osservaKernel: () => {
        obs[segmento] += 1;
        const uscito = (muoriAl === 'TERM' && visti.has('SIGTERM'))
          || (muoriAl === 'KILL' && visti.has('SIGKILL'));
        if (uscito) {
          eventi.push({ tipo: 'assenza', segmento });
          return { state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } };
        }
        eventi.push({ tipo: 'osservazione', segmento });
        return { state: 'observed', processState: 'S', identity: fx.record.hostIdentity };
      },
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      // The clock is read, never counted: a read is not a poll turn.
      monoNow: () => clock,
      attesaImpl: async (ms) => {
        atteseMs[segmento].push(ms);
        atteseTotali += 1;
        // Finite overall fuse, as the old base case had. It does not replace
        // the per-segment bounds: a loop that runs away trips here, and the
        // flag stays set even if the product turns the rejection into a
        // conservative outcome, so the case can never read as green.
        if (atteseTotali > FUSIBILE_ATTESE) {
          fusibileScattato = true;
          throw new Error('9.3(fasi): overall wait fuse tripped');
        }
        if (avanzaMs) clock += Math.max(1, ms);
      },
      probeRoot: async () => {
        probe[segmento] += 1;
        eventi.push({ tipo: 'sonda', stato: probeStato, segmento });
        return { r: { ok: true }, stato: { ok: true, state: probeStato, declared_pid: null, pid_number_in_use: null } };
      },
    });
    assertFactoryMethods(factory, '9.3(fasi)');
    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: deadline,
      phasePlan: pianoCaso,
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true, `9.3(fasi B=${budget}): openAttempt atteso ammesso`);
    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    return { out, killCalls, atteseMs, obs, probe, eventi, fusibileScattato };
  };

  // F1 — no credit: the previous phases are declared consumed and the clock
  // already carries their cost; from there it advances with each wait.
  // The segment between TERM and KILL is not proven to belong entirely to the
  // term phase, so the bounds are composite: term waits by N(1000) +
  // N(500 + 1000), kill waits by N(500 + 1000). The composite limit does NOT
  // prove the separate per-phase counter; that exact proof needs the real
  // ledger and belongs to the next increment.
  {
    const r = await misuraFasi({
      budget: 8000,
      saldi: { p1: 0, p2: 0, p3: 0, p4: 0, p5: 1000, p6: 500, p7: 750, p8: 2000, p9: 1000 },
      clockIniziale: 602500,
      avanzaMs: true,
    });
    assert.equal(r.fusibileScattato, false, '9.3(F1): the overall wait fuse did not trip');
    const LIMITE_TK = N_FASE(1000) + N_FASE(500 + 1000);
    const LIMITE_PK = N_FASE(500 + 1000);
    assert.deepEqual(r.killCalls.map((c) => c.sig), ['SIGTERM', 'SIGKILL'], '9.3(F1): TERM and KILL really happened, once each');
    assert.ok(r.obs.tk >= 1, '9.3(F1/term): the original was observed after the TERM');
    assert.ok(
      r.atteseMs.tk.length <= LIMITE_TK,
      `9.3(F1/term): waits ${r.atteseMs.tk.length} within the composite bound ${LIMITE_TK}`,
    );
    assert.ok(r.obs.pk >= 1, '9.3(F1/kill): the original was observed after the KILL');
    assert.ok(
      r.atteseMs.pk.length <= LIMITE_PK,
      `9.3(F1/kill): waits ${r.atteseMs.pk.length} within the credit bound ${LIMITE_PK}`,
    );
    assertEsitoFallimento(r.out, '9.3(F1)');
  }

  // F2 — full credit, clock frozen at the origin of the run (D minus B): with
  // nothing consumed, the balances of the phases already skipped flow back as
  // credit. The bounds are N(1000 + 2500) and N(500 + 3500): upper limits
  // conditioned on credit, never a promise that the balances are consumed.
  // Only two signal sequences are admitted, exactly: [SIGTERM] or
  // [SIGTERM, SIGKILL].
  {
    const r = await misuraFasi({
      budget: 8000,
      saldi: { p1: 500, p2: 750, p3: 1000, p4: 250, p5: 1000, p6: 500, p7: 750, p8: 2000, p9: 1000 },
      clockIniziale: 600000,
      avanzaMs: false,
    });
    assert.equal(r.fusibileScattato, false, '9.3(F2): the overall wait fuse did not trip');
    const sequenze = r.killCalls.map((c) => c.sig);
    const ammessa = (sequenze.length === 1 && sequenze[0] === 'SIGTERM')
      || (sequenze.length === 2 && sequenze[0] === 'SIGTERM' && sequenze[1] === 'SIGKILL');
    assert.ok(ammessa, `9.3(F2): only [SIGTERM] or [SIGTERM, SIGKILL] are admitted (saw ${JSON.stringify(sequenze)})`);
    const LIMITE_TK = N_FASE(1000 + 2500) + N_FASE(500 + 3500);
    const LIMITE_PK = N_FASE(500 + 3500);
    assert.ok(r.obs.tk >= 1, '9.3(F2/term): the original was observed after the TERM');
    assert.ok(
      r.atteseMs.tk.length <= LIMITE_TK,
      `9.3(F2/term): waits ${r.atteseMs.tk.length} within the composite bound ${LIMITE_TK}`,
    );
    if (sequenze.includes('SIGKILL')) {
      assert.ok(r.obs.pk >= 1, '9.3(F2/kill): the original was observed after the KILL');
      assert.ok(
        r.atteseMs.pk.length <= LIMITE_PK,
        `9.3(F2/kill): waits ${r.atteseMs.pk.length} within the credit bound ${LIMITE_PK}`,
      );
    }
    const tutte = [...r.atteseMs.pre, ...r.atteseMs.tk, ...r.atteseMs.pk];
    assert.ok(tutte.length >= 1, '9.3(F2): at least one wait with the clock frozen');
    for (const ms of tutte) {
      assert.equal(Number.isInteger(ms), true, `9.3(F2): whole wait (received ${ms})`);
      assert.ok(ms >= 1 && ms <= 50, `9.3(F2): wait between 1 and 50 ms, never a zero spin (received ${ms})`);
    }
    assert.equal(r.out.outcome, 'host-stop-failed', '9.3(F2): a live original with a frozen clock ends fail-closed');
    // probeRoot is recorded and never splits a segment.
  }

  // U1 — the original leaves at the TERM. The barrier is proven by an ORDERED
  // sequence of seam events, not by counts: the signal, then a positive
  // observation of absence, then a NEW probe answering none, then the attested
  // outcome. A probe issued before the death was observed would pass a count.
  {
    const r = await misuraFasi({
      budget: 8000,
      saldi: { p1: 500, p2: 750, p3: 1000, p4: 250, p5: 1000, p6: 500, p7: 750, p8: 2000, p9: 1000 },
      clockIniziale: 600000,
      avanzaMs: false,
      muoriAl: 'TERM',
      probeStato: 'none',
    });
    assert.equal(r.fusibileScattato, false, '9.3(U1): the overall wait fuse did not trip');
    assert.deepEqual(r.killCalls.map((c) => c.sig), ['SIGTERM'], '9.3(U1): after the TERM, zero new signals');
    assert.ok(
      r.atteseMs.tk.length <= N_FASE(1000 + 2500) + N_FASE(500 + 3500),
      '9.3(U1/term): waits within the composite bound',
    );
    const iSegnale = r.eventi.findIndex((e) => e.tipo === 'segnale' && e.sig === 'SIGTERM');
    assert.ok(iSegnale >= 0, '9.3(U1): the TERM is in the seam sequence');
    const iAssenza = r.eventi.findIndex((e, i) => i > iSegnale && e.tipo === 'assenza');
    assert.ok(iAssenza > iSegnale, '9.3(U1): absence observed AFTER the signal');
    const iSonda = r.eventi.findIndex((e, i) => i > iAssenza && e.tipo === 'sonda' && e.stato === 'none');
    assert.ok(iSonda > iAssenza, '9.3(U1): a new probe answering none AFTER that observation');
    assert.ok(r.probe.tk >= 1, '9.3(U1): the barrier probe was reached');
    assert.equal(r.out.outcome, 'host-stopped-attested', '9.3(U1): complete and valid fixture means an attested stop');
    assert.equal(r.out.method, 'term', '9.3(U1): the original left at the TERM');
  }

  // U2 — the original leaves at the KILL. Same ordered proof, anchored on the
  // SIGKILL.
  {
    const r = await misuraFasi({
      budget: 8000,
      saldi: { p1: 500, p2: 750, p3: 1000, p4: 250, p5: 1000, p6: 500, p7: 750, p8: 2000, p9: 1000 },
      clockIniziale: 600000,
      avanzaMs: false,
      muoriAl: 'KILL',
      probeStato: 'none',
    });
    assert.equal(r.fusibileScattato, false, '9.3(U2): the overall wait fuse did not trip');
    assert.deepEqual(r.killCalls.map((c) => c.sig), ['SIGTERM', 'SIGKILL'], '9.3(U2): the escalation happened once, in order');
    assert.ok(r.obs.pk >= 1, '9.3(U2/kill): the original was observed after the KILL');
    assert.ok(r.atteseMs.pk.length <= N_FASE(500 + 3500), '9.3(U2/kill): waits within the credit bound');
    const iSegnale = r.eventi.findIndex((e) => e.tipo === 'segnale' && e.sig === 'SIGKILL');
    assert.ok(iSegnale >= 0, '9.3(U2): the KILL is in the seam sequence');
    const iAssenza = r.eventi.findIndex((e, i) => i > iSegnale && e.tipo === 'assenza');
    assert.ok(iAssenza > iSegnale, '9.3(U2): absence observed AFTER the KILL');
    const iSonda = r.eventi.findIndex((e, i) => i > iAssenza && e.tipo === 'sonda' && e.stato === 'none');
    assert.ok(iSonda > iAssenza, '9.3(U2): a new probe answering none AFTER that observation');
    assert.ok(r.probe.pk >= 1, '9.3(U2): the barrier probe was reached after the KILL');
    assert.equal(r.out.outcome, 'host-stopped-attested', '9.3(U2): complete and valid fixture means an attested stop');
    assert.equal(r.out.method, 'kill', '9.3(U2): the original left at the KILL');
  }

  // Negativi di clock: non finito e arretrato non promuovono effetti.
  for (const [caso, leggiClock] of [
    ['clock-non-finito', () => Number.NaN],
    ['clock-arretrato', (() => { let n = 0; return () => (n++ === 0 ? 700000 : 690000); })()],
  ]) {
    const fx5 = creaUnitFixture(t);
    const killCalls5 = [];
    const factory5 = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCalls5.push({ pid, sig }); },
      osservaKernel: () => ({ state: 'observed', processState: 'S', identity: fx5.record.hostIdentity }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: leggiClock,
      attesaImpl: async () => {},
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });
    const deadline5 = 700000 + 8000;
    const opened5 = factory5.openAttempt({
      record: fx5.record,
      stateDir: fx5.stateDir,
      deadlineAt: deadline5,
      phasePlan: piano(8000, deadline5),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    if (!(opened5 && opened5.ok)) {
      assert.deepEqual(killCalls5, [], `9.3(${caso}): rifiuto anticipato senza segnali`);
      continue;
    }
    let out5;
    try {
      out5 = await factory5.recover(opened5.attempt, 'silent');
    } finally {
      factory5.closeAttempt(opened5.attempt);
    }
    assert.deepEqual(killCalls5, [], `9.3(${caso}): clock non valido non promuove alcun segnale`);
    assertEsitoFallimento(out5, `9.3(${caso})`);
  }
});

test('9.4 tutti i siti barriera riconoscono host-stopped-attested e superfici API distinguono lo stop forzato senza leak interni', async (t) => {
  // Sito A: canale posseduto (downSerializzato).
  {
    const w = creaMondoBud(t, { budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.attaccaSupervisore();
    w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live' });
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

    assert.equal(err, null, `9.4(canale): host-stopped-attested deve chiudere senza errore (${err && err.fleetCode})`);
    assert.equal(res && res.ok, true, '9.4(canale): atteso ok:true');
    assert.equal(res && res.host && res.host.outcome, 'host-stopped-attested', '9.4(canale): outcome attestato');
    assert.equal(res && res.host && res.host.method, 'term', '9.4(canale): metodo term osservato');
    const serialized = JSON.stringify(res);
    for (const secret of [String(HOST_PID), w.root, REAL_BOOT_ID, OWNER]) {
      assert.equal(serialized.includes(secret), false, `9.4(canale): risposta API non deve esporre ${secret}`);
    }
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'assente', '9.4(canale): record rimosso');
    assert.ok(
      ['none', 'released'].includes(vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella })),
      '9.4(canale): claim rilasciata',
    );
  }

  // Sito B: down senza canale (riconciliaLancio -> chiudiHostPoiLease).
  {
    const w = creaMondoBud(t, { budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.terminaSupervisoreESessione();
    await w.runtime.shutdown();
    w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live' });
    w.setOnKillProcess((pid, sig) => {
      if (pid === HOST_PID && sig === 'SIGTERM') {
        w.syntheticHost.alive = false;
        w.setVlScenario({ hostState: 'none', afterAckState: 'none' });
      }
    });

    const rt2 = w.creaSecondoRuntime(2800);
    let err = null;
    let res = null;
    try {
      res = await rt2.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.equal(err, null, `9.4(senza-canale): host-stopped-attested deve chiudere senza errore (${err && err.fleetCode})`);
    assert.equal(res && res.ok, true);
    assert.equal(res && res.host && res.host.outcome, 'host-stopped-attested', 'host: outcome attestato');
    assert.equal(res && res.host && res.host.method, 'term', 'host: metodo term osservato');
  }
});

test('9.5 launchState, status, up e reconcile passivo inviano zero nuovi segnali di recovery host', async (t) => {
  const w = creaMondoBud(t, { budgetMs: 2600, useScenarioClock: true });
  await attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  await w.terminaSupervisoreESessione();
  await w.runtime.shutdown();

  w.syntheticHost.alive = true;
  // Budget DISPONIBILE nei percorsi non-down: il CLI risponde presto, quindi
  // lo zero segnali non puo' venire dall'esaurimento del budget ma solo dal
  // consenso false. Il caso positivo della stessa cella lo dimostra.
  w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live', stopAdvanceMs: 200 });
  const recBefore = launchTarget.leggi(w.filesRoot, w.sessione);
  assert.equal(recBefore.stato, 'presente', '9.5: prerequisito record presente');
  const launchId = recBefore.record.launchId;

  const rt2 = w.creaSecondoRuntime(2600);

  const st = await rt2.runtime.status();
  assert.ok(st, '9.5(status): status deve rispondere');
  assert.deepEqual(w.killCalls, [], '9.5(status): zero segnali recovery');

  const ls = await rt2.runtime.launchState(w.cella);
  assert.equal(ls.ok, true, '9.5(launchState): ok atteso');
  assert.equal(ls.launchId, launchId, '9.5(launchState): launchId coerente');
  assert.deepEqual(w.killCalls, [], '9.5(launchState): zero segnali recovery');

  const recRes = await rt2.runtime.reconcile(w.cella, launchId);
  assert.equal(recRes.ok, true, '9.5(reconcile): ok atteso');
  // Premessa positiva esplicita: il budget e' disponibile (il CLI risponde in
  // 200 ms), quindi il reconcile passivo si ferma al confine per consenso
  // false, non per esaurimento. Un esito 'budget' sarebbe un'altra premessa e
  // non proverebbe l'attraversamento del confine.
  assert.equal(
    recRes.outcome,
    'blocked',
    `9.5(reconcile): con budget disponibile il confine fermaHost blocca per consenso (ricevuto ${recRes.outcome})`,
  );
  const dopoReconcile = w.readStopCalls().length;
  assert.ok(dopoReconcile >= 1, '9.5(reconcile): il confine fermaHost e\' attraversato');
  assert.deepEqual(w.killCalls, [], '9.5(reconcile): zero segnali recovery');

  let upErr = null;
  let upRes = null;
  try {
    upRes = await rt2.runtime.up(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    upErr = e;
  }
  assert.equal(upRes, null, '9.5(up): up non deve riuscire su record con host vivo');
  assert.ok(upErr && (upErr.status === 409 || upErr.status === 500), '9.5(up): status bloccante 409/500 atteso su up');
  const dopoUp = w.readStopCalls().length;
  assert.ok(dopoUp > dopoReconcile, '9.5(up): up attraversa il confine una seconda volta');
  assert.ok(dopoUp >= 2, '9.5: reconcile e up raggiungono fermaHost senza segnali recovery');
  assert.deepEqual(w.killCalls, [], '9.5(up): zero segnali recovery durante up');
  assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', '9.5: record conservato');
  assert.equal(vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella }), 'held', '9.5: claim conservata');
});

test('9.6 controllo rollbackReadiness applica budget 30000 ms 60/40 fermando il gruppo con zero segnali host', async (t) => {
  const w = creaMondoBud(t, { budgetMs: 2800 });
  await attesaPgrpFiglio(w.paneChild.pid);
  w.setOnBrokerIssue(async (req) => {
    await w.attaccaSupervisore(req);
  });
  // Fallisce registraIdentitaPeer per peer unverified mantenendo host vivo al rollback.
  w.setVlScenario({ hostState: 'live', badPeerIdentity: true });

  let upErr = null;
  let upRes = null;
  try {
    upRes = await w.runtime.up(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    upErr = e;
  }

  assert.equal(upRes, null, '9.6 controllo: up deve fallire su peer mismatch');
  assert.equal(upErr && upErr.fleetCode, 'VL_PEER_UNATTESTED', '9.6 controllo: fleetCode VL_PEER_UNATTESTED');
  assert.ok(upErr && upErr.data && upErr.data.rollback, '9.6 controllo: dati rollback presenti');
  assert.equal(upErr.data.rollback.deadlineMs, 30000, '9.6 controllo: budget rollbackReadiness 30000 ms');
  assert.equal(upErr.data.rollback.supervisor, 'stopped', '9.6 controllo: gruppo supervisore fermato nella finestra 60/40');
  assert.equal(upErr.data.rollback.session, 'absent-attested', '9.6 controllo: sessione fermata sul canale');
  assert.equal(upErr.data.rollback.incompleto, true, '9.6 controllo: rollback senza host recovery resta incompleto');
  assert.deepEqual(w.killCalls, [], '9.6 controllo: zero segnali host in rollbackReadiness');

  // Con un budget ridotto si osserva che il rollback attraversa davvero il
  // tempo 3 (seam dichiarato) e che l'up NON attende il default di 30 s. Questo
  // NON e' la misura del tetto di 1 s del rollback ne' del 60/40: l'intervallo
  // comprende l'intera up e il tetto del rollback si prova al gate degli
  // strati 8-9, dove vive tests/fleet-readiness-rollback.test.js.
  {
    let tempo3OsservatoAMs = null;
    const t0Totale = Date.now();
    const w2 = creaMondoBud(t, {
      budgetMs: 2800,
      readinessRollbackMs: 1000,
      readinessRollbackSeams: {
        primaDelTempo3: () => { tempo3OsservatoAMs = Date.now() - t0Totale; },
      },
    });
    await attesaPgrpFiglio(w2.paneChild.pid);
    w2.setOnBrokerIssue(async (req) => { await w2.attaccaSupervisore(req); });
    w2.setVlScenario({ hostState: 'live', badPeerIdentity: true });

    let e2 = null;
    try {
      await w2.runtime.up(w2.cella);
    } catch (e) {
      e2 = e;
    }
    const durataMs = Date.now() - t0Totale;

    assert.ok(e2 && e2.data && e2.data.rollback, '9.6(tetto): dati rollback presenti');
    assert.equal(
      e2.data.rollback.deadlineMs,
      1000,
      '9.6(tetto): il budget del rollback e\' quello configurato, non il default di 30000',
    );
    assert.equal(
      Number.isInteger(tempo3OsservatoAMs),
      true,
      '9.6(tetto): il rollback deve attraversare il tempo 3 dichiarato dal seam',
    );
    assert.ok(
      durataMs < 30000,
      `9.6(intera up): l'intera up resta sotto il default di 30 s, quindi il budget ridotto e' stato applicato (${durataMs}ms) — non e' il tetto di 1 s del rollback`,
    );
    assert.equal(e2.data.rollback.supervisor, 'stopped', '9.6(tetto): gruppo fermato entro il tetto');
    assert.deepEqual(w2.killCalls, [], '9.6(tetto): zero segnali host');
  }
});

test('9.6 restart con host bloccato mantiene allowHostRecovery false con zero segnali e non chiama up mentre down esplicito recupera', async (t) => {
  const w = creaMondoBud(t, { budgetMs: 2800 });
  await attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  await w.attaccaSupervisore();
  assert.equal(w.brokerState.issueCount, 1, '9.6: un solo avvio iniziale');

  w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live' });
  w.setOnKillProcess((pid, sig) => {
    if (pid === HOST_PID && sig === 'SIGTERM') {
      w.syntheticHost.alive = false;
      w.setVlScenario({ hostState: 'none', afterAckState: 'none' });
    }
  });

  // restart: deve disabilitare recovery host (allowHostRecovery:false), inviare zero segnali e NON chiamare up().
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

  // down esplicito (nuova istanza con supervisore attaccato e host vivo) deve attivare host recovery (SIGTERM) e chiudere.
  const w2 = creaMondoBud(t, { budgetMs: 2800 });
  await attesaPgrpFiglio(w2.paneChild.pid);
  await w2.runtime.up(w2.cella);
  await w2.attaccaSupervisore();
  w2.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live' });
  w2.setOnKillProcess((pid, sig) => {
    if (pid === HOST_PID && sig === 'SIGTERM') {
      w2.syntheticHost.alive = false;
      w2.setVlScenario({ hostState: 'none', afterAckState: 'none' });
    }
  });

  let downErr = null;
  let downRes = null;
  try {
    downRes = await w2.runtime.down(w2.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    downErr = e;
  }

  assert.equal(downErr, null, `9.6(down): down esplicito deve recuperare host bloccato con SIGTERM (${downErr && downErr.fleetCode})`);
  assert.equal(downRes && downRes.ok, true, '9.6(down): atteso ok:true');
  assert.equal(downRes && downRes.host && downRes.host.outcome, 'host-stopped-attested', '9.6(down): outcome attestato');
    assert.equal(downRes && downRes.host && downRes.host.method, 'term', '9.6(down): metodo term osservato');
  assert.deepEqual(w2.killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], '9.6(down): atteso SIGTERM su down esplicito');
});

test('9.7a catalogo causes e codeOf accettano HOST_ALIVE, LEASE_BLOCKS e LEASE_UNREADABLE', () => {
  for (const code of ['HOST_ALIVE', 'LEASE_BLOCKS', 'LEASE_UNREADABLE']) {
    assert.equal(causes.CODES.includes(code), true, `9.7a: causes.CODES deve includere ${code}`);
    assert.equal(causes.codeOf(code), code, `9.7a: causes.codeOf(${code}) deve restituire ${code}`);
  }
});

test('9.7b emissione fleetCode HOST_ALIVE solo con stessa incarnazione positivamente viva, incerto distinto e i18n paritarie it/en/es', async (t) => {
  // Parte 1: stessa incarnazione positivamente viva in stato D dopo SIGKILL -> fleetCode HOST_ALIVE.
  {
    const w = creaMondoBud(t, { budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.attaccaSupervisore();
    w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live' });
    // La foto positiva deve essere FRESCA e SUCCESSIVA al SIGKILL: prima del
    // KILL l'host è vivo in S (così l'escalation avviene), solo dopo il KILL
    // l'override restituisce lo stato D della stessa incarnazione.
    const segnali = [];
    let obsAlKill = null;
    w.setOnKillProcess((pid, sig) => {
      if (pid !== HOST_PID) return;
      segnali.push(sig);
      if (sig === 'SIGKILL') {
        obsAlKill = w.syntheticHost.kernelObsCount;
        w.syntheticHost.kernelOverride = {
          state: 'observed',
          processState: 'D',
          identity: { ...w.hostIdReal },
        };
      }
    });
    w.syntheticHost.kernelOverride = null;

    let err = null;
    try {
      await w.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }
    assert.deepEqual(
      segnali,
      ['SIGTERM', 'SIGKILL'],
      `9.7b(positivo): escalation TERM→KILL osservata prima dell'emissione (ricevuti ${segnali.join(',')})`,
    );
    assert.ok(
      obsAlKill !== null && w.syntheticHost.kernelObsCount > obsAlKill,
      '9.7b(positivo): la foto positiva deve essere successiva al SIGKILL, non una lettura precedente riusata',
    );
    assert.equal(
      err && err.fleetCode,
      'HOST_ALIVE',
      `9.7b(positivo): stessa incarnazione viva in D post-SIGKILL deve emettere HOST_ALIVE (ricevuto ${err && err.fleetCode})`,
    );
  }

  // Parte 2: la lettura kernel diventa incerta SOLO dopo il KILL. Il percorso
  // deve essere lo stesso del positivo — TERM, poi KILL — e l'incertezza
  // arriva dopo l'effetto: nessun HOST_ALIVE, esito incerto.
  {
    const w = creaMondoBud(t, { budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.attaccaSupervisore();
    w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live' });
    const segnali = [];
    let obsAlKill = null;
    w.setOnKillProcess((pid, sig) => {
      if (pid !== HOST_PID) return;
      segnali.push(sig);
      if (sig === 'SIGKILL') {
        obsAlKill = w.syntheticHost.kernelObsCount;
        // Grammatica normativa dell'osservatore: `unverifiable` con reason
        // chiusa (`access`), non uno stato inventato con errno.
        w.syntheticHost.kernelOverride = { state: 'unverifiable', reason: 'access' };
      }
    });
    // Fino al KILL l'host resta osservabile: l'incertezza non e' un ingresso.
    w.syntheticHost.kernelOverride = null;
    const osservazioniPrima = w.syntheticHost.kernelObsCount;

    let err = null;
    try {
      await w.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }
    assert.deepEqual(
      segnali,
      ['SIGTERM', 'SIGKILL'],
      `9.7b(incerto): il negativo deve percorrere TERM→KILL come il positivo (ricevuti ${segnali.join(',')})`,
    );
    assert.ok(
      obsAlKill !== null && w.syntheticHost.kernelObsCount > obsAlKill,
      '9.7b(incerto): la lettura incerta deve essere successiva al SIGKILL, non precedente all\'escalation',
    );
    assert.ok(
      w.syntheticHost.kernelObsCount > osservazioniPrima,
      '9.7b(incerto): il ramo di lettura incerta deve essere davvero raggiunto, non solo dichiarato',
    );
    assert.ok(err && err.status === 500, '9.7b(incerto): errore 500 atteso su kernel illeggibile');
    assert.equal(typeof (err && err.fleetCode), 'string', '9.7b(incerto): esito incerto con codice, non un successo');
    assert.notEqual(err.fleetCode, 'HOST_ALIVE', '9.7b(incerto): lettura incerta non emette HOST_ALIVE');
  }

  // Parte 3: the interface contract on the function the UI already calls.
  // Real errors keep rejecting with their structured cause and carry the
  // locale text; the attested host result is presented; unknown or missing
  // methods are never promoted.
  await verificaContrattoUi('9.7b');
});

