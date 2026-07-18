'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Preset allowlistati (audit F1): il client sceglie un NOME, mai un comando.
// Estendibili da config.json `sessionPresets` (name -> array argv di stringhe).
const PRESETS = { shell: null, claude: ['claude'], 'codex-vl': ['codex-vl'], pi: ['pi'] };

const NAME_RE = /^[\w.-]{1,64}$/;
function validSessionName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !name.startsWith('-');
}

// cwd reale sotto la home reale (audit F1): realpath su ENTRAMBI, così un
// symlink dentro home che punta fuori viene rifiutato.
function resolveCwd(cwd, home) {
  try {
    const real = fs.realpathSync(cwd);
    const realHome = fs.realpathSync(home);
    if (!fs.statSync(real).isDirectory()) return null;
    if (real !== realHome && !real.startsWith(realHome + path.sep)) return null;
    return real;
  } catch (_) { return null; }
}

// Denylist kill INDIPENDENTE dal registry (audit F2): qualunque cloud-* è
// protetta anche con fleet assente/rotto; in più le tmuxSession del registry.
function isProtectedSession(name, isCellSession) {
  if (/^cloud-/i.test(String(name))) return true;
  try { return !!isCellSession(name); } catch (_) { return false; }
}

function presetArgv(preset, extra) {
  const table = { ...PRESETS };
  for (const [k, v] of Object.entries(extra || {})) {
    if (NAME_RE.test(k) && Array.isArray(v) && v.every((s) => typeof s === 'string')) table[k] = v;
  }
  if (!Object.prototype.hasOwnProperty.call(table, preset)) return undefined;
  return table[preset];
}

// Pure: argomenti tmux per la create, o null se input invalido.
function buildCreateArgs(name, realCwd, preset, extraPresets) {
  if (!validSessionName(name) || typeof realCwd !== 'string' || !realCwd) return null;
  const argv = presetArgv(String(preset || 'shell'), extraPresets);
  if (argv === undefined) return null;
  const base = ['new-session', '-d', '-s', name, '-c', realCwd];
  return argv ? [...base, ...argv] : base;
}

function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }

async function createSession(tmuxBin, { name, cwd, preset }, { home, presets, ensureProtection } = {}) {
  if (typeof ensureProtection === 'function') await ensureProtection();
  return new Promise((resolve, reject) => {
    if (!validSessionName(name)) return reject(httpError(400, 'nome sessione non valido'));
    // Il namespace cloud-* e' delle celle fleet (audit finale #1): una generica
    // con quel prefisso occuperebbe il binding per-nome e sarebbe poi 409 al kill.
    if (/^cloud-/i.test(name)) return reject(httpError(409, 'namespace riservato alle celle (cloud-*): usa fleet up'));
    const real = resolveCwd(String(cwd || home), home);
    if (!real) return reject(httpError(400, 'cwd non valida (deve esistere sotto la home)'));
    const args = buildCreateArgs(name, real, preset, presets);
    if (!args) return reject(httpError(400, 'preset non in allowlist'));
    execFile(tmuxBin, args, (err, _o, stderr) => {
      if (err) {
        if (/duplicate session/i.test(stderr || '')) return reject(httpError(409, 'sessione già esistente'));
        return reject(httpError(500, `tmux new-session failed: ${String(stderr || err.message).trim()}`));
      }
      resolve();
    });
  });
}

async function killSession(tmuxBin, name, { ensureProtection } = {}) {
  if (typeof ensureProtection === 'function') await ensureProtection();
  return new Promise((resolve, reject) => {
    execFile(tmuxBin, ['kill-session', '-t', `=${name}`], (err, _o, stderr) => {
      if (err) {
        if (/can't find session|no server running/i.test(stderr || '')) return resolve(false);
        return reject(httpError(500, `tmux kill-session failed: ${String(stderr || err.message).trim()}`));
      }
      resolve(true);
    });
  });
}

module.exports = { PRESETS, validSessionName, resolveCwd, isProtectedSession, buildCreateArgs, createSession, killSession };
