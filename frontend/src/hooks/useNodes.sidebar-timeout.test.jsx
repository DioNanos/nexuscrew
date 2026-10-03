import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, within } from '@testing-library/react';
const api = vi.hoisted(() => ({ getNodes: vi.fn(), getTopology: vi.fn(), getNodeAliases: vi.fn(), getVlNodes: vi.fn(), getRouteConfig: vi.fn(), ROSTER_READ_TIMEOUT_MS: 8000 }));
vi.mock('../lib/api.js', async (original) => ({ ...await original(), ...api }));
vi.mock('../components/Terminal.jsx', () => ({ default: () => null }));
vi.mock('../components/CellPanel.jsx', () => ({ default: () => null }));
vi.mock('../components/CellPeek.jsx', () => ({ default: () => null }));
import Sidebar from '../components/Sidebar.jsx';
import { useNodes } from './useNodes.js';
import { buildRemoteRoster } from '../lib/roster-view-model.js';
const localId = 'a'.repeat(32), leafId = 'c'.repeat(32), siblingId = 'd'.repeat(32);
const sessionPayload = { sessions: [{ name: 'worker' }] };
const fleetPayload = { available: true, cells: [{ cell: 'Worker', tmuxSession: 'worker', tmux: true, active: true }] };
let snapshots, blockedSource, seen;
function Harness() { snapshots = useNodes('token'); return <Sidebar localNodeId={localId} nodeGroups={snapshots} />; }
const flush = async () => { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };
const tick = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const group = (id = leafId) => snapshots.find(g => g.instanceId === id);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); vi.resetAllMocks(); localStorage.clear(); localStorage.setItem('nc_lang', 'en'); blockedSource = null; seen = [];
  api.getRouteConfig.mockResolvedValue({ instanceId: localId });
  api.getNodes.mockResolvedValue({ nodes: [{ name: 'hub', label: 'Hub', nodeId: 'b'.repeat(32), paired: true, tunnel: { status: 'up' } }] });
  api.getTopology.mockResolvedValue({ nodes: [{ name: 'leaf', label: 'Leaf', instanceId: leafId, route: ['hub', 'leaf'] }, { name: 'sibling', label: 'Sibling', instanceId: siblingId, route: ['hub', 'sibling'] }] });
  api.getNodeAliases.mockResolvedValue({ aliasesByInstanceId: {} }); api.getVlNodes.mockResolvedValue({ nodes: [] });
  // Real API headers resolve immediately; the selected body waits for its actual abort signal.
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    const source = String(url).endsWith('/sessions') ? 'sessions' : 'fleet';
    const blocked = blockedSource === source && String(url).includes('/hub/leaf/');
    return { ok: true, status: 200, json: blocked ? () => new Promise((resolve, reject) => {
      seen.push(opts.signal); opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
      if (opts.signal.aborted) reject(opts.signal.reason);
    }) : async () => source === 'sessions' ? sessionPayload : fleetPayload };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it.each(['sessions', 'fleet'])('an actual eight-second %s body timeout degrades only its source and leaf', async source => {
  const { container } = render(<Harness />); await flush();
  expect(group()).toMatchObject({ status: 'up', sessionsAvailable: true, fleetState: 'available' });
  const at = group().verifiedAt; blockedSource = source; await tick(4000); await flush();
  expect(seen).toHaveLength(1); expect(group().checking).toBe(true);
  await tick(7999); expect(seen[0].aborted).toBe(false); expect(group().checking).toBe(true);
  await tick(1); await flush(); expect(seen[0].aborted).toBe(true); expect(seen[0].reason.name).toBe('TimeoutError');
  expect(group().checking).not.toBe(true); expect(group().cause).toBe('peer-assente');
  if (source === 'sessions') expect(group()).toMatchObject({ sessionsAvailable: false, inventoryPartial: true, verifiedAt: at });
  else { expect(group()).toMatchObject({ fleetState: 'stale', fleetAvailable: false }); expect(group().cellsPreserved).not.toBe(true); expect(group().cells[0].preserved).not.toBe(true); }
  expect(group(siblingId)).toMatchObject({ status: 'up', fleetState: 'available', sessionsAvailable: true });
  const sibling = within(container).getByText('Sibling', { selector: 'b' }).closest('.nc-node-order-wrap');
  expect(sibling.querySelector('.nc-node-title > .nc-dot').classList.contains('on')).toBe(true);
  expect(sibling.querySelector('.nc-cell').classList.contains('live')).toBe(true);
});
