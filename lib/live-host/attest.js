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
    let status;
    try { status = await bridge.threadStatus(entry.cell); } catch (_) { status = 'unknown'; }
    if (!ALIVE.has(status)) return { ok: false, reason: 'thread-not-alive' };
    return { ok: true, hostCell: entry.cell };
  }
  return { verify };
}

module.exports = { createLiveAttestation };
