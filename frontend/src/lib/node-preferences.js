// Local-only node presentation preferences. They never enter federation or
// backend state: identity and routing remain instanceId/name/route, while each
// browser can choose its own label and node-group order.

export const NODE_ALIASES_KEY = 'nc_node_aliases_v1';
export const NODE_ORDER_KEY = 'nc_node_order_v1';
export const NODE_ALIAS_MAX = 64;

const OWNER_ID_RE = /^[a-f0-9]{16,64}$/;

export function nodePreferenceKey(node) {
  if (OWNER_ID_RE.test(String(node?.instanceId || ''))) return `id:${node.instanceId}`;
  const route = Array.isArray(node?.route) ? node.route.filter((part) => typeof part === 'string' && part) : [];
  if (route.length) return `route:${route.map(encodeURIComponent).join('/')}`;
  return typeof node?.name === 'string' && node.name ? `name:${encodeURIComponent(node.name)}` : '';
}

export function cleanNodeAlias(value) {
  if (typeof value !== 'string') return null;
  const alias = value.trim();
  if (!alias) return '';
  if (alias.length > NODE_ALIAS_MAX || /[\x00-\x1f\x7f]/.test(alias)) return null;
  return alias;
}

export function loadNodeAliases(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage.getItem(NODE_ALIASES_KEY));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [key, value] of Object.entries(raw).slice(0, 128)) {
      const clean = cleanNodeAlias(value);
      if (typeof key === 'string' && key.length <= 192 && clean) out[key] = clean;
    }
    return out;
  } catch (_) { return {}; }
}

export function saveNodeAliases(aliases, storage = globalThis.localStorage) {
  try { storage.setItem(NODE_ALIASES_KEY, JSON.stringify(aliases)); } catch (_) {}
  return aliases;
}

export function updateNodeAlias(aliases, node, value) {
  const key = nodePreferenceKey(node);
  const clean = cleanNodeAlias(value);
  if (!key || clean === null) return aliases;
  const next = { ...(aliases || {}) };
  if (clean) next[key] = clean; else delete next[key];
  return next;
}

export function nodeDisplayLabel(node, aliases = {}) {
  return aliases[nodePreferenceKey(node)] || node?.label || node?.name || '';
}

export function loadNodeOrder(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage.getItem(NODE_ORDER_KEY));
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter((key) => typeof key === 'string' && key && key.length <= 192))].slice(0, 128);
  } catch (_) { return []; }
}

export function saveNodeOrder(order, storage = globalThis.localStorage) {
  try { storage.setItem(NODE_ORDER_KEY, JSON.stringify(order)); } catch (_) {}
  return order;
}

export function orderNodeGroups(groups = [], order = []) {
  const rank = new Map(order.map((key, index) => [key, index]));
  return groups.map((group, index) => ({ group, index })).sort((a, b) => {
    const ar = rank.has(nodePreferenceKey(a.group)) ? rank.get(nodePreferenceKey(a.group)) : Number.MAX_SAFE_INTEGER;
    const br = rank.has(nodePreferenceKey(b.group)) ? rank.get(nodePreferenceKey(b.group)) : Number.MAX_SAFE_INTEGER;
    return ar - br || a.index - b.index;
  }).map(({ group }) => group);
}

export function moveNodeGroup(order, source, target, groups = []) {
  if (!source || !target || source === target) return order;
  const available = groups.map(nodePreferenceKey).filter(Boolean);
  if (!available.includes(source) || !available.includes(target)) return order;
  const base = [...order.filter((key) => available.includes(key)), ...available.filter((key) => !order.includes(key))];
  const sourceIndex = base.indexOf(source); const targetIndex = base.indexOf(target);
  base.splice(sourceIndex, 1);
  const targetAfterRemoval = base.indexOf(target);
  base.splice(sourceIndex < targetIndex ? targetAfterRemoval + 1 : targetAfterRemoval, 0, source);
  return base;
}
