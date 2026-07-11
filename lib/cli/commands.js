'use strict';
// CLI dispatcher: init / serve / start / stop / status. [M6][R1]
// serve = foreground HTTP (+ --pidfile lifecycle su Termux/manuale).
// start/stop/status = per-platform: linux (systemctl --user), mac (launchctl),
// termux (nohup serve --pidfile + pidfile verificato; status boot-script vs running).
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { detectPlatform, nodeBin, repoRoot, uid } = require('./platform.js');
const { installPath: serviceInstallPath } = require('./service.js');
const pidf = require('./pidfile.js');
const { runInit } = require('./init.js');
const { rotateToken } = require('../auth/token.js');
const urlmod = require('./url.js');
const { doctor } = require('./doctor.js');
const nodesCmds = require('../nodes/commands.js');
const nodesStore = require('../nodes/store.js');
const nodesTunnel = require('../nodes/tunnel.js');

// Flag CLI che consumano il token successivo (forma "--k v", oltre a "--k=v").
// Solo flag esclusivi dei subcomandi nodes/node: non collidono con gli altri.
const VALUE_FLAGS = new Set([
  'ssh', 'remote-port', 'key', 'local-port', 'node-id', 'rendezvous', 'published-port', 'token',
]);

const HELP = `NexusCrew (portable) — browser tmux client.

Usage:
  nexuscrew                               smart-up: init se serve -> start -> URL + QR
  nexuscrew init [--dry-run] [--port N]   setup: detect + config + token + service + URL
  nexuscrew serve [--pidfile]             HTTP server foreground (dev / ExecStart)
  nexuscrew start | up                    avvia il servizio (systemctl / launchctl / nohup+pidfile)
  nexuscrew stop | down                   stop del servizio (service manager / pidfile verificato)
  nexuscrew status [--json]               stato: platform + service + porta + URL + ruoli + nodi
  nexuscrew url [--qr]                    ristampa URL con #token (+ QR ASCII) — UNICO posto col token
  nexuscrew token rotate                  ruota il token (atomico) + invalida le sessioni attive
  nexuscrew logs [-f]                     journalctl-user / logfile (-f = segue)
  nexuscrew doctor                        auto-diagnosi: node, tmux, PTY, service, boot, token, ssh
  nexuscrew mcp                           server MCP stdio per sessioni AI (notify/ask/file/status)
  nexuscrew update                        npm i -g @mmmbuto/nexuscrew@latest + restart
  nexuscrew fleet-boot                    companion di boot: avvia le celle boot:true (config-driven)
  nexuscrew nodes add <name> --ssh u@h    aggiunge un nodo (genera chiave dedicata + authorized_keys)
  nexuscrew nodes list [--json]           elenca i nodi + stato tunnel (token redatti)
  nexuscrew nodes remove|test <name>      rimuove / testa un nodo (test: tunnel/health/token remoto)
  nexuscrew nodes up|down|restart <name>  lifecycle del singolo tunnel (non tocca la config)
  nexuscrew nodes set-token <name>        aggiorna il token remoto (da stdin/env, mai argv)
  nexuscrew node on|off                   ruolo "nodo raggiungibile" (reverse tunnel)

Piattaforme: linux (systemd --user), mac (launchd), termux (nohup + pidfile).
Bind loopback 127.0.0.1 — raggiungibile via tunnel SSH/VPN.
Il token appare SOLO in \`url\`/\`url --qr\` — mai in status, logs, service output.`;

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
    try {
      // bootout scarica il job: KeepAlive non puo' rianimare uno stop volontario.
      execImpl('launchctl', ['bootout', label], { stdio: 'ignore' });
      log(`stop: launchctl bootout ${label}`);
      return { platform, stopped: true };
    } catch (e) {
      const reason = String(e.message || e);
      log(`stop: launchctl bootout fallito: ${reason}`);
      return { platform, stopped: false, reason };
    }
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

// running-check per-platform (no log) — riusato da smart-up / token rotate / update.
function isServiceRunning(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const execImpl = opts.execImpl || execFileSync;
  if (platform === 'linux') {
    try { return execImpl('systemctl', ['--user', 'is-active', 'nexuscrew'], { encoding: 'utf8' }).trim() === 'active'; }
    catch (_) { return false; }
  }
  if (platform === 'mac') {
    try { execImpl('launchctl', ['print', `gui/${opts.uid || uid()}/com.mmmbuto.nexuscrew`], { stdio: 'ignore' }); return true; }
    catch (_) { return false; }
  }
  if (platform === 'termux') {
    const meta = pidf.readPidfile(pidf.defaultPidfilePath());
    return !!(meta && pidf.isAlive(meta));
  }
  return false;
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

  const out = { platform, service: null, running: null, port: null, url: null, roles: null, nodes: [] };

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
          hasToken: red.hasToken,
          tunnel: nodesTunnel.readTunnelState(home, n.name),
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
  if (platform === 'linux') {
    execImpl('systemctl', ['--user', 'restart', 'nexuscrew'], { stdio: 'ignore' });
    log('restart: systemctl --user restart nexuscrew');
    return { platform, restarted: true };
  }
  if (platform === 'mac') {
    const label = `gui/${opts.uid || uid()}/com.mmmbuto.nexuscrew`;
    execImpl('launchctl', ['kickstart', '-k', label], { stdio: 'ignore' });
    log(`restart: launchctl kickstart -k ${label}`);
    return { platform, restarted: true };
  }
  if (platform === 'termux') {
    stop({ execImpl, log, platform, uid: opts.uid });
    start({ execImpl, spawnImpl: opts.spawnImpl, log, platform, uid: opts.uid });
    return { platform, restarted: true };
  }
  throw new Error(`restart: platform ${platform} non supportata`);
}

// smart-up (design §3.2): nexuscrew nudo. init minimale (zero domande) se mai
// inizializzato -> start service (se non gia' attivo) -> stampa URL con #token + QR.
// Idempotente: se gia' attivo stampa solo l'URL. Seam iniettabili per test.
function smartUp(opts = {}) {
  const log = opts.log || console.log;
  const platform = opts.platform || detectPlatform();
  const { configPath, tokenPath } = urlmod.resolvePaths(opts);
  const runInitImpl = opts.runInitImpl || runInit;
  const startImpl = opts.startImpl || start;

  const initialized = fs.existsSync(configPath) && !!urlmod.readToken(tokenPath);
  if (!initialized) {
    log('smart-up: mai inizializzato -> init minimale (zero domande; il resto dal wizard UI)');
    // printUrl:false -> init non stampa il token; l'URL/QR lo presenta smart-up sotto.
    runInitImpl({ ...opts, log, platform, printUrl: false });
  }

  const running = isServiceRunning({ ...opts, platform });
  if (!running) {
    startImpl({ execImpl: opts.execImpl, spawnImpl: opts.spawnImpl, log, platform, uid: opts.uid });
  } else {
    log('smart-up: servizio gia\' attivo');
  }

  // Output: URL base (SENZA token in chiaro — smart-up puo' girare al boot/service)
  // + QR che INCORPORA il token (scan-to-login, killer feature Termux). Il token in
  // chiaro resta esclusivo di `nexuscrew url` (§3, invariante "token mai in output servizio").
  const port = urlmod.loadPort(opts);
  const token = urlmod.readToken(tokenPath);
  const baseUrl = urlmod.buildUrl(port, null, { withToken: false });
  const fullUrl = urlmod.buildUrl(port, token, { withToken: true });
  log(baseUrl);
  if (token) {
    log(urlmod.renderQr(fullUrl, { qrcode: opts.qrcode }));
    log('scansiona il QR (contiene il token) o usa `nexuscrew url` per l\'URL completo');
  }
  return { platform, initialized, running, url: baseUrl, port };
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
    const meta = pidf.readPidfile(pidf.defaultPidfilePath());
    if (meta && pidf.isAlive(meta)) {
      log(`token rotate: ATTENZIONE — server manuale attivo (pid ${meta.pid}): il vecchio token resta valido finche' non lo riavvii`);
    } else {
      log('token rotate: servizio non attivo (il nuovo token varra\' al prossimo start)');
    }
  }
  log('usa `nexuscrew url` per il nuovo URL (il token non si stampa qui)');
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
  const { flags, rest } = parseFlags(argv, VALUE_FLAGS);
  const cmd = rest[0];
  const log = opts.log || console.log;

  // help esplicito
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    log(HELP);
    return { code: 0 };
  }
  // nexuscrew nudo = smart-up (design §3.2)
  if (!cmd) {
    smartUp({ ...opts, log });
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
  if (cmd === 'start' || cmd === 'up') {
    const r = start({ execImpl: opts.execImpl, spawnImpl: opts.spawnImpl, log,
      platform: opts.platform, uid: opts.uid, home: opts.home, installPath: opts.installPath });
    return { code: r.started === false ? 1 : 0 };
  }
  if (cmd === 'stop' || cmd === 'down') {
    const r = stop({ execImpl: opts.execImpl, log, platform: opts.platform, uid: opts.uid });
    return { code: r.stopped === false ? 1 : 0 };
  }
  if (cmd === 'status') {
    status({ ...opts, json: !!flags.json, log });
    return { code: 0 };
  }
  if (cmd === 'url') {
    url({ ...opts, qr: !!flags.qr, log });
    return { code: 0 };
  }
  if (cmd === 'token') {
    if (rest[1] === 'rotate') {
      tokenRotate({ ...opts, log });
      return { code: 0 };
    }
    log('usage: nexuscrew token rotate');
    return { code: 1 };
  }
  if (cmd === 'logs') {
    const follow = !!(flags.f || flags.follow) || rest.includes('-f');
    const r = logs({ ...opts, follow, log });
    return { code: 0, keepAlive: !!r.keepAlive };
  }
  if (cmd === 'doctor') {
    const r = doctor({ ...opts, log });
    return { code: r.code };
  }
  if (cmd === 'update') {
    const r = update({ ...opts, log });
    return { code: r.code || 0 };
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
  if (cmd === 'nodes') {
    return dispatchNodes(rest, flags, { ...opts, log });
  }
  if (cmd === 'node') {
    return dispatchNode(rest, flags, { ...opts, log });
  }
  log(`unknown command: ${cmd}\n\n${HELP}`);
  return { code: 1 };
}

// nodes add|list|remove|test|up|down|restart|set-token (design §3, §4).
function dispatchNodes(rest, flags, opts) {
  const log = opts.log;
  const sub = rest[1];
  const name = rest[2];
  const common = { ...opts, name };
  switch (sub) {
    case 'add':
      return { code: nodesCmds.nodesAdd({
        ...common, ssh: flags.ssh, remotePort: flags['remote-port'],
        key: flags.key, localPort: flags['local-port'], nodeId: flags['node-id'],
      }).code };
    case undefined:
    case 'list':
      return { code: nodesCmds.nodesList({ ...opts, json: !!flags.json }).code };
    case 'remove':
      return { code: nodesCmds.nodesRemove(common).code };
    case 'up':
      return { code: nodesCmds.nodesUp(common).code };
    case 'down':
      return { code: nodesCmds.nodesDown(common).code };
    case 'restart':
      return { code: nodesCmds.nodesRestart(common).code };
    case 'set-token':
      return { code: nodesCmds.nodesSetToken(common).code };
    case 'test': {
      // async: tieni vivo il processo finche' il probe non risolve, poi exit.
      const exit = typeof opts.exit === 'function' ? opts.exit : ((c) => process.exit(c));
      nodesCmds.nodesTest(common)
        .then((r) => exit(r.code))
        .catch((e) => { log(`nodes test: error — ${e && e.message ? e.message : e}`); exit(1); });
      return { code: 0, keepAlive: true };
    }
    default:
      log('usage: nexuscrew nodes add|list|remove|test|up|down|restart|set-token <name>');
      return { code: 1 };
  }
}

// node on|off — ruolo "nodo raggiungibile" (reverse tunnel). §4.
function dispatchNode(rest, flags, opts) {
  const log = opts.log;
  const sub = rest[1];
  if (sub === 'on') {
    return { code: nodesCmds.nodeOn({
      ...opts, rendezvousSsh: flags.rendezvous,
      publishedPort: flags['published-port'], key: flags.key,
    }).code };
  }
  if (sub === 'off') {
    return { code: nodesCmds.nodeOff({ ...opts }).code };
  }
  log('usage: nexuscrew node on|off');
  return { code: 1 };
}

module.exports = {
  dispatch, serve, start, stop, status, parseFlags, HELP,
  smartUp, url, tokenRotate, logs, doctor, update, restart,
  isServiceRunning, readRoles,
  runFleetBoot, dispatchFleetBoot,
};
