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
// processo (pid + nascita da /proc, che distingue il riuso del numero).
//
// ESCLUSIONE: il file si pubblica con link(2) di un temporaneo gia' completo,
// che fallisce con EEXIST se il lock esiste: nessun rename puo' sovrascrivere
// il risultato di un altro. Il lock di un processo MORTO si riprende dentro un
// mutex di takeover (file creato con lo stesso link esclusivo): chi lo tiene
// rilegge il lock, ne verifica la morte, lo toglie e pubblica il proprio; un
// mutex rimasto di un processo morto NON si scavalca (fallisce chiuso). File
// non regolari, link, non nostri o di modo diverso da 0600 bloccano.
// Nel ripiego senza link(2), un fallimento DOPO la creazione esclusiva porta
// via il file creato dal processo stesso (identita' dimostrata: mai il file
// di un altro), cosi' un guasto passeggero non lascia scorie eterne.
// L'fsync della cartella DOPO la pubblicazione riuscita segue la stessa
// regola: se fallisce, il lock appena pubblicato (completo, con pid e token
// nostri) si toglie solo se la rilettura ne dimostra ancora l'identita'; poi
// il rifiuto resta 'scrittura', senza registrazione.
//
// STESSO PROCESSO: lo stato dei possessori e' condiviso a livello di modulo
// (radice -> token + conteggio); il lock su disco si toglie solo quando
// l'ultimo possessore rilascia.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { leggiStarttimeProc } = require('./definitions.js');

const NOME = '.writer-lock.json';
const NOME_MUTEX = '.writer-lock.takeover.json';

// radice canonica -> { token, conteggio } dei possessori di QUESTO processo.
const possessori = new Map();

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Rimuove `dest` solo se e' ancora il file regolare aperto come `fd`: fstat
// del fd contro lstat della destinazione, stesso dev e stesso ino. Se nel
// frattempo il nome e' passato a un file di un altro, non si tocca niente:
// mai un unlink cieco del file di un altro.
function rimuoviSeNostro(fd, dest) {
  try {
    const mio = fs.fstatSync(fd);
    const suDisco = fs.lstatSync(dest);
    if (mio.isFile() && suDisco.isFile() && mio.dev === suDisco.dev && mio.ino === suDisco.ino) {
      fs.unlinkSync(dest);
    }
  } catch (_) { /* best-effort: senza pulizia il rifiuto resta chiuso */ }
}

function identitaMia() {
  return { pid: process.pid, starttime: leggiStarttimeProc(process.pid) };
}

// Legge un file di lock SENZA seguire link e solo se e' regolare, nostro,
// 0600, con un solo nome. { stato: 'assente'|'illeggibile'|'presente', dato?, ino? }
function leggi(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    return e && e.code === 'ENOENT' ? { stato: 'assente' } : { stato: 'illeggibile' };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600) return { stato: 'illeggibile' };
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { stato: 'illeggibile' };
    const d = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!d || !Number.isSafeInteger(d.pid) || d.pid <= 0) return { stato: 'illeggibile' };
    return { stato: 'presente', dato: d, ino: st.ino, dev: st.dev };
  } catch (_) {
    return { stato: 'illeggibile' };
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* best-effort */ }
  }
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

// Codici con cui un filesystem puo' negare link(2) senza che il file esista:
// le cartelle delle app su Android/Termux rispondono EPERM o EACCES, altri
// kernel ENOSYS o ENOTSUP. Nessuno di questi e' EEXIST: nessuno ha il file.
const SENZA_LINK = new Set(['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP']);

// Pubblicazione ESCLUSIVA: temporaneo completo + link(2). EEXIST = qualcuno
// ha gia' il file; mai un rename che sovrascrive. Dove link(2) e' negato
// (Android/Termux) si ripiega su una creazione esclusiva diretta della
// destinazione ('wx', 0600): un lettore che veda il file ancora parziale lo
// giudica illeggibile e fallisce chiuso, quindi l'esclusione resta.
function pubblicaEsclusivo(dir, nome, contenuto, token) {
  const tmp = path.join(dir, `.${nome}.${process.pid}.${token}.tmp`);
  const dest = path.join(dir, nome);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, contenuto);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(tmp, dest);
    } catch (e) {
      if (e && e.code === 'EEXIST') return { ok: false, esiste: true };
      if (!e || !SENZA_LINK.has(e.code)) return { ok: false, esiste: false };
      // Ripiego senza hard link: creazione esclusiva diretta. Un EEXIST qui
      // significa che un altro ha gia' il file; niente rename che sovrascrive.
      // Se qualcosa fallisce DOPO l'open, il file appena creato e' NOSTRO e
      // resta parziale o non registrato: lo si toglie, dopo averne dimostrato
      // l'identita'. Cosi' il rifiuto di oggi non diventa un illeggibile o un
      // takeover senza uscita.
      try {
        fd = fs.openSync(dest, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, contenuto);
          fs.fchmodSync(fd, 0o600);
          fs.fsyncSync(fd);
          // La cartella si sincronizza PRIMA di chiudere il fd: se fallisce,
          // il fd serve ancora per dimostrare l'identita' del file da ripulire.
          fsyncDir(dir);
          fs.closeSync(fd);
          fd = null;
        } catch (_) {
          if (fd !== null) rimuoviSeNostro(fd, dest);
          return { ok: false, esiste: false };
        }
        return { ok: true };
      } catch (e2) {
        return { ok: false, esiste: !!(e2 && e2.code === 'EEXIST') };
      }
    }
    return { ok: true };
  } catch (_) {
    return { ok: false, esiste: false };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* best-effort */ } }
    try { fs.unlinkSync(tmp); } catch (_) { /* best-effort */ }
  }
}

function dirQualificata(root) {
  const dir = path.join(root, 'launch-targets');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) return null;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
  return dir;
}

// Fsync della cartella DOPO la pubblicazione riuscita del lock: se fallisce,
// il file appena pubblicato e' NOSTRO ma nessun possessore e' registrato, e
// senza pulizia resterebbe per sempre (il processo stesso, vivo, verrebbe poi
// respinto come 'altro-scrittore' fino al riavvio). Lo si toglie solo se la
// rilettura dal disco dimostra che e' ancora il nostro: file regolare letto
// senza link, token e pid uguali a quelli appena pubblicati. Mai il lock di
// un altro. Ritorna false quando la scrittura e' fallita: il rifiuto resta
// 'scrittura'.
function fsyncDirDopoPubblicazione(dir, file, token, pid) {
  try {
    fsyncDir(dir);
    return true;
  } catch (_) {
    const c = leggi(file);
    if (c.stato === 'presente' && c.dato.token === token && c.dato.pid === pid) {
      try { fs.unlinkSync(file); } catch (_) { /* best-effort: il rifiuto resta chiuso */ }
    }
    return false;
  }
}

/**
 * Acquisisce il lock di scrittore della radice `root`. Esito:
 *   { ok: true, token }            — acquisito (o gia' nostro, contato)
 *   { ok: false, codice, pid? }    — 'altro-scrittore' | 'illeggibile' | 'takeover' | 'scrittura'
 * Mai throw.
 */
function acquisisci(root) {
  try {
    const chiave = path.resolve(root);
    const dir = dirQualificata(root);
    if (!dir) return { ok: false, codice: 'illeggibile' };
    const file = path.join(dir, NOME);
    const io = identitaMia();
    const mio = possessori.get(chiave);
    if (mio) {
      // Gia' tenuto da questo processo: il file deve essere ANCORA il nostro.
      const c = leggi(file);
      if (c.stato === 'presente' && c.dato.token === mio.token && c.dato.pid === io.pid) {
        mio.conteggio += 1;
        return { ok: true, token: mio.token, gia: true };
      }
      possessori.delete(chiave);
      return { ok: false, codice: 'altro-scrittore' };
    }
    const token = crypto.randomBytes(8).toString('hex');
    const contenuto = `${JSON.stringify({ v: 1, pid: io.pid, starttime: io.starttime, token })}\n`;
    const registra = () => {
      possessori.set(chiave, { token, conteggio: 1 });
      return { ok: true, token };
    };
    const primo = pubblicaEsclusivo(dir, NOME, contenuto, token);
    if (primo.ok) {
      if (!fsyncDirDopoPubblicazione(dir, file, token, io.pid)) return { ok: false, codice: 'scrittura' };
      return registra();
    }
    if (!primo.esiste) return { ok: false, codice: 'scrittura' };
    const corrente = leggi(file);
    if (corrente.stato === 'illeggibile') return { ok: false, codice: 'illeggibile' };
    if (corrente.stato === 'presente' && proprietarioVivo(corrente.dato)) {
      return { ok: false, codice: 'altro-scrittore', pid: corrente.dato.pid };
    }
    // Assente (rilasciato nel frattempo) o di un processo morto: il takeover e'
    // SERIALIZZATO da un mutex esclusivo; chi lo tiene ricontrolla tutto.
    const mx = pubblicaEsclusivo(dir, NOME_MUTEX, `${JSON.stringify({ v: 1, pid: io.pid, starttime: io.starttime, token })}\n`, token);
    if (!mx.ok) return { ok: false, codice: mx.esiste ? 'takeover' : 'scrittura' };
    try {
      const ricontrollo = leggi(file);
      if (ricontrollo.stato === 'illeggibile') return { ok: false, codice: 'illeggibile' };
      if (ricontrollo.stato === 'presente') {
        if (proprietarioVivo(ricontrollo.dato)) {
          return { ok: false, codice: 'altro-scrittore', pid: ricontrollo.dato.pid };
        }
        // Morto: si toglie solo se e' ancora esattamente il file giudicato morto.
        if (ricontrollo.ino !== corrente.ino || ricontrollo.dev !== corrente.dev) {
          return { ok: false, codice: 'altro-scrittore', pid: ricontrollo.dato.pid };
        }
        fs.unlinkSync(file);
      }
      const secondo = pubblicaEsclusivo(dir, NOME, contenuto, token);
      if (!secondo.ok) return { ok: false, codice: secondo.esiste ? 'altro-scrittore' : 'scrittura' };
      if (!fsyncDirDopoPubblicazione(dir, file, token, io.pid)) return { ok: false, codice: 'scrittura' };
      return registra();
    } finally {
      try { fs.unlinkSync(path.join(dir, NOME_MUTEX)); } catch (_) { /* best-effort */ }
    }
  } catch (_) {
    return { ok: false, codice: 'scrittura' };
  }
}

/** Vero se il lock su disco e' ancora quello con `token`, di questo processo. */
function verifica(root, token) {
  try {
    const c = leggi(path.join(root, 'launch-targets', NOME));
    return c.stato === 'presente' && c.dato.token === token && c.dato.pid === process.pid;
  } catch (_) { return false; }
}

/**
 * Rilascia UN possessore. Il file si toglie solo quando l'ultimo possessore
 * di questo processo rilascia e solo se e' ancora quello con `token`.
 */
function rilascia(root, token) {
  try {
    const chiave = path.resolve(root);
    const mio = possessori.get(chiave);
    if (!mio || mio.token !== token) return false;
    mio.conteggio -= 1;
    if (mio.conteggio > 0) return true;
    possessori.delete(chiave);
    const file = path.join(root, 'launch-targets', NOME);
    const c = leggi(file);
    if (c.stato !== 'presente' || c.dato.token !== token) return false;
    fs.unlinkSync(file);
    return true;
  } catch (_) { return false; }
}

module.exports = { acquisisci, rilascia, verifica, NOME, NOME_MUTEX };
