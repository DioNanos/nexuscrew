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
    if (!upNow) out[key] = (prev && prev[key]) || nowSec;
  }
  return out; // nodi tornati up (o rimossi) spariscono dalla mappa
}

// buildNodeGroups({nodes, remote, down}) -> gruppi ordinati per nome.
//   nodes:  lista /api/nodes (name, tunnel:{status,...}, ...)
//   remote: {name: {sessions:[...]} | {error:string}} — risultato fetch per i
//           soli nodi col tunnel up (best-effort)
//   down:   mappa trackDown (epochSec prima osservazione del down)
// Zero nodi configurati -> [] (la UI resta identica a oggi).
export function buildNodeGroups({ nodes, topology, remote, down } = {}) {
  const out = [];
  const directRoutes = new Set();
  const seenIds = new Set();
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || typeof n.name !== 'string' || !NODE_NAME_RE.test(n.name)) continue;
    const route = [n.name]; const key = n.name; directRoutes.add(key);
    const up = n.tunnel && n.tunnel.status === 'up';
    const base = { name: n.name, label: n.name, route, direct: true, tunnelStatus: up ? 'up' : 'down', sessions: [] };
    if (n.nodeId) seenIds.add(n.nodeId);
    if (!n.nodeId && n.paired === false) {
      out.push({ ...base, status: 'needs-repair', downSince: (down && down[key]) || null });
      continue;
    }
    if (!up) {
      out.push({ ...base, status: 'down', downSince: (down && down[key]) || null });
      continue;
    }
    const r = (remote && (remote[key] || remote[n.name])) || null;
    if (!r || r.error || !Array.isArray(r.sessions)) {
      out.push({ ...base, status: 'unreachable' });
      continue;
    }
    const sessions = r.sessions
      .filter((s) => s && typeof s.name === 'string' && s.name)
      .map((s) => ({ ...s, node: key, route, key: `${key}:${s.name}` }));
    out.push({ ...base, status: 'up', sessions });
  }
  for (const n of Array.isArray(topology) ? topology : []) {
    if (!n || !Array.isArray(n.route) || n.route.length < 1 || n.route.some((x) => !NODE_NAME_RE.test(x))) continue;
    const key = n.route.join('/');
    if (directRoutes.has(key) || (n.instanceId && seenIds.has(n.instanceId))) continue;
    if (n.instanceId) seenIds.add(n.instanceId);
    const base = { name: n.name, label: n.route.join(' › '), route: [...n.route], direct: false, tunnelStatus: null, sessions: [], lastSeen: n.lastSeen || null };
    if (n.stale) {
      out.push({ ...base, status: 'offline', downSince: (down && down[key]) || n.lastSeen || null });
      continue;
    }
    const r = (remote && remote[key]) || null;
    if (!r || r.error || !Array.isArray(r.sessions)) {
      out.push({ ...base, status: 'unreachable', downSince: (down && down[key]) || null });
      continue;
    }
    const sessions = r.sessions.filter((s) => s && typeof s.name === 'string' && s.name)
      .map((s) => ({ ...s, node: key, route: n.route, key: `${key}:${s.name}` }));
    out.push({ ...base, status: 'up', sessions, lastSeen: n.lastSeen || null });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
