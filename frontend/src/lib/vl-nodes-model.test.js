import { describe, expect, it } from 'vitest';
import { vlNodeToPeer, topologyVlOwners, vlSidebarGroups } from './vl-nodes-model.js';
import { healthDot } from './roster-view-model.js';

const RAW = {
  nodeId: 'a'.repeat(32),
  label: 'VL-Node-A',
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
    expect(peer.label).toBe('VL-Node-A');
  });

  it('maps "accoppiato" from pairedAt being set, not copied verbatim', () => {
    expect(vlNodeToPeer(RAW).paired).toBe(true);
    expect(vlNodeToPeer({ ...RAW, pairedAt: null }).paired).toBe(false);
  });

  // Il contratto è cambiato qui, e non per comodità: la salute non si passa
  // più attraverso. Il broker dichiara `state`, il pallino legge `status`, e
  // `running` è un'auto-dichiarazione. La derivazione (con la tabella e la
  // freschezza) sta in vl-node-view.js; qui si prova che il modello la usa.
  it('derives health instead of passing it through', () => {
    const fresco = { ...RAW, online: true, lastSeen: Date.now(), health: { state: 'running', brokerReachable: true } };
    const peer = vlNodeToPeer(fresco);
    expect(peer.health.status).toBe('healthy');
    expect(peer.health.freshness).toBe('current');
    // senza prova del broker, o senza salute, il pallino non è verde
    expect(vlNodeToPeer({ ...RAW, health: { state: 'running' } }).health.status).toBe('warn');
    // la salute assente non produce un oggetto: e' assenza, non un oggetto vuoto
    const senza = vlNodeToPeer({ ...RAW, health: null });
    expect(senza.health).toBeNull();
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

// Step 3 (owner remoti, brief UI nodi VL remoti): un nodo VL viene da UN
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
    const owner = { instanceId: 'b'.repeat(16), route: ['node-a'], label: 'Node A' };
    const peer = vlNodeToPeer(RAW, owner);
    expect(peer.route).toEqual(['node-a']);
    expect(peer.isLocal).toBe(false);
    expect(peer.ownerInstanceId).toBe('b'.repeat(16));
    expect(peer.ownerLabel).toBe('Node A');
  });

  it('does not mutate the owner.route array it was given (defensive copy)', () => {
    const owner = { instanceId: 'b'.repeat(16), route: ['node-a'], label: 'Node A' };
    const peer = vlNodeToPeer(RAW, owner);
    peer.route.push('mutated');
    expect(owner.route).toEqual(['node-a']);
  });
});

describe('topologyVlOwners — ports topologyOwners() semantics (lib/mcp/cells.js) into the frontend', () => {
  const topology = {
    nodes: [
      { instanceId: 'local-id-000000', route: [], label: 'Self', stale: false },
      { instanceId: 'remote-a-000000', route: ['node-a'], label: 'Node A', stale: false },
      { instanceId: 'remote-b-000000', route: ['nova', 'node-a'], label: 'via Nova', stale: false },
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
    expect(remoteA[0].route).toEqual(['node-a']);
  });

  it('preserves the route array and label for each surviving owner', () => {
    const owners = topologyVlOwners(topology, 'local-id-000000');
    const b = owners.find((o) => o.instanceId === 'remote-b-000000');
    expect(b.route).toEqual(['nova', 'node-a']);
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
    expect(g.label).toBe('VL-Node-A');
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

  it('propagates peer.stale to the group so cached data is not read as fresh', () => {
    const peer = { ...vlNodeToPeer(RAW), stale: true };
    expect(vlSidebarGroups([peer])[0].stale).toBe(true);
  });

  it('a freshly read peer is explicitly not stale (boolean, never undefined)', () => {
    const peer = { ...vlNodeToPeer(RAW), stale: false };
    expect(vlSidebarGroups([peer])[0].stale).toBe(false);
  });

  it('a peer without the flag is reported as not stale', () => {
    expect(vlSidebarGroups([vlNodeToPeer(RAW)])[0].stale).toBe(false);
  });

  it('a stale cached peer surfaces as fleetState "stale" for the existing indicator', () => {
    const peer = { ...vlNodeToPeer(RAW), stale: true };
    expect(vlSidebarGroups([peer])[0].fleetState).toBe('stale');
  });

  it('a fresh peer carries no stale fleet state', () => {
    const peer = { ...vlNodeToPeer(RAW), stale: false };
    expect(vlSidebarGroups([peer])[0].fleetState).toBeNull();
  });
});

// Il pallino grigio visto sul dispositivo: il broker dichiara `state`, il dot
// legge `status`. Mappare il campo non basta — `running` è un'auto-dichiarazione
// e non prova che l'host risponda. Questi due casi sono il confine.
describe('salute del nodo VL: il pallino segue la prova, non la parola', () => {
  const adesso = Date.now();

  it('running SENZA prova del broker non è sano', () => {
    const p = vlNodeToPeer({ nodeId: 'd'.repeat(32), label: 'N', online: true, lastSeen: adesso, health: { state: 'running' } });
    expect(healthDot(p.health)).toBe('warn');
    expect(p.health.detail).toBeTruthy();
  });

  it('running CON il broker attestato è sano', () => {
    const p = vlNodeToPeer({ nodeId: 'e'.repeat(32), label: 'N', online: true, lastSeen: adesso, health: { state: 'running', brokerReachable: true } });
    expect(healthDot(p.health)).toBe('on');
  });
});

// «Mai collegato» e «offline» chiedono due cose diverse a chi legge.
describe('collegamento del nodo VL', () => {
  it('un nodo senza heartbeat è «mai collegato», non «offline»', () => {
    const peer = vlNodeToPeer({ nodeId: 'f'.repeat(32), label: 'K', online: false, lastSeen: null });
    expect(vlSidebarGroups([peer])[0].status).toBe('never-connected');
  });

  it('un nodo che ha perso il contatto resta offline', () => {
    const peer = vlNodeToPeer({ nodeId: '0'.repeat(32), label: 'N2DS', online: false, lastSeen: 12345 });
    expect(vlSidebarGroups([peer])[0].status).toBe('offline');
  });
});

// La catena che l'operatore vede: adapter → gruppi → pallino. Una salute
// assente non deve accendere niente, e il titolo deve ricadere sullo stato.
describe('salute assente lungo la catena', () => {
  it('un nodo senza heartbeat e senza salute non mostra un pallino', () => {
    const peer = vlNodeToPeer({ nodeId: '1'.repeat(32), label: 'K', online: false, lastSeen: null, health: null });
    const gruppo = vlSidebarGroups([peer]);
    expect(healthDot(gruppo[0].health)).toBeNull();
    expect(gruppo[0].health).toBeNull();
  });

  it('un vocabolario sconosciuto non accende un pallino, ma il dettaglio resta', () => {
    const peer = vlNodeToPeer({ nodeId: '2'.repeat(32), label: 'N', online: true, lastSeen: Date.now(), health: { state: 'boh', detail: 'dice qualcosa' } });
    expect(healthDot(peer.health)).toBeNull();
    expect(peer.health.detail).toBe('dice qualcosa');
  });
});
