'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const {
  PACKAGE_NAME, compareVersions, parseVersion, registryVersion, scrubError, pidAlive, readLock,
  acquireUpdateLock, releaseUpdateLock, readState, writeState,
} = require('./core.js');

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

function lookupLatestNpm({ execFileImpl = execFile, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl('npm', ['view', `${PACKAGE_NAME}@latest`, 'version', '--json'], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(registryVersion(stdout)); } catch (e) { reject(e); }
    });
  });
}

function createNpmUpdater(opts = {}) {
  const currentVersion = String(opts.currentVersion || require('../../package.json').version);
  const home = opts.home || os.homedir();
  const statusPath = opts.statusPath || path.join(home, '.nexuscrew', 'npm-update.json');
  const logPath = opts.logPath || path.join(home, '.nexuscrew', 'npm-update.log');
  const lockPath = opts.lockPath || path.join(home, '.nexuscrew', 'npm-update.lock');
  const runnerPath = opts.runnerPath || path.join(__dirname, 'runner.js');
  const supported = opts.supported === undefined ? isGlobalInstall(opts.packageRoot) : !!opts.supported;
  const readonly = opts.readonly === true;
  const lookupLatest = opts.lookupLatest || (() => lookupLatestNpm(opts));
  const spawnImpl = opts.spawnImpl || spawn;
  const useSystemdRun = opts.useSystemdRun === undefined
    ? (process.platform === 'linux' && !!process.env.INVOCATION_ID)
    : opts.useSystemdRun === true;
  const initialDelayMs = opts.initialDelayMs === undefined ? DEFAULT_INITIAL_DELAY_MS : opts.initialDelayMs;
  const intervalMs = opts.intervalMs === undefined ? DEFAULT_INTERVAL_MS : opts.intervalMs;
  const maxLogBytes = opts.maxLogBytes === undefined ? DEFAULT_MAX_LOG_BYTES : opts.maxLogBytes;
  let enabled = opts.enabled !== false && !readonly;
  let checking = null;
  let timer = null;
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
  const activeLock = () => { const lock = readLock(lockPath); return !!(lock && pidAlive(lock.pid)); };
  if ((state.phase === 'installing' || state.phase === 'restarting') && !pidAlive(state.updaterPid) && !activeLock()) {
    state = { ...state, phase: 'error', lastError: 'aggiornamento precedente interrotto' };
    writeState(statusPath, state);
  }

  const persist = (patch) => {
    state = { ...state, ...patch };
    writeState(statusPath, state);
    return status();
  };

  const status = () => {
    state = { ...state, ...readState(statusPath) };
    return {
      supported, enabled, current: currentVersion,
      phase: state.phase || 'idle', latest: state.latest || '',
      available: state.available === true && isNewer(state.latest, currentVersion),
      lastCheckedAt: state.lastCheckedAt || '', lastUpdatedAt: state.lastUpdatedAt || '',
      lastError: state.lastError || '', blockedVersion: state.blockedVersion || '',
    };
  };

  const launch = (version) => {
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
    const reservation = acquireUpdateLock(lockPath);
    if (!reservation.ok) {
      const error = new Error('aggiornamento già in corso'); error.status = 409; error.code = 'update-busy'; throw error;
    }
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    try {
      const logStat = fs.lstatSync(logPath);
      if (!logStat.isFile() || logStat.isSymbolicLink()) throw new Error('update log target non sicuro');
      if (logStat.size > maxLogBytes) fs.truncateSync(logPath, 0);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        releaseUpdateLock(lockPath, reservation.token);
        persist({ phase: 'error', available: true, lastError: scrubError(error) });
        throw error;
      }
    }
    const fd = fs.openSync(logPath, 'a', 0o600);
    let child;
    try {
      persist({ phase: 'installing', targetVersion: version, latest: version, available: true, lastError: '' });
      const runnerArgs = [runnerPath, '--version', version, '--status', statusPath, '--home', home,
        '--lock', lockPath, '--lock-token', reservation.token];
      const bin = useSystemdRun ? 'systemd-run' : process.execPath;
      const argv = useSystemdRun
        ? ['--user', '--quiet', '--collect', `--unit=nexuscrew-update-${process.pid}-${Date.now()}`,
          `--property=StandardOutput=append:${logPath}`, `--property=StandardError=append:${logPath}`,
          process.execPath, ...runnerArgs]
        : runnerArgs;
      child = spawnImpl(bin, argv, {
        detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, NEXUSCREW_UPDATE_RUNNER: '1' },
      });
    } catch (e) {
      releaseUpdateLock(lockPath, reservation.token);
      persist({ phase: 'error', available: true, lastError: scrubError(e) });
      throw e;
    } finally {
      try { fs.closeSync(fd); } catch (_) {}
    }
    if (child && typeof child.once === 'function') {
      child.once('error', (error) => {
        if (releaseUpdateLock(lockPath, reservation.token)) {
          persist({ phase: 'error', available: true, lastError: scrubError(error) });
        }
      });
      if (useSystemdRun) child.once('exit', (code) => {
        if (code && releaseUpdateLock(lockPath, reservation.token)) {
          persist({ phase: 'error', available: true, lastError: `systemd-run terminato con codice ${code}` });
          return;
        }
        // systemd-run returns after scheduling the transient unit. The runner
        // must adopt the reservation promptly; otherwise release a dead lock.
        const timer = setTimeout(() => {
          const lock = readLock(lockPath);
          if (lock?.token === reservation.token && lock.pid === process.pid
            && releaseUpdateLock(lockPath, reservation.token)) {
            persist({ phase: 'error', available: true, lastError: 'runner aggiornamento non avviato' });
          }
        }, 15_000);
        if (typeof timer.unref === 'function') timer.unref();
      });
    }
    if (!child || !Number.isInteger(child.pid)) {
      releaseUpdateLock(lockPath, reservation.token);
      const error = new Error('impossibile avviare il processo di aggiornamento');
      persist({ phase: 'error', available: true, lastError: error.message });
      throw error;
    }
    persist({ updaterPid: child.pid });
    if (typeof child.unref === 'function') child.unref();
    return status();
  };

  const check = async ({ autoApply = false } = {}) => {
    if (!supported) return status();
    if (checking) return checking;
    checking = (async () => {
      status();
      if (state.phase === 'installing' || state.phase === 'restarting' || activeLock()) return status();
      persist({ phase: 'checking', lastError: '' });
      try {
        const latest = await lookupLatest();
        if (parseVersion(latest)?.prerelease.length) throw new Error('npm latest punta a una prerelease: aggiornamento rifiutato');
        const available = isNewer(latest, currentVersion);
        const blocked = state.blockedVersion === latest;
        persist({
          phase: blocked ? 'error' : available ? 'available' : 'idle', latest, available,
          lastCheckedAt: new Date().toISOString(),
          lastError: blocked ? (state.lastError || `versione ${latest} bloccata dopo rollback`) : '',
        });
        if (available && !blocked && autoApply && enabled) return launch(latest);
        return status();
      } catch (e) {
        return persist({ phase: 'error', lastCheckedAt: new Date().toISOString(), lastError: scrubError(e) });
      } finally { checking = null; }
    })();
    return checking;
  };

  const apply = async () => {
    if (!supported) throw new Error('auto-update disponibile solo nell’installazione npm globale');
    if (readonly) throw new Error('READONLY: auto-update bloccato');
    status();
    if (state.phase === 'installing' || state.phase === 'restarting' || activeLock()) {
      const error = new Error('aggiornamento già in corso'); error.status = 409; error.code = 'update-busy'; throw error;
    }
    const latest = state.latest && isNewer(state.latest, currentVersion)
      ? state.latest : (await check()).latest;
    if (!latest || !isNewer(latest, currentVersion)) return status();
    return launch(latest);
  };

  const schedule = (delay) => {
    if (!enabled || !supported || readonly || timer) return;
    timer = setTimeout(async () => {
      timer = null;
      await check({ autoApply: true });
      schedule(intervalMs);
    }, Math.max(0, delay));
    if (typeof timer.unref === 'function') timer.unref();
  };

  const start = () => schedule(initialDelayMs);
  const close = () => { if (timer) clearTimeout(timer); timer = null; };
  const setEnabled = (value) => {
    enabled = value === true && !readonly;
    close();
    if (enabled) schedule(250);
    return status();
  };

  return { status, check, apply, start, close, setEnabled, supported };
}

module.exports = {
  DEFAULT_INITIAL_DELAY_MS, DEFAULT_INTERVAL_MS, DEFAULT_MAX_LOG_BYTES, packageRoot, isGlobalInstall,
  isNewer, pidAlive, lookupLatestNpm, createNpmUpdater,
};
