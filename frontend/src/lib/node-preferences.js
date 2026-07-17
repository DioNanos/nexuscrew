// Local-only node ordering. Labels are deliberately excluded: a node name has
// one canonical, server-backed source shared by Settings, the roster and peers.
export const NODE_ORDER_KEY = 'nc_node_order_v1';

const OWNER_ID_RE = /^[a-f0-9]{16,64}$/;

export function nodePreferenceKey(node) {
  if (OWNER_ID_RE.test(String(node?.instanceId || ''))) return `id:${node.instanceId}`;
  const route = Array.isArray(node?.route) ? node.route.filter((part) => typeof part === 'string' && part) : [];
  if (route.length) return `route:${route.map(encodeURIComponent).join('/')}`;
  return typeof node?.name === 'string' && node.name ? `name:${encodeURIComponent(node.name)}` : '';
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
