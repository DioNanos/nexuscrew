'use strict';
// lib/nodes/tunnel.js — SSH tunnel manager (design §4b(1), §7).
//
// I processi ssh sono figli del lifecycle CLI/service, MAI di un handler HTTP
// (nessun spawn dalla superficie web). Template SSH ESATTI dal design §4b(1);
// argv puro (spawn con array), nessuna shell interpolation.
//
// Due meccaniche:
//   - builder puri (buildForwardArgs/buildReverseArgs) + backoff deterministico:
//     unit-testabili senza lanciare ssh.
//   - lifecycle per-tunnel via pidfile (start/stop/restart/state): il processo
//     ssh e' detached, la sua liveness/porta stabile e' interrogabile da
//     `status --json` e (in B1) dal proxy. Porta STABILE da nodes.json; una
//     collisione fa fallire ExitOnForwardFailure -> si segnala, NON si riciclano
//     porte a caso.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const pidf = require('../cli/pidfile.js');
const store = require('./store.js');

// Opzioni SSH comuni ai due template (ordine e valori ESATTI dal design §4b(1)).
const SSH_BASE_OPTS = Object.freeze([
  '-N',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'BatchMode=yes',
]);

function assertForwardSpec(node) {
  if (!node || typeof node !== 'object') throw new Error('tunnel: spec mancante');
  if (!store.isPort(node.localPort)) throw new Error('tunnel: localPort non valida');
  if (!store.isPort(node.remotePort)) throw new Error('tunnel: remotePort non valida');
  if (node.sshPort !== undefined && !store.isPort(node.sshPort)) throw new Error('tunnel: sshPort non valida');
  if (node.identityFile !== undefined && !store.isAbsPath(node.identityFile)) throw new Error('tunnel: identityFile non valido');
  if (node.keyPath !== undefined && !store.isAbsPath(node.keyPath)) throw new Error('tunnel: keyPath non valido');
  if (!store.parseSshTarget(node.ssh)) throw new Error('tunnel: target ssh non valido');
}

function assertReverseSpec(rdv) {
  if (!rdv || typeof rdv !== 'object') throw new Error('tunnel: rendezvous mancante');
  if (!store.isPort(rdv.publishedPort)) throw new Error('tunnel: publishedPort non valida');
  if (!store.isPort(rdv.localPort)) throw new Error('tunnel: localPort non valida');
  if (!store.isAbsPath(rdv.keyPath)) throw new Error('tunnel: keyPath non valido');
  if (!store.parseSsh(rdv.ssh)) throw new Error('tunnel: ssh (user@rendezvous) non valido');
}

// Forward client->nodo (ruolo client). §4b(1):
//   ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30
//       -o ServerAliveCountMax=3 -o BatchMode=yes -i <key>
//       -L 127.0.0.1:<locale>:127.0.0.1:<remota> user@host
function buildForwardArgs(node) {
  assertForwardSpec(node);
  const transport = node.sshPort === undefined ? [] : ['-p', String(node.sshPort)];
  const identity = node.identityFile || node.keyPath;
  const reverse = node.reversePort === undefined ? [] : [
    '-R', `127.0.0.1:${node.reversePort}:127.0.0.1:${node.localAppPort || node.remotePort}`,
  ];
  return SSH_BASE_OPTS.concat(transport, identity ? ['-i', identity] : [], [
    '-L', `127.0.0.1:${node.localPort}:127.0.0.1:${node.remotePort}`,
    ...reverse,
    node.ssh,
  ]);
}

// Reverse nodo->rendezvous (ruolo node). §4b(1): bind loopback ESPLICITO lato
// remoto (mai wildcard):
//   ssh -N ... -i <key> -R 127.0.0.1:<pubblicata>:127.0.0.1:<locale> user@rendezvous
function buildReverseArgs(rdv) {
  assertReverseSpec(rdv);
  return SSH_BASE_OPTS.concat([
    '-i', rdv.keyPath,
    '-R', `127.0.0.1:${rdv.publishedPort}:127.0.0.1:${rdv.localPort}`,
    rdv.ssh,
  ]);
}

// Backoff esponenziale + jitter (design §7). Deterministico con rng iniettato.
//   delay = clamp(base * factor^attempt, 0..cap) * (1 +- jitter*(2*rand-1))
// rng()=0.5 -> jitter nullo (ritorna il valore base clamperato); test deterministici.
function backoffDelay(attempt, opts = {}) {
  const base = opts.baseMs || 1000;
  const cap = opts.capMs || 60000;
  const factor = opts.factor || 2;
  const jitter = opts.jitter === undefined ? 0.2 : opts.jitter;
  const rng = opts.rng || Math.random;
  const a = Math.max(0, Math.floor(attempt));
  const raw = Math.min(cap, base * Math.pow(factor, a));
  const delta = raw * jitter * (rng() * 2 - 1);
  return Math.max(0, Math.round(raw + delta));
}

// --- Lifecycle per-tunnel (pidfile) ----------------------------------------

function tunnelDir(home) {
  return path.join(home || os.homedir(), '.nexuscrew', 'tunnels');
}

// pidfile per-tunnel: forward "<name>", reverse "__rendezvous__". Il name e' gia'
// una chiave strict (^[a-z0-9-]{1,32}$), safe come basename.
function tunnelPidPath(home, name) {
  return path.join(tunnelDir(home), `${name}.pid`);
}

function tunnelLogPath(home, name) {
  return path.join(tunnelDir(home), `${name}.log`);
}

function tunnelStatePath(home, name) {
  return path.join(tunnelDir(home), `${name}.state.json`);
}

// Stato interrogabile del tunnel: { status: 'up'|'down', pid?, since? }.
function readTunnelState(home, name) {
  const p = tunnelPidPath(home, name);
  const meta = pidf.readPidfile(p);
  if (meta && pidf.isAlive(meta)) {
    try {
      const state = JSON.parse(fs.readFileSync(tunnelStatePath(home, name), 'utf8'));
      if (state.status === 'up') return { status: 'up', pid: meta.pid, since: meta.startTs || null };
      return { status: 'down', pid: meta.pid, since: meta.startTs || null, reason: state.status || 'starting' };
    } catch (_) {
      // Backward compatibility for pre-supervisor pidfiles: a live direct ssh
      // process had no state sidecar and was considered up.
      if (!String(meta.cmd || '').includes('tunnel-supervisor.js')) {
        return { status: 'up', pid: meta.pid, since: meta.startTs || null };
      }
      return { status: 'down', pid: meta.pid, since: meta.startTs || null, reason: 'starting' };
    }
  }
  return { status: 'down' };
}

// Pre-flight sincrono: l'unico modo di "surfaccare" un binario ssh assente come
// failure ESPLICITA nel valore di ritorno (lo spawn emette 'error' asincrono, non
// catturabile sync). spawnSyncImpl iniettabile per test deterministici.
// ssh -V esiste su ogni platform supportata; ENOENT = binario mancante (audit F2).
function sshBinaryAvailable(sshBin, spawnSyncImpl) {
  try {
    const r = (spawnSyncImpl || spawnSync)(sshBin, ['-V'], { encoding: 'utf8' });
    if (r && r.error) return false; // binario mancante o non eseguibile
    return true; // qualunque altro esito (anche status!=0) = il binario esiste
  } catch (_) { return false; }
}

// Avvia il tunnel (idempotente: se gia' vivo, no-op). Spawn detached; stdout/err
// nel logfile del tunnel; pidfile con cmd verificabile (kill anti PID-reuse).
// spawnImpl/spawnSyncImpl iniettabili per i test (mai lancia ssh vero in suite).
//
// INVARIANTI (audit F2/F3):
//   - MAI crashare: spawn throw, error async, pid mancante -> failure esplicita
//     {started:false, reason}, con cleanup di pidfile/process/log fd di nostra proprieta'.
//   - NESSUN leak del log fd aperto internamente: il padre chiude la SUA copia dopo
//     lo spawn (il figlio ha la sua dup via stdio) su SUCCESSO e su OGNI failure.
//   - Una sola chiusura (idempotente): il path normale e l'eventuale 'error' async
//     non competono sulla stessa fd.
function startTunnel(opts) {
  const home = opts.home || os.homedir();
  const name = opts.name;
  const args = opts.args;
  const spawnImpl = opts.spawnImpl || spawn;
  const spawnSyncImpl = opts.spawnSyncImpl || spawnSync;
  const sshBin = opts.sshBin || 'ssh';
  if (!name) throw new Error('startTunnel: name mancante');
  if (!Array.isArray(args)) throw new Error('startTunnel: args mancanti');

  const pidPath = tunnelPidPath(home, name);
  const existing = pidf.readPidfile(pidPath);
  if (existing && pidf.isAlive(existing)) {
    return { started: false, reason: 'already running', pid: existing.pid };
  }
  pidf.cleanStale(pidPath);

  fs.mkdirSync(tunnelDir(home), { recursive: true });
  const logPath = tunnelLogPath(home, name);
  const statePath = tunnelStatePath(home, name);
  // fdProvided: il caller ci passa un fd (es. test con logFd:null) e ne rimane
  // proprietario; noi chiudiamo solo la fd che apriamo noi (no double-close).
  const fdProvided = opts.logFd !== undefined;
  const logFd = fdProvided ? opts.logFd : fs.openSync(logPath, 'a');
  let fdClosed = false;
  const closeOwnedFd = () => {
    if (fdClosed) return; fdClosed = true;
    if (!fdProvided) { try { fs.closeSync(logFd); } catch (_) { /* best-effort */ } }
  };

  // Pre-flight: binario ssh mancante -> failure esplicita, nessuno spawn, nessun
  // crash (audit F2: prima restituiva started:true e poi l'event 'error' killava Node).
  if (!sshBinaryAvailable(sshBin, spawnSyncImpl)) {
    closeOwnedFd();
    return { started: false, reason: 'ssh binary not found', sshBin };
  }

  // Spawn a detached Node supervisor. It owns ssh and retries failures with the
  // bounded backoff defined above, so CLI/server lifetime does not own liveness.
  let child;
  const supervisor = path.join(__dirname, 'tunnel-supervisor.js');
  const supervisorArgs = [supervisor, sshBin, ...args];
  try {
    child = spawnImpl(process.execPath, supervisorArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, AUTOSSH_GATETIME: '0', NEXUSCREW_TUNNEL_STATE: statePath },
    });
  } catch (e) {
    closeOwnedFd();
    return { started: false, reason: 'spawn error', error: String((e && e.message) || e) };
  }
  if (child && typeof child.unref === 'function') child.unref();

  // Difensivo: un 'error' async (es. race: binario rimosso tra pre-flight e spawn)
  // non deve MAI restare senza listener (crash Node). Pulisce pidfile + fd di nostra
  // proprieta'. Idempotente rispetto al path normale.
  let pid = child && child.pid;
  const cleanupIfOwned = () => {
    const current = pidf.readPidfile(pidPath);
    if (current && current.pid === pid) pidf.removePidfile(pidPath);
    try { fs.unlinkSync(statePath); } catch (_) {}
  };
  if (child && typeof child.on === 'function') {
    child.on('error', () => {
      cleanupIfOwned();
      closeOwnedFd();
    });
  }

  if (!Number.isFinite(pid)) {
    // spawn senza pid (failure): niente pidfile, cleanup. Non c'e' figlio da killare.
    closeOwnedFd();
    return { started: false, reason: 'spawn error (no pid)' };
  }

  const cmd = `${process.execPath} ${supervisorArgs.join(' ')}`;
  // writePidfile e' exclusive (wx): cleanStale sopra ha gia' tolto uno stale.
  try {
    pidf.writePidfile(pidPath, pid, cmd);
  } catch (e) {
    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
    cleanupIfOwned();
    closeOwnedFd();
    return { started: false, reason: 'pidfile error', error: String(e && e.message || e) };
  }
  closeOwnedFd(); // copia del padre: il figlio ha la sua dup; nessun leak (audit F3)
  return { started: true, pid, logPath };
}

// Ferma il tunnel: kill verificato via pidfile (mai broad match by name).
function stopTunnel(opts) {
  const home = opts.home || os.homedir();
  const name = opts.name;
  if (!name) throw new Error('stopTunnel: name mancante');
  const r = pidf.killPidfile(tunnelPidPath(home, name));
  try { fs.unlinkSync(tunnelStatePath(home, name)); } catch (_) {}
  return { stopped: r.killed, pid: r.pid, reason: r.reason };
}

function restartTunnel(opts) {
  stopTunnel(opts);
  return startTunnel(opts);
}

// Helper di alto livello: costruisce args dal nodo e avvia il forward.
function startForward(opts) {
  const node = opts.node;
  let sshBin = opts.sshBin;
  let args = buildForwardArgs({ ...node, localAppPort: opts.localAppPort });
  const wanted = node.transport || (node.keyPath ? 'ssh' : 'auto');
  if (!sshBin && (wanted === 'auto' || wanted === 'autossh') && sshBinaryAvailable('autossh', opts.spawnSyncImpl)) {
    sshBin = 'autossh';
    args = ['-M', '0', ...args];
  } else if (!sshBin) {
    sshBin = 'ssh';
  }
  return startTunnel({ ...opts, sshBin, name: node.name, args });
}

// Helper di alto livello: reverse verso il rendezvous.
const REVERSE_NAME = '__rendezvous__';
function startReverse(opts) {
  const args = buildReverseArgs(opts.rendezvous);
  return startTunnel({ ...opts, name: REVERSE_NAME, args });
}

// --- Capability OpenSSH (permitlisten, design §7 advisory (a)) --------------
// permitlisten (vincola i -R) esiste da OpenSSH 7.8. Serve sul rendezvous per il
// ruolo node; il check locale su `ssh -V` e' l'unico verificabile in autonomia.
// null = versione non determinabile (non un fail: warn + verifica manuale).
function readSshVersion(spawnSyncImpl) {
  try {
    const r = (spawnSyncImpl || spawnSync)('ssh', ['-V'], { encoding: 'utf8' });
    const text = `${(r && r.stdout) || ''}${(r && r.stderr) || ''}`; // ssh -V scrive su stderr
    const m = text.match(/OpenSSH_(\d+)\.(\d+)/);
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), raw: text.trim().split('\n')[0] };
  } catch (_) { return null; }
}

// true/false se determinabile, null se versione ignota.
function sshSupportsPermitlisten(v) {
  if (!v) return null;
  if (v.major > 7) return true;
  if (v.major === 7 && v.minor >= 8) return true;
  return false;
}

module.exports = {
  SSH_BASE_OPTS,
  buildForwardArgs, buildReverseArgs, backoffDelay,
  tunnelDir, tunnelPidPath, tunnelLogPath, tunnelStatePath, readTunnelState,
  startTunnel, stopTunnel, restartTunnel, startForward, startReverse,
  REVERSE_NAME,
  readSshVersion, sshSupportsPermitlisten, sshBinaryAvailable,
};
