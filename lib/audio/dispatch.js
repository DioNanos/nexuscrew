'use strict';
// lib/audio/dispatch.js — instradamento lato ORIGINE verso un target esatto.
//
// Regole non negoziabili:
//   * il target e' un instanceId di nodo, esatto. Niente wildcard, niente "tutti",
//     niente broadcast: se il chiamante non sa chi deve parlare, non parla nessuno;
//   * la risoluzione avviene sulla topologia LIVE autorizzata di questo server
//     (peer diretti + peer instradati realmente noti), non su un nome fornito dal
//     chiamante e non su una cache arbitraria;
//   * l'inoltro riusa la route federata esistente, quindi passa da `canTransit`,
//     dalla whitelist delle risorse e da `controlledVisited`: la provenienza la
//     costruisce il server, il chiamante non puo' iniettarla;
//   * nessun esito ambiguo diventa un successo. Timeout, 5xx, corpo non
//     interpretabile e stati sconosciuti restano `unreachable` o `unknown`.
const { resolvePeer } = require('../nodes/inventory.js');

const DISPATCH_TIMEOUT_MS = 8000;
const PER_ENDPOINT_STATUS = new Set(['refused', 'unreachable', 'accepted', 'spoken', 'unknown']);
const INSTANCE_ID_RE = /^[a-f0-9]{32}$/i;

function createDispatcher(opts = {}) {
  const localNodeId = opts.localNodeId || (() => null);
  const peers = opts.peers || (async () => []);
  const localPort = opts.localPort || (() => 0);
  const localToken = opts.localToken || (() => '');
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DISPATCH_TIMEOUT_MS;

  function isLocal(target) {
    const self = localNodeId();
    return !!self && target === self;
  }

  // resolveRoute(): ritorna la catena di nomi peer verso il target, oppure il
  // motivo per cui non e' raggiungibile. Un target che non compare nella
  // topologia autorizzata NON e' un errore del chiamante da spiegare in
  // dettaglio: e' semplicemente irraggiungibile da qui.
  async function resolveRoute(target) {
    if (!INSTANCE_ID_RE.test(String(target || ''))) return { error: 'invalid-target' };
    let list;
    try { list = await peers(); } catch (_) { return { error: 'topology-unavailable' }; }
    if (!Array.isArray(list) || !list.length) return { error: 'unknown-target' };
    // Risoluzione per instanceId soltanto: risolvere per nome permetterebbe a un
    // chiamante di colpire un nodo diverso da quello che intendeva se due
    // installazioni condividono un'etichetta.
    const found = resolvePeer(list.filter((p) => p && (p.nodeId || p.instanceId)), String(target));
    if (found.error || !found.peer) return { error: 'unknown-target' };
    const route = Array.isArray(found.peer.route) ? found.peer.route.filter(Boolean) : [];
    if (!route.length) return { error: 'unknown-target' };
    return { route, peer: found.peer };
  }

  // forward(): POST interno verso la propria route federata. Usa il Bearer
  // locale perche' il destinatario del primo hop e' questo stesso server, che
  // poi applica peering, ACL e whitelist come per qualunque altro inoltro.
  async function forward(resource, route, body) {
    const port = localPort();
    const token = localToken();
    if (!port || !token) return { status: 'unreachable', reason: 'local-transport-unavailable' };
    const url = `http://127.0.0.1:${port}/api/route/${route.join('/')}/_${resource}`;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (_) {
      // Timeout o transport giu': mai un successo, mai uno stato inventato.
      return { status: 'unreachable', reason: 'transport' };
    }
    let payload = null;
    try { payload = await res.json(); } catch (_) { payload = null; }
    if (res.status === 403 || res.status === 404 || res.status === 409) {
      return { status: 'refused', reason: 'route-denied', httpStatus: res.status };
    }
    if (res.status >= 500) return { status: 'unreachable', reason: 'peer-error', httpStatus: res.status };
    if (!payload || typeof payload !== 'object' || !PER_ENDPOINT_STATUS.has(payload.status)) {
      // Il peer ha risposto qualcosa che non e' un esito per endpoint: non si
      // indovina. `unknown` e' esattamente questo caso.
      return { status: 'unknown', reason: 'unreadable-endpoint-result', httpStatus: res.status };
    }
    return {
      status: payload.status,
      ...(payload.reason ? { reason: String(payload.reason).slice(0, 64) } : {}),
      httpStatus: res.status,
    };
  }

  return {
    isLocal,
    resolveRoute,
    // dispatch(): unico ingresso per un target remoto.
    async dispatch({ resource, target, origin, payload }) {
      const resolved = await resolveRoute(target);
      if (resolved.error === 'invalid-target') return { status: 'refused', reason: 'invalid-target' };
      if (resolved.error) return { status: 'unreachable', reason: resolved.error };
      return forward(resource, resolved.route, {
        ...payload,
        target,
        // Attestazione della cella di origine. Il NODO di origine lo ricostruisce
        // il destinatario dalla catena `visited`; questo campo serve solo perche'
        // possa registrare *quale cella* quel nodo dichiara. La differenza fra
        // verificato e attestato viaggia fino al receipt.
        originCell: origin && origin.cell,
        originNode: origin && origin.node,
      });
    },
  };
}

module.exports = { createDispatcher, DISPATCH_TIMEOUT_MS, PER_ENDPOINT_STATUS };
