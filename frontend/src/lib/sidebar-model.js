import { readPref, writePref } from './pref-store.js';

// Pure sidebar roster model.  Every item has a route-qualified `key`, a
// human-readable `label`, a `live` flag and optional `activity` epoch.

export const SIDEBAR_FILTERS = ['all', 'pinned', 'active', 'off', 'technical'];
export const SIDEBAR_VIEW_KEY = 'nc_sidebar_views_v1';
export const SIDEBAR_ORDER_KEY = 'nc_sidebar_order_v1';

export function normalizeSidebarFilter(value) {
  return SIDEBAR_FILTERS.includes(value) ? value : 'all';
}

export function sidebarItemVisible(item, pins = [], filter = 'all') {
  const mode = normalizeSidebarFilter(filter);
  if (mode === 'technical') return item.technical === true;
  if (item.technical === true) return false;
  if (mode === 'pinned') return pins.includes(item.key);
  if (mode === 'active') return !!item.live;
  if (mode === 'off') return !item.live;
  return true;
}

// Stable order inside every position: explicit pin order, live before off,
// most recent activity, then the visible name and finally the identity key.
export function compareSidebarItems(a, b, pins = [], order = []) {
  const ai = pins.indexOf(a.key); const bi = pins.indexOf(b.key);
  const ap = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
  const bp = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
  const ao = order.indexOf(a.key); const bo = order.indexOf(b.key);
  const ar = ao === -1 ? Number.MAX_SAFE_INTEGER : ao;
  const br = bo === -1 ? Number.MAX_SAFE_INTEGER : bo;
  return ap - bp
    || ar - br
    || Number(!!b.live) - Number(!!a.live)
    || Number(!!b.fresh) - Number(!!a.fresh)
    || Number(b.activity || 0) - Number(a.activity || 0)
    || String(a.label || '').localeCompare(String(b.label || ''))
    || String(a.key || '').localeCompare(String(b.key || ''));
}

export function loadSidebarOrders(storage = globalThis.localStorage) {
  return readPref(SIDEBAR_ORDER_KEY, {
    storage, fallback: () => ({}),
    parse: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
      const out = {};
      for (const [position, keys] of Object.entries(raw).slice(0, 64)) {
        if (typeof position !== 'string' || !position || position.length > 160 || !Array.isArray(keys)) continue;
        const clean = [...new Set(keys.filter((key) => typeof key === 'string' && key && key.length <= 256))].slice(0, 128);
        if (clean.length) out[position] = clean;
      }
      return out;
    },
  });
}

export function sidebarOrder(orders, position) {
  return Array.isArray(orders?.[position]) ? orders[position] : [];
}

export function saveSidebarOrders(orders, storage = globalThis.localStorage) {
  writePref(SIDEBAR_ORDER_KEY, orders, { storage });
  return orders;
}

// Sposta source nella posizione occupata da target. Se source era sopra target
// viene inserita dopo target; se era sotto viene inserita prima: anche lo scambio
// di due elementi adiacenti funziona in entrambe le direzioni.
export function moveSidebarItem(orders, position, source, target, availableKeys = []) {
  if (typeof position !== 'string' || !position || source === target) return orders;
  const available = [...new Set(availableKeys.filter((key) => typeof key === 'string' && key))];
  if (!available.includes(source) || !available.includes(target)) return orders;
  // Le chiavi salvate ma non visibili ORA (nodo in errore, cella spenta non ancora letta) restano nell'ordine:
  // scartarle cancellava la posizione scelta dall'utente al primo spostamento (roster parziale).
  const stored = sidebarOrder(orders, position);
  const base = [...stored, ...available.filter((key) => !stored.includes(key))];
  const sourceIndex = base.indexOf(source);
  const targetIndex = base.indexOf(target);
  base.splice(sourceIndex, 1);
  const targetAfterRemoval = base.indexOf(target);
  const insertAt = sourceIndex < targetIndex ? targetAfterRemoval + 1 : targetAfterRemoval;
  base.splice(insertAt, 0, source);
  return { ...orders, [position]: base };
}

export function loadSidebarViews(storage = globalThis.localStorage) {
  return readPref(SIDEBAR_VIEW_KEY, {
    storage, fallback: () => ({}),
    parse: (raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined),
  });
}

export function sidebarView(views, key) {
  return {
    open: views?.[key]?.open !== false,
    filter: normalizeSidebarFilter(views?.[key]?.filter),
  };
}

export function saveSidebarViews(views, storage = globalThis.localStorage) {
  writePref(SIDEBAR_VIEW_KEY, views, { storage });
  return views;
}

export function sidebarSearchVisible(item, query = '') {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return true;
  const haystack = [item.label, item.key, item.searchText]
    .filter(Boolean).join(' ').toLocaleLowerCase();
  return haystack.includes(needle);
}

export function sidebarItems(items = [], pins = [], filter = 'all', order = []) {
  return [...items]
    .filter((item) => sidebarItemVisible(item, pins, filter))
    .sort((a, b) => compareSidebarItems(a, b, pins, order));
}
