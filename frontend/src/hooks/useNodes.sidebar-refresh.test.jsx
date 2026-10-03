import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, within } from '@testing-library/react';
const api = vi.hoisted(() => ({ getNodes: vi.fn(), getTopology: vi.fn(), getNodeAliases: vi.fn(), getRouteSessions: vi.fn(), fleetStatus: vi.fn(), getVlNodes: vi.fn(), getRouteConfig: vi.fn(), ROSTER_READ_TIMEOUT_MS: 8000 }));
vi.mock('../lib/api.js', () => api);
vi.mock('../components/Terminal.jsx', () => ({ default: () => null }));
vi.mock('../components/CellPanel.jsx', () => ({ default: () => null }));
vi.mock('../components/CellPeek.jsx', () => ({ default: () => null }));
import Sidebar from '../components/Sidebar.jsx';
import { useNodes } from './useNodes.js';
import { buildRemoteRoster } from '../lib/roster-view-model.js';
const localId = 'a'.repeat(32), hubId = 'b'.repeat(32), leafId = 'c'.repeat(32), siblingId = 'd'.repeat(32);
const hub = { name: 'hub', label: 'Hub', nodeId: hubId, paired: true, tunnel: { status: 'up' } };
const leaf = { name: 'leaf', label: 'Leaf', instanceId: leafId, route: ['hub', 'leaf'] };
const sibling = { name: 'sibling', label: 'Sibling', instanceId: siblingId, route: ['hub', 'sibling'] };
const payload = (name = 'worker') => ({ sessions: [{ name, preview: 'ready' }] });
const fleet = (name = 'worker') => ({ available: true, cells: [{ cell: 'Worker', tmuxSession: name, tmux: true, active: true }] });
const pending = [];
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); promise.catch(() => {}); const d = { promise, resolve, reject }; pending.push(d); return d; }
function round() { return { config: deferred(), nodes: deferred(), topology: deferred(), sessions: Object.fromEntries(['hub', 'hub/leaf', 'hub/sibling'].map(k => [k, deferred()])), fleet: Object.fromEntries(['hub', 'hub/leaf', 'hub/sibling'].map(k => [k, deferred()])) }; }
let current, snapshots;
function Harness({ token = 'token', refreshKey = '' }) { snapshots = useNodes(token, true, refreshKey); return <Sidebar cells={[{ cell: 'Local Worker', tmuxSession: 'local-worker', tmux: true }]} sessions={[{ name: 'local-worker' }]} localNodeId={localId} nodeGroups={snapshots} />; }
const flush = async () => { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };
const tick = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const group = (id = leafId) => snapshots.find(g => g.instanceId === id);
function nodeDom(container, label = 'Leaf') { return within(container).getByText(label, { selector: 'b' }).closest('.nc-node-order-wrap'); }
function assertLive(container, at, label = 'Leaf', id = leafId) {
  const node = nodeDom(container, label);
  expect(node.querySelector('.nc-node-title > .nc-dot').classList.contains('on')).toBe(true);
  const card = within(node).getByText('Worker', { selector: 'b' }).closest('.nc-cell');
  expect(card.classList.contains('live')).toBe(true); expect(card.classList.contains('preserved')).toBe(false);
  expect(group(id)).toMatchObject({ status: 'up', verifiedAt: at });
  expect(buildRemoteRoster(group(id)).rawItems.find(r => r.type === 'cell').live).toBe(true);
  return card;
}
async function discovery(order, includeSibling = false) {
  const responses = { config: { instanceId: localId }, nodes: { nodes: [hub] }, topology: { nodes: includeSibling ? [leaf, sibling] : [leaf] } };
  for (const name of order) { current[name].resolve(responses[name]); await flush(); }
}
async function settle(includeSibling = false) { for (const key of includeSibling ? ['hub', 'hub/leaf', 'hub/sibling'] : ['hub', 'hub/leaf']) { current.sessions[key].resolve(payload()); current.fleet[key].resolve(fleet()); } await flush(); }
async function healthy(includeSibling = false) { const r = render(<Harness />); await discovery(['config', 'nodes', 'topology'], includeSibling); await settle(includeSibling); return r; }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); vi.resetAllMocks(); localStorage.clear(); localStorage.setItem('nc_lang', 'en'); current = round(); snapshots = [];
  api.getRouteConfig.mockImplementation(() => current.config.promise); api.getNodes.mockImplementation(() => current.nodes.promise); api.getTopology.mockImplementation(() => current.topology.promise);
  api.getRouteSessions.mockImplementation((_, route) => current.sessions[route.join('/')].promise); api.fleetStatus.mockImplementation((_, route) => current.fleet[route.join('/')].promise);
  api.getNodeAliases.mockResolvedValue({ aliasesByInstanceId: {} }); api.getVlNodes.mockResolvedValue({ nodes: [] });
});
afterEach(() => { cleanup(); for (const d of pending.splice(0)) d.resolve({ nodes: [], sessions: [], available: true, cells: [] }); vi.useRealTimers(); });

it.each([['nodes', 'topology', 'config'], ['config', 'nodes', 'topology'], ['topology', 'config', 'nodes']])('keeps the live sidebar snapshot across refresh discovery order %j', async (...args) => {
  const order = args.slice(0, 3); const { container } = await healthy(); assertLive(container, group().verifiedAt);
  for (let cycle = 0; cycle < 2; cycle++) {
    const at = group().verifiedAt; const card = assertLive(container, at);
    current = round(); await tick(4000); await discovery(order);
    // Both primary sources are still unresolved: this is the actual regression window.
    expect(group().checking).toBe(true); expect(assertLive(container, at)).toBe(card);
    current.fleet['hub/leaf'].resolve(fleet('new-worker')); await flush();
    expect(group().cells[0].tmuxSession).toBe('new-worker'); expect(group().sessions[0].name).toBe('worker'); expect(group().sessionsPending).toBe(true); expect(group().verifiedAt).toBe(at);
    await settle();
  }
});
it('publishes a healthy sibling while a leaf and hub reads remain pending', async () => {
  const { container } = await healthy(true); const at = group().verifiedAt;
  current = round(); await tick(4000); await discovery(['nodes', 'topology', 'config'], true);
  assertLive(container, at); assertLive(container, at, 'Sibling', siblingId);
  current.sessions['hub/sibling'].resolve(payload('new-sibling')); current.fleet['hub/sibling'].resolve(fleet('new-sibling')); await flush();
  expect(group(siblingId).sessions[0].name).toBe('new-sibling'); expect(group().sessionsPending).toBe(true); assertLive(container, at); await settle(true);
});
it.each([{ available: true, cells: [] }, { available: false, reason: 'disabled' }])('does not revive cached fleet after an authoritative empty outcome %j', async outcome => {
  const { container } = await healthy(); const at = group().verifiedAt;
  current = round(); await tick(4000); await discovery(['nodes', 'topology', 'config']); assertLive(container, at);
  current.fleet['hub/leaf'].resolve(outcome); await flush();
  expect(group().cells).toEqual([]); expect(group().verifiedAt).toBe(at); expect(group().sessionsPending).toBe(true); expect(nodeDom(container).querySelector('.nc-cell')).toBeNull(); await settle();
});
it('keeps an unverified new route pending and never paints it live', async () => {
  const { container } = render(<Harness />); await discovery(['nodes', 'topology', 'config']);
  expect(group().status).toBe('pending'); expect(nodeDom(container).querySelector('.nc-node-title > .nc-dot').classList.contains('on')).toBe(false); expect(nodeDom(container).querySelector('.nc-cell')).toBeNull(); await settle();
});
it('confirmed stale topology overrides in-flight reads without degrading its healthy sibling', async () => {
  const { container } = await healthy(true); current = round(); await tick(4000);
  current.config.resolve({ instanceId: localId }); current.nodes.resolve({ nodes: [hub] }); await flush();
  current.topology.resolve({ nodes: [{ ...leaf, stale: true }, sibling] }); await flush();
  expect(group().status).toBe('offline'); expect(group().cellsPreserved).toBe(true); expect(nodeDom(container).querySelector('.nc-cell').classList.contains('preserved')).toBe(true);
  expect(group(siblingId).status).toBe('up'); expect(nodeDom(container, 'Sibling').querySelector('.nc-node-title > .nc-dot').classList.contains('on')).toBe(true); await settle(true);
});
it('prepares every leaf before publishing a hub that is already in backoff', async () => {
  const { container } = await healthy(true);
  for (let cycle = 0; cycle < 2; cycle++) {
    current = round(); await tick(4000); await discovery(['config', 'nodes', 'topology'], true);
    current.sessions.hub.reject(Object.assign(new Error('HTTP 502'), { status: 502 })); current.fleet.hub.reject(Object.assign(new Error('HTTP 502'), { status: 502 }));
    for (const key of ['hub/leaf', 'hub/sibling']) { current.sessions[key].resolve(payload()); current.fleet[key].resolve(fleet()); } await flush();
  }
  const at = group().verifiedAt; const beforeHub = api.getRouteSessions.mock.calls.filter(([, route]) => route.join('/') === 'hub').length;
  current = round(); await tick(4000); await discovery(['nodes', 'topology', 'config'], true);
  expect(api.getRouteSessions.mock.calls.filter(([, route]) => route.join('/') === 'hub')).toHaveLength(beforeHub);
  assertLive(container, at); assertLive(container, at, 'Sibling', siblingId); await settle(true);
});
