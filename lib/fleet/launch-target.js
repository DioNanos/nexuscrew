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

// Scrittura atomica 0600: temporaneo univoco nella stessa directory, poi
// rename. Stessa disciplina dei record di attivita' (files/activity.js).
function scriviAtomico(dir, nome, contenuto) {
  const destinazione = path.join(dir, nome);
  let tmp = null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    tmp = path.join(dir, `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    fs.writeFileSync(tmp, contenuto, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, destinazione);
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

function registra(root, sessione, { launchId, sessionId, paneId, tmuxSocket = '', serverPid = null, family = '', ora = null } = {}) {
  try {
    if (!root || typeof root !== 'string') return false;
    if (!sessioneValida(sessione)) return false;
    if (typeof launchId !== 'string' || !RE_ID_LANCIO.test(launchId)) return false;
    if (typeof sessionId !== 'string' || !RE_SESSIONE_TMUX.test(sessionId)) return false;
    if (typeof paneId !== 'string' || !RE_PANE_TMUX.test(paneId)) return false;
    if (family !== 'vl' && family !== 'other') return false;
    const socket = typeof tmuxSocket === 'string' && tmuxSocket.startsWith('/') ? tmuxSocket : '';
    const pid = serverPid != null && RE_PID.test(String(serverPid)) ? Number(serverPid) : null;
    const ts = Number(ora);
    const dato = {
      version: 1,
      family,
      launchId,
      sessionId,
      paneId,
      tmuxSocket: socket,
      serverPid: pid,
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

function rimuovi(root, sessione) {
  try {
    if (!root || typeof root !== 'string') return false;
    if (!sessioneValida(sessione)) return false;
    fs.unlinkSync(percorso(root, sessione));
    return true;
  } catch (e) {
    if (e && e.code === 'ENOENT') return true;
    return false;
  }
}

module.exports = { registra, registraIntent, leggi, rimuovi, marcaIncerto, DIR };
