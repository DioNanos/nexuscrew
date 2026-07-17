'use strict';
// B4.3 — Service companion (boot) generation + migration gate. Design §4c / §9b.
//
// generateFleetService({platform, nodeBin, entryPath}) genera il contenuto del
// service UNICO di boot (NON una unit per cella) che al boot esegue
//     <node> <entry> fleet-boot
// seguendo ESATTAMENTE i pattern/escaping di lib/cli/service.js:
//   linux  -> systemd --user  'nexuscrew-fleet.service'  (Type=oneshot)
//   mac    -> launchd plist   'com.mmmbuto.nexuscrew-fleet.plist' (RunAtLoad)
//   termux -> script          '~/.termux/boot/nexuscrew-fleet.sh'
//
// migrationGate({exec, platform}) rileva unit legacy 'cloud-cell@*.service'
// abilitate (systemctl --user list-unit-files --state=enabled, via execFile —
// MAI shell string). Se presenti -> {blocked:true, units, remediation}: il
// companion NON va installato (design 9b: mai doppio boot silenzioso). Su
// piattaforme senza systemd il gate passa. `exec` e' iniettabile per testabilita'.
//
// Nessun side-effect all'import e NESSUNA installazione reale qui (solo generazione
// contenuto + gate). L'installazione e' demandata al flusso init (separato).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  escapeSystemdPath, escapeSystemdExec, escapeXml, shellQuote, assertSystemdSafe,
} = require('./service.js');
const { uid } = require('./platform.js');

// entryPath e' tipicamente <repoRoot>/bin/nexuscrew.js -> repoRoot = dirname x2.
function deriveRepoRoot(entryPath) {
  return path.dirname(path.dirname(entryPath));
}

function generateFleetService(opts) {
  const platform = opts && opts.platform;
  if (platform === 'linux') return generateFleetLinux(opts);
  if (platform === 'mac') return generateFleetMac(opts);
  if (platform === 'termux') return generateFleetTermux(opts);
  throw new Error(`unsupported platform: ${platform}`);
}

function generateFleetLinux(opts) {
  const repoRoot = opts.repoRoot || deriveRepoRoot(opts.entryPath);
  const { nodeBin, entryPath } = opts;
  // Parita' di hardening con service.js (M3): reject char non gestibili in systemd.
  assertSystemdSafe('repoRoot', repoRoot);
  assertSystemdSafe('nodeBin', nodeBin);
  assertSystemdSafe('entryPath', entryPath);
  const repo = escapeSystemdPath(repoRoot);
  const node = escapeSystemdExec(nodeBin);
  const entry = escapeSystemdExec(entryPath);
  const nodeDir = escapeSystemdPath(path.dirname(nodeBin));
  return `# NexusCrew fleet boot companion (systemd --user) - avvia le celle boot:true
[Unit]
Description=NexusCrew fleet boot companion (avvia le celle boot:true)
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${repo}
Environment=PATH=${nodeDir}:/usr/local/bin:/usr/bin:/bin
ExecStart=${node} ${entry} fleet-boot

[Install]
WantedBy=default.target
`;
}

function generateFleetMac(opts) {
  const repoRoot = opts.repoRoot || deriveRepoRoot(opts.entryPath);
  const home = opts.home || os.homedir();
  const nodeXml = escapeXml(opts.nodeBin);
  const entryXml = escapeXml(opts.entryPath);
  const repoXml = escapeXml(repoRoot);
  const homeXml = escapeXml(home);
  const launchPath = [...new Set([
    path.dirname(opts.nodeBin), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ])].join(':');
  const launchPathXml = escapeXml(launchPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mmmbuto.nexuscrew-fleet</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeXml}</string>
    <string>${entryXml}</string>
    <string>fleet-boot</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repoXml}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${launchPathXml}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${homeXml}/.nexuscrew/fleet-boot.log</string>
  <key>StandardErrorPath</key>
  <string>${homeXml}/.nexuscrew/fleet-boot.log</string>
</dict>
</plist>
`;
}

function generateFleetTermux(opts) {
  const repoRoot = opts.repoRoot || deriveRepoRoot(opts.entryPath);
  const nodeQ = shellQuote(opts.nodeBin);
  const entryQ = shellQuote(opts.entryPath);
  const repoQ = shellQuote(repoRoot);
  return `#!/data/data/com.termux/files/usr/bin/sh
# NexusCrew fleet boot companion (Termux) - avvia le celle boot:true
export PATH=/data/data/com.termux/files/usr/bin:$PATH
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export TMPDIR=$PREFIX/tmp
export TMUX_TMPDIR=$PREFIX/var/run
mkdir -p "$TMPDIR" "$TMUX_TMPDIR"
cd -- ${repoQ}
exec ${nodeQ} ${entryQ} fleet-boot >> "$HOME/.nexuscrew/fleet-boot.log" 2>&1
`;
}

// Default exec per il gate: execFileSync (argv diretto, MAI shell string).
function defaultListEnabled(bin, args, opts) {
  return execFileSync(bin, args, opts);
}

// Migration gate (design 9b): blocca l'installazione del companion se ci sono
// unit legacy cloud-cell@*.service abilitate (mai doppio boot silenzioso).
//   opts.exec     — funzione iniettabile con firma execFileSync(bin, args, opts)
//   opts.platform — se !== 'linux' il gate passa (no systemd -> no rischio)
// Ritorna {blocked, units[], remediation?|reason?}.
function migrationGate(opts = {}) {
  const { exec, platform } = opts;
  if (platform && platform !== 'linux') {
    return { blocked: false, units: [], reason: `platform ${platform}: no systemd, gate skipped` };
  }
  const execImpl = typeof exec === 'function' ? exec : defaultListEnabled;

  let stdout;
  try {
    stdout = execImpl('systemctl',
      ['--user', 'list-unit-files', '--state=enabled', 'cloud-cell@*'],
      { encoding: 'utf8' });
  } catch (e) {
    // systemctl assente / ambiente non systemd-user: nessuna evidenza di unit
    // legacy -> il gate passa (non blocca su assenza di informazioni).
    return { blocked: false, units: [], reason: `gate skipped: ${e && e.message ? e.message : 'command error'}` };
  }

  const units = [];
  for (const line of String(stdout || '').split('\n')) {
    const tok = line.trim().split(/\s+/)[0];
    if (tok && /^cloud-cell@.+\.service$/.test(tok)) units.push(tok);
  }

  if (units.length) {
    return {
      blocked: true,
      units,
      remediation: 'esegui il backup, poi disabilita le unit legacy cloud-cell@*.service prima di abilitare nexuscrew-fleet.service; non devono esistere due proprietari del boot',
    };
  }
  return { blocked: false, units: [], reason: 'nessuna unit cloud-cell@*.service abilitata' };
}

// --- selectProviderModeSync — resolver SINCRONO del mode del provider ---
// Speculare alla logica builtin-only di lib/fleet/provider.js ma sincrono per
// runInit.  Il binario legacy `fleet` non viene scoperto né eseguito.
function selectProviderModeSync(cfg = {}) {
  if (cfg.fleetEnabled === false) {
    return { mode: 'disabled', reason: 'fleet disabilitato (fleetEnabled=false)' };
  }
  if (cfg.builtinEnabled === false) return { mode: 'disabled', reason: 'fleet builtin disabilitata' };

  // builtin: fleet.json valido (loadDefinitions e' sync; garbage -> null = fail-closed).
  const { loadDefinitions } = require('../fleet/definitions.js');
  const home = cfg.home || os.homedir();
  const defsPath = cfg.fleetDefsPath || path.join(home, '.nexuscrew', 'fleet.json');
  const builtinAvail = !!loadDefinitions(defsPath);

  if (builtinAvail) return { mode: 'builtin', reason: 'NexusCrew builtin (fleet.json valido)' };
  return { mode: 'disabled', reason: 'fleet.json invalido o mancante (fail-closed)' };
}

// --- Install (speculare a installService di lib/cli/service.js) ---
// Stesso hardening di service.js: no-symlink atomic (lstat + tmp+rename), failure
// collection (NON ingoiare activation — M1), execImpl iniettabile (test). Differenze
// companion:
//  - nomi 'nexuscrew-fleet.*' + mode termux 0o755 (boot script eseguibile)
//  - linux: daemon-reload + enable, NESSUN restart (Type=oneshot -> parte al boot)
//  - mac: bootout + bootstrap (idempotente come service.js)
// Nessuna installazione reale all'import: il companion e' installato dal flusso init.

function fleetInstallPath(platform, home) {
  if (platform === 'linux') return path.join(home, '.config', 'systemd', 'user', 'nexuscrew-fleet.service');
  if (platform === 'mac') return path.join(home, 'Library', 'LaunchAgents', 'com.mmmbuto.nexuscrew-fleet.plist');
  if (platform === 'termux') return path.join(home, '.termux', 'boot', 'nexuscrew-fleet.sh');
  throw new Error(`unsupported platform: ${platform}`);
}

function fleetFileMode(platform) {
  if (platform === 'termux') return 0o755; // boot script eseguibile (design §4c: chmod 755)
  return 0o644;                            // systemd unit + launchd plist (come service.js)
}

function fleetInstallCommands(platform, target, ctx) {
  if (platform === 'linux') {
    return [
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', 'nexuscrew-fleet.service']],
      // NESSUN restart: Type=oneshot — il companion avvia le celle boot:true al boot.
    ];
  }
  if (platform === 'mac') {
    const domain = `gui/${ctx.uid || uid()}`;
    const label = `${domain}/com.mmmbuto.nexuscrew-fleet`;
    return [
      ['launchctl', ['bootout', label]],      // idempotente: ignorato se non caricato
      ['launchctl', ['bootstrap', domain, target]],
    ];
  }
  if (platform === 'termux') {
    return []; // nessun service manager; boot script + app Termux:Boot (start manuale)
  }
  return [];
}

// Install no-symlink + atomic rename (come service.js). execImpl iniettabile per test;
// default execFileSync (argv diretto, MAI shell string). Su activation fallita il file
// e' PRESERVATO e le failure raccolte per diagnosi (M1: non si ingoia, non si rollback).
function installFleetService(platform, content, ctx, { dryRun = false, execImpl = execFileSync } = {}) {
  const home = ctx.home || os.homedir();
  const target = ctx.installPath || fleetInstallPath(platform, home);
  const mode = fleetFileMode(platform);

  // lstat: reject symlink preesistente (no-symlink atomic, parita' service.js [M3])
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) {
      throw new Error(`refusing symlink install target: ${target}`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  if (dryRun) {
    return { target, mode, written: false, failures: [], note: 'dry-run: nessuna scrittura' };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp.' + process.pid; // stessa dir -> atomic rename su stesso FS
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target); // atomic
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {} // cleanup temp su failure [m1]
    throw e;
  }

  // exec service manager — raccogli failure per diagnosi (NON ingoiare, M1)
  const cmds = fleetInstallCommands(platform, target, ctx);
  const failures = [];
  for (const [bin, args] of cmds) {
    try { execImpl(bin, args, { stdio: 'ignore' }); }
    catch (e) {
      if (platform === 'mac' && bin === 'launchctl' && args[0] === 'bootout') continue;
      failures.push({ cmd: `${bin} ${args.join(' ')}`, error: e.message });
    }
  }

  return { target, mode, written: true, failures };
}

module.exports = {
  generateFleetService,
  generateFleetLinux,
  generateFleetMac,
  generateFleetTermux,
  migrationGate,
  deriveRepoRoot,
  installFleetService,
  fleetInstallPath,
  fleetFileMode,
  fleetInstallCommands,
  selectProviderModeSync,
};
