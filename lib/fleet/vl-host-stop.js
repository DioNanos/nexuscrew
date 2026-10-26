'use strict';
// Stop dell'host VL. Il binario eseguito è la copia pinnata,
// la root è quella del record scritto all'up. Il timeout uccide solo il
// CLI di controllo, mai l'host. rc 0 non basta: serve state=none.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BUDGET_MS = 15000;
const PROBE_MS = 5000;

function sha256File(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function slugCoppia(owner, cellId) {
  if (typeof owner !== 'string' || typeof cellId !== 'string') return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(owner) || !/^[A-Za-z0-9_-]{1,64}$/.test(cellId)) return null;
  return `${owner}-${cellId}`;
}

function dirContesto(stateDir) {
  return path.join(stateDir, 'host-context.json');
}

function scriviContesto(stateDir, dato) {
  const file = dirContesto(stateDir);
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(dato));
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  return file;
}

function leggiContesto(stateDir) {
  let buf;
  try { buf = fs.readFileSync(dirContesto(stateDir)); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return { errore: 'illeggibile' };
  }
  let o;
  try { o = JSON.parse(buf.toString('utf8')); } catch (_) { return { errore: 'corrotto' }; }
  if (!o || typeof o !== 'object') return { errore: 'corrotto' };
  const chiavi = ['launchId', 'vlBin', 'vlBinSha256', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'HOME', 'uid', 'serverRoot', 'ts'];
  if (Object.keys(o).some((k) => !chiavi.includes(k))) return { errore: 'corrotto' };
  if (!/^[a-f0-9]{16}$/.test(o.launchId || '')) return { errore: 'corrotto' };
  if (typeof o.vlBinSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(o.vlBinSha256)) return { errore: 'corrotto' };
  for (const k of ['vlBin', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'HOME', 'serverRoot']) {
    if (typeof o[k] !== 'string' || !o[k] || o[k].includes('\0')) return { errore: 'corrotto' };
  }
  if (!Number.isSafeInteger(o.uid) || o.uid < 0) return { errore: 'corrotto' };
  return o;
}

function dirPin(home, owner, cellId, sha) {
  const coppia = slugCoppia(owner, cellId);
  if (!coppia) return null;
  return path.join(home, '.nexuscrew', 'vl-control-pin', coppia, sha);
}

function pinBinario({ source, home, owner, cellId, log }) {
  let hash;
  try { hash = sha256File(source); } catch (_) { return { ok: false, code: 'ASSENTE' }; }
  const dir = dirPin(home, owner, cellId, hash);
  if (!dir) return { ok: false, code: 'NOME' };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const finale = path.join(dir, 'vl');
  if (fs.existsSync(finale)) {
    let ora = '';
    try { ora = sha256File(finale); } catch (_) { ora = ''; }
    if (ora === hash) return { ok: true, path: finale, sha256: hash };
    const quarantena = `${finale}.corrupt-${Date.now()}`;
    try { fs.renameSync(finale, quarantena); } catch (_) { return { ok: false, code: 'QUARANTINE' }; }
    if (typeof log === 'function') log('pin-cache-corrupt');
  }
  const tmp = `${finale}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  const buf = fs.readFileSync(source);
  if (crypto.createHash('sha256').update(buf).digest('hex') !== hash) return { ok: false, code: 'HASH' };
  const fd = fs.openSync(tmp, 'wx', 0o500);
  try {
    fs.writeFileSync(fd, buf);
    fs.fchmodSync(fd, 0o500);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const diNuovo = sha256File(tmp);
  if (diNuovo !== hash) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, code: 'REREAD' };
  }
  if (fs.existsSync(finale)) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, code: 'EXISTS' };
  }
  fs.renameSync(tmp, finale);
  const altri = path.dirname(dir);
  for (const nome of fs.readdirSync(altri)) {
    if (nome === hash) continue;
    fs.rmSync(path.join(altri, nome), { recursive: true, force: true });
  }
  return { ok: true, path: finale, sha256: hash };
}

function verificaPin(pinPath, sha) {
  try {
    if (sha256File(pinPath) !== sha) return { ok: false };
    return { ok: true, path: pinPath };
  } catch (_) {
    return { ok: false };
  }
}

function envDalRecord(record) {
  return {
    HOME: record.HOME,
    XDG_STATE_HOME: record.XDG_STATE_HOME,
    XDG_DATA_HOME: record.XDG_DATA_HOME,
    XDG_CONFIG_HOME: record.XDG_CONFIG_HOME,
    PATH: '/usr/bin:/bin',
  };
}

function lancia(bin, args, env, timeoutMs, spawnImpl) {
  const lanciaProc = spawnImpl || spawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = lanciaProc(bin, args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', errore: e, ucciso: false });
      return;
    }
    const out = [];
    let n = 0;
    child.stdout.on('data', (b) => { n += b.length; if (n < 65536) out.push(b); });
    child.stderr.on('data', () => {});
    let ucciso = false;
    const killer = setTimeout(() => {
      ucciso = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);
    child.once('error', () => {});
    child.once('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), ucciso, child });
    });
  });
}

function leggiStato(stdout) {
  const riga = String(stdout || '').split('\n').find((r) => r.trim().startsWith('{'));
  if (!riga) return null;
  try {
    const o = JSON.parse(riga);
    if (!o || typeof o.state !== 'string') return null;
    if (o.state !== 'none' && o.state !== 'live' && o.state !== 'lock') return null;
    return o;
  } catch (_) { return null; }
}

function sondaConclusa(r) {
  return !!r && r.code === 0 && r.ucciso !== true && !r.errore;
}

async function fermaHost({ record, bin, budgetMs, monoNow, spawnImpl, nelGruppo }) {
  const inizio = monoNow();
  const limite = inizio + Math.min(budgetMs || BUDGET_MS, BUDGET_MS);
  const resta = () => limite - monoNow();
  if (nelGruppo === true) {
    return { outcome: 'host-stop-failed', code: 'HOST_IN_GROUP', spawned: 0 };
  }
  const env = envDalRecord(record);
  const root = record.serverRoot;
  let spawned = 0;
  const stato = async () => {
    const ms = Math.min(PROBE_MS, Math.max(1, resta()));
    spawned += 1;
    const r = await lancia(bin, ['host', 'status', '--json', '--server-root', root], env, ms, spawnImpl);
    return { r, stato: leggiStato(r.stdout) };
  };
  if (resta() < 50) return { outcome: 'host-stop-failed', code: 'BUDGET', spawned };
  const primo = await stato();
  if (sondaConclusa(primo.r) && primo.stato && primo.stato.state === 'none') {
    return { outcome: 'host-already-stopped', spawned };
  }
  if (resta() < 50) return { outcome: 'host-stop-failed', code: 'BUDGET', spawned };
  const fermo = Math.min(resta() - 200, PROBE_MS);
  if (fermo < 50) return { outcome: 'host-stop-failed', code: 'BUDGET', spawned };
  spawned += 1;
  const shut = await lancia(bin, ['shutdown', '--server-root', root], env, fermo, spawnImpl);
  if (shut.ucciso) return { outcome: 'host-stop-failed', code: 'TIMEOUT', spawned };
  if (resta() < 50) return { outcome: 'host-stop-failed', code: 'BUDGET', spawned };
  const secondo = await stato();
  if (sondaConclusa(secondo.r) && secondo.stato && secondo.stato.state === 'none') {
    return { outcome: 'host-stopped-clean', spawned };
  }
  return { outcome: 'host-stop-failed', code: 'BARRIER', spawned };
}

module.exports = {
  scriviContesto, leggiContesto, pinBinario, verificaPin, fermaHost, sha256File, dirPin, envDalRecord,
};
