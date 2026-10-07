'use strict';
// lib/live-host/attest.js — verifica del riferimento Live dichiarato da un mittente.
//
// Il server MCP della Live dichiara il riferimento della propria thread; qui si
// decide se quella dichiarazione regge. Regge solo se il riferimento e' nel
// registro, appartiene alla cella ospite che sta mandando il messaggio e la
// thread e' viva adesso. Il risultato porta un motivo nominato, ma chi lo usa
// non rifiuta il messaggio: lo consegna senza etichetta.

const { REF_RE } = require('./registry.js');

const ALIVE = new Set(['present', 'active']);

function createLiveAttestation({ registry, bridge }) {
  async function verify({ ref, fromCell } = {}) {
    if (ref === undefined || ref === null || ref === '') return { ok: false, reason: 'no-ref' };
    if (typeof ref !== 'string' || !REF_RE.test(ref)) return { ok: false, reason: 'bad-ref' };
    const entry = registry.findByRef(ref);
    if (!entry) return { ok: false, reason: 'unknown-ref' };
    if (entry.cell !== fromCell) return { ok: false, reason: 'wrong-host' };
    // La tupla (cella, thread, riferimento) e' quella letta ADESSO: e' lei che
    // si attesta. Lo stato si chiede per quel thread, e dopo l'attesa il
    // registro si rilegge: se nel frattempo la Live e' stata ruotata, la
    // risposta non vale piu' per questo riferimento.
    const captured = { cell: entry.cell, threadId: entry.threadId };
    let status;
    try { status = await bridge.threadStatus(captured.cell, captured.threadId); } catch (_) { status = 'unknown'; }
    // Un thread non vivo non da mai l'etichetta (anche se il ponte lo ha appena tolto dal registro).
    if (!ALIVE.has(status)) return { ok: false, reason: 'thread-not-alive' };
    const now = registry.findByRef(ref);
    if (!now || now.cell !== captured.cell || now.threadId !== captured.threadId) {
      return { ok: false, reason: 'ref-changed' };
    }
    return { ok: true, hostCell: captured.cell };
  }
  return { verify };
}

module.exports = { createLiveAttestation };
