'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const prefs = () => import('../frontend/src/lib/node-preferences.js');

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}

test('node preferences use stable owner identity and route only as fallback', async () => {
  const { nodePreferenceKey } = await prefs();
  const id = 'a'.repeat(32);
  assert.equal(nodePreferenceKey({ instanceId: id, route: ['old-route'] }), `id:${id}`);
  assert.equal(nodePreferenceKey({ instanceId: id, route: ['new-route'] }), `id:${id}`);
  assert.equal(nodePreferenceKey({ route: ['relay', 'pixel'] }), 'route:relay/pixel');
});

test('aliases are local, strict and can reset without changing node identity', async () => {
  const { NODE_ALIASES_KEY, loadNodeAliases, nodeDisplayLabel, updateNodeAlias } = await prefs();
  const node = { instanceId: 'b'.repeat(32), name: 'pixel', label: 'Pixel canonical' };
  let aliases = updateNodeAlias({}, node, 'Pixel cucina');
  assert.equal(nodeDisplayLabel(node, aliases), 'Pixel cucina');
  assert.equal(node.name, 'pixel');
  assert.equal(node.instanceId, 'b'.repeat(32));
  aliases = updateNodeAlias(aliases, node, '');
  assert.equal(nodeDisplayLabel(node, aliases), 'Pixel canonical');
  const s = storage();
  s.setItem(NODE_ALIASES_KEY, JSON.stringify({ good: 'Mac', bad: 'line\nbreak', huge: 'x'.repeat(65) }));
  assert.deepEqual(loadNodeAliases(s), { good: 'Mac' });
});

test('node order persists independently from cell order and survives rename/route refresh', async () => {
  const { moveNodeGroup, nodePreferenceKey, orderNodeGroups, updateNodeAlias } = await prefs();
  const mac = { instanceId: 'a'.repeat(32), name: 'mac', label: 'Mac', route: ['mac'] };
  const pixel = { instanceId: 'b'.repeat(32), name: 'pixel', label: 'Pixel', route: ['hub', 'pixel'] };
  const groups = [mac, pixel];
  const order = moveNodeGroup([], nodePreferenceKey(pixel), nodePreferenceKey(mac), groups);
  assert.deepEqual(orderNodeGroups(groups, order).map((group) => group.name), ['pixel', 'mac']);
  const aliases = updateNodeAlias({}, pixel, 'Telefono');
  assert.equal(Object.keys(aliases)[0], nodePreferenceKey(pixel));
  const refreshedPixel = { ...pixel, route: ['other-hub', 'pixel'], status: 'offline' };
  assert.deepEqual(orderNodeGroups([mac, refreshedPixel], order).map((group) => group.name), ['pixel', 'mac']);
});
