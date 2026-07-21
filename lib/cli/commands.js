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
const { installPath: serviceInstallPath, ensureLinuxTmuxSurvival } = require('./service.js');
const { fleetInstallPath } = require('./fleet-service.js');
const pidf = require('./pidfile.js');
const { runInit, ensureFleetDefaults } = require('./init.js');
const { rotateToken } = require('../auth/token.js');
const urlmod = require('./url.js');
const { doctor, checkServiceWorkingDirectory } = require('./doctor.js');
const nodesStore = require('../nodes/store.js');
const nodesTunnel = require('../nodes/tunnel.js');
const nodesCmds = require('../nodes/commands.js');
const peering = require('../nodes/peering.js');
// Service/portable runtime ownership + start/stop lifecycle (Phase 3 extraction).
const runtimeLifecycle = require('./runtime-lifecycle.js');
const {
  start, stop, isServiceRunning, bootState, stopManagedTunnels,
  managedRuntimeState, portableRuntimeState, resolveRuntimeOwner,
  refusePairedPortRelocation, stopPortableRuntime, unlinkRegular,
} = runtimeLifecycle;

const HELP = `NexusCrew — PWA for local and remote AI workers.

Usage:
  nexuscrew          start in background; show status and quick guide
  nexuscrew init     initialize missing stores idempotently
  nexuscrew show     start when needed and open the authenticated PWA
  nexuscrew show token  print the clickable authenticated URL
  nexuscrew boot     enable startup at boot (use: boot off|status)
  nexuscrew status   show service, port, roles and node status
  nexuscrew stop     stop the background service
  nexuscrew restart  restart the background service
  nexuscrew doctor   run local diagnostics
  nexuscrew nodes    list and manage connected peers (use: nodes help)
  nexuscrew help     show this help
  nexuscrew version  show the installed version

Configuration, engines, models and advanced lifecycle also live in the PWA.
NexusCrew binds only to 127.0.0.1 and automatically selects a free port.`;

const NODES_HELP = `NexusCrew nodes — headless peer management.

Usage:
  nexuscrew nodes list [--direct|--network] [--json]
  nexuscrew nodes inspect|show <name|nodeId> [--json]
  nexuscrew nodes doctor [name|nodeId] [--json]
  nexuscrew nodes edit <name|nodeId> [--label TEXT] [--ssh TARGET]
                         [--ssh-port PORT] [--autostart on|off]
                         [--visibility network|relay-only|selected]
                         [--selected NODE_ID,...]
  nexuscrew nodes remove <name|nodeId> --yes
  nexuscrew nodes test|up|down|connect|disconnect|restart|reconnect <name|nodeId>
                         [--persist]
  nexuscrew nodes rename <name|nodeId> --label TEXT
  nexuscrew nodes visibility <name|nodeId> network|relay-only|selected
                         [--selected NODE_ID,...]
  nexuscrew nodes share <name|nodeId> on|off [--json]
  nexuscrew nodes invite --ssh TARGET [--ssh-port PORT] [--name SLUG]
                         [--label TEXT] [--json]
  printf '%s' "$PAIRING_URL" | nexuscrew nodes pair|join
                         [--ssh TARGET] [--name SLUG] [--label TEXT]
                         [--local-name SLUG] [--local-label TEXT]
  nexuscrew nodes identity [--json]

Pairing links are read from stdin, never from argv. Mutations honor
NEXUSCREW_READONLY=1. Routed peers are inspect-only.

Lifecycle semantics:
  up          connect now and enable autostart
  down        disconnect and disable autostart
  disconnect  disconnect now without changing autostart
  restart     reconnect now without changing autostart`;

const CLI_VALUE_FLAGS = new Set([
  'label', 'ssh', 'ssh-port', 'autostart', 'visibility', 'selected',
  'name', 'local-name', 'local-label', 'identity-file', 'port',
]);

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
  // Service manager e Termux:Boot entrano direttamente da `serve`, senza
  // passare per smartUp. Ripara solo fleet.json MANCANTE; un file invalido
  // resta intatto e il provider continua a fallire chiuso.
  (opts.ensureFleetDefaultsImpl || ensureFleetDefaults)(opts);
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

// start/stop/runtime-ownership lifecycle (start, stop, stopManagedTunnels,
// refusePairedPortRelocation, managedRuntimeState, portableRuntimeState,
// resolveRuntimeOwner, waitForPidExit, stopPortableRuntime, isServiceRunning,
// bootState, unlinkRegular) moved to ./runtime-lifecycle.js (Phase 3).

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
    if (platform === 'linux') {
      try {
        (opts.ensureTmuxSurvivalImpl || ensureLinuxTmuxSurvival)({ ...opts, home: opts.home, execImpl });
      } catch (error) {
        return { platform, owner: before.owner, runtimeOwner: 'managed', restarted: false, reason: String(error.message || error) };
      }
    }
    if (before.portableRunning) {
      const portable = (opts.stopPortableImpl || stopPortableRuntime)(opts);
      if (!portable.killed) return { platform, owner: before.owner, restarted: false, reason: portable.reason };
    }
    try {
      if (platform === 'linux') {
        (opts.stopTunnelsImpl || stopManagedTunnels)(opts);
        execImpl('systemctl', ['--user', 'restart', 'nexuscrew'], { stdio: 'ignore' });
        log('restart: systemctl --user restart nexuscrew');
      } else {
        (opts.stopTunnelsImpl || stopManagedTunnels)(opts);
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

function serviceDefinitionNeedsRefresh(platform, home, installPath) {
  if (servicePinsLegacyPort(platform, home, installPath)) return true;
  return !checkServiceWorkingDirectory(platform, home, installPath).ok;
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

  // Config+token da soli non garantiscono un'installazione completa. Questo
  // era il buco delle installazioni/migrazioni Termux che lasciava il provider
  // disabilitato e l'editor Fleet irraggiungibile.
  const fleetBootstrap = (opts.ensureFleetDefaultsImpl || ensureFleetDefaults)(opts);

  // 0.8.0 services embedded NEXUSCREW_PORT in their environment, overriding
  // config.json forever. Regenerate once so config.json becomes authoritative.
  const home = opts.home || require('node:os').homedir();
  const persistent = bootState({ ...opts, platform }).enabled;
  let serviceRefreshed = false;
  if (persistent && serviceDefinitionNeedsRefresh(platform, home, opts.installPath)) {
    runInitImpl({ ...opts, log: quiet, platform, installBoot: true, printUrl: false });
    serviceRefreshed = checkServiceWorkingDirectory(platform, home, opts.installPath).ok;
    // Termux:Boot has no service manager, so replacing the script alone cannot
    // change the cwd of the already-running pidfile owner. Restart exactly once
    // after a verified migration; Linux/macOS are restarted by installService.
    if (serviceRefreshed && platform === 'termux') {
      const migrated = restartImpl({ ...opts, platform, log: quiet });
      if (!migrated || migrated.restarted !== true) {
        throw new Error(`service cwd migration restart failed: ${(migrated && migrated.reason) || 'unknown'}`);
      }
    }
  }

  if (!port) port = urlmod.loadPort(opts);
  let token = urlmod.readToken(tokenPath);
  let running = await probe(port, token, opts);
  let portableAttempted = false;
  let runtime = resolveRuntimeOwner({ ...opts, platform });

  // selectProvider() viene risolto una volta allo startup. Se abbiamo creato
  // fleet.json mentre un vecchio processo era gia' vivo, serve un restart
  // verificato per fargli acquisire il provider builtin.
  if (running && fleetBootstrap.created) {
    const restarted = restartImpl({ ...opts, platform, log: quiet });
    if (!restarted || restarted.restarted !== true) {
      throw new Error(`fleet bootstrap completato ma restart fallito: ${(restarted && restarted.reason) || 'esito non verificato'}`);
    }
    running = await waitForNexusCrew(port, token, opts);
    if (!running) throw new Error(`server non pronto dopo il bootstrap Fleet su 127.0.0.1:${port}`);
    runtime = resolveRuntimeOwner({ ...opts, platform });
  }
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
  const execImpl = opts.execImpl || execFileSync;
  const { tokenPath } = urlmod.resolvePaths(opts);
  const readonly = process.env.NEXUSCREW_READONLY === '1' || opts.readonly;
  if (readonly) {
    log('token rotate: READONLY, rotazione bloccata');
    return { rotated: false, reason: 'readonly' };
  }
  const runtime = resolveRuntimeOwner({ ...opts, platform, execImpl });
  const running = runtime.owner !== 'stopped';
  if (runtime.managedRunning && platform === 'linux') {
    try {
      (opts.ensureTmuxSurvivalImpl || ensureLinuxTmuxSurvival)({ ...opts, home: opts.home, execImpl });
    } catch (error) {
      const reason = String(error.message || error);
      log(`token rotate: annullata — protezione tmux non verificata: ${reason}`);
      return { rotated: false, tokenWritten: false, restarted: false, running, reason };
    }
  }
  rotateToken(tokenPath); // atomico (tmp+rename, 0600, no-symlink); non stampa il token
  log(`token: nuovo segreto scritto (${tokenPath})`);
  if (running) {
    const restarted = (opts.restartImpl || restart)({ ...opts, platform, execImpl, log });
    if (!restarted || restarted.restarted !== true) {
      const reason = (restarted && restarted.reason) || 'esito restart non verificato';
      log(`token rotate: INCOMPLETA — nuovo token scritto ma restart fallito: ${reason}`);
      log('token rotate: non e\' possibile confermare l\'invalidazione del vecchio token; correggi il servizio e ripeti il restart');
      return { rotated: false, tokenWritten: true, restarted: false, running, reason };
    }
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
  return { rotated: true, tokenWritten: true, restarted: running, running };
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
    const restarted = (opts.restartImpl || restart)({ ...opts, platform, log });
    if (!restarted || restarted.restarted !== true) {
      const reason = (restarted && restarted.reason) || 'esito restart non verificato';
      log(`update: pacchetto installato ma restart fallito — ${reason}`);
      return { updated: true, running, restarted: false, reason, code: 1 };
    }
    log('update: servizio riavviato sul nuovo codice');
  } else {
    log('update: servizio non attivo (nessun restart)');
  }
  return { updated: true, running, restarted: running, code: 0 };
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

function boolFlag(value, name) {
  if (value === true || value === 'on' || value === 'true' || value === '1') return true;
  if (value === 'off' || value === 'false' || value === '0') return false;
  throw new Error(`${name}: atteso on|off`);
}

function readPairingStdin(opts = {}) {
  const clean = (value) => String(value || '').trim().replace(/[\r\n]/g, '');
  if (typeof opts.stdin === 'function') return clean(opts.stdin());
  if (typeof opts.stdin === 'string') return clean(opts.stdin);
  if (process.stdin.isTTY) return '';
  try { return clean(fs.readFileSync(0, 'utf8')); } catch (_) { return ''; }
}

async function localSettingsRequest(pathname, body, opts = {}) {
  const method = opts.method || 'POST';
  if (typeof opts.localApiImpl === 'function') return opts.localApiImpl(pathname, body, { method });
  const up = await (opts.smartUpImpl || smartUp)({
    ...opts, noOpen: true, log: opts.lifecycleLog || (() => {}),
  });
  const { tokenPath } = urlmod.resolvePaths(opts);
  const token = urlmod.readToken(tokenPath);
  if (!token) throw new Error('token locale assente: inizializza NexusCrew');
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch non disponibile');
  const response = await fetchImpl(`http://127.0.0.1:${up.port || urlmod.loadPort(opts)}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = value;
    throw error;
  }
  return value;
}

async function dispatchNodes(rest, flags, opts = {}) {
  const log = opts.log || console.log;
  const sub = rest[1] || 'list';
  const ref = rest[2];
  if (sub === 'help' || sub === '--help' || sub === '-h') { log(NODES_HELP); return { code: 0 }; }
  if (sub === 'list') return { code: nodesCmds.nodesList({
    ...opts, log, json: flags.json === true, direct: flags.direct === true,
  }).code };
  if (sub === 'inspect' || sub === 'show') return { code: nodesCmds.nodesInspect({ ...opts, log, ref, json: flags.json === true }).code };
  if (sub === 'doctor') {
    const view = nodesCmds.loadPeerInventory(opts);
    let peers = view.nodes;
    if (ref) {
      const inspected = nodesCmds.nodesInspect({ ...opts, log: () => {}, ref });
      if (inspected.code !== 0) { log(`nodes doctor: nodo sconosciuto "${ref}"`); return { code: 1 }; }
      peers = [inspected.peer];
    }
    const checks = [];
    for (const peer of peers) {
      if (peer.kind === 'transitive') {
        checks.push({ name: peer.name, nodeId: peer.nodeId, ok: true, result: 'inspect-only', route: peer.route });
        continue;
      }
      const lines = [];
      const result = await nodesCmds.nodesTest({ ...opts, log: (line) => lines.push(String(line)), ref: peer.nodeId || peer.name });
      checks.push({
        name: peer.name, nodeId: peer.nodeId || null, ok: result.code === 0,
        result: result.result || (result.code === 0 ? 'ok' : 'failed'),
        detail: lines[lines.length - 1] || '',
      });
    }
    if (flags.json === true) log(JSON.stringify({ nodeId: view.nodeId, checks }, null, 2));
    else if (checks.length === 0) log('nodes doctor: nessun peer diretto');
    else for (const check of checks) log(`${check.name}: ${check.ok ? 'OK' : 'KO'} — ${check.result}${check.detail ? ` · ${check.detail}` : ''}`);
    return { code: checks.some((check) => !check.ok) ? 1 : 0 };
  }
  if (sub === 'identity') {
    const view = nodesCmds.loadPeerInventory(opts);
    const value = { nodeId: view.nodeId };
    if (flags.json === true) log(JSON.stringify(value, null, 2));
    else log(`nodeId: ${value.nodeId || '(store non inizializzato)'}`);
    return { code: value.nodeId ? 0 : 1 };
  }
  if (sub === 'edit') {
    const patch = {};
    if (flags.label !== undefined) patch.label = flags.label;
    if (flags.ssh !== undefined) patch.ssh = flags.ssh;
    if (flags['ssh-port'] !== undefined) patch.sshPort = Number(flags['ssh-port']);
    if (flags.autostart !== undefined) {
      try { patch.autostart = boolFlag(flags.autostart, '--autostart'); }
      catch (e) { log(e.message); return { code: 1 }; }
    }
    if (flags.visibility !== undefined) patch.visibility = flags.visibility;
    if (flags.selected !== undefined) patch.selected = String(flags.selected).split(',').map((x) => x.trim()).filter(Boolean);
    return { code: nodesCmds.nodesEdit({ ...opts, log, ref, patch }).code };
  }
  if (sub === 'rename') {
    if (flags.label === undefined) { log('nodes rename: --label TEXT obbligatorio'); return { code: 1 }; }
    return { code: nodesCmds.nodesEdit({ ...opts, log, ref, patch: { label: flags.label } }).code };
  }
  if (sub === 'visibility') {
    const visibility = rest[3] || flags.visibility;
    const selected = flags.selected === undefined ? []
      : String(flags.selected).split(',').map((value) => value.trim()).filter(Boolean);
    return { code: nodesCmds.nodesEdit({ ...opts, log, ref, patch: { visibility, selected } }).code };
  }
  if (sub === 'remove') {
    if (flags.yes !== true) { log('nodes remove: conferma richiesta con --yes'); return { code: 1 }; }
    return { code: nodesCmds.nodesRemove({ ...opts, log, ref }).code };
  }
  if (sub === 'test') return { code: (await nodesCmds.nodesTest({ ...opts, log, ref })).code };
  if (['up', 'down', 'connect', 'disconnect', 'restart', 'reconnect'].includes(sub)) {
    const fn = sub === 'up' || sub === 'connect' ? nodesCmds.nodesUp
      : sub === 'restart' || sub === 'reconnect' ? nodesCmds.nodesRestart : nodesCmds.nodesDown;
    const persistAutostart = sub === 'up' || sub === 'down' || flags.persist === true;
    return { code: fn({ ...opts, log, ref, persistAutostart }).code };
  }
  if (sub === 'share') {
    const inspected = nodesCmds.nodesInspect({ ...opts, log: () => {}, ref });
    if (inspected.code !== 0 || inspected.peer.kind !== 'direct') {
      log(`nodes share: peer diretto sconosciuto "${ref || ''}"`); return { code: 1 };
    }
    let shared;
    try { shared = boolFlag(rest[3], 'nodes share'); }
    catch (error) { log(error.message); return { code: 1 }; }
    try {
      const result = await localSettingsRequest(
        `/api/settings/nodes/${encodeURIComponent(inspected.peer.name)}/share`,
        { shared }, { ...opts, method: 'PATCH' },
      );
      if (flags.json === true) log(JSON.stringify(result, null, 2));
      else log(`nodes share [${inspected.peer.name}]: ${shared ? 'on' : 'off'}`);
      return { code: 0 };
    } catch (error) { log(`nodes share: ${error.message}`); return { code: 1 }; }
  }
  if (sub === 'invite') {
    const body = {
      ...(flags.ssh !== undefined ? { ssh: flags.ssh } : {}),
      ...(flags['ssh-port'] !== undefined ? { sshPort: Number(flags['ssh-port']) } : {}),
      ...(flags.name !== undefined ? { name: flags.name } : {}),
      ...(flags.label !== undefined ? { label: flags.label } : {}),
    };
    if (!body.ssh) { log('nodes invite: --ssh TARGET obbligatorio'); return { code: 1 }; }
    try {
      const result = await localSettingsRequest('/api/settings/peering/invite', body, opts);
      if (flags.json === true) log(JSON.stringify(result, null, 2));
      else { log(result.pairingUrl); log(`scade: ${new Date(result.expiresAt).toISOString()}`); }
      return { code: 0 };
    } catch (e) { log(`nodes invite: ${e.message}`); return { code: 1 }; }
  }
  if (sub === 'pair' || sub === 'join') {
    const pairingUrl = readPairingStdin(opts);
    if (!pairingUrl) {
      log("nodes pair: passa il link via stdin (es. printf '%s' \"$PAIRING_URL\" | nexuscrew nodes pair)");
      return { code: 1 };
    }
    const decoded = peering.parsePairingUrl(pairingUrl);
    if (!decoded) { log('nodes pair: link non valido o corrotto'); return { code: 1 }; }
    const body = {
      pairingUrl,
      name: flags.name || decoded.name,
      ssh: flags.ssh || decoded.ssh,
      ...(flags.label !== undefined || decoded.label ? { label: flags.label || decoded.label } : {}),
      ...(flags['ssh-port'] !== undefined || decoded.sshPort ? { sshPort: Number(flags['ssh-port'] || decoded.sshPort) } : {}),
      ...(flags['local-label'] !== undefined ? { localLabel: flags['local-label'] } : {}),
      ...(flags['local-name'] !== undefined ? { localName: flags['local-name'] } : {}),
      ...(flags['identity-file'] !== undefined ? { identityFile: flags['identity-file'] } : {}),
    };
    if (!body.name || !body.ssh) {
      log('nodes pair: il link non contiene name/ssh; fornisci --name e --ssh');
      return { code: 1 };
    }
    try {
      const result = await localSettingsRequest('/api/settings/nodes/pair', body, opts);
      if (flags.json === true) log(JSON.stringify(result, null, 2));
      else log(`nodes pair: collegato "${result.name}" (${result.instanceId})`);
      return { code: 0 };
    } catch (e) {
      const stage = e.data && e.data.stage ? ` [${e.data.stage}]` : '';
      const hint = e.data && e.data.hint ? ` · ${e.data.hint}` : '';
      log(`nodes pair${stage}: ${e.message}${hint}`);
      return { code: 1 };
    }
  }
  log(`comando nodes sconosciuto: ${sub}\n\n${NODES_HELP}`);
  return { code: 1 };
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
  const { flags, rest } = parseFlags(argv, CLI_VALUE_FLAGS);
  const cmd = rest[0];

  // help esplicito
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    log(HELP);
    return { code: 0 };
  }
  // Public surface: normal start, init, show, boot, doctor, help, version.
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
  if (cmd === 'init') {
    const port = flags.port === undefined ? undefined : Number(flags.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      log('usage: nexuscrew init [--dry-run] [--port PORT]');
      return { code: 1 };
    }
    (opts.runInitImpl || runInit)({
      ...opts, dryRun: flags['dry-run'] === true, port, log,
    });
    return { code: 0 };
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
    status({ ...opts, log, json: flags.json === true });
    return { code: 0 };
  }
  if (cmd === 'nodes' || cmd === 'peers') return dispatchNodes(rest, flags, opts);
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
    serve({ ...opts, pidfile: flags.pidfile, serverStart: opts.serverStart });
    return { code: 0, keepAlive: true }; // server.listen tiene il processo vivo; non exit
  }
  if (cmd === 'doctor') {
    if (flags.peers === true) return dispatchNodes(['nodes', 'doctor'], flags, opts);
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
  dispatch, dispatchNodes, serve, start, stop, status, parseFlags, HELP, NODES_HELP,
  smartUp, url, tokenRotate, logs, doctor, update, restart,
  serviceDefinitionNeedsRefresh,
  portAvailable, findAvailablePort, probeNexusCrew, waitForNexusCrew, openPwa, startPortable, wizardComplete,
  servicePinsLegacyPort,
  isServiceRunning, readRoles,
  bootState, bootOn, bootOff, quickSummary,
  stopManagedTunnels,
  managedRuntimeState, portableRuntimeState, resolveRuntimeOwner,
  runFleetBoot, dispatchFleetBoot,
};
