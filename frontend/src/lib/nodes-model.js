// Modello puro dei gruppi per-nodo (B2, design §5/§7). Nessun React qui.
// Input: /api/nodes (read-only, redatto) + fetch best-effort delle sessioni
// remote via proxy /node/<name>/api/sessions. Output: gruppi renderizzabili
// con stato esplicito (mai spinner infinito, design §7).
//
// Stati gruppo:
//   'up'          tunnel su, sessioni caricate
//   'down'        tunnel giu' (nessun fetch tentato) — degradato
//   'unreachable' tunnel dichiarato su ma il proxy non raggiunge il nodo — degradato

export const NODE_NAME_RE = /^[a-z0-9-]{1,32}$/;

// Identita' route-qualified per pin/badge/contatori/SingleView: include la route
// per evitare collisioni tra celle/sessioni omonime su posizioni diverse.
// route = [] (Locale) -> id nudo; route = ['vps'] -> 'vps:id'.
export function positionKey(route, id) {
  const r = Array.isArray(route) ? route : [];
  return r.length ? `${r.map(encodeURIComponent).join('/')}:${id}` : String(id);
}

// Base path HTTP delle route remote di un nodo ('' = locale). Le route dei
// tile (files/preview/voice) passano dal proxy B1 con lo stesso token locale.
export function nodeBase(node) {
  return node ? `/api/route/${String(node).split('/').map(encodeURIComponent).join('/')}/_` : '/api';
}

// Tracking client-side del "down da quando": /api/nodes riporta `since` solo
// per i tunnel up (pidfile); per il down ricordiamo la PRIMA osservazione.
// prev: {name: epochSec}; nodes: lista da /api/nodes. Ritorna la mappa nuova.
export function trackDown(prev, nodes, nowSec) {
  const out = {};
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const route = Array.isArray(n?.route) ? n.route : (typeof n?.name === 'string' ? [n.name] : []);
    if (!route.length) continue;
    const key = route.join('/');
    const upNow = n.status === 'up' || (n.tunnel && n.tunnel.status === 'up');
    const passive = n.status === 'passive' || (n.tunnel && n.tunnel.status === 'passive');
    if (!upNow && !passive) out[key] = (prev && prev[key]) || nowSec;
  }
  return out; // nodi tornati up (o rimossi) spariscono dalla mappa
}

// Arricchisce le celle Fleet di una posizione con identita' route-qualified
// (key + route), pronte per rendering/pin/azioni. f = payload fleetStatus(route).
// preserved: le celle vengono da un elenco fermo (nodo non raggiungibile) —
// la UI deve mostrarle distinguibili e senza azioni da nodo vivo.
function enrichCells(f, route, key, preserved = false) {
  if (!f || !Array.isArray(f.cells)) return [];
  return f.cells.map((c) => ({
    ...c,
    route,
    // Il tile deve aprire la VERA sessione tmux, non l'id logico della cella.
    // Usare c.cell (es. Dev) produceva header plausibile ma attach WS a una
    // sessione inesistente invece di cloud-Dev -> terminale remoto vuoto.
    key: `${key}:${c.tmuxSession || c.cell}`,
    ...(preserved ? { preserved: true } : {}),
  }));
}

// Campi fleet di un gruppo il cui nodo NON e' raggiungibile ma ha un ultimo
// elenco noto: stesse regole del backoff R21/755ae60 — la lettura non e'
// verificabile, non assente. L'elenco sopravvive marcato (fleetState 'stale',
// cellsPreserved) finche' non arriva un dato autorevole: available (fresco,
// anche vuoto) o disabled. Nessuna unione, nessun TTL: se il nodo torna su
// senza una cella, quella cella sparisce.
function preservedFleetFields(f, route, key) {
  if (!f) return {};
  const state = fleetStateOf(f);
  if (!fleetInventoryKnown(f, state) || state !== 'stale') return {};
  return {
    cells: enrichCells(f, route, key, true),
    fleetState: 'stale',
    fleetAvailable: false,
    cellsPreserved: true,
  };
}

// Fleet remoto: available e' dato aggiornato; stale e' l'ultimo elenco noto
// mantenuto mentre la lettura non e' verificabile; disabled e' una risposta
// autorevole che dichiara il fleet spento. Il fallback sui payload precedenti
// senza fleetState resta fail-closed: available:false e' disabled, assenza di
// payload e' stale.
function fleetStateOf(f) {
  if (f?.fleetState === 'stale') return 'stale';
  if (f?.fleetState === 'disabled') return 'disabled';
  if (f?.available === true && Array.isArray(f.cells)) return 'available';
  if (f?.available === false) return 'disabled';
  return 'stale';
}

function fleetInventoryKnown(f, state) {
  return (state === 'available' || state === 'stale') && Array.isArray(f?.cells);
}

// buildNodeGroups({nodes, topology, remote, down, fleet}) -> gruppi ordinati.
//   nodes:  lista /api/nodes (name, label?, tunnel:{status,...}, health?, ...)
//   topology: lista /api/topology (route transitive, stale/lastSeen)
//   remote: {routeKey: {sessions:[...]} | {error}} — fetch sessions per i nodi up
//   down:   mappa trackDown (epochSec prima osservazione del down)
//   fleet:  {routeKey: {available, cells, capabilities, provider}} — fetch fleet
//           per ogni posizione (Locale + route). Permette di mostrare celle Fleet
//           attive E inattive + tmux unmanaged anche sulle posizioni remote.
// Ogni gruppo up porta: sessions (tutte le tmux, retro-compat), cells (Fleet,
// con engine/model/active/boot), unmanaged (tmux non-cell), fleetAvailable,
// capabilities. Zero nodi -> [] (UI identica a oggi).
export function buildNodeGroups({ nodes, topology, remote, down, fleet, aliases } = {}) {
  const out = [];
  const directRoutes = new Set();
  const seenIds = new Set();
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || typeof n.name !== 'string' || !NODE_NAME_RE.test(n.name)) continue;
    if (n.direction === 'inbound' && n.shared !== true) continue;
    const route = [n.name]; const key = n.name; directRoutes.add(key);
    const tunnelStatus = n.tunnel?.status || 'unknown';
    const up = tunnelStatus === 'up';
    const base = {
      name: n.name, label: n.label || n.name, originalLabel: n.label || n.name, alias: null, route, direct: true,
      instanceId: n.nodeId || null, shared: n.shared === true,
      tunnelStatus, sessions: [], cells: [], unmanaged: [],
      fleetAvailable: false, capabilities: [], engines: [], health: n.health || null,
      direction: n.direction || 'outbound', roles: n.roles || null, rolesKnown: n.rolesKnown === true,
    };
    if (n.nodeId) seenIds.add(n.nodeId);
    if (!n.nodeId && n.paired === false) {
      out.push({ ...base, status: 'needs-repair', downSince: (down && down[key]) || null,
        ...preservedFleetFields(fleet && (fleet[key] || fleet[n.name]), route, key) });
      continue;
    }
    if (n.health?.auth === 'failed' || (tunnelStatus === 'degraded' && n.health?.status === 'degraded')) {
      out.push({ ...base, status: 'needs-repair', downSince: (down && down[key]) || null,
        ...preservedFleetFields(fleet && (fleet[key] || fleet[n.name]), route, key) });
      continue;
    }
    if (tunnelStatus === 'passive' || n.health?.status === 'passive') {
      out.push({ ...base, status: 'passive', downSince: null,
        ...preservedFleetFields(fleet && (fleet[key] || fleet[n.name]), route, key) });
      continue;
    }
    if (!up) {
      out.push({ ...base, status: 'down', downSince: (down && down[key]) || null,
        ...preservedFleetFields(fleet && (fleet[key] || fleet[n.name]), route, key) });
      continue;
    }
    const r = (remote && (remote[key] || remote[n.name])) || null;
    const f = fleet && (fleet[key] || fleet[n.name]);
    const sessionsAvailable = !!(r && !r.error && Array.isArray(r.sessions));
    const fleetState = fleetStateOf(f);
    const fleetInventoryAvailable = fleetState === 'available' && fleetInventoryKnown(f, fleetState);
    const fleetInventoryPresent = fleetInventoryKnown(f, fleetState);
    // A host without a running tmux server can still expose a complete Fleet
    // inventory. Do not hide its cells merely because /sessions is degraded.
    if (!sessionsAvailable && !fleetInventoryPresent) {
      // R21: la CAUSA del mancato raggiungimento viaggia col gruppo: tre
      // esiti (502/403/404) suggeriscono tre azioni diverse a chi guarda.
      out.push({ ...base, status: 'unreachable', cause: (r && r.cause) || null });
      continue;
    }
    const sessions = (sessionsAvailable ? r.sessions : [])
      .filter((s) => s && typeof s.name === 'string' && s.name)
      .map((s) => ({ ...s, node: key, route, key: `${key}:${s.name}` }));
    const cells = enrichCells(f, route, key);
    const cellTmux = new Set(cells.map((c) => c.tmuxSession).filter(Boolean));
    out.push({
      ...base, status: 'up', sessions,
      cells, unmanaged: sessions.filter((s) => !cellTmux.has(s.name)),
      fleetAvailable: fleetInventoryAvailable, fleetState,
      capabilities: (f && f.capabilities) || [],
      engines: (f && f.engines) || [],
      fleetProvider: (f && f.provider) || null,
      sessionsAvailable, inventoryPartial: !sessionsAvailable,
    });
  }
  for (const n of Array.isArray(topology) ? topology : []) {
    if (!n || !Array.isArray(n.route) || n.route.length < 1 || n.route.some((x) => !NODE_NAME_RE.test(x))) continue;
    const key = n.route.join('/');
    if (directRoutes.has(key) || (n.instanceId && seenIds.has(n.instanceId))) continue;
    if (n.instanceId) seenIds.add(n.instanceId);
    const originalLabel = n.label || n.route.join(' › ');
    const alias = n.instanceId && aliases && typeof aliases[n.instanceId] === 'string' ? aliases[n.instanceId] : null;
    const base = {
      name: n.name, label: alias || originalLabel, originalLabel, alias, route: [...n.route], direct: false,
      instanceId: n.instanceId || null, shared: true,
      tunnelStatus: null, sessions: [], cells: [], unmanaged: [], fleetAvailable: false,
      capabilities: [], engines: [], health: n.health || null, lastSeen: n.lastSeen || null,
    };
    if (n.stale) {
      out.push({ ...base, status: 'offline', downSince: (down && down[key]) || n.lastSeen || null,
        ...preservedFleetFields(fleet && fleet[key], n.route, key) });
      continue;
    }
    const r = (remote && remote[key]) || null;
    const f = fleet && fleet[key];
    const sessionsAvailable = !!(r && !r.error && Array.isArray(r.sessions));
    const fleetState = fleetStateOf(f);
    const fleetInventoryAvailable = fleetState === 'available' && fleetInventoryKnown(f, fleetState);
    const fleetInventoryPresent = fleetInventoryKnown(f, fleetState);
    if (!sessionsAvailable && !fleetInventoryPresent) {
      // R21: come sopra — la causa distingue l'assenza dal rifiuto dalla
      // rotta inesistente, e il recupero non deve buttarla via.
      out.push({ ...base, status: 'unreachable', downSince: (down && down[key]) || null, cause: (r && r.cause) || null });
      continue;
    }
    const sessions = (sessionsAvailable ? r.sessions : []).filter((s) => s && typeof s.name === 'string' && s.name)
      .map((s) => ({ ...s, node: key, route: n.route, key: `${key}:${s.name}` }));
    const cells = enrichCells(f, n.route, key);
    const cellTmux = new Set(cells.map((c) => c.tmuxSession).filter(Boolean));
    out.push({
      ...base, status: 'up', sessions,
      cells, unmanaged: sessions.filter((s) => !cellTmux.has(s.name)),
      fleetAvailable: fleetInventoryAvailable, fleetState,
      capabilities: (f && f.capabilities) || [],
      engines: (f && f.engines) || [],
      fleetProvider: (f && f.provider) || null, lastSeen: n.lastSeen || null,
      sessionsAvailable, inventoryPartial: !sessionsAvailable,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
