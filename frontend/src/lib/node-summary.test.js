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

// La federazione di /vl-nodes/* e' stata ripristinata (2026-08-05): le quattro
// route VL sono federate come ogni altra risorsa (lib/proxy/federation.js,
// knownResource + allowedResource; docs/VL_MICRO_NODES.md §Federation). Un nodo
// VL e' dunque raggiungibile da un peer autorizzato, NON "non federabile".
describe('nodeExposure — VL nodes are federated (brief §3, federation restored 2026-08-05)', () => {
  it('reports the node as federated and reachable by an authorized peer', () => {
    const peer = vlNodeToPeer(RAW_ONLINE);
    const exposure = nodeExposure(peer);
    expect(exposure.shared).toBe(true);
    expect(exposure.key).toBe('peer-vl-federated');
    expect(exposure.shortKey).toBe('row-vl-federated');
  });

  it('never reports "private" or "not federated" for a VL node', () => {
    const exposure = nodeExposure(vlNodeToPeer(RAW_ONLINE));
    expect(exposure.key).not.toBe('peer-private');
    expect(exposure.shortKey).not.toBe('row-private');
    expect(exposure.key).not.toBe('peer-vl-not-federated');
    expect(exposure.shortKey).not.toBe('row-vl-not-federated');
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

// Step 3 (owner remoti, brief NC_UI_NODI_VL_REMOTI, invariante 2): "due nodi
// con la stessa label su owner diversi sono distinguibili SOLO cosi'" — la
// riga deve portare l'owner, non solo lo stato.
describe('nodeRowSummary — shows the owner for a VL node (step 3, invariant 2)', () => {
  it('prefixes the subtitle with the owner label for a remote node', () => {
    const owner = { instanceId: 'b'.repeat(16), route: ['vps3'], label: 'VPS3' };
    const row = nodeRowSummary(vlNodeToPeer(RAW_ONLINE, owner));
    expect(row.subtitle.startsWith('VPS3')).toBe(true);
    expect(row.subtitle).toContain('nominal');
  });

  it('two nodes with the SAME label on different owners produce different subtitles', () => {
    const ownerA = { instanceId: 'a'.repeat(16), route: ['vps3'], label: 'VPS3' };
    const ownerB = { instanceId: 'b'.repeat(16), route: ['nova'], label: 'NovaLNX' };
    const rowA = nodeRowSummary(vlNodeToPeer(RAW_ONLINE, ownerA));
    const rowB = nodeRowSummary(vlNodeToPeer(RAW_ONLINE, ownerB));
    expect(rowA.title).toBe(rowB.title); // stessa label del device
    expect(rowA.subtitle).not.toBe(rowB.subtitle); // ma distinguibili
  });

  it('does not prefix a local node with an owner label (no ownerLabel set)', () => {
    const row = nodeRowSummary(vlNodeToPeer(RAW_ONLINE));
    expect(row.subtitle.startsWith('nominal')).toBe(true);
  });
});
