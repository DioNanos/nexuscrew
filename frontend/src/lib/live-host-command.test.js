import { describe, expect, it, vi } from 'vitest';
import { runLiveHostCommand } from './live-host-command.js';

// One command, two directions, and ALWAYS a fresh revision: the store is a
// compare-and-swap, so writing with a revision read in an earlier render is a
// 409 by construction. The command reads, then writes, and reports an outcome
// the caller can SHOW (a key, never a sentence and never only an alert).
const route = ['relay'];

function api(overrides = {}) {
  return {
    getLiveHost: vi.fn(async () => ({ hostCell: null, revision: 7, eligible: true, threadStatus: 'absent' })),
    designateHostCell: vi.fn(async (cellId, revision) => ({ hostCell: cellId, revision: revision + 1 })),
    clearHostCell: vi.fn(async (revision) => ({ hostCell: null, revision: revision + 1 })),
    ...overrides,
  };
}

describe('runLiveHostCommand — use', () => {
  it('reads the revision and designates with THAT one', async () => {
    const a = api();
    const out = await runLiveHostCommand({ action: 'use', cellId: 'cell-two', route, api: a });
    expect(a.getLiveHost).toHaveBeenCalledWith(route);
    expect(a.designateHostCell).toHaveBeenCalledWith('cell-two', 7, route);
    expect(out).toMatchObject({ ok: true, messageKey: 'live-host-designated', hostCell: 'cell-two', revision: 8 });
  });

  it('a refusal names the cause and changes nothing', async () => {
    const refusal = Object.assign(new Error('forbidden'), { status: 403, data: { reason: 'live-host-not-granted' } });
    const a = api({ designateHostCell: vi.fn(async () => { throw refusal; }) });
    const out = await runLiveHostCommand({ action: 'use', cellId: 'cell-two', route, api: a });
    expect(out.ok).toBe(false);
    expect(out.messageKey).toBe('live-host-not-granted');
  });

  it('a stale revision is reported as such, not as a generic error', async () => {
    const conflict = Object.assign(new Error('revision superata: rileggi e riprova'), { status: 409 });
    const a = api({ designateHostCell: vi.fn(async () => { throw conflict; }) });
    const out = await runLiveHostCommand({ action: 'use', cellId: 'cell-two', route, api: a });
    expect(out.messageKey).toBe('live-host-stale-revision');
  });

  it('a cell that is not this node\'s is reported as such', async () => {
    const notMine = Object.assign(new Error('cella non appartiene a questo nodo'), { status: 404 });
    const a = api({ designateHostCell: vi.fn(async () => { throw notMine; }) });
    const out = await runLiveHostCommand({ action: 'use', cellId: 'Elsewhere', route, api: a });
    expect(out.messageKey).toBe('live-host-not-local');
  });

  it('a failed reading is an outcome too, and nothing is written', async () => {
    const a = api({ getLiveHost: vi.fn(async () => { throw new Error('offline'); }) });
    const out = await runLiveHostCommand({ action: 'use', cellId: 'cell-two', route, api: a });
    expect(out.ok).toBe(false);
    expect(out.messageKey).toBe('live-host-error');
    expect(a.designateHostCell).not.toHaveBeenCalled();
  });
});

describe('runLiveHostCommand — remove', () => {
  it('clears with the fresh revision and reports it', async () => {
    const a = api({ getLiveHost: vi.fn(async () => ({ hostCell: 'cell-two', revision: 11 })) });
    const out = await runLiveHostCommand({ action: 'remove', route, api: a });
    expect(a.clearHostCell).toHaveBeenCalledWith(11, route);
    expect(out).toMatchObject({ ok: true, messageKey: 'live-host-cleared', hostCell: null, revision: 12 });
  });
});
