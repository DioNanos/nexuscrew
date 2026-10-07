import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// The quick cell list must show the rows of the main list: same per-node
// mode, same order, both in its default (per-node) mode and in "all". The
// «active» pill is an extra ROW gate on top of the node filter: whatever the
// saved preference of a node is (including none, which reads as 'all'), an
// off cell never passes the pill — only live rows and active degraded cells
// do — while "all" lifts the gate and restores the exact main list rows.
// Fixtures: a generic federated client — a local node, a directly connected
// hub whose fleet view comes back empty (scoped peer view), a two-hop node
// in "pinned" mode, an unreachable node, a node with NO saved preference,
// active and inactive cells in every group. The expected side is computed
// with the exact model the main list uses (orderNodeGroups ->
// buildLocalRoster/buildRemoteRoster -> sidebarItems with the per-node view
// filter) plus the pill gate in default mode.

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(), fleetStatus: vi.fn(), getRouteSessions: vi.fn(),
  getLiveHost: vi.fn(), designateHostCell: vi.fn(), clearHostCell: vi.fn(),
  useNodesState: vi.fn(),
}));
vi.mock('../lib/api.js', () => ({
  apiFetch: mocks.apiFetch, fleetStatus: mocks.fleetStatus, getRouteSessions: mocks.getRouteSessions,
  getLiveHost: mocks.getLiveHost, designateHostCell: mocks.designateHostCell, clearHostCell: mocks.clearHostCell,
}));
vi.mock('../hooks/useNodes.js', () => ({ useNodesState: mocks.useNodesState }));
vi.mock('./Terminal.jsx', () => ({ default: (props) => (
  <div data-testid="peek-term" data-session={props.session} />
) }));
vi.mock('./CellPanel.jsx', () => ({ default: () => <div data-testid="peek-panel" /> }));

import CellSwitcher from './CellSwitcher.jsx';
import { writeCellSwitcherSnapshot } from '../lib/cell-switcher-cache.js';
import { positionKey } from '../lib/nodes-model.js';
import { orderNodeGroups } from '../lib/node-preferences.js';
import { buildLocalRoster, buildRemoteRoster } from '../lib/roster-view-model.js';
import { sidebarItems, sidebarView, loadSidebarViews, sidebarOrder, loadSidebarOrders } from '../lib/sidebar-model.js';

const active = (cell, tmuxSession) => ({ cell, tmuxSession, active: true, tmux: true, engine: 'claude.native' });
const off = (cell, tmuxSession) => ({ cell, tmuxSession, active: false, tmux: false, engine: 'shell.local' });

const hubId = 'a'.repeat(32);
const nodeBId = 'b'.repeat(32);
const deadId = 'c'.repeat(32);
const plainId = 'e'.repeat(32);

const HUB = ['hub1'];
const TWO_HOP = ['hub1', 'node-b'];
const DEAD = ['dead1'];
const PLAIN = ['plain1'];
const keyOf = (route, tmux) => positionKey(route, tmux);

// The node groups the main list model produces for this client: the direct
// hub is up but its fleet view is EMPTY for the scoped peer (cells: []) and
// only its sessions are known; the two-hop node carries a full cell list;
// the unreachable node keeps its last known cells as preserved; the plain
// node has NO saved view (its filter reads as 'all') and mixes an active and
// an inactive cell, so the «active» pill gate has to drop the off one.
const NODE_GROUPS = [
  { route: HUB, label: 'hub-node', instanceId: hubId, direct: true, status: 'up',
    sessions: [{ name: 'h1', activity: 5, key: 'hub1:h1', node: 'hub1', route: HUB }],
    unmanaged: [{ name: 'h1', activity: 5 }], cells: [] },
  { route: TWO_HOP, label: 'NODE-B', instanceId: nodeBId, direct: false, status: 'up',
    sessions: [{ name: 'm1', activity: 4, key: 'hub1/node-b:m1', node: 'hub1/node-b', route: TWO_HOP }],
    cells: [active('NodeB-One', 'm1'), off('NodeB-Two', 'm2'), active('NodeB-Three', 'm3')] },
  { route: DEAD, label: 'offline-node', instanceId: deadId, direct: false, status: 'unreachable',
    sessions: [], cellsPreserved: true,
    cells: [active('Dead-One', 'd1'), off('Dead-Two', 'd2')].map((c) => ({ ...c, preserved: true })) },
  { route: PLAIN, label: 'plain-node', instanceId: plainId, direct: false, status: 'up',
    sessions: [{ name: 'p1', activity: 2, key: 'plain1:p1', node: 'plain1', route: PLAIN }],
    cells: [active('Plain-One', 'p1'), off('Plain-Two', 'p2')] },
];

const LOCAL_CELLS = [active('Loc-One', 'loc-one'), off('Loc-Two', 'loc-two')];
const LOCAL_SESSIONS = [
  { name: 'loc-one', activity: 10, working: true },
  { name: 'loc-scratch', activity: 3 }, // tmux unmanaged: nessuna cella la possiede
];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  writeCellSwitcherSnapshot({
    sessions: LOCAL_SESSIONS, cells: LOCAL_CELLS, localFresh: true,
    nodeGroups: NODE_GROUPS,
  });
  localStorage.setItem('nc_node_order_v1', JSON.stringify([`id:${hubId}`, `id:${nodeBId}`, `id:${deadId}`, `id:${plainId}`]));
  // Nessuna vista per 'plain1': e' il nodo senza preferenza salvata.
  localStorage.setItem('nc_sidebar_views_v1', JSON.stringify({
    local: { filter: 'active' }, hub1: { filter: 'active' }, 'hub1/node-b': { filter: 'pinned' }, dead1: { filter: 'active' },
  }));
  localStorage.setItem('nc_pins', JSON.stringify([keyOf(TWO_HOP, 'm1')]));
  localStorage.setItem('nc_sidebar_order_v1', JSON.stringify({ 'hub1/node-b': [keyOf(TWO_HOP, 'm1')] }));
  mocks.useNodesState.mockReturnValue({ groups: NODE_GROUPS, hasLoaded: true });
  mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: LOCAL_SESSIONS }) });
  mocks.getRouteSessions.mockImplementation(async (_t, route) => {
    if (route.join('/') === 'hub1') return { sessions: [{ name: 'h1', activity: 5 }] };
    if (route.join('/') === 'hub1/node-b') return { sessions: [{ name: 'm1', activity: 4 }] };
    if (route.join('/') === 'plain1') return { sessions: [{ name: 'p1', activity: 2 }] };
    return { sessions: [] };
  });
  mocks.fleetStatus.mockImplementation(async (_t, route = []) => {
    if (!route.length) return { available: true, cells: LOCAL_CELLS };
    if (route.join('/') === 'hub1') return { available: true, cells: [] };
    if (route.join('/') === 'hub1/node-b') return { available: true, cells: NODE_GROUPS[1].cells };
    if (route.join('/') === 'plain1') return { available: true, cells: NODE_GROUPS[3].cells };
    return Promise.reject(new Error('unreachable'));
  });
});

// The «active» pill gate of the drawer, mirrored on the expected side: an off
// row never passes the pill whatever the saved node filter is; an active
// degraded cell does (visible, not selectable). Same predicate as
// CellSwitcher's visibleRows.
const pillKeeps = (item) => item.live === true
  || (item.type === 'cell' && item.value?.degraded === true && item.value?.active === true);

// The main list, computed with its own functions on the same data and prefs
// (plus the pill gate when the drawer is in its default mode).
function mainListRows({ drawerAll = false, nodeGroups = NODE_GROUPS } = {}) {
  const order = orderNodeGroups(nodeGroups, JSON.parse(localStorage.getItem('nc_node_order_v1') || '[]'));
  const pins = JSON.parse(localStorage.getItem('nc_pins') || '[]');
  const views = loadSidebarViews();
  const orders = loadSidebarOrders();
  const filterFor = (position) => (drawerAll ? 'all' : sidebarView(views, position).filter);

  const cellSessions = new Set(LOCAL_CELLS.map((c) => c.tmuxSession).filter(Boolean));
  const byName = new Map(LOCAL_SESSIONS.map((s) => [s.name, s]));
  const localRaw = buildLocalRoster(LOCAL_CELLS, LOCAL_SESSIONS.filter((s) => !cellSessions.has(s.name)), byName);
  const out = [];
  for (const item of sidebarItems(localRaw, pins, filterFor('local'), sidebarOrder(orders, 'local'))) {
    if (!drawerAll && !pillKeeps(item)) continue;
    out.push({ position: 'local', key: item.key, session: item.type === 'cell' ? item.value.tmuxSession : item.value.name });
  }
  for (const g of order) {
    const route = Array.isArray(g.route) ? g.route : [];
    if (!route.length || g.kind === 'vl') continue;
    const position = route.join('/');
    const { rawItems } = buildRemoteRoster(g);
    for (const item of sidebarItems(rawItems, pins, filterFor(position), sidebarOrder(orders, position))) {
      if (!drawerAll && !pillKeeps(item)) continue;
      out.push({ position, key: item.key, session: item.type === 'cell' ? (item.value.tmuxSession || item.value.cell) : item.value.name });
    }
  }
  return out;
}

const positions = () => [...document.querySelectorAll('.nc-cell-switcher-position')].map((e) => e.textContent);
const rowKeys = () => [...document.querySelectorAll('[data-roster-key]')].map((e) => e.dataset.rosterKey);

async function renderSwitcher() {
  render(<CellSwitcher token="token" current={{}} localNodeLabel="NODE-LOCAL"
    onPick={vi.fn()} onClose={vi.fn()} pollMs={150} />);
  await screen.findByRole('button', { name: /^Loc-One / });
  await waitFor(() => expect(positions().length + rowKeys().length).toBeGreaterThanOrEqual(2), { timeout: 4000 });
  await new Promise((r) => setTimeout(r, 400));
  return { positions, rowKeys };
}

describe('cold open: the node groups are there at once', () => {
  it('retires the cold snapshot when the first published model is empty', async () => {
    mocks.useNodesState.mockReturnValue({ groups: [], hasLoaded: false });
    const props = { token: 'token', current: {}, localNodeLabel: 'NODE-LOCAL', onPick: vi.fn(), onClose: vi.fn() };
    const view = render(<CellSwitcher {...props} />);
    await screen.findByRole('button', { name: /^Loc-One / });
    expect(rowKeys()).toEqual(mainListRows().map(r => r.key));
    mocks.useNodesState.mockReturnValue({ groups: [], hasLoaded: true });
    view.rerender(<CellSwitcher {...props} />);
    expect(rowKeys()).toEqual(mainListRows({ nodeGroups: [] }).map(r => r.key));
  });

  it('follows an empty main model after populated groups without reviving the snapshot', async () => {
    const props = { token: 'token', current: {}, localNodeLabel: 'NODE-LOCAL', onPick: vi.fn(), onClose: vi.fn() };
    const view = render(<CellSwitcher {...props} />);
    await screen.findByRole('button', { name: /^Loc-One / });
    expect(rowKeys()).toEqual(mainListRows().map(r => r.key));
    mocks.useNodesState.mockReturnValue({ groups: [], hasLoaded: true });
    view.rerender(<CellSwitcher {...props} />);
    expect(rowKeys()).toEqual(mainListRows({ nodeGroups: [] }).map(r => r.key));
    expect(screen.queryByText('hub-node')).toBeNull();
    expect(screen.queryByText('NODE-B')).toBeNull();
  });

  it('with useNodes still empty, the snapshot seeds hub and two-hop groups in the main list order', async () => {
    // Apertura a freddo nella vista singola mobile: la lista principale e'
    // smontata e useNodes non ha ancora pubblicato. L'ultimo snapshot della
    // principale porta i gruppi: devono comparire SUBITO, senza attendere un
    // giro, nello stesso ordine e con le stesse righe della principale.
    mocks.useNodesState.mockReturnValue({ groups: [], hasLoaded: false });
    const expected = mainListRows();
    render(<CellSwitcher token="token" current={{}} localNodeLabel="NODE-LOCAL"
      onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Loc-One / });
    // Nessuna attesa aggiuntiva: il seme e' sincrono con il primo render.
    expect(rowKeys()).toEqual(expected.map((r) => r.key));
    expect(expected.some((r) => r.position === 'hub1')).toBe(true);
    expect(expected.some((r) => r.position === 'hub1/node-b')).toBe(true);
  });
});

const labelOf = (position) => ({ local: 'NODE-LOCAL', hub1: 'hub-node', 'hub1/node-b': 'NODE-B', dead1: 'offline-node', plain1: 'plain-node' }[position]);

describe('quick list shows exactly the main list rows', () => {
  it('default mode: same rows, same order, same groups (scoped hub, pinned two-hop, unreachable)', async () => {
    const expected = mainListRows();
    // Sanity on the expected side: the scoped hub still shows its live
    // session, the pinned two-hop shows only the pinned cell, the
    // unreachable node shows nothing, the local group shows the live cell.
    expect([...new Set(expected.map((r) => r.position))]).toEqual(['local', 'hub1', 'hub1/node-b', 'plain1']);
    // The no-preference node reads as 'all': its OFF cell passes the node
    // filter, and only the «active» pill drops it.
    expect(expected.some((r) => r.key === keyOf(PLAIN, 'p2'))).toBe(false);
    expect(expected.some((r) => r.key === keyOf(PLAIN, 'p1'))).toBe(true);
    // La tmux unmanaged locale e' una riga della principale in modalita' attiva:
    // il drawer la mostra perche' e solo perche' la mostra la principale.
    expect(expected.some((r) => r.key === 'loc-scratch')).toBe(true);
    const { positions: pos, rowKeys: rk } = await renderSwitcher();
    expect(rk()).toEqual(expected.map((r) => r.key));
    const seen = [];
    for (const row of document.querySelectorAll('[data-roster-key]')) {
      const position = row.dataset.position;
      if (!seen.includes(position)) seen.push(position);
    }
    expect(seen).toEqual([...new Set(expected.map((r) => r.position))]);
    expect(pos().length).toBe(new Set(expected.map((r) => r.position)).size);
  });

  it('all mode: same rows as the main list with every filter opened', async () => {
    const { rowKeys: rk } = await renderSwitcher();
    const toggle = await screen.findByRole('button', { name: /all|tutti/i });
    fireEvent.click(toggle);
    await waitFor(() => expect(rk().length).toBeGreaterThan(3), { timeout: 4000 });
    const expected = mainListRows({ drawerAll: true });
    expect(expected.length).toBeGreaterThan(3); // off cells and preserved rows are back
    expect(expected.some((r) => r.key === keyOf(PLAIN, 'p2'))).toBe(true); // the pill gate is lifted
    expect(rk()).toEqual(expected.map((r) => r.key));
  });
});
