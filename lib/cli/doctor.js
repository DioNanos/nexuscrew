'use strict';
// nexuscrew doctor: self-diagnosis entry point.
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
const { commandExists, resolveCommand } = require('./path.js');
const { loadDefinitions } = require('../fleet/definitions.js');
const { loadConfig } = require('../config.js');
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

function checkTmux(existsImpl, tmuxBin, resolveImpl) {
  if (existsImpl(tmuxBin || 'tmux')) return { name: 'tmux presente', ok: true };
  // existsImpl e' un booleano (spesso un seam di test): non dice se e' una
  // vera assenza o una verifica impossibile. Quando disponibile, resolveImpl
  // arricchisce SOLO il messaggio — mai la decisione ok/fail, che resta
  // quella di existsImpl.
  if (resolveImpl) {
    const r = resolveImpl(tmuxBin || 'tmux');
    if (r && r.blocked && r.blocked.length) {
      const detail = r.blocked.map((b) => `${b.path} (${b.code})`).join('; ');
      return { name: 'tmux presente', ok: false, detail: `non verificabile su PATH, non "non installato" (${detail})` };
    }
  }
  return { name: 'tmux presente', ok: false, detail: 'non trovato su PATH (installa tmux)' };
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
  let activeUnverifiable = null; // null = stato verificato (attivo o no); string = non ho potuto verificare
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
  } catch (e) {
    active = false;
    // Linux: systemctl assente (ENOENT) o bus/dbus down = non ho potuto VERIFICARE
    // se e' attivo; systemctl che gira e risponde 'inactive' (altri throw) =
    // legittimo "non attivo", VERIFICATO. Verdetto invariato (active resta false,
    // ok/warn non cambiano); il messaggio distingue, come checkTmuxSurvival nello
    // stesso file. Il discriminante e' CHI ha fallito, non che e' ci sia stata
    // un'eccezione. mac/termux non toccati: il collasso nominato e' linux/systemctl.
    if (platform === 'linux' && systemctlUnverifiable(e)) activeUnverifiable = e.code || e.message || e.constructor.name;
  }
  return {
    name: 'service installato/attivo',
    ok: installed,
    warn: installed && !active, // installato ma non attivo = warning, non fail
    detail: installed
      ? (active
        ? 'attivo'
        : (activeUnverifiable
          ? `installato, stato attivita' non verificabile (systemctl/dbus: ${activeUnverifiable}), non "non attivo"`
          : 'installato ma non attivo'))
      : `non installato (${target})`,
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
    } catch (e) {
      // systemctl assente (ENOENT) o bus/dbus down = non ho potuto verificare se
      // e' enabled; systemctl che gira e risponde 'disabled'/'masked' (altri
      // throw) = legittimo "non enabled", VERIFICATO. Verdetto invariato
      // (ok:true, warn:true); il messaggio distingue, come checkTmuxSurvival.
      if (systemctlUnverifiable(e)) {
        return { name: 'boot (systemd enabled)', ok: true, warn: true, detail: `non verificabile (systemctl/dbus non raggiungibile: ${e.code || e.message || e.constructor.name}): l'unita' potrebbe essere enabled, non ho potuto guardare` };
      }
      return { name: 'boot (systemd enabled)', ok: true, warn: true, detail: 'non enabled (non parte al boot)' };
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

// systemctl assente (ENOENT: il binario non e' sul PATH) o bus/dbus non
// raggiungibile = non ho potuto VERIFICARE lo stato, distinto da systemctl che
// ha GIRATO e ha risposto 'inactive'/'disabled' (legittimo "non attivo"/"non
// enabled"). Stesso principio di checkTmuxSurvival (sotto): il discriminante e'
// CHI ha fallito, non che ci sia stata un'eccezione. Function declaration: hoisted,
// quindi disponibile a checkService/checkBoot che la precedono nel sorgente.
function systemctlUnverifiable(e) {
  if (!e) return false;
  if (e.code === 'ENOENT') return true; // systemctl non installato su PATH
  const msg = String((e && e.message) || e);
  return /Failed to connect to bus|Unable to connect to bus|D-Bus|dbus|Could not connect|Connection refused|Failed to get (D-?bus|the bus)/i.test(msg);
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

// ssh client on PATH: prerequisite for the multi-node tunnels.
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
  // Stessa forma gia' corretta altrove: ENOENT ("PREFIX/lib non c'e'") e'
  // legittimo, ma EACCES/ELOOP/ENOTDIR ("non sono riuscito a leggere la
  // directory") non e' un'assenza — e' un fallimento della verifica. Il
  // verdetto resta ok:false in entrambi i casi (in nessuno dei due possiamo
  // CONFERMARE che la libreria trusted esista): solo il messaggio distingue.
  let libDirBlocked = null;
  try {
    candidates = fs.readdirSync(libDir).filter((name) => TERMUX_EXEC_BASENAME_RE.test(name)).sort();
  } catch (e) {
    if (e.code !== 'ENOENT') libDirBlocked = `${e.code || e.constructor.name}: ${e.message}`;
  }
  // Riconsegna: il fix sopra copriva readdirSync sulla DIRECTORY, ma il
  // difetto era tornato un passo piu' avanti, nella stessa funzione —
  // statSync su ogni CANDIDATO ricollassava EACCES/ELOOP in "prossimo",
  // indistinguibile da "questo nome non e' un file valido". Misurato: un
  // candidato che e' un symlink circolare (o rotto in modo diverso da
  // ENOENT) fa fallire statSync con ELOOP — la libreria potrebbe essere
  // davvero li' dietro, solo irraggiungibile in questo modo specifico. Se
  // TUTTI i candidati finiscono bloccati, il loop esce con present='' e,
  // senza questo tracciamento, il ramo finale direbbe "non trovata" —
  // esattamente il messaggio fuorviante gia' chiuso una volta, tornato un
  // passo piu' avanti nella stessa funzione.
  const candidateBlocked = [];
  for (const name of candidates) {
    const candidate = path.join(libDir, name);
    try {
      if (fs.statSync(candidate).isFile()) { present = candidate; break; }
    } catch (e) {
      if (e.code !== 'ENOENT') candidateBlocked.push(`${name} (${e.code || e.constructor.name})`);
    }
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
  if (libDirBlocked) {
    return {
      name: 'termux-exec preload', ok: false,
      detail: `non ho potuto verificare PREFIX/lib (${libDirBlocked}), non "assente": sulla build Google Play celle e shell non possono eseguire comandi se manca davvero`,
    };
  }
  if (candidateBlocked.length) {
    return {
      name: 'termux-exec preload', ok: false,
      detail: `non ho potuto verificare ${candidateBlocked.length === 1 ? 'un candidato' : 'alcuni candidati'} sotto PREFIX/lib (${candidateBlocked.join('; ')}), non "assente": sulla build Google Play celle e shell non possono eseguire comandi se manca davvero`,
    };
  }
  return {
    name: 'termux-exec preload', ok: false,
    detail: 'libtermux-exec non trovata sotto PREFIX/lib: sulla build Google Play celle e shell non possono eseguire comandi',
  };
}

// «Server assente» e «non ho potuto guardare» sono due cose diverse, e vanno
// dette diverse. La prima e' uno stato normale — il server non c'e' ancora, la
// probe si rinvia al primo avvio. La seconda e' un'informazione che manca:
// collassarla nella prima significa dichiarare sano cio' che non si e'
// verificato, che e' esattamente il modo in cui un permesso sbagliato resta
// invisibile. E' la stessa distinzione gia' fatta fra «manca» e «non
// verificabile» altrove nel prodotto.
function classifyTmuxProbeCause(error) {
  const code = String((error && error.code) || '');
  const message = String((error && error.message) || error || '');
  if (code === 'ENOENT'
    || /no server running|no such file or directory|connection refused|no sessions/i.test(message)) {
    return 'absent';
  }
  const cause = (code || message.trim() || 'errore non nominato');
  return cause.length > 120 ? `${cause.slice(0, 117)}...` : cause;
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
  } catch (error) {
    const cause = classifyTmuxProbeCause(error);
    if (cause === 'absent') {
      return { name: 'tmux server cwd', ok: true, warn: true, detail: 'server tmux non attivo; probe rinviato al primo avvio' };
    }
    return {
      name: 'tmux server cwd', ok: false, warn: true,
      detail: `probe non verificabile: ${cause}`,
    };
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
// This distinguishes a healthy server from a stale run (no preload) and one
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
  } catch (err) {
    // Con il server ATTIVO `tmux show-environment -g <var>` esce 1 scrivendo
    // "unknown variable" su stderr: execFileSync lo rigetta come errore, come
    // fa per un server assente ("no server running"), ma i due esiti non sono
    // la stessa cosa. L'assenza della variabile merita un WARN col rimedio,
    // non l'esito «server non attivo».
    const msg = String((err && (err.stderr || err.message)) || '');
    if (/unknown variable/i.test(msg)) {
      return {
        name: 'tmux server termux-exec', ok: true, warn: true,
        detail: 'server tmux attivo ma LD_PRELOAD non impostato (tmux: unknown variable); al primo avvio verra\' impostata, oppure: tmux set-environment -g LD_PRELOAD <libtermux-exec-ld-preload.so>',
      };
    }
    // Classificazione dell'errore tmux: solo il «no server running» autentico
    // dice che il server non c'è. Un «error connecting ... (Permission denied)»
    // o qualunque altro fallimento lasciano la domanda aperta — il socket
    // esiste ma questo utente non può leggerlo — e diventano «probe non
    // verificabile» con lo stderr nel dettaglio, non un falso «server assente».
    if (/permission denied/i.test(msg)) {
      return {
        name: 'tmux server termux-exec', ok: true, warn: true,
        detail: `probe non verificabile: il socket tmux risponde "${msg}"; il server potrebbe essere attivo ma non leggibile con questo utente`,
      };
    }
    if (/no server running|error connecting/i.test(msg)) {
      return { name: 'tmux server termux-exec', ok: true, warn: true, detail: 'server tmux non attivo; probe rinviato al primo avvio' };
    }
    return {
      name: 'tmux server termux-exec', ok: true, warn: true,
      detail: `probe non verificabile: tmux ha risposto "${msg}"; stato del server non determinabile da qui`,
    };
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

// Check MCP identity. NON-FAILING per costrutto: `ok` è sempre true, così
// chi usa NexusCrew solo come PWA (nessuna integrazione MCP) non vede mai il
// doctor andare in FAIL solo per env MCP assente. Il check osserva SOLO la
// presence delle env var di identità nel processo che lancia `doctor` (nessuna
// lettura di ~/.codex/config.toml, cache private o config MCP).
//
// LIMITE DOCUMENTATO: `doctor` non gira dentro il server MCP stdio e non può
// distinguere in modo portatile "MCP configurato" da "PWA-only". Il WARN è quindi
// conservativo e informativo: segnala l'assenza di identità osservabile a chi sta
// configurando l'MCP, senza rompere l'utente PWA-only (per il quale ok resta true).
function checkMcpIdentity(env) {
  const e = env || process.env;
  const hasTmux = !!(typeof e.TMUX === 'string' && e.TMUX);
  const hasSession = !!(typeof e.NEXUSCREW_MCP_SESSION === 'string' && e.NEXUSCREW_MCP_SESSION.trim());
  const verifiedNames = [
    'NEXUSCREW_VERIFIED_ENV_VERSION',
    'NEXUSCREW_VERIFIED_OWNER_INSTANCE_ID',
    'NEXUSCREW_VERIFIED_CELL_ID',
    'NEXUSCREW_VERIFIED_INCARNATION_ID',
    'NEXUSCREW_VERIFIED_BINDING_ID',
    'NEXUSCREW_VERIFIED_ORIGIN',
    'NEXUSCREW_VERIFIED_THREAD_ID',
  ];
  const verifiedPresent = verifiedNames.filter((name) => typeof e[name] === 'string' && e[name]);
  if (verifiedPresent.length) {
    return {
      name: 'MCP identity env',
      ok: true,
      detail: `metadati verified osservabili (${verifiedPresent.length}/7 nomi NEXUSCREW_VERIFIED_*): `
        + 'identita attribuita solo dopo introspezione authority riuscita',
    };
  }
  if (hasTmux || hasSession) {
    const src = [];
    if (hasTmux) src.push('TMUX');
    if (hasSession) src.push('NEXUSCREW_MCP_SESSION');
    return {
      name: 'MCP identity env',
      ok: true,
      detail: `identita legacy osservabile (${src.join('+')})`,
    };
  }
  return {
    name: 'MCP identity env',
    ok: true, // mai FAIL: PWA-only senza MCP configurato non deve rompere il doctor
    warn: true,
    detail: 'nessuna identita MCP osservabile (nessun NEXUSCREW_VERIFIED_* e nessuna variabile legacy '
      + 'nel processo doctor). Percorsi validi: sessione verified (codex-vl >= 0.154.0-vl.3 + NexusCrew '
      + '>= 0.9.25 con authority mode provisionato) oppure sessione legacy con le tre variabili ereditate '
      + 'dal client MCP. NON allowlistare i nomi legacy in env_vars del server MCP: con vl.3 lo spawn '
      + 'verified fallisce — PWA-only: ignorabile',
  };
}

// Stato dell'authority mode (registro flotta). Mostra mode e costruibilita' dell'
// authority (file presenti, permessi) SENZA mai esporre valori.
function checkIdentityAuthorityMode({ home, configPath, env } = {}) {
  const e = env || process.env;
  const fs = require('node:fs');
  const path = require('node:path');
  const cfgPath = configPath
    || process.env.NEXUSCREW_CONFIG_FILE
    || path.join(home || os.homedir(), '.nexuscrew', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch (_) { cfg = {}; }
  const mode = cfg.fleetIdentityMode
    || (cfg.fleet && cfg.fleet.identity && cfg.fleet.identity.mode)
    || 'legacy';
  const dir = cfg.identityAuthorityDir || path.join(home || os.homedir(), '.nexuscrew', 'identity-authority');
  const files = ['daemon.credential', 'launcher.credential'];
  const present = [];
  const values = {};
  const problems = [];
  for (const name of files) {
    const filePath = path.join(dir, name);
    try {
      const st = fs.lstatSync(filePath);
      if (!st.isFile()) { problems.push(`${name}: non regolare`); continue; }
      if ((st.mode & 0o777) !== 0o600) { problems.push(`${name}: permessi non 0600`); continue; }
      const value = fs.readFileSync(filePath, 'utf8').trim();
      if (!value) { problems.push(`${name}: vuoto`); continue; }
      present.push(name);
      values[name] = value;
    } catch (_) { problems.push(`${name}: assente`); }
  }
  // The two credentials must be DISTINCT (constant-time comparison):
  // identical means the authority is not constructible, fail-closed.
  let distinctLine = 'credentials distinct: n/a (una o entrambe assenti)';
  if (present.length === 2) {
    const distinct = Buffer.from(values['daemon.credential'])
      .compare(Buffer.from(values['launcher.credential'])) !== 0;
    distinctLine = `credentials distinct: ${distinct ? 'yes' : 'no'}`;
    if (!distinct) problems.push('credenziali daemon e launcher identiche');
  }
  const constructible = present.length === 2 && problems.length === 0;
  const ok = mode !== 'authority' || constructible;
  const out = {
    name: 'Fleet identity authority mode',
    ok,
    detail: `mode=${mode}; credenziali: ${present.length === 2 ? 'entrambe presenti (0600)' : present.join('+') || 'nessuna'} `
      + `(${dir}); ${distinctLine}${problems.length ? '; problemi: ' + problems.join(', ') : ''}`,
  };
  if (mode !== 'authority') {
    out.warn = true;
    out.detail += ' — il launcher espone CODEX_APP_SERVER_IDENTITY_REQUIRED=0: provisiona con '
      + '`nexuscrew identity provision` per attivare l\'authority mode';
  } else if (!constructible) {
    out.detail += ' — authority: configured but unavailable: '
      + (problems.length ? problems.join(', ') : 'credentials not constructible')
      + ' — le celle protette (codex-vl) non partono [IDENTITY_AUTHORITY_UNAVAILABLE]';
  }
  void e;
  return out;
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

// Sezione «engine credentials»: per ogni engine che risolve una credenziale,
// DA DOVE viene. Prima non esisteva alcun controllo di questo tipo: l'unico
// blocco credenziali del doctor era quello dell'identita' (daemon/launcher), e
// la provenienza delle chiavi degli engine non era visibile da nessuna parte —
// una diagnosi sul campo e' arrivata a un confronto manuale di hash.
// Non si stampa MAI un valore: solo la sorgente, il path, l'mtime e l'impronta
// del valore troncata a 8. Un conflitto fra i file di chiavi su un engine che
// una cella USA e' un fallimento; su un engine che nessuna cella usa e' un
// avviso, perche' li' non c'e' ancora nulla che parta con la chiave sbagliata.
function checkEngineCredentials(home, fleetDefsPath, enabled = true) {
  const name = 'engine credentials';
  if (!enabled) return { name, ok: true, warn: true, detail: 'Fleet disabilitata' };
  const target = fleetDefsPath || path.join(home, '.nexuscrew', 'fleet.json');
  const defs = loadDefinitions(target);
  if (!defs) return { name, ok: true, warn: true, detail: 'fleet.json non leggibile: provenienza non verificabile' };
  const { describeManaged, extraModelsFrom } = require('../fleet/managed.js');
  const inUso = new Set((defs.cells || []).map((c) => c && c.engine).filter(Boolean));
  const extraModels = extraModelsFrom(defs);
  const righe = [];
  const conflitti = [];
  for (const engine of defs.engines || []) {
    if (!engine || !engine.managed) continue;
    const info = describeManaged(engine.managed, { home, extraModels, engineId: engine.id });
    const envKey = info.auth;
    if (!envKey || envKey === 'login' || envKey === 'none') continue;
    const dove = info.credentialPath
      ? `${info.credentialSource} (${info.credentialPath}, mtime ${new Date(info.credentialMtime).toISOString()}, sha256 ${info.credentialHash8})`
      : info.credentialSource;
    righe.push(`${engine.id}: ${envKey} from ${dove}`);
    if (info.credentialConflict) conflitti.push({ engine: engine.id, inUso: inUso.has(engine.id), c: info.credentialConflict });
  }
  if (!righe.length) return { name, ok: true, detail: 'nessun engine con credenziale risolta' };
  for (const { engine, c } of conflitti) {
    const altri = c.others
      .map((o) => `${o.path} (mtime ${new Date(o.mtime).toISOString()}, sha256 ${o.hash8})`)
      .join(', ');
    righe.push(`${engine}: ${c.envKey} e' definita anche in ${altri} con un valore DIVERSO (vince ${c.winner.path})`);
  }
  const grave = conflitti.some((k) => k.inUso);
  const detail = righe.join(' · ');
  if (grave) return { name, ok: false, detail };
  if (conflitti.length) return { name, ok: true, warn: true, detail };
  return { name, ok: true, detail };
}

// Read-only check: alternate-screen is applied per managed session, while the
// history limit remains an operator-owned tmux setting. Do not write ~/.tmux.conf
// or change a live server from doctor; only recommend a sufficient value.
function checkAlternateScreenHistory(alternateScreen, execImpl, tmuxBin) {
  if (alternateScreen === true) {
    return { name: 'Fleet alternate-screen history', ok: true, detail: 'alternate-screen standard attivo' };
  }
  let raw = '';
  try {
    raw = String(execImpl(tmuxBin || 'tmux', ['show-options', '-g', 'history-limit'], { encoding: 'utf8' }) || '');
  } catch (_) {
    return {
      name: 'Fleet alternate-screen history', ok: true, warn: true,
      detail: 'history-limit non verificabile; con alternateScreen off configura set -g history-limit 100000 in ~/.tmux.conf',
    };
  }
  const match = raw.match(/(?:^|\n)history-limit\s+(\d+)\b/);
  if (!match) {
    return {
      name: 'Fleet alternate-screen history', ok: true, warn: true,
      detail: 'history-limit non leggibile; con alternateScreen off configura set -g history-limit 100000 in ~/.tmux.conf',
    };
  }
  const limit = Number(match[1]);
  if (limit < 10000) {
    return {
      name: 'Fleet alternate-screen history', ok: true, warn: true,
      detail: `history-limit ${limit} (<10000) con alternateScreen off; configura set -g history-limit 100000 in ~/.tmux.conf`,
    };
  }
  return { name: 'Fleet alternate-screen history', ok: true, detail: `history-limit ${limit}` };
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
  const resolveImpl = opts.resolveCommand || resolveCommand;
  const { tokenPath } = resolvePaths(opts);
  const fleetEnabled = opts.fleetEnabled !== false
    && opts.builtinEnabled !== false
    && process.env.NEXUSCREW_FLEET !== '0';

  const checks = [
    checkNode(),
    checkTmux(existsImpl, opts.tmuxBin, resolveImpl),
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
    checkEngineCredentials(home, opts.fleetDefsPath, fleetEnabled),
    checkAlternateScreenHistory(opts.alternateScreen !== undefined
      ? opts.alternateScreen : loadConfig().alternateScreen, execImpl, opts.tmuxBin),
    checkTermuxExec(opts.env, { platform, home }),
    checkSshClient(existsImpl),
    checkAutossh(existsImpl),
    checkSshPermitlisten(opts.sshVersion),
    checkMcpIdentity(opts.env),
    checkIdentityAuthorityMode({ home: opts.home, env: opts.env }),
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
  checkAlternateScreenHistory,
  checkServiceWorkingDirectory,
  checkFleetServiceWorkingDirectory,
  checkTmuxSurvival, checkUserLinger,
  checkSshClient, checkAutossh, checkSshPermitlisten,
  checkMcpIdentity, checkIdentityAuthorityMode, checkTermuxExec,
  checkTmuxServerCwd, checkTmuxServerTermuxPreload,
  checkEngineCredentials,
};
