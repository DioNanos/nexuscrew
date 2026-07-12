'use strict';
// tests/inventory.test.js — inventario Hydra globale: per ogni posizione (Locale
// implicito + ogni route) la PWA compone celle Fleet (attive E inattive, con
// engine/active/boot) + tmux unmanaged, con chiavi route-qualified (no collisioni
// tra omonimi su posizioni diverse). Verifica anche backward-compat (sessions
// resta tutte le tmux) e che le cloud-* vengano classificate come cells.
const { test } = require('node:test');
const assert = require('node:assert');
const nodes = () => import('../frontend/src/lib/nodes-model.js');

const ID = 'a'.repeat(32);

test('inventario: posizione remota con fleet mostra cells attive+inattive e unmanaged', async () => {
  const { buildNodeGroups } = await nodes();
  const g = buildNodeGroups({
    nodes: [{ name: 'relay', label: 'Remote Relay', tunnel: { status: 'up' }, nodeId: ID }],
    remote: { relay: { sessions: [{ name: 'work' }, { name: 'cloud-build' }] } },
    fleet: { relay: { available: true, capabilities: ['status', 'up', 'down', 'edit'],
      cells: [
        { cell: 'build', tmuxSession: 'cloud-build', engine: 'claude', active: true, boot: true },
        { cell: 'review', tmuxSession: 'cloud-review', engine: 'glm', active: false, boot: true },
      ] } },
    down: {},
  });
  const grp = g.find((x) => x.name === 'relay');
  assert.equal(grp.status, 'up');
  assert.equal(grp.fleetAvailable, true);
  assert.equal(grp.cells.length, 2);
  assert.equal(grp.cells.find((c) => c.cell === 'build').active, true, 'cell attiva');
  assert.equal(grp.cells.find((c) => c.cell === 'review').active, false, 'cell inattiva mostrata');
  // unmanaged = sessioni NON cloud-* (work); cloud-build esclusa perche' e' una cell
  assert.deepEqual(grp.unmanaged.map((s) => s.name), ['work']);
});

test('inventario: chiavi route-qualified (nessuna collisione tra omonimi)', async () => {
  const { buildNodeGroups, positionKey } = await nodes();
  const g = buildNodeGroups({
    nodes: [
      { name: 'relay', tunnel: { status: 'up' }, nodeId: 'b'.repeat(32) },
      { name: 'laptop', tunnel: { status: 'up' }, nodeId: 'c'.repeat(32) },
    ],
    remote: {
      relay: { sessions: [{ name: 'build' }] },
      laptop: { sessions: [{ name: 'build' }] },
    },
    fleet: {
      relay: { available: true, cells: [{ cell: 'build', tmuxSession: 'cloud-build', engine: 'x', active: true }] },
      laptop: { available: true, cells: [{ cell: 'build', tmuxSession: 'cloud-build', engine: 'y', active: true }] },
    },
    down: {},
  });
  const keys = g.flatMap((grp) => grp.cells.map((c) => c.key));
  assert.equal(new Set(keys).size, keys.length, 'chiavi cell univoche anche con cell omonime');
  assert.ok(keys.includes('relay:build'));
  assert.ok(keys.includes('laptop:build'));
  // positionKey: locale nuda, remota route-qualified
  assert.equal(positionKey([], 'x'), 'x');
  assert.equal(positionKey(['relay'], 'x'), 'relay:x');
  assert.equal(positionKey(['relay', 'phone'], 'x'), 'relay/phone:x');
});

test('inventario: backward-compat senza fleet -> cells vuote, sessions tutte le tmux', async () => {
  const { buildNodeGroups } = await nodes();
  const g = buildNodeGroups({
    nodes: [{ name: 'relay', tunnel: { status: 'up' }, nodeId: ID }],
    remote: { relay: { sessions: [{ name: 'cloud-build' }, { name: 'work' }] } },
    down: {},
  });
  const grp = g.find((x) => x.name === 'relay');
  assert.deepEqual(grp.cells, [], 'senza fleet nessuna cell');
  assert.deepEqual(grp.sessions.map((s) => s.name), ['cloud-build', 'work'], 'sessions = tutte le tmux (retrocompat)');
});

test('inventario: nodo degradato (down/unreachable) -> cells vuote, niente crash', async () => {
  const { buildNodeGroups } = await nodes();
  const g = buildNodeGroups({
    nodes: [{ name: 'down', tunnel: { status: 'down' } }],
    remote: {}, fleet: { down: { available: true, cells: [{ cell: 'x', tmuxSession: 'cloud-x', active: true }] } },
    down: { down: 100 },
  });
  const grp = g.find((x) => x.name === 'down');
  assert.equal(grp.status, 'down');
  assert.deepEqual(grp.cells, []);
  assert.deepEqual(grp.unmanaged, []);
});

test('inventario: label umana usata quando presente (fallback a name)', async () => {
  const { buildNodeGroups } = await nodes();
  const withLabel = buildNodeGroups({
    nodes: [{ name: 'relay', label: 'Remote Server', tunnel: { status: 'up' }, nodeId: ID }],
    remote: { relay: { sessions: [] } }, down: {},
  });
  assert.equal(withLabel[0].label, 'Remote Server');
  const noLabel = buildNodeGroups({
    nodes: [{ name: 'relay', tunnel: { status: 'up' }, nodeId: ID }],
    remote: { relay: { sessions: [] } }, down: {},
  });
  assert.equal(noLabel[0].label, 'relay', 'fallback a name quando label assente');
});

test('inventario: capabilities propagate (per gating azioni Settings > Fleet)', async () => {
  const { buildNodeGroups } = await nodes();
  const g = buildNodeGroups({
    nodes: [{ name: 'relay', tunnel: { status: 'up' }, nodeId: ID }],
    remote: { relay: { sessions: [] } },
    fleet: { relay: { available: true, capabilities: ['status', 'up', 'down', 'restart', 'edit'], cells: [] } },
    down: {},
  });
  assert.deepEqual(g[0].capabilities, ['status', 'up', 'down', 'restart', 'edit']);
});

test('inventario: engines e route restano associati alle celle remote per il PowerSheet', async () => {
  const { buildNodeGroups } = await nodes();
  const groups = buildNodeGroups({
    nodes: [{ name: 'relay', nodeId: 'a'.repeat(32), tunnel: { status: 'up' } }],
    remote: { relay: { sessions: [] } },
    fleet: { relay: { available: true, capabilities: ['up', 'down'], engines: [{ id: 'claude.zai-p' }], cells: [{ cell: 'Build', tmuxSession: 'cloud-Build', active: false, engine: 'claude.zai-p' }] } },
  });
  assert.deepEqual(groups[0].engines, [{ id: 'claude.zai-p' }]);
  assert.deepEqual(groups[0].cells[0].route, ['relay']);
});
