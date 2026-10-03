import { describe, expect, it } from 'vitest';
import { buildNodeGroups } from './nodes-model.js';

// Un gruppo senza alcuna lettura conclusa non e' "unreachable": e' una
// lettura ancora in corso. Un gruppo gia' noto, durante un refresh, conserva
// il suo stato e il suo snapshot finche' un esito nuovo non li sostituisce,
// con un marcatore che distingue il riuso da una verifica fresca.
const NODO = { name: 'vps', label: 'VPS', nodeId: 'i-1234', tunnel: { status: 'up' }, paired: true };

const build = (remote, fleet, extra = {}) => buildNodeGroups({
  nodes: [NODO],
  topology: [],
  remote,
  fleet,
  aliases: {},
  down: {},
  ...extra,
});

describe('stato di lettura dei gruppi', () => {
  it('una route con letture in corso e nessun esito e\' "pending", non unreachable', () => {
    const groups = build({}, {}, {
      pendingReads: new Set(['vps']),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe('pending');
  });

  it('un gruppo gia\' noto conserva stato e snapshot durante il refresh, marcato "checking"', () => {
    const completo = build(
      { vps: { sessions: [{ name: 'viva', created: 1 }], at: 42 } },
      { vps: { available: true, cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev', tmux: true }], fleetState: 'available' } },
    );
    expect(completo[0].status).toBe('up');
    const groups = build(
      {},
      {},
      { pendingReads: new Set(['vps']), previousGroups: completo },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe('up');
    expect(groups[0].checking).toBe(true);
    // Niente rinnovo dell'attestato: verifiedAt resta quello della lettura.
    expect(groups[0].verifiedAt).toBe(completo[0].verifiedAt);
  });

  it('senza il flag di lettura in corso, esiti assenti restano unreachable (comportamento invariato)', () => {
    const groups = build({ vps: { error: 'unreachable', cause: null, lastGoodAt: null } }, {});
    expect(groups[0].status).toBe('unreachable');
  });
});
