import { normalize, parseRef } from './grid-model.js';

export const LOCAL_OWNER = 'local';
export const NODE_ID_RE = /^[a-f0-9]{16,64}$/;

// Isteresi di disponibilita' degli owner (stato EFFIMERO, mai persistito nel
// deck salvato): un owner assente per UN poll non spegne la tile. La tile
// diventa unavailable solo dopo OWNER_UNAVAILABLE_TICKS poll consecutivi senza
// di lui; finche' resta entro l'isteresi la tile resta viva con l'ultima route
// nota (cache in memoria) e mostra il badge stale. Map a lato del deck: il
// contatore non vive nel layout e sopravvive ai soli render della sessione.
export const OWNER_UNAVAILABLE_TICKS = 3;
const ownerMisses = new Map();
const lastOwnerRoute = new Map();
const OWNER_STATE_MAX = 128;

export function resetOwnerAvailability() {
  ownerMisses.clear();
  lastOwnerRoute.clear();
}

// Un tick per cambio della lista owners (il poll della topologia): aggiorna i
// contatori di miss consecutivi e l'ultima route nota per owner.
export function tickOwnerAvailability(owners) {
  const present = new Set();
  for (const owner of Array.isArray(owners) ? owners : []) {
    if (!owner || !NODE_ID_RE.test(String(owner.instanceId || '')) || !Array.isArray(owner.route)) continue;
    present.add(owner.instanceId);
    lastOwnerRoute.set(owner.instanceId, [...owner.route]);
    ownerMisses.set(owner.instanceId, 0);
  }
  for (const id of [...lastOwnerRoute.keys()]) {
    if (present.has(id)) continue;
    const misses = (ownerMisses.get(id) || 0) + 1;
    ownerMisses.set(id, misses);
    // oltre l'isteresi la route cache non serve piu'; il ricordo non cresce
    if (misses > OWNER_UNAVAILABLE_TICKS + 32) {
      ownerMisses.delete(id);
      lastOwnerRoute.delete(id);
    }
  }
  if (lastOwnerRoute.size > OWNER_STATE_MAX) {
    for (const id of [...lastOwnerRoute.keys()].slice(0, lastOwnerRoute.size - OWNER_STATE_MAX)) {
      ownerMisses.delete(id);
      lastOwnerRoute.delete(id);
    }
  }
}

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
// One deck, two ids. A deck that lives on the node the browser is talking to is
// stored and listed as `local:<name>`, but the URL that opens it in a new tab is
// owner-qualified with that same node: `/deck/<nodeId>/<name>`, which resolves to
// `<nodeId>:<name>`. Both ids mean the same deck, so anything that resolves "the
// current deck" must accept the owner-qualified form of its own node — otherwise
// the deck opens as an empty grid, because no record carries that id.
// A DIFFERENT node's owner-qualified id is left alone on purpose: that is the
// federated path, and its layout comes from the owner, never from here.
export function deckIdForLocalOwner(id, localNodeId) {
  const parsed = parseDeckId(id);
  if (!parsed || !parsed.ownerId) return id;
  if (!localNodeId || parsed.ownerId !== localNodeId) return id;
  return deckId(null, parsed.name);
}

export function resolveLayoutForViewer(layout, localNodeId, viewerOwners = []) {
  const out = cloneLayout(layout);
  const byId = new Map();
  const staleById = new Set();
  for (const owner of viewerOwners) {
    if (owner && NODE_ID_RE.test(String(owner.instanceId || '')) && Array.isArray(owner.route)) {
      byId.set(owner.instanceId, [...owner.route]);
      if (owner.stale === true) staleById.add(owner.instanceId);
    }
  }
  for (const column of out.columns) {
    for (const tile of column.tiles) {
      if (!tile.ownerId) continue;
      if (tile.ownerId === localNodeId) {
        delete tile.node; delete tile.unavailable; delete tile.stale;
      } else if (byId.has(tile.ownerId)) {
        // Owner presente nel poll (anche se marcato stale dal server): la tile
        // resta viva con la route del tick; lo stato stale e' solo un badge.
        tile.node = routeKey(byId.get(tile.ownerId));
        delete tile.unavailable;
        if (staleById.has(tile.ownerId)) tile.stale = true; else delete tile.stale;
      } else {
        const misses = ownerMisses.get(tile.ownerId);
        const cached = lastOwnerRoute.get(tile.ownerId);
        if (cached && misses !== undefined && misses < OWNER_UNAVAILABLE_TICKS) {
          // Isteresi: l'owner manca da meno di N poll consecutivi. La tile
          // resta viva sull'ultima route nota e si segnala come stale.
          tile.node = routeKey(cached);
          delete tile.unavailable;
          tile.stale = true;
        } else {
          // Mai visto in questa sessione, o assente da troppi poll: non ci si
          // fida piu' del compatibility hint una volta che lo owner stabile non
          // e' piu' presente nella topologia autorizzata di chi guarda.
          tile.unavailable = true;
          delete tile.stale;
        }
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
      // Stato effimero: mai scritto verso l'owner.
      delete tile.unavailable;
      delete tile.stale;
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
