'use strict';
// Telemetria per-cella: contesto LIBERO e tier 5h/7d USATI, letti dal file che
// la statusline di Claude Code scrive in <root>/<sessione>/telemetry.json
// (snippet documentato in docs/STATUSLINE_TELEMETRY.md, NON applicato: la
// statusline e' dell'operatore). Il verso dei due dati e' OPPOSTO e i nomi del file lo
// portano scritto dentro: `contextFreePct` e' quanto RESTA, `tier*UsedPct` e'
// quanto e' STATO CONSUMATO. Confondere i versi produce una riga che dice il
// contrario del vero e fa prendere la decisione opposta a quella giusta.
//
// Tre regole non opinabili, tutte implementate qui:
//   1. TIMESTAMP OBBLIGATORIO: oltre MASSIMA_ETA_MS il dato e' morto e viene
//      restituito null — un numero stantio che sembra fresco e' peggio di un
//      numero assente.
//   2. ASSENZA LEGITTIMA: le celle non-Claude (codex-vl, agy, grok, shell) non
//      hanno quella statusline e non avranno mai questo file. File assente =
//      null, e la riga della lista resta com'era: niente campo, niente
//      trattino, niente «n/d».
//   3. LETTURA TOLLERANTE: file illeggibile, JSON rotto, campi mancanti o
//      fuori contratto — si degrada a null senza mai far fallire la lista.
//
// CONTRATTO del file: valori INTERI 0..100 (gia' percentuali — la
// normalizzazione frazione→percentuale e' compito di chi scrive, vedi lo
// snippet). Il lettore accetta SOLO interi: una frazione scritta per errore
// (0.5 che voleva essere 50%) viene rifiutata, non arrotondata a 1% — un
// numero sbagliato mostrato con sicurezza e' il difetto che conta, meglio
// nessun numero.

const fs = require('node:fs');
const path = require('node:path');

// La statusline aggiorna a ogni evento del modello: in una cella viva il file
// e' sempre piu' fresco di cosi'. Cinque minuti coprono una pausa pranzo senza
// mostrare come attuale il dato di ieri.
const MASSIMA_ETA_MS = 5 * 60 * 1000;
// La soglia guarda in ENTRAMBI i versi. Un ts nel futuro farebbe `ora - ts`
// negativo: la differenza non supera MAI la massima eta' e il dato resterebbe
// «fresco» per sempre — un orologio avanti, o uno ts scritto male, e la riga
// mostra un numero morto che non scadra' mai. Due minuti di skew sono il
// margine che un orologio legittimamente sforato puo' avere; oltre, il ts e'
// rotto e il dato non esiste.
const FUTURO_TOLLERATO_MS = 2 * 60 * 1000;

const NOME_FILE = 'telemetry.json';

// Accetta SOLO interi 0..100 gia' numeri. Tutto il resto e' fuori contratto
// e non viene mostrato — in particolare null e i booleani: `Number(null)` e'
// 0 e `Number(true)` e' 1, e un campo assente letto come «0% usato» e'
// esattamente il numero sbagliato-mostrato-con-sicurezza che questo modulo
// esiste per evitare.
function percentualeIntera(valore) {
  if (typeof valore !== 'number' || !Number.isInteger(valore)) return null;
  if (valore < 0 || valore > 100) return null;
  return valore;
}

/**
 * Legge la telemetria di una sessione. Ritorna `{ ts, contextFreePct?,
 * tier5hUsedPct?, tier7dUsedPct? }` con solo i campi validi, oppure null per
 * assenza legittima, dato stantio o qualsiasi rotture. Non lancia MAI.
 */
function leggiTelemetria(root, sessione, ora = Date.now()) {
  try {
    let raw;
    try {
      raw = fs.readFileSync(path.join(root, String(sessione), NOME_FILE), 'utf8');
    } catch (_) {
      return null; // assente (o non leggibile): cella non-Claude o primo avvio
    }
    const dato = JSON.parse(raw);
    if (!dato || typeof dato !== 'object' || Array.isArray(dato)) return null;
    const ts = Number(dato.ts);
    // Senza timestamp non c'e' freschezza da verificare: il dato non esiste.
    if (!Number.isFinite(ts)) return null;
    if (ora - ts > MASSIMA_ETA_MS) return null; // stantio = assente
    if (ts - ora > FUTURO_TOLLERATO_MS) return null; // ts rotto: «fresco per sempre» non e' fresco
    const campi = {};
    const libero = percentualeIntera(dato.contextFreePct);
    const t5 = percentualeIntera(dato.tier5hUsedPct);
    const t7 = percentualeIntera(dato.tier7dUsedPct);
    if (libero !== null) campi.contextFreePct = libero;
    if (t5 !== null) campi.tier5hUsedPct = t5;
    if (t7 !== null) campi.tier7dUsedPct = t7;
    return Object.keys(campi).length ? { ts, ...campi } : null;
  } catch (_) {
    return null; // JSON rotto o altro: la lista non fallisce per questo
  }
}

module.exports = { leggiTelemetria, MASSIMA_ETA_MS, FUTURO_TOLLERATO_MS, NOME_FILE };
