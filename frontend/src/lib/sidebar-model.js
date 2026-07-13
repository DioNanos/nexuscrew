// Pure sidebar roster model.  Every item has a route-qualified `key`, a
// human-readable `label`, a `live` flag and optional `activity` epoch.

export const SIDEBAR_FILTERS = ['all', 'pinned', 'active', 'off'];
export const SIDEBAR_VIEW_KEY = 'nc_sidebar_views_v1';

export function normalizeSidebarFilter(value) {
  return SIDEBAR_FILTERS.includes(value) ? value : 'all';
}

export function sidebarItemVisible(item, pins = [], filter = 'all') {
  const mode = normalizeSidebarFilter(filter);
  if (mode === 'pinned') return pins.includes(item.key);
  if (mode === 'active') return !!item.live;
  if (mode === 'off') return !item.live;
  return true;
}

// Stable order inside every position: explicit pin order, live before off,
// most recent activity, then the visible name and finally the identity key.
export function compareSidebarItems(a, b, pins = []) {
  const ai = pins.indexOf(a.key); const bi = pins.indexOf(b.key);
  const ap = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
  const bp = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
  return ap - bp
    || Number(!!b.live) - Number(!!a.live)
    || Number(!!b.fresh) - Number(!!a.fresh)
    || Number(b.activity || 0) - Number(a.activity || 0)
    || String(a.label || '').localeCompare(String(b.label || ''))
    || String(a.key || '').localeCompare(String(b.key || ''));
}

export function loadSidebarViews(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage.getItem(SIDEBAR_VIEW_KEY));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (_) { return {}; }
}

export function sidebarView(views, key) {
  return {
    open: views?.[key]?.open !== false,
    filter: normalizeSidebarFilter(views?.[key]?.filter),
  };
}

export function saveSidebarViews(views, storage = globalThis.localStorage) {
  try { storage.setItem(SIDEBAR_VIEW_KEY, JSON.stringify(views)); } catch (_) {}
  return views;
}

export function sidebarSearchVisible(item, query = '') {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return true;
  const haystack = [item.label, item.key, item.searchText]
    .filter(Boolean).join(' ').toLocaleLowerCase();
  return haystack.includes(needle);
}

export function sidebarItems(items = [], pins = [], filter = 'all') {
  return [...items]
    .filter((item) => sidebarItemVisible(item, pins, filter))
    .sort((a, b) => compareSidebarItems(a, b, pins));
}
