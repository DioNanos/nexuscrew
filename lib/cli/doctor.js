'use strict';
// nexuscrew doctor: auto-diagnosi (design §3, §7). [A2]
// Struttura ESTENSIBILE: una lista di check-fn, ognuna ritorna
//   { name, ok, warn?, detail? }. SSH è un requisito locale; la policy del
// server remoto si prova soltanto tentando il forwarding reale.
// Exit code: 0 se tutti ok (i warn non falliscono), 1 se almeno un check è FAIL.
// Nessun segreto nell'output (mai il token, solo il path + i permessi).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { detectPlatform, uid } = require('./platform.js');
const { installPath } = require('./service.js');
const { resolvePaths } = require('./url.js');
const { commandExists } = require('./path.js');

function nodeMajor() {
  return parseInt(String(process.versions.node).split('.')[0], 10);
}

function checkNode() {
  const maj = nodeMajor();
  return { name: 'node >= 18', ok: maj >= 18, detail: `v${process.versions.node}` };
}

function checkTmux(existsImpl, tmuxBin) {
  return existsImpl(tmuxBin || 'tmux')
    ? { name: 'tmux presente', ok: true }
    : { name: 'tmux presente', ok: false, detail: 'non trovato su PATH (installa tmux)' };
}

function checkPty(ptyLoad) {
  try {
    ptyLoad();
    return { name: 'PTY prebuilt caricabile', ok: true };
  } catch (e) {
    return { name: 'PTY prebuilt caricabile', ok: false, detail: e && e.message ? e.message : 'load fallito' };
  }
}

function checkService(platform, home, execImpl, uidVal, installPathOverride) {
  const target = installPathOverride || installPath(platform, home);
  const installed = fs.existsSync(target);
  let active = false;
  try {
    if (platform === 'linux') {
      const s = execImpl('systemctl', ['--user', 'is-active', 'nexuscrew'], { encoding: 'utf8' });
      active = String(s).trim() === 'active';
    } else if (platform === 'mac') {
      execImpl('launchctl', ['print', `gui/${uidVal}/com.mmmbuto.nexuscrew`], { stdio: 'ignore' });
      active = true;
    } else if (platform === 'termux') {
      const pidf = require('./pidfile.js');
      const meta = pidf.readPidfile(pidf.defaultPidfilePath(home));
      active = !!(meta && pidf.isAlive(meta));
    }
  } catch (_) { active = false; }
  return {
    name: 'service installato/attivo',
    ok: installed,
    warn: installed && !active, // installato ma non attivo = warning, non fail
    detail: installed ? (active ? 'attivo' : 'installato ma non attivo') : `non installato (${target})`,
  };
}

function checkBoot(platform, home, execImpl) {
  if (platform === 'termux') {
    const p = path.join(home, '.termux', 'boot', 'nexuscrew.sh');
    const ok = fs.existsSync(p);
    return { name: 'boot script', ok, warn: !ok, detail: ok ? p : 'nessun Termux:boot script' };
  }
  if (platform === 'linux') {
    try {
      const s = execImpl('systemctl', ['--user', 'is-enabled', 'nexuscrew'], { encoding: 'utf8' });
      const enabled = String(s).trim() === 'enabled';
      return { name: 'boot (systemd enabled)', ok: true, warn: !enabled, detail: enabled ? 'enabled' : 'non enabled (non parte al boot)' };
    } catch (_) {
      return { name: 'boot (systemd enabled)', ok: true, warn: true, detail: 'non enabled' };
    }
  }
  // mac: RunAtLoad nel plist installato
  const target = installPath('mac', home);
  const ok = fs.existsSync(target);
  return { name: 'boot (launchd RunAtLoad)', ok: true, warn: !ok, detail: ok ? 'plist installato' : 'plist non installato' };
}

function checkTmuxSurvival(platform, execImpl) {
  if (platform !== 'linux') {
    return { name: 'tmux survival on service restart', ok: true, detail: `${platform}: systemd cgroup non applicabile` };
  }
  try {
    const value = String(execImpl('systemctl', [
      '--user', 'show', 'nexuscrew.service', '--property=KillMode', '--value',
    ], { encoding: 'utf8' }) || '').trim();
    const ok = value === 'process';
    return {
      name: 'tmux survival on service restart', ok,
      detail: ok ? 'KillMode=process' : `KillMode=${value || 'sconosciuto'} (restart NexusCrew puo terminare tmux)`,
    };
  } catch (error) {
    return { name: 'tmux survival on service restart', ok: false, detail: `KillMode non verificabile: ${error.message || error}` };
  }
}

// ssh client presente su PATH: prerequisito dei tunnel multi-node (design §4).
function checkSshClient(existsImpl) {
  return existsImpl('ssh')
    ? { name: 'OpenSSH transport', ok: true, detail: 'ssh presente · USATO dal supervisor NexusCrew' }
    : { name: 'OpenSSH transport', ok: false, detail: 'ssh non trovato su PATH; autossh da solo non funziona senza OpenSSH' };
}

function checkAutossh(existsImpl) {
  return existsImpl('autossh')
    ? { name: 'autossh', ok: true, detail: 'presente · NON usato (retry gia gestito dal supervisor NexusCrew)' }
    : { name: 'autossh', ok: true, warn: true, detail: 'assente · opzionale, non necessario con SSH supervisionato' };
}

// Versione locale informativa. `permitlisten` e' una policy del server sshd e
// NON puo' essere certificata guardando `ssh -V` sul client: Share la verifica
// con un vero -R + health autenticato.
function checkSshPermitlisten(sshVersionImpl) {
  const tun = require('../nodes/tunnel.js');
  const v = tun.readSshVersion(sshVersionImpl);
  if (!v) return { name: 'OpenSSH version', ok: true, warn: true, detail: 'versione non determinabile; Share verra verificato a runtime sul server' };
  return { name: 'OpenSSH version', ok: true, detail: `${v.raw} · policy reverse verificata a runtime` };
}

function checkTokenPerms(tokenPath) {
  try {
    const st = fs.lstatSync(tokenPath);
    if (st.isSymbolicLink()) {
      return { name: 'token file permessi', ok: false, detail: 'è un symlink (rifiutato)' };
    }
    const mode = st.mode & 0o777;
    const ok = mode === 0o600;
    return { name: 'token file permessi', ok, detail: `mode 0${mode.toString(8)}${ok ? '' : ' (atteso 0600)'}` };
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { name: 'token file permessi', ok: false, detail: 'token assente (esegui init)' };
    }
    return { name: 'token file permessi', ok: false, detail: e.message };
  }
}

// Esegue tutti i check. Seam iniettabili per test (platform, home, execImpl, ptyLoad).
function doctor(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const home = opts.home || os.homedir();
  const execImpl = opts.execImpl || execFileSync;
  const uidVal = opts.uid || uid();
  const log = opts.log || console.log;
  const ptyLoad = opts.ptyLoad || (() => require('../pty/provider.js').loadPty());
  const existsImpl = opts.commandExists || commandExists;
  const { tokenPath } = resolvePaths(opts);

  const checks = [
    checkNode(),
    checkTmux(existsImpl, opts.tmuxBin),
    checkPty(ptyLoad),
    checkService(platform, home, execImpl, uidVal, opts.installPath),
    checkBoot(platform, home, execImpl),
    checkTmuxSurvival(platform, execImpl),
    checkTokenPerms(tokenPath),
    checkSshClient(existsImpl),
    checkAutossh(existsImpl),
    checkSshPermitlisten(opts.sshVersion),
  ];

  for (const c of checks) {
    const tag = c.ok ? (c.warn ? 'WARN' : 'OK  ') : 'FAIL';
    log(`${tag}  ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  }
  const ok = checks.every((c) => c.ok); // i warn non fanno fallire
  log(ok ? 'doctor: tutto ok' : 'doctor: problemi rilevati (vedi FAIL sopra)');
  return { platform, checks, ok, code: ok ? 0 : 1 };
}

module.exports = {
  doctor, nodeMajor,
  checkNode, checkTmux, checkPty, checkService, checkBoot, checkTokenPerms,
  checkTmuxSurvival,
  checkSshClient, checkAutossh, checkSshPermitlisten,
};
