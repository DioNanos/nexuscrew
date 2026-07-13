'use strict';
// Minimal public CLI plus internal service/MCP entry points. [M6][R1]
// serve = foreground HTTP (+ --pidfile lifecycle su Termux/manuale).
// start/stop/status = per-platform: linux (systemctl --user), mac (launchctl),
// termux (nohup serve --pidfile + pidfile verificato; status boot-script vs running).
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { detectPlatform, nodeBin, repoRoot, uid } = require('./platform.js');
const { installPath: serviceInstallPath } = require('./service.js');
const { fleetInstallPath } = require('./fleet-service.js');
const pidf = require('./pidfile.js');
const { runInit } = require('./init.js');
const { rotateToken } = require('../auth/token.js');
const urlmod = require('./url.js');
const { doctor } = require('./doctor.js');
const nodesStore = require('../nodes/store.js');
const nodesTunnel = require('../nodes/tunnel.js');

const HELP = `NexusCrew — PWA for local and remote AI workers.

Usage:
  nexuscrew          start in background; show status and quick guide
  nexuscrew show     start when needed and open the authenticated PWA
  nexuscrew show token  print the clickable authenticated URL
  nexuscrew boot     enable startup at boot (use: boot off|status)
  nexuscrew status   show service, port, roles and node status
  nexuscrew stop     stop the background service
  nexuscrew restart  restart the background service
  nexuscrew doctor   run local diagnostics
  nexuscrew help     show this help
  nexuscrew version  show the installed version

Configuration, nodes, engines, providers, models and lifecycle live in the PWA.
NexusCrew binds only to 127.0.0.1 and automatically selects a free port.`;

// valueFlags (Set|array opzionale): flag che consumano il token successivo nella
// forma "--k v". Omesso -> comportamento storico (solo "--k" bool o "--k=v").
function parseFlags(argv, valueFlags) {
  const vf = valueFlags instanceof Set ? valueFlags
    : (Array.isArray(valueFlags) ? new Set(valueFlags) : null);
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        if (vf && vf.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          flags[key] = argv[i + 1]; i += 1; // consuma il valore (forma "--k v")
        } else {
          flags[key] = true;
        }
      }
    } else rest.push(a);
  }
  return { flags, rest };
}

function serve(opts = {}) {
  const serverStart = opts.serverStart || require('../server.js').start;
  if (opts.pidfile) {
    const pidPath = pidf.defaultPidfilePath(opts.home);
    // already-running check
    const meta = pidf.readPidfile(pidPath);
    if (meta && pidf.isAlive(meta)) {
      throw new Error(`already running (pid ${meta.pid}) — pidfile ${pidPath}`);
    }
    pidf.cleanStale(pidPath);
    const cmd = [process.execPath].concat(process.argv.slice(1)).join(' ');
    pidf.writePidfile(pidPath, process.pid, cmd);
    const cleanup = () => pidf.removePidfile(pidPath);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('exit', cleanup);
  }
  serverStart(opts);
}

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

async function bootOn(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const quiet = opts.lifecycleLog || (() => {});
  const { configPath, tokenPath } = urlmod.resolvePaths(opts);
  if (!fs.existsSync(configPath) || !urlmod.readToken(tokenPath)) {
    const selected = await findAvailablePort(opts.port || urlmod.loadPort(opts), opts);
    (opts.runInitImpl || runInit)({ ...opts, platform, port: selected, installBoot: false, printUrl: false, log: quiet });
  }
  try { pidf.killPidfile(pidf.defaultPidfilePath(opts.home)); } catch (_) {}
  (opts.runInitImpl || runInit)({ ...opts, platform, installBoot: true, printUrl: false, log: quiet });
  const result = await smartUp({ ...opts, platform });
  return { ...result, boot: bootState({ ...opts, platform }).enabled };
}

async function bootOff(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const execImpl = opts.execImpl || execFileSync;
  const home = opts.home || require('node:os').homedir();
  if (platform === 'linux') {
    try { execImpl('systemctl', ['--user', 'disable', 'nexuscrew'], { stdio: 'ignore' }); } catch (_) {}
    try { execImpl('systemctl', ['--user', 'disable', 'nexuscrew-fleet.service'], { stdio: 'ignore' }); } catch (_) {}
  } else if (platform === 'mac') {
    const domain = `gui/${opts.uid || uid()}`;
    try { execImpl('launchctl', ['bootout', `${domain}/com.mmmbuto.nexuscrew`], { stdio: 'ignore' }); } catch (_) {}
    try { execImpl('launchctl', ['bootout', `${domain}/com.mmmbuto.nexuscrew-fleet`], { stdio: 'ignore' }); } catch (_) {}
    unlinkRegular(serviceInstallPath(platform, home));
    try { unlinkRegular(fleetInstallPath(platform, home)); } catch (_) {}
    const { tokenPath } = urlmod.resolvePaths(opts); const port = urlmod.loadPort(opts); const token = urlmod.readToken(tokenPath);
    if (!(await probeNexusCrew(port, token, opts))) {
      startPortable({ ...opts, platform });
      await waitForNexusCrew(port, token, opts);
    }
  } else if (platform === 'termux') {
    unlinkRegular(serviceInstallPath(platform, home));
    try { unlinkRegular(fleetInstallPath(platform, home)); } catch (_) {}
  }
  return { platform, enabled: false, running: isServiceRunning({ ...opts, platform }) || !!pidf.readPidfile(pidf.defaultPidfilePath(home)) };
}

function quickSummary(result, opts = {}) {
  const log = opts.log || console.log;
  const platform = result.platform || opts.platform || detectPlatform();
  const home = opts.home || require('node:os').homedir();
  const { configDir } = urlmod.resolvePaths(opts);
  const st = nodesStore.loadStore(opts.nodesPath || path.join(configDir, 'nodes.json'));
  let cached = [];
  try { cached = (require('../nodes/topology-cache.js').loadCache(opts.topologyCachePath || require('../nodes/topology-cache.js').defaultPath(home)) || {}).nodes || []; } catch (_) {}
  const direct = (st && st.nodes) || [];
  const managed = direct.filter((n) => n.direction !== 'inbound');
  const online = managed.filter((n) => nodesTunnel.readTunnelState(home, n.name).status === 'up').length;
  const known = direct.length + cached.filter((n) => !direct.some((d) => d.nodeId && d.nodeId === n.instanceId)).length;
  log(`NexusCrew ${require('../../package.json').version}`);
  log(`server  ${result.running ? '● running' : '○ stopped'} · 127.0.0.1:${result.port}`);
  log(`boot    ${bootState({ ...opts, platform }).enabled ? 'on' : 'off'} · ${platform}`);
  log(`nodes   ${known} known · ${online}/${managed.length} hub connections up`);
  log('');
  log('open    nexuscrew show');
  log('link    nexuscrew show token');
  log('boot    nexuscrew boot');
  log('check   nexuscrew doctor');
}

// Ruoli client/node dal config.json (default entrambi off — B0 li popola dal wizard UI).
function readRoles(configPath) {
  try {
    const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const r = c && c.roles;
    return { client: !!(r && r.client), node: !!(r && r.node) };
  } catch (_) { return { client: false, node: false }; }
}

function status(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const execImpl = opts.execImpl || execFileSync;
  const log = opts.log || console.log;
  const home = opts.home || require('node:os').homedir();
  const { configPath, configDir } = urlmod.resolvePaths(opts);
  const nodesPath = opts.nodesPath || path.join(configDir, 'nodes.json');

  const runtime = resolveRuntimeOwner({ ...opts, platform, execImpl });
  const out = {
    platform, service: runtime.service, running: runtime.owner !== 'stopped',
    runtimeOwner: runtime.owner, managedRunning: runtime.managedRunning,
    portableRunning: runtime.portableRunning, portablePid: runtime.portablePid,
    port: null, url: null, roles: null, nodes: [],
  };

  if (platform === 'termux') {
    // boot-script installed vs server running (pidfile vivo)
    const bootScript = path.join(home, '.termux', 'boot', 'nexuscrew.sh');
    out.bootScriptInstalled = fs.existsSync(bootScript);
    out.service = out.bootScriptInstalled ? 'boot-script installed' : 'no boot-script';
  }

  out.port = urlmod.loadPort(opts);
  out.url = urlmod.buildUrl(out.port, null, { withToken: false }); // MAI il token in status
  out.roles = readRoles(configPath);

  // nodes[] con stato tunnel REALE. Token per-nodo SEMPRE redatti (mai in status).
  // nodes.json assente/invalido -> nodes [] (non fa fallire status).
  try {
    const st = nodesStore.loadStore(nodesPath);
    if (st) {
      out.nodeId = st.nodeId;
      out.nodes = st.nodes.map((n) => {
        const red = nodesStore.redactNode(n); // hasToken, mai il token
        return {
          name: red.name, roles: red.roles,
          remotePort: red.remotePort, localPort: red.localPort,
          direction: red.direction, shared: red.shared, hasToken: red.hasToken,
          tunnel: n.direction === 'inbound'
            ? { status: n.shared === true ? 'shared-peer' : 'private-peer', managed: false }
            : nodesTunnel.readTunnelState(home, n.name),
        };
      });
    }
  } catch (_) { /* nodes opzionale: non rompe status */ }

  if (opts.json) {
    log(JSON.stringify(out, null, 2));
  } else {
    log(`platform:  ${out.platform}`);
    log(`service:   ${out.service}`);
    log(`running:   ${out.running}`);
    log(`runtime:   ${out.runtimeOwner}${out.portablePid ? ` (pid ${out.portablePid})` : ''}`);
    log(`port:      ${out.port}`);
    log(`url:       ${out.url}`);
    log(`roles:     client=${out.roles.client} node=${out.roles.node}`);
    log(`nodes:     ${out.nodes.length === 0 ? '(nessuno)' : out.nodes.map((n) => `${n.name}[${n.tunnel.status}]`).join(', ')}`);
    if (platform === 'termux') log(`boot:      ${out.bootScriptInstalled ? 'boot-script installed' : 'no boot-script'}`);
  }
  return out;
}

// restart per-platform (shared da token rotate / update). execImpl per test.
function restart(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const execImpl = opts.execImpl || execFileSync;
  const log = opts.log || console.log;
  if (!['linux', 'mac', 'termux'].includes(platform)) throw new Error(`restart: platform ${platform} non supportata`);
  const before = resolveRuntimeOwner({ ...opts, platform, execImpl });

  // A managed owner can use the service manager's atomic restart. In a
  // conflict, first remove only the stray portable owner, then keep managed as
  // the single authority.
  if (before.managedRunning) {
    if (before.portableRunning) {
      const portable = (opts.stopPortableImpl || stopPortableRuntime)(opts);
      if (!portable.killed) return { platform, owner: before.owner, restarted: false, reason: portable.reason };
    }
    try {
      if (platform === 'linux') {
        execImpl('systemctl', ['--user', 'restart', 'nexuscrew'], { stdio: 'ignore' });
        log('restart: systemctl --user restart nexuscrew');
      } else {
        const label = `gui/${opts.uid || uid()}/com.mmmbuto.nexuscrew`;
        execImpl('launchctl', ['kickstart', '-k', label], { stdio: 'ignore' });
        log(`restart: launchctl kickstart -k ${label}`);
      }
      return { platform, owner: before.owner, runtimeOwner: 'managed', restarted: true };
    } catch (error) {
      return { platform, owner: before.owner, runtimeOwner: 'managed', restarted: false, reason: String(error.message || error) };
    }
  }

  if (before.portableRunning) {
    const stopped = stop({ ...opts, platform, execImpl, log });
    if (!stopped.stopped) return { platform, owner: before.owner, restarted: false, reason: stopped.reason };
    const started = (opts.startPortableImpl || startPortable)({ ...opts, platform, spawnImpl: opts.spawnImpl });
    const ok = !!(started && started.started !== false);
    if (ok) log('restart: portable runtime started');
    return { platform, owner: before.owner, runtimeOwner: 'portable', restarted: ok, reason: ok ? undefined : started && started.reason };
  }

  // `restart` on a stopped runtime follows the explicit boot owner; with boot
  // disabled it starts a portable background runtime.
  const useManaged = platform !== 'termux' && bootState({ ...opts, platform, execImpl }).enabled;
  const started = useManaged
    ? start({ ...opts, platform, execImpl, spawnImpl: opts.spawnImpl, log })
    : (opts.startPortableImpl || startPortable)({ ...opts, platform, spawnImpl: opts.spawnImpl });
  const ok = !!(started && started.started !== false);
  if (ok) log(`restart: ${useManaged ? 'managed' : 'portable'} runtime started`);
  return { platform, owner: before.owner, runtimeOwner: useManaged ? 'managed' : 'portable', restarted: ok, reason: ok ? undefined : started && started.reason };
}

function wizardComplete(configPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return cfg && cfg.wizardDone === true;
  } catch (_) { return false; }
}

function servicePinsLegacyPort(platform, home, installPath) {
  let target;
  try { target = installPath || serviceInstallPath(platform, home); } catch (_) { return false; }
  try { return /NEXUSCREW_PORT/.test(fs.readFileSync(target, 'utf8')); } catch (_) { return false; }
}

function portAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

async function findAvailablePort(startPort, opts = {}) {
  const available = opts.portAvailableImpl || portAvailable;
  const first = Number(startPort);
  if (!Number.isInteger(first) || first < 1 || first > 65535) throw new Error(`invalid port: ${startPort}`);
  for (let port = first; port <= Math.min(65535, first + 200); port += 1) {
    if (await available(port, '127.0.0.1')) return port;
  }
  throw new Error(`no free loopback port found from ${first}`);
}

async function probeNexusCrew(port, token, opts = {}) {
  if (!token) return false;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return false;
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/api/config`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout?.(700),
    });
    return r.status === 200;
  } catch (_) { return false; }
}

async function waitForNexusCrew(port, token, opts = {}) {
  const probe = opts.probeImpl || probeNexusCrew;
  const attempts = opts.waitAttempts === undefined ? 30 : opts.waitAttempts;
  const delay = opts.waitDelayMs === undefined ? 100 : opts.waitDelayMs;
  for (let i = 0; i < attempts; i += 1) {
    if (await probe(port, token, opts)) return true;
    if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return false;
}

function startPortable(opts = {}) {
  const spawnImpl = opts.spawnImpl || spawn;
  const home = opts.home || require('node:os').homedir();
  const existing = portableRuntimeState({ home });
  if (existing.running) return { started: false, reason: 'already running', pid: existing.pid, portable: true };
  const logPath = path.join(home, '.nexuscrew', 'nexuscrew.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  const resolved = urlmod.resolvePaths(opts);
  const childEnv = {
    ...process.env,
    HOME: home,
    NEXUSCREW_CONFIG_FILE: resolved.configPath,
    NEXUSCREW_TOKEN_FILE: resolved.tokenPath,
    ...(opts.filesRoot ? { NEXUSCREW_FILES_ROOT: opts.filesRoot } : {}),
  };
  // config.json is authoritative after automatic port fallback.
  delete childEnv.NEXUSCREW_PORT;
  let child;
  try {
    child = spawnImpl(nodeBin(), [path.join(repoRoot(), 'bin', 'nexuscrew.js'), 'serve', '--pidfile'], {
      detached: true, stdio: ['ignore', logFd, logFd], env: childEnv,
    });
  } finally { try { fs.closeSync(logFd); } catch (_) {} }
  if (child && typeof child.unref === 'function') child.unref();
  return { started: true, pid: child && child.pid, portable: true };
}

function openPwa(fullUrl, opts = {}) {
  if (opts.openImpl) return opts.openImpl(fullUrl);
  const platform = opts.platform || detectPlatform();
  const commandExists = opts.commandExists || require('./path.js').commandExists;
  const candidates = platform === 'termux'
    ? ['termux-open-url']
    : platform === 'mac' ? ['open'] : ['xdg-open', 'gio'];
  const bin = candidates.find((candidate) => commandExists(candidate, opts.env || process.env));
  if (!bin) throw new Error('no URL opener found; install termux-tools or xdg-utils');
  const args = bin === 'gio' ? ['open', fullUrl] : [fullUrl];
  const child = (opts.spawnImpl || spawn)(bin, args, { detached: true, stdio: 'ignore' });
  if (child && typeof child.on === 'function') child.on('error', () => {});
  if (child && typeof child.unref === 'function') child.unref();
  return true;
}

// Normal entry point. It is deliberately quiet and returns after starting the
// background service. Only first-run opens the wizard; `show` always opens it.
async function smartUp(opts = {}) {
  const quiet = opts.lifecycleLog || (() => {});
  const platform = opts.platform || detectPlatform();
  const runInitImpl = opts.runInitImpl || runInit;
  const startImpl = opts.startImpl || start;
  const restartImpl = opts.restartImpl || restart;
  const portableStart = opts.startPortableImpl || startPortable;
  const probe = opts.probeImpl || probeNexusCrew;
  const { configPath, tokenPath } = urlmod.resolvePaths(opts);
  let initialized = fs.existsSync(configPath) && !!urlmod.readToken(tokenPath);
  let port;

  if (!initialized) {
    const requested = opts.port || urlmod.loadPort(opts);
    const selected = await findAvailablePort(requested, opts);
    refusePairedPortRelocation(opts, requested, selected);
    runInitImpl({ ...opts, port: selected, log: quiet, platform, installBoot: false, printUrl: false });
    port = selected;
    initialized = true;
  }

  // 0.8.0 services embedded NEXUSCREW_PORT in their environment, overriding
  // config.json forever. Regenerate once so config.json becomes authoritative.
  const home = opts.home || require('node:os').homedir();
  const persistent = bootState({ ...opts, platform }).enabled;
  if (persistent && servicePinsLegacyPort(platform, home, opts.installPath)) {
    runInitImpl({ ...opts, log: quiet, platform, installBoot: true, printUrl: false });
  }

  if (!port) port = urlmod.loadPort(opts);
  let token = urlmod.readToken(tokenPath);
  let running = await probe(port, token, opts);
  let portableAttempted = false;
  let runtime = resolveRuntimeOwner({ ...opts, platform });
  if (!running && runtime.owner !== 'stopped') running = await waitForNexusCrew(port, token, opts);

  if (!running) {
    if (!(await (opts.portAvailableImpl || portAvailable)(port, '127.0.0.1'))) {
      const previousPort = port;
      port = await findAvailablePort(port + 1, opts);
      refusePairedPortRelocation(opts, previousPort, port);
      runInitImpl({ ...opts, port, log: quiet, platform, installBoot: persistent, printUrl: false });
      token = urlmod.readToken(tokenPath);
    } else {
      try {
        runtime = resolveRuntimeOwner({ ...opts, platform });
        const started = runtime.owner === 'conflict'
          ? restartImpl({ ...opts, platform, log: quiet })
          : persistent
            ? (runtime.managedRunning ? restartImpl({ ...opts, platform, log: quiet }) : startImpl({ ...opts, platform, log: quiet }))
            : (runtime.portableRunning ? restartImpl({ ...opts, platform, log: quiet }) : portableStart({ ...opts, platform }));
        if (started && started.started === false) {
          portableStart({ ...opts, platform }); portableAttempted = true;
        }
      } catch (_) {
        portableStart({ ...opts, platform }); portableAttempted = true;
      }
    }
    running = await waitForNexusCrew(port, token, opts);
    if (!running && !portableAttempted) {
      try { portableStart({ ...opts, platform }); portableAttempted = true; } catch (_) {}
      running = await waitForNexusCrew(port, token, opts);
    }
    if (!running) throw new Error(`server did not become ready on 127.0.0.1:${port}`);
  }

  const shouldOpen = !opts.noOpen && (!!opts.forceOpen || !wizardComplete(configPath));
  if (shouldOpen) openPwa(urlmod.buildUrl(port, token, { withToken: true }), { ...opts, platform });
  return { platform, initialized, running, opened: shouldOpen, port, url: urlmod.buildUrl(port, null) };
}

// url [--qr]: ristampa URL completo con #token — UNICO comando che mostra il token.
function url(opts = {}) {
  const log = opts.log || console.log;
  const { tokenPath } = urlmod.resolvePaths(opts);
  const port = urlmod.loadPort(opts);
  const token = urlmod.readToken(tokenPath);
  const full = urlmod.buildUrl(port, token, { withToken: true });
  log(full);
  if (opts.qr) {
    if (token) log(urlmod.renderQr(full, { qrcode: opts.qrcode }));
    else log('url: nessun token (esegui init) — QR non generato');
  }
  return { url: full, port, hasToken: !!token };
}

// token rotate (§4b(3)): scrittura atomica nuovo token + invalidazione reale delle
// sessioni attive (restart se il service e' attivo). Il nuovo token NON si stampa.
function tokenRotate(opts = {}) {
  const log = opts.log || console.log;
  const platform = opts.platform || detectPlatform();
  const { tokenPath } = urlmod.resolvePaths(opts);
  const readonly = process.env.NEXUSCREW_READONLY === '1' || opts.readonly;
  if (readonly) {
    log('token rotate: READONLY, rotazione bloccata');
    return { rotated: false, reason: 'readonly' };
  }
  rotateToken(tokenPath); // atomico (tmp+rename, 0600, no-symlink); non stampa il token
  log(`token: nuovo segreto scritto (${tokenPath})`);
  const running = isServiceRunning({ ...opts, platform });
  if (running) {
    restart({ ...opts, platform, log });
    log('token rotate: servizio riavviato — vecchio token invalidato (401), nuovo attivo (200)');
  } else {
    // il service manager non lo vede, ma un `serve` manuale (pidfile) puo' essere
    // vivo col VECCHIO token cachato allo startup: avvisa esplicitamente.
    const meta = pidf.readPidfile(pidf.defaultPidfilePath(opts.home));
    if (meta && pidf.isAlive(meta)) {
      log(`token rotate: ATTENZIONE — server manuale attivo (pid ${meta.pid}): il vecchio token resta valido finche' non lo riavvii`);
    } else {
      log('token rotate: servizio non attivo (il nuovo token varra\' al prossimo start)');
    }
  }
  log('usa `nexuscrew show token` per il nuovo URL (il token non si stampa qui)');
  return { rotated: true, running };
}

// logs [-f]: passthrough. linux -> journalctl --user -u nexuscrew; mac/termux -> logfile.
function logs(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const spawnImpl = opts.spawnImpl || spawn;
  const log = opts.log || console.log;
  const home = opts.home || require('node:os').homedir();
  const follow = !!opts.follow;

  let bin; let args;
  if (platform === 'linux') {
    bin = 'journalctl';
    args = ['--user', '-u', 'nexuscrew', '--no-pager'];
    if (follow) args.push('-f');
  } else {
    // mac (launchd StandardOutPath) / termux (nohup logfile): stesso path.
    const logPath = path.join(home, '.nexuscrew', 'nexuscrew.log');
    bin = 'tail';
    args = follow ? ['-f', logPath] : ['-n', '200', logPath];
  }
  log(`logs: ${bin} ${args.join(' ')}`);
  const child = spawnImpl(bin, args, { stdio: 'inherit' });
  // passthrough: quando il figlio esce (o subito, se non-follow), esce anche la CLI.
  if (child && typeof child.on === 'function') {
    child.on('exit', (code) => process.exit(code || 0));
  }
  return { platform, bin, args, follow, keepAlive: true };
}

// update: npm i -g @latest + restart se attivo. Fallimento npm -> messaggio chiaro, code 1.
function update(opts = {}) {
  const execImpl = opts.execImpl || execFileSync;
  const log = opts.log || console.log;
  const platform = opts.platform || detectPlatform();
  const pkg = '@mmmbuto/nexuscrew@latest';
  try {
    execImpl('npm', ['i', '-g', pkg], { stdio: 'inherit' });
    log(`update: ${pkg} installato`);
  } catch (e) {
    log(`update: npm install fallito — ${e && e.message ? e.message : e}`);
    log('update: controlla npm/rete/permessi globali, poi riprova: npm i -g @mmmbuto/nexuscrew@latest');
    return { updated: false, error: String(e && e.message ? e.message : e), code: 1 };
  }
  const running = isServiceRunning({ ...opts, platform });
  if (running) {
    restart({ ...opts, platform, log });
    log('update: servizio riavviato sul nuovo codice');
  } else {
    log('update: servizio non attivo (nessun restart)');
  }
  return { updated: true, running, code: 0 };
}

// B4.3 — fleet-boot companion: avvia le celle boot:true del provider selezionato.
// dispatch e' sync (bin/nexuscrew.js non fa await), quindi runFleetBoot (async)
// viene lanciato e il processo tenuto vivo (keepAlive) finche' non termina, poi
// esce col code risultante. runFleetBoot e' la unit testabile (no process.exit);
// dispatchFleetBoot e' il thin glue. Seam iniettabili: selectProvider / loadConfig
// / cfg / exit (per test, no process.exit che uccide il runner).
async function runFleetBoot(opts = {}) {
  const log = opts.log || console.log;
  const loadConfig = opts.loadConfig || require('../config.js').loadConfig;
  const selectProvider = opts.selectProvider || require('../fleet/provider.js').selectProvider;
  const { bootCells } = require('../fleet/boot.js');
  const cfg = opts.cfg || loadConfig();

  const sel = await selectProvider(cfg);
  if (sel.mode === 'external') {
    log('fleet-boot: boot gestito dal fleet esterno (nessuna azione del companion)');
    return { code: 0, mode: 'external' };
  }
  if (sel.mode !== 'builtin' || !sel.fleet || !sel.fleet.available) {
    // disabled (o builtin unavailable): niente da avviare, non e' un errore.
    log(`fleet-boot: nessun boot (provider ${sel.mode}${sel.reason ? ' — ' + sel.reason : ''})`);
    return { code: 0, mode: sel.mode };
  }

  // builtin: up() per ogni cella boot:true. READONLY fa fallire le up con 403 ->
  // raccolte in failed[] -> exit 1 (nessun short-circuit speciale, design §9d).
  const res = await bootCells(sel.fleet, { log });
  log(`fleet-boot: ${res.started.length} started, ${res.skipped.length} skipped, ${res.failed.length} failed`);
  for (const f of res.failed) log(`  failed: ${f.cell} — ${f.reason}`);
  return { code: res.failed.length ? 1 : 0, mode: 'builtin', summary: res };
}

function dispatchFleetBoot(opts) {
  const exit = typeof opts.exit === 'function' ? opts.exit : ((c) => process.exit(c));
  runFleetBoot(opts)
    .then((r) => exit(r.code))
    .catch((e) => {
      (opts.log || console.log)(`fleet-boot: error — ${e && e.message ? e.message : e}`);
      exit(1);
    });
  return { code: 0, keepAlive: true }; // il processo resta vivo finche' runFleetBoot non chiama exit()
}

function dispatch(argv, opts = {}) {
  const log = opts.log || console.log;
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    log(HELP);
    return { code: 0 };
  }
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    log(require('../../package.json').version);
    return { code: 0 };
  }
  const { flags, rest } = parseFlags(argv);
  const cmd = rest[0];

  // help esplicito
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    log(HELP);
    return { code: 0 };
  }
  // Public surface: normal start, show, boot, doctor, help, version.
  if (!cmd) {
    if (Object.keys(flags).length) {
      log(`unknown option: --${Object.keys(flags)[0]}\n\n${HELP}`);
      return { code: 1 };
    }
    return smartUp({ ...opts, log: opts.lifecycleLog || (() => {}) }).then((r) => { quickSummary(r, { ...opts, log }); return { code: 0 }; });
  }
  if (cmd === 'show') {
    if (rest[1] === 'token') {
      return smartUp({ ...opts, noOpen: true, log: opts.lifecycleLog || (() => {}) }).then((r) => {
        const { tokenPath } = urlmod.resolvePaths(opts); const token = urlmod.readToken(tokenPath);
        log(urlmod.buildUrl(r.port, token, { withToken: true })); return { code: 0 };
      });
    }
    if (rest[1]) { log('usage: nexuscrew show [token]'); return { code: 1 }; }
    return smartUp({ ...opts, forceOpen: true, log: opts.lifecycleLog || (() => {}) }).then(() => ({ code: 0 }));
  }
  if (cmd === 'boot') {
    const sub = rest[1] || 'on';
    if (sub === 'status') {
      const b = bootState(opts); log(`boot: ${b.enabled ? 'on' : 'off'} · ${b.platform}`); return { code: 0 };
    }
    if (sub === 'off') return bootOff(opts).then((r) => { log(`boot: off · ${r.platform}`); return { code: 0 }; });
    if (sub === 'on') return bootOn(opts).then((r) => { quickSummary(r, { ...opts, log }); return { code: r.boot ? 0 : 1 }; });
    log('usage: nexuscrew boot [on|off|status]'); return { code: 1 };
  }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    log(require('../../package.json').version);
    return { code: 0 };
  }
  if (cmd === 'status') {
    status({ ...opts, log });
    return { code: 0 };
  }
  if (cmd === 'stop') {
    const result = stop({ ...opts, log });
    return { code: result.stopped || ['not running', 'stale pidfile'].includes(result.reason) ? 0 : 1 };
  }
  if (cmd === 'restart') {
    const result = restart({ ...opts, log });
    return { code: result.restarted ? 0 : 1 };
  }
  // Internal runtime commands used by service managers and MCP clients. They
  // are intentionally omitted from HELP and are not configuration surfaces.
  if (cmd === 'serve') {
    serve({ pidfile: flags.pidfile, serverStart: opts.serverStart });
    return { code: 0, keepAlive: true }; // server.listen tiene il processo vivo; non exit
  }
  if (cmd === 'doctor') {
    const r = doctor({ ...opts, log });
    return { code: r.code };
  }
  if (cmd === 'mcp') {
    // Server MCP stdio (bridge cella→operatore): stdout e' il canale JSON-RPC, quindi
    // NESSUN log qui. keepAlive: resta vivo finche' il client tiene aperto stdin.
    const startMcpImpl = opts.startMcpImpl || require('../mcp/server.js').startMcp;
    startMcpImpl();
    return { code: 0, keepAlive: true };
  }
  if (cmd === 'fleet-boot') {
    return dispatchFleetBoot({ ...opts, log });
  }
  log(`"${cmd}" is not a public CLI command. Open the PWA with: nexuscrew show\n\n${HELP}`);
  return { code: 1 };
}

module.exports = {
  dispatch, serve, start, stop, status, parseFlags, HELP,
  smartUp, url, tokenRotate, logs, doctor, update, restart,
  portAvailable, findAvailablePort, probeNexusCrew, waitForNexusCrew, openPwa, startPortable, wizardComplete,
  servicePinsLegacyPort,
  isServiceRunning, readRoles,
  bootState, bootOn, bootOff, quickSummary,
  stopManagedTunnels,
  managedRuntimeState, portableRuntimeState, resolveRuntimeOwner,
  runFleetBoot, dispatchFleetBoot,
};
