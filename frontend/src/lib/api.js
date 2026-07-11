// fetch con Bearer: tutte le /api del server lo richiedono.
export function apiFetch(path, token, opts = {}) {
  return fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
}

export const seenKey = (session) => `nc_seen_${session}`;

// Helper JSON per le route di flotta/sessioni: usa apiFetch (Bearer) e parsa il
// body. apiFetch(path, token, opts) accetta già {method, headers, body}, quindi
// qui componiamo solo la codifica JSON + gli header content-type.
async function jsonFetch(path, token, opts = {}) {
  const r = await apiFetch(path, token, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; e.data = j; throw e; }
  return j;
}
export const fleetStatus = (t) => jsonFetch('/api/fleet/status', t);
export const fleetUp = (t, b) => jsonFetch('/api/fleet/up', t, { method: 'POST', body: b });
export const fleetDown = (t, b) => jsonFetch('/api/fleet/down', t, { method: 'POST', body: b });
export const fleetEngine = (t, b) => jsonFetch('/api/fleet/engine', t, { method: 'POST', body: b });
export const fleetBoot = (t, b) => jsonFetch('/api/fleet/boot', t, { method: 'POST', body: b });
export const fleetRestart = (t, cell) => jsonFetch('/api/fleet/restart', t, { method: 'POST', body: { cell } });
export const fleetSchema = (t) => jsonFetch('/api/fleet/schema', t);
export const fleetDefinitions = (t) => jsonFetch('/api/fleet/definitions', t);
export const fleetDefineEngine = (t, def) => jsonFetch('/api/fleet/define-engine', t, { method: 'POST', body: { def } });
export const fleetEditEngine = (t, id, patch, envChanges) => jsonFetch('/api/fleet/edit-engine', t, { method: 'POST', body: { id, patch, envChanges } });
export const fleetRemoveEngine = (t, id) => jsonFetch('/api/fleet/remove-engine', t, { method: 'POST', body: { id } });
export const fleetDefineCell = (t, def) => jsonFetch('/api/fleet/define-cell', t, { method: 'POST', body: { def } });
export const fleetEditCell = (t, id, patch) => jsonFetch('/api/fleet/edit-cell', t, { method: 'POST', body: { id, patch } });
export const fleetRemoveCell = (t, id, stop = false) => jsonFetch('/api/fleet/remove-cell', t, { method: 'POST', body: { id, stop } });
export const createSession = (t, b) => jsonFetch('/api/sessions', t, { method: 'POST', body: b });
export const killSession = (t, name) => jsonFetch(`/api/sessions/${encodeURIComponent(name)}`, t, { method: 'DELETE' });
export const listDirs = (t, p) => jsonFetch(`/api/fs/dirs${p ? `?path=${encodeURIComponent(p)}` : ''}`, t);

// Settings API B2 (design §4b(6)): read-only + mutanti lista chiusa. jsonFetch
// propaga la causa esplicita (j.error) su ogni failure — MAI errori muti in UI.
export const getSettings = (t) => jsonFetch('/api/settings', t);
export const getNodes = (t) => jsonFetch('/api/nodes', t);
// Sessioni di un nodo remoto via proxy B1 (stesso token locale: il proxy
// verifica il Bearer e inietta LUI il token remoto — mai visto dal browser).
export const getNodeSessions = (t, name) => jsonFetch(`/node/${encodeURIComponent(name)}/api/sessions`, t);
export const saveConfig = (t, b) => jsonFetch('/api/settings/config', t, { method: 'POST', body: b });
export const rotateToken = (t) => jsonFetch('/api/settings/token/rotate', t, { method: 'POST' });
export const addNode = (t, b) => jsonFetch('/api/settings/nodes', t, { method: 'POST', body: b });
export const removeNode = (t, name) => jsonFetch(`/api/settings/nodes/${encodeURIComponent(name)}`, t, { method: 'DELETE' });
// action ∈ {test, up, down, restart} — stringhe fisse dal chiamante, mai input utente.
export const nodeAction = (t, name, action) => jsonFetch(`/api/settings/nodes/${encodeURIComponent(name)}/${action}`, t, { method: 'POST' });
export const setNodeRole = (t, b) => jsonFetch('/api/settings/node-role', t, { method: 'POST', body: b });
export const regenService = (t) => jsonFetch('/api/settings/service/regenerate', t, { method: 'POST' });

// MCP bridge: asks aperti + risposta (il POST answer incolla nella sessione
// della cella; in READONLY il server risponde 403 con causa esplicita).
export const getAsks = (t, open = true) => jsonFetch(`/api/asks${open ? '?open=1' : ''}`, t);
export const answerAsk = (t, id, text) => jsonFetch(`/api/asks/${encodeURIComponent(id)}/answer`, t, { method: 'POST', body: { text } });

export const getDecks = (t) => jsonFetch('/api/decks', t);
export const createDeck = (t, name) => jsonFetch('/api/decks', t, { method: 'POST', body: { name } });
export const saveDeck = (t, name, layout, expectedRevision) => jsonFetch(`/api/decks/${encodeURIComponent(name)}`, t, { method: 'PUT', body: { layout, expectedRevision } });
export const renameDeck = (t, name, next, expectedRevision) => jsonFetch(`/api/decks/${encodeURIComponent(name)}`, t, { method: 'PATCH', body: { name: next, expectedRevision } });
export const deleteDeck = (t, name, expectedRevision) => jsonFetch(`/api/decks/${encodeURIComponent(name)}`, t, { method: 'DELETE', body: { expectedRevision } });
