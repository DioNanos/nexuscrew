import { describe, expect, it } from 'vitest';
import { vlNodeActions, vlCommandStatus } from './vl-node-detail.js';

describe('vlNodeActions — read from node.capabilities, never a fixed list', () => {
  it('shows exactly the capabilities the device declares', () => {
    const node = { kind: 'vl', capabilities: ['status', 'health', 'logs'] };
    expect(vlNodeActions(node)).toEqual(['status', 'health', 'logs']);
  });

  it('does not show a button for a command the device did not declare', () => {
    // The discriminating case: "start" exists as a real device capability in
    // general, but THIS node did not declare it — the brief's test.
    const node = { kind: 'vl', capabilities: ['status'] };
    const actions = vlNodeActions(node);
    expect(actions).toContain('status');
    expect(actions).not.toContain('start');
    expect(actions).not.toContain('restart');
    expect(actions).not.toContain('stop');
  });

  it('NEVER exposes update_candidate, even when the device declares it', () => {
    const node = { kind: 'vl', capabilities: ['status', 'update_candidate', 'unpair'] };
    const actions = vlNodeActions(node);
    expect(actions).not.toContain('update_candidate');
    expect(actions).toEqual(['status', 'unpair']);
  });

  it('is empty for a non-VL node, an empty declaration, or a malformed one', () => {
    expect(vlNodeActions({ kind: 'direct', capabilities: ['status'] })).toEqual([]);
    expect(vlNodeActions({ kind: 'vl', capabilities: [] })).toEqual([]);
    expect(vlNodeActions({ kind: 'vl' })).toEqual([]);
    expect(vlNodeActions(null)).toEqual([]);
  });

  it('drops duplicate capability entries instead of duplicating the button', () => {
    expect(vlNodeActions({ kind: 'vl', capabilities: ['status', 'status'] })).toEqual(['status']);
  });
});

describe('vlCommandStatus — "inviato" is never "fatto" until lastAck says so', () => {
  it('is null with nothing submitted and no prior ack', () => {
    expect(vlCommandStatus({ kind: 'vl' }, null)).toBeNull();
  });

  it('reports "submitted" right after the POST, before the node reflects it', () => {
    const node = { kind: 'vl', inflight: null, lastAck: null };
    const pending = { id: 'cmd-1', kind: 'restart', submittedAt: 1000 };
    expect(vlCommandStatus(node, pending)).toEqual({ phase: 'submitted', kind: 'restart' });
  });

  it('reports "inflight" once the node/broker confirms the command is in flight', () => {
    const node = { kind: 'vl', inflight: { id: 'cmd-1', kind: 'restart', status: 'sent', submittedAt: 1000 }, lastAck: null };
    const pending = { id: 'cmd-1', kind: 'restart', submittedAt: 1000 };
    expect(vlCommandStatus(node, pending)).toEqual({ phase: 'inflight', kind: 'restart' });
  });

  it('reports "done" with the real result once lastAck matches the submitted id', () => {
    const node = {
      kind: 'vl', inflight: null,
      lastAck: { id: 'cmd-1', status: 'ok', result: { restarted: true }, at: 2000 },
    };
    const pending = { id: 'cmd-1', kind: 'restart', submittedAt: 1000 };
    expect(vlCommandStatus(node, pending)).toEqual({
      phase: 'done', kind: 'restart', status: 'ok', result: { restarted: true }, at: 2000,
    });
  });

  it('reports a failed ack as done-with-error, not a silent success', () => {
    const node = {
      kind: 'vl', inflight: null,
      lastAck: { id: 'cmd-1', status: 'error', result: { message: 'device offline' }, at: 2000 },
    };
    const pending = { id: 'cmd-1', kind: 'restart', submittedAt: 1000 };
    expect(vlCommandStatus(node, pending).status).toBe('error');
  });

  // Il caso che il brief chiama esplicitamente il piu' facile da sbagliare:
  // un lastAck che esiste ma appartiene a un comando PRECEDENTE non deve
  // essere letto come l'esito di quello appena sottomesso.
  it('does NOT show a stale lastAck from a PREVIOUS command as the result of a new one', () => {
    const node = {
      kind: 'vl', inflight: null,
      lastAck: { id: 'cmd-OLD', status: 'ok', result: {}, at: 500 },
    };
    const pending = { id: 'cmd-NEW', kind: 'restart', submittedAt: 1000 };
    const status = vlCommandStatus(node, pending);
    expect(status.phase).toBe('submitted');
    expect(status.phase).not.toBe('done');
  });

  it('shows the last known ack even with nothing pending in this session (sheet reopened later)', () => {
    const node = {
      kind: 'vl', inflight: null,
      lastAck: { id: 'cmd-1', status: 'ok', result: { version: '1.2.3' }, at: 2000 },
    };
    expect(vlCommandStatus(node, null)).toEqual({
      phase: 'done', kind: null, status: 'ok', result: { version: '1.2.3' }, at: 2000,
    });
  });

  it('inflight wins over a pending session command that has not caught up yet', () => {
    // Un altro comando (magari da un'altra sessione/scheda) e' in volo ORA:
    // e' lo stato piu' fresco che il server conosce, va mostrato comunque.
    const node = { kind: 'vl', inflight: { id: 'cmd-OTHER', kind: 'logs', status: 'sent' }, lastAck: null };
    const pending = { id: 'cmd-NEW', kind: 'restart', submittedAt: 1000 };
    expect(vlCommandStatus(node, pending)).toEqual({ phase: 'inflight', kind: 'logs' });
  });
});
