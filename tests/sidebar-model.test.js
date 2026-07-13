'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const model = () => import('../frontend/src/lib/sidebar-model.js');

test('sidebar filters are explicit and invalid values fall back to all', async () => {
  const { normalizeSidebarFilter, sidebarItemVisible } = await model();
  assert.equal(normalizeSidebarFilter('pinned'), 'pinned');
  assert.equal(normalizeSidebarFilter('garbage'), 'all');
  assert.equal(sidebarItemVisible({ key: 'node:x', live: false }, ['node:x'], 'pinned'), true);
  assert.equal(sidebarItemVisible({ key: 'node:x', live: false }, [], 'active'), false);
  assert.equal(sidebarItemVisible({ key: 'node:x', live: false }, [], 'off'), true);
});

test('sidebar order is pin, live, recent activity, label and route-qualified key', async () => {
  const { sidebarItems } = await model();
  const rows = [
    { key: 'relay:z', label: 'Zed', live: false, activity: 9 },
    { key: 'relay:b', label: 'Beta', live: true, activity: 1 },
    { key: 'relay:a', label: 'Alpha', live: true, activity: 1 },
    { key: 'relay:p', label: 'Pinned', live: false, activity: 0 },
  ];
  assert.deepEqual(sidebarItems(rows, ['relay:p']).map((x) => x.key), [
    'relay:p', 'relay:a', 'relay:b', 'relay:z',
  ]);
  assert.deepEqual(sidebarItems(rows, [], 'active').map((x) => x.key), ['relay:a', 'relay:b']);
});
