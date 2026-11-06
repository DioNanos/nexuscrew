'use strict';

// Consultazione di sola lettura del fence del proprietario (0.9.80, strato 2c).
//
// Il daemon chiede al supervisore, sul canale lease gia' autenticato, UNA
// fotografia della consegna del prompt di quel lancio: launchId immutabile del
// payload, applicabilita' della consegna e ULTIMA generazione effettivamente
// ammessa dal suo fence. La richiesta porta un nonce che il daemon lega a
// owner locale, cella, entry e connessione corrente: una risposta che non torna
// con tutte e quattro e' scartata.
//
// Modulo puro: nessun fs, nessun require di moduli della flotta. Schema chiuso
// e versionato; ogni forma ostile e' rifiutata senza copiarne il testo.

const SNAPSHOT_VERSION = 1;
const NONCE_RE = /^[a-f0-9]{16,64}$/;
const LAUNCH_ID_RE = /^[a-f0-9]{16}$/;
const MCP_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MCP_MAX_NAMES = 16;
const MCP_STATES = new Set(['ready', 'degraded']);

function chiaviEsatte(obj, richieste, facoltative = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (!richieste.every((k) => Object.hasOwn(obj, k))) return false;
  const ammesse = new Set([...richieste, ...facoltative]);
  return keys.every((k) => ammesse.has(k));
}

function validNonce(nonce) {
  return typeof nonce === 'string' && NONCE_RE.test(nonce);
}

function validRequest(msg) {
  return chiaviEsatte(msg, ['type', 'v', 'nonce'])
    && msg.type === 'promptSnapshot' && msg.v === SNAPSHOT_VERSION && validNonce(msg.nonce);
}

function listaNomiValida(lista) {
  return Array.isArray(lista) && lista.length <= MCP_MAX_NAMES
    && lista.every((n) => typeof n === 'string' && MCP_NAME_RE.test(n));
}

// Osservazione MCP accessoria: GIA' osservata dal supervisore per la stessa
// tupla, in memoria. Non e' un campo del record e non promuove il prompt.
function validMcp(mcp) {
  return chiaviEsatte(mcp, ['state', 'failed', 'pending'])
    && MCP_STATES.has(mcp.state) && listaNomiValida(mcp.failed) && listaNomiValida(mcp.pending);
}

// Forma canonica della risposta del supervisore. `generation` e' null finche'
// nessuna generazione e' stata ammessa: la 0 non si presenta come ammessa.
function validResult(msg) {
  if (!chiaviEsatte(msg, ['type', 'v', 'nonce', 'launchId', 'applicable', 'generation'], ['mcp'])) return false;
  if (msg.type !== 'promptSnapshotResult' || msg.v !== SNAPSHOT_VERSION || !validNonce(msg.nonce)) return false;
  if (typeof msg.launchId !== 'string' || !LAUNCH_ID_RE.test(msg.launchId)) return false;
  if (typeof msg.applicable !== 'boolean') return false;
  if (!(msg.generation === null || (Number.isSafeInteger(msg.generation) && msg.generation >= 0))) return false;
  if (Object.hasOwn(msg, 'mcp') && !validMcp(msg.mcp)) return false;
  return true;
}

// Dal lato del supervisore: compone la risposta da una fotografia sincrona
// del proprio stato. Ritorna null se la fotografia non e' una forma valida.
function buildResult(nonce, snap) {
  if (!snap || typeof snap !== 'object') return null;
  const out = {
    type: 'promptSnapshotResult', v: SNAPSHOT_VERSION, nonce,
    launchId: snap.launchId, applicable: snap.applicable === true,
    generation: Number.isSafeInteger(snap.generation) && snap.generation >= 0 ? snap.generation : null,
  };
  if (snap.mcp !== undefined && snap.mcp !== null) {
    if (!validMcp(snap.mcp)) return null;
    out.mcp = { state: snap.mcp.state, failed: [...snap.mcp.failed], pending: [...snap.mcp.pending] };
  }
  return validResult(out) ? out : null;
}

module.exports = {
  SNAPSHOT_VERSION, MCP_MAX_NAMES, validNonce, validRequest, validResult, validMcp, buildResult,
};
