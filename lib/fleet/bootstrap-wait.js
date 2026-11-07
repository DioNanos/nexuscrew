'use strict';
// Contratto unico dell'attesa di prontezza prima del primo prompt: default,
// minimo, massimo e regola di validazione. Vive qui e da qui lo prendono il
// payload del lancio, il validatore del supervisore e la consegna del prompt,
// cosi' non esistono quattro normalizzatori che divergono.
//
// NON coercitivo per scelta: una stringa numerica, un frazionario, un valore
// fuori range non vengono convertiti ne' corretti. Chi scrive (POST) riceve un
// rifiuto; chi legge un file legacy riceve il default con una causa esplicita;
// un payload fuori contratto viene rifiutato dal suo validatore, non aggiustato.

const DEFAULT_MS = 15000;
const MIN_MS = 1000;
const MAX_MS = 120000;

// valida(v) -> { ok: true, value } | { ok: false, motivo: 'tipo'|'non-intero'|'range' }
function valida(valore) {
  if (typeof valore !== 'number' || !Number.isFinite(valore)) return { ok: false, motivo: 'tipo' };
  if (!Number.isInteger(valore)) return { ok: false, motivo: 'non-intero' };
  if (valore < MIN_MS || valore > MAX_MS) return { ok: false, motivo: 'range' };
  return { ok: true, value: valore };
}

// normalizzaLegacy(v) -> { value, causa: null|'assente'|'invalido' }
// Serve SOLO alla lettura di un valore scritto prima del contratto (config
// legacy): assente e' il default senza avviso, invalido e' il default con una
// causa che il chiamante puo' diagnosticare. Il valore invalido non si stampa.
function normalizzaLegacy(valore) {
  if (valore === undefined || valore === null) return { value: DEFAULT_MS, causa: 'assente' };
  const esito = valida(valore);
  if (esito.ok) return { value: esito.value, causa: null };
  return { value: DEFAULT_MS, causa: 'invalido' };
}

module.exports = { DEFAULT_MS, MIN_MS, MAX_MS, valida, normalizzaLegacy };
