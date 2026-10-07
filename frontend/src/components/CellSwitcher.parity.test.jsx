import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// The quick cell list must show EXACTLY the rows of the main list: same
// per-node mode, same order, both in its default (per-node) mode and in
// "all". Fixtures: a generic federated client — a local node, a directly
// connected hub whose fleet view comes back empty (scoped peer view), a
// two-hop node in "pinned" mode, an unreachable node, active and inactive
// cells in every group. The expected side is computed with the exact model
// the main list uses (orderNodeGroups -> buildLocalRoster/buildRemoteRoster
// -> sidebarItems with the per-node view filter).

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(), fleetStatus: vi.fn(), getRouteSessions: vi.fn(),
  getLiveHost: vi.fn(), designateHostCell: vi.fn(), clearHostCell: vi.fn(),
  useNodes: vi.fn(),
}));
vi.mock('../lib/api.js', () => ({
  apiFetch: mocks.apiFetch, fleetStatus: mocks.fleetStatus, getRouteSessions: mocks.getRouteSessions,
  getLiveHost: mocks.getLiveHost, designateHostCell: mocks.designateHostCell, clearHostCell: mocks.clearHostCell,
}));
vi.mock('../hooks/useNodes.js', () => ({ useNodes: mocks.useNodes }));
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
const mgmId = 'b'.repeat(32);
const deadId = 'c'.repeat(32);

const HUB = ['hub1'];
const MGM = ['hub1', 'mgm'];
const DEAD = ['dead1'];
const keyOf = (route, tmux) => positionKey(route, tmux);

// The node groups the main list model produces for this client: the direct
// hub is up but its fleet view is EMPTY for the scoped peer (cells: []) and
// only its sessions are known; the two-hop node carries a full cell list;
// the unreachable node keeps its last known cells as preserved.
const NODE_GROUPS = [
  { route: HUB, label: 'HUB1', instanceId: hubId, direct: true, status: 'up',
    sessions: [{ name: 'h1', activity: 5, key: 'hub1:h1', node: 'hub1', route: HUB }],
    unmanaged: [{ name: 'h1', activity: 5 }], cells: [] },
  { route: MGM, label: 'MGM2', instanceId: mgmId, direct: false, status: 'up',
    sessions: [{ name: 'm1', activity: 4, key: 'hub1/mgm:m1', node: 'hub1/mgm', route: MGM }],
    cells: [active('Mgm-One', 'm1'), off('Mgm-Two', 'm2'), active('Mgm-Three', 'm3')] },
  { route: DEAD, label: 'DEAD1', instanceId: deadId, direct: false, status: 'unreachable',
    sessions: [], cellsPreserved: true,
    cells: [active('Dead-One', 'd1'), off('Dead-Two', 'd2')].map((c) => ({ ...c, preserved: true })) },
];

const LOCAL_CELLS = [active('Loc-One', 'loc-one'), off('Loc-Two', 'loc-two')];
const LOCAL_SESSIONS = [{ name: 'loc-one', activity: 10, working: true }];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  writeCellSwitcherSnapshot({
    sessions: LOCAL_SESSIONS, cells: LOCAL_CELLS, localFresh: true,
    nodeGroups: NODE_GROUPS,
  });
  localStorage.setItem('nc_node_order_v1', JSON.stringify([`id:${hubId}`, `id:${mgmId}`, `id:${deadId}`]));
  localStorage.setItem('nc_sidebar_views_v1', JSON.stringify({
    local: { filter: 'active' }, hub1: { filter: 'active' }, 'hub1/mgm': { filter: 'pinned' }, dead1: { filter: 'active' },
  }));
  localStorage.setItem('nc_pins', JSON.stringify([keyOf(MGM, 'm1')]));
  localStorage.setItem('nc_sidebar_order_v1', JSON.stringify({ 'hub1/mgm': [keyOf(MGM, 'm1')] }));
  mocks.useNodes.mockReturnValue(NODE_GROUPS);
  mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: LOCAL_SESSIONS }) });
  mocks.getRouteSessions.mockImplementation(async (_t, route) => {
    if (route.join('/') === 'hub1') return { sessions: [{ name: 'h1', activity: 5 }] };
    if (route.join('/') === 'hub1/mgm') return { sessions: [{ name: 'm1', activity: 4 }] };
    return { sessions: [] };
  });
  mocks.fleetStatus.mockImplementation(async (_t, route = []) => {
    if (!route.length) return { available: true, cells: LOCAL_CELLS };
    if (route.join('/') === 'hub1') return { available: true, cells: [] };
    if (route.join('/') === 'hub1/mgm') return { available: true, cells: NODE_GROUPS[1].cells };
    return Promise.reject(new Error('unreachable'));
  });
});

// The main list, computed with its own functions on the same data and prefs.
function mainListRows({ drawerAll = false } = {}) {
  const order = orderNodeGroups(NODE_GROUPS, JSON.parse(localStorage.getItem('nc_node_order_v1') || '[]'));
  const pins = JSON.parse(localStorage.getItem('nc_pins') || '[]');
  const views = loadSidebarViews();
  const orders = loadSidebarOrders();
  const filterFor = (position) => (drawerAll ? 'all' : sidebarView(views, position).filter);

  const cellSessions = new Set(LOCAL_CELLS.map((c) => c.tmuxSession).filter(Boolean));
  const byName = new Map(LOCAL_SESSIONS.map((s) => [s.name, s]));
  const localRaw = buildLocalRoster(LOCAL_CELLS, LOCAL_SESSIONS.filter((s) => !cellSessions.has(s.name)), byName);
  const out = [];
  for (const item of sidebarItems(localRaw, pins, filterFor('local'), sidebarOrder(orders, 'local'))) {
    out.push({ position: 'local', key: item.key, session: item.type === 'cell' ? item.value.tmuxSession : item.value.name });
  }
  for (const g of order) {
    const route = Array.isArray(g.route) ? g.route : [];
    if (!route.length || g.kind === 'vl') continue;
    const position = route.join('/');
    const { rawItems } = buildRemoteRoster(g);
    for (const item of sidebarItems(rawItems, pins, filterFor(position), sidebarOrder(orders, position))) {
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

const labelOf = (position) => ({ local: 'NODE-LOCAL', hub1: 'HUB1', 'hub1/mgm': 'MGM2', dead1: 'DEAD1' }[position]);

describe('quick list shows exactly the main list rows', () => {
  it('default mode: same rows, same order, same groups (scoped hub, pinned two-hop, unreachable)', async () => {
    const expected = mainListRows();
    // Sanity on the expected side: the scoped hub still shows its live
    // session, the pinned two-hop shows only the pinned cell, the
    // unreachable node shows nothing, the local group shows the live cell.
    expect(expected.map((r) => r.position)).toEqual(['local', 'hub1', 'hub1/mgm']);
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
    expect(rk()).toEqual(expected.map((r) => r.key));
  });
});
