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
    nodes: [{ name: 'vps', label: 'VPS3', tunnel: { status: 'up' }, nodeId: ID }],
    remote: { vps: { sessions: [{ name: 'work' }, { name: 'cloud-dev' }] } },
    fleet: { vps: { available: true, capabilities: ['status', 'up', 'down', 'edit'],
      cells: [
        { cell: 'dev', tmuxSession: 'cloud-dev', engine: 'claude', active: true, boot: true },
        { cell: 'fork', tmuxSession: 'cloud-fork', engine: 'glm', active: false, boot: true },
      ] } },
    down: {},
  });
  const grp = g.find((x) => x.name === 'vps');
  assert.equal(grp.status, 'up');
  assert.equal(grp.fleetAvailable, true);
  assert.equal(grp.cells.length, 2);
  assert.equal(grp.cells.find((c) => c.cell === 'dev').active, true, 'cell attiva');
  assert.equal(grp.cells.find((c) => c.cell === 'fork').active, false, 'cell inattiva mostrata');
  // unmanaged = sessioni NON cloud-* (work); cloud-dev esclusa perche' e' una cell
  assert.deepEqual(grp.unmanaged.map((s) => s.name), ['work']);
});

test('inventario: Fleet resta visibile quando il nodo non ha un server tmux', async () => {
  const { buildNodeGroups } = await nodes();
  const groups = buildNodeGroups({
    nodes: [{ name: 'mac', label: 'Mac', tunnel: { status: 'up' }, nodeId: 'b'.repeat(32) }],
    remote: { mac: { error: 'tmux socket assente' } },
    fleet: { mac: { available: true, capabilities: ['status'], cells: [
      { cell: 'dev', tmuxSession: 'cloud-dev', engine: 'claude', active: true },
      { cell: 'fork', tmuxSession: 'cloud-fork', engine: 'codex-vl', active: false },
    ] } },
  });
  assert.equal(groups[0].status, 'up');
  assert.equal(groups[0].inventoryPartial, true);
  assert.equal(groups[0].sessionsAvailable, false);
  assert.deepEqual(groups[0].cells.map((cell) => cell.cell), ['dev', 'fork']);
  assert.deepEqual(groups[0].sessions, []);
});

test('inventario: chiavi route-qualified (nessuna collisione tra omonimi)', async () => {
  const { buildNodeGroups, positionKey } = await nodes();
  const g = buildNodeGroups({
    nodes: [
      { name: 'vps', tunnel: { status: 'up' }, nodeId: 'b'.repeat(32) },
      { name: 'mac', tunnel: { status: 'up' }, nodeId: 'c'.repeat(32) },
    ],
    remote: {
      vps: { sessions: [{ name: 'dev' }] },
      mac: { sessions: [{ name: 'dev' }] },
    },
    fleet: {
      vps: { available: true, cells: [{ cell: 'dev', tmuxSession: 'cloud-dev', engine: 'x', active: true }] },
      mac: { available: true, cells: [{ cell: 'dev', tmuxSession: 'cloud-dev', engine: 'y', active: true }] },
    },
    down: {},
  });
  const keys = g.flatMap((grp) => grp.cells.map((c) => c.key));
  assert.equal(new Set(keys).size, keys.length, 'chiavi cell univoche anche con cell omonime');
  // La chiave punta alla sessione tmux reale, non all'id logico della cella:
  // l'attach di `dev` aprirebbe un terminale vuoto al posto di `cloud-dev`.
  assert.ok(keys.includes('vps:cloud-dev'));
  assert.ok(keys.includes('mac:cloud-dev'));
  // positionKey: locale nuda, remota route-qualified
  assert.equal(positionKey([], 'x'), 'x');
  assert.equal(positionKey(['vps'], 'x'), 'vps:x');
  assert.equal(positionKey(['relay', 'phone'], 'x'), 'relay/phone:x');
});

test('inventario: backward-compat senza fleet -> cells vuote, sessions tutte le tmux', async () => {
  const { buildNodeGroups } = await nodes();
  const g = buildNodeGroups({
    nodes: [{ name: 'vps', tunnel: { status: 'up' }, nodeId: ID }],
    remote: { vps: { sessions: [{ name: 'cloud-dev' }, { name: 'work' }] } },
    down: {},
  });
  const grp = g.find((x) => x.name === 'vps');
  assert.deepEqual(grp.cells, [], 'senza fleet nessuna cell');
  assert.deepEqual(grp.sessions.map((s) => s.name), ['cloud-dev', 'work'], 'sessions = tutte le tmux (retrocompat)');
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

test('inventario: client inbound privato resta fuori dalla sidebar e non accumula downSince', async () => {
  const { buildNodeGroups, trackDown } = await nodes();
  const input = [{ name: 'phone', direction: 'inbound', roles: { client: true, node: false }, rolesKnown: true,
    tunnel: { status: 'passive' }, health: { status: 'passive', managed: false } }];
  assert.deepEqual(trackDown({ phone: 100 }, input, 200), {});
  const groups = buildNodeGroups({ nodes: input, remote: {}, down: { phone: 100 } });
  assert.deepEqual(groups, [], 'senza Share il client resta visibile solo in Settings > Nodes');
});

test('inventario: label umana usata quando presente (fallback a name)', async () => {
  const { buildNodeGroups } = await nodes();
  const withLabel = buildNodeGroups({
    nodes: [{ name: 'vps', label: 'VPS3 Server', tunnel: { status: 'up' }, nodeId: ID }],
    remote: { vps: { sessions: [] } }, down: {},
  });
  assert.equal(withLabel[0].label, 'VPS3 Server');
  const noLabel = buildNodeGroups({
    nodes: [{ name: 'vps', tunnel: { status: 'up' }, nodeId: ID }],
    remote: { vps: { sessions: [] } }, down: {},
  });
  assert.equal(noLabel[0].label, 'vps', 'fallback a name quando label assente');
});

test('inventario: capabilities propagate (per gating azioni Settings > Fleet)', async () => {
  const { buildNodeGroups } = await nodes();
  const g = buildNodeGroups({
    nodes: [{ name: 'vps', tunnel: { status: 'up' }, nodeId: ID }],
    remote: { vps: { sessions: [] } },
    fleet: { vps: { available: true, capabilities: ['status', 'up', 'down', 'restart', 'edit'], cells: [] } },
    down: {},
  });
  assert.deepEqual(g[0].capabilities, ['status', 'up', 'down', 'restart', 'edit']);
});

test('inventario: engines e route restano associati alle celle remote per il PowerSheet', async () => {
  const { buildNodeGroups } = await nodes();
  const groups = buildNodeGroups({
    nodes: [{ name: 'relay', nodeId: 'a'.repeat(32), tunnel: { status: 'up' } }],
    remote: { relay: { sessions: [] } },
    fleet: { relay: { available: true, capabilities: ['up', 'down'], engines: [{ id: 'claude.zai-p' }], cells: [{ cell: 'Worker', tmuxSession: 'cloud-Worker', active: false, engine: 'claude.zai-p' }] } },
  });
  assert.deepEqual(groups[0].engines, [{ id: 'claude.zai-p' }]);
  assert.deepEqual(groups[0].cells[0].route, ['relay']);
});
