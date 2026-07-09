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
    readonlyDefault: false,
    filesRoot: path.join(os.homedir(), 'NexusFiles'),
    maxUpload: 100 * 1024 * 1024,
    voiceUrl: null,
    voiceToken: '',
    voiceTokenFile: null,
    fleetEnabled: true,
    fleetBin: path.join(os.homedir(), '.local', 'bin', 'fleet'),
    sessionPresets: {},
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
  if (process.env.NEXUSCREW_READONLY) e.readonlyDefault = process.env.NEXUSCREW_READONLY === '1';
  if (process.env.NEXUSCREW_FILES_ROOT) e.filesRoot = process.env.NEXUSCREW_FILES_ROOT;
  if (process.env.NEXUSCREW_MAX_UPLOAD_MB) e.maxUpload = Number(process.env.NEXUSCREW_MAX_UPLOAD_MB) * 1024 * 1024;
  if (process.env.NEXUSCREW_VOICE_URL) e.voiceUrl = process.env.NEXUSCREW_VOICE_URL;
  if (process.env.NEXUSCREW_VOICE_TOKEN) e.voiceToken = process.env.NEXUSCREW_VOICE_TOKEN;
  if (process.env.NEXUSCREW_VOICE_TOKEN_FILE) e.voiceTokenFile = process.env.NEXUSCREW_VOICE_TOKEN_FILE;
  if (process.env.NEXUSCREW_FLEET) e.fleetEnabled = process.env.NEXUSCREW_FLEET !== '0';
  if (process.env.NEXUSCREW_FLEET_BIN) e.fleetBin = process.env.NEXUSCREW_FLEET_BIN;
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
