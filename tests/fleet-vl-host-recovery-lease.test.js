'use strict';

const { verificaContrattoUi } = require('./helpers/ui-power-i18n.js');

// Host recovery lease barrier, grace calculation, and LEASE_BLOCKS/LEASE_UNREADABLE tests (8.1 - 8.8b).

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
const causes = require('../lib/fleet/causes.js');
const gruppo = require('../lib/fleet/group-stop.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const vlRoots = require('../lib/fleet/vl-roots.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');

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

test('8.1 host risolto e supervisore alive restano barriere distinte in valuta, riconciliaLancio e recovery', async (t) => {
  // Parte A: host risolto (none/morto) con supervisore vivo in proc -> SUPERVISOR_ALIVE resta bloccante.
  {
    const w = creaMondoLea(t);
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.runtime.shutdown();
    fs.writeFileSync(path.join(w.root, 'tmux-dead'), '1');
    w.syntheticHost.alive = false;
    w.setVlScenario({ hostState: 'none', afterAckState: 'none' });

    const rt2 = creaMondoLeaSecond(w);
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
  }

  // Parte B: supervisore morto + sessione assente + lease expired ma host vivo -> recupera host con SIGTERM senza blocco supervisore.
  {
    const w = creaMondoLea(t, { budgetMs: 2800 });
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

    const rt2 = creaMondoLeaSecond(w);
    let err = null;
    let res = null;
    try {
      res = await rt2.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.equal(err, null, `8.1(sup-morto): supervisore morto deve raggiungere recovery host (${err && err.fleetCode})`);
    assert.equal(res && res.ok, true, '8.1(sup-morto): atteso ok:true');
    assert.equal(res && res.outcome, 'resolved-dead', '8.1(sup-morto): atteso resolved-dead');
    assert.equal(res && res.host && res.host.outcome, 'host-stopped-attested', '8.1(sup-morto): outcome attestato');
    assert.equal(res && res.host && res.host.method, 'term', '8.1(sup-morto): metodo term osservato');
    assert.deepEqual(w.killCalls, [{ pid: HOST_PID, sig: 'SIGTERM' }]);
  }
});

function creaMondoLeaSecond(w) {
  return w.creaSecondoRuntime(2800);
}

test('8.2 ramo ternario con lease live o grace rifiuta subito con LEASE_BLOCKS senza attendere 60000 ms e blocca up', async (t) => {
  // I due stati sono esercitati separatamente: la promozione a LEASE_BLOCKS
  // vale solo quando il lease live/grace resta l'unico blocco residuo, e i
  // due stati non sono intercambiabili ai fini della promozione.
  async function eseguiSottocaso(t2, statoLease) {
    const tag = `8.2(${statoLease})`;
    const w = creaMondoLea(t2, { initialLeaseNow: 10000 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    const sup = await w.attaccaSupervisore();
    sup.close();
    await w.terminaSupervisoreESessione();
    await untilNotLive(w.mgrRaw, w.cella);

    if (statoLease === 'live') {
      // Il live REALE richiede il supervisore ancora attaccato, che
      // aggiungerebbe SUPERVISOR_ALIVE come secondo blocco e toglierebbe la
      // premessa «unico blocco residuo». Lo stato si fissa quindi sul seam di
      // status gia' esposto dalla fixture, lasciando reale tutto il resto.
      w.setStatusOverride(() => ({ cellId: w.cella, state: 'live', leaseId: 'lg-82-live', graceDeadline: null }));
    } else {
      w.leaseClock.now = 15000;
      const pre = w.mgrRaw.status(w.cella);
      assert.equal(pre.state, 'grace', `${tag}: prerequisito lease in grace`);
      // La deadline viene dal lease (EOF a now=10000 + 60000 di grace); se il
      // campo non e' esposto dallo status la si ricostruisce dal clock del caso.
      const graceDeadline = Number.isFinite(pre.graceDeadline) ? pre.graceDeadline : 10000 + 60000;
      assert.ok(graceDeadline - w.leaseClock.now > 0, `${tag}: prerequisito grace ancora attiva`);
    }
    await w.runtime.shutdown();

    const rt2 = w.creaSecondoRuntime(2800);
    const t0 = Date.now();
    let err = null;
    let res = null;
    try {
      res = await rt2.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }
    const elapsedMs = Date.now() - t0;

    assert.equal(res, null, `${tag}: down durante lease ${statoLease} non deve chiudere`);
    assert.ok(elapsedMs < 15000, `${tag}: nessuna attesa 60000 ms su lease ${statoLease} (${elapsedMs}ms)`);
    assert.ok(err && err.status === 409, `${tag}: atteso 409`);
    assert.ok(
      err.data && err.data.prove && Array.isArray(err.data.prove.blocchi)
        && err.data.prove.blocchi.includes('LEASE_BLOCKS'),
      `${tag}: blocco LEASE_BLOCKS atteso nelle prove`,
    );
    assert.equal(
      err.fleetCode,
      'LEASE_BLOCKS',
      `${tag}: fleetCode atteso LEASE_BLOCKS per lease ${statoLease} come unico blocco (ricevuto ${err.fleetCode})`,
    );
    assert.equal(err.fleetPhase, 'teardown', `${tag}: phase teardown attesa`);
    assert.deepEqual(w.killCalls, [], `${tag}: nessun segnale host con lease attiva/grace`);
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', `${tag}: record intatto`);
    assert.equal(vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella }), 'held', `${tag}: claim intatta`);

    // /up bloccata finche lease/record restano attivi.
    let upErr = null;
    let upRes = null;
    try {
      upRes = await rt2.runtime.up(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      upErr = e;
    }
    assert.equal(upRes, null, `${tag}(/up): up bloccata durante lease ${statoLease}`);
    assert.ok(upErr && upErr.status === 409, `${tag}(/up): atteso 409 su up`);
    assert.equal(causes.codeOf('LEASE_BLOCKS'), 'LEASE_BLOCKS', `${tag}: causes.codeOf deve accettare LEASE_BLOCKS`);
  }

  await t.test('8.2(grace)', (t2) => eseguiSottocaso(t2, 'grace'));
  await t.test('8.2(live)', (t2) => eseguiSottocaso(t2, 'live'));

  // Sottocaso senza canale posseduto: supervisore e sessione chiusi e host
  // fermo attestato NON rendono la lease expired o none. La grace resta una
  // barriera indipendente, quindi il rifiuto e' quello normativo e non una
  // chiusura: provare morti host e supervisore non e' prova sulla lease.
  await t.test('8.2(senza-canale)', async (t2) => {
    const tag = '8.2(senza-canale)';
    const w = creaMondoLea(t2, { initialLeaseNow: 10000, budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    const sup = await w.attaccaSupervisore();
    sup.close();
    await w.terminaSupervisoreESessione();
    await untilNotLive(w.mgrRaw, w.cella);

    w.leaseClock.now = 25000; // graceDeadline 70000: restano 45000 ms
    const pre = w.mgrRaw.status(w.cella);
    assert.equal(pre.state, 'grace', `${tag}: prerequisito lease in grace`);
    const graceDeadline = Number.isFinite(pre.graceDeadline) ? pre.graceDeadline : 10000 + 60000;
    const remainingMs = graceDeadline - w.leaseClock.now;
    assert.ok(remainingMs > 0, `${tag}: prerequisito grace ancora attiva`);
    await w.runtime.shutdown();

    w.syntheticHost.alive = false;
    w.setVlScenario({ hostState: 'none', stopAction: 'stopped', afterAckState: 'none' });

    const rt2 = w.creaSecondoRuntime(2800);
    let err = null;
    let res = null;
    try {
      res = await rt2.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.equal(res, null, `${tag}: down con grace come unico blocco non deve chiudere`);
    assert.ok(err && err.status === 409, `${tag}: atteso 409`);
    assert.ok(
      err.data && err.data.prove && Array.isArray(err.data.prove.blocchi)
        && err.data.prove.blocchi.includes('LEASE_BLOCKS'),
      `${tag}: LEASE_BLOCKS atteso nelle prove`,
    );
    assert.equal(
      err.fleetCode,
      'LEASE_BLOCKS',
      `${tag}: fleetCode atteso LEASE_BLOCKS quando la grace e' l'unico blocco (ricevuto ${err.fleetCode})`,
    );
    assert.equal(
      err.data && err.data.graceRemainingMs,
      remainingMs,
      `${tag}: graceRemainingMs coerente con il clock del caso`,
    );
    assert.deepEqual(w.killCalls, [], `${tag}: zero segnali`);
    assert.deepEqual(w.revokeControlCalls, [], `${tag}: zero revokeControl`);
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', `${tag}: record conservato`);
    assert.equal(
      vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella }),
      'held',
      `${tag}: claim conservata`,
    );
  });
});

test('8.3 seconda down dopo scadenza grace completa resolved-dead senza riattivazione da proof scaduto e zero revoke pre-commit', async (t) => {
  const w = creaMondoLea(t, { initialLeaseNow: 10000, budgetMs: 2800 });
  await attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  const sup = await w.attaccaSupervisore({ captureProof: true });
  assert.ok(sup.proof, '8.3: proof acquisito dal supervisore');

  sup.close();
  await w.terminaSupervisoreESessione();
  await untilNotLive(w.mgrRaw, w.cella);
  w.leaseClock.now = 15000;
  await w.runtime.shutdown();

  // 1a down durante grace -> LEASE_BLOCKS, zero revokeControl pre-commit.
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

  // Dopo scadenza grace (75000 > 70000), un reconnect con proof scaduto/tardivo viene negato e non riattiva.
  w.leaseClock.now = 75000;
  assert.equal(w.mgrRaw.status(w.cella).state, 'expired', '8.3: lease deve risultare expired');
  if (sup.stablePath) {
    const tardy = await new Promise((resolve, reject) => {
      const s = net.connect(sup.stablePath, async () => {
        try {
          const msg = await sendJsonLine(s, { type: 'reconnect', cellId: w.cella, proof: sup.proof, generation: 0 });
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

  // 2a down post-grace con host che richiede SIGTERM -> chiude resolved-dead con zero revoke pre-commit.
  w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live' });
  w.setOnKillProcess((pid, sig) => {
    if (pid === HOST_PID && sig === 'SIGTERM') {
      w.syntheticHost.alive = false;
      w.setVlScenario({ hostState: 'none', afterAckState: 'none' });
    }
  });

  let err2 = null;
  let res2 = null;
  try {
    res2 = await rt2.runtime.down(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    err2 = e;
  }

  assert.equal(err2, null, `8.3(2a-down): seconda down post-grace deve completare resolved-dead (${err2 && err2.fleetCode})`);
  assert.equal(res2 && res2.ok, true, '8.3(2a-down): atteso ok:true');
  assert.equal(res2 && res2.outcome, 'resolved-dead', '8.3(2a-down): atteso outcome resolved-dead');
  assert.equal(res2 && res2.host && res2.host.outcome, 'host-stopped-attested', '8.3(2a-down): outcome attestato');
    assert.equal(res2 && res2.host && res2.host.method, 'term', '8.3(2a-down): metodo term osservato');
  assert.equal(
    w.revokeControlCalls.some((c) => c.recordPresent),
    false,
    '8.3(2a-down): zero revokeControl prima del commit del record',
  );
  assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'assente', '8.3(2a-down): record chiuso');
  assert.ok(
    ['none', 'released'].includes(vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella })),
    '8.3(2a-down): claim rilasciata',
  );
});

test('8.4 via attestata con supervisore e host fermi chiude direttamente senza attesa grace extra', async (t) => {
  const w = creaMondoLea(t, { initialLeaseNow: 10000, budgetMs: 2800 });
  await attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  const sup = await w.attaccaSupervisore();
  sup.close();
  await w.terminaSupervisoreESessione();
  await untilNotLive(w.mgrRaw, w.cella);
  w.leaseClock.now = 75000;
  assert.equal(w.mgrRaw.status(w.cella).state, 'expired', '8.4: prerequisito lease expired');
  await w.runtime.shutdown();

  w.syntheticHost.alive = false;
  w.setVlScenario({ hostState: 'none', stopAction: 'stopped', afterAckState: 'none' });

  const rt2 = w.creaSecondoRuntime(2800);
  const t0 = Date.now();
  let err = null;
  let res = null;
  try {
    res = await rt2.runtime.down(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    err = e;
  }
  const elapsedMs = Date.now() - t0;

  assert.equal(err, null, `8.4: via attestata con supervisore e host fermi deve chiudere senza errore (${err && err.fleetCode})`);
  assert.equal(res && res.ok, true, '8.4: atteso ok:true');
  assert.equal(res && res.outcome, 'resolved-dead', '8.4: atteso resolved-dead');
  assert.ok(
    res && ['host-already-stopped', 'host-stopped-clean'].includes(res.host),
    `8.4: atteso esito host fermo (ricevuto ${res && res.host})`,
  );
  assert.ok(elapsedMs < 15000, `8.4: nessuna attesa grace extra (${elapsedMs}ms)`);
  assert.deepEqual(w.killCalls, [], '8.4: zero segnali inutili con host gia fermo');
  assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'assente', '8.4: record rimosso con commit');
  assert.ok(
    ['none', 'released'].includes(vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella })),
    '8.4: claim rilasciata',
  );
});

test('8.5 graceRemainingMs intero 0..60000 in status, launchState ed error.data deriva dal solo clock lease ignorando monoNow divergente', async (t) => {
  const w = creaMondoLea(t, {
    initialLeaseNow: 10000,
    initialLeaseMono: 900000000,
    initialRuntimeMono: 500000000,
    customMono: true,
    budgetMs: 2800,
  });
  await attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  const sup = await w.attaccaSupervisore();

  // Stato live -> graceRemainingMs === null sia su mgr.status che su runtime.launchState.
  const stLive = w.mgr.status(w.cella);
  assert.equal(stLive.state, 'live', '8.5(live): lease atteso live');
  assert.strictEqual(
    stLive.graceRemainingMs,
    null,
    `8.5(live): status.graceRemainingMs atteso null quando live (ricevuto ${String(stLive.graceRemainingMs)})`,
  );
  const lsLive = await w.runtime.launchState(w.cella);
  assert.strictEqual(
    lsLive.graceRemainingMs,
    null,
    `8.5(live): launchState.graceRemainingMs atteso null quando live (ricevuto ${String(lsLive.graceRemainingMs)})`,
  );

  // Chiusura socket -> entra in grace con now=10000 => graceDeadline=70000.
  sup.close();
  await w.terminaSupervisoreESessione();
  await untilNotLive(w.mgrRaw, w.cella);

  w.leaseClock.now = 28000; // rimanenza = 42000
  w.leaseClock.mono = 999999000;
  w.runtimeMono.now = 777777000;
  await w.runtime.shutdown();

  const stGrace = w.mgr.status(w.cella);
  assert.equal(stGrace.state, 'grace');
  assert.strictEqual(stGrace.graceRemainingMs, 42000, '8.5(grace): status.graceRemainingMs deve valere 42000');

  // Cambiamenti di monoNow non devono alterare graceRemainingMs finche now del lease resta fermo.
  w.leaseClock.mono += 15000;
  w.runtimeMono.now += 15000;
  assert.strictEqual(w.mgr.status(w.cella).graceRemainingMs, 42000, '8.5(grace): monoNow divergente ignorato');

  const rt2 = w.creaSecondoRuntime(2800);
  const lsGrace = await rt2.runtime.launchState(w.cella);
  assert.strictEqual(lsGrace.graceRemainingMs, 42000, '8.5(grace): launchState.graceRemainingMs atteso 42000');

  let err = null;
  try {
    await rt2.runtime.down(w.cella);
  } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    err = e;
  }
  assert.ok(err && err.data, '8.5(down): error.data atteso');
  assert.strictEqual(err.data.graceRemainingMs, 42000, '8.5(down): error.data.graceRemainingMs atteso 42000');
  assert.ok(
    Number.isInteger(err.data.graceRemainingMs) && err.data.graceRemainingMs >= 0 && err.data.graceRemainingMs <= 60000,
    '8.5(down): graceRemainingMs deve stare in 0..60000',
  );

  // Scaduto noto (75000 > 70000) -> 0.
  w.leaseClock.now = 75000;
  assert.strictEqual(w.mgr.status(w.cella).graceRemainingMs, 0, '8.5(expired): status.graceRemainingMs atteso 0');
  const lsExp = await rt2.runtime.launchState(w.cella);
  assert.strictEqual(lsExp.graceRemainingMs, 0, '8.5(expired): launchState.graceRemainingMs atteso 0');
});

test('8.6 LEASE_BLOCKS promosso a fleetCode 409 teardown solo quando lease live o grace e unico blocco residuo in tutti i rientri down', async (t) => {
  // Parte A: rientro senza canale (downSerializzato).
  {
    const w = creaMondoLea(t, { initialLeaseNow: 10000, budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    const sup = await w.attaccaSupervisore();
    sup.close();
    await w.terminaSupervisoreESessione();
    await untilNotLive(w.mgrRaw, w.cella);
    w.leaseClock.now = 25000; // graceRemainingMs = 45000
    await w.runtime.shutdown();

    const rt2 = w.creaSecondoRuntime(2800);
    const ls = await rt2.runtime.launchState(w.cella);
    assert.deepEqual(ls.blockers, ['LEASE_BLOCKS'], '8.6(no-chan): unico blocco atteso LEASE_BLOCKS');

    let err = null;
    try {
      await rt2.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.ok(err && err.status === 409, '8.6(no-chan): status 409 atteso');
    assert.equal(
      err.fleetCode,
      'LEASE_BLOCKS',
      `8.6(no-chan): fleetCode atteso LEASE_BLOCKS (ricevuto ${err && err.fleetCode})`,
    );
    assert.equal(err.fleetPhase, 'teardown', '8.6(no-chan): fleetPhase teardown attesa');
    assert.strictEqual(err.data && err.data.graceRemainingMs, 45000, '8.6(no-chan): graceRemainingMs atteso in data');
    assert.deepEqual(err.data && err.data.prove && err.data.prove.blocchi, ['LEASE_BLOCKS'], '8.6(no-chan): prove.blocchi intatte');
  }

  // Parte B: rientro nella stessa down con canale posseduto perso al kill-session e grace unico blocco.
  {
    const w = creaMondoLea(t, { initialLeaseNow: 10000, budgetMs: 2800 });
    await attesaPgrpFiglio(w.paneChild.pid);
    await w.runtime.up(w.cella);
    await w.attaccaSupervisore();
    fs.writeFileSync(w.crashMarkerPath, '1');
    w.leaseClock.now = 25000;

    let err = null;
    try {
      await w.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.ok(err && err.status === 409, `8.6(recupero-stessa-down): atteso 409 LEASE_BLOCKS invece di ${err && err.status}/${err && err.fleetCode}`);
    assert.equal(err.fleetCode, 'LEASE_BLOCKS', '8.6(recupero-stessa-down): fleetCode LEASE_BLOCKS atteso');
    assert.equal(err.fleetPhase, 'teardown', '8.6(recupero-stessa-down): fleetPhase teardown attesa');
  }

  assert.equal(causes.codeOf('LEASE_BLOCKS'), 'LEASE_BLOCKS', '8.6: causes.codeOf(LEASE_BLOCKS)');
});

test('8.7 lease live, grace o illeggibile insieme a un altro blocco non promuove LEASE_BLOCKS o LEASE_UNREADABLE e conserva prove.blocchi', async (t) => {
  const w = creaMondoLea(t, { initialLeaseNow: 10000, budgetMs: 2800 });
  await attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  await w.runtime.shutdown();
  // Blocca il riaggancio -C mantenendo vivi supervisore e sessione cosi downSerializzato raggiunge valuta().
  fs.writeFileSync(path.join(w.root, 'tmux-dead'), '1');

  const rt2 = w.creaSecondoRuntime(2800);

  // Sottocaso A: grace + altro blocco (SUPERVISOR_ALIVE / SESSION_ALIVE).
  {
    w.setStatusOverride(() => ({ cellId: w.cella, state: 'grace', leaseId: 'lg-87', graceDeadline: 40000 }));
    let err = null;
    let res = null;
    try {
      res = await rt2.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }
    assert.equal(res, null, '8.7(grace+altro): down non deve chiudere');
    assert.ok(err && err.status === 409, '8.7(grace+altro): status 409 atteso');
    assert.equal(err.fleetCode, 'IDENTITY_UNVERIFIED', '8.7(grace+altro): non promuove LEASE_BLOCKS in presenza di altro blocco');
    assert.ok(Array.isArray(err.data && err.data.prove && err.data.prove.blocchi), '8.7(grace+altro): prove.blocchi presente');
    assert.ok(err.data.prove.blocchi.includes('LEASE_BLOCKS'), '8.7(grace+altro): LEASE_BLOCKS conservato in blocchi');
    assert.ok(err.data.prove.blocchi.includes('SUPERVISOR_ALIVE'), '8.7(grace+altro): SUPERVISOR_ALIVE conservato in blocchi');
    assert.equal(err.data.prove.proofs && err.data.prove.proofs.lease, 'grace', '8.7(grace+altro): proof lease grace intatta');
    assert.equal(err.data.prove.proofs && err.data.prove.proofs.supervisor, 'alive', '8.7(grace+altro): proof supervisor alive intatta');
  }

  // Sottocaso B: illeggibile + altro blocco.
  {
    w.setStatusOverride(() => { throw new Error('EIO stato lease'); });
    let err = null;
    let res = null;
    try {
      res = await rt2.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }
    assert.equal(res, null, '8.7(unreadable+altro): down non deve chiudere');
    assert.ok(err && err.status === 409, '8.7(unreadable+altro): status 409 atteso');
    assert.equal(err.fleetCode, 'IDENTITY_UNVERIFIED', '8.7(unreadable+altro): non promuove LEASE_UNREADABLE in presenza di altro blocco');
    assert.ok(Array.isArray(err.data && err.data.prove && err.data.prove.blocchi), '8.7(unreadable+altro): prove.blocchi presente');
    assert.ok(err.data.prove.blocchi.includes('LEASE_UNREADABLE'), '8.7(unreadable+altro): LEASE_UNREADABLE conservato in blocchi');
    assert.ok(err.data.prove.blocchi.includes('SUPERVISOR_ALIVE'), '8.7(unreadable+altro): SUPERVISOR_ALIVE conservato in blocchi');
    assert.equal(err.data.prove.proofs && err.data.prove.proofs.lease, 'unreadable', '8.7(unreadable+altro): proof lease unreadable intatta');
    assert.deepEqual(w.killCalls, [], '8.7: zero segnali host');
    assert.equal(launchTarget.leggi(w.filesRoot, w.sessione).stato, 'presente', '8.7: record intatto');
    assert.equal(vlRoots.osservaClaim({ home: w.home, root: w.vlRoot, ownerInstanceId: OWNER, cellId: w.cella }), 'held', '8.7: claim intatta');
  }
});

test('8.8a lease sconosciuto o status che lancia come unico blocco emette 409 LEASE_UNREADABLE in teardown con graceRemainingMs null e codeOf', async (t) => {
  const w = creaMondoLea(t, { budgetMs: 2800 });
  await attesaPgrpFiglio(w.paneChild.pid);
  await w.runtime.up(w.cella);
  await w.terminaSupervisoreESessione();
  await w.runtime.shutdown();

  const rt2 = w.creaSecondoRuntime(2800);

  // Stato lease sconosciuto ('strano') come unico blocco.
  {
    w.setStatusOverride(() => ({ cellId: w.cella, state: 'strano' }));
    let err = null;
    try {
      await rt2.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.ok(err && err.status === 409, '8.8a(strano): status 409 atteso');
    assert.equal(
      err.fleetCode,
      'LEASE_UNREADABLE',
      `8.8a(strano): fleetCode atteso LEASE_UNREADABLE (ricevuto ${err && err.fleetCode})`,
    );
    assert.equal(err.fleetPhase, 'teardown', '8.8a(strano): fleetPhase teardown attesa');
    assert.strictEqual(err.data && err.data.graceRemainingMs, null, '8.8a(strano): graceRemainingMs atteso null');
    assert.deepEqual(err.data && err.data.prove && err.data.prove.blocchi, ['LEASE_UNREADABLE']);
  }

  // status() che lancia eccezione come unico blocco.
  {
    w.setStatusOverride(() => { throw new Error('disk EIO'); });
    let err = null;
    try {
      await rt2.runtime.down(w.cella);
    } catch (e) {
      if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
      err = e;
    }

    assert.ok(err && err.status === 409, '8.8a(throws): status 409 atteso');
    assert.equal(err.fleetCode, 'LEASE_UNREADABLE', '8.8a(throws): fleetCode LEASE_UNREADABLE atteso');
    assert.equal(err.fleetPhase, 'teardown', '8.8a(throws): fleetPhase teardown attesa');
    assert.strictEqual(err.data && err.data.graceRemainingMs, null, '8.8a(throws): graceRemainingMs atteso null');
  }

  assert.equal(causes.CODES.includes('LEASE_UNREADABLE'), true, '8.8a: causes.CODES deve contenere LEASE_UNREADABLE');
  assert.equal(causes.codeOf('LEASE_UNREADABLE'), 'LEASE_UNREADABLE', '8.8a: causes.codeOf deve restituire LEASE_UNREADABLE');
});

test('8.8b messages for the lease causes are locale text on the interface path, without countdown on the unreadable cause', async () => {
  await verificaContrattoUi('8.8b');
});

