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

test('inventario: Fleet stale conserva l\'ultimo elenco ma non lo spaccia per aggiornato', async () => {
  const { buildNodeGroups } = await nodes();
  const base = {
    nodes: [{ name: 'vps', tunnel: { status: 'up' }, nodeId: ID }],
    remote: { vps: { sessions: [{ name: 'cloud-dev' }] } },
  };
  const cell = { cell: 'dev', tmuxSession: 'cloud-dev', engine: 'claude', active: true };
  const full = buildNodeGroups({ ...base, fleet: { vps: { available: true, cells: [cell] } } });
  const stale = buildNodeGroups({ ...base, fleet: {
    vps: { available: false, fleetState: 'stale', cells: [cell] },
  } });
  const empty = buildNodeGroups({ ...base, fleet: {
    vps: { available: true, cells: [] },
  } });
  const disabled = buildNodeGroups({ ...base, fleet: {
    vps: { available: false, fleetState: 'disabled', cells: [] },
  } });

  assert.equal(full[0].fleetState, 'available');
  assert.deepEqual(stale[0].cells.map((item) => item.cell), ['dev']);
  assert.equal(stale[0].fleetState, 'stale');
  assert.equal(stale[0].fleetAvailable, false);
  assert.deepEqual(empty[0].cells, []);
  assert.equal(empty[0].fleetState, 'available');
  assert.deepEqual(disabled[0].cells, []);
  assert.equal(disabled[0].fleetState, 'disabled');
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
    fleet: { relay: { available: true, capabilities: ['up', 'down'], engines: [{ id: 'claude.zai-p' }], cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev', active: false, engine: 'claude.zai-p' }] } },
  });
  assert.deepEqual(groups[0].engines, [{ id: 'claude.zai-p' }]);
  assert.deepEqual(groups[0].cells[0].route, ['relay']);
});

// --- Celle preservate: il nodo cade, l'elenco resta finché la rimozione è VERA ---

test('celle preservate: nodo DOWN con ultimo elenco noto -> celle visibili e marcate', async () => {
  const { buildNodeGroups } = await nodes();
  const cells = [
    { cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude', active: true },
    { cell: 'Fork', tmuxSession: 'cloud-Fork', engine: 'codex', active: false },
    { cell: 'Research', tmuxSession: 'cloud-Research', engine: 'glm', active: true },
  ];
  const groups = buildNodeGroups({
    nodes: [{ name: 'vps', nodeId: 'a'.repeat(32), tunnel: { status: 'down' } }],
    fleet: { vps: { available: false, fleetState: 'stale', cells } },
    down: {},
  });
  const grp = groups[0];
  assert.equal(grp.status, 'down', 'ramo esercitato: nodo diretto caduto');
  assert.equal(grp.cells.length, 3, 'le 3 celle dell\'ultimo elenco restano visibili');
  assert.equal(grp.cellsPreserved, true, 'il gruppo dichiara l\'elenco preservato');
  assert.equal(grp.fleetState, 'stale');
  assert.ok(grp.cells.every((c) => c.preserved === true), 'ogni cella è marcata preserved');
  assert.ok(grp.cells.every((c) => Array.isArray(c.route) && c.route[0] === 'vps'), 'identità route-qualified mantenuta');
});

test('celle preservate: nodo OFFLINE (topology stale) conserva l\'ultimo elenco', async () => {
  const { buildNodeGroups } = await nodes();
  const groups = buildNodeGroups({
    nodes: [],
    topology: [{ route: ['vps'], stale: true, lastSeen: 111 }],
    fleet: { vps: { available: false, fleetState: 'stale', cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev', active: true }] } },
    down: {},
  });
  const grp = groups[0];
  assert.equal(grp.status, 'offline', 'ramo esercitato: nodo federato stale (il caso «OFFLINE» del sintomo)');
  assert.equal(grp.cellsPreserved, true);
  assert.equal(grp.cells.length, 1);
  assert.equal(grp.cells[0].preserved, true);
});

test('celle preservate: P2 — il ritorno con dato autorevole SOSTITUISCE, non unisce', async () => {
  const { buildNodeGroups } = await nodes();
  const tre = [
    { cell: 'Dev', tmuxSession: 'cloud-Dev', active: true },
    { cell: 'Fork', tmuxSession: 'cloud-Fork', active: true },
    { cell: 'Research', tmuxSession: 'cloud-Research', active: true },
  ];
  const due = tre.slice(0, 2);
  const giu = buildNodeGroups({
    nodes: [{ name: 'vps', nodeId: 'a'.repeat(32), tunnel: { status: 'down' } }],
    fleet: { vps: { available: false, fleetState: 'stale', cells: tre } },
    down: {},
  });
  assert.equal(giu[0].cells.length, 3, 'da giù si parte con 3 conservate');
  const su = buildNodeGroups({
    nodes: [{ name: 'vps', nodeId: 'a'.repeat(32), tunnel: { status: 'up' } }],
    remote: { vps: { sessions: [{ name: 'cloud-Dev' }] } },
    fleet: { vps: { available: true, fleetState: 'available', cells: due } },
    down: {},
  });
  assert.equal(su[0].status, 'up');
  assert.equal(su[0].cellsPreserved, undefined, 'nessuna conservazione con dato fresco');
  assert.deepEqual(su[0].cells.map((c) => c.cell), ['Dev', 'Fork'], 'la terza cella SPARISCE (rimozione vera)');
  assert.ok(su[0].cells.every((c) => c.preserved === undefined));
});

test('celle preservate: P4 — la caduta di un nodo non tocca l\'elenco dell\'altro', async () => {
  const { buildNodeGroups } = await nodes();
  const groups = buildNodeGroups({
    nodes: [
      { name: 'a', nodeId: 'a'.repeat(32), tunnel: { status: 'down' } },
      { name: 'b', nodeId: 'b'.repeat(32), tunnel: { status: 'up' } },
    ],
    remote: { b: { sessions: [{ name: 'cloud-X' }] } },
    fleet: {
      a: { available: false, fleetState: 'stale', cells: [{ cell: 'A1', tmuxSession: 'cloud-A1', active: true }] },
      b: { available: true, cells: [{ cell: 'B1', tmuxSession: 'cloud-X', active: true }] },
    },
    down: {},
  });
  const ga = groups.find((g) => g.name === 'a');
  const gb = groups.find((g) => g.name === 'b');
  assert.equal(ga.status, 'down');
  assert.deepEqual(ga.cells.map((c) => c.cell), ['A1'], 'A conserva le proprie');
  assert.equal(ga.cellsPreserved, true);
  assert.equal(gb.status, 'up');
  assert.deepEqual(gb.cells.map((c) => c.cell), ['B1'], 'B resta col proprio elenco vivo');
  assert.equal(gb.cellsPreserved, undefined);
});

test('celle preservate: nodo mai visto giù -> nessuna cella fantasma', async () => {
  const { buildNodeGroups } = await nodes();
  const groups = buildNodeGroups({
    nodes: [{ name: 'nuovo', nodeId: 'c'.repeat(32), tunnel: { status: 'down' } }],
    fleet: {},
    down: {},
  });
  assert.equal(groups[0].status, 'down');
  assert.equal(groups[0].cellsPreserved, undefined, 'senza ultimo elenco noto niente conservazione');
  assert.deepEqual(groups[0].cells, []);
});
