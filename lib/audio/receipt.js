'use strict';
// lib/audio/receipt.js — receipt degli enunciati, bounded e ridotto all'osso.
//
// Scope del chiamante = NODO + CELLA. Non la sola cella: due nodi possono avere
// celle omonime (`Alpha` esiste su piu' installazioni), e una chiave basata solo
// sul nome permetterebbe a un nodo di leggere o sovrascrivere i receipt di una
// cella altrui con lo stesso nome. La chiave e' costruita qui, dal server, mai
// accettata dal client.
//
// Cosa NON entra mai in un receipt: testo, lingua, voce, path, credenziali,
// header. L'attribuzione e' {utteranceId, origin{node,cell}, target, stato,
// reason, timestamp} e nient'altro. `attested` distingue una cella verificata
// localmente dal bridge da una dichiarata da un altro nodo: la differenza e' di
// sicurezza e non va persa per strada.
//
// Nessun booleano aggregato di successo: chi legge deve guardare lo stato per
// endpoint, altrimenti "vero" finirebbe per significare "ho provato".
const crypto = require('node:crypto');

const STATUS = Object.freeze(['refused', 'unreachable', 'accepted', 'spoken', 'unknown']);
const CAP = 512;
const TTL_MS = 24 * 60 * 60 * 1000;

// Chiave di scope: il separatore e' uno spazio, non rappresentabile in un nodeId
// (hex) ne' in un nome cella ([A-Za-z0-9._-]), quindi non e' ambigua.
function callerKey(origin) {
  if (!origin || typeof origin !== 'object') return null;
  const node = typeof origin.node === 'string' ? origin.node : '';
  const cell = typeof origin.cell === 'string' ? origin.cell : '';
  if (!node || !cell) return null;
  return `${node} ${cell}`;
}

function createReceiptStore({ now = Date.now } = {}) {
  const byId = new Map();

  const expired = (e, t) => t - e.timestamp > TTL_MS;

  function cleanup(t) {
    for (const [id, e] of byId) if (expired(e, t)) byId.delete(id);
  }

  function redact(e) {
    return {
      utteranceId: e.utteranceId,
      origin: { node: e.origin.node, cell: e.origin.cell, attested: e.attested === true },
      target: e.target,
      status: e.status,
      timestamp: e.timestamp,
      ...(e.reason ? { reason: e.reason } : {}),
    };
  }

  // find(): sonda di idempotenza. Non muta. `collision` segnala che lo stesso
  // utteranceId appartiene a un altro chiamante o a un altro target: fail-closed,
  // perche' riusare l'id di un altro sarebbe un modo per leggerne il receipt.
  function find(utteranceId, origin, target) {
    if (typeof utteranceId !== 'string' || !utteranceId) return null;
    const key = callerKey(origin);
    const e = byId.get(utteranceId);
    if (!e) return null;
    if (expired(e, now())) { byId.delete(utteranceId); return null; }
    if (!key || e.caller !== key || e.target !== target) return 'collision';
    return redact(e);
  }

  function record(opts) {
    if (!opts || typeof opts !== 'object') throw new Error('record: opts mancante');
    const key = callerKey(opts.origin);
    if (!key) throw new Error('record: origin {node,cell} mancante');
    if (typeof opts.target !== 'string' || !opts.target) throw new Error('record: target mancante');
    if (!STATUS.includes(opts.status)) throw new Error(`status non valida (enum: ${STATUS.join('|')})`);
    const t = now();
    cleanup(t);
    const provided = typeof opts.utteranceId === 'string' && opts.utteranceId ? opts.utteranceId : null;
    if (provided) {
      const existing = byId.get(provided);
      if (existing && !expired(existing, t)) {
        if (existing.caller === key && existing.target === opts.target) return redact(existing);
        throw new Error('utteranceId collision (diverso caller/target)');
      }
    }
    const utteranceId = provided || crypto.randomUUID();
    const entry = {
      utteranceId,
      caller: key,
      origin: { node: opts.origin.node, cell: opts.origin.cell },
      attested: opts.attested === true,
      target: opts.target,
      status: opts.status,
      ...(opts.reason ? { reason: String(opts.reason).slice(0, 64) } : {}),
      timestamp: t,
    };
    byId.set(utteranceId, entry);
    if (byId.size > CAP) {
      const sorted = [...byId.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      for (let i = 0; i < byId.size - CAP; i += 1) byId.delete(sorted[i][0]);
    }
    return redact(entry);
  }

  // update(): transizione di stato di un enunciato gia' registrato (accepted ->
  // spoken/refused/unknown quando la coda locale conclude). Non crea receipt
  // nuovi e non cambia mai origine o target: solo lo stato puo' evolvere.
  function update(utteranceId, status, reason) {
    if (!STATUS.includes(status)) throw new Error('status non valida');
    const e = byId.get(utteranceId);
    if (!e) return null;
    if (expired(e, now())) { byId.delete(utteranceId); return null; }
    e.status = status;
    if (reason) e.reason = String(reason).slice(0, 64);
    else delete e.reason;
    return redact(e);
  }

  // get(): lettura scoped. Solo lo stesso nodo+cella vede il proprio receipt;
  // per chiunque altro l'enunciato semplicemente non esiste.
  function get(origin, utteranceId) {
    const key = callerKey(origin);
    const e = byId.get(utteranceId);
    if (!key || !e) return null;
    if (expired(e, now())) { byId.delete(utteranceId); return null; }
    if (e.caller !== key) return null;
    return redact(e);
  }

  function list(origin) {
    const key = callerKey(origin);
    if (!key) return [];
    const t = now();
    const out = [];
    for (const [, e] of byId) if (!expired(e, t) && e.caller === key) out.push(redact(e));
    return out;
  }

  function count() {
    const t = now();
    let c = 0;
    for (const [, e] of byId) if (!expired(e, t)) c += 1;
    return c;
  }

  return { record, update, find, get, list, count, STATUS };
}

module.exports = { createReceiptStore, callerKey, STATUS, CAP, TTL_MS };
