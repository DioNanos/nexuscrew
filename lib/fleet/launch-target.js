'use strict';
// lib/fleet/launch-target.js — il record del lancio POSSIEDUTO da questo
// processo NC: gli id tmux ($sessione, %pane) restituiti dalla creazione e
// l'identità del server su cui quella creazione e' avvenuta.
//
// PERCHE' QUESTO MODULO ESISTE. Un nome di sessione tmux e' un indirizzo
// RIUTILIZZABILE: quando il lancio A termina, chiunque puo' creare una
// sessione B con lo stesso nome. Fermare «per nome» significa fermare chi
// ocupa il nome ORA, non cio' che NC ha lanciato. Gli id $N/%N invece non
// vengono mai riutilizzati dentro lo stesso server tmux: sono l'identita'
// stabile. Questo record e' il possesso dimostrabile: chi lo ha scritto ha
// creato quella sessione su quel server e puo' rivendicarla per il teardown.
//
// Il record vive nella root dei file di NC, chiave = nome della sessione tmux
// della cella (la stessa chiave del registro dei lanci), disciplina 0600 con
// write+rename atomica: un lettore vede o il record vecchio per intero o
// quello nuovo per intero, mai un file a meta'.
//
// Stati di lettura — assenza VERIFICATA e ignoranza NON sono la stessa cosa:
//  - 'assente':      nessun record (mai lanciato da questo NC, o gia' pulito).
//  - 'presente':     record valido con i campi conformi.
//  - 'indeterminato': errore di lettura diverso da ENOENT o record non
//                     interpretabile. NON si cancella e NON si agisce sopra:
//                     l'identita' non e' dimostrabile né in un verso né
//                     nell'altro.

const fs = require('node:fs');
const path = require('node:path');

const DIR = 'launch-targets';
const RE_SESSIONE_TMUX = /^\$[0-9]+$/;
const RE_PANE_TMUX = /^%[0-9]+$/;
const RE_ID_LANCIO = /^[0-9a-f]{16}$/;
const RE_PID = /^[0-9]+$/;

function sessioneValida(sessione) {
  return typeof sessione === 'string' && !!sessione
    && !sessione.includes('/') && !sessione.includes('\\') && sessione !== '..';
}

function percorso(root, sessione) {
  return path.join(root, DIR, `${sessione}.json`);
}

// Scrittura atomica 0600 E DUREVOLE: temporaneo univoco nella stessa
// directory, fsync del file PRIMA del rename (il contenuto sopravvive al
// crash anche se il rename resta in pagina), rename, fsync della directory
// (il nuovo nome e' commitato), e — quando la directory e' stata creata da
// questa chiamata — fsync della padre (la directory stessa sopravvive al
// crash). Un errore in QUALSIASI punto rende l'esito false: il chiamante
// rifiuta il lancio invece di credere a una barriera che vive solo nella
// cache del processo che l'ha scritta. La disciplina del record precedente
// resta: un lettore vede o il record vecchio per intero o il nuovo per
// intero, mai un file a meta'; qui in piu' quello che si vede e' anche
// quello che resta dopo un riavvio.
function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function scriviAtomico(dir, nome, contenuto) {
  const destinazione = path.join(dir, nome);
  let tmp = null;
  try {
    const creata = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    tmp = path.join(dir, `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, contenuto, { encoding: 'utf8' });
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, destinazione);
    fsyncDir(dir);
    if (creata) fsyncDir(path.dirname(creata));
    return true;
  } catch (_) {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (_) { /* best-effort */ } }
    return false;
  }
}

/**
 * Registra il bersaglio del lancio corrente per una sessione tmux di cella.
 * Accetta SOLO id nella forma chiusa di tmux ($N per la sessione, %N per il
 * pane) e un id di lancio esadecimale: un valore fuori forma e' rifiutato
 * PRIMA di toccare il disco, perche' un record «quasi giusto» varrebbe come
 * prova di possesso e non lo e'. `family` e' la famiglia del CLIENT del
 * lancio ('vl' se il lancio ha richiesto la barriera host, 'other' altrimenti)
 * ed e' decisa ALLA CREAZIONE, quando l'engine usato e' un fatto e non una
 * ricostruzione: il teardown la legge da qui e non dall'engine aggiornato
 * della definizione, che puo' essere cambiato nel frattempo. Socket e pid del
 * server sono facoltativi (raccolti best-effort alla creazione): vuoti, il
 * teardown resta per id sul server risolto dall'ambiente; la verifica di
 * continuita' del server e' questione separata. Mai throw.
 */
/**
 * Registra un intent di lancio durevole prima della materializzazione.
 * Viene sovrascritto dal record completo al termine della creazione riuscita.
 */
function registraIntent(root, sessione, { launchId, tmuxSocket = '', family = '', ora = null } = {}) {
  try {
    if (!root || typeof root !== 'string') return false;
    if (!sessioneValida(sessione)) return false;
    if (typeof launchId !== 'string' || !RE_ID_LANCIO.test(launchId)) return false;
    if (family !== 'vl' && family !== 'other') return false;
    const socket = typeof tmuxSocket === 'string' && tmuxSocket.startsWith('/') ? tmuxSocket : '';
    const ts = Number(ora);
    const dato = {
      version: 1,
      family,
      launchId,
      stato: 'intent',
      incerto: true,
      sessionId: '$0',
      paneId: '%0',
      tmuxSocket: socket,
      serverPid: null,
      ts: Number.isFinite(ts) ? ts : Date.now(),
    };
    return scriviAtomico(path.join(root, DIR), `${sessione}.json`, `${JSON.stringify(dato)}\n`);
  } catch (_) {
    return false;
  }
}

function registra(root, sessione, { launchId, sessionId, paneId, tmuxSocket = '', serverPid = null, panePid = null, family = '', ora = null } = {}) {
  try {
    if (!root || typeof root !== 'string') return false;
    if (!sessioneValida(sessione)) return false;
    if (typeof launchId !== 'string' || !RE_ID_LANCIO.test(launchId)) return false;
    if (typeof sessionId !== 'string' || !RE_SESSIONE_TMUX.test(sessionId)) return false;
    if (typeof paneId !== 'string' || !RE_PANE_TMUX.test(paneId)) return false;
    if (family !== 'vl' && family !== 'other') return false;
    const socket = typeof tmuxSocket === 'string' && tmuxSocket.startsWith('/') ? tmuxSocket : '';
    const pid = serverPid != null && RE_PID.test(String(serverPid)) ? Number(serverPid) : null;
    // Il pid del SUPERVISORE del pane (#{pane_pid}), non quello del server
    // tmux: e' l'identita' che la verifica di uscita deve osservare PRIMA
    // dello stop, perche' dopo l'uscita non e' piu' ricavabile dal PID sparito.
    const pidPane = panePid != null && RE_PID.test(String(panePid)) ? Number(panePid) : null;
    const ts = Number(ora);
    const dato = {
      version: 1,
      family,
      launchId,
      sessionId,
      paneId,
      tmuxSocket: socket,
      serverPid: pid,
      panePid: pidPane,
      ts: Number.isFinite(ts) ? ts : Date.now(),
    };
    return scriviAtomico(path.join(root, DIR), `${sessione}.json`, `${JSON.stringify(dato)}\n`);
  } catch (_) {
    return false;
  }
}

/**
 * Legge il record del lancio per una sessione. Mai throw.
 */
function leggi(root, sessione) {
  try {
    if (!root || typeof root !== 'string') return { stato: 'indeterminato' };
    if (!sessioneValida(sessione)) return { stato: 'indeterminato' };
    let raw;
    try {
      raw = fs.readFileSync(percorso(root, sessione), 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { stato: 'assente' };
      return { stato: 'indeterminato' };
    }
    const dato = JSON.parse(raw);
    if (!dato || typeof dato !== 'object') return { stato: 'indeterminato' };
    if (typeof dato.launchId !== 'string' || !RE_ID_LANCIO.test(dato.launchId)) return { stato: 'indeterminato' };
    if (typeof dato.sessionId !== 'string' || !RE_SESSIONE_TMUX.test(dato.sessionId)) return { stato: 'indeterminato' };
    if (typeof dato.paneId !== 'string' || !RE_PANE_TMUX.test(dato.paneId)) return { stato: 'indeterminato' };
    return {
      stato: 'presente',
      record: {
        launchId: dato.launchId,
        // family assente (record scritto prima del campo): null, NON 'other'.
        // Chi legge decide; il conservative default e' trattare l'ignoto come
        // lancio che richiede la barriera, mai come esente.
        family: dato.family === 'vl' || dato.family === 'other' ? dato.family : null,
        sessionId: dato.sessionId,
        paneId: dato.paneId,
        tmuxSocket: typeof dato.tmuxSocket === 'string' ? dato.tmuxSocket : '',
        serverPid: Number.isFinite(dato.serverPid) ? dato.serverPid : null,
        panePid: Number.isFinite(dato.panePid) ? dato.panePid : null,
        ts: Number.isFinite(dato.ts) ? dato.ts : null,
        incerto: dato.incerto === true,
      },
    };
  } catch (_) {
    return { stato: 'indeterminato' };
  }
}

/**
 * Rimuove il record dopo un teardown COMPLETATO (o quando il lancio fallisce
 * dopo averlo scritto). Assenza = successo: non c'e' niente da ripulire e
 * non e' un errore. Mai throw.
 */
function marcaIncerto(root, sessione) {
  try {
    const letto = leggi(root, sessione);
    if (letto.stato !== 'presente') return false;
    const raw = fs.readFileSync(percorso(root, sessione), 'utf8');
    const dato = JSON.parse(raw);
    dato.incerto = true;
    return scriviAtomico(path.join(root, DIR), `${sessione}.json`, `${JSON.stringify(dato)}\n`);
  } catch (_) {
    return false;
  }
}

// La rimozione e' un COMMIT, non un suggerimento: l'unlink da solo vive
// nella cache della directory. Senza fsync della directory il record puo'
// riapparire dopo un crash e la barriera sparire da un processo vivo che
// credeva il lancio chiuso. Successo (true) solo quando la rimozione e'
// durevole; un errore di sync lascia il chiamante sul conservative «record
// ancora presente».
function rimuovi(root, sessione) {
  try {
    if (!root || typeof root !== 'string') return false;
    if (!sessioneValida(sessione)) return false;
    fs.unlinkSync(percorso(root, sessione));
  } catch (e) {
    if (e && e.code === 'ENOENT') return true;
    return false;
  }
  try {
    fsyncDir(path.join(root, DIR));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { registra, registraIntent, leggi, rimuovi, marcaIncerto, DIR };
