import { describe, it, expect } from 'vitest';
import { cellDisplayName, findManagedCell } from './cell-display.js';

// Roster di riferimento (specchiato dal rendering reale: celle locali da
// /api/fleet/status locale + gruppi per-nodo da useNodes).
const localCells = [
  { cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude.native', key: 'A' },
  { cell: 'Trading', tmuxSession: 'cloud-Trading', engine: 'glm', key: 'P' },
];
const nodeGroups = [
  {
    route: ['workstation'], instanceId: 'a'.repeat(32),
    cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude.native', key: 'A' }],
  },
  {
    route: ['vps', 'relay'], instanceId: 'b'.repeat(32),
    cells: [{ cell: 'Fork', tmuxSession: 'cloud-Fork', engine: 'glm', key: 'A' }],
  },
];

describe('cellDisplayName — managed cells', () => {
  it('returns the logical Fleet cell name for a local managed cell', () => {
    expect(cellDisplayName({ session: 'cloud-Dev', cells: localCells })).toBe('Dev');
    expect(cellDisplayName({ session: 'cloud-Trading', cells: localCells })).toBe('Trading');
  });

  it('returns the logical name for a remote direct cell, dropping route + tmux session', () => {
    // cell=Dev, tmuxSession=cloud-Dev, route workstation -> titolo esatto "Dev".
    expect(cellDisplayName({
      session: 'cloud-Dev', node: 'workstation', ownerId: 'a'.repeat(32), nodeGroups,
    })).toBe('Dev');
  });

  it('returns the logical name for a routed multi-hop cell', () => {
    expect(cellDisplayName({
      session: 'cloud-Fork', node: 'vps/relay', ownerId: 'b'.repeat(32), nodeGroups,
    })).toBe('Fork');
  });

  it('resolves a local cell when node is absent even if a remote group has the same tmuxSession', () => {
    // Same tmuxSession cloud-Dev exists on workstation, but local lookup wins
    // for a local tile (no node) and still returns the local cell name.
    expect(cellDisplayName({ session: 'cloud-Dev', cells: localCells, nodeGroups })).toBe('Dev');
  });
});

describe('cellDisplayName — unmanaged + fallback', () => {
  it('falls back to the tmux session name for an unmanaged local session', () => {
    expect(cellDisplayName({ session: 'scratch-pad', cells: localCells })).toBe('scratch-pad');
  });

  it('falls back to the session name when the remote route has no matching group', () => {
    expect(cellDisplayName({ session: 'cloud-Dev', node: 'unknown/relay', nodeGroups })).toBe('cloud-Dev');
  });

  it('does NOT naively strip a cloud- prefix when no Fleet data resolves the cell', () => {
    expect(cellDisplayName({ session: 'cloud-Dev' })).toBe('cloud-Dev');
    expect(cellDisplayName({ session: 'cloud-Dev', cells: [], nodeGroups: [] })).toBe('cloud-Dev');
    expect(cellDisplayName({ session: 'cloud-Dev', node: 'workstation', nodeGroups: [] })).toBe('cloud-Dev');
  });

  it('returns empty string for an empty/invalid session', () => {
    expect(cellDisplayName({ session: '' })).toBe('');
    expect(cellDisplayName({})).toBe('');
  });
});

describe('cellDisplayName — duplicates across owners/routes (Gate D)', () => {
  it('keeps distinct two same-tmuxSession cells on different routes', () => {
    const groups = [
      { route: ['n1'], instanceId: 'a'.repeat(32), cells: [{ cell: 'Alpha', tmuxSession: 'cloud-X' }] },
      { route: ['n2'], instanceId: 'b'.repeat(32), cells: [{ cell: 'Beta', tmuxSession: 'cloud-X' }] },
    ];
    expect(cellDisplayName({ session: 'cloud-X', node: 'n1', nodeGroups: groups })).toBe('Alpha');
    expect(cellDisplayName({ session: 'cloud-X', node: 'n2', nodeGroups: groups })).toBe('Beta');
  });

  it('uses ownerId as tiebreaker when the same route resolves to multiple owners', () => {
    const groups = [
      { route: ['n1'], instanceId: 'a'.repeat(32), cells: [{ cell: 'Alpha', tmuxSession: 'cloud-X' }] },
      { route: ['n1'], instanceId: 'b'.repeat(32), cells: [{ cell: 'Beta', tmuxSession: 'cloud-X' }] },
    ];
    expect(cellDisplayName({ session: 'cloud-X', node: 'n1', ownerId: 'a'.repeat(32), nodeGroups: groups })).toBe('Alpha');
    expect(cellDisplayName({ session: 'cloud-X', node: 'n1', ownerId: 'b'.repeat(32), nodeGroups: groups })).toBe('Beta');
  });
});

describe('cellDisplayName — SingleView reuse (pre-resolved cell)', () => {
  it('uses a pre-resolved Fleet cell directly, without roster', () => {
    expect(cellDisplayName({ session: 'cloud-Dev', cell: { cell: 'Dev', tmuxSession: 'cloud-Dev' } })).toBe('Dev');
  });

  it('falls back to the session name when the pre-resolved cell is null (unmanaged)', () => {
    expect(cellDisplayName({ session: 'scratch', cell: null })).toBe('scratch');
    expect(cellDisplayName({ session: 'scratch', cell: undefined })).toBe('scratch');
  });

  it('ignores a malformed pre-resolved cell (no cell field) and falls back to roster/session', () => {
    expect(cellDisplayName({ session: 'cloud-Dev', cell: { tmuxSession: 'cloud-Dev' }, cells: localCells })).toBe('Dev');
    expect(cellDisplayName({ session: 'scratch', cell: { tmuxSession: 'scratch' } })).toBe('scratch');
  });
});

describe('findManagedCell', () => {
  it('returns the matching local cell object', () => {
    expect(findManagedCell({ session: 'cloud-Dev', cells: localCells })).toEqual(
      expect.objectContaining({ cell: 'Dev', tmuxSession: 'cloud-Dev' }),
    );
  });

  it('returns null for an unmanaged session', () => {
    expect(findManagedCell({ session: 'nope', cells: localCells })).toBeNull();
    expect(findManagedCell({ session: 'cloud-Dev', node: 'missing', nodeGroups })).toBeNull();
  });
});
