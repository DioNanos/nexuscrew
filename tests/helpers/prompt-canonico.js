'use strict';
// Fixture per i test che osservano l'esito della consegna dal percorso
// canonico (0.9.80, strato 2c). Il supervisore finto fa quel che farebbe il
// vero: scrive il record canonico nella directory del canale del PAYLOAD
// (`payload.promptOutcome`) e attesta la generazione ammessa. Nessun marcatore
// volatile, nessun tmux reale.
const { canonicalOutcome, VERSIONE_RECORD_PROMPT, EVENTO_RECORD_PROMPT } = require('../../lib/fleet/prompt-outcome.js');
const { scriviRecordPrompt } = require('../../lib/files/activity.js');

// Converte il valore storico del marcatore («stato[:notReady]») nell'input
// chiuso della tabella canonica, poi nel terminale canonico.
function canonicoDaMarcatore(valore) {
  const testo = String(valore || '').trim();
  if (!testo) return null;
  const i = testo.indexOf(':');
  const state = i === -1 ? testo : testo.slice(0, i);
  const notReady = i === -1 ? '' : testo.slice(i + 1);
  return canonicalOutcome({ state, notReady });
}

// Scrive il terminale canonico del lancio del payload alla generazione data.
function scriviCanonico(payload, valore, { generation = 0, ts = Date.now() } = {}) {
  const canale = payload && payload.promptOutcome;
  const canonico = typeof valore === 'object' && valore ? valore : canonicoDaMarcatore(valore);
  if (!canale || !canonico) return false;
  return scriviRecordPrompt(canale.dir, {
    version: VERSIONE_RECORD_PROMPT, event: EVENTO_RECORD_PROMPT,
    launchId: canale.launchId, generation, ts, ...canonico,
  });
}

// Rende «vivo» e attestante un leaseManager (reale o finto): lo stesso oggetto
// che il runtime ha gia' in mano, solo con le tre letture della consultazione.
function attestaProprietario(leaseManager, getPayload, { generation = 0, applicable = true, mcp } = {}) {
  leaseManager.status = () => ({ state: 'live', leaseId: 'f'.repeat(16), generation });
  leaseManager.readPromptSnapshot = async () => {
    const p = getPayload();
    if (!p || !p.promptOutcome) return { ok: false, reason: 'no-lease' };
    return {
      ok: true, launchId: p.promptOutcome.launchId, applicable, generation,
      ...(mcp ? { mcp } : {}), epoch: 1, leaseId: 'f'.repeat(16),
    };
  };
  leaseManager.promptSnapshotBinding = () => true;
  // Nessun canale di controllo dello stop in questi mondi (i test del down
  // restano quelli di sempre): solo la consultazione del fence e' attiva.
  leaseManager.armControl = () => false;
  return leaseManager;
}

// Attesa BOUNDED su una funzione che ritorna un valore o null.
async function finche(fn, { timeoutMs = 2000, passoMs = 10 } = {}) {
  const fine = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > fine) return v;
    await new Promise((r) => setTimeout(r, passoMs));
  }
}

module.exports = { canonicoDaMarcatore, scriviCanonico, attestaProprietario, finche };
