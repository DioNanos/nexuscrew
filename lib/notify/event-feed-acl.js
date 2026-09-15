'use strict';
// lib/notify/event-feed-acl.js — per-peer projection of the event feed.
//
// The grants live in the node store and are the ONLY source of truth, read
// fresh before every batch (a cached grant is a stale grant). Scope rules:
//   - scope 'cell': eventsAccess AND the cell must be visible under
//     cellVisibility. A hidden cell stays hidden through events.
//   - scope 'node': eventsAccess AND nodeEventsAccess. nodeEventsAccess NEVER
//     bypasses cellVisibility: cell lists inside node frames are projected by
//     the same visibility rule, and hidden cells contribute neither names nor
//     counts.

const nodesStore = require('../nodes/store.js');
const accessPresets = require('../nodes/access-presets.js');

const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;

function visibilityAllows(grants, cellId) {
  const mode = grants.cellVisibility;
  if (mode === 'all') return true;
  if (mode === 'none') return false;
  if (mode === 'selected') {
    return Array.isArray(grants.cells) && typeof cellId === 'string' && grants.cells.includes(cellId);
  }
  return false; // malformed: denied, never guessed
}

// Effective grants of ONE peer, read fresh from the store. Unconfigured or
// malformed records are denied everywhere (a paired peer is not, by itself,
// allowed to read events). `revision` is the store-root access revision: the
// signature lets the publisher detect grant changes cheaply.
function peerGrants(store, peerNodeId) {
  const node = (store && Array.isArray(store.nodes) ? store.nodes : [])
    .find((n) => n && n.nodeId === peerNodeId && n.direction === 'inbound');
  if (!node) return null;
  const view = accessPresets.grantsOf(node);
  const grants = {
    eventsAccess: view.configured === true && node.eventsAccess === true,
    nodeEventsAccess: view.configured === true && node.nodeEventsAccess === true,
    askReplyAccess: view.configured === true && node.askReplyAccess === true,
    cellVisibility: view.configured === true ? node.cellVisibility : 'none',
    cells: Array.isArray(node.cells) ? [...node.cells] : [],
    configured: view.configured === true,
    label: view.label,
  };
  grants.signature = JSON.stringify({
    e: grants.eventsAccess, n: grants.nodeEventsAccess, a: grants.askReplyAccess,
    v: grants.cellVisibility, c: grants.cells, r: nodesStore.accessRevisionOf(store),
  });
  return grants;
}

// May this peer receive this envelope at all? The envelope's cellId is trusted
// here because it was resolved by the OWNER (binding/roster), never taken from
// a request body.
function allowsEnvelope(grants, envelope) {
  if (!grants || grants.configured !== true) return false;
  if (grants.eventsAccess !== true) return false;
  if (!envelope || typeof envelope !== 'object') return false;
  if (envelope.scope === 'cell') {
    if (!(typeof envelope.cellId === 'string' && CELL_ID_RE.test(envelope.cellId))) return false;
    return visibilityAllows(grants, envelope.cellId);
  }
  if (envelope.scope === 'node') return grants.nodeEventsAccess === true;
  return false;
}

// Project a list of cells (fleet frames, snapshot state) to what the peer may
// see. Hidden cells contribute NOTHING: no names, no counts, no "there were N
// more" hints.
function projectCells(grants, cells) {
  if (!Array.isArray(cells)) return [];
  if (!grants || grants.eventsAccess !== true) return [];
  if (grants.cellVisibility === 'all') return cells.slice(0, 1000);
  if (grants.cellVisibility === 'selected') {
    const allowed = new Set(Array.isArray(grants.cells) ? grants.cells : []);
    return cells.filter((c) => c && allowed.has(c.cell));
  }
  return [];
}

// Full per-request decision + projection context. Returns null when the peer
// record does not exist (unknown origin): the caller refuses.
function resolvePeer(store, peerNodeId) {
  const grants = peerGrants(store, peerNodeId);
  if (!grants) return null;
  return {
    nodeId: peerNodeId,
    grants,
    allows: (envelope) => allowsEnvelope(grants, envelope),
    projectCells: (cells) => projectCells(grants, cells),
  };
}

module.exports = { peerGrants, allowsEnvelope, projectCells, visibilityAllows, resolvePeer, CELL_ID_RE };
