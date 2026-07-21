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
const { fleetInstallPath } = require('./fleet-service.js');
const { resolvePaths } = require('./url.js');
const { commandExists } = require('./path.js');
const { loadDefinitions } = require('../fleet/definitions.js');
const {
  termuxRuntimePaths, trustedTermuxPreload, TERMUX_EXEC_BASENAME_RE,
} = require('../runtime/env.js');

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

function decodeXmlText(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function checkMacServiceWorkingDirectory(platform, home, installPathOverride) {
  if (platform !== 'mac') {
    return { name: 'launchd cwd stabile', ok: true, detail: `${platform}: non applicabile` };
  }
  return checkServiceWorkingDirectory(platform, home, installPathOverride);
}

// The service cwd is inherited by a shared tmux server and every future pane.
// It must therefore be HOME, never the replaceable runtime directory. This
// check reads only the installed definition and fails closed on missing,
// symlinked, malformed, or legacy service files.
function checkServiceWorkingDirectory(platform, home, installPathOverride) {
  if (!['linux', 'mac', 'termux'].includes(platform)) {
    return { name: 'service cwd stabile', ok: true, detail: `${platform}: non applicabile` };
  }
  const target = installPathOverride || installPath(platform, home);
  let raw;
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) throw Object.assign(new Error('definizione service non regolare'), { code: 'UNSAFE' });
    raw = fs.readFileSync(target, 'utf8');
  }
  catch (error) {
    return {
      name: 'service cwd stabile', ok: false,
      detail: error.code === 'ENOENT' ? `service non installato (${target})` : error.message,
    };
  }
  let actual = '';
  let ok = false;
  if (platform === 'mac') {
    const match = raw.match(/<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/);
    if (!match) return { name: 'service cwd stabile', ok: false, detail: 'WorkingDirectory assente dal plist' };
    actual = decodeXmlText(match[1]);
    ok = actual === String(home);
  } else if (platform === 'linux') {
    const match = raw.match(/^WorkingDirectory=(.+)$/m);
    if (!match) return { name: 'service cwd stabile', ok: false, detail: 'WorkingDirectory assente dalla unit' };
    actual = match[1].replace(/%%/g, '%');
    ok = actual === String(home);
  } else {
    const stable = /^\s*cd -- "\$HOME"\s*$/m.test(raw);
    actual = stable ? '$HOME' : (/^\s*cd\s+--\s+(.+)$/m.exec(raw)?.[1] || 'cd assente');
    ok = stable;
  }
  return {
    name: 'service cwd stabile', ok,
    detail: ok ? (platform === 'termux' ? '$HOME' : String(home)) : `${actual} (atteso HOME stabile)`,
  };
}

// The Fleet boot companion can win the boot race and create the shared tmux
// server before the HTTP service. Apply the same stable-HOME invariant to it.
// A missing companion is non-fatal because Fleet boot is optional; an installed
// but stale/unsafe definition is a real failure.
function checkFleetServiceWorkingDirectory(platform, home, installPathOverride) {
  if (!['linux', 'mac', 'termux'].includes(platform)) {
    return { name: 'fleet service cwd stabile', ok: true, detail: `${platform}: non applicabile` };
  }
  const target = installPathOverride || fleetInstallPath(platform, home);
  try {
    fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { name: 'fleet service cwd stabile', ok: true, warn: true, detail: `companion non installato (${target})` };
    }
  }
  const result = checkServiceWorkingDirectory(platform, home, target);
  return { ...result, name: 'fleet service cwd stabile' };
}

function checkBoot(platform, home, execImpl) {
  if (platform === 'termux') {
    const p = path.join(home, '.termux', 'boot', 'nexuscrew.sh');
    const ok = fs.existsSync(p);
    return {
      name: 'boot script', ok, warn: ok,
      detail: ok
        ? `${p} · app Termux:Boot non verificabile da CLI: installala e avviala una volta`
        : 'nessun Termux:boot script',
    };
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

function checkUserLinger(platform, execImpl, uidVal) {
  if (platform !== 'linux') {
    return { name: 'user linger', ok: true, detail: `${platform}: non applicabile` };
  }
  try {
    const value = String(execImpl('loginctl', [
      'show-user', String(uidVal), '--property=Linger', '--value',
    ], { encoding: 'utf8' }) || '').trim().toLowerCase();
    const enabled = value === 'yes';
    return {
      name: 'user linger', ok: true, warn: !enabled,
      detail: enabled ? 'enabled · il servizio user puo partire senza login' : 'disabled · abilita con loginctl enable-linger per il boot senza login',
    };
  } catch (_) {
    return { name: 'user linger', ok: true, warn: true, detail: 'non verificabile; il boot senza login potrebbe non partire' };
  }
}

function checkTmuxSurvival(platform, execImpl) {
  if (platform !== 'linux') {
    return { name: 'tmux survival on service restart', ok: true, detail: `${platform}: systemd cgroup non applicabile` };
  }
  const units = ['nexuscrew.service', 'nexuscrew-fleet.service'];
  const results = [];
  for (const unit of units) {
    try {
      const loadState = String(execImpl('systemctl', [
        '--user', 'show', unit, '--property=LoadState', '--value',
      ], { encoding: 'utf8' }) || '').trim();
      if (loadState === 'not-found') {
        results.push({ unit, skipped: true, detail: 'non installata' });
        continue;
      }
      const value = String(execImpl('systemctl', [
        '--user', 'show', unit, '--property=KillMode', '--value',
      ], { encoding: 'utf8' }) || '').trim();
      results.push({ unit, ok: value === 'process', value: value || 'sconosciuto' });
    } catch (error) {
      if (/not[ -]?found|could not be found|not loaded/i.test(String(error && error.message || error))) {
        results.push({ unit, skipped: true, detail: 'non installata' });
      } else {
        results.push({ unit, ok: false, value: `non verificabile: ${error.message || error}` });
      }
    }
  }
  const checked = results.filter((result) => !result.skipped);
  const ok = checked.length > 0 && checked.every((result) => result.ok);
  const detail = results.map((result) => result.skipped
    ? `${result.unit}: ${result.detail}`
    : `${result.unit}: KillMode=${result.value}`).join(' · ');
  return {
    name: 'tmux survival on service restart', ok,
    detail: ok ? detail : `${detail} (restart/oneshot puo terminare tmux)`,
  };
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

// Presence-only Termux preload check. On the Google Play build of Termux
// (targetSdk >= 29, SELinux `untrusted_app` domain) every command pane spawned
// by the shared tmux server dies at execve() unless libtermux-exec is
// preloaded. The validated preload is preserved by minimalRuntimeEnv; this
// check tells the user, BEFORE launching a cell, whether the trusted library
// exists under PREFIX/lib and whether the current process carries a trusted
// LD_PRELOAD. It is strictly read-only: no tmux socket is touched, no service
// or device state is mutated, no command is spawned.
function checkTermuxExec(runtimeEnv, opts = {}) {
  const env = runtimeEnv || process.env;
  const platform = opts.platform || detectPlatform();
  const termux = termuxRuntimePaths(env, { platform, home: opts.home });
  if (!termux) {
    return { name: 'termux-exec preload', ok: true, detail: `${platform}: non applicabile` };
  }
  const trusted = trustedTermuxPreload(env, { platform, home: opts.home });
  const libDir = path.join(termux.prefix, 'lib');
  let present = '';
  let candidates = [];
  try {
    candidates = fs.readdirSync(libDir).filter((name) => TERMUX_EXEC_BASENAME_RE.test(name)).sort();
  } catch (_) { /* absent/unreadable */ }
  for (const name of candidates) {
    const candidate = path.join(libDir, name);
    try { if (fs.statSync(candidate).isFile()) { present = candidate; break; } } catch (_) { /* next */ }
  }
  if (trusted) {
    return { name: 'termux-exec preload', ok: true, detail: `preload trusted: ${path.basename(trusted)}` };
  }
  if (present) {
    return {
      name: 'termux-exec preload', ok: true, warn: true,
      detail: `libreria presente (${path.basename(present)}) ma LD_PRELOAD non valido nell'env del doctor: avvia il servizio da una shell Termux di login o via termux-exec preload`,
    };
  }
  return {
    name: 'termux-exec preload', ok: false,
    detail: 'libtermux-exec non trovata sotto PREFIX/lib: sulla build Google Play celle e shell non possono eseguire comandi',
  };
}

// Read-only probe of the long-lived tmux server cwd. A server that retained an
// unlinked runtime directory keeps accepting clients but makes later children
// fail getcwd(3). Never reports the path itself; only stable state.
function checkTmuxServerCwd(platform, execImpl, opts = {}) {
  if (!['linux', 'termux'].includes(platform)) {
    return { name: 'tmux server cwd', ok: true, detail: `${platform}: non applicabile` };
  }
  let rawPid = '';
  try {
    rawPid = String(execImpl(opts.tmuxBin || 'tmux', ['display-message', '-p', '#{pid}'], { encoding: 'utf8' }) || '').trim();
  } catch (_) {
    return { name: 'tmux server cwd', ok: true, warn: true, detail: 'server tmux non attivo; probe rinviato al primo avvio' };
  }
  if (!/^\d+$/.test(rawPid)) {
    return { name: 'tmux server cwd', ok: true, warn: true, detail: 'server tmux non rilevato' };
  }
  try {
    const resolveImpl = opts.procCwdImpl || ((pid) => fs.realpathSync(`/proc/${pid}/cwd`));
    const cwd = resolveImpl(Number(rawPid));
    if (typeof cwd !== 'string' || !cwd) throw new Error('cwd vuota');
    return { name: 'tmux server cwd', ok: true, detail: 'cwd risolvibile' };
  } catch (_) {
    return {
      name: 'tmux server cwd', ok: false,
      detail: 'cwd del server tmux non risolvibile (directory sostituita); termina le sessioni in modo esplicito e riavvia tmux',
    };
  }
}

// Inspect only the single tmux global environment key required by
// termux-exec. The value is validated and then discarded; it is never logged.
// This distinguishes a healthy server from RC-2 (stale/no preload) and RC-7
// (present but rejected by the trust boundary) without killing any session.
function checkTmuxServerTermuxPreload(runtimeEnv, execImpl, opts = {}) {
  const env = runtimeEnv || process.env;
  const platform = opts.platform || detectPlatform();
  if (!termuxRuntimePaths(env, { platform, home: opts.home })) {
    return { name: 'tmux server termux-exec', ok: true, detail: `${platform}: non applicabile` };
  }
  let raw = '';
  try {
    raw = String(execImpl(opts.tmuxBin || 'tmux', ['show-environment', '-g', 'LD_PRELOAD'], { encoding: 'utf8' }) || '').trim();
  } catch (_) {
    return { name: 'tmux server termux-exec', ok: true, warn: true, detail: 'server tmux non attivo; probe rinviato al primo avvio' };
  }
  const match = raw.match(/^LD_PRELOAD=(.+)$/);
  const trusted = match && trustedTermuxPreload({ ...env, LD_PRELOAD: match[1] }, { platform, home: opts.home });
  return trusted
    ? { name: 'tmux server termux-exec', ok: true, detail: 'preload trusted presente nel server tmux' }
    : {
      name: 'tmux server termux-exec', ok: false,
      detail: 'LD_PRELOAD assente o non trusted nel server tmux; server stale o formato non compatibile (nessun kill automatico)',
    };
}

// Check MCP identity (P0). NON-FAILING per costrutto: `ok` è sempre true, così
// chi usa NexusCrew solo come PWA (nessuna integrazione MCP) non vede mai il
// doctor andare in FAIL solo per env MCP assente. Il check osserva SOLO la
// presence delle env var di identità nel processo che lancia `doctor` (nessuna
// lettura di ~/.codex/config.toml, cache private o config MCP).
//
// LIMITE DOCUMENTATO (P0): `doctor` non gira dentro il server MCP stdio e non può
// distinguere in modo portatile "MCP configurato" da "PWA-only". Il WARN è quindi
// conservativo e informativo: segnala l'assenza di identità osservabile a chi sta
// configurando l'MCP, senza rompere l'utente PWA-only (per il quale ok resta true).
function checkMcpIdentity(env) {
  const e = env || process.env;
  const hasTmux = !!(typeof e.TMUX === 'string' && e.TMUX);
  const hasSession = !!(typeof e.NEXUSCREW_MCP_SESSION === 'string' && e.NEXUSCREW_MCP_SESSION.trim());
  if (hasTmux || hasSession) {
    const src = [];
    if (hasTmux) src.push('TMUX');
    if (hasSession) src.push('NEXUSCREW_MCP_SESSION');
    return {
      name: 'MCP identity env',
      ok: true,
      detail: `identita osservabile (${src.join('+')})`,
    };
  }
  return {
    name: 'MCP identity env',
    ok: true, // mai FAIL: PWA-only senza MCP configurato non deve rompere il doctor
    warn: true,
    detail: 'nessuna identita MCP osservabile (TMUX/NEXUSCREW_MCP_SESSION assenti nel processo doctor); '
      + 'se integri l\'MCP stdio allowlista i nomi (codex-vl mcp add --env-var) — PWA-only: ignorabile',
  };
}

function checkFleetDefinitions(home, fleetDefsPath, enabled = true) {
  const target = fleetDefsPath || path.join(home, '.nexuscrew', 'fleet.json');
  if (!enabled) {
    return { name: 'Fleet builtin definitions', ok: true, warn: true, detail: 'disabilitata intenzionalmente' };
  }
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (e) {
    return {
      name: 'Fleet builtin definitions', ok: false,
      detail: e.code === 'ENOENT' ? `fleet.json assente (${target}); esegui nexuscrew per riparare` : e.message,
    };
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    return { name: 'Fleet builtin definitions', ok: false, detail: `target non sicuro o non regolare (${target})` };
  }
  const defs = loadDefinitions(target);
  if (!defs) {
    return { name: 'Fleet builtin definitions', ok: false, detail: `fleet.json invalido (${target}); preservato, non sovrascritto` };
  }
  const mode = st.mode & 0o777;
  return {
    name: 'Fleet builtin definitions', ok: true, warn: mode !== 0o600,
    detail: `${defs.engines.length} engine · ${defs.cells.length} celle · mode 0${mode.toString(8)}`,
  };
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
  const fleetEnabled = opts.fleetEnabled !== false
    && opts.builtinEnabled !== false
    && process.env.NEXUSCREW_FLEET !== '0';

  const checks = [
    checkNode(),
    checkTmux(existsImpl, opts.tmuxBin),
    checkPty(ptyLoad),
    checkService(platform, home, execImpl, uidVal, opts.installPath),
    checkServiceWorkingDirectory(platform, home, opts.installPath),
    fleetEnabled
      ? checkFleetServiceWorkingDirectory(platform, home, opts.fleetInstallPath)
      : { name: 'fleet service cwd stabile', ok: true, warn: true, detail: 'Fleet disabilitata' },
    checkBoot(platform, home, execImpl),
    checkUserLinger(platform, execImpl, uidVal),
    checkTmuxSurvival(platform, execImpl),
    checkTokenPerms(tokenPath),
    checkFleetDefinitions(home, opts.fleetDefsPath, fleetEnabled),
    checkTermuxExec(opts.env, { platform, home }),
    checkSshClient(existsImpl),
    checkAutossh(existsImpl),
    checkSshPermitlisten(opts.sshVersion),
    checkMcpIdentity(opts.env),
    checkTmuxServerCwd(platform, execImpl, { tmuxBin: opts.tmuxBin, procCwdImpl: opts.procCwdImpl }),
    checkTmuxServerTermuxPreload(opts.env, execImpl, { platform, home, tmuxBin: opts.tmuxBin }),
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
  checkMacServiceWorkingDirectory,
  checkFleetDefinitions,
  checkServiceWorkingDirectory,
  checkFleetServiceWorkingDirectory,
  checkTmuxSurvival, checkUserLinger,
  checkSshClient, checkAutossh, checkSshPermitlisten,
  checkMcpIdentity, checkTermuxExec,
  checkTmuxServerCwd, checkTmuxServerTermuxPreload,
};
