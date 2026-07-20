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
const { loadDefinitions } = require('../fleet/definitions.js');

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
    checkBoot(platform, home, execImpl),
    checkUserLinger(platform, execImpl, uidVal),
    checkTmuxSurvival(platform, execImpl),
    checkTokenPerms(tokenPath),
    checkFleetDefinitions(home, opts.fleetDefsPath, fleetEnabled),
    checkSshClient(existsImpl),
    checkAutossh(existsImpl),
    checkSshPermitlisten(opts.sshVersion),
    checkMcpIdentity(opts.env),
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
  checkFleetDefinitions,
  checkTmuxSurvival, checkUserLinger,
  checkSshClient, checkAutossh, checkSshPermitlisten,
  checkMcpIdentity,
};
