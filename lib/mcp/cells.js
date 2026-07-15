'use strict';
// Helper cella/deck/topologia per il server MCP (`lib/mcp/server.js`).
//
// Cohesione di tutto cio' che legge la directory delle celle Fleet e risolve
// owner/route/topologia: layout deck (ordine visuale), normalizzazione payload
// celle, parsing del target owner-qualified, costruzione della route federata
// e della directory aggregata locale+remota. Queste funzioni parlano SOLO via
// l'astrazione `ctx.api` (loopback + Bearer del bridge); ACL e identita'
// owner-qualified sono applicate lato server HTTP.
const { isValidSession } = require('../files/store.js');

const NODE_PART_RE = /^[a-z0-9-]{1,32}$/;
const NODE_ID_RE = /^[a-f0-9]{16,64}$/;
const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;

// Deck layout is stored column-major, while the UI is read row-major. Preserve
// the visual order so an agent sees the same neighbourhood as the operator.
function orderedDeckMembers(deck) {
  const columns = deck && deck.layout && Array.isArray(deck.layout.columns)
    ? deck.layout.columns : [];
  const rows = Math.max(0, ...columns.map((column) => (
    column && Array.isArray(column.tiles) ? column.tiles.length : 0
  )));
  const out = [];
  for (let row = 0; row < rows; row += 1) {
    for (const column of columns) {
      const tile = column && Array.isArray(column.tiles) ? column.tiles[row] : null;
      if (!tile || typeof tile.session !== 'string' || !tile.session) continue;
      const member = { tmuxSession: tile.session };
      if (typeof tile.node === 'string' && tile.node) member.node = tile.node;
      if (typeof tile.ownerId === 'string' && NODE_ID_RE.test(tile.ownerId)) member.ownerId = tile.ownerId;
      out.push(member);
    }
  }
  return out;
}

function fleetStatusPath(node) {
  if (!node) return '/api/fleet/status';
  const parts = String(node).split('/');
  if (!parts.length || parts.some((part) => !NODE_PART_RE.test(part))
    || new Set(parts).size !== parts.length) return null;
  return `/api/route/${parts.map(encodeURIComponent).join('/')}/_/fleet/status`;
}

function fleetCellsBySession(payload) {
  const out = new Map();
  if (!payload || payload.available !== true || !Array.isArray(payload.cells)) return out;
  for (const cell of payload.cells) {
    if (!cell || typeof cell.tmuxSession !== 'string' || !cell.tmuxSession
      || typeof cell.cell !== 'string' || !cell.cell) continue;
    out.set(cell.tmuxSession, cell.cell);
  }
  return out;
}

function routePath(route, resource) {
  if (!Array.isArray(route) || !route.length || route.length > 4
    || route.some((part) => !NODE_PART_RE.test(part)) || new Set(route).size !== route.length) return null;
  return `/api/route/${route.map(encodeURIComponent).join('/')}/_/${resource}`;
}

function topologyOwners(payload) {
  const out = [];
  const seen = new Set();
  for (const node of (payload && Array.isArray(payload.nodes) ? payload.nodes : [])) {
    if (!node || !NODE_ID_RE.test(String(node.instanceId || '')) || seen.has(node.instanceId)
      || !Array.isArray(node.route) || !routePath(node.route, 'decks')) continue;
    seen.add(node.instanceId);
    out.push({
      instanceId: node.instanceId,
      route: [...node.route],
      label: typeof node.label === 'string' && node.label ? node.label : (node.name || node.route.join(' › ')),
      stale: node.stale === true,
    });
  }
  return out;
}

function memberOwnerId(member, deckOwner, ownerTopology) {
  if (member.ownerId && NODE_ID_RE.test(member.ownerId)) return member.ownerId;
  if (!member.node) return deckOwner.instanceId;
  const found = ownerTopology.find((node) => Array.isArray(node.route) && node.route.join('/') === member.node);
  return found ? found.instanceId : null;
}

function parseCellTarget(value) {
  if (typeof value !== 'string') return null;
  const split = value.indexOf(':');
  if (split < 16) return null;
  const instanceId = value.slice(0, split);
  const cell = value.slice(split + 1);
  return NODE_ID_RE.test(instanceId) && CELL_ID_RE.test(cell) ? { instanceId, cell } : null;
}

function normalizeCellPayload(payload, owner, callerSession = null) {
  if (!payload || payload.instanceId !== owner.instanceId || !Array.isArray(payload.cells)) return [];
  const route = owner.route.length ? owner.route.join('/') : 'local';
  const seen = new Set();
  const out = [];
  for (const raw of payload.cells) {
    if (!raw || raw.instanceId !== owner.instanceId || !CELL_ID_RE.test(String(raw.cell || ''))
      || typeof raw.tmuxSession !== 'string' || !isValidSession(raw.tmuxSession)
      || seen.has(raw.cell)) continue;
    seen.add(raw.cell);
    out.push({
      id: `${owner.instanceId}:${raw.cell}`,
      instanceId: owner.instanceId,
      owner: owner.label,
      route,
      cell: raw.cell,
      tmuxSession: raw.tmuxSession,
      engine: typeof raw.engine === 'string' ? raw.engine : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      active: raw.active === true,
      canReceive: raw.canReceive === true,
      lastSeen: Number.isFinite(raw.lastSeen) ? raw.lastSeen : null,
      self: owner.route.length === 0 && callerSession === raw.tmuxSession,
    });
  }
  return out;
}

async function readCellDirectory(ctx, callerSession = null) {
  const [config, topology] = await Promise.all([
    ctx.api('GET', '/api/config'), ctx.api('GET', '/api/topology'),
  ]);
  const localId = String(config && config.instanceId || '');
  if (!NODE_ID_RE.test(localId)) throw new Error('instanceId locale non disponibile');
  const owners = [{ instanceId: localId, route: [], label: 'Local', stale: false },
    ...topologyOwners(topology).filter((owner) => !owner.stale && owner.instanceId !== localId)];
  const cells = [];
  const unavailable = [];
  await Promise.all(owners.map(async (owner) => {
    const apiPath = owner.route.length ? routePath(owner.route, 'cells') : '/api/cells';
    if (!apiPath) return;
    try {
      cells.push(...normalizeCellPayload(await ctx.api('GET', apiPath), owner, callerSession));
    } catch (_) {
      unavailable.push({ instanceId: owner.instanceId, owner: owner.label,
        route: owner.route.length ? owner.route.join('/') : 'local' });
    }
  }));
  cells.sort((a, b) => (a.route === 'local' ? -1 : b.route === 'local' ? 1
    : a.route.localeCompare(b.route)) || a.cell.localeCompare(b.cell));
  unavailable.sort((a, b) => a.route.localeCompare(b.route));
  return { nodeId: localId, cells, unavailable };
}

module.exports = {
  NODE_PART_RE, NODE_ID_RE, CELL_ID_RE,
  orderedDeckMembers, fleetStatusPath, fleetCellsBySession, routePath,
  topologyOwners, memberOwnerId, parseCellTarget, normalizeCellPayload, readCellDirectory,
};
