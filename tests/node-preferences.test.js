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

test('node order persists independently from cell order and survives rename/route refresh', async () => {
  const { moveNodeGroup, nodePreferenceKey, orderNodeGroups } = await prefs();
  const mac = { instanceId: 'a'.repeat(32), name: 'mac', label: 'Mac', route: ['mac'] };
  const pixel = { instanceId: 'b'.repeat(32), name: 'pixel', label: 'Pixel', route: ['hub', 'pixel'] };
  const groups = [mac, pixel];
  const order = moveNodeGroup([], nodePreferenceKey(pixel), nodePreferenceKey(mac), groups);
  assert.deepEqual(orderNodeGroups(groups, order).map((group) => group.name), ['pixel', 'mac']);
  const refreshedPixel = { ...pixel, route: ['other-hub', 'pixel'], status: 'offline' };
  assert.deepEqual(orderNodeGroups([mac, refreshedPixel], order).map((group) => group.name), ['pixel', 'mac']);
});
