'use strict';
// npm dell'aggiornamento: lo STESSO node che esegue il demone, con la prova che installerebbe dove il codice vive.
//
// Il difetto che questo modulo chiude: `npm` chiamato nudo dal PATH del processo. Con piu' node sulla macchina
// (proot vs Termux, Homebrew vs sistema, nvm) quello che risponde a `npm` puo' appartenere a un altro node/prefix:
// `npm install --global` esce 0 ma scrive in un ALTRO albero, e il processo riavviato ricarica codice vecchio.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PACKAGE_NAME } = require('./core.js');

// Redazione per il log: mai home, mai segreti. Le stringhe lunghe alfanumeriche (token, chiavi) diventano ***.
function redact(text, home = os.homedir()) {
  let out = String(text == null ? '' : text);
  if (home && home.length > 1) out = out.split(home).join('~');
  return out.replace(/[A-Za-z0-9_-]{32,}/g, '***').slice(0, 600);
}

function describeEnv({ execPath = process.execPath, envPath = process.env.PATH || '', home = os.homedir(), nodeVersion = process.version } = {}) {
  const entries = String(envPath).split(path.delimiter).filter(Boolean).slice(0, 25).map((e) => redact(e, home).slice(0, 120));
  return `node=${redact(execPath, home)} v=${nodeVersion} PATH=${entries.join(':')}`;
}

// npm-cli.js accanto al node: bin/node -> ../lib/node_modules/npm (Linux/macOS/Termux/Homebrew/nvm),
// oppure node_modules/npm accanto al binario (Windows e alcuni tarball).
function findNpmCli(execPath, { exists = fs.existsSync, realpath = fs.realpathSync } = {}) {
  const dirs = [path.dirname(execPath)];
  try { const real = path.dirname(realpath(execPath)); if (!dirs.includes(real)) dirs.push(real); } catch (_) { /* binario non risolvibile */ }
  for (const dir of dirs) {
    for (const rel of [['..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'], ['node_modules', 'npm', 'bin', 'npm-cli.js']]) {
      const candidate = path.join(dir, ...rel);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

// Mini-verifica di un range `engines.node` (clausole con `||`, congiunzioni con spazio; >=, >, <=, <, =, ^, ~).
// Un range che non si sa leggere non blocca: e' un controllo di sicurezza, non un veto.
function parseV(v) { const m = /^v?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?/.exec(String(v).trim()); return m ? [Number(m[1]), m[2] === undefined || m[2] === 'x' ? null : Number(m[2]), m[3] === undefined || m[3] === 'x' ? null : Number(m[3])] : null; }
function cmp(a, b) { for (let i = 0; i < 3; i += 1) { const x = a[i] || 0; const y = (b[i] === null || b[i] === undefined) ? 0 : b[i]; if (x !== y) return x > y ? 1 : -1; } return 0; }
function comparatorOk(version, token) {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(v?[\d.x]+)$/.exec(token);
  if (!m) return null;
  const op = m[1] || '='; const t = parseV(m[2]); if (!t) return null;
  const c = cmp(version, t);
  if (op === '>=') return c >= 0; if (op === '>') return c > 0; if (op === '<=') return c <= 0; if (op === '<') return c < 0;
  if (op === '=') return t.every((n, i) => n === null || n === version[i]);
  if (op === '^') { if (c < 0) return false; if (t[0] > 0) return version[0] === t[0]; if ((t[1] || 0) > 0) return version[0] === 0 && version[1] === t[1]; return version[0] === 0 && version[1] === 0 && version[2] === (t[2] || 0); }
  if (op === '~') return c >= 0 && version[0] === t[0] && (t[1] === null || version[1] === t[1]);
  return null;
}
function nodeRangeOk(nodeVersion, range) {
  const v = parseV(nodeVersion); if (!v || !range) return true;
  let unknown = false;
  for (const clause of String(range).split('||')) {
    const tokens = clause.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const results = tokens.map((tk) => comparatorOk(v, tk));
    if (results.some((r) => r === null)) { unknown = true; continue; }
    if (results.every(Boolean)) return true;
  }
  return unknown; // se nessuna clausola e' soddisfatta ma qualcuna non era leggibile, non si blocca
}

// Come lanciare npm: { bin, argvPrefix, env, kind, npmCli }.
function resolveNpmInvocation({ execPath = process.execPath, exists, realpath, env = process.env } = {}) {
  const npmCli = findNpmCli(execPath, { exists, realpath });
  const withNodeFirst = { ...env, PATH: `${path.dirname(execPath)}${path.delimiter}${env.PATH || ''}` };
  if (npmCli) return { kind: 'node-npm-cli', bin: execPath, argvPrefix: [npmCli], env: withNodeFirst, npmCli };
  // npm non trovato accanto al node: si ripiega su `npm` del PATH, ma SOLO se la preflight prova dove scrive.
  return { kind: 'path-npm', bin: 'npm', argvPrefix: [], env: withNodeFirst, npmCli: null };
}

function realpathSafe(p, realpath = fs.realpathSync) { try { return realpath(p); } catch (_) { return path.resolve(p); } }

// Prova, PRIMA di toccare qualcosa, che l'install globale andrebbe dove il processo in esecuzione vive.
function npmPreflight({
  invocation, packageRoot = path.resolve(__dirname, '..', '..'), home = os.homedir(), nodeVersion = process.version,
  execImpl = execFileSync, realpath = fs.realpathSync, readFile = fs.readFileSync,
} = {}) {
  if (invocation.npmCli) {
    let engines = '';
    try { engines = JSON.parse(readFile(path.join(path.dirname(path.dirname(invocation.npmCli)), 'package.json'), 'utf8')).engines?.node || ''; } catch (_) { /* nessun engines leggibile */ }
    if (engines && !nodeRangeOk(nodeVersion, engines)) {
      throw new Error(`npm richiede node ${engines} ma il demone esegue node ${nodeVersion}: aggiornamento annullato prima di installare`);
    }
  }
  let globalRoot = '';
  try {
    globalRoot = String(execImpl(invocation.bin, [...invocation.argvPrefix, 'root', '-g'], { encoding: 'utf8', timeout: 20_000, env: invocation.env, stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim();
  } catch (e) { throw new Error(`npm root -g non riuscito (${redact(e && e.message, home).slice(0, 160)}): aggiornamento annullato prima di installare`); }
  if (!globalRoot) throw new Error('npm root -g vuoto: aggiornamento annullato prima di installare');
  const target = realpathSafe(path.join(globalRoot, PACKAGE_NAME), realpath);
  const running = realpathSafe(packageRoot, realpath);
  if (target !== running) {
    throw new Error(`npm -g installerebbe in ${redact(target, home)} ma il processo esegue ${redact(running, home)} (installazione portatile, locale o node diverso): aggiornamento annullato prima di installare`);
  }
  return { globalRoot, packageRoot: running };
}

// Versione del pacchetto nel percorso ESEGUITO (realpath), con il percorso per il messaggio d'errore.
function readInstalledFrom(root, { realpath = fs.realpathSync, readFile = fs.readFileSync } = {}) {
  const real = realpathSafe(root, realpath);
  return { path: real, version: JSON.parse(readFile(path.join(real, 'package.json'), 'utf8')).version };
}

module.exports = { redact, describeEnv, findNpmCli, nodeRangeOk, resolveNpmInvocation, npmPreflight, readInstalledFrom };
