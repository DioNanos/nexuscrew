import { describe, expect, it } from 'vitest';
import { nodeReach, nodeExposure, nodeRowSummary } from './node-summary.js';
import { vlNodeToPeer } from './vl-nodes-model.js';

const RAW_ONLINE = {
  nodeId: 'a'.repeat(32), label: 'N900', cell: 'VL-aaaaaaaa',
  pairedAt: 1700000000000, online: true, lastSeen: 1700000100000,
  health: { state: 'ok', uptimeSec: 3600, rssBytes: 12345, detail: 'nominal' },
  capabilities: ['status', 'health'],
};

describe('nodeReach — VL nodes (poll status, not a tunnel — brief §3)', () => {
  it('reports online from the poll, not "tunnel down" for a node with no tunnel', () => {
    const peer = vlNodeToPeer(RAW_ONLINE);
    const reach = nodeReach(peer);
    expect(reach.up).toBe(true);
    // Must NOT be the Fleet "tunnel-down" key — a VL node has no tunnel at
    // all, so a Fleet-shaped reach key here would be a lie by omission.
    expect(reach.key).not.toBe('tunnel-down');
    expect(reach.key).not.toBe('tunnel-up');
  });

  it('reports offline distinctly when the poll is not established', () => {
    const peer = vlNodeToPeer({ ...RAW_ONLINE, online: false });
    const reach = nodeReach(peer);
    expect(reach.up).toBe(false);
    const onlineReach = nodeReach(vlNodeToPeer(RAW_ONLINE));
    expect(reach.key).not.toBe(onlineReach.key);
  });
});

describe('nodeExposure — VL nodes are not federable (brief §3)', () => {
  it('never reports "private" (which implies it COULD be shared) — a distinct not-applicable state', () => {
    const peer = vlNodeToPeer(RAW_ONLINE);
    const exposure = nodeExposure(peer);
    expect(exposure.shared).toBe(false);
    expect(exposure.key).not.toBe('peer-private');
    expect(exposure.shortKey).not.toBe('row-private');
  });
});

describe('nodeRowSummary — a VL node produces a real row, not null', () => {
  it('has a title and a non-empty subtitle even with no Fleet fields set', () => {
    const row = nodeRowSummary(vlNodeToPeer(RAW_ONLINE));
    expect(row).not.toBeNull();
    expect(row.title).toBe('N900');
    expect(row.subtitle).toBeTruthy();
  });

  it('surfaces health in the subtitle when the device reports it — "salute reale" in the list', () => {
    const row = nodeRowSummary(vlNodeToPeer(RAW_ONLINE));
    expect(row.subtitle).toContain('nominal');
  });

  it('falls back to the poll state in the subtitle when there is no health detail', () => {
    const row = nodeRowSummary(vlNodeToPeer({ ...RAW_ONLINE, health: null, online: false }));
    expect(row.subtitle).toBeTruthy();
    expect(row.subtitle).not.toContain('undefined');
    expect(row.subtitle).not.toContain('null');
  });
});
