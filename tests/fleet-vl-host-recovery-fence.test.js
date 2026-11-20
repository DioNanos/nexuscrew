'use strict';

const { piano } = require('./helpers/phase-plan.js');

// Host recovery launch fence, partial trace recovery, store caps, and schema tests (7.1 - 7.9).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { publishExclusive, pubblicaEsclusiva } = require('../lib/fleet/exclusive-publish.js');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
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

test('7.1 sostituzione launchId durante await di down rifiuta con 409 IDENTITY_UNVERIFIED e zero effetti sul nuovo lancio', async (t) => {
  const w = creaMondoE2E(t, { budgetMs: 2500 });
  await attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  await w.attaccaSupervisore();

  const original = launchTarget.leggi(w.filesRoot, w.sessione);
  assert.equal(original.stato, 'presente', '7.1: record iniziale deve essere presente');
  const lid1 = original.record.launchId;
  const lid2 = hexId(8);
  assert.notEqual(lid2, lid1);

  let downStarted = false;
  let swapped = false;
  let swappedAt = 0;
  w.setOnObserveKernel(() => {
    if (!downStarted || swapped) return;
    swapped = true;
    swappedAt = Date.now();
    const prev = original.record;
    assert.equal(
      launchTarget.registra(w.filesRoot, w.sessione, {
        launchId: lid2,
        family: 'vl',
        sessionId: prev.sessionId,
        paneId: prev.paneId,
        tmuxSocket: prev.tmuxSocket,
        serverPid: prev.serverPid,
        panePid: prev.panePid,
        paneStarttime: prev.paneStarttime,
      }),
      true,
      '7.1: sostituzione record launch-targets con lid2 deve riuscire',
    );
    const curCtx = hostStop.leggiContesto(w.cellBase);
    assert.ok(curCtx && curCtx.launchId === lid1, '7.1: host-context deve avere lid1 prima dello swap');
    hostStop.scriviContesto(w.cellBase, {
      ...curCtx,
      launchId: lid2,
    });
  });

  w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'lock' });
  downStarted = true;

  let err = null;
  let res = null;
  try {
    res = await w.runtime.down(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    err = e;
  }

  assert.equal(
    err && err.status,
    409,
    `7.1: sostituzione launchId durante await down deve rifiutare con HTTP 409 (ricevuto ${err && err.status} ${err && err.fleetCode}, res=${Boolean(res)})`,
  );
  assert.equal(err && err.fleetCode, 'IDENTITY_UNVERIFIED', '7.1: atteso fleetCode IDENTITY_UNVERIFIED');
  assert.equal(w.killCalls.length, 0, '7.1: zero segnali inviati dopo sostituzione launchId');

  const after = launchTarget.leggi(w.filesRoot, w.sessione);
  assert.equal(after.stato, 'presente', '7.1: il record del nuovo lancio deve restare presente');
  assert.equal(after.record.launchId, lid2, '7.1: launchId del nuovo lancio deve restare intatto');
  assert.notEqual(after.record.incerto, true, '7.1: il nuovo lancio non deve risultare incerto');

  // Un revokeControl improprio sul nuovo lancio non cambierebbe record ne'
  // segnali: va osservato direttamente, e solo dopo la sostituzione.
  assert.deepEqual(
    w.revokeControlCalls.filter((c) => c.at >= swappedAt),
    [],
    '7.1: nessun revokeControl sul nuovo lancio dopo la sostituzione',
  );
});

test('7.2 errore write/fsync su intent-term e intent-kill in recover e su cli-attempt in runExpected blocca gli effetti successivi', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '7.2: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  // (a) Fallimento pubblicazione/write di intent-term -> zero SIGTERM, zero SIGKILL.
  {
    const fx = creaUnitFixture(t);
    const killCalls = [];
    let clock = 10000;
    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: (opts) => {
        const parsed = opts?.bytes ? JSON.parse(Buffer.from(opts.bytes).toString('utf8')) : null;
        if (parsed && parsed.kind === 'intent-term') {
          return { status: 'failed-before-create', via: 'exclusive', code: 'EIO', created: false };
        }
        return PUB_EXCL(opts);
      },
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory, '7.2');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true, '7.2(a): openAttempt atteso ok:true');

    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assertEsitoFallimento(out, '7.2(a)');
    assert.deepEqual(killCalls, [], '7.2(a): fallimento write/fsync di intent-term deve impedire qualsiasi SIGTERM');
  }

  // (b) SIGTERM ignorato poi fallimento pubblicazione/write di intent-kill -> 1 SIGTERM e 0 SIGKILL.
  {
    const fx = creaUnitFixture(t);
    const killCalls = [];
    let clock = 20000;
    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: (opts) => {
        const parsed = opts?.bytes ? JSON.parse(Buffer.from(opts.bytes).toString('utf8')) : null;
        if (parsed && parsed.kind === 'intent-kill') {
          return { status: 'failed-before-create', via: 'exclusive', code: 'EIO', created: false };
        }
        return PUB_EXCL(opts);
      },
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true, '7.2(b): openAttempt atteso ok:true');

    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assertEsitoFallimento(out, '7.2(b)');
    assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], '7.2(b): fallimento write/fsync di intent-kill non deve inviare SIGKILL');
  }

  // (c) Fallimento pubblicazione di cli-attempt pre-CLI in runExpected -> callback CLI mai invocata.
  {
    const fx = creaUnitFixture(t);
    let cliCalls = 0;
    let clock = 30000;
    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: (opts) => {
        const parsed = opts?.bytes ? JSON.parse(Buffer.from(opts.bytes).toString('utf8')) : null;
        if (parsed && parsed.kind === 'cli-attempt') {
          return { status: 'failed-before-create', via: 'exclusive', code: 'EIO', created: false };
        }
        return PUB_EXCL(opts);
      },
      killProcess: () => {},
      osservaKernel: () => ({ state: 'absent', node: { bootId: BOOT_ID, pidNamespaceInode: PID_NS } }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clock,
      attesaImpl: async (ms) => { clock += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'live', declared_pid: HOST_PID, pid_number_in_use: null } }),
    });

    assert.equal(typeof factory?.runExpected, 'function', '7.2(c): capability factory.runExpected mancante');
    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'expected');
    assert.equal(opened && opened.ok, true, '7.2(c): openAttempt expected atteso ok:true');

    let out;
    try {
      out = await factory.runExpected(opened.attempt, async () => {
        cliCalls += 1;
        // Forma del callback: il result grezzo resta nell'adattatore, il
        // journal vede solo l'evento con kind/reason chiusi.
        return { result: { ok: true }, event: { kind: 'cli-ack', reason: 'shutdown_ack' } };
      });
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    // runExpected answers the run wrapper shape {ok,code?,result?}: the refusal
    // is ok:false, not a HostResult. No outcome is imposed on this boundary.
    assert.equal(out && out.ok, false, '7.2(c): runExpected deve rifiutare con ok:false');
    assert.equal(cliCalls, 0, '7.2(c): CLI non deve essere invocata se cli-attempt non persiste');
  }

  // (d) Guasti di DURABILITÀ distinti, sul percorso reale: fsync del file
  // temporaneo, fsync dell'entry (directory recovery-events) e fsync della
  // catena (stateDir). `failed-before-create` del publisher non li attesta:
  // sono tre confini diversi e vanno rotti uno per uno.
  for (const dove of ['file', 'entry', 'catena']) {
    const fx = creaUnitFixture(t);
    const dirRec = path.join(fx.stateDir, 'recovery-events');
    let clockD = 40000;
    let fsyncScattato = 0;
    const fdPaths = new Map();
    const bersaglio = dove === 'file'
      ? (p) => p.includes('.tmp-')
      : dove === 'entry'
        ? (p) => p === dirRec
        : (p) => p === fx.stateDir;
    // L'iniezione si arma DOPO l'ammissione: la qualifica delle tracce e la
    // creazione della directory possono sincronizzare legittimamente, e un
    // guasto li' rifiuterebbe un prodotto conservativo nel punto sbagliato
    // invece di colpire la dipendenza reale della fase che si vuole provare.
    let guastoArmato = false;
    const fsRotto = {
      ...fs,
      openSync(p, ...rest) {
        const fd = fs.openSync(p, ...rest);
        fdPaths.set(fd, String(p));
        return fd;
      },
      closeSync(fd) {
        fdPaths.delete(fd);
        return fs.closeSync(fd);
      },
      fsyncSync(fd) {
        const p = fdPaths.get(fd) || '';
        if (guastoArmato && bersaglio(p)) {
          fsyncScattato += 1;
          const err = new Error(`EIO injected on ${dove} fsync`);
          err.code = 'EIO';
          throw err;
        }
        return fs.fsyncSync(fd);
      },
    };

    const killCallsD = [];
    const factory = mod.createHostRecovery({
      fsRecovery: fsRotto,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCallsD.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => clockD,
      attesaImpl: async (ms) => { clockD += Math.max(1, ms); },
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clockD + 8000,
      phasePlan: piano(8000, clockD + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    // L'ammissione è un positivo: il guasto è ancora disarmato e la fixture è
    // qualificabile, quindi il prodotto deve arrivare al percorso di recover.
    // Un rifiuto qui salterebbe tutti e tre i confini fsync senza alcuna
    // iniezione, lasciando non misurata la durabilità del percorso ordinario.
    assert.equal(
      opened && opened.ok,
      true,
      `7.2(d/${dove}): con guasto disarmato l'ammissione deve riuscire e raggiungere recover`,
    );
    guastoArmato = true;

    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.ok(fsyncScattato >= 1, `7.2(d/${dove}): il guasto fsync deve essere davvero iniettato`);
    assertEsitoFallimento(out, `7.2(d/${dove})`);
    assert.deepEqual(killCallsD, [], `7.2(d/${dove}): nessun segnale dopo un guasto di durabilità pre-effetto`);
  }

  // (e) Guasto di durabilità DOPO un effetto già avvenuto: il TERM è partito e
  // la registrazione del segnale non si sincronizza. L'iniezione si arma
  // dentro la syscall del TERM, quindi il primo fsync di evento che colpisce è
  // quello successivo all'effetto. Attesi: zero NUOVI segnali, esito della
  // famiglia di fallimento e traccia incerta per il temporaneo residuo.
  {
    const fx = creaUnitFixture(t);
    let clock = 60000;
    let guastoDopoEffetto = false;
    let guastoSegnato = false;
    const killCallsE = [];
    const fdPathsE = new Map();
    const fsRottoE = {
      ...fs,
      openSync(p, ...rest) {
        const fd = fs.openSync(p, ...rest);
        fdPathsE.set(fd, String(p));
        return fd;
      },
      closeSync(fd) {
        fdPathsE.delete(fd);
        return fs.closeSync(fd);
      },
      fsyncSync(fd) {
        const p = fdPathsE.get(fd) || '';
        if (guastoDopoEffetto && p.includes('.tmp-')) {
          guastoSegnato = true;
          const err = new Error('EIO injected on the event after the signal');
          err.code = 'EIO';
          throw err;
        }
        return fs.fsyncSync(fd);
      },
    };
    const factory = mod.createHostRecovery({
      fsRecovery: fsRottoE,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => {
        killCallsE.push({ pid, sig });
        if (sig === 'SIGTERM') guastoDopoEffetto = true;
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
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true, '7.2(e): openAttempt atteso ok:true');

    let out;
    try {
      out = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }

    assert.equal(guastoSegnato, true, '7.2(e): il guasto deve cadere sull\'evento registrato dopo il TERM');
    assert.deepEqual(
      killCallsE,
      [{ pid: HOST_PID, sig: 'SIGTERM' }],
      '7.2(e): TERM già inviato, nessun NUOVO segnale dopo il guasto post-effetto',
    );
    assertEsitoFallimento(out, '7.2(e)');
    assert.equal(
      factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
      'uncertain',
      '7.2(e): il temporaneo residuo della registrazione fallita lascia la traccia incerta',
    );
  }
});

test('7.3 commit fallito dopo morte host provata su 1a down lascia record incerto; 2a down chiude resolved-dead con zero re-TERM e zero nuove CLI', async (t) => {
  const w = creaMondoE2E(t, { budgetMs: 3000 });
  await attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);

  // Simula riavvio NC senza canale vivo e con sessione tmux/supervisore gia usciti prima della 1a down; host vivo che rifiuta stop CLI.
  try { process.kill(w.paneChild.pid, 'SIGKILL'); } catch (_) {}
  const deadDeadline = Date.now() + 3000;
  while (gruppo.leggiPgrp(w.paneChild.pid) !== null && Date.now() < deadDeadline) {
    await new Promise((r) => setTimeout(r, 15));
  }
  fs.writeFileSync(w.sessionsPath, '[]');
  fs.writeFileSync(w.deathMarkerPath, '1');
  await w.runtime.shutdown();
  w.mgr.close();
  const rt2Bundle = w.creaSecondoRuntime();

  w.setVlScenario({ hostState: 'live', stopAction: 'refuse', afterAckState: 'lock' });
  w.setOnKillProcess((pid, sig) => {
    if (pid === HOST_PID && sig === 'SIGTERM') {
      w.syntheticHost.alive = false;
      w.setVlScenario({ hostState: 'none', afterAckState: 'none' });
    }
  });

  // Blocca il commit in quarantena (launch-targets/reconciled) alla 1a down.
  const quarantineDir = path.join(w.filesRoot, launchTarget.DIR, launchTarget.DIR_QUARANTENA);
  fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(quarantineDir, 0o500);

  let err1 = null;
  let res1 = null;
  try {
    res1 = await rt2Bundle.runtime.down(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    err1 = e;
  }

  fs.chmodSync(quarantineDir, 0o700);
  const cliAfterFirst = w.getCliStopCalls();

  // Esegue la 2a down con directory quarantena ripristinata.
  let err2 = null;
  let res2 = null;
  try {
    res2 = await rt2Bundle.runtime.down(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    err2 = e;
  }

  assert.deepEqual(
    {
      err: err2 ? { fleetCode: err2.fleetCode } : null,
      ok: Boolean(res2 && res2.ok),
      outcome: res2 ? res2.outcome : null,
    },
    {
      err: null,
      ok: true,
      outcome: 'resolved-dead',
    },
    `7.3: seconda down dopo morte host provata e commit fallito deve chiudere ok:true outcome resolved-dead (1a: err=${err1 && err1.fleetCode}, res1=${Boolean(res1)}; 2a: err=${err2 && err2.fleetCode})`,
  );
  assert.ok(err1, '7.3: prima down con quarantena 0o500 deve fallire');
  assert.deepEqual(w.killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }], '7.3: esattamente 1 SIGTERM nella 1a down e 0 nella 2a down');
  assert.ok(cliAfterFirst >= 1, '7.3: CLI stop tentata alla 1a down');
  assert.equal(w.getCliStopCalls(), cliAfterFirst, '7.3: seconda down non deve rieseguire internal host-stop');
  assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'assente', '7.3: record chiuso dopo 2a down');
  const claim = vlRoots.osservaClaim({
    home: w.home,
    root: w.vlRoot,
    ownerInstanceId: OWNER,
    cellId: w.cella,
  });
  assert.ok(['released', 'none'].includes(claim), `7.3: claim rilasciata o none (trovato ${claim})`);
});

test('7.4 crash fra intent/TERM/KILL lascia tracce non promosse a successo e la ripresa rilegge fence, kernel e root', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '7.4: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  // (a) Solo intent-term: con processo originale vivo invia 1 SIGTERM e completa; se absent+none chiude con 0 segnali.
  {
    const fx = creaUnitFixture(t);
    const attemptId = hexId(16);
    const contextDigest = computeContextDigest(fx.record);
    seedRecoveryEvent(fx.stateDir, {
      launchId: fx.record.launchId,
      attemptId,
      seq: 1,
      kind: 'intent-term',
      contextDigest,
      method: 'term',
    });

    let alive = true;
    let rootState = 'lock';
    let clock = 10000;
    const killCalls = [];

    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => {
        killCalls.push({ pid, sig });
        if (sig === 'SIGTERM') {
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
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: rootState, declared_pid: null, pid_number_in_use: null } }),
    });
    assertFactoryMethods(factory, '7.4');

    const tracePre = factory.readTrace({ stateDir: fx.stateDir, record: fx.record });
    // An intent alone is not a protected block: it proves the intent, not the
    // death of the process, and the recovery resumes from it. What must not be
    // there before the recovery is a promotion to success.
    assert.equal(tracePre.state, 'clear', '7.4(a): an intent alone is not a protected block');
    assert.equal(tracePre.events.filter((e) => e.kind === 'exited').length, 0, '7.4(a): no exited event before the recovery');
    assert.equal(tracePre.events.filter((e) => e.kind === 'closed').length, 0, '7.4(a): no closed event before the recovery');

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true, '7.4(a): openAttempt post-intent-term deve riuscire');

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(res.outcome, 'host-stopped-attested', '7.4(a): ripresa con processo vivo completa con SIGTERM');
    assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }]);
  }

  // (b) intent-term su processo gia absent + root none -> chiude exited/closed con 0 segnali.
  {
    const fx = creaUnitFixture(t);
    const attemptId = hexId(16);
    const contextDigest = computeContextDigest(fx.record);
    seedRecoveryEvent(fx.stateDir, {
      launchId: fx.record.launchId,
      attemptId,
      seq: 1,
      kind: 'intent-term',
      contextDigest,
      method: 'term',
    });

    const killCalls = [];
    let clock = 20000;
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

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true, '7.4(b): openAttempt deve riuscire');

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(res.outcome, 'host-stopped-attested', '7.4(b): processo gia assente e root none chiude attestato');
    assert.deepEqual(killCalls, [], '7.4(b): zero segnali quando processo e gia absent');
  }

  // (c) intent-term + signaled-term con processo vivo -> non re-invia SIGTERM, scrive intent-kill e invia 1 SIGKILL.
  {
    const fx = creaUnitFixture(t);
    const attemptId = hexId(16);
    const contextDigest = computeContextDigest(fx.record);
    seedRecoveryEvent(fx.stateDir, {
      launchId: fx.record.launchId,
      attemptId,
      seq: 1,
      kind: 'intent-term',
      contextDigest,
      method: 'term',
    });
    seedRecoveryEvent(fx.stateDir, {
      launchId: fx.record.launchId,
      attemptId,
      seq: 2,
      kind: 'signaled-term',
      contextDigest,
      method: 'term',
      reason: 'sent',
    });

    let alive = true;
    let rootState = 'lock';
    let clock = 30000;
    const killCalls = [];
    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => {
        killCalls.push({ pid, sig });
        if (sig === 'SIGKILL') {
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
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: rootState, declared_pid: null, pid_number_in_use: null } }),
    });

    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: clock + 8000,
      phasePlan: piano(8000, clock + 8000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(opened && opened.ok, true, '7.4(c): openAttempt post signaled-term deve riuscire');

    let res;
    try {
      res = await factory.recover(opened.attempt, 'silent');
    } finally {
      factory.closeAttempt(opened.attempt);
    }
    assert.equal(res.outcome, 'host-stopped-attested', '7.4(c): ripresa post signaled-term completa con SIGKILL');
    assert.deepEqual(killCalls, [{ pid: HOST_PID, sig: 'SIGKILL' }], '7.4(c): niente replay di SIGTERM, 1 solo SIGKILL');
  }

  // (d) File traccia parziale/tronco -> readTrace uncertain e recover rifiuta con 0 segnali.
  {
    const fx = creaUnitFixture(t);
    const dir = path.join(fx.stateDir, 'recovery-events');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, '00000001-intent-term.json'), '{"version":1,"kind":"intent-', { mode: 0o600 });

    const killCalls = [];
    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => 40000,
      attesaImpl: async () => {},
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });

    const trace = factory.readTrace({ stateDir: fx.stateDir, record: fx.record });
    assert.equal(trace.state, 'uncertain', '7.4(d): JSON tronco deve marcare stato trace uncertain');
    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: 48000,
      phasePlan: piano(8000, 48000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(Boolean(opened && opened.ok), false, '7.4(d): openAttempt su trace tronco deve rifiutare');
    assert.deepEqual(killCalls, [], '7.4(d): zero segnali su trace tronco');
  }
});

test('7.5 riavvio NC e riagganciaCanale esigono nuovo prepare-ack sul canale nuovo e non promuovono mai file su disco', async (t) => {
  // Parte (a): file recovery su disco pre-popolati, ma coordinatore riagganciato non emette prepare-ack -> STOP_UNKNOWN, zero segnali.
  {
    const w = creaMondoE2E(t, { cella: 'CellaFen75a', budgetMs: 1500 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    const sup1 = await w.attaccaSupervisore();

    const ctx = hostStop.leggiContesto(w.cellBase);
    seedRecoveryEvent(w.cellBase, {
      launchId: ctx.launchId,
      attemptId: hexId(16),
      seq: 1,
      kind: 'cli-attempt',
      contextDigest: computeContextDigest(ctx),
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
  }

  // Parte (b): riavvio + riagganciaCanale con nuovo prepare-ack e silent host recovery -> host-stopped-attested method term.
  {
    const w = creaMondoE2E(t, { cella: 'CellaFen75b', budgetMs: 3000 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    const sup1 = await w.attaccaSupervisore();

    await w.runtime.shutdown();
    sup1.close();
    w.mgr.close();

    const rt2Bundle = w.creaSecondoRuntime();
    rt2Bundle.mgr.boot();
    assert.ok(rt2Bundle.mgr.armControl(w.cella, { launchId: sup1.launchId, token: sup1.token }), '7.5(b): armControl su mgr2');

    let prepareAckCountRt2 = 0;
    await w.attaccaSupervisore({
      mgr: rt2Bundle.mgr,
      launchId: sup1.launchId,
      token: sup1.token,
      onPrepareAck: () => { prepareAckCountRt2 += 1; },
    });

    w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'lock' });
    w.setOnKillProcess((pid, sig) => {
      if (pid === HOST_PID && sig === 'SIGTERM') {
        w.syntheticHost.alive = false;
        w.setVlScenario({ hostState: 'none', afterAckState: 'none' });
      }
    });

    let errB = null;
    let resB = null;
    try {
      resB = await rt2Bundle.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      errB = e;
    }

    assert.deepEqual(
      {
        err: errB ? { fleetCode: errB.fleetCode } : null,
        ok: Boolean(resB && resB.ok),
        host: resB ? resB.host : null,
      },
      {
        err: null,
        ok: true,
        host: { outcome: 'host-stopped-attested', method: 'term' },
      },
      `7.5(b): down dopo riavvio e riagganciaCanale con nuovo prepare-ack deve completare host-stopped-attested (ricevuto ${errB && errB.fleetCode})`,
    );
    assert.equal(prepareAckCountRt2, 1, '7.5(b): atteso esattamente 1 prepare-ack fresco sul canale riagganciato');
  }
});

test('7.6 record legacy o pending/none e directory o trace illeggibili rifiutano con zero segnali', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '7.6: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');
  assert.equal(typeof mod?.guardRecord, 'function', '7.6: export guardRecord mancante in lib/fleet/vl-host-recovery.js');

  const fx = creaUnitFixture(t);
  assert.equal(mod.guardRecord({ ...fx.record, version: 1 }), false, '7.6: guardRecord deve rifiutare version:1 legacy');
  assert.equal(mod.guardRecord({ ...fx.record, hostIdentity: { state: 'pending' } }), false, '7.6: guardRecord deve rifiutare state:pending');
  assert.equal(mod.guardRecord({ ...fx.record, hostIdentity: { state: 'none' } }), false, '7.6: guardRecord deve rifiutare state:none');

  const eventsDir = path.join(fx.stateDir, 'recovery-events');
  fs.mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
  const badFile = path.join(eventsDir, '00000001-intent-term.json');
  fs.writeFileSync(badFile, '{corrupt', { mode: 0o600 });

  const killCalls = [];
  const factory = mod.createHostRecovery({
    fsRecovery: fs,
    publishExclusive: PUB_EXCL,
    killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
    osservaKernel: (pid, instanceId) => ({
      state: 'observed',
      processState: 'S',
      identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
    }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 50000,
    attesaImpl: async () => {},
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
  });

  // I tre difetti viaggiano su fixture INDIPENDENTI, un solo difetto per
  // fixture: mescolarli rende ogni rifiuto attribuibile alla causa sbagliata.
  function eventoValido(record, seq, kind = 'cli-attempt', extra = {}) {
    return {
      version: 1,
      launchId: record.launchId,
      attemptId: hexId(16),
      seq,
      kind,
      contextDigest: computeContextDigest(record),
      ...extra,
    };
  }

  // (A) EACCES da solo.
  {
    const fxE = creaUnitFixture(t);
    const dir = path.join(fxE.stateDir, 'recovery-events');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, '00000001-cli-attempt.json');
    fs.writeFileSync(file, canonicalEventLine(eventoValido(fxE.record, 1)), { mode: 0o600 });
    fs.chmodSync(file, 0o000);
    const tr = factory.readTrace({ stateDir: fxE.stateDir, record: fxE.record });
    fs.chmodSync(file, 0o600);
    assert.equal(tr.state, 'uncertain', '7.6(A): EACCES da solo deve marcare trace uncertain');
  }

  // (B) JSON corrotto da solo.
  {
    const fxC = creaUnitFixture(t);
    const dir = path.join(fxC.stateDir, 'recovery-events');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, '00000001-cli-attempt.json'), '{corrupt', { mode: 0o600 });
    const tr = factory.readTrace({ stateDir: fxC.stateDir, record: fxC.record });
    assert.equal(tr.state, 'uncertain', '7.6(B): JSON corrotto da solo deve marcare trace uncertain');
  }

  // (C) Buco sequenziale da solo: esiste il 2, manca l'1, entrambi leggibili.
  {
    const fxG = creaUnitFixture(t);
    seedRecoveryEvent(fxG.stateDir, eventoValido(fxG.record, 2, 'exited', { method: 'term', reason: 'absent' }));
    const tr = factory.readTrace({ stateDir: fxG.stateDir, record: fxG.record });
    assert.equal(tr.state, 'uncertain', '7.6(C): buco seq da solo deve marcare trace uncertain');
  }

  // (D) Controllo positivo: una storia realmente ammissibile — tentativi aperti
  // e poi chiusi dal loro evento terminale — deve essere accettata.
  {
    const fxOk = creaUnitFixture(t);
    seedStoriaAmmissibile(fxOk.stateDir, fxOk.record, 6);
    const tr = factory.readTrace({ stateDir: fxOk.stateDir, record: fxOk.record });
    assert.equal(tr.state, 'clear', '7.6(D): storia di tentativi chiusi deve dare clear');
  }

  // (E) Un cli-attempt aperto e sintatticamente valido non e' JSON corrotto: il
  // reader lo legge come bloccante, e solo illeggibilita'/buchi danno uncertain.
  {
    const fxOpen = creaUnitFixture(t);
    seedRecoveryEvent(fxOpen.stateDir, eventoValido(fxOpen.record, 1));
    const tr = factory.readTrace({ stateDir: fxOpen.stateDir, record: fxOpen.record });
    assert.equal(tr.state, 'blocked', '7.6(E): cli-attempt aperto valido e bloccante, non illeggibile');
  }

  const opened = factory.openAttempt({
    record: fx.record,
    stateDir: fx.stateDir,
    deadlineAt: 58000,
    phasePlan: piano(8000, 58000),
    allowHostRecovery: true,
    fenceCheck: () => true,
  }, 'silent');
  assert.equal(Boolean(opened && opened.ok), false, '7.6: openAttempt rifiuta su trace illeggibile/non qualificato');
  assert.deepEqual(killCalls, [], '7.6: zero segnali su legacy/illeggibile');

  // (F) Invalid plan inputs are refused before any effect, at the same
  // boundary where the valid plan is accepted.
  {
    const fxP = creaUnitFixture(t);
    const valido = piano(8000, 48000);
    const invalidi = [
      { nome: 'budget-fuori-range', piano: { ...valido, budgetMs: 199 } },
      { nome: 'budget-sopra-range', piano: { ...valido, budgetMs: 15001 } },
      { nome: 'fasi-mancanti', piano: { ...valido, phases: valido.phases.slice(0, 8) } },
      { nome: 'fase-duplicata', piano: { ...valido, phases: valido.phases.map((f, i) => (i === 1 ? { ...f, id: 'p1' } : f)) } },
      { nome: 'somma-errata', piano: { ...valido, marginMs: 999 } },
      { nome: 'deadline-diversa', piano: { ...valido, deadlineAt: 47000 } },
      { nome: 'allowance-oltre-cap', piano: { ...valido, phases: valido.phases.map((f, i) => (i === 0 ? { ...f, allowanceMs: f.capMs + 1 } : f)) } },
    ];
    for (const caso of invalidi) {
      const killCallsP = [];
      const factoryP = mod.createHostRecovery({
        fsRecovery: fs,
        publishExclusive: PUB_EXCL,
        killProcess: (pid, sig) => { killCallsP.push({ pid, sig }); },
        osservaKernel: (pid, instanceId) => ({
          state: 'observed',
          processState: 'S',
          identity: { ...fxP.record.hostIdentity, instanceId: instanceId || OWNER },
        }),
        identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
        identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
        monoNow: () => 40000,
        attesaImpl: async () => {},
        probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
      });
      const openedP = factoryP.openAttempt({
        record: fxP.record,
        stateDir: fxP.stateDir,
        deadlineAt: 48000,
        phasePlan: caso.piano,
        allowHostRecovery: true,
        fenceCheck: () => true,
      }, 'silent');
      assert.equal(
        Boolean(openedP && openedP.ok),
        false,
        `7.6(F/${caso.nome}): piano invalido deve essere rifiutato prima degli effetti`,
      );
      assert.deepEqual(killCallsP, [], `7.6(F/${caso.nome}): zero segnali`);
    }

    const killCallsOk = [];
    const factoryOk = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCallsOk.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fxP.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => 40000,
      attesaImpl: async () => {},
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });
    const openedOk = factoryOk.openAttempt({
      record: fxP.record,
      stateDir: fxP.stateDir,
      deadlineAt: 48000,
      phasePlan: valido,
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(Boolean(openedOk && openedOk.ok), true, '7.6(F/positivo): piano valido ammesso allo stesso confine');
    if (openedOk && openedOk.ok) factoryOk.closeAttempt(openedOk.attempt);
    assert.deepEqual(killCallsOk, [], '7.6(F/positivo): zero segnali');
  }
});

test('7.7 cap 2048 B / 64 file, prenotazioni preflight 10/4/8 e residui parziali rifiutano senza overwrite ne segnali', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '7.7: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  // (a) Preflight 10 / 4 / 8 su recovery-events vicini a cap 64. Per ogni
  // configurazione si esercita il CONFINE — 64 - riserva ammesso, 65 - riserva
  // rifiutato — su una storia REALMENTE ammissibile: tentativi aperti e poi
  // chiusi dal loro evento terminale, nessun rifiuto irrisolto. Le due varianti
  // distano una sola voce dello store, quindi il rifiuto del negativo e'
  // attribuibile alla capacita' e non a una traccia aperta.
  for (const cfgCase of [
    { name: 'expected+recovery', mode: 'expected', allowHostRecovery: true, existing: 55, minFreeNeeded: 10 },
    { name: 'expected-no-recovery', mode: 'expected', allowHostRecovery: false, existing: 61, minFreeNeeded: 4 },
    { name: 'silent', mode: 'silent', allowHostRecovery: true, existing: 57, minFreeNeeded: 8 },
  ]) {
    for (const [esito, existing] of [
      ['positivo', 64 - cfgCase.minFreeNeeded],
      ['negativo', 65 - cfgCase.minFreeNeeded],
    ]) {
      const fx = creaUnitFixture(t);
      seedStoriaAmmissibile(fx.stateDir, fx.record, existing);

      const killCalls = [];
      const deadline = 68000;
      const factory = mod.createHostRecovery({
        fsRecovery: fs,
        publishExclusive: PUB_EXCL,
        killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
        osservaKernel: (pid, instanceId) => ({
          state: 'observed',
          processState: 'S',
          identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
        }),
        identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
        identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
        monoNow: () => 60000,
        attesaImpl: async () => {},
        probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
      });
      // Il piano esplicito viaggia con ogni confine che autorizza la recovery;
      // il ramo expected senza recovery resta l'adattatore storico.
      const ctxAttempt = () => ({
        record: fx.record,
        stateDir: fx.stateDir,
        deadlineAt: deadline,
        ...(cfgCase.allowHostRecovery ? { phasePlan: piano(8000, deadline) } : {}),
        allowHostRecovery: cfgCase.allowHostRecovery,
        fenceCheck: () => true,
      });

      assert.equal(
        factory.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
        'clear',
        `7.7(${cfgCase.name}/${esito}): la storia seminata e' ammissibile, non bloccata ne incerta`,
      );
      assert.equal(
        readRecoveryEvents(fx.stateDir).length,
        existing,
        `7.7(${cfgCase.name}/${esito}): ${existing} voci nel namespace`,
      );

      const opened = factory.openAttempt(ctxAttempt(), cfgCase.mode);
      if (esito === 'positivo') {
        assert.equal(
          Boolean(opened && opened.ok),
          true,
          `7.7(${cfgCase.name}/positivo): ${existing} file + riserva ${cfgCase.minFreeNeeded} = 64, il confine ammesso non puo' essere rifiutato`,
        );
        if (opened && opened.ok && typeof factory.closeAttempt === 'function') factory.closeAttempt(opened.attempt);
      } else {
        assert.equal(
          Boolean(opened && opened.ok),
          false,
          `7.7(${cfgCase.name}/negativo): ${existing} file + riserva ${cfgCase.minFreeNeeded} = 65, oltre il cap`,
        );
        // Controprova della sola capacita', sullo stesso store: togliendo le
        // ultime due voci (l'ultimo tentativo resta chiuso dal suo evento
        // terminale) lo stesso confine ammette.
        const voci = readRecoveryEvents(fx.stateDir);
        fs.unlinkSync(voci[voci.length - 1].path);
        fs.unlinkSync(voci[voci.length - 2].path);
        const dopo = factory.openAttempt(ctxAttempt(), cfgCase.mode);
        assert.equal(
          Boolean(dopo && dopo.ok),
          true,
          `7.7(${cfgCase.name}/negativo): a parita' di storia, una voce in meno sotto il cap ammette`,
        );
        if (dopo && dopo.ok) factory.closeAttempt(dopo.attempt);
      }
      assert.deepEqual(killCalls, [], `7.7(${cfgCase.name}/${esito}): zero segnali`);
    }
  }

  // (a2) La prenotazione e' di RAM, non un conteggio: un secondo tentativo
  // concorrente sullo stesso store e' rifiutato bounded, e closeAttempt libera
  // la prenotazione senza cancellare ne mutare alcun file.
  {
    const fx = creaUnitFixture(t);
    const existing = 64 - 10;
    seedStoriaAmmissibile(fx.stateDir, fx.record, existing);
    const prima = readRecoveryEvents(fx.stateDir).map((e) => ({ name: e.name, raw: e.raw }));

    const killCalls = [];
    const deadline = 68000;
    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => 60000,
      attesaImpl: async () => {},
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });
    const ctxAttempt = () => ({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: deadline,
      phasePlan: piano(8000, deadline),
      allowHostRecovery: true,
      fenceCheck: () => true,
    });

    const primo = factory.openAttempt(ctxAttempt(), 'expected');
    assert.equal(Boolean(primo && primo.ok), true, '7.7(a2): primo tentativo ammesso al suo confine');
    const secondo = factory.openAttempt(ctxAttempt(), 'expected');
    assert.equal(
      Boolean(secondo && secondo.ok),
      false,
      '7.7(a2): un solo attempt attivo per store, il secondo concorrente e\' rifiutato',
    );
    assert.equal(typeof (secondo && secondo.code), 'string', '7.7(a2): il rifiuto concorrente porta un codice');

    if (primo && primo.ok) factory.closeAttempt(primo.attempt);
    const terzo = factory.openAttempt(ctxAttempt(), 'expected');
    assert.equal(
      Boolean(terzo && terzo.ok),
      true,
      '7.7(a2): chiuso il primo, la prenotazione RAM e\' libera e il confine ammette',
    );
    if (terzo && terzo.ok) factory.closeAttempt(terzo.attempt);

    assert.deepEqual(
      readRecoveryEvents(fx.stateDir).map((e) => ({ name: e.name, raw: e.raw })),
      prima,
      '7.7(a2): il rilascio della prenotazione non cancella ne muta i file',
    );
    assert.deepEqual(killCalls, [], '7.7(a2): zero segnali');
  }

  // (b) Temporaneo residuo .tmp-<32hex> conta nel namespace e blocca escalation con 0 segnali.
  {
    const fx = creaUnitFixture(t);
    const dir = path.join(fx.stateDir, 'recovery-events');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `.tmp-${'ab'.repeat(16)}`), '{"partial":true', { mode: 0o600 });

    const killCalls = [];
    const factory = mod.createHostRecovery({
      fsRecovery: fs,
      publishExclusive: PUB_EXCL,
      killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
      osservaKernel: (pid, instanceId) => ({
        state: 'observed',
        processState: 'S',
        identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
      }),
      identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
      identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
      monoNow: () => 70000,
      attesaImpl: async () => {},
      probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
    });

    const tr = factory.readTrace({ stateDir: fx.stateDir, record: fx.record });
    assert.equal(tr.state, 'uncertain', '7.7(b): temporaneo residuo deve marcare trace uncertain');
    const opened = factory.openAttempt({
      record: fx.record,
      stateDir: fx.stateDir,
      deadlineAt: 78000,
      phasePlan: piano(8000, 78000),
      allowHostRecovery: true,
      fenceCheck: () => true,
    }, 'silent');
    assert.equal(Boolean(opened && opened.ok), false, '7.7(b): openAttempt rifiuta con temporaneo residuo');
    assert.deepEqual(killCalls, [], '7.7(b): zero segnali');
  }
});

test('7.8 EEXIST discordante su store o pubblicaEsclusiva blocca senza overwrite ne replay segnali', async (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.createHostRecovery, 'function', '7.8: export createHostRecovery mancante in lib/fleet/vl-host-recovery.js');

  const fx = creaUnitFixture(t);
  const eventsDir = path.join(fx.stateDir, 'recovery-events');
  fs.mkdirSync(eventsDir, { recursive: true, mode: 0o700 });

  // Verifica comportamento base di pubblicaEsclusiva su file esistente discordante vs concordante.
  const srcA = path.join(eventsDir, '.tmp-test-src-a');
  const destDirect = path.join(eventsDir, 'direct-test.json');
  const existingBytes = Buffer.from(`${JSON.stringify({ k: 1 })}\n`, 'utf8');
  fs.writeFileSync(destDirect, existingBytes, { mode: 0o600 });
  fs.writeFileSync(srcA, Buffer.from(`${JSON.stringify({ k: 2 })}\n`, 'utf8'), { mode: 0o600 });
  const pubDiscord = PUB_EXCL({ src: srcA, dest: destDirect, bytes: existingBytes });
  assert.equal(pubDiscord.status, 'exists', '7.8: pubblicaEsclusiva su destinazione esistente ritorna status exists');
  assert.deepEqual(fs.readFileSync(destDirect), existingBytes, '7.8: pubblicaEsclusiva non sovrascrive file esistente');
  try { fs.unlinkSync(srcA); } catch (_) {}
  try { fs.unlinkSync(destDirect); } catch (_) {}

  // In recover, una pubblicazione EEXIST discordante su 00000001-intent-term.json deve fallire con 0 segnali e 0 overwrite.
  const discordantSeed = seedRecoveryEvent(fx.stateDir, {
    launchId: '0123456789abcdef',
    attemptId: hexId(16),
    seq: 1,
    kind: 'intent-term',
    contextDigest: 'f'.repeat(64),
    method: 'term',
  });
  // Simula collisione EEXIST sullo stesso filename di destinazione durante publishExclusive.
  fs.rmSync(discordantSeed.path);

  const killCalls = [];
  let injectedCollision = false;
  const factory = mod.createHostRecovery({
    fsRecovery: fs,
    publishExclusive: (opts) => {
      if (!injectedCollision && opts?.dest?.endsWith('intent-term.json')) {
        injectedCollision = true;
        fs.writeFileSync(opts.dest, discordantSeed.line, { mode: 0o600 });
      }
      return PUB_EXCL(opts);
    },
    killProcess: (pid, sig) => { killCalls.push({ pid, sig }); },
    osservaKernel: (pid, instanceId) => ({
      state: 'observed',
      processState: 'S',
      identity: { ...fx.record.hostIdentity, instanceId: instanceId || OWNER },
    }),
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 80000,
    attesaImpl: async () => {},
    probeRoot: async () => ({ r: { ok: true }, stato: { ok: true, state: 'lock', declared_pid: null, pid_number_in_use: null } }),
  });

  assert.equal(typeof factory?.recover, 'function', '7.8: capability factory.recover mancante');
  const opened = factory.openAttempt({
    record: fx.record,
    stateDir: fx.stateDir,
    deadlineAt: 88000,
    phasePlan: piano(8000, 88000),
    allowHostRecovery: true,
    fenceCheck: () => true,
  }, 'silent');
  assert.equal(opened && opened.ok, true, '7.8: openAttempt atteso ok:true');

  let out;
  try {
    out = await factory.recover(opened.attempt, 'silent');
  } finally {
    factory.closeAttempt(opened.attempt);
  }

  assertEsitoFallimento(out, '7.8');
  assert.deepEqual(killCalls, [], '7.8: EEXIST discordante non deve inviare segnali');
  assert.equal(fs.readFileSync(path.join(eventsDir, '00000001-intent-term.json'), 'utf8'), discordantSeed.line, '7.8: file discordante mai sovrascritto');
});

test('7.9 schema chiuso eventi per tutti gli 11 kind e host-context.json immutato', (t) => {
  const mod = caricaModuloRecovery();
  assert.equal(typeof mod?.validateEvent, 'function', '7.9: export validateEvent mancante in lib/fleet/vl-host-recovery.js');

  const fx = creaUnitFixture(t);
  const contextDigest = computeContextDigest(fx.record);
  const attemptId = hexId(16);
  const validByKind = {
    'cli-attempt': {},
    'peer-verified': {},
    'cli-ack': { reason: 'shutdown_ack' },
    'cli-refusal': { reason: 'peer_mismatch' },
    'cli-failed': { reason: 'spawn' },
    'intent-term': { method: 'term' },
    'signaled-term': { method: 'term', reason: 'sent' },
    'intent-kill': { method: 'kill' },
    'signaled-kill': { method: 'kill', reason: 'esrch' },
    exited: { method: 'term', reason: 'absent' },
    closed: { method: null },
  };

  // Pure form: validateEvent takes the OBJECT and answers a strict boolean.
  // No {ok:true} acceptance and no exception-as-refusal.
  const isAccepted = (value) => mod.validateEvent(value);

  let seq = 1;
  for (const kind of EVENT_KINDS) {
    const event = {
      version: 1,
      launchId: fx.record.launchId,
      attemptId,
      seq,
      kind,
      contextDigest,
      ...validByKind[kind],
    };
    assert.equal(isAccepted(event), true, `7.9: validateEvent deve accettare evento valido per kind ${kind}`);
    const line = canonicalEventLine(event);
    assert.ok(Buffer.byteLength(line, 'utf8') <= 2048, `7.9: lunghezza evento ${kind} <= 2048`);
    seq += 1;
  }

  // Schema rejects, on the object, strict false.
  const baseEvent = { version: 1, launchId: fx.record.launchId, attemptId, seq: 1, kind: 'cli-attempt', contextDigest };
  assert.equal(
    isAccepted({ ...baseEvent, token: 'secret' }),
    false,
    '7.9: campo extra/segreto token rifiutato',
  );
  assert.equal(
    isAccepted({ ...baseEvent, seq: 65 }),
    false,
    '7.9: seq > 64 rifiutato',
  );

  // Byte-level rejects belong to the READER, not to the pure validator, and the
  // reader is a factory method: every read below goes through a qualified
  // factory built on the observing fs. The spy measures the bytes actually
  // read and censuses every mutating primitive, including numeric flags.
  const letture = [];
  const scritture = [];
  const fdLetti = new Map();
  const fsSpy = { ...fs };
  const MUTANTI = [
    'writeFileSync', 'writeSync', 'appendFileSync', 'truncateSync', 'ftruncateSync',
    'unlinkSync', 'renameSync', 'linkSync', 'symlinkSync', 'chmodSync', 'fchmodSync',
    'utimesSync', 'copyFileSync', 'rmSync', 'rmdirSync', 'mkdirSync',
  ];
  const FLAG_SCRITTURA = fs.constants.O_WRONLY | fs.constants.O_RDWR
    | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
  for (const nome of ['readFileSync', 'openSync', 'readSync', 'fstatSync', 'closeSync', 'readdirSync', 'statSync', 'lstatSync']) {
    if (typeof fs[nome] !== 'function') continue;
    fsSpy[nome] = (...args) => {
      const esito = fs[nome](...args);
      if (nome === 'openSync') {
        const flag = args[1];
        const stringaScrittura = typeof flag === 'string' && /[wa+]/.test(flag);
        const flagNumerico = typeof flag === 'number' && (flag & FLAG_SCRITTURA) !== 0;
        if (stringaScrittura || flagNumerico) scritture.push({ path: args[0], flag });
        fdLetti.set(esito, String(args[0]));
      }
      if (nome === 'closeSync') fdLetti.delete(args[0]);
      const percorso = nome === 'openSync'
        ? String(args[0])
        : (typeof args[0] === 'string' ? args[0] : fdLetti.get(args[0]));
      if (typeof percorso === 'string') {
        const byte = nome === 'readSync'
          ? esito
          : (Buffer.isBuffer(esito) ? esito.length : 0);
        letture.push({ nome, bersaglio: percorso, bytes: byte });
      }
      return esito;
    };
  }
  for (const nome of MUTANTI) {
    if (typeof fs[nome] !== 'function') continue;
    fsSpy[nome] = (...args) => {
      scritture.push({ nome, path: typeof args[0] === 'string' ? args[0] : null });
      return fs[nome](...args);
    };
  }
  const factorySpy = mod.createHostRecovery({
    fsRecovery: fsSpy,
    publishExclusive: PUB_EXCL,
    killProcess: () => { throw new Error('7.9: nessun segnale atteso'); },
    osservaKernel: () => { throw new Error('7.9: nessuna osservazione kernel attesa'); },
    identitaNodo: () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS }),
    identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
    monoNow: () => 50000,
    attesaImpl: async () => {},
    probeRoot: async () => { throw new Error('7.9: nessuna probe root attesa'); },
  });
  const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

  // Storia completa e canonica: controllo leggibile, classificato clear.
  const eventiDir = path.join(fx.stateDir, 'recovery-events');
  fs.mkdirSync(eventiDir, { recursive: true, mode: 0o700 });
  const eventFile = path.join(eventiDir, '00000001-cli-attempt.json');
  fs.writeFileSync(eventFile, canonicalEventLine(baseEvent), { mode: 0o600 });
  const eventoChiuso = { ...baseEvent, kind: 'closed', method: null, seq: 2 };
  const chiusoLine = canonicalEventLine(eventoChiuso);
  const eventFile2 = path.join(eventiDir, '00000002-closed.json');
  fs.writeFileSync(eventFile2, chiusoLine, { mode: 0o600 });
  assert.equal(
    factorySpy.readTrace({ stateDir: fx.stateDir, record: fx.record }).state,
    'clear',
    '7.9: la storia completa e canonica deve dare clear (controllo leggibile)',
  );

  // Stessa storia, ma l'ultima riga e' senza LF finale: l'unico difetto e' di
  // formato — gli eventi sono completi e il tentativo e' chiuso — e il reader
  // deve rispondere uncertain, non clear ne blocked.
  fs.writeFileSync(eventFile2, chiusoLine.slice(0, -1), { mode: 0o600 });
  const trTronco = factorySpy.readTrace({ stateDir: fx.stateDir, record: fx.record });
  assert.equal(
    trTronco.state,
    'uncertain',
    '7.9: riga senza LF finale = non canonica, quindi incerta e non bloccata',
  );

  // Il cap byte/file si misura sul READER, in una fixture sua: un file oversize
  // di byte qualsiasi deve essere rifiutato per dimensione o con letture
  // bounded, mai con una lettura illimitata seguita da un errore di parse.
  const fxOver = creaUnitFixture(t);
  const overDir = path.join(fxOver.stateDir, 'recovery-events');
  fs.mkdirSync(overDir, { recursive: true, mode: 0o700 });
  const overFile = path.join(overDir, '00000001-cli-attempt.json');
  fs.writeFileSync(overFile, 'x'.repeat(3000), { mode: 0o600 });
  const dimensionePrima = fs.statSync(overFile).size;
  const hashPrima = sha256File(overFile);
  const trOversize = factorySpy.readTrace({ stateDir: fxOver.stateDir, record: fxOver.record });
  const lettoOversize = letture
    .filter((l) => l.bersaglio === overFile)
    .reduce((tot, l) => tot + (Number.isInteger(l.bytes) ? l.bytes : 0), 0);
  assert.equal(
    trOversize.state,
    'uncertain',
    '7.9: file oltre il cap per byte deve dare uncertain, non clear ne blocked',
  );
  assert.ok(
    letture.some((l) => l.bersaglio === overFile),
    '7.9: il reader deve aver davvero guardato il file oversize',
  );
  assert.ok(
    lettoOversize <= 2049,
    `7.9: letture bounded sul file oversize — cap 2048 piu' una sentinella di overflow (letti ${lettoOversize} byte su 3000)`,
  );
  assert.equal(fs.statSync(overFile).size, dimensionePrima, '7.9: il reader non riscrive il file oversize');
  assert.equal(sha256File(overFile), hashPrima, '7.9: byte identici prima e dopo — la sola dimensione non basta');
  assert.deepEqual(scritture, [], '7.9: il reader non apre in scrittura e non usa primitive mutanti');
  assert.ok(letture.length > 0, '7.9: il reader ha davvero letto la directory');

  // host-context.json conserva il proprio schema chiuso (leggiContesto).
  const ctxRead = hostStop.leggiContesto(fx.stateDir);
  assert.equal(ctxRead && ctxRead.version, 2, '7.9: leggiContesto valida schema v2');
  assert.deepEqual(
    Object.keys(ctxRead).sort(),
    [...CONTEXT_ALLOWED_KEYS].sort(),
    '7.9: chiavi di host-context.json invariate rispetto al contratto chiuso',
  );
});
