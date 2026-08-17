'use strict';
// lib/nodes/peer-transitions.js — registra SOLO le transizioni di stato dei
// peer sul registro diagnostico GIA' esistente (lib/diagnostics/store.js):
// nessun nuovo store, nessun flusso nuovo, nessun polling in piu'. La salute
// federata (lib/nodes/health.js) viene gia' sondata a ogni richiesta della UI
// (/api/nodes, /api/peers) e il risultato veniva buttato via.
//
// Misurato il 2026-08-07: un nodo giu' per 25 minuti produceva ZERO record
// (nextSeq: 1, retained: 0). Senza storia delle transizioni, quando qualcosa
// cade non si puo' sapere QUANDO e' caduto ne' QUANTE VOLTE.
//
// TUNNEL e SERVIZIO restano DUE FATTI DISTINTI, mai un booleano «online»: il
// caso reale che ha fatto perdere quattro ore era tunnel su + servizio giu'
// (ECONNRESET, listener vivo ma NexusCrew morto sul dispositivo) contro
// nessun listener affatto (ECONNREFUSED) — due guasti, due rimedi diversi,
// e un valore unico li avrebbe fatti cercare nel posto sbagliato.
//
// SOLO SULLA TRANSIZIONE: un peer stabile per N sonde produce ZERO record,
// indipendentemente da quante volte viene sondato. Scrivere a ogni sonda
// trasformerebbe il registro in rumore e la storia si perderebbe nel volume
// — peggio di oggi, perche' sembrerebbe di avere i dati.
//
// warn, non info: il registro diagnostico scarta 'info'/'debug' quando il
// verbose non e' acceso (lib/diagnostics/store.js) — e il verbose non si puo'
// accendere retroattivamente su un incidente gia' successo. Una transizione
// di peer deve restare visibile anche senza averlo previsto in anticipo, sia
// che vada verso un guasto sia che torni a posto: solo cosi' si puo'
// ricostruire QUANDO e' caduto e QUANDO e' tornato, per contare gli episodi.
const last = new Map(); // nodeName -> { tunnel, service }

function tunnelStateOf(health) {
  return health && typeof health.transport === 'string' ? health.transport : 'unknown';
}

// Il servizio si valuta SOLO quando il tunnel e' su: senza trasporto, auth e
// reachability restano 'unknown' per costruzione (probeHealth non li tocca
// nel ramo down, vedi lib/proxy/federation.js) — dichiarare qui un servizio
// "giu'" sarebbe un secondo guasto INVENTATO, non misurato: il tunnel giu'
// spiega gia' da solo perche' il servizio non e' raggiungibile.
function serviceStateOf(health) {
  if (!health || health.transport !== 'up') return 'unknown';
  if (health.auth === 'ok' && health.reachability === 'ok') return 'ok';
  if (health.auth === 'failed') return 'auth-failed';
  if (health.reachability === 'failed') return 'unreachable';
  return 'unknown';
}

// nodeName: chiave stabile del peer (node.name in lib/nodes/store.js).
// health: l'oggetto {transport, auth, reachability, ...} gia' calcolato da
// lib/nodes/health.js — questa funzione non sonda nulla, consuma soltanto.
// diagnostics: {record(level, component, code, message, meta)} — vedi
// lib/diagnostics/store.js. Chiamata ripetutamente con lo stesso stato: dopo
// la prima volta, silenzio.
function recordPeerTransition(nodeName, health, diagnostics) {
  if (!nodeName || !diagnostics || typeof diagnostics.record !== 'function') return;
  const tunnel = tunnelStateOf(health);
  const service = serviceStateOf(health);
  const previous = last.get(nodeName);
  last.set(nodeName, { tunnel, service });
  if (!previous) return; // primo probe di questo peer: nessuna "transizione" da niente.

  const tunnelChanged = previous.tunnel !== tunnel;
  if (tunnelChanged) {
    diagnostics.record('warn', 'peer-health', 'TUNNEL_TRANSITION',
      `${nodeName}: tunnel ${previous.tunnel} -> ${tunnel}`,
      { node: nodeName, state: tunnel });
  }
  // Testabile solo quando il tunnel e' su ORA: se e' appena caduto, il
  // servizio e' passato a 'unknown' come artefatto del tunnel (gia' segnalato
  // sopra), non come un fatto nuovo — quindi qui non si scrive nulla.
  if (tunnel === 'up' && previous.service !== service) {
    diagnostics.record('warn', 'peer-health', 'SERVICE_TRANSITION',
      `${nodeName}: service ${previous.service} -> ${service}`,
      { node: nodeName, state: service });
  }
}

// Per i test: azzera la memoria delle transizioni fra un caso e l'altro.
function clearPeerTransitions() { last.clear(); }

module.exports = { recordPeerTransition, clearPeerTransitions, tunnelStateOf, serviceStateOf };
