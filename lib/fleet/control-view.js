'use strict';
// Presentazione condivisa dello stato di supervisione NC per cella
// (calcolato dal runtime nel campo `ncControl` dello /status). Tre lingue,
// tutte con «NC» esplicito per non negare il keepalive locale del
// supervisore. Modulo PURO: nessuna dipendenza, usabile da CLI e test.
//
// Il campo ASSENTE (server precedente allo strato) NON si ricostruisce: la
// presentazione onesta e' «supervisione non verificabile», mai «senza
// supervisione» — l'assenza del dato non e' una lettura riuscita che ha
// dato none.

const NC_CONTROL_CODES = Object.freeze([
  'attested', 'none', 'reconnecting', 'expired', 'unqualified', 'unverifiable', 'inactive',
]);

const NC_CONTROL_LABELS = Object.freeze({
  it: Object.freeze({
    attested: 'controllo NC attestato',
    none: 'senza supervisione NC attestata',
    reconnecting: 'controllo NC in riconnessione',
    expired: 'controllo NC scaduto',
    unqualified: 'controllo NC non attestato',
    unverifiable: 'supervisione NC non verificabile',
    inactive: 'non attiva',
  }),
  en: Object.freeze({
    attested: 'NC control attested',
    none: 'no NC supervision attested',
    reconnecting: 'NC control reconnecting',
    expired: 'NC control expired',
    unqualified: 'NC control unattested',
    unverifiable: 'NC supervision unverifiable',
    inactive: 'not active',
  }),
  es: Object.freeze({
    attested: 'control NC acreditado',
    none: 'sin supervisión NC acreditada',
    reconnecting: 'control NC reconectando',
    expired: 'control NC caducado',
    unqualified: 'control NC no acreditado',
    unverifiable: 'supervisión NC no verificable',
    inactive: 'no activa',
  }),
});

function ncControlLabel(code, lang = 'it') {
  const dizionario = NC_CONTROL_LABELS[lang] || NC_CONTROL_LABELS.it;
  return dizionario[code] || dizionario.unverifiable;
}

// Normalizzazione lato client: un campo assente o di forma non riconosciuta
// resta «non verificabile» — MAI un none ricostruito dall'assenza.
function ncControlFromCell(cell) {
  if (!cell || typeof cell !== 'object') return 'unverifiable';
  return NC_CONTROL_CODES.includes(cell.ncControl) ? cell.ncControl : 'unverifiable';
}

module.exports = { NC_CONTROL_CODES, NC_CONTROL_LABELS, ncControlLabel, ncControlFromCell };
