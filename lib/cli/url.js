'use strict';
// URL/token helpers per la CLI unificata (design §3). [A2]
// - resolvePaths: config/token path home-aware (seam per test con HOME temporanea).
// - readToken: legge il token esistente SENZA crearlo (no-follow symlink), null se assente.
// - loadPort: porta corrente (opts > env > config.json > default 41820).
// - buildUrl: URL loopback; withToken aggiunge #token=… (UNICO posto dove il token appare).
// - renderQr: QR ASCII generato in locale (qrcode-terminal, MIT) — NIENTE fetch a runtime.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readTokenSafe } = require('../auth/token.js');

const DEFAULT_PORT = 41820;

function resolvePaths(opts = {}) {
  const home = opts.home || os.homedir();
  const configDir = opts.configDir || path.join(home, '.nexuscrew');
  return {
    home,
    configDir,
    configPath: opts.configPath || path.join(configDir, 'config.json'),
    tokenPath: opts.tokenPath || path.join(configDir, 'token'),
  };
}

// Legge il token esistente (no create). Symlink -> throw (readTokenSafe); assente -> null.
function readToken(tokenPath) {
  try {
    return readTokenSafe(tokenPath);
  } catch (e) {
    if (e.code === 'ENOENT') return null; // lstat su path inesistente
    throw e; // symlink / permessi -> propaga
  }
}

// Porta corrente: opts.port > env NEXUSCREW_PORT > config.json > default.
function loadPort(opts = {}) {
  if (opts.port) return Number(opts.port);
  if (process.env.NEXUSCREW_PORT) return Number(process.env.NEXUSCREW_PORT);
  const { configPath } = resolvePaths(opts);
  try {
    const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (c && c.port) return Number(c.port);
  } catch (_) {}
  return DEFAULT_PORT;
}

// URL loopback. withToken=true e token presente -> aggiunge #token=… (mai altrove).
function buildUrl(port, token, { withToken = false } = {}) {
  const base = `http://127.0.0.1:${port}/`;
  return withToken && token ? `${base}#token=${token}` : base;
}

// QR ASCII del testo. Generazione locale (qrcode-terminal), callback sincrona.
// small=true -> QR compatto (half-block chars) leggibile su terminale mobile/Termux.
function renderQr(text, opts = {}) {
  const qrcode = opts.qrcode || require('qrcode-terminal');
  let out = '';
  qrcode.generate(String(text), { small: opts.small !== false }, (s) => { out = s; });
  return out;
}

module.exports = { resolvePaths, readToken, loadPort, buildUrl, renderQr, DEFAULT_PORT };
