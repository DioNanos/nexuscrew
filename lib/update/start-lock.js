'use strict';
// Lock di avvio condiviso: serializza chi EMETTE un avvio/riavvio del nodo (boot via start, `show`, `start`,
// `restart`, runner dell'update). Due avviatori simultanei creavano un nodo che ne uccideva un altro appena partito.
//
// Contro il deadlock:
//  - sezione critica breve: si tiene solo mentre si EMETTE il comando (spawn/systemctl/launchctl), mai mentre si
//    attende la salute del nodo, quindi il processo appena avviato non ha nulla da attendere;
//  - rientrante nello STESSO processo (smartUp -> restart -> startPortable non si blocca da solo);
//  - proprietario VERIFICATO: pid vivo e, se noto, stessa nascita del processo (pid riassegnato = lock orfano);
//  - SCADENZA: oltre ttlMs il lock si considera stantio anche con il proprietario vivo, e si riprende;
//  - attesa limitata: allo scadere errore chiaro `start-lock-timeout` (con chi lo tiene), mai attesa infinita;
//  - si rilascia/toglie solo un lock col PROPRIO token.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 60 * 1000;
const DEFAULT_WAIT_MS = 20 * 1000;
const POLL_MS = 100;
const held = new Map(); // file -> { depth, token }

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* best effort */ } };

function lockPath(home) { return path.join(home || os.homedir(), '.nexuscrew', 'start.lock'); }

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function processStartOf(pid, impl) {
  try { return (impl || require('../cli/pidfile.js').readProcessStart)(pid) || ''; } catch (_) { return ''; }
}

function readLock(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return { corrupt: true };
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && Number.isInteger(v.pid) && typeof v.token === 'string' ? v : { corrupt: true };
  } catch (e) { return e.code === 'ENOENT' ? null : { corrupt: true }; }
}

function isStale(meta, now, ttlMs, impl = {}) {
  if (!meta || meta.corrupt) return true;
  if (!pidAlive(meta.pid)) return true;
  if (meta.processStart) {
    const live = processStartOf(meta.pid, impl.readProcessStartImpl);
    if (live && live !== meta.processStart) return true; // pid riassegnato a un altro processo
  }
  return now - Number(meta.createdAt || 0) > ttlMs;
}

function unlinkIfToken(file, token) {
  const cur = readLock(file);
  if (cur && !cur.corrupt && cur.token !== token) return false;
  try { fs.unlinkSync(file); return true; } catch (e) { return e.code === 'ENOENT'; }
}

// Ritorna un handle {release()}. Sincrono: chi lo chiama (spawn, execFileSync) lo e' gia'.
function acquireStartLock({ home, ttlMs = DEFAULT_TTL_MS, waitMs = DEFAULT_WAIT_MS, label = '', impl = {} } = {}) {
  const file = lockPath(home);
  const mine = held.get(file);
  if (mine) { mine.depth += 1; return { release: () => releaseHeld(file) }; }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = crypto.randomBytes(12).toString('hex');
    try {
      fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now(), label, processStart: processStartOf(process.pid, impl.readProcessStartImpl) })}\n`, { flag: 'wx', mode: 0o600 });
      held.set(file, { depth: 1, token });
      return { release: () => releaseHeld(file) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const meta = readLock(file);
    if (isStale(meta, Date.now(), ttlMs, impl)) {
      // ripresa: solo se il file e' ancora quello che abbiamo giudicato stantio
      const again = readLock(file);
      if (!again || again.corrupt || again.token === (meta && meta.token)) { unlinkIfToken(file, meta && !meta.corrupt ? meta.token : undefined); continue; }
    }
    if (Date.now() >= deadline) {
      const error = new Error(`avvio gia' in corso (${meta && meta.label ? meta.label : 'altro avviatore'}, pid ${meta && meta.pid}): riprova fra poco`);
      error.code = 'start-lock-timeout'; error.holder = meta && !meta.corrupt ? { pid: meta.pid, label: meta.label || '', ageMs: Date.now() - Number(meta.createdAt || 0) } : null;
      throw error;
    }
    sleepSync(POLL_MS);
  }
}

function releaseHeld(file) {
  const mine = held.get(file);
  if (!mine) return;
  mine.depth -= 1;
  if (mine.depth > 0) return;
  held.delete(file);
  unlinkIfToken(file, mine.token);
}

function withStartLock(fn, opts = {}) {
  const handle = acquireStartLock(opts);
  try { return fn(); } finally { handle.release(); }
}

module.exports = { DEFAULT_TTL_MS, DEFAULT_WAIT_MS, lockPath, acquireStartLock, withStartLock, isStale, readLock };
