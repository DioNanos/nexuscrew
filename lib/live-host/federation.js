'use strict';
// lib/live-host/federation.js — client-side seam per la designazione remota.
//
// Un nodo CLIENT (la pagina e il ponte vivono qui, la cella designata no) deve
// poter LEGGERE lo stato del proprietario e INOLTRARE la risoluzione del ponte,
// senza che nessun chiamante scelga il target: il target e' il proprietario
// della designazione registrata, risolto sulla topologia autoritativa (stessa
// regola del dispatcher audio/notify). Nessun fallback locale: se il
// proprietario non e' raggiungibile l'esito e' nominato, non sostituito.
//
// Il transito usa la stessa via di tutti: /api/route/<route>/_<resource> col
// Bearer locale — il primo hop e' questo stesso server, che applica peering,
// gate liveHostAccess e prova di hop come per qualunque altro inoltro.
const { resolvePeer } = require('../nodes/inventory.js');

const INSTANCE_ID_RE = /^[a-f0-9]{32}$/i;
// Refusal names the owner may send back. The caller must not relabel "not
// granted" as "unreachable": a refusal is a decision, an unreachable peer is a
// failure. Anything outside this list stays unnamed, not guessed.
const NAMED_PEER_REASONS = new Set(['live-host-not-granted', 'live-host-expectation-mismatch']);
// Name THIS node's own proxy gives to "I could not reach the peer": from here it
// means the owner is unreachable, not that the owner refused.
const PEER_UNREACHABLE = 'federation-peer-unreachable';
const FED_TIMEOUT_MS = 8000;

function createLiveHostFederation({
  localNodeId = () => null,
  peers = async () => [],
  localPort = () => 0,
  localToken = () => '',
  fetchImpl = fetch,
  timeoutMs = FED_TIMEOUT_MS,
} = {}) {
  async function resolveRoute(target) {
    if (!INSTANCE_ID_RE.test(String(target || ''))) return { error: 'invalid-target' };
    let list;
    try { list = await peers(); } catch (_) { return { error: 'topology-unavailable' }; }
    if (!Array.isArray(list) || !list.length) return { error: 'unknown-target' };
    const found = resolvePeer(list.filter((p) => p && (p.nodeId || p.instanceId)), String(target));
    if (found.error || !found.peer) return { error: 'unknown-target' };
    const route = Array.isArray(found.peer.route) ? found.peer.route.filter(Boolean) : [];
    if (!route.length) return { error: 'unknown-target' };
    return { route, peer: found.peer };
  }

  function ownerRoute(target) {
    return resolveRoute(target).then((r) => (r.route ? r.route : null)).catch(() => null);
  }

  async function forward(target, resource, method, body) {
    const resolved = await resolveRoute(target);
    if (resolved.error) return { ok: false, reason: resolved.error === 'invalid-target' ? 'invalid-target' : 'live-host-owner-unreachable' };
    const port = localPort();
    const token = localToken();
    if (!port || !token) return { ok: false, reason: 'live-host-owner-unreachable' };
    const url = `http://127.0.0.1:${port}/api/route/${resolved.route.join('/')}/_${resource}`;
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (_) {
      return { ok: false, reason: 'live-host-owner-unreachable' };
    }
    let payload = null;
    try { payload = await res.json(); } catch (_) { payload = null; }
    const named = payload && NAMED_PEER_REASONS.has(payload.reason) ? payload.reason : null;
    const ok = res.status >= 200 && res.status < 300;
    // A refusal we can name stays the owner's own word for it; our own proxy's
    // "peer unreachable" means the owner is unreachable; anything else the owner
    // answers with comes back under OUR generic name plus the status we saw — a
    // peer string is never passed on as if we had checked it.
    const reason = ok ? null
      : (payload && payload.reason === PEER_UNREACHABLE ? 'live-host-owner-unreachable'
        : (named || 'live-host-owner-rejected'));
    return { ok, status: res.status, body: payload, route: resolved.route, ...(reason ? { reason } : {}) };
  }

  // Stato del proprietario per la GET locale (threadStatus/eligible/lease).
  function getOwnerState({ ownerId } = {}) {
    return forward(ownerId, '/live-host', 'GET');
  }

  // Inoltro della risoluzione del ponte. Il body e' SOLO `{expect}` (unico
  // campo ammesso dal percorso federato): coincide con la designazione
  // registrata localmente, quindi il chiamante non sceglie nulla.
  function bridgeForward({ ownerId, expect } = {}) {
    return forward(ownerId, '/live-host/bridge', 'POST', { expect });
  }

  return { getOwnerState, bridgeForward, ownerRoute };
}

module.exports = { createLiveHostFederation };
