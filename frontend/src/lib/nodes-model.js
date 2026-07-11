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
    if (!n || typeof n.name !== 'string') continue;
    const upNow = n.tunnel && n.tunnel.status === 'up';
    if (!upNow) out[n.name] = (prev && prev[n.name]) || nowSec;
  }
  return out; // nodi tornati up (o rimossi) spariscono dalla mappa
}

// buildNodeGroups({nodes, remote, down}) -> gruppi ordinati per nome.
//   nodes:  lista /api/nodes (name, tunnel:{status,...}, ...)
//   remote: {name: {sessions:[...]} | {error:string}} — risultato fetch per i
//           soli nodi col tunnel up (best-effort)
//   down:   mappa trackDown (epochSec prima osservazione del down)
// Zero nodi configurati -> [] (la UI resta identica a oggi).
export function buildNodeGroups({ nodes, remote, down } = {}) {
  const out = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || typeof n.name !== 'string' || !NODE_NAME_RE.test(n.name)) continue;
    const up = n.tunnel && n.tunnel.status === 'up';
    if (!up) {
      out.push({ name: n.name, status: 'down', sessions: [], downSince: (down && down[n.name]) || null });
      continue;
    }
    const r = (remote && remote[n.name]) || null;
    if (!r || r.error || !Array.isArray(r.sessions)) {
      out.push({ name: n.name, status: 'unreachable', sessions: [] });
      continue;
    }
    const sessions = r.sessions
      .filter((s) => s && typeof s.name === 'string' && s.name)
      .map((s) => ({ ...s, node: n.name, key: `${n.name}:${s.name}` }));
    out.push({ name: n.name, status: 'up', sessions });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
