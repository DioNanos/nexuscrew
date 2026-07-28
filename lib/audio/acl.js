'use strict';
// lib/audio/acl.js — ACL lato TARGET per gli enunciati in arrivo.
//
// Il target non delega a nessuno la decisione di suonare. Anche quando la
// richiesta e' passata da una route federata gia' autorizzata al transito, il
// nodo che possiede l'altoparlante riapplica la propria ACL: `shared` e'
// pubblicazione, `visibility` e' routing, e nessuno dei due e' un permesso a
// emettere suono in casa d'altri.
//
// Sorgente della decisione: solo il node store locale, mai il body della
// richiesta. L'identita' del nodo di origine arriva dalla catena `visited`
// controllata dal server (lib/audio/origin.js), non da un campo dichiarato.
const store = require('../nodes/store.js');

// Stessa semantica di `peerAllows` in lib/proxy/federation.js: `network` apre a
// tutti i peer, `relay-only` non autorizza il nodo come interlocutore, la lista
// `selected` e' un'allowlist esplicita. Riusata qui invece di inventarne una
// seconda: due modelli di visibilita' divergenti sarebbero un bug latente.
function peerAllows(peer, otherId) {
  if (!peer) return false;
  if (peer.visibility === 'network') return true;
  if (peer.visibility === 'relay-only') return false;
  return Array.isArray(peer.selected) && peer.selected.includes(otherId);
}

function findByNodeId(st, nodeId) {
  if (!st || !Array.isArray(st.nodes) || !nodeId) return null;
  return st.nodes.find((n) => n && n.nodeId === nodeId) || null;
}

// createAudioAcl(): `allows({origin, trust, visited})` -> {allowed, reason}
//   trust 'local-bridge' : origine sul nodo stesso, gia' provata dal bridge.
//   trust 'federated'    : va verificato sia chi consegna sia chi ha originato.
function createAudioAcl({ nodesPath, loadStoreImpl = store.loadStore } = {}) {
  function allows({ trust, origin, visited } = {}) {
    if (trust === 'local-bridge') return { allowed: true };
    if (trust !== 'federated') return { allowed: false, reason: 'unknown-trust' };
    const chain = Array.isArray(visited) ? visited : [];
    if (chain.length < 2) return { allowed: false, reason: 'no-delivering-peer' };
    const deliveringId = chain[chain.length - 2];
    let st;
    try { st = loadStoreImpl(nodesPath); } catch (_) { st = null; }
    if (!st) return { allowed: false, reason: 'store-unavailable' };

    // 1) Il peer che consegna deve essere un peer noto di questo nodo. Un hop
    //    sconosciuto non diventa autorevole per il fatto di aver bussato.
    const delivering = findByNodeId(st, deliveringId);
    if (!delivering) return { allowed: false, reason: 'unknown-peer' };
    if (!peerAllows(delivering, origin && origin.node)) {
      return { allowed: false, reason: 'peer-visibility' };
    }

    // 2) Se il nodo di ORIGINE e' a sua volta un peer diretto, la sua stessa
    //    visibilita' deve permettere questo nodo: un peer marcato `relay-only`
    //    puo' far transitare traffico, non puo' farmi parlare.
    const originPeer = findByNodeId(st, origin && origin.node);
    if (originPeer && !peerAllows(originPeer, st.nodeId)) {
      return { allowed: false, reason: 'origin-visibility' };
    }
    return { allowed: true };
  }
  return { allows };
}

module.exports = { createAudioAcl, peerAllows };
