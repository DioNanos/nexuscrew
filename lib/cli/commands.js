'use strict';
// CLI dispatcher: init / serve / start / stop / status. [M6][R1]
// serve = foreground HTTP (+ --pidfile lifecycle su Termux/manuale).
// start/stop/status = per-platform: linux (systemctl --user), mac (launchctl),
// termux (nohup serve --pidfile + pidfile verificato; status boot-script vs running).
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { detectPlatform, nodeBin, repoRoot, uid } = require('./platform.js');
const pidf = require('./pidfile.js');
const { runInit } = require('./init.js');

const HELP = `NexusCrew (portable) — browser tmux client.

Usage:
  nexuscrew init [--dry-run] [--port N]   setup: detect + config + token + service + URL
  nexuscrew serve [--pidfile]             HTTP server foreground (dev / ExecStart)
  nexuscrew start                         avvia il servizio (systemctl / launchctl / nohup+pidfile)
  nexuscrew stop                          stop del servizio (service manager / pidfile verificato)
  nexuscrew status                        stato: platform + service + porta + URL
  nexuscrew fleet-boot                    companion di boot: avvia le celle boot:true (config-driven)

Piattaforme: linux (systemd --user), mac (launchd), termux (nohup + pidfile).
Bind loopback 127.0.0.1 — raggiungibile via tunnel SSH/VPN.`;

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v !== undefined ? v : true;
    } else rest.push(a);
  }
  return { flags, rest };
}

function serve(opts = {}) {
  const serverStart = opts.serverStart || require('../server.js').start;
  if (opts.pidfile) {
    const pidPath = pidf.defaultPidfilePath();
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
    const label = `gui/${opts.uid || uid()}/com.mmmbuto.nexuscrew`;
    execImpl('launchctl', ['kickstart', '-k', label], { stdio: 'ignore' });
    log(`start: launchctl kickstart ${label}`);
    return { platform, started: true };
  }
  if (platform === 'termux') {
    // already-running?
    const pidPath = pidf.defaultPidfilePath();
    const meta = pidf.readPidfile(pidPath);
    if (meta && pidf.isAlive(meta)) {
      log(`already running (pid ${meta.pid}) — pidfile ${pidPath}`);
      return { platform, started: false, reason: 'already running' };
    }
    pidf.cleanStale(pidPath);
    const repoBin = path.join(repoRoot(), 'bin', 'nexuscrew.js');
    const logPath = path.join(require('node:os').homedir(), '.nexuscrew', 'nexuscrew.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, 'a');
    const child = spawnImpl(nodeBin(), [repoBin, 'serve', '--pidfile'], {
      detached: true, stdio: ['ignore', logFd, logFd],
    });
    if (child && typeof child.unref === 'function') child.unref();
    log(`start: nohup ${nodeBin()} ${repoBin} serve --pidfile (>> ${logPath})`);
    return { platform, started: true, pid: child && child.pid };
  }
  throw new Error(`start: platform ${platform} non supportata`);
}

function stop(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const execImpl = opts.execImpl || execFileSync;
  const log = opts.log || console.log;

  if (platform === 'linux') {
    execImpl('systemctl', ['--user', 'stop', 'nexuscrew'], { stdio: 'ignore' });
    log('stop: systemctl --user stop nexuscrew');
    return { platform, stopped: true };
  }
  if (platform === 'mac') {
    const label = `gui/${opts.uid || uid()}/com.mmmbuto.nexuscrew`;
    execImpl('launchctl', ['kill', 'SIGTERM', label], { stdio: 'ignore' });
    log(`stop: launchctl kill SIGTERM ${label}`);
    return { platform, stopped: true };
  }
  if (platform === 'termux') {
    // kill via pidfile verificato (no broad match) + wake-lock-release
    const pidPath = pidf.defaultPidfilePath();
    const r = pidf.killPidfile(pidPath);
    try { execImpl('termux-wake-lock-release', [], { stdio: 'ignore' }); } catch (_) {}
    log(`stop: ${r.killed ? `killed pid ${r.pid}` : r.reason}`);
    return { platform, stopped: r.killed, reason: r.reason };
  }
  throw new Error(`stop: platform ${platform} non supportata`);
}

function status(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const execImpl = opts.execImpl || execFileSync;
  const log = opts.log || console.log;
  const home = opts.home || require('node:os').homedir();

  const out = { platform, service: null, running: null, port: null, url: null };

  if (platform === 'linux') {
    try {
      const s = execImpl('systemctl', ['--user', 'is-active', 'nexuscrew'], { encoding: 'utf8' }).trim();
      out.service = s; out.running = s === 'active';
    } catch (_) { out.service = 'inactive'; out.running = false; }
  } else if (platform === 'mac') {
    out.service = `gui/${opts.uid || uid()}/com.mmmbuto.nexuscrew`;
    try {
      execImpl('launchctl', ['print', out.service], { stdio: 'ignore' });
      out.running = true;
    } catch (_) { out.running = false; }
  } else if (platform === 'termux') {
    // boot-script installed vs server running (pidfile vivo)
    const bootScript = path.join(home, '.termux', 'boot', 'nexuscrew.sh');
    out.bootScriptInstalled = fs.existsSync(bootScript);
    const meta = pidf.readPidfile(pidf.defaultPidfilePath());
    out.running = !!(meta && pidf.isAlive(meta));
    out.service = out.bootScriptInstalled ? 'boot-script installed' : 'no boot-script';
  }

  // porta da config.json
  try {
    const { loadConfig } = require('../config.js');
    const cfg = loadConfig();
    out.port = cfg.port;
    out.url = `http://127.0.0.1:${cfg.port}/`;
  } catch (_) {}

  log(JSON.stringify(out, null, 2));
  return out;
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
  const { flags, rest } = parseFlags(argv);
  const cmd = rest[0];
  const log = opts.log || console.log;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    log(HELP);
    return { code: 0 };
  }
  if (cmd === 'init') {
    runInit({ ...opts, dryRun: flags['dry-run'], port: flags.port ? Number(flags.port) : undefined, log });
    return { code: 0 };
  }
  if (cmd === 'serve') {
    serve({ pidfile: flags.pidfile, serverStart: opts.serverStart });
    return { code: 0, keepAlive: true }; // server.listen tiene il processo vivo; non exit
  }
  if (cmd === 'start') {
    start({ execImpl: opts.execImpl, spawnImpl: opts.spawnImpl, log, platform: opts.platform, uid: opts.uid });
    return { code: 0 };
  }
  if (cmd === 'stop') {
    stop({ execImpl: opts.execImpl, log, platform: opts.platform, uid: opts.uid });
    return { code: 0 };
  }
  if (cmd === 'status') {
    status({ execImpl: opts.execImpl, log, platform: opts.platform, uid: opts.uid, home: opts.home });
    return { code: 0 };
  }
  if (cmd === 'fleet-boot') {
    return dispatchFleetBoot({ ...opts, log });
  }
  log(`unknown command: ${cmd}\n\n${HELP}`);
  return { code: 1 };
}

module.exports = { dispatch, serve, start, stop, status, parseFlags, HELP, runFleetBoot, dispatchFleetBoot };
