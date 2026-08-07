import { describe, expect, it } from 'vitest';
import { vlNodeToPeer, topologyVlOwners, vlSidebarGroups } from './vl-nodes-model.js';

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

// Step 3 (owner remoti, brief NC_UI_NODI_VL_REMOTI): un nodo VL viene da UN
// owner preciso (locale o federato) — la fusione della lista deve saperlo,
// non solo saperne il nodeId, altrimenti due nodi con la stessa label su
// owner diversi sono indistinguibili (invariante 2 del brief) e un comando
// finisce sull'owner sbagliato (invariante 3).
describe('vlNodeToPeer — owner (route/instanceId/label), step 3', () => {
  it('defaults to local (route empty) when no owner is given — step 1/2 behavior unchanged', () => {
    const peer = vlNodeToPeer(RAW);
    expect(peer.route).toEqual([]);
    expect(peer.isLocal).toBe(true);
    expect(peer.ownerInstanceId).toBeNull();
    expect(peer.ownerLabel).toBeNull();
  });

  it('carries a remote owner route/instanceId/label through untouched', () => {
    const owner = { instanceId: 'b'.repeat(16), route: ['vps3'], label: 'VPS3' };
    const peer = vlNodeToPeer(RAW, owner);
    expect(peer.route).toEqual(['vps3']);
    expect(peer.isLocal).toBe(false);
    expect(peer.ownerInstanceId).toBe('b'.repeat(16));
    expect(peer.ownerLabel).toBe('VPS3');
  });

  it('does not mutate the owner.route array it was given (defensive copy)', () => {
    const owner = { instanceId: 'b'.repeat(16), route: ['vps3'], label: 'VPS3' };
    const peer = vlNodeToPeer(RAW, owner);
    peer.route.push('mutated');
    expect(owner.route).toEqual(['vps3']);
  });
});

describe('topologyVlOwners — ports topologyOwners() semantics (lib/mcp/cells.js) into the frontend', () => {
  const topology = {
    nodes: [
      { instanceId: 'local-id-000000', route: [], label: 'Self', stale: false },
      { instanceId: 'remote-a-000000', route: ['vps3'], label: 'VPS3', stale: false },
      { instanceId: 'remote-b-000000', route: ['nova', 'vps3'], label: 'via Nova', stale: false },
      { instanceId: 'stale-c-0000000', route: ['old'], label: 'Stale', stale: true },
      { instanceId: 'remote-a-000000', route: ['dup'], label: 'Duplicate', stale: false },
    ],
  };

  it('excludes the local instanceId — the caller adds it separately as route: []', () => {
    const owners = topologyVlOwners(topology, 'local-id-000000');
    expect(owners.some((o) => o.instanceId === 'local-id-000000')).toBe(false);
  });

  it('excludes stale owners — a stale peer is not a reachable command target', () => {
    const owners = topologyVlOwners(topology, 'local-id-000000');
    expect(owners.some((o) => o.instanceId === 'stale-c-0000000')).toBe(false);
  });

  it('dedupes by instanceId, keeping the first occurrence', () => {
    const owners = topologyVlOwners(topology, 'local-id-000000');
    const remoteA = owners.filter((o) => o.instanceId === 'remote-a-000000');
    expect(remoteA).toHaveLength(1);
    expect(remoteA[0].route).toEqual(['vps3']);
  });

  it('preserves the route array and label for each surviving owner', () => {
    const owners = topologyVlOwners(topology, 'local-id-000000');
    const b = owners.find((o) => o.instanceId === 'remote-b-000000');
    expect(b.route).toEqual(['nova', 'vps3']);
    expect(b.label).toBe('via Nova');
  });

  it('is empty/defensive for missing or malformed topology', () => {
    expect(topologyVlOwners(null, 'x')).toEqual([]);
    expect(topologyVlOwners({}, 'x')).toEqual([]);
    expect(topologyVlOwners({ nodes: 'not-an-array' }, 'x')).toEqual([]);
  });
});

// --- session dichiarata + gruppi sidebar ------------------------------------
// La forma di RAW+session e' quella VERA di GET /api/vl-nodes dopo il commit
// hub a3801bd (broker.list -> session sanitizzata {attached, profile} | null),
// a sua volta dalla forma vera del filo del device (test Rust
// heartbeat_declares_the_session_...). Non un mondo costruito ad arte.

describe('vlNodeToPeer — session', () => {
  it('carries the declared session through untouched', () => {
    const peer = vlNodeToPeer({ ...RAW, session: { attached: true, profile: 'ollama' } });
    expect(peer.session).toEqual({ attached: true, profile: 'ollama' });
  });

  it('an absent or null session stays null — old hub or old binary', () => {
    expect(vlNodeToPeer(RAW).session).toBeNull();
    expect(vlNodeToPeer({ ...RAW, session: null }).session).toBeNull();
  });
});

describe('vlSidebarGroups', () => {
  const peerAttached = vlNodeToPeer({ ...RAW, session: { attached: true, profile: 'ollama' } });
  const peerDetached = vlNodeToPeer({ ...RAW, session: { attached: false, profile: 'ollama' } });
  const peerSilent = vlNodeToPeer(RAW);
  const peerOffline = vlNodeToPeer({ ...RAW, online: false, session: { attached: true, profile: 'ollama' } });

  it('an attached node is one honest session', () => {
    const [g] = vlSidebarGroups([peerAttached]);
    expect(g.kind).toBe('vl');
    expect(g.label).toBe('N900');
    expect(g.status).toBe('up');
    expect(g.sessions).toHaveLength(1);
    expect(g.sessions[0].name).toBe('ollama');
    expect(g.sessions[0].key).toContain(RAW.nodeId);
  });

  it('detached or silent declarations are zero sessions — never "1 in attesa"', () => {
    expect(vlSidebarGroups([peerDetached])[0].sessions).toHaveLength(0);
    expect(vlSidebarGroups([peerSilent])[0].sessions).toHaveLength(0);
  });

  it('an offline node shows what other offline nodes show, no invented state', () => {
    const [g] = vlSidebarGroups([peerOffline]);
    expect(g.status).toBe('offline');
    expect(g.sessions).toHaveLength(0, 'offline: la sessione non e\' raggiungibile, non si conta');
    expect(g.downSince).toBe(RAW.lastSeen);
  });

  it('groups keep the sidebar contract: no cells, no unmanaged, no deck owner', () => {
    const [g] = vlSidebarGroups([peerAttached]);
    expect(g.cells).toEqual([]);
    expect(g.unmanaged).toEqual([]);
    expect(g.instanceId).toBeNull();
    expect(g.peer).toBe(peerAttached);
  });

  it('garbage in, nothing out', () => {
    expect(vlSidebarGroups(null)).toEqual([]);
    expect(vlSidebarGroups([null, {}, { kind: 'cell' }])).toEqual([]);
  });
});
