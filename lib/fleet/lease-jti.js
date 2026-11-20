'use strict';

// Registro transazionale dei jti dei proof lease.
//
// Contratto: controllo replay, prenotazione e consumo definitivo sono tre
// atti SEPARATI. Una presentazione ammissibile nei gate puri PRENOTA il
// proprio jti subito prima della transazione di bind: una seconda ammissione
// concorrente o rientrante dello stesso jti e' rifiutata finche' la
// prenotazione vive. Solo un bind committato CONSUMA definitivamente il jti
// (prima di esporre il successo); un bind fallito prima del commit, senza
// effetti pubblicati, rilascia la prenotazione SOLO al tentativo che la
// possiede (token), cosi' il proof ancora valido puo' riprovare. Un consumo
// non si rilascia mai: un commit riuscito o incerto non rimette il jti in
// circolo.
//
// Il registro vive in memoria e muore col processo: nessuna promessa di
// replay durevole attraverso un restart (la firma e l'expiry restano il
// gate). Bounded: le entry scadute escono alla prima operazione; a cap pieno
// le NUOVE prenotazioni sono rifiutate — una prenotazione viva o un consumo
// non scaduto NON vengono mai espulsi per far posto ad altri, cosi' il token
// del proprietario resta committabile e un consumo non e' dimenticato mentre
// il proof e' ancora in vita. Puro: nessun clock, nessun I/O — il tempo e'
// passato dal chiamante.

const JTI_CAP_DEFAULT = 4096;

function createJtiRegistry({ cap = JTI_CAP_DEFAULT } = {}) {
  const maxEntries = Number.isSafeInteger(cap) && cap > 0 ? cap : JTI_CAP_DEFAULT;
  const entries = new Map(); // jti -> { state: 'reserved' | 'consumed', expiresAt, n }
  let seq = 0;

  function prune(nowMs) {
    for (const [jti, entry] of entries) {
      if (!(entry.expiresAt > nowMs)) entries.delete(jti);
    }
  }

  // Prenota l'uso del jti per QUESTO tentativo. Ritorna un token
  // (handle univoco della prenotazione) oppure null se il jti e' gia'
  // prenotato o consumato e non scaduto, o se il registro e' pieno di
  // entry valide: una sola ammissione per jti e mai un'espulsione di
  // prenotazioni vive o consumi non scaduti per far posto a nuove.
  function reserve(jti, expiresAt, nowMs) {
    prune(nowMs);
    if (typeof jti !== 'string' || !jti.length) return null;
    if (entries.has(jti)) return null;
    if (entries.size >= maxEntries) return null;
    seq += 1;
    entries.set(jti, { state: 'reserved', expiresAt, n: seq });
    return { jti, n: seq };
  }

  // Consumo definitivo: solo il detentore del token, solo da prenotata.
  function commit(token) {
    if (!token || typeof token !== 'object') return false;
    const entry = entries.get(token.jti);
    if (!entry || entry.state !== 'reserved' || entry.n !== token.n) return false;
    entry.state = 'consumed';
    return true;
  }

  // Rilascio padronale: rimuove la prenotazione SOLO se aperta e SOLO se il
  // token e' quello del tentativo che l'ha presa. Su 'consumed' e' un no-op
  // fail-closed: un commit riuscito o incerto non autorizza il rilascio.
  function release(token) {
    if (!token || typeof token !== 'object') return false;
    const entry = entries.get(token.jti);
    if (!entry || entry.state !== 'reserved' || entry.n !== token.n) return false;
    entries.delete(token.jti);
    return true;
  }

  // Diagnostica/test: il jti e' presente (prenotato o consumato) e non scaduto.
  function seen(jti, nowMs) {
    prune(nowMs);
    return entries.has(jti);
  }

  return { reserve, commit, release, seen };
}

module.exports = { createJtiRegistry, JTI_CAP_DEFAULT };
