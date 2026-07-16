'use strict';

// Focused coverage for the pure roster view-model shared by the desktop
// Sidebar and the mobile SessionList (frontend/src/lib/roster-view-model.js).
// No React/DOM: the model is normalization + health labels + relative time +
// fresh-output detection + per-position roster construction. localStorage is
// injected as a plain Map-backed object, exactly like tests/sidebar-model.test.js.

const { test } = require('node:test');
const assert = require('node:assert');

const model = () => import('../frontend/src/lib/roster-view-model.js');
const i18n = () => import('../frontend/src/lib/i18n.js');
const nodes = () => import('../frontend/src/lib/nodes-model.js');

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

test('rel formats compact relative time with an injectable "now"', async () => {
  const { rel } = await model();
  const NOW = 1_000_000;
  assert.equal(rel(0, NOW), '', 'falsy epoch is blank');
  assert.equal(rel(NOW, NOW), 'ora');
  assert.equal(rel(NOW - 59, NOW), 'ora', 'under a minute is ora');
  assert.equal(rel(NOW - 60, NOW), '1m', 'minute boundary');
  assert.equal(rel(NOW - 600, NOW), '10m');
  assert.equal(rel(NOW - 3599, NOW), '59m', 'just under an hour stays in minutes');
  assert.equal(rel(NOW - 3600, NOW), '1h', 'hour boundary');
  assert.equal(rel(NOW - 86399, NOW), '23h', 'just under a day stays in hours');
  assert.equal(rel(NOW - 86400, NOW), '1g', 'day boundary');
  assert.equal(rel(NOW - 172800, NOW), '2g');
  // Negative diff (clock skew / future epoch) clamps to ora, as the inline copies did.
  assert.equal(rel(NOW + 5, NOW), 'ora');
});

test('nodeStateLabel delegates to the shared i18n dictionary and interpolates relative time', async () => {
  const { nodeStateLabel, rel } = await model();
  const { t } = await i18n();
  // Non-time branches delegate verbatim to the dictionary, whatever the active lang.
  assert.equal(nodeStateLabel({ status: 'passive' }), t('node-passive'));
  assert.equal(nodeStateLabel({ status: 'down' }), t('tunnel-down'), 'down without downSince');
  assert.equal(nodeStateLabel({ status: 'unreachable' }), t('node-unreachable'));
  assert.equal(nodeStateLabel({ status: 'offline' }), t('node-offline'), 'offline without lastSeen');
  assert.equal(nodeStateLabel({ status: 'needs-repair' }), t('node-needs-repair'));
  // Unknown / absent status is silent (design §7: never an alarm for the model layer).
  assert.equal(nodeStateLabel({ status: 'up' }), '');
  assert.equal(nodeStateLabel({}), '');
  // Time-interpolating branches substitute {t} with rel(). ~90m ago lands in a
  // stable '1h' bucket so the two Date.now() reads cannot disagree across a boundary.
  const since = Math.floor(Date.now() / 1000) - 5400;
  assert.equal(
    nodeStateLabel({ status: 'down', downSince: since }),
    t('tunnel-down-since').replace('{t}', rel(since)),
    'down-since interpolates the relative age',
  );
  assert.equal(
    nodeStateLabel({ status: 'offline', lastSeen: since }),
    t('node-offline-seen').replace('{t}', rel(since)),
    'offline-seen interpolates the relative age',
  );
});

test('healthDot maps health to a dot class and preserves the desktop/mobile passive divergence', async () => {
  const { healthDot } = await model();
  assert.equal(healthDot(null), null);
  assert.equal(healthDot(undefined), null);
  assert.equal(healthDot({}), 'warn', 'absent status falls to warn');
  assert.equal(healthDot({ status: 'healthy' }), 'on', 'only a healthy probe is green');
  assert.equal(healthDot({ status: 'degraded' }), 'warn');
  assert.equal(healthDot({ status: 'down' }), 'warn');
  assert.equal(healthDot({ status: 'unknown' }), 'warn');
  // Desktop Sidebar default: a passive (expected-offline) client is NOT an alarm.
  assert.equal(healthDot({ status: 'passive' }), null);
  // Mobile SessionList override: passive historically rendered as warn.
  assert.equal(healthDot({ status: 'passive' }, { passive: 'warn' }), 'warn');
  // A healthy probe wins regardless of the passive override.
  assert.equal(healthDot({ status: 'healthy' }, { passive: 'warn' }), 'on');
});

test('healthTitle prefers detail then status, blank when absent', async () => {
  const { healthTitle } = await model();
  assert.equal(healthTitle(null), '');
  assert.equal(healthTitle({}), '');
  assert.equal(healthTitle({ status: 'down' }), 'down');
  assert.equal(healthTitle({ detail: 'probe 401' }), 'probe 401');
  assert.equal(healthTitle({ detail: 'probe 401', status: 'down' }), 'probe 401', 'detail wins over status');
});

test('hasFreshOutput reads the seen-marker from injectable storage', async () => {
  const { hasFreshOutput } = await model();
  const storage = makeStorage({ nc_seen_pos: '100' });
  assert.equal(hasFreshOutput(null, 'pos', storage), false, 'no session');
  assert.equal(hasFreshOutput({}, 'pos', storage), false, 'no outbox');
  assert.equal(hasFreshOutput({ outbox: { count: 0 } }, 'pos', storage), false, 'empty outbox');
  assert.equal(hasFreshOutput({ outbox: { count: 2, latest: 50 } }, 'pos', storage), false, 'latest not newer than seen');
  assert.equal(hasFreshOutput({ outbox: { count: 2, latest: 200 } }, 'pos', storage), true, 'latest newer than seen');
  // A missing marker reads as 0, so any positive latest is fresh.
  assert.equal(hasFreshOutput({ outbox: { count: 1, latest: 1 } }, 'never-seen', storage), true);
});

test('cellRuntime exposes one shared off, idle, working and legacy contract', async () => {
  const { cellRuntime } = await model();
  const { t } = await i18n();
  assert.deepEqual(
    cellRuntime({ tmux: false, model: 'claude-opus-4-1', engine: 'claude.native' }),
    { working: false, subtitle: 'claude.native · claude-opus-4-1' },
    'off cells show the configured startup engine and model',
  );
  assert.deepEqual(
    cellRuntime({ tmux: false, engine: 'codex.responses' }),
    { working: false, subtitle: 'codex.responses' },
    'off cells fall back to the startup engine when model is provider-default',
  );
  assert.deepEqual(
    cellRuntime({ tmux: true }, { working: false, paneTitle: 'Dev' }),
    { working: false, subtitle: t('cell-idle') },
  );
  assert.deepEqual(
    cellRuntime({ tmux: true }, { working: true, status: 'Implement activity UI' }),
    { working: true, subtitle: `${t('cell-working')} · Implement activity UI` },
  );
  assert.deepEqual(
    cellRuntime({ tmux: true }, { working: true, status: '' }),
    { working: true, subtitle: t('cell-working') },
  );
  assert.deepEqual(
    cellRuntime({ tmux: true }, { working: true, status: 'Working...' }),
    { working: true, subtitle: t('cell-working') },
    'Pi generic status is localized without a duplicated label',
  );
  assert.deepEqual(
    cellRuntime({ tmux: true }, { preview: 'older peer preview' }),
    { working: false, subtitle: 'older peer preview' },
    'older peers without an explicit boolean keep their preview and never fake working',
  );
});

test('buildLocalRoster normalizes cells and unmanaged with route-qualified local keys', async () => {
  const { buildLocalRoster } = await model();
  const { t } = await i18n();
  const { positionKey } = await nodes();
  const storage = makeStorage();
  const byName = new Map([
    ['local-live', {
      name: 'local-live', activity: 20, preview: 'p-live', working: true, status: 'Implement activity UI',
      outbox: { count: 1, latest: 5 },
    }],
  ]);
  const cells = [
    { cell: 'Live Cell', tmuxSession: 'local-live', tmux: true, engine: 'claude', key: 'K1' },
    { cell: 'Off Cell', tmuxSession: 'local-off', tmux: false, model: 'gpt-5.4' },
  ];
  const unmanaged = [
    { name: 'scratch', activity: 10, preview: 'p-scratch', cmd: 'vim', technical: false },
    { name: 'helper', activity: 0, technical: true },
  ];
  const items = buildLocalRoster(cells, unmanaged, byName, storage);
  assert.equal(items.length, 4);
  // Active cell: activity/preview from the matched session, fresh via seen-marker.
  assert.deepEqual(items[0], {
    type: 'cell', value: cells[0], key: positionKey([], 'local-live'), label: 'Live Cell',
    live: true, fresh: true, activity: 20, working: true, subtitle: `${t('cell-working')} · Implement activity UI`,
    searchText: 'claude K1 p-live Implement activity UI',
  });
  // Off cell: no matching session -> blank fresh/preview, key is the bare tmuxSession
  // (local position: positionKey([], id) === id), so the seen key matches the old
  // per-name marker the mobile home used before centralization.
  const off = items[1];
  assert.equal(off.key, 'local-off');
  assert.equal(off.label, 'Off Cell');
  assert.equal(off.live, false);
  assert.equal(off.fresh, false);
  assert.equal(off.activity, 0);
  assert.equal(off.working, false);
  assert.equal(off.subtitle, 'gpt-5.4');
  assert.equal(off.searchText, 'gpt-5.4');
  // Unmanaged tmux sessions.
  assert.deepEqual(items[2], {
    type: 'session', value: unmanaged[0], key: positionKey([], 'scratch'), label: 'scratch',
    live: true, technical: false, fresh: false, activity: 10, searchText: 'p-scratch vim',
  });
  assert.equal(items[3].type, 'session');
  assert.equal(items[3].technical, true);
  assert.equal(items[3].searchText, ' ', 'no preview/cmd -> single-space haystack');
  // Defensive: non-array inputs collapse to [].
  assert.deepEqual(buildLocalRoster(null, undefined, new Map(), storage), []);
  assert.deepEqual(buildLocalRoster([], [], new Map(), storage), []);
});

test('buildRemoteRoster qualifies keys with the node route and falls back to cell preview/activity', async () => {
  const { buildRemoteRoster } = await model();
  const { t } = await i18n();
  const { positionKey } = await nodes();
  const storage = makeStorage();
  const group = {
    route: ['relay'],
    sessions: [{ name: 'remote-live', activity: 30, preview: 'rp-live', working: false, paneTitle: 'Dev' }],
    cells: [
      { cell: 'Relay Live', tmuxSession: 'remote-live', tmux: true, engine: 'glm', key: 'G1' },
      { cell: 'Relay Orphan', tmuxSession: 'remote-x', tmux: false, preview: 'cp-orphan', activity: 2 },
    ],
    unmanaged: [{ name: 'remote-shell', activity: 15, preview: 'rp-shell', cmd: 'bash', technical: true }],
  };
  const { route, rawItems } = buildRemoteRoster(group, storage);
  assert.deepEqual(route, ['relay']);
  assert.equal(rawItems.length, 3);
  // Active remote cell: activity/preview from the matched session.
  assert.deepEqual(rawItems[0], {
    type: 'cell', value: group.cells[0], key: positionKey(['relay'], 'remote-live'), label: 'Relay Live',
    live: true, fresh: false, activity: 30, working: false, subtitle: t('cell-idle'),
    searchText: 'glm G1 rp-live',
  });
  // Orphan cell (no matching session): falls back to the cell's own activity/preview.
  const orphan = rawItems[1];
  assert.equal(orphan.key, positionKey(['relay'], 'remote-x'));
  assert.equal(orphan.activity, 2, 'cell.activity fallback when session missing');
  assert.equal(orphan.working, false);
  assert.equal(orphan.subtitle, group.cells[1].engine || t('cell-off'));
  assert.equal(orphan.searchText, 'cp-orphan', 'preview remains searchable while off subtitle wins');
  assert.equal(orphan.fresh, false);
  // Remote unmanaged session, route-qualified key.
  const shell = rawItems[2];
  assert.equal(shell.type, 'session');
  assert.equal(shell.key, positionKey(['relay'], 'remote-shell'));
  assert.equal(shell.technical, true);
  assert.equal(shell.searchText, 'rp-shell bash');
  // Defensive shapes: missing/non-array route collapses to an empty local-style roster.
  assert.deepEqual(buildRemoteRoster(undefined, storage), { route: [], rawItems: [] });
  assert.deepEqual(buildRemoteRoster({ route: 'nope' }, storage), { route: [], rawItems: [] });
});
