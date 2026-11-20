'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const {
  PACKAGE_NAME, compareVersions, parseVersion, registryVersion, scrubError, pidAlive, readLock,
  acquireUpdateLock, releaseUpdateLock, readState, writeState, stableRuntimeDir,
  installGate, recordInstall, initialCheckDelayMs,
} = require('./core.js');
const npmEnv = require('./npm-env.js');

function readProcStatStateSafe(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid < 1) return null;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = raw.lastIndexOf(')');
    if (closeParen < 0) return null;
    const after = raw.slice(closeParen + 1).trimStart();
    if (!after) return null;
    return after[0] || null;
  } catch (_) {
    return null;
  }
}

function isPidLiveRunner(pid) {
  if (!pidAlive(pid)) return false;
  const st = readProcStatStateSafe(pid);
  if (st === 'Z' || st === 'X' || st === 'x') return false;
  return true;
}

function inspectJsonFileStrict(file) {
  try {
    const lst = fs.lstatSync(file);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      return { kind: 'invalid', reason: 'unsafe-target' };
    }
    const raw = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { kind: 'invalid', reason: 'malformed-json' };
    }
    return { kind: 'ok', value };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', reason: (err && err.code) || 'read-error' };
  }
}

function inspectLockStrict(file) {
  const res = inspectJsonFileStrict(file);
  if (res.kind !== 'ok') return res;
  const val = res.value;
  if (!Number.isInteger(val.pid) || val.pid < 1 || typeof val.token !== 'string' || !val.token) {
    return { kind: 'invalid', reason: 'invalid-lock-fields' };
  }
  return res;
}

const DEFAULT_INITIAL_DELAY_MS = 60 * 1000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;

function packageRoot() { return path.resolve(__dirname, '..', '..'); }

function isGlobalInstall(root = packageRoot()) {
  const normalized = path.resolve(root).split(path.sep).join('/');
  return normalized.includes('/node_modules/@mmmbuto/nexuscrew');
}

function isNewer(candidate, current) {
  try { return compareVersions(candidate, current) > 0; } catch (_) { return false; }
}

function lookupLatestNpm({ execFileImpl = execFile, timeoutMs = 20_000, home = os.homedir(), cwd, npmInvocationImpl, onChildStart } = {}) {
  // Stesso npm dell'installazione: node del demone + npm-cli accanto (mai `npm` nudo dal PATH).
  const invocation = (npmInvocationImpl || npmEnv.resolveNpmInvocation)({ execPath: process.execPath });
  return new Promise((resolve, reject) => {
    let cbSettled = false;
    const child = execFileImpl(invocation.bin, [...invocation.argvPrefix, 'view', `${PACKAGE_NAME}@latest`, 'version', '--json'], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024,
      cwd: cwd || stableRuntimeDir(home), ...(invocation.env ? { env: invocation.env } : {}),
    }, (error, stdout) => {
      cbSettled = true;
      if (error) return reject(error);
      try { resolve(registryVersion(stdout)); } catch (e) { reject(e); }
    });
    if (typeof onChildStart === 'function' && (child || !cbSettled)) {
      try { onChildStart(child); } catch (_) {}
    }
  });
}

function createNpmUpdater(opts = {}) {
  const currentVersion = String(opts.currentVersion || require('../../package.json').version);
  const home = opts.home || os.homedir();
  const statusPath = opts.statusPath || path.join(home, '.nexuscrew', 'npm-update.json');
  const logPath = opts.logPath || path.join(home, '.nexuscrew', 'npm-update.log');
  const lockPath = opts.lockPath || path.join(home, '.nexuscrew', 'npm-update.lock');
  const runnerPath = opts.runnerPath || path.join(__dirname, 'runner.js');
  const workDir = opts.cwd || stableRuntimeDir(home);
  const supported = opts.supported === undefined ? isGlobalInstall(opts.packageRoot) : !!opts.supported;
  const nowMono = typeof opts.nowMono === 'function' ? opts.nowMono : () => performance.now();
  const setTimer = typeof opts.setTimer === 'function' ? opts.setTimer : setTimeout;
  const clearTimer = typeof opts.clearTimer === 'function' ? opts.clearTimer : clearTimeout;
  const readonly = opts.readonly === true;
  const activeConsumers = new Set();
  let unattestedConsumers = 0;
  const trackChildConsumer = (child) => {
    if (!child || typeof child.once !== 'function') {
      unattestedConsumers += 1;
      return;
    }
    if ((child.exitCode !== null && child.exitCode !== undefined)
      || (child.signalCode !== null && child.signalCode !== undefined)) {
      return;
    }
    let settled = false;
    let spawnSeen = false;
    const p = new Promise((resolve) => {
      const detach = (event, fn) => {
        if (typeof child.off === 'function') child.off(event, fn);
        else if (typeof child.removeListener === 'function') child.removeListener(event, fn);
      };
      const onSpawn = () => { spawnSeen = true; };
      const done = () => {
        if (settled) return;
        settled = true;
        detach('spawn', onSpawn);
        detach('exit', done);
        detach('close', done);
        detach('error', onError);
        resolve();
      };
      const onError = (err) => {
        // Only treat 'error' as termination when spawn itself failed before acquiring a child process.
        // Operational/signal errors leave a running child alive until 'exit' or 'close' is observed.
        const provenSpawnFailure = !spawnSeen
          && !(Number.isInteger(child.pid) && child.pid > 0)
          && Boolean(err && typeof err === 'object' && typeof err.syscall === 'string' && err.syscall.startsWith('spawn'));
        if (provenSpawnFailure) {
          done();
        }
      };
      child.once('spawn', onSpawn);
      child.once('exit', done);
      child.once('close', done);
      if (typeof child.on === 'function') child.on('error', onError);
      else child.once('error', onError);
    });
    activeConsumers.add(p);
    p.then(() => activeConsumers.delete(p), () => activeConsumers.delete(p));
  };
  const lookupLatest = opts.lookupLatest || (() => lookupLatestNpm({ ...opts, onChildStart: trackChildConsumer }));
  const spawnImpl = opts.spawnImpl || spawn;
  const useSystemdRun = opts.useSystemdRun === undefined
    ? (process.platform === 'linux' && !!process.env.INVOCATION_ID)
    : opts.useSystemdRun === true;
  const initialDelayMs = opts.initialDelayMs === undefined ? DEFAULT_INITIAL_DELAY_MS : opts.initialDelayMs;
  const intervalMs = opts.intervalMs === undefined ? DEFAULT_INTERVAL_MS : opts.intervalMs;
  const maxLogBytes = opts.maxLogBytes === undefined ? DEFAULT_MAX_LOG_BYTES : opts.maxLogBytes;
  const diagnostics = opts.diagnostics || null;
  // Spento se non richiesto esplicitamente: l'unico chiamante di produzione
  // passa `enabled: cfg.autoUpdate === true`, quindi la chiave assente non
  // avvia il daemon. Stesso criterio di setEnabled (`value === true`).
  let enabled = opts.enabled === true && !readonly;
  let closed = false;
  let checking = null;
  let timer = null;
  const adoptionTimers = new Set();
  let activeLaunch = null;
  let cancelledTimersCount = 0;
  let state = readState(statusPath);

  // Only stale temp files are reaped. A fresh temp may belong to another live
  // NexusCrew process writing the same shared state.
  try {
    const dir = path.dirname(statusPath); const prefix = `${path.basename(statusPath)}.`;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(file);
    }
  } catch (_) {}

  if (state.phase === 'installed' && state.targetVersion === currentVersion) {
    state = { ...state, phase: 'idle', available: false, latest: currentVersion, lastError: '' };
    writeState(statusPath, state);
  }
  // un update dato per riuscito ma il processo in esecuzione NON e' alla versione target (ha ricaricato codice
  // vecchio, o e' un altro albero): la versione si blocca, altrimenti ogni riavvio reinstalla lo stesso target.
  if (state.phase === 'installed' && state.targetVersion && state.targetVersion !== currentVersion
    && isNewer(state.targetVersion, currentVersion)) {
    state = {
      ...state, phase: 'error', available: true, blockedVersion: state.targetVersion,
      lastError: `dopo l'aggiornamento il processo esegue la versione ${currentVersion}, attesa ${state.targetVersion}: versione bloccata`,
    };
    writeState(statusPath, state);
  }
  const activeLock = () => { const lock = readLock(lockPath); return !!(lock && pidAlive(lock.pid)); };
  if ((state.phase === 'installing' || state.phase === 'restarting') && !pidAlive(state.updaterPid) && !activeLock()) {
    state = { ...state, phase: 'error', lastError: 'aggiornamento precedente interrotto' };
    writeState(statusPath, state);
  }

  const persist = (patch) => {
    const previousPhase = state.phase || 'idle';
    state = { ...state, ...patch };
    writeState(statusPath, state);
    const phase = state.phase || 'idle';
    if (diagnostics && typeof diagnostics.record === 'function' && phase !== previousPhase) {
      diagnostics.record(phase === 'error' ? 'warn' : 'info', 'updater', 'UPDATE_PHASE', 'Updater phase changed', {
        phase, version: state.targetVersion || state.latest || currentVersion,
      });
    }
    return status();
  };

  const status = () => {
    state = { ...state, ...readState(statusPath) };
    return {
      supported, enabled, current: currentVersion,
      phase: state.phase || 'idle', latest: state.latest || '',
      available: state.available === true && isNewer(state.latest, currentVersion),
      // `idle` di DEFAULT (stato mai scritto) e `idle` DOPO un check
      // senza novita' coincidono — e la UI narrava «aggiornato» in entrambi.
      // `checked` deriva da lastCheckedAt, che viene scritto a OGNI check
      // (riuscito o fallito): chi legge distingue «mai controllato» (ignoranza)
      // da «controllato, nessuna novita'» (buona notizia saputa).
      checked: !!state.lastCheckedAt,
      lastCheckedAt: state.lastCheckedAt || '', lastUpdatedAt: state.lastUpdatedAt || '',
      lastError: state.lastError || '', blockedVersion: state.blockedVersion || '',
    };
  };

  const launch = (version, { manual = false } = {}) => {
    if (closed) {
      const error = new Error('updater chiuso');
      error.status = 503;
      error.code = 'update-disarmed';
      throw error;
    }
    if (!supported) throw new Error('auto-update disponibile solo nell’installazione npm globale');
    if (readonly) throw new Error('READONLY: auto-update bloccato');
    if (!isNewer(version, currentVersion)) return status();
    status();
    if (state.phase === 'installing' || state.phase === 'restarting' || activeLock()) {
      const error = new Error('aggiornamento già in corso'); error.status = 409; error.code = 'update-busy'; throw error;
    }
    if (state.blockedVersion === version) {
      const error = new Error(`versione ${version} bloccata dopo un rollback fallito/necessario`); error.status = 409; error.code = 'update-blocked'; throw error;
    }
    if (!manual) {
      const gate = installGate(state, version);
      if (!gate.ok) {
        persist({ phase: 'available', available: true, lastError: gate.reason });
        const error = new Error(gate.reason); error.status = 409; error.code = 'update-backoff'; throw error;
      }
    }
    const reservation = acquireUpdateLock(lockPath);
    if (!reservation.ok) {
      const error = new Error('aggiornamento già in corso'); error.status = 409; error.code = 'update-busy'; throw error;
    }
    activeLaunch = {
      token: reservation.token,
      targetVersion: version,
      launcherPid: null,
      useSystemdRun,
      startedAtMs: Date.now(),
      spawnFailed: false,
      wrapperExited: false,
      wrapperExitCode: null,
      directChildExited: false,
    };
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    try {
      const logStat = fs.lstatSync(logPath);
      if (!logStat.isFile() || logStat.isSymbolicLink()) throw new Error('update log target non sicuro');
      if (logStat.size > maxLogBytes) fs.truncateSync(logPath, 0);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        activeLaunch = null;
        releaseUpdateLock(lockPath, reservation.token);
        persist({ phase: 'error', available: true, lastError: scrubError(error) });
        throw error;
      }
    }
    const fd = fs.openSync(logPath, 'a', 0o600);
    let child;
    try {
      persist({ ...recordInstall(state, version), phase: 'installing', targetVersion: version, latest: version, available: true, lastError: '' });
      const runnerArgs = [runnerPath, '--version', version, '--status', statusPath, '--home', home,
        '--lock', lockPath, '--lock-token', reservation.token];
      const bin = useSystemdRun ? 'systemd-run' : process.execPath;
      const argv = useSystemdRun
        ? ['--user', '--quiet', '--collect', `--unit=nexuscrew-update-${process.pid}-${Date.now()}`,
          `--property=StandardOutput=append:${logPath}`, `--property=StandardError=append:${logPath}`,
          process.execPath, ...runnerArgs]
        : runnerArgs;
      child = spawnImpl(bin, argv, {
        detached: true, stdio: ['ignore', fd, fd], cwd: workDir,
        env: { ...process.env, NEXUSCREW_UPDATE_RUNNER: '1' },
      });
    } catch (e) {
      activeLaunch = null;
      releaseUpdateLock(lockPath, reservation.token);
      persist({ phase: 'error', available: true, lastError: scrubError(e) });
      throw e;
    } finally {
      try { fs.closeSync(fd); } catch (_) {}
    }
    if (!child || !Number.isInteger(child.pid)) {
      activeLaunch = null;
      releaseUpdateLock(lockPath, reservation.token);
      const error = new Error('unable to start the update process');
      persist({ phase: 'error', available: true, lastError: error.message });
      throw error;
    }
    activeLaunch.launcherPid = child.pid;
    if (typeof child.once === 'function') {
      child.once('error', (error) => {
        if (closed) return;
        if (activeLaunch && activeLaunch.token === reservation.token) {
          activeLaunch.spawnFailed = true;
        }
        if (releaseUpdateLock(lockPath, reservation.token)) {
          if (activeLaunch && activeLaunch.token === reservation.token) activeLaunch = null;
          persist({ phase: 'error', available: true, lastError: scrubError(error) });
        }
      });
      if (useSystemdRun) {
        child.once('exit', (code) => {
          if (activeLaunch && activeLaunch.token === reservation.token) {
            activeLaunch.wrapperExited = true;
            activeLaunch.wrapperExitCode = code;
          }
          if (closed) return;
          if (code && releaseUpdateLock(lockPath, reservation.token)) {
            if (activeLaunch && activeLaunch.token === reservation.token) activeLaunch = null;
            persist({ phase: 'error', available: true, lastError: `systemd-run terminato con codice ${code}` });
            return;
          }
          // systemd-run returns after scheduling the transient unit. The runner
          // must adopt the reservation promptly; otherwise release a dead lock.
          const adoptTimer = setTimer(() => {
            adoptionTimers.delete(adoptTimer);
            if (closed) return;
            const lock = readLock(lockPath);
            if (lock?.token === reservation.token && lock.pid === process.pid
              && releaseUpdateLock(lockPath, reservation.token)) {
              if (activeLaunch && activeLaunch.token === reservation.token) activeLaunch = null;
              persist({ phase: 'error', available: true, lastError: 'runner aggiornamento non avviato' });
            }
          }, 15_000);
          adoptionTimers.add(adoptTimer);
          if (typeof adoptTimer.unref === 'function') adoptTimer.unref();
        });
      } else {
        child.once('exit', () => {
          if (activeLaunch && activeLaunch.token === reservation.token) {
            activeLaunch.directChildExited = true;
          }
        });
      }
    }
    persist({ updaterPid: child.pid });
    if (typeof child.unref === 'function') child.unref();
    return status();
  };

  const check = async ({ autoApply = false } = {}) => {
    if (!supported) return status();
    if (checking) return checking;
    if (closed) return status();
    checking = (async () => {
      status();
      if (closed || state.phase === 'installing' || state.phase === 'restarting' || activeLock()) return status();
      persist({ phase: 'checking', lastError: '' });
      try {
        const latest = await lookupLatest();
        if (closed) return status();
        if (parseVersion(latest)?.prerelease.length) throw new Error('npm latest punta a una prerelease: aggiornamento rifiutato');
        const available = isNewer(latest, currentVersion);
        const blocked = state.blockedVersion === latest;
        persist({
          phase: blocked ? 'error' : available ? 'available' : 'idle', latest, available,
          lastCheckedAt: new Date().toISOString(),
          lastError: blocked ? (state.lastError || `versione ${latest} bloccata dopo rollback`) : '',
        });
        if (!closed && available && !blocked && autoApply && enabled) {
          try { return launch(latest); } catch (error) { if (error && error.code === 'update-backoff') return status(); throw error; }
        }
        return status();
      } catch (e) {
        if (closed) return status();
        return persist({ phase: 'error', lastCheckedAt: new Date().toISOString(), lastError: scrubError(e) });
      } finally { checking = null; }
    })();
    return checking;
  };

  const apply = async () => {
    if (closed) {
      const error = new Error('updater chiuso');
      error.status = 503;
      error.code = 'update-disarmed';
      throw error;
    }
    if (!supported) throw new Error('auto-update disponibile solo nell’installazione npm globale');
    if (readonly) throw new Error('READONLY: auto-update bloccato');
    status();
    if (state.phase === 'installing' || state.phase === 'restarting' || activeLock()) {
      const error = new Error('aggiornamento già in corso'); error.status = 409; error.code = 'update-busy'; throw error;
    }
    const latest = state.latest && isNewer(state.latest, currentVersion)
      ? state.latest : (await check()).latest;
    if (closed) {
      const error = new Error('updater chiuso');
      error.status = 503;
      error.code = 'update-disarmed';
      throw error;
    }
    if (!latest || !isNewer(latest, currentVersion)) return status();
    return launch(latest, { manual: true });
  };

  const schedule = (delay) => {
    if (closed || !enabled || !supported || readonly || timer) return;
    timer = setTimer(async () => {
      timer = null;
      if (closed) return;
      await check({ autoApply: true });
      if (!closed) schedule(intervalMs);
    }, Math.max(0, delay));
    if (typeof timer.unref === 'function') timer.unref();
  };

  const closeTimersOnly = () => {
    if (timer) {
      clearTimer(timer);
      timer = null;
      cancelledTimersCount += 1;
    }
    for (const adoptTimer of adoptionTimers) {
      clearTimer(adoptTimer);
      cancelledTimersCount += 1;
    }
    adoptionTimers.clear();
  };

  const start = () => {
    if (closed) return;
    schedule(initialCheckDelayMs({ lastCheckedAt: readState(statusPath).lastCheckedAt, intervalMs, initialDelayMs }));
  };

  const disarm = () => {
    const first = !closed;
    closed = true;
    closeTimersOnly();
    return first;
  };

  const close = () => {
    disarm();
  };

  const setEnabled = (value) => {
    if (closed) return status();
    enabled = value === true && !readonly;
    closeTimersOnly();
    if (enabled) schedule(250);
    return status();
  };

  function raceConsumerWithDeadline(promise, dlMono) {
    const tracked = Promise.resolve().then(() => promise);
    tracked.catch(() => {});
    const isExpired = () => Number.isFinite(dlMono) && nowMono() >= dlMono;
    const rem = Number.isFinite(dlMono) ? Math.max(0, dlMono - nowMono()) : 0;
    if (rem <= 0) {
      return Promise.race([
        tracked.then(() => ({ timedOut: isExpired() }), () => ({ timedOut: isExpired() })),
        Promise.resolve({ timedOut: true }),
      ]);
    }
    return new Promise((resolve) => {
      let settled = false;
      let t = null;
      const done = (res) => {
        if (settled) return;
        settled = true;
        if (t !== null) {
          clearTimer(t);
          t = null;
        }
        resolve(res);
      };
      t = setTimer(() => {
        t = null;
        done({ timedOut: true });
      }, rem);
      tracked.then(
        () => done({ timedOut: isExpired() }),
        () => done({ timedOut: isExpired() }),
      );
    });
  }

  function classifyDetachedUpdateState() {
    const diskLock = inspectLockStrict(lockPath);
    const diskState = inspectJsonFileStrict(statusPath);
    const diskPhase = diskState.kind === 'ok' && typeof diskState.value.phase === 'string'
      ? diskState.value.phase : null;
    const stateIsActivePhase = diskPhase === 'installing' || diskPhase === 'restarting';

    if (diskLock.kind === 'invalid' || diskState.kind === 'invalid') {
      return { quiescent: false, handoff: false, code: 'UPDATE_IN_PROGRESS' };
    }

    if (activeLaunch) {
      if (diskLock.kind === 'ok') {
        const lk = diskLock.value;
        const tokenMatch = lk.token === activeLaunch.token;
        const adoptedByRunnerPid = Number.isFinite(lk.adoptedAt)
          && lk.pid !== process.pid
          && (!activeLaunch.useSystemdRun || lk.pid !== activeLaunch.launcherPid);
        const runnerAlive = isPidLiveRunner(lk.pid);
        const stateCoherent = diskState.kind === 'ok'
          && stateIsActivePhase
          && diskState.value.targetVersion === activeLaunch.targetVersion
          && diskState.value.updaterPid === lk.pid;
        if (tokenMatch && adoptedByRunnerPid && runnerAlive && stateCoherent) {
          return { quiescent: false, handoff: true, code: 'UPDATE_HANDOFF' };
        }
        return { quiescent: false, handoff: false, code: 'UPDATE_IN_PROGRESS' };
      }

      // diskLock is missing after a launch in this process
      if (stateIsActivePhase) {
        return { quiescent: false, handoff: false, code: 'UPDATE_IN_PROGRESS' };
      }
      if (!activeLaunch.useSystemdRun && !activeLaunch.directChildExited && isPidLiveRunner(activeLaunch.launcherPid)) {
        return { quiescent: false, handoff: false, code: 'UPDATE_IN_PROGRESS' };
      }
      if (diskState.kind === 'ok' && (diskPhase === 'installed' || diskPhase === 'idle' || diskPhase === 'error')) {
        const upPid = diskState.value.updaterPid;
        const pidStillRunning = Number.isInteger(upPid) && upPid > 0 && upPid !== process.pid && isPidLiveRunner(upPid);
        if (pidStillRunning) {
          return { quiescent: false, handoff: false, code: 'UPDATE_IN_PROGRESS' };
        }
        return { quiescent: true, handoff: false, code: null };
      }
      return { quiescent: false, handoff: false, code: 'UPDATE_IN_PROGRESS' };
    }

    // No launch from this instance: never claim handoff, still inspect persisted lock/state
    if (diskLock.kind === 'ok' || stateIsActivePhase) {
      return { quiescent: false, handoff: false, code: 'UPDATE_IN_PROGRESS' };
    }
    return { quiescent: true, handoff: false, code: null };
  }

  const drain = async ({ deadlineMono } = {}) => {
    disarm();
    const waitList = [];
    if (checking) waitList.push(checking);
    for (const c of activeConsumers) waitList.push(c);

    let timedOut = false;
    if (waitList.length > 0) {
      const waitRes = await raceConsumerWithDeadline(Promise.all(waitList), deadlineMono);
      if (waitRes.timedOut) timedOut = true;
    }

    const inProcessRemaining = (checking ? 1 : 0) + activeConsumers.size + unattestedConsumers;
    if (Number.isFinite(deadlineMono) && nowMono() >= deadlineMono && inProcessRemaining > 0) {
      timedOut = true;
    }

    const detached = classifyDetachedUpdateState();
    const codes = [];
    if (timedOut || inProcessRemaining > 0) {
      codes.push('UPDATE_IN_PROGRESS');
    }
    if (detached.code) {
      codes.push(detached.code);
    }
    const activeOpsRemaining = inProcessRemaining + (detached.quiescent ? 0 : 1);
    const quiescent = !timedOut && inProcessRemaining === 0 && detached.quiescent;
    return {
      quiescent,
      timedOut,
      handoff: detached.handoff,
      activeOpsRemaining,
      cancelledTimers: cancelledTimersCount,
      codes: [...new Set(codes)],
    };
  };

  return { status, check, apply, start, close, disarm, drain, setEnabled, supported };
}

module.exports = {
  DEFAULT_INITIAL_DELAY_MS, DEFAULT_INTERVAL_MS, DEFAULT_MAX_LOG_BYTES, packageRoot, isGlobalInstall,
  isNewer, pidAlive, lookupLatestNpm, createNpmUpdater,
};
