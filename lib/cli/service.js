'use strict';
// Service generation per-platform: systemd --user (linux), launchd plist (mac),
// Termux:boot script. Escaping per-platform + install no-symlink atomic. [M2][M3][B1][R2][R3]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { detectPlatform, uid } = require('./platform.js');

// --- Escaping helpers ---

// systemd WorkingDirectory: escape % (percent specifier). Spazi ok.
function escapeSystemdPath(s) {
  return String(s).replace(/%/g, '%%');
}

// systemd ExecStart arg: escape backslash, %, spazio.
function escapeSystemdExec(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '%%')
    .replace(/ /g, '\\ ');
}

// launchd plist XML escape.
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// POSIX shell single-quote.
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// systemd ExecStart non gestisce bene alcuni char (", $, ;, backtick, newline, apice)
// nemmeno con escaping ad hoc: reject esplicito con errore chiaro. [M3]
// space e % sono ok (escaped). Path repo normali non hanno questi char.
const SYSTEMD_FORBIDDEN = /[";$`\n']/;
function assertSystemdSafe(label, p) {
  if (SYSTEMD_FORBIDDEN.test(String(p))) {
    throw new Error(`${label} path contiene caratteri non supportati in systemd (", $, ;, backtick, newline, apice): "${p}". Usa un path senza questi caratteri (spazi e % sono ok).`);
  }
}

// --- Templates ---

function generateService(platform, ctx) {
  if (platform === 'linux') return generateLinux(ctx);
  if (platform === 'mac') return generateMac(ctx);
  if (platform === 'termux') return generateTermux(ctx);
  throw new Error(`unsupported platform: ${platform}`);
}

function generateLinux(ctx) {
  assertSystemdSafe('repoRoot', ctx.repoRoot); // [M3] reject char non gestibili
  assertSystemdSafe('nodeBin', ctx.nodeBin);
  const repo = escapeSystemdPath(ctx.repoRoot);
  const node = escapeSystemdExec(ctx.nodeBin);
  const repoBin = escapeSystemdExec(path.join(ctx.repoRoot, 'bin', 'nexuscrew.js'));
  const nodeDir = escapeSystemdPath(path.dirname(ctx.nodeBin));
  return `# NexusCrew service (systemd --user, loopback, solo tunnel SSH/VPN)
[Unit]
Description=NexusCrew - browser tmux client (loopback, solo tunnel SSH/VPN)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${repo}
Environment=PATH=${nodeDir}:/usr/local/bin:/usr/bin:/bin
ExecStart=${node} ${repoBin} serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function generateMac(ctx) {
  const nodeXml = escapeXml(ctx.nodeBin);
  const repoBinXml = escapeXml(path.join(ctx.repoRoot, 'bin', 'nexuscrew.js'));
  const repoXml = escapeXml(ctx.repoRoot);
  const homeXml = escapeXml(ctx.home);
  const launchPath = [...new Set([
    path.dirname(ctx.nodeBin), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ])].join(':');
  const launchPathXml = escapeXml(launchPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mmmbuto.nexuscrew</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeXml}</string>
    <string>${repoBinXml}</string>
    <string>serve</string>
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
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${homeXml}/.nexuscrew/nexuscrew.log</string>
  <key>StandardErrorPath</key>
  <string>${homeXml}/.nexuscrew/nexuscrew.log</string>
</dict>
</plist>
`;
}

function generateTermux(ctx) {
  const nodeQ = shellQuote(ctx.nodeBin);
  const repoBinQ = shellQuote(path.join(ctx.repoRoot, 'bin', 'nexuscrew.js'));
  const repoQ = shellQuote(ctx.repoRoot);
  return `#!/data/data/com.termux/files/usr/bin/sh
# NexusCrew boot (Termux) - loopback, localhost del telefono
export PATH=/data/data/com.termux/files/usr/bin:$PATH
export HOME=/data/data/com.termux/files/home
cd -- ${repoQ}
termux-wake-lock 2>/dev/null || true
mkdir -p "$HOME/.nexuscrew"
exec ${nodeQ} ${repoBinQ} serve --pidfile >> "$HOME/.nexuscrew/nexuscrew.log" 2>&1
`;
}

// --- Install paths ---

function installPath(platform, home) {
  if (platform === 'linux') return path.join(home, '.config', 'systemd', 'user', 'nexuscrew.service');
  if (platform === 'mac') return path.join(home, 'Library', 'LaunchAgents', 'com.mmmbuto.nexuscrew.plist');
  if (platform === 'termux') return path.join(home, '.termux', 'boot', 'nexuscrew.sh');
  throw new Error(`unsupported platform: ${platform}`);
}

function fileMode(platform) {
  if (platform === 'termux') return 0o700;
  return 0o644; // systemd unit + launchd plist
}

// Install no-symlink + atomic rename. [M3]
// - lstat target: reject symlink (no follow)
// - write temp file nella stessa dir -> chmod mode -> atomic rename
// - exec service manager (systemctl/launchctl); skip in dryRun
// execImpl per test (default execFileSync).
function installService(platform, content, ctx, { dryRun = false, execImpl = execFileSync } = {}) {
  const home = ctx.home || os.homedir();
  const target = ctx.installPath || installPath(platform, home);
  const mode = fileMode(platform);

  // lstat: reject symlink preesistente
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
  // temp file stessa dir (per atomic rename su stesso filesystem)
  const tmp = target + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target); // atomic
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {} // cleanup temp su failure [m1]
    throw e;
  }

  // exec service manager — NON ingoiare failure (M1): raccogli per diagnosi
  const cmds = installCommands(platform, target, ctx);
  const failures = [];
  for (const [bin, args] of cmds) {
    try { execImpl(bin, args, { stdio: 'ignore' }); }
    catch (e) {
      // bootout e' idempotente: un job non ancora caricato non e' un errore di installazione.
      if (platform === 'mac' && bin === 'launchctl' && args[0] === 'bootout') continue;
      failures.push({ cmd: `${bin} ${args.join(' ')}`, error: e.message });
    }
  }

  return { target, mode, written: true, failures };
}

function installCommands(platform, target, ctx) {
  if (platform === 'linux') {
    return [
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', 'nexuscrew']],
      ['systemctl', ['--user', 'restart', 'nexuscrew']], // restart carica nuovo codice (drop-in)
    ];
  }
  if (platform === 'mac') {
    const domain = `gui/${ctx.uid || uid()}`;
    const label = `${domain}/com.mmmbuto.nexuscrew`;
    // bootout (ignore se non esiste) poi bootstrap
    return [
      ['launchctl', ['bootout', label]],
      ['launchctl', ['bootstrap', domain, target]],
    ];
  }
  if (platform === 'termux') {
    return []; // nessun service manager; boot script + start manuale (nohup+pidfile)
  }
  return [];
}

module.exports = {
  generateService, generateLinux, generateMac, generateTermux,
  installService, installPath, installCommands, fileMode,
  escapeSystemdPath, escapeSystemdExec, escapeXml, shellQuote,
  assertSystemdSafe, SYSTEMD_FORBIDDEN,
};
