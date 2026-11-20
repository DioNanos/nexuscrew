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
const { pubblicaEsclusiva } = require('./exclusive-publish.js');

const NOME = '.writer-lock.json';
const NOME_MUTEX = '.writer-lock.takeover.json';

// radice canonica -> { token, conteggio } dei possessori di QUESTO processo.
const possessori = new Map();

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
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

// Pubblicazione ESCLUSIVA: temporaneo completo + link(2); EEXIST = qualcuno
// ha gia' il file; mai un rename che sovrascrive. Il ripiego senza link(2) e'
// lo STESSO primitivo condiviso del resto del prodotto (creazione esclusiva
// verificata per descrittore, cinque errno ammessi, nessuna apparizione
// atomica). Dopo una creazione riuscita ma non verificabile il nome resta per
// tutti gli altri (occupato/incerto, mai riparato da un concorrente); il solo
// CREATORE toglie la generazione propria, dimostrata da identita' dell'oggetto
// creato e byte ancora suoi.
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
    const atteso = Buffer.from(contenuto, 'utf8');
    const pub = pubblicaEsclusiva({ src: tmp, dest, bytes: atteso });
    if (pub.status === 'published') return { ok: true };
    if (pub.status === 'exists') return { ok: false, esiste: true };
    if (pub.status === 'uncertain-after-create' && pub.created) {
      // Cleanup solo della PROPRIA generazione: l'oggetto che questa chiamata
      // ha creato (dev/ino catturati sul fd) e che contiene ancora soltanto
      // byte nostri (un prefisso, anche vuoto, di quanto volevamo scrivere).
      // L'inode da solo non basta una volta chiuso il fd (puo' essere
      // riassegnato); un successore ha altri byte. Il residuo di un processo
      // MORTO, o di un altro, non e' mai dimostrabile cosi' e non si tocca.
      try {
        const su = fs.lstatSync(dest);
        if (su.isFile() && su.dev === pub.created.dev && su.ino === pub.created.ino) {
          const corrente = fs.readFileSync(dest);
          if (corrente.length <= atteso.length && atteso.subarray(0, corrente.length).equals(corrente)) {
            fs.unlinkSync(dest);
          }
        }
      } catch (_) { /* best-effort: resta chiuso */ }
    }
    return { ok: false, esiste: false };
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
 * Rilascia UN possessore con esito strutturato. Un'identita' di lock sostituita,
 * assente o illeggibile fa comunque decadere la titolarita' in `possessori`
 * (abbandono dell'autorita'), mentre su record ancora posseduto non cancella
 * mai `possessori` prima del successo di `unlinkSync` e non esegue mai
 * `unlink` su un lockfile sostituito, assente o illeggibile.
 */
function rilasciaDettaglio(root, token) {
  try {
    const chiave = path.resolve(root);
    const mio = possessori.get(chiave);
    if (!mio || mio.token !== token) {
      return { ok: false, outcome: 'not-owner', released: false };
    }
    const file = path.join(root, 'launch-targets', NOME);
    const c = leggi(file);
    if (c.stato !== 'presente' || c.dato.token !== token || c.dato.pid !== process.pid) {
      const outcome = c.stato === 'assente' ? 'absent'
        : c.stato === 'illeggibile' ? 'unreadable'
          : 'replaced';
      possessori.delete(chiave);
      return { ok: false, outcome, released: false };
    }
    if (mio.conteggio > 1) {
      mio.conteggio -= 1;
      return {
        ok: true,
        outcome: 'quota-released',
        released: true,
        remainingHolders: mio.conteggio,
      };
    }
    try {
      fs.unlinkSync(file);
    } catch (e) {
      return {
        ok: false,
        outcome: 'unlink-failed',
        released: false,
        errorCode: e && e.code ? String(e.code) : 'UNLINK_FAILED',
      };
    }
    possessori.delete(chiave);
    return {
      ok: true,
      outcome: 'released',
      released: true,
      remainingHolders: 0,
    };
  } catch (_) {
    return { ok: false, outcome: 'error', released: false };
  }
}

/**
 * Rilascia UN possessore. Il file si toglie solo quando l'ultimo possessore
 * di questo processo rilascia e solo se e' ancora quello con `token`.
 */
function rilascia(root, token) {
  return rilasciaDettaglio(root, token).ok === true;
}

module.exports = { acquisisci, rilascia, rilasciaDettaglio, verifica, NOME, NOME_MUTEX };
