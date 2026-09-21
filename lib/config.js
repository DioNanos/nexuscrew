'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function assertLoopback(bind) {
  if (!LOOPBACK.has(bind)) {
    throw new Error(`refusing non-loopback bind "${bind}": nexuscrew is localhost-only`);
  }
  return bind;
}

// Defaults PURI (no env, no config.json). voice null = graceful (non configurato).
// parametri del terminale, in un posto solo. Il merge della config è
// SUPERFICIALE ({...base, ...json, ...env, ...opts}): per una sotto-mappa un
// Object.assign globale azzererebbe le chiavi non nominate, quindi `terminal`
// ha il suo merge per-chiave (resolveTerminal).
const TERMINAL_DEFAULTS = Object.freeze({
  retryBaseMs: 250,
  retryMaxMs: 5000,
  pingMs: 5000,
  deadMs: 10000,
  hubGraceMs: 60000,
  outputRingBytes: 256 * 1024,
  queuedInputBytes: 4096,
  captureLines: 2000,
  overlayDelayMs: 1000,
});

function resolveTerminal(...sources) {
  const out = { ...TERMINAL_DEFAULTS };
  for (const source of sources) {
    const t = source && source.terminal;
    if (t && typeof t === 'object' && !Array.isArray(t)) Object.assign(out, t);
  }
  return out;
}

function baseDefaults() {
  return {
    bind: '127.0.0.1',
    port: 41820,
    // Seconda porta loopback, SOLO per /panel/* (sicurezza 2026-08-16):
    // un pannello vive su un'origin diversa dal control plane — la porta fa
    // parte dell'origin, quindi un iframe cross-porta non legge il
    // localStorage del padre, qualunque JS esegua il container. Nessuna API
    // di controllo e nessun token verificato su questa porta: solo ticket
    // monouso + cookie di visione (lib/proxy/panel-auth.js), che restano
    // esattamente come sono — si spostano, non si riprogettano.
    panelPort: 41821,
    tokenPath: path.join(os.homedir(), '.nexuscrew', 'token'),
    tmuxBin: 'tmux',
    // Shared-server safety is operational hardening, not a same-UID security
    // boundary. Disable only when the operator deliberately owns tmux policy.
    protectSharedTmuxServer: true,
    // Fleet sessions stay on the normal screen by default so their transcript
    // enters tmux history and remains scrollable from the web terminal.
    alternateScreen: false,
    readonlyDefault: false,
    terminal: { ...TERMINAL_DEFAULTS },
    // Etichetta neutra usata nel prefisso delle risposte ask incollate in TUI.
    replyLabel: 'human',
    filesRoot: path.join(os.homedir(), 'NexusFiles'),
    maxUpload: 100 * 1024 * 1024,
    voiceUrl: null,
    voiceToken: '',
    voiceTokenFile: null,
    fleetEnabled: true,
    providerSecretsPath: path.join(os.homedir(), '.nexuscrew', 'providers.env'),
    // Existing user-owned shell exports. NexusCrew parses simple assignments
    // as data; it never executes/sources this file and never copies values.
    providerShellPath: path.join(os.homedir(), '.config', 'ai-shell', 'providers.zsh'),
    // Canonical credential files sourced by providers.zsh. NexusCrew reads
    // only strict KEY=VALUE assignments as data and never executes either file.
    providerKeysPath: path.join(os.homedir(), '.config', 'keys', 'ai.env'),
    providerSecurePath: path.join(os.homedir(), '.config', 'secure', '.env'),
    // Write-only local provider store managed by NexusCrew. It is never part
    // of Fleet backups, federation payloads or API responses.
    credentialsPath: path.join(os.homedir(), '.nexuscrew', 'credentials.json'),
    // Installazioni npm globali controllano periodicamente il dist-tag latest.
    // Il manager aggiorna solo verso una semver superiore: mai downgrade.
    autoUpdate: true,
    sessionPresets: {},
    // Ponte Live (fetta 3, rev5): isolabile — a false il ponte non si
    // connette mai e ogni avvio di Live resta sul comportamento standard.
    liveBridgeEnabled: true,
    // Socket di controllo dell'app-server (misurato 2026-08-15:
    // $CODEX_HOME/app-server-control/app-server-control.sock, WebSocket sopra
    // unix socket). Non cablare mai una porta al posto di questo path.
    liveBridgeSocketPath: path.join(os.homedir(), '.codex', 'app-server-control', 'app-server-control.sock'),
    // Limite dichiarato per OGNI fase del ponte (GET designazione e
    // sessione sul socket). Oltre questo la Live parte senza puntamento.
    liveBridgeTimeoutMs: 1500,
    // PTY grace is finite and configurable for mobile handovers. The caps keep
    // a small host from retaining an unbounded number of disconnected sessions.
    ptyGraceMs: 30000,
    ptyGraceMaxSessions: 8,
    ptyGraceMaxMemoryBytes: 8 * 1024,
    // Un singolo timeout del probe può essere jitter mobile: servono tre
    // fallimenti consecutivi prima di dichiarare il peer irraggiungibile.
    nodeHealthFailureThreshold: 3,
  };
}

function configJsonPath() {
  return process.env.NEXUSCREW_CONFIG_FILE || path.join(os.homedir(), '.nexuscrew', 'config.json');
}

// Legge ~/.nexuscrew/config.json se esiste (nuovo). {} se assente/malformato.
// federation.events.enabled — the node-level kill switch for the event feed.
// STRICT boolean: only the literal false disables. A truthy string or any
// other type never enables anything beyond the default, and never disables by
// accident: "false" (string) is not a decision, it is noise, and the default
// holds. Without explicit grants nothing is enabled either way — the switch
// only stops what grants already allow.
function eventsEnabledFlag(raw, log = console.warn) {
  // Fail-closed strictness: only the literal true/false is a decision. A
  // missing value keeps the default (enabled); ANY other type — "false" as a
  // string, 0, null, an object — is invalid config, is treated as DISABLED and
  // is reported: silently enabling on garbage is how switches lie.
  if (raw === undefined) return true;
  if (raw === true) return true;
  if (raw === false) return false;
  try { log('config: federation.events.enabled must be a boolean; invalid value treated as disabled'); } catch (_) {}
  return false;
}

function readFederationEventsEnabled(opts = {}) {
  if (typeof opts.federationEventsEnabled === 'boolean') return opts.federationEventsEnabled;
  let cfg = {};
  try {
    const raw = fs.readFileSync(opts.configJsonPath || configJsonPath(), 'utf8');
    cfg = JSON.parse(raw) || {};
  } catch (_) { cfg = {}; }
  const fed = cfg && typeof cfg.federation === 'object' && cfg.federation ? cfg.federation : null;
  const events = fed && typeof fed.events === 'object' && fed.events ? fed.events : null;
  return eventsEnabledFlag(events ? events.enabled : undefined);
}

function readConfigJson() {
  try {
    const raw = fs.readFileSync(configJsonPath(), 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (_) { return {}; }
}

// Override da env (precedence più alta di config.json).
function envOverrides() {
  const e = {};
  if (process.env.NEXUSCREW_PORT) e.port = Number(process.env.NEXUSCREW_PORT);
  if (process.env.NEXUSCREW_PANEL_PORT) e.panelPort = Number(process.env.NEXUSCREW_PANEL_PORT);
  if (process.env.NEXUSCREW_TOKEN_FILE) e.tokenPath = process.env.NEXUSCREW_TOKEN_FILE;
  if (process.env.NEXUSCREW_TMUX) e.tmuxBin = process.env.NEXUSCREW_TMUX;
  if (process.env.NEXUSCREW_PROTECT_SHARED_TMUX_SERVER !== undefined) {
    e.protectSharedTmuxServer = !['', '0', 'false', 'no', 'off']
      .includes(String(process.env.NEXUSCREW_PROTECT_SHARED_TMUX_SERVER).toLowerCase());
  }
  if (process.env.NEXUSCREW_ALTERNATE_SCREEN !== undefined) {
    e.alternateScreen = !['', '0', 'false', 'no', 'off']
      .includes(String(process.env.NEXUSCREW_ALTERNATE_SCREEN).toLowerCase());
  }
  if (process.env.NEXUSCREW_READONLY) e.readonlyDefault = process.env.NEXUSCREW_READONLY === '1';
  if (process.env.NEXUSCREW_REPLY_LABEL) e.replyLabel = process.env.NEXUSCREW_REPLY_LABEL;
  if (process.env.NEXUSCREW_FILES_ROOT) e.filesRoot = process.env.NEXUSCREW_FILES_ROOT;
  if (process.env.NEXUSCREW_MAX_UPLOAD_MB) e.maxUpload = Number(process.env.NEXUSCREW_MAX_UPLOAD_MB) * 1024 * 1024;
  if (process.env.NEXUSCREW_VOICE_URL) e.voiceUrl = process.env.NEXUSCREW_VOICE_URL;
  if (process.env.NEXUSCREW_VOICE_TOKEN) e.voiceToken = process.env.NEXUSCREW_VOICE_TOKEN;
  if (process.env.NEXUSCREW_VOICE_TOKEN_FILE) e.voiceTokenFile = process.env.NEXUSCREW_VOICE_TOKEN_FILE;
  if (process.env.NEXUSCREW_FLEET) e.fleetEnabled = process.env.NEXUSCREW_FLEET !== '0';
  if (process.env.NEXUSCREW_PROVIDER_SECRETS) e.providerSecretsPath = process.env.NEXUSCREW_PROVIDER_SECRETS;
  if (process.env.NEXUSCREW_PROVIDER_SHELL) e.providerShellPath = process.env.NEXUSCREW_PROVIDER_SHELL;
  if (process.env.NEXUSCREW_PROVIDER_KEYS) e.providerKeysPath = process.env.NEXUSCREW_PROVIDER_KEYS;
  if (process.env.NEXUSCREW_PROVIDER_SECURE) e.providerSecurePath = process.env.NEXUSCREW_PROVIDER_SECURE;
  if (process.env.NEXUSCREW_CREDENTIALS_FILE) e.credentialsPath = process.env.NEXUSCREW_CREDENTIALS_FILE;
  if (process.env.NEXUSCREW_AUTO_UPDATE !== undefined) {
    e.autoUpdate = !['', '0', 'false', 'no', 'off'].includes(String(process.env.NEXUSCREW_AUTO_UPDATE).toLowerCase());
  }
  if (process.env.NEXUSCREW_LIVE_BRIDGE !== undefined) {
    e.liveBridgeEnabled = !['', '0', 'false', 'no', 'off'].includes(String(process.env.NEXUSCREW_LIVE_BRIDGE).toLowerCase());
  }
  if (process.env.NEXUSCREW_LIVE_BRIDGE_SOCKET) e.liveBridgeSocketPath = process.env.NEXUSCREW_LIVE_BRIDGE_SOCKET;
  if (process.env.NEXUSCREW_LIVE_BRIDGE_TIMEOUT_MS) e.liveBridgeTimeoutMs = Number(process.env.NEXUSCREW_LIVE_BRIDGE_TIMEOUT_MS);
  if (process.env.NEXUSCREW_PTY_GRACE_MS) e.ptyGraceMs = Number(process.env.NEXUSCREW_PTY_GRACE_MS);
  if (process.env.NEXUSCREW_PTY_GRACE_MAX_SESSIONS) e.ptyGraceMaxSessions = Number(process.env.NEXUSCREW_PTY_GRACE_MAX_SESSIONS);
  if (process.env.NEXUSCREW_PTY_GRACE_MAX_MEMORY_BYTES) e.ptyGraceMaxMemoryBytes = Number(process.env.NEXUSCREW_PTY_GRACE_MAX_MEMORY_BYTES);
  if (process.env.NEXUSCREW_NODE_HEALTH_FAILURE_THRESHOLD) e.nodeHealthFailureThreshold = Number(process.env.NEXUSCREW_NODE_HEALTH_FAILURE_THRESHOLD);
  return e;
}

// Precedence: baseDefaults < config.json < env < opts.
// Le credenziali authority vivono in due file 0600 nella dir
// dell'authority (default ~/.nexuscrew/identity-authority). Se esistono vengono
// caricate qui, senza MAI loggare i valori: builtin costruisce l'authority
// solo quando ENTRAMBE sono presenti e distinte.
function readIdentityAuthorityCredentials(cfg = {}) {
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const dir = cfg.identityAuthorityDir
    || path.join(cfg.home || os.homedir(), '.nexuscrew', 'identity-authority');
  // Enforced AT LOAD. Identical credentials or wrong permissions
  // (files != 0600, dir != 0700) => the credentials are NOT loaded: the
  // authority is not constructed and the protected launch is refused instead.
  // The reason travels in identityAuthorityFault, and never carries a value.
  const faults = [];
  let dirMode = null;
  try { dirMode = fs.lstatSync(dir).mode & 0o777; } catch (_) { faults.push('authority dir missing'); }
  if (dirMode !== null && dirMode !== 0o700) faults.push('authority dir mode is not 0700');
  const readOne = (name) => {
    try {
      const st = fs.lstatSync(path.join(dir, name));
      if (!st.isFile()) { faults.push(`${name}: not a regular file`); return undefined; }
      if ((st.mode & 0o777) !== 0o600) { faults.push(`${name}: mode is not 0600`); return undefined; }
      const value = fs.readFileSync(path.join(dir, name), 'utf8').trim();
      if (!value) { faults.push(`${name}: empty`); return undefined; }
      return value;
    } catch (_) { faults.push(`${name}: missing`); return undefined; }
  };
  const daemon = readOne('daemon.credential');
  const launcher = readOne('launcher.credential');
  if (daemon && launcher) {
    let distinct;
    try {
      distinct = !crypto.timingSafeEqual(Buffer.from(daemon), Buffer.from(launcher));
    } catch (_) { distinct = false; }
    if (!distinct) faults.push('daemon and launcher credentials are identical');
  }
  const out = {};
  if (faults.length) {
    out.identityAuthorityFault = faults.join('; ');
    return out;
  }
  if (daemon) out.identityDaemonCredential = daemon;
  if (launcher) out.identityLauncherCredential = launcher;
  return out;
}

function loadConfig(opts = {}) {
  const base = baseDefaults();
  const json = readConfigJson();
  const env = envOverrides();
  const merged = { ...base, ...json, ...env, ...opts };
  // terminal e' una sotto-mappa: merge per-chiave, o una sola chiave in
  // config.json cancellerebbe tutte le altre.
  const terminal = resolveTerminal(base, json, env, opts);
  // I file di credenziale sono fallback: non sovrascrivono mai valori espliciti
  // di config.json/env/opts (precedence invariata).
  const creds = readIdentityAuthorityCredentials(merged);
  return { ...merged, terminal, ...creds };
}

// Retrocompat: defaults() = baseDefaults + env (NO config.json — per test isolati
// che non devono leggere ~/.nexuscrew/config.json del device). server.js usa loadConfig().
function defaults() {
  const base = baseDefaults();
  const env = envOverrides();
  return { ...base, ...env, terminal: resolveTerminal(base, env) };
}

module.exports = { assertLoopback, baseDefaults, readConfigJson, loadConfig, defaults, LOOPBACK, configJsonPath, eventsEnabledFlag, readFederationEventsEnabled, TERMINAL_DEFAULTS, resolveTerminal };
