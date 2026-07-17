'use strict';

// Canonical peer inventory shared by HTTP, CLI and the PWA.  A direct peer is
// backed by nodes.json and can therefore expose management actions.  A routed
// peer comes from topology-cache.json: it is visible and inspectable, but it
// must never pretend to support mutations on this installation.

function actionsFor(node, kind = 'direct') {
  if (kind !== 'direct') return { inspect: true };
  const outbound = node.direction !== 'inbound';
  return {
    inspect: true,
    edit: true,
    remove: true,
    test: true,
    ...(outbound ? {
      connect: true,
      disconnect: true,
      restart: true,
      share: true,
    } : {
      visibility: true,
    }),
  };
}

function directPeer(node, extra = {}) {
  const direction = node.direction || 'outbound';
  return {
    ...node,
    ...extra,
    kind: 'direct',
    relation: direction === 'inbound' ? 'client' : 'hub',
    manageable: true,
    route: [node.name],
    hops: 1,
    actions: actionsFor(node, 'direct'),
  };
}

function routedPeer(entry) {
  const route = Array.isArray(entry.route) ? [...entry.route] : [];
  return {
    name: entry.name,
    nodeId: entry.instanceId,
    instanceId: entry.instanceId,
    kind: 'transitive',
    relation: 'routed',
    manageable: false,
    route,
    hops: route.length,
    lastSeen: entry.lastSeen,
    stale: entry.stale === true,
    actions: actionsFor(entry, 'transitive'),
  };
}

function buildInventory({ direct = [], topology = [], extras = new Map() } = {}) {
  const directIds = new Set(direct.map((node) => node && node.nodeId).filter(Boolean));
  const peers = direct.map((node) => directPeer(node, extras.get(node.name) || {}));
  for (const entry of topology) {
    if (!entry || directIds.has(entry.instanceId)) continue;
    peers.push(routedPeer(entry));
  }
  return peers;
}

function resolvePeer(peers, ref) {
  const value = String(ref || '').trim();
  if (!value) return { error: 'riferimento nodo mancante' };
  const byId = peers.filter((peer) => peer.nodeId === value || peer.instanceId === value);
  if (byId.length === 1) return { peer: byId[0] };
  const byName = peers.filter((peer) => peer.name === value);
  if (byName.length === 1) return { peer: byName[0] };
  if (byId.length > 1 || byName.length > 1) {
    return { error: `riferimento ambiguo "${value}": usa il nodeId` };
  }
  return { error: `nodo sconosciuto "${value}"` };
}

module.exports = { actionsFor, directPeer, routedPeer, buildInventory, resolvePeer };
