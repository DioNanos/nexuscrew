import { normalize, parseRef } from './grid-model.js';

export const LOCAL_OWNER = 'local';
export const NODE_ID_RE = /^[a-f0-9]{16,64}$/;

export function deckId(ownerId, name) {
  return `${ownerId && NODE_ID_RE.test(ownerId) ? ownerId : LOCAL_OWNER}:${name}`;
}

export function parseDeckId(value) {
  const s = String(value || '');
  const at = s.indexOf(':');
  if (at < 1) return null;
  const ownerId = s.slice(0, at);
  const name = s.slice(at + 1);
  if (ownerId !== LOCAL_OWNER && !NODE_ID_RE.test(ownerId)) return null;
  if (!/^[a-z0-9-]{1,32}$/.test(name)) return null;
  return { ownerId: ownerId === LOCAL_OWNER ? null : ownerId, name };
}

function routeKey(route) {
  return Array.isArray(route) && route.length ? route.join('/') : '';
}

function cloneLayout(layout) {
  return { columns: normalize(layout).columns.map((column) => ({
    width: column.width,
    tiles: column.tiles.map((tile) => ({ ...tile })),
  })) };
}

function topologyRouteToId(topology) {
  const map = new Map();
  for (const node of Array.isArray(topology) ? topology : []) {
    if (node && NODE_ID_RE.test(String(node.instanceId || '')) && Array.isArray(node.route)) {
      map.set(routeKey(node.route), node.instanceId);
    }
  }
  return map;
}

function topologyIdToRoute(topology) {
  const map = new Map();
  for (const node of Array.isArray(topology) ? topology : []) {
    if (node && NODE_ID_RE.test(String(node.instanceId || '')) && Array.isArray(node.route)) {
      map.set(node.instanceId, [...node.route]);
    }
  }
  return map;
}

// A deck is interpreted in the coordinate system of its owner. Legacy local
// tiles have no node: bind them to the owner. Legacy remote tiles are upgraded
// when the owner's topology can resolve their route to a stable instanceId.
export function annotateCanonicalLayout(layout, deckOwnerId, ownerTopology = []) {
  const out = cloneLayout(layout);
  const byRoute = topologyRouteToId(ownerTopology);
  for (const column of out.columns) {
    for (const tile of column.tiles) {
      if (tile.ownerId) continue;
      if (!tile.node && NODE_ID_RE.test(String(deckOwnerId || ''))) tile.ownerId = deckOwnerId;
      else if (tile.node && byRoute.has(tile.node)) tile.ownerId = byRoute.get(tile.node);
    }
  }
  return out;
}

// Resolve stable ownerId coordinates into routes valid from the current PWA.
// Route hints remain only when an owner is temporarily unavailable; this keeps
// the tile visibly offline instead of ever falling back to an omonymous local
// tmux session.
export function resolveLayoutForViewer(layout, localNodeId, viewerOwners = []) {
  const out = cloneLayout(layout);
  const byId = new Map();
  for (const owner of viewerOwners) {
    if (owner && NODE_ID_RE.test(String(owner.instanceId || '')) && Array.isArray(owner.route)) {
      byId.set(owner.instanceId, [...owner.route]);
    }
  }
  for (const column of out.columns) {
    for (const tile of column.tiles) {
      if (!tile.ownerId) continue;
      if (tile.ownerId === localNodeId) {
        delete tile.node; delete tile.unavailable;
      } else if (byId.has(tile.ownerId)) {
        tile.node = routeKey(byId.get(tile.ownerId)); delete tile.unavailable;
      } else {
        // Never trust a compatibility route hint once the stable owner is no
        // longer present in the viewer's authorized topology.
        tile.unavailable = true;
      }
    }
  }
  return out;
}

// Before writing to an owner, convert the viewer route hints back into the
// owner's route coordinate system. ownerId stays authoritative; node is only a
// one-cycle compatibility hint for 0.8.x readers.
export function canonicalizeLayoutForOwner(layout, deckOwnerId, ownerTopology = []) {
  const out = cloneLayout(layout);
  const byId = topologyIdToRoute(ownerTopology);
  for (const column of out.columns) {
    for (const tile of column.tiles) {
      delete tile.unavailable;
      if (!tile.ownerId) continue;
      if (tile.ownerId === deckOwnerId) delete tile.node;
      else if (byId.has(tile.ownerId)) tile.node = routeKey(byId.get(tile.ownerId));
    }
  }
  return out;
}

export function refWithOwner(ref, localNodeId, viewerOwners = []) {
  const parsed = parseRef(ref);
  if (!parsed) return null;
  if (parsed.ownerId) return parsed;
  if (!parsed.node) return { ...parsed, ...(NODE_ID_RE.test(String(localNodeId || '')) ? { ownerId: localNodeId } : {}) };
  const owner = viewerOwners.find((item) => routeKey(item && item.route) === parsed.node);
  return { ...parsed, ...(owner && NODE_ID_RE.test(String(owner.instanceId || '')) ? { ownerId: owner.instanceId } : {}) };
}
