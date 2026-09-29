import { apiFetch } from './api.js';
import { readPref, writePref } from './pref-store.js';
import { appendOrderJournal } from './order-journal.js';
import { loadPins } from './pins.js';
import { loadSidebarOrders, loadSidebarViews, SIDEBAR_ORDER_KEY, SIDEBAR_VIEW_KEY } from './sidebar-model.js';
import { loadNodeOrder, NODE_ORDER_KEY } from './node-preferences.js';

// Copia per-dispositivo delle preferenze sul nodo: pin, ordini, viste, ordine nodi. Serve a ritrovarle se lo
// storage del browser viene svuotato. Regole: il token non fa mai parte delle preferenze; il primo sync non carica
// mai un insieme vuoto; una copia locale non vuota non viene mai sostituita da quella del server senza una scelta.
export const DEVICE_KEY = 'nc_device_id_v1';
export const SYNC_KEY = 'nc_prefs_sync_v1';
const CHANGE_EVENT = 'nexuscrew-roster-preferences';
const DEVICE_RE = /^[a-f0-9]{32}$/;
const MAX_KEY = 192; const MAX_LIST = 256; const MAX_POSITIONS = 128;
const FILE_KIND = 'nexuscrew-preferences';

const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const keyOk = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s);
const keyList = (v, max = MAX_LIST) => Array.isArray(v) && v.length <= max && v.every((k) => keyOk(k, MAX_KEY));

// Stessa whitelist del server: chiavi sconosciute => null.
export function normalizePrefs(raw) {
  if (!plain(raw) || Object.keys(raw).some((k) => !['pins', 'orders', 'views', 'nodeOrder'].includes(k))) return null;
  const out = { pins: [], orders: {}, views: {}, nodeOrder: [] };
  if (raw.pins !== undefined) { if (!keyList(raw.pins)) return null; out.pins = [...new Set(raw.pins)]; }
  if (raw.nodeOrder !== undefined) { if (!keyList(raw.nodeOrder, 128)) return null; out.nodeOrder = [...new Set(raw.nodeOrder)]; }
  if (raw.orders !== undefined) {
    if (!plain(raw.orders) || Object.keys(raw.orders).length > MAX_POSITIONS) return null;
    for (const [pos, list] of Object.entries(raw.orders)) { if (!keyOk(pos, 96) || !keyList(list)) return null; out.orders[pos] = [...new Set(list)]; }
  }
  if (raw.views !== undefined) {
    if (!plain(raw.views) || Object.keys(raw.views).length > MAX_POSITIONS) return null;
    for (const [pos, v] of Object.entries(raw.views)) {
      if (!keyOk(pos, 96) || !plain(v)) return null;
      const view = {};
      if (v.open !== undefined) { if (typeof v.open !== 'boolean') return null; view.open = v.open; }
      if (v.filter !== undefined) { if (!keyOk(v.filter, 16)) return null; view.filter = v.filter; }
      out.views[pos] = view;
    }
  }
  return out;
}

export const isEmptyPrefs = (d) => !d || (!(d.pins || []).length && !(d.nodeOrder || []).length
  && !Object.keys(d.orders || {}).length && !Object.keys(d.views || {}).length);

export function collectPrefs(storage) {
  const raw = { pins: loadPins(), orders: loadSidebarOrders(storage), views: loadSidebarViews(storage), nodeOrder: loadNodeOrder(storage) };
  return normalizePrefs(raw) || { pins: [], orders: {}, views: {}, nodeOrder: [] };
}

const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : plain(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v));
export const hashPrefs = (d) => { const s = stable(normalizePrefs(d) || {}); let h = 2166136261; for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };

// Scrive le quattro chiavi (passando dal pref-store: il grezzo illeggibile non si perde) e avvisa i consumatori.
// Tutto o niente: se una scrittura fallisce le chiavi gia' scritte tornano al valore di prima, cosi' non resta uno stato
// a meta' (che al giro dopo sembrerebbe un conflitto). Ritorna null se ok, l'errore (con la causa) altrimenti.
const PREF_KEYS = ['nc_pins', SIDEBAR_ORDER_KEY, SIDEBAR_VIEW_KEY, NODE_ORDER_KEY];
export function applyPrefs(data, { storage, note = 'restore' } = {}) {
  const d = normalizePrefs(data); if (!d) return new Error('preferenze non valide');
  let s = storage; try { s = s || globalThis.localStorage; } catch (e) { return e; }
  const before = {};
  for (const key of PREF_KEYS) { try { before[key] = s.getItem(key); } catch (_) { before[key] = null; } }
  const values = { nc_pins: d.pins, [SIDEBAR_ORDER_KEY]: d.orders, [SIDEBAR_VIEW_KEY]: d.views, [NODE_ORDER_KEY]: d.nodeOrder };
  for (const key of PREF_KEYS) {
    const error = writePref(key, values[key], { storage });
    if (error) {
      for (const k of PREF_KEYS) {
        try { if (before[k] === null || before[k] === undefined) s.removeItem(k); else s.setItem(k, before[k]); } catch (_) { /* best effort */ }
      }
      appendOrderJournal({ reason: 'prefs-restore-failed', key, note: String(error && error.message || error).slice(0, 120) });
      return error;
    }
  }
  appendOrderJournal({ reason: 'prefs-restore', note, after: d.pins });
  try { window.dispatchEvent(new Event(CHANGE_EVENT)); } catch (_) { /* fuori dal browser */ }
  return null;
}

const writeFailed = (error) => ({ status: 'error', code: 'storage-write-failed', note: String(error && error.message || error).slice(0, 120) });

const ls = (storage) => { try { return storage || globalThis.localStorage; } catch (_) { return null; } };
const getDevice = (storage) => { try { const v = ls(storage)?.getItem(DEVICE_KEY); return DEVICE_RE.test(v || '') ? v : ''; } catch (_) { return ''; } };
const setDevice = (id, storage) => { try { ls(storage)?.setItem(DEVICE_KEY, id); } catch (_) { /* storage rifiutato: si richiede al prossimo avvio */ } };
// Un id che arriva dal link (#device=) si adotta SOLO se questo browser non ne ha gia' uno.
export function adoptDeviceId(id, storage) { if (DEVICE_RE.test(id || '') && !getDevice(storage)) setDevice(id, storage); }
export const currentDeviceId = getDevice;

const readSync = (storage) => readPref(SYNC_KEY, { storage, fallback: () => null, parse: (v) => (plain(v) ? v : undefined) });
const writeSync = (revision, data, storage) => writePref(SYNC_KEY, { revision, hash: hashPrefs(data), at: Date.now() }, { storage });

export function tokenRequest(token) {
  return async (method, path, { headers = {}, body } = {}) => apiFetch(path, token, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body, timeoutMs: 8000 });
}

async function ensureDevice(request, storage) {
  let id = getDevice(storage);
  if (!id) {
    const r = await request('POST', '/api/prefs/devices');
    if (r.status !== 201) throw Object.assign(new Error(`device ${r.status}`), { status: r.status });
    id = (await r.json()).deviceId; if (!DEVICE_RE.test(id || '')) throw new Error('device non valido');
    setDevice(id, storage);
  }
  return id;
}

async function put(request, id, data, revision, storage) {
  const r = await request('PUT', '/api/prefs', { headers: { 'x-nc-device': id, 'if-match': `"${revision}"` }, body: JSON.stringify({ data }) });
  if (r.status === 200) { const j = await r.json(); writeSync(j.revision, data, storage); return { status: 'uploaded', revision: j.revision }; }
  const j = await r.json().catch(() => ({}));
  if (r.status === 409 && j.current) return { status: 'conflict', revision: j.current.revision, conflict: { local: data, server: normalizePrefs(j.current.data) || null, revision: j.current.revision, deviceId: id } };
  return { status: 'error', code: j.code || `http-${r.status}` };
}

// Un giro completo: mai un'eccezione, esito dichiarato.
//   uploaded | restored | synced | conflict | offline | error
export async function syncPrefs({ request, token, storage } = {}) {
  const req = request || tokenRequest(token);
  try {
    let id = await ensureDevice(req, storage);
    let r = await req('GET', '/api/prefs', { headers: { 'x-nc-device': id } });
    if (r.status === 404) { // il nodo non conosce piu' questo id (dati persi): se ne chiede uno nuovo, le preferenze locali restano
      try { ls(storage)?.removeItem(DEVICE_KEY); } catch (_) { /* best effort */ }
      id = await ensureDevice(req, storage);
      r = await req('GET', '/api/prefs', { headers: { 'x-nc-device': id } });
    }
    if (r.status !== 200) return { status: 'error', code: `http-${r.status}` };
    const server = await r.json();
    const local = collectPrefs(storage); const serverData = normalizePrefs(server.data);
    if (!serverData) {
      if (isEmptyPrefs(local)) return { status: 'synced', revision: server.revision };
      return put(req, id, local, server.revision, storage);
    }
    if (isEmptyPrefs(local)) {
      const failure = applyPrefs(serverData, { storage });
      if (failure) return writeFailed(failure); // la copia del nodo resta intatta e la revisione non avanza: si ritenta al prossimo giro
      writeSync(server.revision, serverData, storage);
      return { status: 'restored', revision: server.revision };
    }
    if (hashPrefs(local) === hashPrefs(serverData)) { writeSync(server.revision, local, storage); return { status: 'synced', revision: server.revision }; }
    const last = readSync(storage);
    if (last && last.revision === server.revision && last.hash !== hashPrefs(local)) return put(req, id, local, server.revision, storage);
    return { status: 'conflict', revision: server.revision, conflict: { local, server: serverData, revision: server.revision, deviceId: id } };
  } catch (error) {
    return { status: 'offline', note: String(error?.message || error).slice(0, 120) };
  }
}

export async function resolveConflict(choice, conflict, { request, token, storage } = {}) {
  if (!conflict) return { status: 'error', code: 'no-conflict' };
  const req = request || tokenRequest(token);
  try {
    if (choice === 'server') {
      if (!conflict.server) return { status: 'error', code: 'no-server-copy' };
      const failure = applyPrefs(conflict.server, { storage, note: 'restore-from-server' });
      if (failure) return writeFailed(failure);
      writeSync(conflict.revision, conflict.server, storage);
      return { status: 'restored', revision: conflict.revision };
    }
    return await put(req, conflict.deviceId || getDevice(storage), conflict.local, conflict.revision, storage);
  } catch (error) { return { status: 'offline', note: String(error?.message || error).slice(0, 120) }; }
}

// Backup a file: solo le preferenze (mai token, mai diario).
export function exportPrefs(storage) {
  return JSON.stringify({ kind: FILE_KIND, version: 1, exportedAt: new Date().toISOString(), data: collectPrefs(storage) }, null, 2);
}

export function importPrefs(text, { storage } = {}) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return { ok: false, reason: 'not-json' }; }
  if (!plain(parsed) || parsed.kind !== FILE_KIND || parsed.version !== 1) return { ok: false, reason: 'wrong-kind' };
  const data = normalizePrefs(parsed.data);
  if (!data) return { ok: false, reason: 'bad-schema' };
  const failure = applyPrefs(data, { storage, note: 'import' });
  if (failure) return { ok: false, reason: 'storage-write-failed', note: String(failure && failure.message || failure).slice(0, 120) };
  return { ok: true, data };
}
