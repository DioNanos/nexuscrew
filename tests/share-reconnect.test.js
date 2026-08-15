'use strict';
// tests/share-reconnect.test.js — P0 Share/reconnect: il supervisor non muore
// piu' dopo ripetuti fallimenti reverse-forward. Resta "degraded", continua con
// retry fisso e recupera automaticamente quando il canale inverso torna libero,
// senza richiedere OFF/ON manuale.
//
// Tutti i test usano un fake ssh (mai ssh/porte/runtime reali). Una porta di
// forward locale e' sostenuta da un net.createServer effimero solo per consentire
// al probe -L del supervisor di concludersi: non apre connessioni verso l'esterno.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tunnel = require('../lib/nodes/tunnel.js');
const pidf = require('../lib/cli/pidfile.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-share-'));
const SUPERVISOR = path.join(__dirname, '..', 'lib', 'nodes', 'tunnel-supervisor.js');

const NODE = {
  name: 'hub', ssh: 'user@example.com',
  remotePort: 41820, localPort: 43001,
  keyPath: '/home/user/.nexuscrew/keys/host_ed25519',
};

// Costruisce un fake ssh che fallisce con un messaggio di reverse-forward finche'
// il file `failFlag` esiste, poi resta stabile (successo). Registra ogni tentativo.
function writeFailThenStableFake({ dir, failFlag, attemptsPath, stderrLine }) {
  const fakeSsh = path.join(dir, 'fake-ssh.js');
  const script = [
    "'use strict';",
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(attemptsPath)}, 'attempt\\n');`,
    `if (fs.existsSync(${JSON.stringify(failFlag)})) {`,
    `  process.stderr.write(${JSON.stringify(stderrLine)} + '\\n');`,
    '  process.exit(255);',
    '}',
    "setInterval(() => {}, 1000);",
    '',
  ].join('\n');
  fs.writeFileSync(fakeSsh, script, { mode: 0o700 });
  return fakeSsh;
}

// Fake ssh che fallisce per sempre (listener permanentemente occupato / policy).
function writeAlwaysFailingFake({ dir, attemptsPath, stderrLine }) {
  const failFlag = path.join(dir, 'always-failing');
  fs.writeFileSync(failFlag, '1');
  return {
    fakeSsh: writeFailThenStableFake({ dir, failFlag, attemptsPath, stderrLine }),
    failFlag,
  };
}

// Avvia il supervisor con gli env di test. forwardPort deve essere una porta
// sostenuta da un net.createServer del test (probe -L).
function startSupervisor({ dir, name, fakeSsh, forwardPort, reversePort = 44001, runId, envExtra = {} }) {
  const statePath = tunnel.tunnelStatePath(dir, name);
  const pidPath = tunnel.tunnelPidPath(dir, name);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const args = [
    '-N',
    '-L', `127.0.0.1:${forwardPort}:127.0.0.1:41820`,
    '-R', `127.0.0.1:${reversePort}:127.0.0.1:41820`,
    'hub',
  ];
  const child = spawn(process.execPath, [SUPERVISOR, process.execPath, fakeSsh, ...args], {
    env: {
      ...process.env,
      NEXUSCREW_TUNNEL_STATE: statePath,
      NEXUSCREW_TUNNEL_PIDFILE: pidPath,
      NEXUSCREW_TUNNEL_RUN_ID: runId,
      NEXUSCREW_TUNNEL_STABLE_MS: '100',
      NEXUSCREW_TUNNEL_REVERSE_FAILURE_MAX: '3',
      NEXUSCREW_TUNNEL_TEST_MODE: '1',
      NEXUSCREW_TUNNEL_STEADY_RETRY_MS: '60',
      ...envExtra,
    },
    stdio: 'ignore',
  });
  pidf.writePidfile(pidPath, child.pid, `${process.execPath} ${SUPERVISOR}`, { runId });
  return { child, statePath, pidPath };
}

function readState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { return null; }
}

// Il limite serve solo a non appendere il test all'infinito: NESSUNA asserzione
// di questo file dipende da quanto IN FRETTA il supervisore entra in uno stato,
// solo dal fatto che ci entri. Sei secondi su una macchina con la flotta attiva
// (load 10-12) non proteggevano niente e producevano rossi casuali — misurato:
// tre giri isolati su develop puro davano 3 fail, 0, 2. Un test del gate che
// cade a caso e' peggio di un test assente, perche' insegna a ignorare i rossi.
// Alzarlo qui NON cura un sintomo: il criterio era gia' l'attesa dell'evento,
// era il limite a essere tarato su una macchina scarica.
async function waitForState(statePath, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    const s = readState(statePath);
    if (s) { seen.push(s.status); if (predicate(s)) return { ok: true, state: s, seen }; }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return { ok: false, state: readState(statePath), seen };
}

async function stopSupervisor(child) {
  try { child.kill('SIGTERM'); } catch (_) {}
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

// --- T1: il caso centrale del P0 -------------------------------------------
// Ogni tentativo di un mobile che si riconnette fallisce con "remote port
// forwarding failed" finche' il listener precedente sul hub non rilascia la
// porta. Oggi, superato il budget, il supervisor MUORE (down terminale): serve
// OFF/ON. Dopo il fix resta "degraded" e, quando il canale si libera, recupera
// da solo promuovendo transport-ready (probe -L) senza alcuna interazione UI.
test('reverse-forward failure ripetuta NON e terminale: resta degraded e recupera al successo senza OFF/ON', async () => {
  const dir = tmpDir();
  // forwardPort resta SENZA server durante il failing: come in produzione, ssh
  // esce per ExitOnForwardFailure e nessun forward -L e attivo, quindi il probe
  // -L deve essere rifiutato. Il server reale viene alzato solo quando il canale
  // si libera, per consentire al probe di promuovere transport-ready.
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const forwardPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const failFlag = path.join(dir, 'still-failing');
  fs.writeFileSync(failFlag, '1');
  const attemptsPath = path.join(dir, 'attempts.log');
  const fakeSsh = writeFailThenStableFake({
    dir, failFlag, attemptsPath,
    stderrLine: 'remote port forwarding failed for listen port 44001',
  });
  const { child, statePath } = startSupervisor({
    dir, name: 'hub', fakeSsh, forwardPort, reversePort: 44001, runId: 'recover-generation',
  });
  let forward = null;
  try {
    // Prima fase: almeno 3 fallimenti -> il supervisor entra in degraded (non muore).
    const degraded = await waitForState(statePath, (s) => s.status === 'degraded', 20000);
    assert.equal(degraded.ok, true, `il supervisor deve entrare in degraded, seen=${degraded.seen && degraded.seen.join(',')}`);
    assert.equal(degraded.state.terminal, false, 'degraded non e terminale');
    assert.equal(degraded.state.code, 'reverse-forward-failed');
    assert.equal(child.exitCode, null, 'il supervisor e VIVO (non e uscito)');

    // Seconda fase: il listener sul hub si libera -> al prossimo tentativo il
    // reverse ha successo e il probe -L promuove transport-ready. Nessun OFF/ON.
    fs.unlinkSync(failFlag);
    forward = net.createServer((socket) => socket.end());
    await new Promise((resolve) => forward.listen(forwardPort, '127.0.0.1', resolve));
    const ready = await waitForState(statePath, (s) => s.status === 'transport-ready', 6000);
    assert.equal(ready.ok, true, `deve recuperare fino a transport-ready, seen=${ready.seen && ready.seen.join(',')}`);
    assert.equal(child.exitCode, null, 'il supervisor e ancora VIVO dopo il recupero');
    assert.equal(ready.state.attempt, 0, 'il backoff e stato resettato al successo');
  } finally {
    await stopSupervisor(child);
    if (forward) await new Promise((resolve) => forward.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- helpers aggiuntivi -----------------------------------------------------

async function reservePort() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

// --- T2: reverse-forward-bind (porta gia occupata sul hub) ------------------
test('reverse-forward-bind resta degraded con la classe corretta e NON muore', async () => {
  const dir = tmpDir();
  const forwardPort = await reservePort();
  const { fakeSsh } = writeAlwaysFailingFake({
    dir, attemptsPath: path.join(dir, 'bind.log'),
    stderrLine: 'remote port forwarding failed: bind 127.0.0.1:44001: Address already in use',
  });
  const { child, statePath } = startSupervisor({
    dir, name: 'hub', fakeSsh, forwardPort, reversePort: 44001, runId: 'bind-generation',
  });
  try {
    const degraded = await waitForState(statePath, (s) => s.status === 'degraded', 20000);
    assert.equal(degraded.ok, true, `seen=${degraded.seen && degraded.seen.join(',')}`);
    assert.equal(degraded.state.code, 'reverse-forward-bind');
    assert.equal(degraded.state.reversePort, 44001);
    assert.equal(degraded.state.ownership, 'unknown', 'il listener sul hub non e attribuibile senza privilegi');
    assert.equal(degraded.state.terminal, false);
    // resta vivo a lungo: nessun exit terminale
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(child.exitCode, null, 'il supervisor NON esce per bind occupato');
  } finally {
    await stopSupervisor(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- T3: reverse-forward-failed persistente (distinto dal recover di T1) ----
test('reverse-forward-failed persistente resta degraded con classe reverse-forward-failed (non terminale)', async () => {
  const dir = tmpDir();
  const forwardPort = await reservePort();
  const { fakeSsh } = writeAlwaysFailingFake({
    dir, attemptsPath: path.join(dir, 'failed.log'),
    stderrLine: 'remote port forwarding failed for listen port 44001',
  });
  const { child, statePath } = startSupervisor({
    dir, name: 'hub', fakeSsh, forwardPort, reversePort: 44001, runId: 'failed-generation',
  });
  try {
    const degraded = await waitForState(statePath, (s) => s.status === 'degraded', 20000);
    assert.equal(degraded.ok, true, `seen=${degraded.seen && degraded.seen.join(',')}`);
    assert.equal(degraded.state.code, 'reverse-forward-failed');
    assert.equal(degraded.state.reversePort, 44001);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(child.exitCode, null, 'il supervisor NON esce per reverse-forward-failed');
  } finally {
    await stopSupervisor(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- T4: diniego policy (forward-denied) non e un breaker reverse -----------
test('diniego policy persistente (forward-denied) non rompe il supervisor: resta in retry vivo, mai terminale', async () => {
  const dir = tmpDir();
  const forwardPort = await reservePort();
  const { fakeSsh } = writeAlwaysFailingFake({
    dir, attemptsPath: path.join(dir, 'policy.log'),
    stderrLine: 'channel 2: open failed: administratively prohibited: open failed',
  });
  const { child, statePath } = startSupervisor({
    dir, name: 'hub', fakeSsh, forwardPort, reversePort: 44001, runId: 'policy-generation',
  });
  try {
    const retrying = await waitForState(statePath, (s) => s.status === 'retrying', 6000);
    assert.equal(retrying.ok, true, `seen=${retrying.seen && retrying.seen.join(',')}`);
    // il diniego policy non e reverse-forward: non entra in degraded ne esce
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(child.exitCode, null, 'il supervisor resta vivo');
    const raw = readState(statePath);
    assert.ok(!raw || raw.status !== 'failed' || raw.terminal !== true, 'mai terminale');
    assert.ok(!raw || raw.status !== 'degraded', 'il diniego policy non attiva il breaker reverse');
  } finally {
    await stopSupervisor(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- T5: dopo il budget iniziale il retry e fisso (non backoff crescente) ---
test('dopo il budget iniziale il retry e fisso: steadyRetryMs costante, backoff iniziale cresce', async () => {
  const dir = tmpDir();
  const forwardPort = await reservePort();
  const { fakeSsh } = writeAlwaysFailingFake({
    dir, attemptsPath: path.join(dir, 'steady.log'),
    stderrLine: 'remote port forwarding failed for listen port 44001',
  });
  const { child, statePath } = startSupervisor({
    dir, name: 'hub', fakeSsh, forwardPort, reversePort: 44001, runId: 'steady-generation',
    envExtra: { NEXUSCREW_TUNNEL_STEADY_RETRY_MS: '70' },
  });
  try {
    // Raccolta guidata dall'EVENTO, non da un cronometro. Prima leggeva per
    // cinque secondi fissi e poi sperava che nel mezzo fosse passato lo stato
    // atteso: su una macchina carica il supervisore non ci arrivava, e il test
    // falliva due volte su tre — misurato, anche su develop e anche isolato.
    // Un test del gate che cade a caso e' peggio di un test assente: insegna a
    // ignorare i rossi.
    //
    // Il limite NON e' stato alzato per curare il sintomo: e' cambiato il
    // criterio. Si aspetta finche' lo stato atteso compare, e se non compare
    // affatto il test fallisce come prima — l'asserzione non si e' indebolita.
    const collected = [];
    const deadline = Date.now() + 15000;
    let visto = false;
    while (Date.now() < deadline) {
      const s = readState(statePath);
      if (s) {
        collected.push(s);
        if (s.status === 'degraded') visto = true;
      }
      // Dopo aver visto il degraded si continua un poco, per avere abbastanza
      // campioni di `retrying` da confrontare fra loro.
      if (visto && collected.filter((x) => x.status === 'degraded').length >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    const degraded = collected.filter((s) => s.status === 'degraded');
    const retryingDelay = collected.filter((s) => s.status === 'retrying' && Number.isFinite(s.delayMs)).map((s) => s.delayMs);
    assert.ok(degraded.length >= 1, 'deve entrare in degraded dopo il budget');
    for (const s of degraded) assert.equal(s.steadyRetryMs, 70, 'steadyRetryMs fisso a 70');
    // il backoff iniziale cresce: confronta primo e ultimo delay osservato
    if (retryingDelay.length >= 2) {
      assert.ok(retryingDelay[retryingDelay.length - 1] >= retryingDelay[0],
        `backoff iniziale cresce: ${retryingDelay.join(',')}`);
    }
    assert.equal(child.exitCode, null, 'il supervisor resta vivo');
  } finally {
    await stopSupervisor(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('in produzione il retry degraded resta fisso a 60s anche con un env breve', async () => {
  const dir = tmpDir();
  const forwardPort = await reservePort();
  const { fakeSsh } = writeAlwaysFailingFake({
    dir, attemptsPath: path.join(dir, 'production-cadence.log'),
    stderrLine: 'remote port forwarding failed for listen port 44001',
  });
  const { child, statePath } = startSupervisor({
    dir, name: 'hub', fakeSsh, forwardPort, reversePort: 44001, runId: 'production-cadence',
    envExtra: {
      NEXUSCREW_TUNNEL_REVERSE_FAILURE_MAX: '1',
      NEXUSCREW_TUNNEL_TEST_MODE: '0',
      NEXUSCREW_TUNNEL_STEADY_RETRY_MS: '1',
    },
  });
  try {
    const degraded = await waitForState(statePath, (s) => s.status === 'degraded', 20000);
    assert.equal(degraded.ok, true, `seen=${degraded.seen && degraded.seen.join(',')}`);
    assert.equal(degraded.state.steadyRetryMs, 60000, 'runtime non accetta una cadenza breve');
  } finally {
    await stopSupervisor(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- T6: un listener permanentemente occupato non colpisce altri peer -------
test('un listener permanentemente occupato (bind) resta diagnosticato e non colpisce altri peer', async () => {
  const dir = tmpDir();
  // peer B healthy: forward server reale + fake ssh stabile
  const forwardB = net.createServer((socket) => socket.end());
  await new Promise((resolve) => forwardB.listen(0, '127.0.0.1', resolve));
  const portB = forwardB.address().port;
  const fakeStable = path.join(dir, 'stable.js');
  fs.writeFileSync(fakeStable, "setInterval(() => {}, 1000);\n", { mode: 0o700 });
  // peer A: reverse-forward-bind permanente
  const { fakeSsh: fakeBind } = writeAlwaysFailingFake({
    dir, attemptsPath: path.join(dir, 'bindA.log'),
    stderrLine: 'remote port forwarding failed: bind 127.0.0.1:44001: Address already in use',
  });
  const portA = await reservePort();
  const A = startSupervisor({ dir, name: 'hub-a', fakeSsh: fakeBind, forwardPort: portA, reversePort: 44001, runId: 'peer-a' });
  const B = startSupervisor({ dir, name: 'hub-b', fakeSsh: fakeStable, forwardPort: portB, reversePort: 44002, runId: 'peer-b' });
  try {
    const aDegr = await waitForState(A.statePath, (s) => s.status === 'degraded', 20000);
    const bReady = await waitForState(B.statePath, (s) => s.status === 'transport-ready', 6000);
    assert.equal(aDegr.ok, true, `A deve essere degraded, seen=${aDegr.seen && aDegr.seen.join(',')}`);
    assert.equal(bReady.ok, true, `B deve essere healthy nonostante A degraded, seen=${bReady.seen && bReady.seen.join(',')}`);
    assert.equal(aDegr.state.code, 'reverse-forward-bind');
    assert.equal(A.child.exitCode, null, 'peer A vivo');
    assert.equal(B.child.exitCode, null, 'peer B vivo');
  } finally {
    await stopSupervisor(A.child);
    await stopSupervisor(B.child);
    await new Promise((resolve) => forwardB.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- T7: diagnostica bounded (classe, reversePort, ownership) ---------------
test('readTunnelState/diagnoseTunnel espongono diagnostica bounded con ownership remoto unknown', () => {
  const dir = tmpDir();
  fs.mkdirSync(tunnel.tunnelDir(dir), { recursive: true });
  // Il pidfile locale e' vivo ma non puo attribuire il listener remoto.
  pidf.writePidfile(tunnel.tunnelPidPath(dir, 'hub'), process.pid, '', { runId: 'gen7' });
  fs.writeFileSync(tunnel.tunnelStatePath(dir, 'hub'), JSON.stringify({
    status: 'degraded', code: 'reverse-forward-bind', detail: 'bind occupata', hint: 'verifica listener',
    reversePort: 44001, ownership: 'unknown', steadyRetryMs: 60000, terminal: false,
    supervisorPid: process.pid, runId: 'gen7', attempt: 3, transport: 'ssh',
  }));
  const st = tunnel.readTunnelState(dir, 'hub');
  assert.equal(st.status, 'down');
  assert.equal(st.phase, 'degraded');
  assert.equal(st.code, 'reverse-forward-bind');
  assert.equal(st.reversePort, 44001);
  assert.equal(st.ownership, 'unknown');
  assert.equal(st.retryInMs, 60000);
  const diag = tunnel.diagnoseTunnel(dir, { ...NODE, name: 'hub' }, st);
  assert.equal(diag.phase, 'degraded');
  assert.equal(diag.code, 'reverse-forward-bind');
  assert.equal(diag.reversePort, 44001);
  fs.rmSync(dir, { recursive: true, force: true });
});
