'use strict';
// lib/cells/scope.js — quali celle di QUESTO nodo un peer federato puo' vedere.
//
// Gemello di lib/audio/acl.js, e per le stesse ragioni:
//   * la sorgente della decisione e' il node store locale, mai il corpo della
//     richiesta. Un peer non dichiara il proprio scope: lo subisce.
//   * l'identita' arriva dalla catena `visited` che costruisce il server
//     (controlledVisited), non da un campo dichiarato.
//
// Due invarianti che una versione semplificata romperebbe in silenzio:
//
//   1. In multi-hop lo scope e' l'INTERSEZIONE fra chi consegna e chi origina.
//      `canTransit` autorizza il transito, non l'accesso: un peer B puo'
//      instradare una richiesta di C. Guardare solo B lascerebbe C ereditare i
//      permessi di B. lib/audio/acl.js risolve lo stesso caso controllando
//      entrambi, e qui va replicato invece che semplificato.
//   2. Una sessione tmux e' concessa solo se lo e' la CELLA a cui appartiene, e
//      una sessione che non appartiene a nessuna cella non e' "libera": e'
//      fuori scope. Altrimenti basterebbe una tmux creata a mano per aggirare
//      il permesso — e `/ws` attacca proprio per nome di sessione.
//
// Il permesso e' indicizzato per `nodeId`, non per `name`: il name e' uno slug
// locale rinominabile, il nodeId e' l'identita' stabile provata dal pairing.
const nodesStore = require('../nodes/store.js');

// Scope di un singolo nodo, normalizzato. `all` non elenca nulla di proposito:
// una lista che significa "tutte" invecchierebbe a ogni cella nuova.
function scopeOf(node) {
  if (!node) return { mode: 'none', cells: new Set() };
  const mode = node.cellVisibility || 'all';
  if (mode === 'all') return { mode: 'all', cells: null };
  if (mode === 'none') return { mode: 'none', cells: new Set() };
  return { mode: 'selected', cells: new Set(Array.isArray(node.cells) ? node.cells : []) };
}

// Intersezione di due scope. `all` e' l'elemento neutro; `none` assorbe.
function intersect(a, b) {
  if (a.mode === 'none' || b.mode === 'none') return { mode: 'none', cells: new Set() };
  if (a.mode === 'all') return b;
  if (b.mode === 'all') return a;
  return { mode: 'selected', cells: new Set([...a.cells].filter((c) => b.cells.has(c))) };
}

function findByNodeId(st, nodeId) {
  if (!st || !Array.isArray(st.nodes) || !nodeId) return null;
  return st.nodes.find((n) => n && n.nodeId === nodeId) || null;
}

// createCellScope(): deps esplicite, nessun accesso globale.
//   nodesPath       percorso del node store
//   loadStoreImpl   iniettabile nei test
//   cellForSession  mappa tmuxSession -> id cella (null se non e' di una cella)
function createCellScope({ nodesPath, loadStoreImpl = nodesStore.loadStore, cellForSession = () => null } = {}) {
  // Scope "tutto", usato dal percorso locale: il proprietario della macchina
  // non si limita da solo, e questo modulo non e' il posto dove decidere
  // altrimenti.
  function openScope() {
    return buildApi({ mode: 'all', cells: null });
  }

  function buildApi(resolved, localNodeId = null) {
    const allowsCell = (cell) => {
      if (resolved.mode === 'all') return true;
      if (resolved.mode === 'none') return false;
      return typeof cell === 'string' && resolved.cells.has(cell);
    };
    const allowsSession = (session) => {
      if (resolved.mode === 'all') return true;
      const cell = cellForSession(session);
      // Nessuna cella dietro la sessione => fuori scope. Vedi invariante 2.
      if (!cell) return false;
      return allowsCell(cell);
    };
    // Un tile di deck che punta a un ALTRO nodo non e' una cella di questo
    // hub: lo scope celle governa le celle locali, e la topologia ha gia' le
    // sue regole (canTransit, allowlist federata). Quando pero' non sappiamo
    // chi siamo, un `ownerId` non confrontabile si tratta come LOCALE: e' il
    // verso fail-closed, perche' l'errore costa un tile in meno invece di un
    // nome di cella in piu'.
    const tileIsRemote = (tile) => {
      if (!tile || typeof tile !== 'object') return false;
      if (typeof tile.node === 'string' && tile.node) return true;
      if (typeof tile.ownerId === 'string' && tile.ownerId) {
        return localNodeId ? tile.ownerId !== localNodeId : false;
      }
      return false;
    };
    return {
      mode: resolved.mode,
      cells: resolved.cells ? [...resolved.cells] : null,
      allowsCell,
      allowsSession,
      allowsTile: (tile) => tileIsRemote(tile) || allowsSession(tile && tile.session),
      // Filtri: gli elenchi si restringono con lo STESSO predicato che decide
      // le azioni. Due implementazioni divergenti sarebbero un bug latente.
      filterCells: (list) => (Array.isArray(list) ? list.filter((c) => allowsCell(c && (c.cell ?? c.id))) : []),
      filterSessions: (list) => (Array.isArray(list) ? list.filter((s) => allowsSession(s && (s.name ?? s.tmuxSession))) : []),
    };
  }

  // resolve({trust, visited}) -> api dello scope.
  //   trust 'local-bridge' (o assente e non federato) : nessuna restrizione
  //   trust 'federated'                                : intersezione consegnante ∩ origine
  function resolve({ trust, visited } = {}) {
    if (trust !== 'federated') return openScope();
    const chain = Array.isArray(visited) ? visited : [];
    // Serve almeno origine + questo nodo. Una catena piu' corta non identifica
    // nessun peer: fail-closed.
    if (chain.length < 2) return buildApi({ mode: 'none', cells: new Set() });

    let st;
    try { st = loadStoreImpl(nodesPath); } catch (_) { st = null; }
    if (!st) return buildApi({ mode: 'none', cells: new Set() });

    const deliveringId = chain[chain.length - 2];
    const originId = chain[0];
    // Il CONSEGNANTE deve essere un mio peer: mi ha consegnato la richiesta
    // autenticandosi. Se non lo trovo nello store, fail-closed.
    const delivering = scopeOf(findByNodeId(st, deliveringId));
    // L'ORIGINE no. Un peer transitivo arriva attraverso un hub che io ho
    // autorizzato a instradare, e non ho alcun motivo di conoscerlo: e' il caso
    // normale di una rete a tre nodi (A chiede a C passando per B).
    //
    // Trattare un'origine sconosciuta come `none` sembrava prudente ed era
    // invece una porta chiusa in faccia al traffico legittimo: nella rete reale
    // il terzo nodo smetteva di vedere QUALSIASI cella, senza errore, appena
    // questo codice e' arrivato sui peer. Lo scope celle governa i MIEI peer
    // diretti; chi non e' mio non ha una restrizione mia da subire.
    //
    // Non e' un ampliamento: `all` e' l'elemento neutro dell'intersezione, e la
    // restrizione del consegnante — che e' mio e che ho configurato io —
    // continua a valere per intero. L'invariante resta: un'origine che E' nel
    // mio store porta con se' la propria restrizione anche in multi-hop.
    const originNode = originId === deliveringId ? null : findByNodeId(st, originId);
    const origin = originId === deliveringId
      ? delivering
      : (originNode ? scopeOf(originNode) : { mode: 'all', cells: null });
    return buildApi(intersect(delivering, origin), st.nodeId || null);
  }

  return { resolve };
}

module.exports = { createCellScope, scopeOf, intersect };
