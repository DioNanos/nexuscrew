'use strict';
// lib/fleet/control-protocol.js — protocollo NDJSON a tipi chiusi del canale
// broker di controllo (requisito V6-04).
//
// PERCHE' QUESTO MODULO ESISTE. Il canale lease della cella diventa anche il
// canale di controllo del ciclo di stop: NC e il client della cella (il
// coordinatore del gruppo di processo) si parlano sulla STESSA connessione
// con frame NDJSON a tipi chiusi. Le proprieta' che il disegno esige e che
// questo modulo garantisce da solo, prima di qualunque innesto:
//
//   - UN parser per stream: l'accumulo avviene qui, per byte, fino al newline;
//     il transport non deve tenere parzializzazioni proprie.
//   - UTF-8 frammentato ricomposto: l'accumulatore lavora su Buffer, la riga
//     viene decodificata SOLO quando e' completa (spezzare una sequenza
//     multibyte su due chunk non perde e non corrompe nulla).
//   - accumulatore bounded: una riga oltre il cap senza newline, un JSON
//     malformato, un frame fuori dai tipi chiusi = protocollo ROTTO. La
//     connessione va distrutta dal chiamante (onRotto): nessun frame parziale
//     viene mai consegnato come se fosse valido.
//   - EOF con accumulatore non vuoto = frame troncato = rotto.
//   - il verificatore del token di controllo tiene SOLO l'hash sha256, mai il
//     token; il confronto e' a tempo costante; revocato a fine lancio.
//   - le epoche numerano le (ri)connessioni: un messaggio di un'epoca
//     precedente NON e' autoritativo (no-op), non un errore.
//
// Nessun segreto entra nei frame: il token di controllo non si trasmette, si
// presenta il suo hash nel payload del primo frame di una connessione.

const crypto = require('node:crypto');

const CAP_RIGA_DEFAULT = 64 * 1024;
const CAP_PAYLOAD_JSON = 4096;
const CAP_DEDUP = 256;
const RE_REQUEST_ID = /^[a-f0-9]{16}$/;

// Tipi chiusi del protocollo (V6-04/V6-01). Aggiungere un op e' una decisione
// di protocollo, non un refactor: fuori da qui il frame e' rotto.
const OPS = new Set([
  'stop',             // NC -> coordinatore: ferma il gruppo {requestId, deadlineMs}
  'stop-ack',         // coordinatore -> NC: ammissione (NON esito)
  'ready-to-exit',    // coordinatore -> NC: gli ALTRI membri sono terminati
  'escalate-commit',  // coordinatore -> NC: impegno PREVIO alla escalation
  'stop-report',      // coordinatore -> NC: esito osservato con conteggi
]);

function validaFrame(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'non-oggetto';
  if (typeof o.op !== 'string' || !OPS.has(o.op)) return 'op-chiusa';
  if (typeof o.requestId !== 'string' || !RE_REQUEST_ID.test(o.requestId)) return 'requestId';
  if (typeof o.launchId !== 'string' || !RE_REQUEST_ID.test(o.launchId)) return 'launchId';
  if (!Number.isSafeInteger(o.epoch) || o.epoch < 1) return 'epoch';
  if (o.payload !== undefined) {
    if (!o.payload || typeof o.payload !== 'object' || Array.isArray(o.payload)) return 'payload';
    if (Buffer.byteLength(JSON.stringify(o.payload), 'utf8') > CAP_PAYLOAD_JSON) return 'payload';
  }
  return null;
}

/**
 * Core condiviso dei parser: accumulo per BYTE fino al newline, riga completa
 * consegnata a smista(o, rompi) UNA volta; smista puo' chiamare rompi(motivo)
 * per le violazioni che conosce solo lui. Da li' in poi il parser e' sordo.
 * fine() va chiamata a EOF: residuo non vuoto = frame troncato = rotto.
 */
function creaParserCore({ capRiga = CAP_RIGA_DEFAULT, smista, onRotto } = {}) {
  let buf = Buffer.alloc(0);
  let rotto = false;
  const rompi = (motivo) => {
    if (rotto) return;
    rotto = true;
    buf = Buffer.alloc(0);
    if (typeof onRotto === 'function') { try { onRotto(motivo); } catch (_) { /* diagnostica */ } }
  };
  return {
    get rotto() { return rotto; },
    spingiBytes(chunk) {
      if (rotto || !Buffer.isBuffer(chunk) || chunk.length === 0) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) break;
        const rigaByte = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
        if (rigaByte.length === 0) continue; // riga vuota: separatore, non frame
        if (rigaByte.length > capRiga) { rompi('riga-oltre-cap'); return; }
        let o;
        try { o = JSON.parse(rigaByte.toString('utf8')); } catch (_) { rompi('json-malformato'); return; }
        try { smista(o, rompi); } catch (_) { rompi('handler'); }
        if (rotto) return;
      }
      if (buf.length > capRiga) rompi('riga-oltre-cap');
    },
    spingi(testo) {
      if (typeof testo !== 'string') return;
      this.spingiBytes(Buffer.from(testo, 'utf8'));
    },
    fine() {
      if (rotto) return;
      if (buf.length > 0) rompi('eof-frame-troncato');
    },
  };
}

/**
 * Il parser di soli frame di controllo: UNO per stream. Ogni riga DEVE essere
 * un frame a tipo chiuso; fuori tipo = protocollo rotto.
 */
function creaParser({ capRiga = CAP_RIGA_DEFAULT, onFrame, onRotto } = {}) {
  return creaParserCore({
    capRiga,
    smista(o, rompi) {
      const errore = validaFrame(o);
      if (errore) { rompi(`frame-invalido:${errore}`); return; }
      if (typeof onFrame === 'function') { try { onFrame(o); } catch (_) { /* il chiamante decide */ } }
    },
    onRotto,
  });
}

/**
 * Il parser IBRIDO della connessione lease: un solo accumulatore per stream
 * che smista sulla STESSA connessione i frame di controllo (campo `op` chiuso,
 * validati come creaParser) e le righe lease esistenti (campo `type`,
 * consegnate GREZZE al gestore legacy che ne valida lo schema). La riga si
 * decodifica solo quando e' completa: l'UTF-8 frammentato su piu' chunk viene
 * ricomposto prima della decodifica, per entrambe le famiglie.
 * Il canale e' a protocollo chiuso: JSON malformato = rotto, anche se la
 * riga sarebbe stata per il lato lease.
 */
function creaParserIbrido({ capRiga = CAP_RIGA_DEFAULT, onFrame, onLeaseLine, onRotto } = {}) {
  return creaParserCore({
    capRiga,
    smista(o, rompi) {
      if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.op === 'string') {
        const errore = validaFrame(o);
        if (errore) { rompi(`frame-invalido:${errore}`); return; }
        if (typeof onFrame === 'function') { try { onFrame(o); } catch (_) { /* il chiamante decide */ } }
        return;
      }
      if (typeof onLeaseLine === 'function') { try { onLeaseLine(o); } catch (_) { /* ignora come oggi */ } }
    },
    onRotto,
  });
}

/** Codifica un frame in riga NDJSON (validazione inclusa: mai frame invalidi). */
function codifica(frame) {
  const errore = validaFrame(frame);
  if (errore) throw new Error(`frame di controllo non valido: ${errore}`);
  return `${JSON.stringify(frame)}\n`;
}

/** Dedup per requestId (V6-01.4: messaggio idempotente), con tetto. */
function creaDedup() {
  const visti = new Map();
  return {
    nuovo(id) {
      if (typeof id !== 'string' || !RE_REQUEST_ID.test(id)) return false;
      if (visti.has(id)) return false;
      visti.set(id, 1);
      if (visti.size > CAP_DEDUP) visti.delete(visti.keys().next().value);
      return true;
    },
  };
}

/** Verificatore durevole del token di controllo: tiene l'HASH, mai il token. */
function creaVerificatore() {
  let hashBuf = null;
  let hashHex = '';
  return {
    arma(token) {
      if (typeof token !== 'string' || token.length === 0) throw new Error('token di controllo assente');
      hashBuf = crypto.createHash('sha256').update(token, 'utf8').digest();
      hashHex = hashBuf.toString('hex');
      return hashHex;
    },
    verifica(prova) {
      if (!hashBuf || typeof prova !== 'string' || !/^[a-f0-9]{64}$/.test(prova)) return false;
      let provaBuf;
      try { provaBuf = Buffer.from(prova, 'hex'); } catch (_) { return false; }
      return provaBuf.length === hashBuf.length && crypto.timingSafeEqual(provaBuf, hashBuf);
    },
    revoca() { hashBuf = null; hashHex = ''; },
    get hash() { return hashHex; },
  };
}

/** Epoche di connessione: ogni (ri)connessione ne apre una nuova. */
function creaEpoche() {
  let corrente = 0;
  return {
    nuova() { corrente += 1; return corrente; },
    get corrente() { return corrente; },
    autoritativo(epoch) {
      return Number.isSafeInteger(epoch) && epoch === corrente && corrente > 0;
    },
  };
}

module.exports = {
  creaParser, creaParserIbrido, codifica, creaDedup, creaVerificatore, creaEpoche,
  validaFrame, OPS, CAP_RIGA_DEFAULT, CAP_PAYLOAD_JSON,
};
