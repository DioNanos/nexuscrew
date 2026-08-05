import { describe, expect, it } from 'vitest';
import { vlNodeToPeer } from './vl-nodes-model.js';

const RAW = {
  nodeId: 'a'.repeat(32),
  label: 'N900',
  cell: 'VL-aaaaaaaa',
  pairedAt: 1700000000000,
  online: true,
  lastSeen: 1700000100000,
  generation: 3,
  version: '1.2.3',
  capabilities: ['status', 'health', 'logs'],
  health: { state: 'ok', uptimeSec: 3600, rssBytes: 12345, detail: 'nominal' },
  inflight: null,
  lastAck: { id: 'x1', status: 'ok', at: 1700000050000 },
  canManage: true,
};

describe('vlNodeToPeer', () => {
  it('maps identity so the row/sheet machinery can find a name+nodeId (brief §3)', () => {
    const peer = vlNodeToPeer(RAW);
    expect(peer.kind).toBe('vl');
    expect(peer.nodeId).toBe(RAW.nodeId);
    // nodeRowSummary/nodeIdentity require a truthy `name` or the row silently
    // disappears — the nodeId is the only stable identifier a VL node has.
    expect(peer.name).toBe(RAW.nodeId);
    expect(peer.label).toBe('N900');
  });

  it('maps "accoppiato" from pairedAt being set, not copied verbatim', () => {
    expect(vlNodeToPeer(RAW).paired).toBe(true);
    expect(vlNodeToPeer({ ...RAW, pairedAt: null }).paired).toBe(false);
  });

  it('carries health through untouched — same shape, not reinterpreted', () => {
    expect(vlNodeToPeer(RAW).health).toEqual(RAW.health);
    expect(vlNodeToPeer({ ...RAW, health: null }).health).toBeNull();
  });

  it('carries online/lastSeen for poll status instead of empty tunnel fields', () => {
    const peer = vlNodeToPeer(RAW);
    expect(peer.online).toBe(true);
    expect(peer.lastSeen).toBe(RAW.lastSeen);
    // No Fleet tunnel/transport fields are invented.
    expect(peer.tunnel).toBeUndefined();
    expect(peer.ssh).toBeUndefined();
    expect(peer.direction).toBeUndefined();
  });

  it('never sets shared/visibility — the brief marks sharing not applicable to VL nodes', () => {
    const peer = vlNodeToPeer(RAW);
    expect(peer.shared).toBeUndefined();
    expect(peer.visibility).toBeUndefined();
  });

  it('does not expose autostart — the device field is not surfaced by the backend today', () => {
    expect(vlNodeToPeer(RAW).autostart).toBeUndefined();
  });

  it('carries capabilities/inflight/lastAck through for the command UI (step 2)', () => {
    const peer = vlNodeToPeer(RAW);
    expect(peer.capabilities).toEqual(['status', 'health', 'logs']);
    expect(peer.lastAck).toEqual(RAW.lastAck);
    expect(peer.inflight).toBeNull();
  });

  it('returns null for a node with no nodeId — never a row with no identity', () => {
    expect(vlNodeToPeer({ ...RAW, nodeId: '' })).toBeNull();
    expect(vlNodeToPeer({ ...RAW, nodeId: undefined })).toBeNull();
    expect(vlNodeToPeer(null)).toBeNull();
    expect(vlNodeToPeer(undefined)).toBeNull();
  });

  it('falls back to cell, then nodeId, when label is missing', () => {
    expect(vlNodeToPeer({ ...RAW, label: '' }).label).toBe(RAW.cell);
    expect(vlNodeToPeer({ ...RAW, label: '', cell: '' }).label).toBe(RAW.nodeId);
  });
});
