'use strict';
// lib/nodes/tunnel.js — SSH tunnel manager (design §4b(1), §7).
//
// I processi ssh sono gestiti da un solo supervisor detached, avviato dal
// lifecycle del servizio o dalle azioni PWA autenticate. argv puro (spawn con
// array), nessuna shell interpolation.
//
// Due meccaniche:
//   - builder puro buildForwardArgs + backoff deterministico:
//     unit-testabili senza lanciare ssh.
//   - lifecycle per-tunnel via pidfile (start/stop/restart/state): il processo
//     ssh e' detached, la sua liveness/porta stabile e' interrogabile da
//     `status --json` e (in B1) dal proxy. Porta STABILE da nodes.json; una
//     collisione fa fallire ExitOnForwardFailure -> si segnala, NON si riciclano
//     porte a caso.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
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
  '-o', 'ConnectTimeout=15',
  // A Host stanza may set LogLevel=QUIET, leaving the per-tunnel diagnostic
  // completely empty even for bind/auth/forward failures.  ERROR is still
  // quiet on success and never logs key material, but preserves real failures.
  '-o', 'LogLevel=ERROR',
]);

function assertForwardSpec(node) {
  if (!node || typeof node !== 'object') throw new Error('tunnel: spec mancante');
  if (!store.isPort(node.localPort)) throw new Error('tunnel: localPort non valida');
  if (!store.isPort(node.remotePort)) throw new Error('tunnel: remotePort non valida');
  if (node.sshPort !== undefined && !store.isPort(node.sshPort)) throw new Error('tunnel: sshPort non valida');
  if (node.identityFile !== undefined && !store.isAbsPath(node.identityFile)) throw new Error('tunnel: identityFile non valido');
  if (node.keyPath !== undefined && !store.isAbsPath(node.keyPath)) throw new Error('tunnel: keyPath non valido');
  if (node.reversePort !== undefined && !store.isPort(node.reversePort)) throw new Error('tunnel: reversePort non valida');
  if (node.localAppPort !== undefined && !store.isPort(node.localAppPort)) throw new Error('tunnel: localAppPort non valida');
  if (node.shared === true && node.reversePort !== undefined && !store.isPort(node.localAppPort)) {
    throw new Error('tunnel: Share richiede localAppPort esplicita');
  }
  if (!store.parseSshTarget(node.ssh)) throw new Error('tunnel: target ssh non valido');
}

// Forward client->nodo (ruolo client). §4b(1):
//   ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30
//       -o ServerAliveCountMax=3 -o BatchMode=yes -i <key>
//       -L 127.0.0.1:<locale>:127.0.0.1:<remota> user@host
function buildForwardArgs(node) {
  assertForwardSpec(node);
  const transport = node.sshPort === undefined ? [] : ['-p', String(node.sshPort)];
  const identity = node.identityFile || node.keyPath;
  // The forward channel is the connection to the hub and is always present.
  // The reverse channel publishes this device back through the hub, so it is
  // opt-in only. A negotiated reversePort alone must never imply consent.
  const reverse = node.shared === true && node.reversePort !== undefined ? [
    '-R', `127.0.0.1:${node.reversePort}:127.0.0.1:${node.localAppPort}`,
  ] : [];
  return SSH_BASE_OPTS.concat(transport, identity ? ['-i', identity] : [], [
    '-L', `127.0.0.1:${node.localPort}:127.0.0.1:${node.remotePort}`,
    ...reverse,
    node.ssh,
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

// pidfile per-tunnel: forward "<name>". `__rendezvous__` è riconosciuto soltanto
// per spegnere un supervisor legacy durante la migrazione.
function tunnelPidPath(home, name) {
  return path.join(tunnelDir(home), `${name}.pid`);
}

function tunnelLogPath(home, name) {
  return path.join(tunnelDir(home), `${name}.log`);
}

// Cleanup identifier for pre-0.8.10 standalone rendezvous supervisors. New
// runtimes never start this second connection; reconciliation can still stop a
// stale legacy process left by an older install.
const REVERSE_NAME = '__rendezvous__';

// Reconcile detached supervisors against the authoritative node store. A
// server crash or an older rollback could leave a valid supervisor pidfile
// after its node disappeared; startup and `nexuscrew stop` must recover it
// without broad process matching. Only strict NexusCrew pidfile names are
// considered and stopTunnel still performs pid+cmd verification.
function tunnelPidNames(home) {
  const dir = tunnelDir(home);
  try {
    const root = fs.lstatSync(dir);
    if (root.isSymbolicLink() || !root.isDirectory()) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.pid'))
      .map((entry) => entry.name.slice(0, -4))
      .filter((name) => store.NODE_NAME_RE.test(name) || name === REVERSE_NAME)
      .sort();
  } catch (_) { return []; }
}

function reconcileTunnelSupervisors({ home = os.homedir(), configuredNames = [], stopImpl } = {}) {
  const keep = new Set((Array.isArray(configuredNames) ? configuredNames : [])
    .filter((name) => store.NODE_NAME_RE.test(String(name || ''))));
  const stopOne = typeof stopImpl === 'function' ? stopImpl : stopTunnel;
  const result = { kept: [], stopped: [], cleaned: [], failed: [] };
  const safeAbsent = new Set(['no pidfile', 'stale (pid dead)', 'pid reuse (cmd mismatch)']);
  for (const name of tunnelPidNames(home)) {
    if (keep.has(name)) { result.kept.push(name); continue; }
    try {
      const out = stopOne({ home, name });
      if (out && out.stopped) result.stopped.push(name);
      else if (out && safeAbsent.has(out.reason)) result.cleaned.push(name);
      else result.failed.push({ name, reason: (out && out.reason) || 'stop failed' });
    } catch (error) {
      result.failed.push({ name, reason: String((error && error.message) || error) });
    }
  }
  return result;
}

function prepareTunnelDir(home) {
  const dir = tunnelDir(home);
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('unsafe tunnel directory');
    fs.chmodSync(dir, 0o700);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('unsafe tunnel directory');
    fs.chmodSync(dir, 0o700);
  }
  return dir;
}

function openTunnelLog(home, name) {
  prepareTunnelDir(home);
  const logPath = tunnelLogPath(home, name);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC |
    (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(logPath, flags, 0o600);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('unsafe tunnel log');
    fs.fchmodSync(fd, 0o600);
    return { fd, logPath };
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    throw error;
  }
}

// Classifica soltanto firme SSH note e restituisce messaggi sicuri/azionabili:
// mai rimandare il log grezzo alla PWA (può contenere host/path locali). Serve
// soprattutto nel pairing: un normale `ssh hub-alias` può autenticarsi mentre permitopen nega
// il forward richiesto, caso che prima collassava nel generico "fetch failed".
function classifySshFailure(text, remotePort) {
  const s = String(text || '');
  const target = store.isPort(remotePort) ? `127.0.0.1:${remotePort}` : 'la porta NexusCrew richiesta';
  if (/administratively prohibited|request (?:was )?denied|open failed:.*prohibited|port forwarding.*(?:disabled|denied)/i.test(s)) {
    return {
      code: 'forward-denied',
      detail: `SSH autenticato, ma il server ha negato il port forwarding verso ${target}`,
      hint: `verifica AllowTcpForwarding e l'eventuale permitopen per ${target}; il link NON e' stato consumato`,
    };
  }
  if (/Permission denied \((?:publickey|password|keyboard-interactive)[^)]*\)|No supported authentication methods available/i.test(s)) {
    return {
      code: 'ssh-auth-failed', detail: 'autenticazione SSH rifiutata',
      hint: 'usa lo stesso Host o alias che funziona con il client SSH di questo dispositivo; chiavi e alias restano locali e il link NON e\' stato consumato',
    };
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|authenticity of host .* can'?t be established/i.test(s)) {
    return { code: 'ssh-host-key', detail: 'verifica della host key SSH non completata', hint: 'verifica la host key con il normale client SSH; NexusCrew non la accetta automaticamente' };
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname provided/i.test(s)) {
    return { code: 'ssh-dns', detail: 'host SSH non risolvibile', hint: 'verifica hostname o alias nel file SSH di questo dispositivo' };
  }
  if (/Bad owner or permissions on .*ssh|Bad configuration option|Could not open user configuration file/i.test(s)) {
    return { code: 'ssh-config', detail: 'configurazione SSH non utilizzabile', hint: 'verifica permessi e opzioni del file ~/.ssh/config' };
  }
  if (/remote port forwarding failed|Could not request remote forwarding/i.test(s)) {
    return { code: 'reverse-forward-denied', detail: 'il server SSH ha negato il canale inverso del nodo', hint: 'verifica permitlisten/AllowTcpForwarding sul nodo hub' };
  }
  if (/Could not request local forwarding|Address already in use/i.test(s)) {
    return { code: 'local-forward-bind', detail: 'la porta locale scelta per il tunnel non è disponibile', hint: 'ferma il tunnel precedente e riprova' };
  }
  if (/Connection refused|No route to host|Connection timed out|Operation timed out|Network is unreachable/i.test(s)) {
    return { code: 'ssh-unreachable', detail: 'endpoint SSH non raggiungibile', hint: 'verifica rete, hostname e porta SSH' };
  }
  return null;
}

function readTunnelDiagnostic(home, name, remotePort) {
  if (!store.NODE_NAME_RE.test(String(name || ''))) return null;
  const p = tunnelLogPath(home, name);
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const size = Math.min(st.size, 16 * 1024);
    if (!size) return null;
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, Math.max(0, st.size - size));
    return classifySshFailure(buf.toString('utf8'), remotePort);
  } catch (_) { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
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
      const transport = typeof state.transport === 'string' ? state.transport : undefined;
      const owned = state.supervisorPid === meta.pid && (!meta.runId || state.runId === meta.runId);
      if (!owned) return { status: 'down', pid: meta.pid, since: meta.startTs || null, reason: 'starting' };
      if (state.status === 'transport-ready' || state.status === 'up') {
        return { status: 'up', phase: 'transport-ready', pid: meta.pid, since: meta.startTs || null,
          ...(Number.isInteger(state.attempt) ? { attempt: state.attempt } : {}), ...(transport ? { transport } : {}) };
      }
      return { status: 'down', phase: state.status || 'starting', pid: meta.pid, since: meta.startTs || null,
        reason: state.status || 'starting', ...(Number.isInteger(state.attempt) ? { attempt: state.attempt } : {}),
        ...(Number.isFinite(state.delayMs) ? { retryInMs: state.delayMs } : {}), ...(transport ? { transport } : {}) };
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

function diagnoseTunnel(home, node, state = null) {
  const current = state || readTunnelState(home, node && node.name);
  const ssh = node && readTunnelDiagnostic(home, node.name, node.remotePort);
  if (ssh) return { stage: 'ssh', ...ssh, status: current.status, phase: current.phase || current.reason || null };
  if (current.status === 'up') {
    return { stage: 'transport', code: 'transport-ready', status: 'up', phase: current.phase || 'transport-ready',
      detail: 'trasporto SSH stabile; verifica federation in corso' };
  }
  if (current.reason === 'starting' || current.phase === 'starting') {
    return { stage: 'ssh', code: 'ssh-starting', status: 'starting', phase: 'starting',
      detail: 'connessione SSH in avvio', hint: 'attendi qualche secondo e usa Test connessione' };
  }
  if (current.reason === 'retrying' || current.phase === 'retrying') {
    return { stage: 'ssh', code: 'ssh-retrying', status: 'retrying', phase: 'retrying',
      detail: `connessione SSH in retry${Number.isInteger(current.attempt) ? ` (tentativo ${current.attempt + 1})` : ''}`,
      hint: 'usa Test connessione per vedere la causa; verifica target SSH, chiave e porta' };
  }
  return { stage: 'ssh', code: 'tunnel-stopped', status: 'down', phase: current.phase || null,
    detail: 'connessione SSH ferma', hint: 'avvia la connessione dalla PWA, Impostazioni > Nodi' };
}

function removeStateIfOwned(home, name, meta) {
  const statePath = tunnelStatePath(home, name);
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const samePid = !meta || !meta.pid || state.supervisorPid === meta.pid;
    const sameRun = !meta || !meta.runId || state.runId === meta.runId;
    if (samePid && sameRun) { fs.unlinkSync(statePath); return true; }
  } catch (_) {}
  return false;
}

function supervisorExited(pid, timeoutMs = 2500, impl = {}) {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const pidExistsImpl = impl.pidExistsImpl || pidf.pidExists;
  const procReadImpl = impl.procReadImpl || fs.readFileSync;
  const spawnSyncImpl = impl.spawnSyncImpl || spawnSync;
  const exited = () => {
    if (!pidExistsImpl(pid)) return true;
    try { return procReadImpl(`/proc/${pid}/stat`, 'utf8').split(' ')[2] === 'Z'; }
    catch (_) {
      // macOS has no /proc. `ps` is argv-only and its STAT starts with Z for a
      // zombie, which is no longer a usable supervisor even before wait/reap.
      try {
        const result = spawnSyncImpl('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
        return !result?.error && /^Z/.test(String(result?.stdout || '').trim());
      } catch (_error) { return false; }
    }
  };
  while (!exited() && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 25);
  return exited();
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
  const supervisor = path.join(__dirname, 'tunnel-supervisor.js');
  const runId = crypto.randomBytes(16).toString('hex');
  const supervisorArgs = [supervisor, sshBin, ...args];
  const cmd = `${process.execPath} ${supervisorArgs.join(' ')}`;
  const existing = pidf.readPidfile(pidPath);
  if (existing && pidf.isAlive(existing)) {
    // An update or automatic HTTP-port fallback can change -L/-R while the
    // detached supervisor is still alive.  Keep exact matches idempotent, but
    // replace a supervisor whose saved argv no longer matches the desired one.
    if (!existing.cmd || existing.cmd === cmd) {
      return { started: false, reason: 'already running', pid: existing.pid, transport: sshBin };
    }
    const oldMeta = existing;
    const stopped = pidf.killPidfile(pidPath);
    if (!stopped.killed) return { started: false, reason: `running spec mismatch: ${stopped.reason || 'stop failed'}`, pid: existing.pid };
    if (!(opts.supervisorExitedImpl || supervisorExited)(oldMeta.pid, opts.stopWaitMs || 2500)) {
      return { started: false, reason: `running spec mismatch: old supervisor ${oldMeta.pid} did not exit`, pid: oldMeta.pid };
    }
    removeStateIfOwned(home, name, oldMeta);
  }
  pidf.cleanStale(pidPath);

  const logPath = tunnelLogPath(home, name);
  const statePath = tunnelStatePath(home, name);
  // fdProvided: il caller ci passa un fd (es. test con logFd:null) e ne rimane
  // proprietario; noi chiudiamo solo la fd che apriamo noi (no double-close).
  const fdProvided = opts.logFd !== undefined;
  let logFd;
  try {
    prepareTunnelDir(home);
    logFd = fdProvided ? opts.logFd : openTunnelLog(home, name).fd;
  } catch (_) {
    return { started: false, reason: 'unsafe tunnel log path' };
  }
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
  try {
    child = spawnImpl(process.execPath, supervisorArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        NEXUSCREW_TUNNEL_STATE: statePath,
        NEXUSCREW_TUNNEL_PIDFILE: pidPath,
        NEXUSCREW_TUNNEL_RUN_ID: runId,
        ...(opts.stableMs === undefined ? {} : { NEXUSCREW_TUNNEL_STABLE_MS: String(opts.stableMs) }),
      },
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
    if (current && current.pid === pid && current.runId === runId) pidf.removePidfile(pidPath);
    removeStateIfOwned(home, name, { pid, runId });
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

  // writePidfile e' exclusive (wx): cleanStale sopra ha gia' tolto uno stale.
  try {
    pidf.writePidfile(pidPath, pid, cmd, { runId });
  } catch (e) {
    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
    cleanupIfOwned();
    closeOwnedFd();
    return { started: false, reason: 'pidfile error', error: String(e && e.message || e) };
  }
  // Safe local breadcrumb: argv, host, key paths and credentials are omitted.
  // The detached supervisor appends lifecycle events to the same 0600 file.
  if (Number.isInteger(logFd)) {
    try { fs.writeSync(logFd, `[nexuscrew] supervisor requested transport=${path.basename(sshBin)}\n`); } catch (_) {}
  }
  closeOwnedFd(); // copia del padre: il figlio ha la sua dup; nessun leak (audit F3)
  return { started: true, pid, logPath, transport: sshBin };
}

// Ferma il tunnel: kill verificato via pidfile (mai broad match by name).
function stopTunnel(opts) {
  const home = opts.home || os.homedir();
  const name = opts.name;
  if (!name) throw new Error('stopTunnel: name mancante');
  const pidPath = tunnelPidPath(home, name);
  const meta = pidf.readPidfile(pidPath);
  const r = pidf.killPidfile(pidPath);
  if (r.killed && !(opts.supervisorExitedImpl || supervisorExited)(r.pid, opts.stopWaitMs || 2500)) {
    return { stopped: false, pid: r.pid, reason: `supervisor ${r.pid} did not exit after SIGTERM` };
  }
  removeStateIfOwned(home, name, meta);
  return { stopped: r.killed, pid: r.pid, reason: r.reason };
}

function restartTunnel(opts) {
  stopTunnel(opts);
  return startTunnel(opts);
}

// Helper di alto livello: costruisce args dal nodo e avvia il forward.
function startForward(opts) {
  const node = opts.node;
  const localAppPort = opts.localAppPort === undefined ? node.localAppPort : opts.localAppPort;
  const args = buildForwardArgs({ ...node, localAppPort });
  // NexusCrew already owns retry/backoff in tunnel-supervisor.js. Nesting
  // autossh inside that supervisor made liveness dishonest: autossh could stay
  // alive while every SSH child exited 255, so the UI reported "tunnel up".
  // Use one portable supervisor around OpenSSH on Linux, macOS and Termux.
  // `transport: autossh` remains readable for old stores but is normalized at
  // runtime to supervised ssh.
  const sshBin = opts.sshBin || 'ssh';
  return startTunnel({ ...opts, sshBin, name: node.name, args });
}

// Versione client OpenSSH, solo diagnostica. Non inferire mai da questa la
// policy `permitlisten` del server remoto: quella si prova con il vero -R.
function readSshVersion(spawnSyncImpl) {
  try {
    const r = (spawnSyncImpl || spawnSync)('ssh', ['-V'], { encoding: 'utf8' });
    const text = `${(r && r.stdout) || ''}${(r && r.stderr) || ''}`; // ssh -V scrive su stderr
    const m = text.match(/OpenSSH_(\d+)\.(\d+)/);
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), raw: text.trim().split('\n')[0] };
  } catch (_) { return null; }
}

module.exports = {
  SSH_BASE_OPTS,
  buildForwardArgs, backoffDelay,
  tunnelDir, tunnelPidPath, tunnelLogPath, tunnelStatePath, readTunnelState,
  prepareTunnelDir, openTunnelLog,
  tunnelPidNames, reconcileTunnelSupervisors,
  classifySshFailure, readTunnelDiagnostic,
  diagnoseTunnel,
  removeStateIfOwned, supervisorExited,
  startTunnel, stopTunnel, restartTunnel, startForward,
  REVERSE_NAME,
  readSshVersion, sshBinaryAvailable,
};
