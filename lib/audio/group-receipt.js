'use strict';
// lib/audio/group-receipt.js — receipt bounded di un gruppo Audio Share.
//
// Il receipt resta dell'origine nodo+cella e conserva SOLO la mappa endpoint
// redatta. Non contiene testo, lingua, voce, route, path o un booleano di
// successo aggregato: un gruppo puo' avere un endpoint spoken e un altro
// unreachable senza che un `ok:true` nasconda il dettaglio.
const crypto = require('node:crypto');
const { callerKey, STATUS, CAP, TTL_MS } = require('./receipt.js');

function createGroupReceiptStore({ now = Date.now } = {}) {
  const byId = new Map();
  const expired = (entry, at) => at - entry.timestamp > TTL_MS;
  const cleanup = (at) => {
    for (const [id, entry] of byId) if (expired(entry, at)) byId.delete(id);
  };
  const redact = (entry) => ({
    utteranceId: entry.utteranceId,
    origin: { node: entry.origin.node, cell: entry.origin.cell },
    group: entry.group,
    mode: entry.mode,
    timestamp: entry.timestamp,
    endpoints: entry.endpoints.map((endpoint) => ({
      target: endpoint.target,
      status: endpoint.status,
      ...(endpoint.reason ? { reason: endpoint.reason } : {}),
    })),
  });
  const find = (origin, utteranceId) => {
    const key = callerKey(origin);
    const entry = byId.get(utteranceId);
    if (!key || !entry) return null;
    if (expired(entry, now())) { byId.delete(utteranceId); return null; }
    return entry.caller === key ? entry : null;
  };

  function begin({ origin, group, mode, targets, utteranceId } = {}) {
    const caller = callerKey(origin);
    if (!caller) throw new Error('group receipt: origin mancante');
    if (typeof group !== 'string' || !group) throw new Error('group receipt: gruppo mancante');
    if (!Array.isArray(targets) || !targets.length) throw new Error('group receipt: target mancanti');
    const id = typeof utteranceId === 'string' && utteranceId ? utteranceId : crypto.randomUUID();
    const existing = byId.get(id);
    if (existing && !expired(existing, now())) {
      const same = existing.caller === caller && existing.group === group && existing.mode === mode
        && existing.endpoints.map((endpoint) => endpoint.target).join(',') === targets.join(',');
      if (!same) throw new Error('utteranceId collision');
      return { created: false, receipt: redact(existing) };
    }
    const timestamp = now();
    cleanup(timestamp);
    const entry = {
      utteranceId: id, caller, origin: { node: origin.node, cell: origin.cell }, group, mode,
      timestamp,
      endpoints: targets.map((target) => ({ target, status: 'unknown', reason: 'not-attempted', admitted: false })),
    };
    byId.set(id, entry);
    if (byId.size > CAP) {
      const oldest = [...byId.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      while (byId.size > CAP && oldest.length) byId.delete(oldest.shift()[0]);
    }
    return { created: true, receipt: redact(entry) };
  }

  function update(origin, utteranceId, target, status, reason, admitted = false) {
    if (!STATUS.includes(status)) throw new Error('group receipt: status non valida');
    const entry = find(origin, utteranceId);
    if (!entry) return null;
    // Uno Stop locale prevale sull'orchestratore asincrono: un completamento
    // tardivo non puo' riaprire un endpoint gia' cancellato e farlo parlare.
    if (entry.stopped === true) return redact(entry);
    const endpoint = entry.endpoints.find((value) => value.target === target);
    if (!endpoint) return null;
    endpoint.status = status;
    endpoint.admitted = endpoint.admitted || admitted === true;
    if (reason) endpoint.reason = String(reason).slice(0, 64);
    else delete endpoint.reason;
    return redact(entry);
  }

  function get(origin, utteranceId) {
    const entry = find(origin, utteranceId);
    return entry ? redact(entry) : null;
  }

  function admittedTargets(origin, utteranceId) {
    const entry = find(origin, utteranceId);
    return entry ? entry.endpoints.filter((endpoint) => endpoint.admitted).map((endpoint) => endpoint.target) : [];
  }

  // Segna la richiesta di stop prima di contattare gli endpoint. Gli endpoint
  // non ancora tentati diventano `refused/stopped`; quelli gia' ammessi
  // conservano l'ultimo stato noto, perche' un POST remoto accettato non prova
  // ancora che la voce sia gia' cessata. La coda locale e il suo stop sovrano
  // restano l'autorita' finale su quel dettaglio.
  function stop(origin, utteranceId) {
    const entry = find(origin, utteranceId);
    if (!entry) return null;
    entry.stopped = true;
    for (const endpoint of entry.endpoints) {
      if (!endpoint.admitted && endpoint.status === 'unknown' && endpoint.reason === 'not-attempted') {
        endpoint.status = 'refused'; endpoint.reason = 'stopped';
      }
    }
    return redact(entry);
  }

  function isStopped(origin, utteranceId) {
    const entry = find(origin, utteranceId);
    return !!(entry && entry.stopped === true);
  }

  return {
    begin, update, get, admittedTargets, stop, isStopped,
    count: () => { cleanup(now()); return byId.size; },
  };
}

module.exports = { createGroupReceiptStore };
