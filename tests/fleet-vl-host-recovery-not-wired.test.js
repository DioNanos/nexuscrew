'use strict';
// Il recupero NON e' attivato: attraverso gli ingressi del runtime che toccano
// l'host (down e restart) la factory di recovery non viene mai creata, nessun
// segnale raggiunge il seam, nessun evento di recupero nasce su disco. La prova
// e' il cablaggio eseguito qui: per OGNI ingresso il binario finto registra le
// sue invocazioni e il test pretende che la fase host sia stata raggiunta.
// `shutdown` del runtime e' disarmo e chiusura, non uno stop dell'host: il test
// lo dichiara e verifica che non invochi il binario. Il controllo sul testo del
// sorgente e' solo un complemento.

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
const gruppo = require('../lib/fleet/group-stop.js');
const vlRoots = require('../lib/fleet/vl-roots.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const recovery = require('../lib/fleet/vl-host-recovery.js');

const OWNER = 'b2'.repeat(16);
// Il peer finto e' un processo REALE del mondo: il pid si decide alla nascita
// del dummy e lo si scrive qui prima di generare il binario finto.
let HOST_PID = 51515;
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

function hexId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

// Ogni directory `recovery-events` sotto la home del mondo, con le sue voci.
function eventiRecovery(home) {
  const voci = [];
  const visita = (dir, profondita) => {
    if (profondita > 8) return;
    let lista = [];
    try { lista = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const v of lista) {
      const p = path.join(dir, v.name);
      if (!v.isDirectory()) continue;
      if (v.name === 'recovery-events') {
        try { voci.push(...fs.readdirSync(p).map((n) => path.join(p, n))); } catch (_) { /* vuota */ }
        continue;
      }
      visita(p, profondita + 1);
    }
  };
  visita(home, 0);
  return voci;
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

function createFakeVlScript(vlBin, { vlRoot, scenarioPath, uid, bootId, nsInode, startTicks, vllog }) {
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const CAPS = ['host_stop_v1', 'host_peer_identity_v1', 'host_stop_expected_v1'];
const LOG = ${JSON.stringify(vllog || '/dev/null')};
const nota = (c) => { try { fs.appendFileSync(LOG, c + '\\n'); } catch (_) {} };
nota('argv ' + args.join(' '));
const readScen = () => {
  try { return JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf8')); }
  catch (_) { return { hostState: 'live', stopAction: 'ack' }; }
};
if (args[0] === 'host' && args[1] === 'status') {
  nota('status');
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
  nota('stop-internal');
  const sc = readScen();
  if (sc.stopAction === 'timeout') {
    process.stdout.write(JSON.stringify({ ok: false, reason: sc.stopFailReason || 'timeout' }) + '\\n');
    process.exit(1);
  }
  if (sc.stopAction === 'refuse') {
    process.stdout.write(JSON.stringify({ ok: false, reason: sc.stopFailReason || 'peer_mismatch' }) + '\\n');
    process.exit(1);
  }
  if (sc.afterAckState) {
    sc.ackSeen = true;
    fs.writeFileSync(${JSON.stringify(scenarioPath)}, JSON.stringify(sc));
  }
  process.stdout.write(JSON.stringify({ ok: true, reason: 'shutdown_ack' }) + '\\n');
  process.exit(0);
}
if (args[0] === 'shutdown') {
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

function creaMondo(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nowire-'));
  fs.chmodSync(root, 0o755);
  const home = path.join(root, 'home');
  const cella = opts.cella || 'CellaNoWire';
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

  // Due processi dummy REALI e cooperativi: escono da soli quando il test
  // scrive il loro marcatore, e comunque dopo un tetto di tempo. Nessun
  // segnale, nemmeno nel cleanup.
  const serverDone = path.join(root, 'server-done');
  const paneDone = path.join(root, 'pane-done');
  const dummy = (marcatore, ttlMs) => spawn(process.execPath, ['-e',
    `const fs = require('node:fs'); const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(marcatore)})) { clearInterval(t); process.exit(0); } }, 10); setTimeout(() => process.exit(0), ${ttlMs}).unref();`],
    { detached: true, stdio: 'ignore' });
  const serverProc = dummy(serverDone, 30000);
  serverProc.unref();
  // Il peer registrato E' questo processo: cosi' la prova d'uscita dopo l'ack
  // non puo' riuscire (il pid e' vivo) e la down conserva il lancio, il che
  // permette anche al restart di tornare alla fase host.
  HOST_PID = serverProc.pid;
  const paneChild = dummy(paneDone, 30000);
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
  const vlLog = path.join(root, 'vl-calls.log');
  fs.writeFileSync(vlLog, '');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  createFakeVlScript(vlBin, {
    vlRoot,
    scenarioPath,
    uid: UID,
    bootId: REAL_BOOT_ID,
    nsInode: REAL_NS_INODE,
    startTicks: '4321',
    vllog: vlLog,
  });

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'vl.native', label: 'VL', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' } }],
    cells: [{ id: cella, tmuxSession: sessione, cwd, engine: 'vl.native', boot: false }],
  });

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

  const cleanupFns = [];
  let lastPayload = null;

  function makeRuntimeInstance() {
    const mgr = createLeaseManager({ home, log: () => {} });
    cleanupFns.push(() => { try { mgr.close(); } catch (_) {} });
    const runtime = createBuiltinRuntime({
      cfg: {
        launchReadyMs: 0,
        filesRoot,
        activityHooks: false,
        vlLaunchCooldownMs: 0,
        groupStopBudgetMs: opts.budgetMs || 2800,
        log: () => {},
        env: {},
        // I seam che il runtime conosce: l'osservazione del peer per la
        // qualifica e il doppio registrante dei segnali. Nessuno dei due
        // deve essere raggiunto dal recupero, che qui non esiste.
        vlIsolationSeams: {
          identitaNodo: () => ({ bootId: REAL_BOOT_ID, pidNamespaceInode: REAL_NS_INODE }),
          identitaCoordinatore: () => ({ pgid: COORD_PID, sid: COORD_PID }),
          osservaPeer: (pid, instanceId) => (pid === HOST_PID
            ? { ...hostIdReal, instanceId: instanceId || OWNER }
            : null),
          killProcess: (pid, sig) => {
            killCalls.push({ pid, sig });
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
          lastPayload = req;
          return { socketPath: path.join(root, 'broker.sock'), nonce: 'c'.repeat(64) };
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
    try { fs.writeFileSync(paneDone, 'done'); } catch (_) {}
    try { fs.writeFileSync(serverDone, 'done'); } catch (_) {}
    try { fs.chmodSync(path.dirname(vlRoot), 0o700); } catch (_) {}
    try { fs.chmodSync(vlRoot, 0o700); } catch (_) {}
    try { fs.chmodSync(root, 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Il supervisore della cella, agganciato come nel 6.1b dei barriers: senza,
  // la down si ferma nella preparazione senza segnali e la fase host non viene
  // mai raggiunta. Serve qui perche' il test deve PROVARE di essere arrivato
  // alla fase host prima di dire che non ha attivato niente.
  async function attaccaSupervisore() {
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
    assert.equal(primary.mgr.attachInitial(cella, serverSide, { generation: 0 }), true);

    let morto = false;
    const coord = gruppo.creaCoordinatore({
      token: payloadCtl.token,
      launchId: payloadCtl.launchId,
      monoNow: () => Number(process.hrtime.bigint() / 1000000n),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      killGruppo: (sig) => {
        if (sig !== 'SIGTERM' || morto) return;
        morto = true;
        try { fs.writeFileSync(paneDone, 'done'); } catch (_) {}
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
    return { coord, leaseCtl, close };
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
    killCalls,
    mgr: primary.mgr,
    runtime: primary.runtime,
    attaccaSupervisore,
    vlLog,
    setVlScenario: (patch) => {
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')); } catch (_) {}
      fs.writeFileSync(scenarioPath, JSON.stringify({ ...cur, ...patch }));
    },
  };
}

function contaFactory(contatore) {
  const originale = recovery.createHostRecovery;
  recovery.createHostRecovery = (...a) => {
    contatore.create += 1;
    return originale(...a);
  };
  return () => { recovery.createHostRecovery = originale; };
}

// Le invocazioni registrate dal binario finto, nell'ordine: la prova che una
// fase host e' stata davvero eseguita.
function invocazioni(w) {
  return fs.readFileSync(w.vlLog, 'utf8').split('\n')
    .filter((riga) => riga === 'status' || riga === 'stop-internal');
}

test('down e restart non creano la factory, non segnalano, non scrivono giornali; shutdown non e uno stop host', async (t) => {
  const contatore = { create: 0 };
  const ripristina = contaFactory(contatore);
  t.after(() => ripristina());
  const creati = { down: 0, restart: 0, shutdown: 0 };

  const w = creaMondo(t, { budgetMs: 2800 });
  await attesaPgrpFiglio(w.paneChild.pid);

  const up = await w.runtime.up(w.cella);
  assert.equal(up && up.ok, true, 'il lancio riesce nel mondo sintetico');
  await w.attaccaSupervisore();

  // Il peer del record e' vivo nel kernel e risponde ack, ma lo status dopo
  // dichiara none: la prova d'uscita non puo' riuscire, la down rifiuta e
  // conserva il lancio. E' la condizione perche' anche il restart arrivi alla
  // fase host.
  w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'none' });

  // (1) down — conteggi PRIMA/DOPO, non un totale cumulato.
  const primaDown = invocazioni(w);
  const c0 = contatore.create;
  let erroreDown = null;
  try { await w.runtime.down(w.cella); } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    erroreDown = e; // un rifiuto qualificato e ammesso: qui si prova altro
  }
  const dopoDown = invocazioni(w);
  const deltaDown = dopoDown.slice(primaDown.length);
  creati.down = contatore.create - c0;
  assert.ok(deltaDown.includes('status'), 'down: la fase host e stata raggiunta (status del binario)');
  assert.ok(deltaDown.includes('stop-internal'), 'down: lo stop interno e partito');

  // (2) restart — il peer torna vivo: il probe dice live, la qualifica isola,
  // lo stop parte di nuovo e l'ack non e' seguito da none. La fase host e'
  // esercitata in proprio e la si conta in proprio.
  w.setVlScenario({ hostState: 'live', stopAction: 'ack', afterAckState: 'live' });
  const c1 = contatore.create;
  let erroreRestart = null;
  try { await w.runtime.restart(w.cella); } catch (e) {
    if (!e || (typeof e.fleetCode !== 'string' && !Number.isInteger(e.status))) throw e;
    erroreRestart = e;
  }
  const dopoRestart = invocazioni(w);
  const deltaRestart = dopoRestart.slice(dopoDown.length);
  creati.restart = contatore.create - c1;
  assert.ok(deltaRestart.includes('status'), 'restart: la fase host e stata raggiunta (status del binario)');
  assert.ok(deltaRestart.includes('stop-internal'), 'restart: lo stop interno e partito');

  // (3) shutdown — disarmo e chiusura del runtime, NON uno stop dell'host: il
  // binario VL non viene invocato affatto.
  const c2 = contatore.create;
  let erroreShutdown = null;
  try { await w.runtime.shutdown(); } catch (e) {
    erroreShutdown = e;
  }
  const deltaShutdown = invocazioni(w).slice(dopoRestart.length);
  creati.shutdown = contatore.create - c2;
  assert.equal(erroreShutdown, null, 'lo shutdown del runtime non deve lanciare');
  assert.deepEqual(deltaShutdown, [], 'shutdown: non e uno stop host, il binario non viene invocato');

  // Per OGNI ingresso, la fabrica di recupero non viene creata.
  assert.deepEqual(creati, { down: 0, restart: 0, shutdown: 0 },
    'nessun ingresso crea la factory di recupero');
  assert.deepEqual(w.killCalls, [], 'nessun segnale raggiunge il seam dei segnali');
  assert.deepEqual(eventiRecovery(w.home), [], 'nessun evento di recupero esiste su disco');
  assert.equal(fs.existsSync(path.join(w.cellBase, 'recovery-events')), false, 'la cartella del giornale non nasce');
});

test('controllo strutturale (complemento): il sorgente non richiede ne chiama il recupero', () => {
  const hs = fs.readFileSync(path.join(__dirname, '../lib/fleet/vl-host-stop.js'), 'utf8');
  const r = fs.readFileSync(path.join(__dirname, '../lib/fleet/runtime.js'), 'utf8');
  assert.ok(!/require\(\s*['"]\.\/vl-host-recovery(\.js)?['"]\s*\)/.test(hs), 'HS non richiede il modulo di recupero');
  assert.ok(!hs.includes('.recover('), 'HS non chiama recover');
  assert.ok(!hs.includes('createHostRecovery'), 'HS non crea la factory');
  assert.ok(!r.includes('allowHostRecovery'), 'il runtime non inoltra il consenso al recupero');
  assert.ok(!r.includes('killProcess'), 'il runtime non inoltra il seam dei segnali');
});
