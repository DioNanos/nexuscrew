'use strict';

// Classification of the resources reachable through the federation proxy.
//
// Every federated resource belongs to exactly one class, and each class demands
// explicit grants from the node that OWNS the resource. The class is decided on
// the resource and the method, BEFORE the request is dispatched: a route that is
// not classified is denied, so a new endpoint cannot become reachable by a
// limited peer just because nobody classified it. The gate reads grants — never
// a role string — and an owner-side request (no peer ingress) is unaffected.

const CLASSES = Object.freeze({
  // Events of cells and of the node itself.
  'event-feed': Object.freeze({ grants: ['eventsAccess'] }),
  'node-event-feed': Object.freeze({ grants: ['eventsAccess', 'nodeEventsAccess'] }),
  // Answering, dismissing or polling a single ask. Seeing the card does not
  // grant the action.
  'ask-action': Object.freeze({ grants: ['eventsAccess', 'askReplyAccess'] }),
  // Inventories: which cells, which sessions, the status of the fleet. Only the
  // authorized inventory is projected, and a peer with no visible cell sees none
  // of it.
  inventory: Object.freeze({ grants: [], needsVisibility: true }),
  // Reading shared files: list and download, filtered by the owning cell.
  'files-read': Object.freeze({ grants: ['filesReadAccess'] }),
  // Choosing which cell of this node hosts the Live session.
  'live-host': Object.freeze({ grants: ['liveHostAccess'] }),
  // Opening a panel: a browser with already-authenticated sessions behind it.
  panel: Object.freeze({ grants: ['panelAccess', 'peerOperatorAccess'], needsVisibility: true }),
  // Everything else that mutates: configuration, filesystem browsing,
  // diagnostics, credentials, fleet topology, decks, terminals, uploads and
  // deletions. Operator-level by definition.
  operator: Object.freeze({ grants: ['peerOperatorAccess'] }),
});

const CLASS_NAMES = Object.freeze(Object.keys(CLASSES));

const CELL_ID = '[A-Za-z0-9._-]{1,32}';
const NODE_ID = '[a-f0-9]{32}';

// Resource -> class. Keep this table aligned with the federation allowlist: the
// coverage test reads both and fails when one has a resource the other ignores.
function classifyResource(resource, method = 'GET') {
  if (typeof resource !== 'string' || resource === '') return null;
  const m = String(method || 'GET').toUpperCase();

  if (resource === '/event-feed' || resource === '/event-feed/snapshot') {
    return m === 'GET' ? 'event-feed' : null;
  }
  if (new RegExp(`^/event-feed/${CELL_ID}$`).test(resource)) return m === 'GET' ? 'event-feed' : null;
  if (new RegExp(`^/event-feed/node/${NODE_ID}$`).test(resource)) return m === 'GET' ? 'node-event-feed' : null;
  if (new RegExp(`^/asks/${CELL_ID}/(answer|dismiss|status)$`).test(resource)) {
    return m === 'POST' || m === 'GET' ? 'ask-action' : null;
  }
  // Federated ask surface: the ask id is the 8-hex local id, the
  // attempt id a UUID. The routes live UNDER /event-feed because they are the
  // feed's own write-back path; the class is the same ask-action.
  if (/^\/event-feed\/asks\/[a-f0-9]{8}\/answer$/.test(resource)) return m === 'POST' ? 'ask-action' : null;
  if (/^\/event-feed\/asks\/[a-f0-9]{8}$/.test(resource)) return m === 'DELETE' ? 'ask-action' : null;
  if (/^\/event-feed\/asks\/[a-f0-9]{8}\/requests\/[0-9a-f-]{16,64}$/.test(resource)) return m === 'GET' ? 'ask-action' : null;

  if (resource === '/cells') return m === 'GET' ? 'inventory' : null;
  if (resource === '/sessions') return m === 'GET' ? 'inventory' : (m === 'POST' ? 'operator' : null);
  if (/^\/sessions\/[\w.@%:+-]{1,128}$/.test(resource)) return m === 'DELETE' ? 'operator' : null;
  if (/^\/sessions\/[\w.@%:+-]{1,128}\/visibility$/.test(resource)) return m === 'PATCH' ? 'operator' : null;
  if (resource === '/vl-nodes') return m === 'GET' ? 'inventory' : null;
  if (new RegExp(`^/vl-nodes/${NODE_ID}/events$`).test(resource)) return m === 'GET' ? 'inventory' : null;

  if (resource === '/files') return m === 'GET' ? 'files-read' : (m === 'DELETE' ? 'operator' : null);
  if (resource === '/files/download') return m === 'GET' ? 'files-read' : null;
  if (resource === '/files/upload') return m === 'POST' ? 'operator' : null;

  if (resource === '/live-host') return m === 'GET' ? 'live-host' : null;
  if (resource === '/live-host/designate' || resource === '/live-host/clear' || resource === '/live-host/bridge') {
    return m === 'POST' ? 'live-host' : null;
  }
  if (new RegExp(`^/panel/${CELL_ID}(?:/.*)?$`).test(resource)) {
    return m === 'GET' || m === 'POST' ? 'panel' : null;
  }

  // Operator-level mutations and diagnostics, one by one.
  if (resource === '/config') return m === 'GET' ? 'operator' : null;
  if (resource === '/fs/dirs') return m === 'GET' ? 'operator' : null;
  if (resource === '/cells/send') return m === 'POST' ? 'operator' : null;
  if (resource === '/vl-nodes/invite') return m === 'POST' ? 'operator' : null;
  if (new RegExp(`^/vl-nodes/${NODE_ID}/commands$`).test(resource)) return m === 'POST' ? 'operator' : null;
  if (new RegExp(`^/vl-nodes/${NODE_ID}$`).test(resource)) return m === 'DELETE' ? 'operator' : null;
  // Fleet: the allowlist splits the family in two — the read alternatives are
  // GET, the rest are POST. A peer that is not an operator is refused by the
  // class gate; an operator no longer gets "resource-not-classified".
  if (/^\/fleet\/(status|schema|definitions|credentials\/status)$/.test(resource)) {
    return m === 'GET' ? 'operator' : null;
  }
  if (/^\/fleet\/(credentials\/(?:set|remove)|up|down|restart|engine|boot|define-engine|edit-engine|remove-engine|define-model|remove-model|model-test|define-cell|edit-cell|remove-cell|restore-cells|restore-engines)$/.test(resource)) {
    return m === 'POST' ? 'operator' : null;
  }
  if (resource === '/decks') return m === 'GET' || m === 'POST' ? 'operator' : null;
  if (/^\/decks\/[a-z0-9-]{1,32}$/.test(resource)) {
    return ['PUT', 'PATCH', 'DELETE'].includes(m) ? 'operator' : null;
  }

  // Topology, diagnostics, terminals and the notify/audio surface of this node:
  // all of them act ON the owner's node, so they belong to the operator class.
  if (resource === '/topology') return m === 'GET' ? 'operator' : null;
  // Diagnostics: the allowlist accepts GET on status and logs, DELETE on logs
  // and PATCH on verbose — the class follows those methods, not a wider one.
  if (resource === '/diagnostics/status') return m === 'GET' ? 'operator' : null;
  if (resource === '/diagnostics/logs') return m === 'GET' || m === 'DELETE' ? 'operator' : null;
  if (resource === '/diagnostics/verbose') return m === 'PATCH' ? 'operator' : null;
  if (resource === '/ws') return m === 'GET' ? 'operator' : null;
  // La DOMANDA federata (nc_ask): `/asks` e' la superficie operatore come
  // `/notify` — mostra testo sui nodi dell'owner e non esegue nulla. Solo POST:
  // la GET resta locale, lo snapshot degli ask e' autorevole solo sul nodo che
  // li possiede. NB: non va confusa con `^/asks/<cellId>/(answer|dismiss|status)$`
  // qui sopra, che e' la write-back verso la CELLA e ha un'altra classe.
  if (resource === '/asks') return m === 'POST' ? 'operator' : null;
  if (resource === '/notify') return m === 'POST' ? 'operator' : null;
  if (resource === '/audio/capability') return m === 'GET' ? 'operator' : null;
  if (resource === '/audio/speak') return m === 'POST' ? 'operator' : null;
  if (resource === '/audio/speak/status') return m === 'POST' ? 'operator' : null;
  if (resource === '/audio/stop') return m === 'POST' ? 'operator' : null;

  // Not classified: denied until it is classified on purpose.
  return null;
}

// True when the grants of the peer satisfy the class. `ingress` null is the
// owner of this node, who is not limited by these grants.
function allowedByClass(className, ingress) {
  if (!ingress) return true;
  const cls = CLASSES[className];
  if (!cls) return false; // unknown class: never a reason to allow
  for (const grant of cls.grants) {
    if (ingress[grant] !== true) return false;
  }
  if (cls.needsVisibility === true && ingress.cellVisibility === 'none') return false;
  return true;
}

// The grants a class demands, for diagnostics and for the coverage test.
function grantsForClass(className) {
  const cls = CLASSES[className];
  return cls ? [...cls.grants] : null;
}

module.exports = {
  CLASSES,
  CLASS_NAMES,
  allowedByClass,
  classifyResource,
  grantsForClass,
};
