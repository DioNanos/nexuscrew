'use strict';
// Platform detection per NexusCrew portatile.
// Regole (in ordine): TERMUX_VERSION -> termux; PREFIX com.termux -> termux;
// process.platform === 'android' -> termux; 'darwin' -> mac; 'linux' -> linux.
// Allineato a lib/pty/provider.js (che gia tratta android come Termux).

const path = require('node:path');

function detectPlatform(ctx = {}) {
  const env = ctx.env || process.env;
  const platform = ctx.platform || process.platform;
  if (env.TERMUX_VERSION) return 'termux';
  if ((env.PREFIX || '').includes('com.termux')) return 'termux';
  if (platform === 'android') return 'termux';
  if (platform === 'darwin') return 'mac';
  if (platform === 'linux') return 'linux';
  return 'linux'; // fallback sicuro (loopback + tmux disponibili)
}

function nodeBin() {
  // Mai hardcoded nvm: il node che sta girando.
  return process.execPath;
}

function repoRoot() {
  // lib/cli/platform.js -> ../.. = repo root.
  return path.resolve(__dirname, '..', '..');
}

function uid() {
  // Per launchd gui/<uid>. Fallback 501 (mac default) se getuid non disponibile.
  try { return process.getuid(); } catch (_) { return 501; }
}

module.exports = { detectPlatform, nodeBin, repoRoot, uid };
