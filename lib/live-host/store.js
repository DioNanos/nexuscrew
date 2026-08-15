'use strict';
// lib/live-host/store.js — stato della designazione "cella ospite Live" di un nodo.
//
// Un solo hostCell per nodo (contratto rev6 §2.2): chiave unica, non una convenzione
// ripetuta in N punti. Lo stato vive su disco (sopravvive a riavvii di cella e di
// NexusCrew) e l'aggiornamento e' un CAS su `revision`: due designazioni concorrenti
// non possono lasciare due celle rosse — il perdente rilegge la revision e rinuncia.
//
// La designazione e' PURAMENTE un marker di scelta del nodo. L'eligibilita' (la cella
// e' anche attiva in questo momento?) e' derivata dal roster Fleet e non si persiste
// qui: `active` resta `sessions.has(tmuxSession)` (runtime.js), la marcatura non lo
// tocca. Una cella spenta PRESERVA la designazione — resta hostCell, semplicemente
// ineligible finche' non torna attiva.

const path = require('node:path');
const os = require('node:os');
const { readJsonSafe, atomicWriteJson } = require('../notify/persist.js');

const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;

// Path del file di stato: override esplicito -> dir del token (~/.nexuscrew) -> home.
// Stessa convenzione di consentPath/groupsPath, cosi' i test isolano lo stato via
// cfg.tokenPath senza toccare la home reale.
function liveHostPath(cfg = {}, home = (cfg.home || os.homedir())) {
  if (cfg.liveHostPath) return cfg.liveHostPath;
  if (cfg.tokenPath) return path.join(path.dirname(cfg.tokenPath), 'live-host.json');
  return path.join(home, '.nexuscrew', 'live-host.json');
}

// Normalizza il grezzo letto da disco in {revision, hostCell}. Un file assente o
// garbage (readJsonSafe -> {}) e' lo stato iniziale legittimo {0, null}; un hostCell
// non-string o fuori formato viene chiuso a null senza promuovere garbage.
function normalize(raw) {
  const revision = raw && Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  const hostCell = raw && typeof raw.hostCell === 'string' && CELL_ID_RE.test(raw.hostCell)
    ? raw.hostCell : null;
  return { revision, hostCell };
}

function readLiveHost(filePath) {
  return normalize(readJsonSafe(filePath));
}

// createLiveHostStore({filePath, now}) — CAS store.
//
// read+compare+write sono sincroni, ma le route sono async e due richieste concorrenti
// possono entrambe aver letto la stessa revision prima che una delle due scriva. La
// promise-chain serializza la sezione read-modify-write: nessun await dentro la
// callback, quindi il check e la scrittura sono una sola transazione atomica rispetto
// agli altri CAS in volo. Esattamente uno dei due CAS concorrenti avanza la revision.
function createLiveHostStore({ filePath, now = () => Date.now() } = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('createLiveHostStore: filePath richiesto');
  }
  let chain = Promise.resolve();

  function serialize(fn) {
    const run = chain.then(fn);
    // La catena non si rompe mai su un errore di un CAS: un fallimento non deve
    // bloccare i successivi (un CAS che lancia risolve comunque il run).
    chain = run.then(() => {}, () => {});
    return run;
  }

  // Snapshot read-only corrente (dopo normalizzazione).
  function snapshot() {
    return readLiveHost(filePath);
  }

  // CAS: scrive nextHostCell (stringa valida | null) solo se la revision corrente
  // coincide con expectedRevision. Ritorna:
  //   { ok:true, revision:<nuova>, hostCell:<nuovo>, at }
  //   { ok:false, conflict:true, revision:<corrente>, hostCell:<corrente> }
  // Fail-closed: expectedRevision deve essere un integer che coincide con la
  // revision corrente. Uno expected non-integer (es. undefined) NON e' un
  // lasciapassare: e' un conflitto. Lo stato iniziale e' revision 0 ed e'
  // conoscibile (la UI lo legge dal GET), quindi non esiste un "primo scrittore
  // senza revision" legittimo: l'assenza del campo va rifiutata, non tollerata.
  function compareAndSet(expectedRevision, nextHostCell) {
    return serialize(() => {
      const cur = readLiveHost(filePath);
      if (!Number.isInteger(expectedRevision) || cur.revision !== expectedRevision) {
        return { ok: false, conflict: true, revision: cur.revision, hostCell: cur.hostCell };
      }
      const hostCell = nextHostCell === null ? null
        : (typeof nextHostCell === 'string' && CELL_ID_RE.test(nextHostCell) ? nextHostCell : null);
      const revised = { revision: cur.revision + 1, hostCell, updatedAt: now() };
      atomicWriteJson(filePath, revised);
      return { ok: true, revision: revised.revision, hostCell: revised.hostCell, at: revised.updatedAt };
    });
  }

  return { snapshot, compareAndSet, filePath };
}

module.exports = { createLiveHostStore, liveHostPath, readLiveHost, normalize, CELL_ID_RE };
