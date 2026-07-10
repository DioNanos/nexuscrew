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
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
export const fleetStatus = (t) => jsonFetch('/api/fleet/status', t);
export const fleetUp = (t, b) => jsonFetch('/api/fleet/up', t, { method: 'POST', body: b });
export const fleetDown = (t, b) => jsonFetch('/api/fleet/down', t, { method: 'POST', body: b });
export const fleetEngine = (t, b) => jsonFetch('/api/fleet/engine', t, { method: 'POST', body: b });
export const fleetBoot = (t, b) => jsonFetch('/api/fleet/boot', t, { method: 'POST', body: b });
export const createSession = (t, b) => jsonFetch('/api/sessions', t, { method: 'POST', body: b });
export const killSession = (t, name) => jsonFetch(`/api/sessions/${encodeURIComponent(name)}`, t, { method: 'DELETE' });
export const listDirs = (t, p) => jsonFetch(`/api/fs/dirs${p ? `?path=${encodeURIComponent(p)}` : ''}`, t);
