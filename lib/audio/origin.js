'use strict';
// lib/audio/origin.js — risoluzione dell'ORIGINE di una richiesta audio.
//
// L'origine non e' un campo del body: e' il risultato di una verifica. Esistono
// esattamente due modi legittimi di presentarsi, e nient'altro e' accettato.
//
//   1. locale via bridge MCP — la richiesta porta la firma HMAC del segreto di
//      bridge (lib/audio/bridge-auth.js) e dichiara una sessione tmux che deve
//      risultare una cella Fleet ATTIVA in questo momento. Lo stato Fleet e'
//      asincrono: va atteso, non letto da un oggetto che sembra sincrono.
//      Origine = { node: nodeId locale, cell: id logico della cella }.
//
//   2. federata — la richiesta e' l'ultimo hop di una route federata, provato
//      dall'header di hop firmato dal segreto per-processo (lib/proxy/hop-proof)
//      piu' la catena `visited` che il proxy costruisce lato server. Origine
//      node = `visited[0]`, cioe' il nodo che ha aperto la catena, MAI un campo
//      del body.
//
// Confine dichiarato, non nascosto: il nodo di origine e' verificato end-to-end
// (catena visited legata ai token di peering); la CELLA di origine remota e'
// invece *attestata* dal nodo di origine, che l'ha verificata localmente col
// bridge. Un proprietario di nodo puo' mentire su quale delle proprie celle ha
// parlato. Questo limite e' inerente al modello di fiducia fra nodi e va
// registrato come tale, non spacciato per autenticazione.
//
// Il Bearer — della UI o di federation — non concorre MAI a stabilire l'origine.
const { verifyRequest, SESSION_HEADER } = require('./bridge-auth.js');
const { verifyHop, HOP_HEADER } = require('../proxy/hop-proof.js');

const NODE_ID_RE = /^[a-f0-9]{16,64}$/;
const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;

function validNode(v) { return typeof v === 'string' && NODE_ID_RE.test(v); }
function validCell(v) { return typeof v === 'string' && CELL_ID_RE.test(v); }

// Catena visited gia' costruita dal server (controlledVisited). Qui si verifica
// solo la forma e la coerenza con il nodo locale: la prova di provenienza e'
// l'header di hop, non questa stringa.
function parseVisitedChain(raw, localNodeId) {
  const ids = String(raw || '').split(',').filter(Boolean);
  if (!ids.length || ids.length > 8) return null;
  if (ids.some((id) => !validNode(id))) return null;
  if (new Set(ids).size !== ids.length) return null;
  if (ids.at(-1) !== localNodeId) return null;
  return ids;
}

// createOriginResolver(): deps esplicite, nessun accesso globale.
//   localNodeId()  -> string|null   nodeId REALE del nodo (dal node store)
//   activeCells()  -> Promise<[{cell, tmuxSession, active}]>  stato Fleet atteso
//   bridgeSecret() -> string|null   segreto del bridge (file 0600)
//   hopSecret()    -> Buffer|null   segreto per-processo della prova di hop
function createOriginResolver(deps = {}) {
  const localNodeId = deps.localNodeId || (() => null);
  const activeCells = deps.activeCells || (async () => []);
  const bridgeSecret = deps.bridgeSecret || (() => null);
  const hopSecret = deps.hopSecret || (() => null);
  const nonceCache = deps.nonceCache || null;
  const now = deps.now || Date.now;

  async function resolve(req) {
    const self = localNodeId();
    // Senza identita' di nodo non si puo' ne' attribuire ne' verificare nulla:
    // fail-closed invece di inventare un nodeId vuoto.
    if (!validNode(self)) return { ok: false, reason: 'no-node-identity' };

    const headers = req.headers || {};
    const hopProof = headers[HOP_HEADER];
    if (hopProof) {
      const visited = parseVisitedChain(headers['x-nexuscrew-visited'], self);
      if (!visited) return { ok: false, reason: 'bad-visited' };
      const okHop = verifyHop(hopSecret(), {
        method: req.method, path: req.originalUrl || req.url, visited,
      }, hopProof);
      if (!okHop) return { ok: false, reason: 'bad-hop' };
      const originNode = visited[0];
      // Un hop la cui catena inizia col nodo locale non e' un inbound federato:
      // e' un giro su se stessi, e l'origine locale ha il suo percorso.
      if (originNode === self) return { ok: false, reason: 'self-hop' };
      const body = req.body || {};
      const attested = body.originCell;
      if (!validCell(attested)) return { ok: false, reason: 'bad-attested-cell' };
      // Coerenza: se il body dichiara anche un nodo, deve combaciare con la
      // catena controllata dal server. In caso di conflitto vince visited e la
      // richiesta viene rifiutata, non "corretta" in silenzio.
      if (body.originNode !== undefined && body.originNode !== originNode) {
        return { ok: false, reason: 'origin-mismatch' };
      }
      return { ok: true, origin: { node: originNode, cell: attested }, trust: 'federated', visited };
    }

    // Percorso locale: serve la firma del bridge. Nessun fallback sul body.
    const verified = verifyRequest({
      secret: bridgeSecret(),
      method: req.method,
      path: req.originalUrl || req.url,
      headers,
      rawBody: req.rawBody,
      nonceCache,
      now,
    });
    if (!verified.ok) return { ok: false, reason: verified.reason };
    const session = headers[SESSION_HEADER];
    let cells;
    try {
      cells = await activeCells();
    } catch (_) {
      return { ok: false, reason: 'fleet-unavailable' };
    }
    if (!Array.isArray(cells)) return { ok: false, reason: 'fleet-unavailable' };
    const match = cells.find((c) => c && c.tmuxSession === session && c.active === true);
    if (!match || !validCell(match.cell)) return { ok: false, reason: 'cell-not-active' };
    return { ok: true, origin: { node: self, cell: match.cell }, trust: 'local-bridge' };
  }

  return { resolve };
}

module.exports = { createOriginResolver, parseVisitedChain, NODE_ID_RE, CELL_ID_RE };
