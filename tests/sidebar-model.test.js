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

test('sidebar order promotes fresh output after liveness and before activity', async () => {
  const { sidebarItems } = await model();
  const rows = [
    { key: 'old-live', label: 'Old live', live: true, fresh: false, activity: 99 },
    { key: 'fresh-live', label: 'Fresh live', live: true, fresh: true, activity: 1 },
    { key: 'fresh-off', label: 'Fresh off', live: false, fresh: true, activity: 100 },
  ];
  assert.deepEqual(sidebarItems(rows).map((x) => x.key), ['fresh-live', 'old-live', 'fresh-off']);
});

test('sidebar view persistence and search are shared by desktop and mobile', async () => {
  const {
    SIDEBAR_VIEW_KEY, loadSidebarViews, saveSidebarViews, sidebarSearchVisible, sidebarView,
  } = await model();
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const saved = saveSidebarViews({ local: { open: false, filter: 'active' } }, storage);
  assert.equal(values.has(SIDEBAR_VIEW_KEY), true);
  assert.deepEqual(loadSidebarViews(storage), saved);
  assert.deepEqual(sidebarView(saved, 'local'), { open: false, filter: 'active' });
  assert.deepEqual(sidebarView(saved, 'missing'), { open: true, filter: 'all' });
  const item = { label: 'Build', key: 'relay:build', searchText: 'codex-vl release' };
  assert.equal(sidebarSearchVisible(item, 'CODEX'), true);
  assert.equal(sidebarSearchVisible(item, 'missing'), false);
});
