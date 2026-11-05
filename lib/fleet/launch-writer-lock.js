'use strict';
// lib/fleet/launch-writer-lock.js — UN SOLO writer del runtime per filesRoot.
//
// Il confronto del record per sha256 al commit della riconciliazione non e'
// una compare-and-swap atomica: fra la rilettura e l'unlink un altro scrittore
// potrebbe riscrivere il record. Il vincolo che rende il confronto sufficiente
// e' quindi ESPLICITO: chi muta i record dei lanci (up, down, riconciliazione)
// tiene il lock di scrittore della radice dei file; un secondo processo NC
// sulla stessa radice si ferma con un errore dichiarato invece di correre.
//
// Il lock e' un file `launch-targets/.writer-lock.json` con l'identita' del
// processo (pid + nascita da /proc, che distingue il riuso del numero). Un
// lock di un processo MORTO si riprende; un lock illeggibile o di un processo
// vivo e diverso blocca. Lo STESSO processo puo' tenere piu' runtime sulla
// stessa radice (gli stessi pid e nascita): la serializzazione per cella e'
// dentro il processo.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { leggiStarttimeProc } = require('./definitions.js');

const NOME = '.writer-lock.json';

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function identitaMia() {
  return { pid: process.pid, starttime: leggiStarttimeProc(process.pid) };
}

function leggi(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? { stato: 'assente' } : { stato: 'illeggibile' };
  }
  try {
    const d = JSON.parse(raw);
    if (!d || !Number.isSafeInteger(d.pid) || d.pid <= 0) return { stato: 'illeggibile' };
    return { stato: 'presente', dato: d };
  } catch (_) { return { stato: 'illeggibile' }; }
}

// Il processo del lock e' VIVO se ha ancora quel pid con quella nascita.
// Nascita non misurabile: non si dichiara morto.
function proprietarioVivo(dato) {
  const nascita = leggiStarttimeProc(dato.pid);
  if (nascita === null || nascita === undefined) {
    try { process.kill(dato.pid, 0); } catch (e) { return !(e && e.code === 'ESRCH'); }
    return true;
  }
  if (!Number.isFinite(dato.starttime)) return true;
  return nascita === dato.starttime;
}

/**
 * Acquisisce il lock di scrittore della radice `root`. Esito:
 *   { ok: true, token }            — acquisito (o gia' nostro)
 *   { ok: false, codice, pid? }    — 'altro-scrittore' | 'illeggibile' | 'scrittura'
 * Mai throw.
 */
function acquisisci(root) {
  try {
    const dir = path.join(root, 'launch-targets');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, NOME);
    const io = identitaMia();
    const token = crypto.randomBytes(8).toString('hex');
    const contenuto = `${JSON.stringify({ v: 1, pid: io.pid, starttime: io.starttime, token })}\n`;
    const corrente = leggi(file);
    if (corrente.stato === 'illeggibile') return { ok: false, codice: 'illeggibile' };
    if (corrente.stato === 'presente') {
      const d = corrente.dato;
      if (d.pid === io.pid && (d.starttime === io.starttime || !Number.isFinite(d.starttime))) {
        return { ok: true, token: d.token || token, gia: true };
      }
      if (proprietarioVivo(d)) return { ok: false, codice: 'altro-scrittore', pid: d.pid };
    }
    // Assente o di un processo morto: si scrive in modo atomico.
    const tmp = path.join(dir, `.writer-lock.${process.pid}.${token}.tmp`);
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, contenuto); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      fsyncDir(dir);
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (__) { /* best-effort */ }
      return { ok: false, codice: 'scrittura' };
    }
    return { ok: true, token };
  } catch (_) {
    return { ok: false, codice: 'scrittura' };
  }
}

/** Rilascia il lock se e' ancora quello con `token`. Mai throw. */
function rilascia(root, token) {
  try {
    const file = path.join(root, 'launch-targets', NOME);
    const c = leggi(file);
    if (c.stato !== 'presente' || c.dato.token !== token) return false;
    fs.unlinkSync(file);
    return true;
  } catch (_) { return false; }
}

module.exports = { acquisisci, rilascia, NOME };
