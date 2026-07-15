'use strict';
// Service/portable runtime ownership and start/stop lifecycle. Extracted from
// commands.js (Phase 3 modularization) without behavior change: identical opts
// seams, return objects, log text, platform branches, tmux-survival fail-closed
// logic, tunnel cleanup and pidfile handling. No public CLI surface changes.
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { detectPlatform, nodeBin, repoRoot, uid } = require('./platform.js');
const { installPath: serviceInstallPath, ensureLinuxTmuxSurvival } = require('./service.js');
const pidf = require('./pidfile.js');
const urlmod = require('./url.js');
const nodesStore = require('../nodes/store.js');
const nodesTunnel = require('../nodes/tunnel.js');

// start per-platform. execImpl/spawnImpl per test.
function start(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const execImpl = opts.execImpl || execFileSync;
  const spawnImpl = opts.spawnImpl || spawn;
  const log = opts.log || console.log;

  if (platform === 'linux') {
    execImpl('systemctl', ['--user', 'start', 'nexuscrew'], { stdio: 'ignore' });
    log('start: systemctl --user start nexuscrew');
    return { platform, started: true };
  }
  if (platform === 'mac') {
    const domain = `gui/${opts.uid || uid()}`;
    const label = `${domain}/com.mmmbuto.nexuscrew`;
    try {
      execImpl('launchctl', ['kickstart', '-k', label], { stdio: 'ignore' });
    } catch (_) {
      try {
        const home = opts.home || require('node:os').homedir();
        const plist = opts.installPath || serviceInstallPath('mac', home);
        execImpl('launchctl', ['bootstrap', domain, plist], { stdio: 'ignore' });
        execImpl('launchctl', ['kickstart', '-k', label], { stdio: 'ignore' });
      } catch (e) {
        const reason = String(e.message || e);
        log(`start: launchctl fallito: ${reason}`);
        return { platform, started: false, reason };
      }
    }
    log(`start: launchctl kickstart ${label}`);
    return { platform, started: true };
  }
  if (platform === 'termux') {
    const home = opts.home || require('node:os').homedir();
    // already-running?
    const pidPath = pidf.defaultPidfilePath(opts.home);
    const meta = pidf.readPidfile(pidPath);
    if (meta && pidf.isAlive(meta)) {
      log(`already running (pid ${meta.pid}) — pidfile ${pidPath}`);
      return { platform, started: false, reason: 'already running' };
    }
    pidf.cleanStale(pidPath);
    const repoBin = path.join(repoRoot(), 'bin', 'nexuscrew.js');
    const logPath = path.join(home, '.nexuscrew', 'nexuscrew.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, 'a');
    const resolved = urlmod.resolvePaths(opts);
    const childEnv = {
      ...process.env,
      HOME: home,
      NEXUSCREW_CONFIG_FILE: resolved.configPath,
      NEXUSCREW_TOKEN_FILE: resolved.tokenPath,
    };
    // config.json is authoritative after automatic port fallback.
    delete childEnv.NEXUSCREW_PORT;
    let child;
    try {
      child = spawnImpl(nodeBin(), [repoBin, 'serve', '--pidfile'], {
        detached: true, stdio: ['ignore', logFd, logFd], env: childEnv,
      });
    } finally { try { fs.closeSync(logFd); } catch (_) {} }
    if (child && typeof child.unref === 'function') child.unref();
    log(`start: nohup ${nodeBin()} ${repoBin} serve --pidfile (>> ${logPath})`);
    return { platform, started: true, pid: child && child.pid };
  }
  throw new Error(`start: platform ${platform} non supportata`);
}

function stopManagedTunnels(opts = {}) {
  const home = opts.home || require('node:os').homedir();
  const { configDir } = urlmod.resolvePaths(opts);
  const nodesPath = opts.nodesPath || path.join(configDir, 'nodes.json');
  const st = nodesStore.loadStore(nodesPath);
  const stopped = [];
  for (const node of (st && st.nodes) || []) {
    if (node.direction === 'inbound') continue;
    try { nodesTunnel.stopTunnel({ home, name: node.name }); stopped.push(node.name); } catch (_) {}
  }
  if (st && st.rendezvous) {
    try { nodesTunnel.stopTunnel({ home, name: nodesTunnel.REVERSE_NAME }); stopped.push(nodesTunnel.REVERSE_NAME); } catch (_) {}
  }
  // Also recover supervisors whose node was already removed by an older or
  // interrupted runtime. The pidfile verifier prevents broad process kills.
  const recovered = nodesTunnel.reconcileTunnelSupervisors({ home, configuredNames: [] });
  for (const name of [...recovered.stopped, ...recovered.cleaned]) {
    if (!stopped.includes(name)) stopped.push(name);
  }
  return stopped;
}

function refusePairedPortRelocation(opts, from, to) {
  if (Number(from) === Number(to)) return;
  const { configDir } = urlmod.resolvePaths(opts);
  const nodesPath = opts.nodesPath || path.join(configDir, 'nodes.json');
  if (nodesStore.hasPairedPeers(nodesStore.loadStore(nodesPath))) {
    throw new Error(`port ${from} is busy and paired peers exist; refusing automatic move to ${to}. Free the configured port or reconnect peers intentionally.`);
  }
}

// Runtime ownership is independent from boot persistence.  With boot disabled,
// smartUp intentionally launches `serve --pidfile` on Linux/macOS too; lifecycle
// commands must therefore inspect both the service manager and that portable
// pidfile instead of assuming the platform selects exactly one owner.
function managedRuntimeState(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const execImpl = opts.execImpl || execFileSync;
  if (platform === 'linux') {
    try {
      const service = String(execImpl('systemctl', ['--user', 'is-active', 'nexuscrew'], { encoding: 'utf8' }) || '').trim();
      return { supported: true, running: service === 'active', service: service || 'inactive' };
    } catch (_) { return { supported: true, running: false, service: 'inactive' }; }
  }
  if (platform === 'mac') {
    const service = `gui/${opts.uid || uid()}/com.mmmbuto.nexuscrew`;
    try {
      execImpl('launchctl', ['print', service], { stdio: 'ignore' });
      return { supported: true, running: true, service };
    } catch (_) { return { supported: true, running: false, service }; }
  }
  return { supported: false, running: false, service: 'portable-only' };
}

function portableRuntimeState(opts = {}) {
  const home = opts.home || require('node:os').homedir();
  const pidPath = pidf.defaultPidfilePath(home);
  const meta = pidf.readPidfile(pidPath);
  if (!meta) return { running: false, pidPath, reason: 'no pidfile' };
  if (pidf.isAlive(meta)) return { running: true, pidPath, pid: meta.pid, meta };
  pidf.cleanStale(pidPath);
  return { running: false, pidPath, reason: 'stale pidfile' };
}

function resolveRuntimeOwner(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const managed = managedRuntimeState({ ...opts, platform });
  const portable = portableRuntimeState(opts);
  let owner = 'stopped';
  if (managed.running && portable.running) owner = 'conflict';
  else if (managed.running) owner = 'managed';
  else if (portable.running) owner = 'portable';
  return {
    platform, owner,
    managedRunning: managed.running,
    portableRunning: portable.running,
    service: managed.service,
    portablePid: portable.pid,
    pidPath: portable.pidPath,
    stalePidfile: portable.reason === 'stale pidfile',
    portableReason: portable.reason,
  };
}

function waitForPidExit(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const exited = () => {
    if (!pidf.pidExists(pid)) return true;
    // A test-owned child can remain as a zombie until this synchronous caller
    // returns to the event loop. It no longer owns sockets and is exited for
    // lifecycle purposes. Linux/Termux expose the state in /proc; macOS has no
    // equivalent cheap path and normally removes a non-child immediately.
    try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] === 'Z'; }
    catch (_) { return false; }
  };
  while (!exited() && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 25);
  return exited();
}

function stopPortableRuntime(opts = {}) {
  const home = opts.home || require('node:os').homedir();
  const pidPath = pidf.defaultPidfilePath(home);
  const result = pidf.killPidfile(pidPath);
  if (result.killed && !waitForPidExit(result.pid, opts.stopWaitMs || 2000)) {
    return { ...result, killed: false, reason: `pid ${result.pid} did not exit after SIGTERM` };
  }
  return result;
}

function stop(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const execImpl = opts.execImpl || execFileSync;
  const log = opts.log || console.log;
  if (!['linux', 'mac', 'termux'].includes(platform)) throw new Error(`stop: platform ${platform} non supportata`);

  const before = resolveRuntimeOwner({ ...opts, platform, execImpl });
  const stoppedOwners = [];
  const errors = [];

  // The shared tmux server can live in the NexusCrew systemd cgroup.  If the
  // effective KillMode cannot be proven safe, stop must not mutate *any*
  // runtime owner or detached tunnel: callers can then fix the unit and retry
  // without ending up in a partially stopped state.
  if (before.managedRunning && platform === 'linux') {
    try {
      (opts.ensureTmuxSurvivalImpl || ensureLinuxTmuxSurvival)({ ...opts, home: opts.home, execImpl });
    } catch (error) {
      const reason = String(error.message || error);
      log(`stop: annullato — protezione tmux non verificata: ${reason}`);
      return { platform, owner: before.owner, stopped: false, stoppedOwners, reason };
    }
  }

  if (before.managedRunning) {
    try {
      if (platform === 'linux') {
        execImpl('systemctl', ['--user', 'stop', 'nexuscrew'], { stdio: 'ignore' });
        log('stop: systemctl --user stop nexuscrew');
      } else {
        const label = `gui/${opts.uid || uid()}/com.mmmbuto.nexuscrew`;
        // bootout unloads KeepAlive, so a voluntary stop stays stopped.
        execImpl('launchctl', ['bootout', label], { stdio: 'ignore' });
        log(`stop: launchctl bootout ${label}`);
      }
      stoppedOwners.push('managed');
    } catch (error) { errors.push(String(error.message || error)); }
  }

  if (before.portableRunning) {
    const portable = (opts.stopPortableImpl || stopPortableRuntime)(opts);
    if (portable.killed) {
      stoppedOwners.push('portable');
      log(`stop: killed portable pid ${portable.pid}`);
    } else errors.push(portable.reason || 'portable stop failed');
  }

  // Detached tunnel supervisors are outside both server owners. A real stop
  // closes them once; the next start restores only autostart:true links.
  (opts.stopTunnelsImpl || stopManagedTunnels)(opts);
  if (platform === 'termux') {
    try { execImpl('termux-wake-lock-release', [], { stdio: 'ignore' }); } catch (_) {}
  }

  if (errors.length) {
    const reason = errors.join('; ');
    log(`stop: incompleto — ${reason}`);
    return { platform, owner: before.owner, stopped: false, stoppedOwners, reason };
  }
  const alreadyStopped = before.owner === 'stopped';
  if (alreadyStopped) log(`stop: ${before.portableReason || 'already stopped'}`);
  return {
    platform, owner: before.owner, stopped: true, stoppedOwners, alreadyStopped,
    reason: alreadyStopped ? (before.portableReason || 'already stopped') : undefined,
  };
}

// running-check per-platform (no log) — riusato da smart-up / token rotate / update.
function isServiceRunning(opts = {}) {
  return resolveRuntimeOwner(opts).owner !== 'stopped';
}

function bootState(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const execImpl = opts.execImpl || execFileSync;
  const home = opts.home || require('node:os').homedir();
  if (platform === 'linux') {
    try { return { platform, enabled: execImpl('systemctl', ['--user', 'is-enabled', 'nexuscrew'], { encoding: 'utf8' }).trim() === 'enabled' }; }
    catch (_) { return { platform, enabled: false }; }
  }
  try { return { platform, enabled: fs.lstatSync(serviceInstallPath(platform, home)).isFile() }; }
  catch (_) { return { platform, enabled: false }; }
}

function unlinkRegular(target) {
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`refusing unsafe boot target: ${target}`);
    fs.unlinkSync(target); return true;
  } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

module.exports = {
  start,
  stopManagedTunnels,
  refusePairedPortRelocation,
  managedRuntimeState,
  portableRuntimeState,
  resolveRuntimeOwner,
  waitForPidExit,
  stopPortableRuntime,
  stop,
  isServiceRunning,
  bootState,
  unlinkRegular,
};
