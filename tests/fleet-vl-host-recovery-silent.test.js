'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hostStopPath = require.resolve('../lib/fleet/vl-host-stop.js');
const hostStop = require(hostStopPath);
const { piano } = require('./helpers/phase-plan.js');

const OWNER = 'ab'.repeat(16);
const BOOT_ID = '12345678-1234-1234-1234-123456789abc';
const PID_NS = '4026531836';
const HOST_PID = 4242;
const COORD_PID = 99999;

function hexId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeHostIdentity(overrides = {}) {
  return {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId: OWNER,
    pid: HOST_PID,
    uid: process.getuid(),
    bootId: BOOT_ID,
    pidNamespaceInode: PID_NS,
    startTicks: '1234',
    pgid: HOST_PID,
    sid: HOST_PID,
    ...overrides,
  };
}

// A boundary that authorises host recovery travels with its explicit plan: the
// deadline is computed once here and the same value reaches the ctx and the
// plan, so the two cannot drift apart. Callers that keep the historical
// recovery-false adapter do not use this helper.
function pianoRecoveryDiretto(f, budgetMs = 8000) {
  const deadlineAt = f.monoNow() + budgetMs;
  return { deadlineAt, phasePlan: piano(budgetMs, deadlineAt) };
}

function computeContextDigest(record) {
  const h = record.hostIdentity;
  return sha256Hex(Buffer.from(JSON.stringify([
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
  ]), 'utf8'));
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

function creaFakeChild(code, stdoutObj, { onExec, delayMs = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killedSignals = [];
  child.kill = (sig) => {
    child.killedSignals.push(sig);
    return true;
  };
  const emitResult = () => {
    if (typeof onExec === 'function') onExec(child);
    if (stdoutObj != null) {
      const text = typeof stdoutObj === 'string' ? stdoutObj : `${JSON.stringify(stdoutObj)}\n`;
      child.stdout.emit('data', Buffer.from(text, 'utf8'));
    }
    child.emit('close', code);
  };
  if (delayMs > 0) {
    const timer = setTimeout(emitResult, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
  } else {
    setImmediate(emitResult);
  }
  return child;
}

function readRecoveryEvents(stateDir) {
  const dir = path.join(stateDir, 'recovery-events');
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir)
    .filter((n) => /^\d{8}-[a-z-]+\.json$/.test(n))
    .sort();
  return names.map((name) => {
    const full = path.join(dir, name);
    const raw = fs.readFileSync(full, 'utf8');
    return {
      name,
      path: full,
      stat: fs.lstatSync(full),
      raw,
      event: JSON.parse(raw),
    };
  });
}

function writeCanonicalRecoveryEvent(stateDir, event) {
  const dir = path.join(stateDir, 'recovery-events');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const seqStr = String(event.seq).padStart(8, '0');
  const file = path.join(dir, `${seqStr}-${event.kind}.json`);
  const ordered = {
    version: event.version ?? 1,
    launchId: event.launchId,
    attemptId: event.attemptId,
    seq: event.seq,
    kind: event.kind,
    contextDigest: event.contextDigest,
    ...(event.method !== undefined ? { method: event.method } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
  };
  fs.writeFileSync(file, `${JSON.stringify(ordered)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function creaFixtureSilent(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sil-'));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o755 });
  fs.chmodSync(home, 0o755);

  const cellId = opts.cellId || 'CellaSil';
  const ncDir = path.join(home, '.nexuscrew');
  const vlBase = path.join(ncDir, 'vl-instances', OWNER);
  const stateDir = path.join(vlBase, cellId);
  const serverRoot = path.join(ncDir, 'vl-roots', cellId);
  const xdgState = path.join(home, '.local', 'state');
  const xdgData = path.join(home, '.local', 'share');
  const xdgConfig = path.join(home, '.config');

  for (const d of [ncDir, path.join(ncDir, 'vl-instances'), vlBase, stateDir, serverRoot, xdgState, xdgData, xdgConfig]) {
    fs.mkdirSync(d, { recursive: true, mode: d === home ? 0o755 : 0o700 });
    if (d !== home) fs.chmodSync(d, 0o700);
  }

  const fakeVlSource = path.join(root, 'vl-source');
  fs.writeFileSync(fakeVlSource, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(fakeVlSource, 0o755);

  const pin = hostStop.pinBinario({ source: fakeVlSource, home, owner: OWNER, cellId });
  assert.equal(pin.ok, true);

  const hostId = makeHostIdentity(opts.hostIdentity);
  const record = {
    launchId: opts.launchId || hexId(8),
    vlBin: fakeVlSource,
    vlBinSha256: pin.sha256,
    XDG_STATE_HOME: xdgState,
    XDG_DATA_HOME: xdgData,
    XDG_CONFIG_HOME: xdgConfig,
    HOME: home,
    uid: process.getuid(),
    serverRoot,
    ts: 1000,
    version: 2,
    hostIdentity: hostId,
  };
  const contextPath = hostStop.scriviContesto(stateDir, record);

  t.after(() => {
    try { fs.chmodSync(stateDir, 0o700); } catch (_) {}
    try { fs.chmodSync(root, 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const signals = [];
  const observedPids = [];
  const spawnCalls = [];
  let hostAlive = opts.initialAlive !== undefined ? opts.initialAlive : true;
  let clock = 10000;

  const identitaNodo = () => ({ bootId: BOOT_ID, pidNamespaceInode: PID_NS });
  const identitaCoordinatore = () => ({ pid: COORD_PID, pgid: COORD_PID, sid: COORD_PID });

  const osservaPeer = (pid, instanceId) => {
    observedPids.push(pid);
    if (!hostAlive || pid !== hostId.pid) return null;
    return { ...hostId, instanceId };
  };

  const osservaKernel = (pid, instanceId) => {
    observedPids.push(pid);
    if (typeof opts.onOsservaKernel === 'function') {
      const override = opts.onOsservaKernel({ pid, instanceId, hostAlive, signals });
      if (override) return override;
    }
    if (hostAlive && pid === hostId.pid) {
      return {
        state: 'observed',
        processState: 'S',
        identity: { ...hostId, instanceId },
      };
    }
    return {
      state: 'absent',
      node: identitaNodo(),
    };
  };

  const killProcess = (pid, sig) => {
    signals.push({ pid, sig });
    if (typeof opts.onKillProcess === 'function') {
      return opts.onKillProcess({ pid, sig, setAlive: (v) => { hostAlive = v; } });
    }
    if (pid === hostId.pid && (sig === 'SIGTERM' || sig === 'SIGKILL')) {
      hostAlive = false;
    }
    return undefined;
  };

  const makeSpawnImpl = (responder) => (_bin, args, spawnOpts) => {
    spawnCalls.push({ args: [...args], env: spawnOpts && spawnOpts.env });
    return responder(args, spawnOpts);
  };

  return {
    root,
    home,
    cellId,
    stateDir,
    serverRoot,
    contextPath,
    bin: pin.path,
    record,
    contextDigest: computeContextDigest(record),
    signals,
    observedPids,
    spawnCalls,
    isAlive: () => hostAlive,
    setAlive: (v) => { hostAlive = v; },
    monoNow: () => clock,
    advanceClock: (ms) => { clock += ms; },
    attesaImpl: async (ms) => { clock += Math.max(1, ms); },
    identitaNodo,
    identitaCoordinatore,
    osservaPeer,
    osservaKernel,
    killProcess,
    makeSpawnImpl,
  };
}

test('2.1 controllo shutdown_ack con originale vivo dopo 250 ms e root lock non promuove mai host-stopped-clean', async (t) => {
  const f = creaFixtureSilent(t);
  let statusReads = 0;

  const spawnImpl = f.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      statusReads += 1;
      if (statusReads <= 2) {
        return creaFakeChild(0, statusPayload({
          state: 'live',
          declaredPid: HOST_PID,
          pidInUse: true,
          peerIdentity: makeVerifiedPeer(f.record.hostIdentity),
        }));
      }
      // Root in lock sia durante la vita dell originale sia dopo la sua scomparsa.
      if (statusReads >= 5) f.setAlive(false);
      return creaFakeChild(0, statusPayload({ state: 'lock', declaredPid: null, pidInUse: null }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(0, { ok: true, reason: 'shutdown_ack' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });

  const quali = await hostStop.qualificaIsolamentoHost({
    stateDir: f.stateDir,
    record: f.record,
    bin: f.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: f.monoNow,
    spawnImpl,
    osservaPeer: f.osservaPeer,
    identitaNodo: f.identitaNodo,
    identitaCoordinatore: f.identitaCoordinatore,
  });
  assert.equal(quali.isolamento, 'isolato');

  const res = await hostStop.fermaHost({
    stateDir: f.stateDir,
    record: f.record,
    bin: f.bin,
    budgetMs: quali.residuoMs,
    monoNow: f.monoNow,
    deadlineAt: f.monoNow() + 8000,
    attesaImpl: f.attesaImpl,
    spawnImpl,
    isolamento: quali.isolamento,
    probeIniziale: quali.probe,
    allowHostRecovery: false,
    // Synthetic PID: both seams are the fixture's, never the real defaults.
    osservaKernel: f.osservaKernel,
    killProcess: f.killProcess,
  });

  assert.notEqual(res.outcome, 'host-stopped-clean', '2.1 controllo: root lock post-ack non deve mai diventare clean');
  assert.equal(res.outcome, 'host-stop-failed');
  assert.equal(res.code, 'BARRIER');
  assert.equal(res.reason, 'shutdown_ack');
});

test('2.1 recovery dopo shutdown_ack: root lock resta fail-closed anche a originale morto; con uscita provata e none fresco chiude host-stopped-attested', async (t) => {
  // Parte A: root resta lock dopo morte originale -> fail-closed (mai clean ne attested).
  const fA = creaFixtureSilent(t);
  const spawnA = fA.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      if (fA.spawnCalls.filter((c) => c.args[0] === 'internal').length === 0) {
        return creaFakeChild(0, statusPayload({
          state: 'live',
          declaredPid: HOST_PID,
          pidInUse: true,
          peerIdentity: makeVerifiedPeer(fA.record.hostIdentity),
        }));
      }
      return creaFakeChild(0, statusPayload({ state: 'lock', declaredPid: null, pidInUse: null }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(0, { ok: true, reason: 'shutdown_ack' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });

  const qualiA = await hostStop.qualificaIsolamentoHost({
    stateDir: fA.stateDir,
    record: fA.record,
    bin: fA.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: fA.monoNow,
    spawnImpl: spawnA,
    osservaPeer: fA.osservaPeer,
    identitaNodo: fA.identitaNodo,
    identitaCoordinatore: fA.identitaCoordinatore,
  });
  const resA = await hostStop.fermaHost({
    stateDir: fA.stateDir,
    record: fA.record,
    bin: fA.bin,
    budgetMs: qualiA.residuoMs,
    monoNow: fA.monoNow,
    ...pianoRecoveryDiretto(fA),
    attesaImpl: fA.attesaImpl,
    spawnImpl: spawnA,
    isolamento: qualiA.isolamento,
    probeIniziale: qualiA.probe,
    allowHostRecovery: true,
    killProcess: fA.killProcess,
    osservaKernel: fA.osservaKernel,
    identitaNodo: fA.identitaNodo,
    identitaCoordinatore: fA.identitaCoordinatore,
    fsRecovery: fs,
  });
  // Closed family: a stop that cannot be attested answers with one of the two
  // failure outcomes the contract provides, so neither a success nor a free
  // string passes here.
  assert.ok(
    resA.outcome === 'host-stop-failed' || resA.outcome === 'host-unresolvable',
    `2.1 Parte A: senza root none l'esito resta nella famiglia di fallimento (ricevuto ${resA.outcome})`,
  );
  assert.ok(fA.signals.some((s) => s.pid === HOST_PID && s.sig === 'SIGTERM'), '2.1 Parte A: atteso ingresso recovery con TERM');

  // Parte B: originale morto dopo SIGTERM e root torna none -> host-stopped-attested con method: term.
  const fB = creaFixtureSilent(t);
  const spawnB = fB.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      if (fB.isAlive()) {
        const stopCount = fB.spawnCalls.filter((c) => c.args[0] === 'internal').length;
        if (stopCount === 0) {
          return creaFakeChild(0, statusPayload({
            state: 'live',
            declaredPid: HOST_PID,
            pidInUse: true,
            peerIdentity: makeVerifiedPeer(fB.record.hostIdentity),
          }));
        }
        return creaFakeChild(0, statusPayload({ state: 'lock', declaredPid: null, pidInUse: null }));
      }
      return creaFakeChild(0, statusPayload({ state: 'none', declaredPid: null, pidInUse: null }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(0, { ok: true, reason: 'shutdown_ack' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });

  const qualiB = await hostStop.qualificaIsolamentoHost({
    stateDir: fB.stateDir,
    record: fB.record,
    bin: fB.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: fB.monoNow,
    spawnImpl: spawnB,
    osservaPeer: fB.osservaPeer,
    identitaNodo: fB.identitaNodo,
    identitaCoordinatore: fB.identitaCoordinatore,
  });
  const resB = await hostStop.fermaHost({
    stateDir: fB.stateDir,
    record: fB.record,
    bin: fB.bin,
    budgetMs: qualiB.residuoMs,
    monoNow: fB.monoNow,
    ...pianoRecoveryDiretto(fB),
    attesaImpl: fB.attesaImpl,
    spawnImpl: spawnB,
    isolamento: qualiB.isolamento,
    probeIniziale: qualiB.probe,
    allowHostRecovery: true,
    killProcess: fB.killProcess,
    osservaKernel: fB.osservaKernel,
    identitaNodo: fB.identitaNodo,
    identitaCoordinatore: fB.identitaCoordinatore,
    fsRecovery: fs,
  });

  assert.equal(resB.outcome, 'host-stopped-attested', '2.1 Parte B: atteso host-stopped-attested dopo uscita+none');
  assert.equal(resB.method, 'term');
  assert.deepEqual(fB.signals, [{ pid: HOST_PID, sig: 'SIGTERM' }]);
  const kindsB = readRecoveryEvents(fB.stateDir).map((e) => e.event.kind);
  assert.ok(kindsB.includes('intent-term'));
  assert.ok(kindsB.includes('signaled-term'));
  assert.ok(kindsB.includes('exited'));
  assert.ok(kindsB.includes('closed'));
});

test('2.2 ingresso silent usa solo record.hostIdentity.pid ignorando declared_pid null o diverso', async (t) => {
  // Variante A: status in lock con declared_pid null -> recovery usa solo record.hostIdentity.pid.
  const fNull = creaFixtureSilent(t);
  const spawnNull = fNull.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      if (!fNull.isAlive()) {
        return creaFakeChild(0, statusPayload({ state: 'none', declaredPid: null, pidInUse: null }));
      }
      return creaFakeChild(0, statusPayload({ state: 'lock', declaredPid: null, pidInUse: null }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(1, { ok: false, reason: 'connect_error' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });

  const qualiNull = await hostStop.qualificaIsolamentoHost({
    stateDir: fNull.stateDir,
    record: fNull.record,
    bin: fNull.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: fNull.monoNow,
    spawnImpl: spawnNull,
    osservaPeer: fNull.osservaPeer,
    identitaNodo: fNull.identitaNodo,
    identitaCoordinatore: fNull.identitaCoordinatore,
  });

  const resNull = await hostStop.fermaHost({
    stateDir: fNull.stateDir,
    record: fNull.record,
    bin: fNull.bin,
    budgetMs: qualiNull.residuoMs,
    monoNow: fNull.monoNow,
    ...pianoRecoveryDiretto(fNull),
    attesaImpl: fNull.attesaImpl,
    spawnImpl: spawnNull,
    isolamento: qualiNull.isolamento,
    probeIniziale: qualiNull.probe,
    allowHostRecovery: true,
    killProcess: fNull.killProcess,
    osservaKernel: fNull.osservaKernel,
    identitaNodo: fNull.identitaNodo,
    identitaCoordinatore: fNull.identitaCoordinatore,
    fsRecovery: fs,
  });
  assert.equal(resNull.outcome, 'host-stopped-attested', '2.2: silent con declared_pid null deve usare record.hostIdentity.pid');
  assert.equal(resNull.method, 'term');
  assert.deepEqual(fNull.signals, [{ pid: HOST_PID, sig: 'SIGTERM' }]);

  // Variante B: status in lock con declared_pid estraneo (9876) -> mai osservato ne segnalato 9876.
  const FOREIGN_PID = 9876;
  const fOther = creaFixtureSilent(t);
  const spawnOther = fOther.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      if (!fOther.isAlive()) {
        return creaFakeChild(0, statusPayload({ state: 'none', declaredPid: null, pidInUse: null }));
      }
      return creaFakeChild(0, statusPayload({ state: 'lock', declaredPid: FOREIGN_PID, pidInUse: false }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(1, { ok: false, reason: 'connect_error' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });

  const qualiOther = await hostStop.qualificaIsolamentoHost({
    stateDir: fOther.stateDir,
    record: fOther.record,
    bin: fOther.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: fOther.monoNow,
    spawnImpl: spawnOther,
    osservaPeer: fOther.osservaPeer,
    identitaNodo: fOther.identitaNodo,
    identitaCoordinatore: fOther.identitaCoordinatore,
  });

  const resOther = await hostStop.fermaHost({
    stateDir: fOther.stateDir,
    record: fOther.record,
    bin: fOther.bin,
    budgetMs: qualiOther.residuoMs,
    monoNow: fOther.monoNow,
    ...pianoRecoveryDiretto(fOther),
    attesaImpl: fOther.attesaImpl,
    spawnImpl: spawnOther,
    isolamento: qualiOther.isolamento,
    probeIniziale: qualiOther.probe,
    allowHostRecovery: true,
    killProcess: fOther.killProcess,
    osservaKernel: fOther.osservaKernel,
    identitaNodo: fOther.identitaNodo,
    identitaCoordinatore: fOther.identitaCoordinatore,
    fsRecovery: fs,
  });

  assert.equal(resOther.outcome, 'host-stopped-attested');
  assert.equal(resOther.method, 'term');
  assert.deepEqual(fOther.signals, [{ pid: HOST_PID, sig: 'SIGTERM' }]);
  assert.equal(fOther.signals.some((s) => s.pid === FOREIGN_PID), false);
});

test('2.3 peer_mismatch su --expected restituisce HOST_PEER_MISMATCH, persiste cli-refusal e zero fallback CLI o TERM', async (t) => {
  const f = creaFixtureSilent(t);
  const spawnImpl = f.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      return creaFakeChild(0, statusPayload({
        state: 'live',
        declaredPid: HOST_PID,
        pidInUse: true,
        peerIdentity: makeVerifiedPeer(f.record.hostIdentity),
      }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      assert.ok(args.includes('--expected'));
      return creaFakeChild(1, { ok: false, reason: 'peer_mismatch' });
    }
    throw new Error(`nessun fallback ammesso: ${args.join(' ')}`);
  });

  const quali = await hostStop.qualificaIsolamentoHost({
    stateDir: f.stateDir,
    record: f.record,
    bin: f.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: f.monoNow,
    spawnImpl,
    osservaPeer: f.osservaPeer,
    identitaNodo: f.identitaNodo,
    identitaCoordinatore: f.identitaCoordinatore,
  });

  const res = await hostStop.fermaHost({
    stateDir: f.stateDir,
    record: f.record,
    bin: f.bin,
    budgetMs: quali.residuoMs,
    monoNow: f.monoNow,
    ...pianoRecoveryDiretto(f),
    attesaImpl: f.attesaImpl,
    spawnImpl,
    isolamento: quali.isolamento,
    probeIniziale: quali.probe,
    allowHostRecovery: true,
    killProcess: f.killProcess,
    osservaKernel: f.osservaKernel,
    identitaNodo: f.identitaNodo,
    identitaCoordinatore: f.identitaCoordinatore,
    fsRecovery: fs,
  });

  assert.equal(res.outcome, 'host-stop-failed');
  assert.equal(res.code, hostStop.ESITI_STOP_ATTESO.peer_mismatch);
  assert.equal(res.reason, 'peer_mismatch');
  assert.equal(f.signals.length, 0);
  assert.equal(f.spawnCalls.some((c) => c.args[0] === 'shutdown'), false);

  const events = readRecoveryEvents(f.stateDir);
  assert.equal(events.length, 2, '2.3: attesi cli-attempt + cli-refusal nello store');
  assert.equal(events[0].event.kind, 'cli-attempt');
  assert.equal(events[1].event.kind, 'cli-refusal');
  assert.equal(events[1].event.reason, 'peer_mismatch');
  assert.equal(events[1].event.contextDigest, f.contextDigest);
});

test('2.4 peer_unknown e expected_invalid restituiscono codici propri, persistono cli-refusal e zero segnali', async (t) => {
  for (const [reason, expectedCode] of [
    ['peer_unknown', hostStop.ESITI_STOP_ATTESO.peer_unknown],
    ['expected_invalid', hostStop.ESITI_STOP_ATTESO.expected_invalid],
  ]) {
    const f = creaFixtureSilent(t);
    const spawnImpl = f.makeSpawnImpl((args) => {
      if (args[0] === 'host' && args[1] === 'status') {
        return creaFakeChild(0, statusPayload({
          state: 'live',
          declaredPid: HOST_PID,
          pidInUse: true,
          peerIdentity: makeVerifiedPeer(f.record.hostIdentity),
        }));
      }
      if (args[0] === 'internal' && args[1] === 'host-stop') {
        return creaFakeChild(1, { ok: false, reason });
      }
      throw new Error(`fallback vietato (${reason}): ${args.join(' ')}`);
    });

    const quali = await hostStop.qualificaIsolamentoHost({
      stateDir: f.stateDir,
      record: f.record,
      bin: f.bin,
      instanceId: OWNER,
      budgetMs: 8000,
      monoNow: f.monoNow,
      spawnImpl,
      osservaPeer: f.osservaPeer,
      identitaNodo: f.identitaNodo,
      identitaCoordinatore: f.identitaCoordinatore,
    });
    const res = await hostStop.fermaHost({
      stateDir: f.stateDir,
      record: f.record,
      bin: f.bin,
      budgetMs: quali.residuoMs,
      monoNow: f.monoNow,
      ...pianoRecoveryDiretto(f),
      attesaImpl: f.attesaImpl,
      spawnImpl,
      isolamento: quali.isolamento,
      probeIniziale: quali.probe,
      allowHostRecovery: true,
      killProcess: f.killProcess,
      osservaKernel: f.osservaKernel,
      identitaNodo: f.identitaNodo,
      identitaCoordinatore: f.identitaCoordinatore,
      fsRecovery: fs,
    });

    assert.equal(res.outcome, 'host-stop-failed');
    assert.equal(res.code, expectedCode);
    assert.equal(res.reason, reason);
    assert.equal(f.signals.length, 0);

    const events = readRecoveryEvents(f.stateDir);
    assert.equal(events.length, 2, `2.4 (${reason}): attesi cli-attempt + cli-refusal persistiti`);
    assert.equal(events[0].event.kind, 'cli-attempt');
    assert.equal(events[1].event.kind, 'cli-refusal');
    assert.equal(events[1].event.reason, reason);
  }
});

test('2.5 retry dopo peer_mismatch senza nuova verifica positiva peer-verified resta bloccato con zero segnali', async (t) => {
  const f = creaFixtureSilent(t);

  // Passo 1: primo down riceve peer_mismatch.
  const spawn1 = f.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      return creaFakeChild(0, statusPayload({
        state: 'live',
        declaredPid: HOST_PID,
        pidInUse: true,
        peerIdentity: makeVerifiedPeer(f.record.hostIdentity),
      }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(1, { ok: false, reason: 'peer_mismatch' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });
  const quali1 = await hostStop.qualificaIsolamentoHost({
    stateDir: f.stateDir,
    record: f.record,
    bin: f.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: f.monoNow,
    spawnImpl: spawn1,
    osservaPeer: f.osservaPeer,
    identitaNodo: f.identitaNodo,
    identitaCoordinatore: f.identitaCoordinatore,
  });
  const res1 = await hostStop.fermaHost({
    stateDir: f.stateDir,
    record: f.record,
    bin: f.bin,
    budgetMs: quali1.residuoMs,
    monoNow: f.monoNow,
    ...pianoRecoveryDiretto(f),
    attesaImpl: f.attesaImpl,
    spawnImpl: spawn1,
    isolamento: quali1.isolamento,
    probeIniziale: quali1.probe,
    allowHostRecovery: true,
    killProcess: f.killProcess,
    osservaKernel: f.osservaKernel,
    identitaNodo: f.identitaNodo,
    identitaCoordinatore: f.identitaCoordinatore,
    fsRecovery: fs,
  });
  assert.equal(res1.outcome, 'host-stop-failed');
  assert.equal(res1.code, 'HOST_PEER_MISMATCH');

  const eventsAfter1 = readRecoveryEvents(f.stateDir);
  assert.ok(
    eventsAfter1.some((e) => e.event.kind === 'cli-refusal' && e.event.reason === 'peer_mismatch'),
    '2.5: cli-refusal peer_mismatch deve risultare nello store dopo il primo tentativo',
  );

  // Passo 2: retry socket-silent senza verifica positiva peer_identity -> bloccato, zero segnali.
  const spawn2 = f.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      return creaFakeChild(0, statusPayload({ state: 'lock', declaredPid: null, pidInUse: null }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(1, { ok: false, reason: 'connect_error' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });
  const quali2 = await hostStop.qualificaIsolamentoHost({
    stateDir: f.stateDir,
    record: f.record,
    bin: f.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: f.monoNow,
    spawnImpl: spawn2,
    osservaPeer: f.osservaPeer,
    identitaNodo: f.identitaNodo,
    identitaCoordinatore: f.identitaCoordinatore,
  });
  const res2 = await hostStop.fermaHost({
    stateDir: f.stateDir,
    record: f.record,
    bin: f.bin,
    budgetMs: quali2.residuoMs,
    monoNow: f.monoNow,
    ...pianoRecoveryDiretto(f),
    attesaImpl: f.attesaImpl,
    spawnImpl: spawn2,
    isolamento: quali2.isolamento,
    probeIniziale: quali2.probe,
    allowHostRecovery: true,
    killProcess: f.killProcess,
    osservaKernel: f.osservaKernel,
    identitaNodo: f.identitaNodo,
    identitaCoordinatore: f.identitaCoordinatore,
    fsRecovery: fs,
  });
  assert.equal(res2.outcome, 'host-stop-failed');
  assert.equal(f.signals.length, 0, '2.5: senza peer-verified non deve partire nessun segnale');

  // Passo 3: nuova prova positiva del peer originario su host status -> persiste peer-verified e sblocca.
  const spawn3 = f.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      if (!f.isAlive()) {
        return creaFakeChild(0, statusPayload({ state: 'none', declaredPid: null, pidInUse: null }));
      }
      return creaFakeChild(0, statusPayload({
        state: 'live',
        declaredPid: HOST_PID,
        pidInUse: true,
        peerIdentity: makeVerifiedPeer(f.record.hostIdentity),
      }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(1, { ok: false, reason: 'connect_error' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });
  const quali3 = await hostStop.qualificaIsolamentoHost({
    stateDir: f.stateDir,
    record: f.record,
    bin: f.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: f.monoNow,
    spawnImpl: spawn3,
    osservaPeer: f.osservaPeer,
    identitaNodo: f.identitaNodo,
    identitaCoordinatore: f.identitaCoordinatore,
  });
  const res3 = await hostStop.fermaHost({
    stateDir: f.stateDir,
    record: f.record,
    bin: f.bin,
    budgetMs: quali3.residuoMs,
    monoNow: f.monoNow,
    ...pianoRecoveryDiretto(f),
    attesaImpl: f.attesaImpl,
    spawnImpl: spawn3,
    isolamento: quali3.isolamento,
    probeIniziale: quali3.probe,
    allowHostRecovery: true,
    killProcess: f.killProcess,
    osservaKernel: f.osservaKernel,
    identitaNodo: f.identitaNodo,
    identitaCoordinatore: f.identitaCoordinatore,
    fsRecovery: fs,
  });
  assert.equal(res3.outcome, 'host-stopped-attested', '2.5: dopo peer-verified positivo recovery deve sbloccare');
  assert.ok(readRecoveryEvents(f.stateDir).some((e) => e.event.kind === 'peer-verified'));
});

test('2.6 cli-attempt pre-comando aperto senza esito per crash o fsync fallito blocca retry socket-silent salvo peer-verified', async (t) => {
  // Parte A: cli-attempt deve essere persistito PRIMA dello spawn CLI expected.
  const fA = creaFixtureSilent(t);
  let eventsDuringStopSpawn = null;
  const spawnA = fA.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      return creaFakeChild(0, statusPayload({
        state: 'live',
        declaredPid: HOST_PID,
        pidInUse: true,
        peerIdentity: makeVerifiedPeer(fA.record.hostIdentity),
      }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      eventsDuringStopSpawn = readRecoveryEvents(fA.stateDir).map((e) => e.event.kind);
      return creaFakeChild(1, { ok: false, reason: 'peer_mismatch' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });
  const qualiA = await hostStop.qualificaIsolamentoHost({
    stateDir: fA.stateDir,
    record: fA.record,
    bin: fA.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: fA.monoNow,
    spawnImpl: spawnA,
    osservaPeer: fA.osservaPeer,
    identitaNodo: fA.identitaNodo,
    identitaCoordinatore: fA.identitaCoordinatore,
  });
  await hostStop.fermaHost({
    stateDir: fA.stateDir,
    record: fA.record,
    bin: fA.bin,
    budgetMs: qualiA.residuoMs,
    monoNow: fA.monoNow,
    ...pianoRecoveryDiretto(fA),
    attesaImpl: fA.attesaImpl,
    spawnImpl: spawnA,
    isolamento: qualiA.isolamento,
    probeIniziale: qualiA.probe,
    allowHostRecovery: true,
    killProcess: fA.killProcess,
    osservaKernel: fA.osservaKernel,
    identitaNodo: fA.identitaNodo,
    identitaCoordinatore: fA.identitaCoordinatore,
    fsRecovery: fs,
  });
  assert.deepEqual(
    eventsDuringStopSpawn,
    ['cli-attempt'],
    '2.6: cli-attempt deve risultare persistito prima di invocare il CLI expected',
  );

  // Parte B: store con cli-attempt aperto preesistente blocca retry silent finche manca peer-verified.
  const fB = creaFixtureSilent(t);
  writeCanonicalRecoveryEvent(fB.stateDir, {
    version: 1,
    launchId: fB.record.launchId,
    attemptId: hexId(16),
    seq: 1,
    kind: 'cli-attempt',
    contextDigest: fB.contextDigest,
  });

  const spawnB = fB.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      return creaFakeChild(0, statusPayload({ state: 'lock', declaredPid: null, pidInUse: null }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(1, { ok: false, reason: 'connect_error' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });
  const qualiB = await hostStop.qualificaIsolamentoHost({
    stateDir: fB.stateDir,
    record: fB.record,
    bin: fB.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: fB.monoNow,
    spawnImpl: spawnB,
    osservaPeer: fB.osservaPeer,
    identitaNodo: fB.identitaNodo,
    identitaCoordinatore: fB.identitaCoordinatore,
  });
  const resB = await hostStop.fermaHost({
    stateDir: fB.stateDir,
    record: fB.record,
    bin: fB.bin,
    budgetMs: qualiB.residuoMs,
    monoNow: fB.monoNow,
    ...pianoRecoveryDiretto(fB),
    attesaImpl: fB.attesaImpl,
    spawnImpl: spawnB,
    isolamento: qualiB.isolamento,
    probeIniziale: qualiB.probe,
    allowHostRecovery: true,
    killProcess: fB.killProcess,
    osservaKernel: fB.osservaKernel,
    identitaNodo: fB.identitaNodo,
    identitaCoordinatore: fB.identitaCoordinatore,
    fsRecovery: fs,
  });
  assert.equal(resB.outcome, 'host-stop-failed');
  assert.equal(fB.signals.length, 0, '2.6: cli-attempt aperto deve bloccare ogni segnale silent');
});

test('2.7 fermaHost con allowHostRecovery:false rifiuta pre-CLI senza stateDir qualificata; con stateDir sintetica qualificata esegue CLI e persiste cli-attempt ed esito', async (t) => {
  // Sottocaso A1: stateDir assente -> rifiuto pre-CLI, zero spawn, zero segnali.
  const fMissing = creaFixtureSilent(t);
  const spawnMissing = fMissing.makeSpawnImpl(() => {
    throw new Error('2.7: CLI non doveva essere invocata senza stateDir');
  });
  const resMissing = await hostStop.fermaHost({
    stateDir: undefined,
    record: fMissing.record,
    bin: fMissing.bin,
    budgetMs: 8000,
    monoNow: fMissing.monoNow,
    deadlineAt: fMissing.monoNow() + 8000,
    attesaImpl: fMissing.attesaImpl,
    spawnImpl: spawnMissing,
    isolamento: 'isolato',
    probeIniziale: {
      r: { code: 0, stdout: `${JSON.stringify(statusPayload({ state: 'live', declaredPid: HOST_PID, pidInUse: true, peerIdentity: makeVerifiedPeer(fMissing.record.hostIdentity) }))}\n`, ucciso: false, troncato: false },
      stato: statusPayload({ state: 'live', declaredPid: HOST_PID, pidInUse: true, peerIdentity: makeVerifiedPeer(fMissing.record.hostIdentity) }),
    },
    allowHostRecovery: false,
    killProcess: fMissing.killProcess,
    osservaKernel: fMissing.osservaKernel,
    identitaNodo: fMissing.identitaNodo,
    identitaCoordinatore: fMissing.identitaCoordinatore,
    fsRecovery: fs,
  });
  assert.equal(resMissing.outcome, 'host-stop-failed');
  assert.equal(fMissing.spawnCalls.length, 0, '2.7: stateDir assente deve rifiutare prima del CLI');
  assert.equal(fMissing.signals.length, 0);

  // Sottocaso A2: stateDir non qualificata (mode 0o777) -> rifiuto pre-CLI.
  const fBadDir = creaFixtureSilent(t);
  fs.chmodSync(fBadDir.stateDir, 0o777);
  const resBadDir = await hostStop.fermaHost({
    stateDir: fBadDir.stateDir,
    record: fBadDir.record,
    bin: fBadDir.bin,
    budgetMs: 8000,
    monoNow: fBadDir.monoNow,
    deadlineAt: fBadDir.monoNow() + 8000,
    attesaImpl: fBadDir.attesaImpl,
    spawnImpl: fBadDir.makeSpawnImpl(() => {
      throw new Error('2.7: CLI non doveva essere invocata con stateDir non qualificata');
    }),
    isolamento: 'isolato',
    probeIniziale: {
      r: { code: 0, stdout: `${JSON.stringify(statusPayload({ state: 'live', declaredPid: HOST_PID, pidInUse: true, peerIdentity: makeVerifiedPeer(fBadDir.record.hostIdentity) }))}\n`, ucciso: false, troncato: false },
      stato: statusPayload({ state: 'live', declaredPid: HOST_PID, pidInUse: true, peerIdentity: makeVerifiedPeer(fBadDir.record.hostIdentity) }),
    },
    allowHostRecovery: false,
    killProcess: fBadDir.killProcess,
    osservaKernel: fBadDir.osservaKernel,
    identitaNodo: fBadDir.identitaNodo,
    identitaCoordinatore: fBadDir.identitaCoordinatore,
    fsRecovery: fs,
  });
  fs.chmodSync(fBadDir.stateDir, 0o700);
  assert.equal(resBadDir.outcome, 'host-stop-failed');
  assert.equal(fBadDir.spawnCalls.length, 0, '2.7: stateDir non qualificata (0777) deve rifiutare prima del CLI');
  assert.equal(fBadDir.signals.length, 0);

  // Sottocaso B: stateDir sintetica qualificata (0o700) con allowHostRecovery:false -> CLI + tracce persistite.
  const fOk = creaFixtureSilent(t);
  const spawnOk = fOk.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      if (!fOk.isAlive()) {
        return creaFakeChild(0, statusPayload({ state: 'none', declaredPid: null, pidInUse: null }));
      }
      return creaFakeChild(0, statusPayload({
        state: 'live',
        declaredPid: HOST_PID,
        pidInUse: true,
        peerIdentity: makeVerifiedPeer(fOk.record.hostIdentity),
      }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      fOk.setAlive(false);
      return creaFakeChild(0, { ok: true, reason: 'shutdown_ack' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });
  const qualiOk = await hostStop.qualificaIsolamentoHost({
    stateDir: fOk.stateDir,
    record: fOk.record,
    bin: fOk.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: fOk.monoNow,
    spawnImpl: spawnOk,
    osservaPeer: fOk.osservaPeer,
    identitaNodo: fOk.identitaNodo,
    identitaCoordinatore: fOk.identitaCoordinatore,
  });
  const resOk = await hostStop.fermaHost({
    stateDir: fOk.stateDir,
    record: fOk.record,
    bin: fOk.bin,
    budgetMs: qualiOk.residuoMs,
    monoNow: fOk.monoNow,
    deadlineAt: fOk.monoNow() + 8000,
    attesaImpl: fOk.attesaImpl,
    spawnImpl: spawnOk,
    isolamento: qualiOk.isolamento,
    probeIniziale: qualiOk.probe,
    allowHostRecovery: false,
    killProcess: fOk.killProcess,
    osservaKernel: fOk.osservaKernel,
    identitaNodo: fOk.identitaNodo,
    identitaCoordinatore: fOk.identitaCoordinatore,
    fsRecovery: fs,
  });
  assert.equal(resOk.outcome, 'host-stopped-clean');
  const eventsOk = readRecoveryEvents(fOk.stateDir);
  assert.ok(eventsOk.some((e) => e.event.kind === 'cli-attempt'), '2.7: atteso cli-attempt persistito anche con allowHostRecovery:false');
  assert.ok(eventsOk.some((e) => e.event.kind === 'cli-ack' && e.event.reason === 'shutdown_ack'));
});

test('2.8 peer_mismatch con allowHostRecovery:false persiste blocco che ferma retry con true; errore write/fsync conserva traccia incompleta bloccante e tupla intatta', async (t) => {
  // Parte A: peer_mismatch persistito con allowHostRecovery:false -> blocca successivo retry con allowHostRecovery:true.
  const fA = creaFixtureSilent(t);
  const spawnA1 = fA.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      return creaFakeChild(0, statusPayload({
        state: 'live',
        declaredPid: HOST_PID,
        pidInUse: true,
        peerIdentity: makeVerifiedPeer(fA.record.hostIdentity),
      }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(1, { ok: false, reason: 'peer_mismatch' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });
  const qualiA1 = await hostStop.qualificaIsolamentoHost({
    stateDir: fA.stateDir,
    record: fA.record,
    bin: fA.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: fA.monoNow,
    spawnImpl: spawnA1,
    osservaPeer: fA.osservaPeer,
    identitaNodo: fA.identitaNodo,
    identitaCoordinatore: fA.identitaCoordinatore,
  });
  const resA1 = await hostStop.fermaHost({
    stateDir: fA.stateDir,
    record: fA.record,
    bin: fA.bin,
    budgetMs: qualiA1.residuoMs,
    monoNow: fA.monoNow,
    deadlineAt: fA.monoNow() + 8000,
    attesaImpl: fA.attesaImpl,
    spawnImpl: spawnA1,
    isolamento: qualiA1.isolamento,
    probeIniziale: qualiA1.probe,
    allowHostRecovery: false,
    killProcess: fA.killProcess,
    osservaKernel: fA.osservaKernel,
    identitaNodo: fA.identitaNodo,
    identitaCoordinatore: fA.identitaCoordinatore,
    fsRecovery: fs,
  });
  assert.equal(resA1.outcome, 'host-stop-failed');
  assert.equal(resA1.code, 'HOST_PEER_MISMATCH');
  assert.deepEqual(
    readRecoveryEvents(fA.stateDir).map((e) => e.event.kind),
    ['cli-attempt', 'cli-refusal'],
    '2.8 Parte A: anche con allowHostRecovery:false peer_mismatch deve persistere cli-attempt + cli-refusal',
  );

  // Retry con allowHostRecovery:true e socket silente resta bloccato e traccia intatta.
  const spawnA2 = fA.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      return creaFakeChild(0, statusPayload({ state: 'lock', declaredPid: null, pidInUse: null }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(1, { ok: false, reason: 'connect_error' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });
  const qualiA2 = await hostStop.qualificaIsolamentoHost({
    stateDir: fA.stateDir,
    record: fA.record,
    bin: fA.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: fA.monoNow,
    spawnImpl: spawnA2,
    osservaPeer: fA.osservaPeer,
    identitaNodo: fA.identitaNodo,
    identitaCoordinatore: fA.identitaCoordinatore,
  });
  const resA2 = await hostStop.fermaHost({
    stateDir: fA.stateDir,
    record: fA.record,
    bin: fA.bin,
    budgetMs: qualiA2.residuoMs,
    monoNow: fA.monoNow,
    ...pianoRecoveryDiretto(fA),
    attesaImpl: fA.attesaImpl,
    spawnImpl: spawnA2,
    isolamento: qualiA2.isolamento,
    probeIniziale: qualiA2.probe,
    allowHostRecovery: true,
    killProcess: fA.killProcess,
    osservaKernel: fA.osservaKernel,
    identitaNodo: fA.identitaNodo,
    identitaCoordinatore: fA.identitaCoordinatore,
    fsRecovery: fs,
  });
  assert.equal(resA2.outcome, 'host-stop-failed');
  assert.equal(fA.signals.length, 0);
  assert.deepEqual(
    readRecoveryEvents(fA.stateDir).slice(0, 2).map((e) => e.event.kind),
    ['cli-attempt', 'cli-refusal'],
  );

  // Parte B: errore write/fsync sull esito post-CLI lascia traccia incompleta bloccante e tupla intatta.
  const fB = creaFixtureSilent(t);
  const contextBytesBefore = fs.readFileSync(fB.contextPath);
  const recoveryDirB = path.join(fB.stateDir, 'recovery-events');
  // Il guasto si aggancia all'EVENTO scritto e alla fase effettiva, non al
  // numero d'ordine degli fsync: due sincronizzazioni legittime dello stesso
  // intento sposterebbero un contatore. Si decodifica il frame scritto e si
  // guarda il suo kind; al momento del guasto si registra quante volte il CLI
  // era gia' stato invocato.
  const ESITI_CLI = new Set(['cli-ack', 'cli-refusal', 'cli-failed']);
  let iniezioneScattata = false;
  let hostStopCallsAlGuasto = null;
  const fdPaths = new Map();
  const fdBytes = new Map();
  const fdKinds = new Map();
  const faultyFs = {
    ...fs,
    openSync(p, ...rest) {
      const fd = fs.openSync(p, ...rest);
      fdPaths.set(fd, String(p));
      return fd;
    },
    closeSync(fd) {
      fdPaths.delete(fd);
      fdBytes.delete(fd);
      fdKinds.delete(fd);
      return fs.closeSync(fd);
    },
    writeSync(fd, data, ...rest) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      const prev = fdBytes.get(fd) || Buffer.alloc(0);
      const tot = Buffer.concat([prev, chunk]);
      fdBytes.set(fd, tot.length > 4096 ? tot.subarray(tot.length - 4096) : tot);
      const nl = (fdBytes.get(fd)).lastIndexOf(0x0a);
      if (nl >= 0) {
        try {
          const ev = JSON.parse(fdBytes.get(fd).subarray(0, nl).toString('utf8'));
          fdKinds.set(fd, ev && ev.kind);
        } catch (_) { /* scrittura non canonica: nessun kind */ }
      }
      return fs.writeSync(fd, data, ...rest);
    },
    fsyncSync(fd) {
      const targetPath = fdPaths.get(fd) || '';
      const kind = fdKinds.get(fd);
      if (targetPath.startsWith(recoveryDirB) && ESITI_CLI.has(kind)) {
        iniezioneScattata = true;
        hostStopCallsAlGuasto = hostStopCallsB1;
        const err = new Error(`EIO injected on ${kind} fsync`);
        err.code = 'EIO';
        throw err;
      }
      return fs.fsyncSync(fd);
    },
  };

  let hostStopCallsB1 = 0;
  const spawnB1 = fB.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      return creaFakeChild(0, statusPayload({
        state: 'live',
        declaredPid: HOST_PID,
        pidInUse: true,
        peerIdentity: makeVerifiedPeer(fB.record.hostIdentity),
      }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      hostStopCallsB1 += 1;
      return creaFakeChild(1, { ok: false, reason: 'connect_error' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });
  const qualiB1 = await hostStop.qualificaIsolamentoHost({
    stateDir: fB.stateDir,
    record: fB.record,
    bin: fB.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: fB.monoNow,
    spawnImpl: spawnB1,
    osservaPeer: fB.osservaPeer,
    identitaNodo: fB.identitaNodo,
    identitaCoordinatore: fB.identitaCoordinatore,
  });
  const resB1 = await hostStop.fermaHost({
    stateDir: fB.stateDir,
    record: fB.record,
    bin: fB.bin,
    budgetMs: qualiB1.residuoMs,
    monoNow: fB.monoNow,
    ...pianoRecoveryDiretto(fB),
    attesaImpl: fB.attesaImpl,
    spawnImpl: spawnB1,
    isolamento: qualiB1.isolamento,
    probeIniziale: qualiB1.probe,
    allowHostRecovery: true,
    killProcess: fB.killProcess,
    osservaKernel: fB.osservaKernel,
    identitaNodo: fB.identitaNodo,
    identitaCoordinatore: fB.identitaCoordinatore,
    fsRecovery: faultyFs,
  });
  assert.equal(resB1.outcome, 'host-stop-failed');
  assert.equal(fB.signals.length, 0);
  assert.equal(Buffer.compare(fs.readFileSync(fB.contextPath), contextBytesBefore), 0);
  // Il guasto deve essere davvero iniettato e deve cadere DOPO il CLI: senza
  // queste due prove l'esito bloccante potrebbe venire da un connect_error
  // ordinario e il caso resterebbe verde senza esercitare la durabilità.
  assert.equal(
    iniezioneScattata,
    true,
    '2.8 Parte B: l\'iniezione EIO deve cadere sul fsync dell\'evento di esito CLI, non su un numero d\'ordine',
  );
  assert.ok(
    Number.isInteger(hostStopCallsAlGuasto) && hostStopCallsAlGuasto >= 1,
    `2.8 Parte B: al momento del guasto il CLI host-stop doveva essere gia' stato eseguito (chiamate al guasto: ${hostStopCallsAlGuasto})`,
  );
  const eventsAfterB1 = readRecoveryEvents(fB.stateDir);
  const kindsAfterB1 = eventsAfterB1.map((e) => e.event.kind);
  assert.ok(kindsAfterB1.includes('cli-attempt'), '2.8 Parte B: cli-attempt conservato dopo errore fsync');
  assert.equal(
    kindsAfterB1.some((k) => ['cli-ack', 'cli-refusal', 'cli-failed'].includes(k)),
    false,
    `2.8 Parte B: il guasto deve cadere sulla persistenza dell'esito, non prima del CLI (kinds: ${kindsAfterB1.join(',')})`,
  );

  // Retry successivo resta bloccato e non cancella la traccia.
  const spawnB2 = fB.makeSpawnImpl((args) => {
    if (args[0] === 'host' && args[1] === 'status') {
      return creaFakeChild(0, statusPayload({ state: 'lock', declaredPid: null, pidInUse: null }));
    }
    if (args[0] === 'internal' && args[1] === 'host-stop') {
      return creaFakeChild(1, { ok: false, reason: 'connect_error' });
    }
    throw new Error(`comando imprevisto: ${args.join(' ')}`);
  });
  const qualiB2 = await hostStop.qualificaIsolamentoHost({
    stateDir: fB.stateDir,
    record: fB.record,
    bin: fB.bin,
    instanceId: OWNER,
    budgetMs: 8000,
    monoNow: fB.monoNow,
    spawnImpl: spawnB2,
    osservaPeer: fB.osservaPeer,
    identitaNodo: fB.identitaNodo,
    identitaCoordinatore: fB.identitaCoordinatore,
  });
  const resB2 = await hostStop.fermaHost({
    stateDir: fB.stateDir,
    record: fB.record,
    bin: fB.bin,
    budgetMs: qualiB2.residuoMs,
    monoNow: fB.monoNow,
    ...pianoRecoveryDiretto(fB),
    attesaImpl: fB.attesaImpl,
    spawnImpl: spawnB2,
    isolamento: qualiB2.isolamento,
    probeIniziale: qualiB2.probe,
    allowHostRecovery: true,
    killProcess: fB.killProcess,
    osservaKernel: fB.osservaKernel,
    identitaNodo: fB.identitaNodo,
    identitaCoordinatore: fB.identitaCoordinatore,
    fsRecovery: fs,
  });
  assert.equal(resB2.outcome, 'host-stop-failed');
  assert.equal(fB.signals.length, 0);
  assert.ok(readRecoveryEvents(fB.stateDir).some((e) => e.event.kind === 'cli-attempt'));
});
