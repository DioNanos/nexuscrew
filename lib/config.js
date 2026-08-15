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
function baseDefaults() {
  return {
    bind: '127.0.0.1',
    port: 41820,
    tokenPath: path.join(os.homedir(), '.nexuscrew', 'token'),
    tmuxBin: 'tmux',
    // Shared-server safety is operational hardening, not a same-UID security
    // boundary. Disable only when the operator deliberately owns tmux policy.
    protectSharedTmuxServer: true,
    // Fleet sessions stay on the normal screen by default so their transcript
    // enters tmux history and remains scrollable from the web terminal.
    alternateScreen: false,
    readonlyDefault: false,
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
    // Ponte Live (fetta 3, rev5 MC0): isolabile — a false il ponte non si
    // connette mai e ogni avvio di Live resta sul comportamento standard.
    liveBridgeEnabled: true,
    // Socket di controllo dell'app-server (misurato 2026-08-15:
    // $CODEX_HOME/app-server-control/app-server-control.sock, WebSocket sopra
    // unix socket). Non cablare mai una porta al posto di questo path.
    liveBridgeSocketPath: path.join(os.homedir(), '.codex', 'app-server-control', 'app-server-control.sock'),
    // MC1.5: limite dichiarato per OGNI fase del ponte (GET designazione e
    // sessione sul socket). Oltre questo la Live parte senza puntamento.
    liveBridgeTimeoutMs: 1500,
  };
}

function configJsonPath() {
  return process.env.NEXUSCREW_CONFIG_FILE || path.join(os.homedir(), '.nexuscrew', 'config.json');
}

// Legge ~/.nexuscrew/config.json se esiste (nuovo, B2). {} se assente/malformato.
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
  return e;
}

// Precedence: baseDefaults < config.json < env < opts. [B2]
function loadConfig(opts = {}) {
  return { ...baseDefaults(), ...readConfigJson(), ...envOverrides(), ...opts };
}

// Retrocompat: defaults() = baseDefaults + env (NO config.json — per test isolati
// che non devono leggere ~/.nexuscrew/config.json del device). server.js usa loadConfig().
function defaults() {
  return { ...baseDefaults(), ...envOverrides() };
}

module.exports = { assertLoopback, baseDefaults, readConfigJson, loadConfig, defaults, LOOPBACK, configJsonPath };
