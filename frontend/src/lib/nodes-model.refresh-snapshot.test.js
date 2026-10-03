import { expect, it } from 'vitest';
import { buildNodeGroups } from './nodes-model.js';
const id = 'a'.repeat(32);
const owner = { name: 'leaf', label: 'Leaf', instanceId: id, route: ['hub', 'leaf'] };
const key = 'hub/leaf';
const build = (extra = {}) => buildNodeGroups({ nodes: [], topology: [owner], remote: {}, fleet: {}, pendingReads: new Set([`${key}#sessions`, `${key}#fleet`]), ...extra })[0];
const healthy = build({ pendingReads: new Set(), remote: { [key]: { sessions: [{ name: 'worker' }], at: 42 } }, fleet: { [key]: { available: true, cells: [{ cell: 'Worker', tmuxSession: 'worker', tmux: true }], fleetState: 'available' } } });
it.each(['up', 'unreachable', 'offline'])('preserves the whole known %s group during rereading without promoting stale inventory', status => {
  const previous = { ...healthy, status, cause: { kind: 'unreachable', status: 502 }, fleetState: 'stale', fleetAvailable: false, cellsPreserved: true, sessionsAvailable: false, inventoryPartial: true, cells: healthy.cells.map(c => ({ ...c, preserved: true })), unmanaged: [{ name: 'old-unmanaged' }] };
  expect(build({ previousGroups: [previous] })).toEqual({ ...previous, checking: true, sessionsPending: true, fleetPending: true });
});
it('does not reuse a previous group belonging to another instance on the same route', () => {
  const next = build({ previousGroups: [{ ...healthy, instanceId: 'b'.repeat(32) }] });
  expect(next).toMatchObject({ status: 'pending', cells: [], sessions: [] });
});
it('does not revive stale fleet while only sessions have a fresh successful result', () => {
  const previous = { ...healthy, fleetState: 'stale', fleetAvailable: false, cellsPreserved: true, cells: healthy.cells.map(c => ({ ...c, preserved: true })) };
  const next = build({ previousGroups: [previous], pendingReads: new Set([`${key}#fleet`]), remote: { [key]: { sessions: [{ name: 'new-worker' }], at: 99 } } });
  expect(next).toMatchObject({ status: 'up', sessions: [{ name: 'new-worker' }], fleetState: 'stale', fleetAvailable: false, cellsPreserved: true, verifiedAt: 99 });
  expect(next.cells).toEqual(previous.cells);
});
it.each([{ available: true, cells: [], fleetState: 'available' }, { available: false, cells: [], fleetState: 'disabled' }])('a fresh fleet outcome replaces only fleet and keeps the pending session timestamp %j', fresh => {
  const next = build({ previousGroups: [healthy], pendingReads: new Set([`${key}#sessions`]), fleet: { [key]: fresh } });
  expect(next.cells).toEqual([]); expect(next.sessions).toEqual(healthy.sessions); expect(next.verifiedAt).toBe(42); expect(next.fleetState).toBe(fresh.fleetState);
});
it('confirmed topology staleness overrides the previous up snapshot while sources are pending', () => {
  const next = build({ topology: [{ ...owner, stale: true }], previousGroups: [healthy], fleet: { [key]: { available: false, cells: healthy.cells, fleetState: 'stale' } } });
  expect(next).toMatchObject({ status: 'offline', cellsPreserved: true, fleetAvailable: false });
});
it('a current session failure keeps its cause and cannot gain a new verification timestamp', () => {
  const cause = { kind: 'unreachable', status: 502 };
  const next = build({ previousGroups: [healthy], pendingReads: new Set([`${key}#fleet`]), remote: { [key]: { error: 'unreachable', cause, lastGoodAt: 42 } } });
  expect(next).toMatchObject({ cause, sessionsAvailable: false, inventoryPartial: true, verifiedAt: 42 });
});
it('a fresh fleet success clears its old failure while sessions are only being reread', () => {
  const previous = { ...healthy, cause: 'peer-assente', fleetState: 'stale', fleetAvailable: false, cellsPreserved: true, cells: healthy.cells.map(c => ({ ...c, preserved: true })) };
  const next = build({ previousGroups: [previous], pendingReads: new Set([`${key}#sessions`]), fleet: { [key]: { available: true, cells: [], fleetState: 'available' } } });
  expect(next.cause).toBeUndefined(); expect(next.verifiedAt).toBe(42); expect(next.sessions).toEqual(healthy.sessions);
});
it('fresh sessions retain the failure of fleet that is still being reread', () => {
  const previous = { ...healthy, cause: 'peer-assente', fleetState: 'stale', fleetAvailable: false, cellsPreserved: true, cells: healthy.cells.map(c => ({ ...c, preserved: true })) };
  const next = build({ previousGroups: [previous], pendingReads: new Set([`${key}#fleet`]), remote: { [key]: { sessions: [{ name: 'new-worker' }], at: 99 } } });
  expect(next.cause).toBe('peer-assente'); expect(next.cellsPreserved).toBe(true); expect(next.verifiedAt).toBe(99);
});
