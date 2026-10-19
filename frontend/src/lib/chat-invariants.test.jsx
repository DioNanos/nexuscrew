import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatTileView from '../components/chat/ChatTileView.jsx';
import { RUN_STATE, applyEvents, createView } from './chat-model.js';
import { BASE, OWNER, REVIEWS, TARGETS } from './chat-fixtures.js';

const SESSION = 's-inv';
const NODE = '11111111111111111111111111111111';
const INV_REVIEWS = {
  a1: { displayCommand: 'rm -rf demo-a1', cwd: '/demo', targets: ['demo-a1'], effectiveUser: 'demo', complete: true },
  a2: { displayCommand: 'rm -rf demo-a2', cwd: '/demo', targets: ['demo-a2'], effectiveUser: 'demo', complete: true },
  zzz: { displayCommand: 'rm -rf demo-zzz', cwd: '/demo', targets: ['demo-zzz'], effectiveUser: 'demo', complete: true },
};

function frame({
  target = TARGETS.cli, kind = 'cli_adapter', boot = 'boot-a', gen = 1, seq,
  type, run = 'r1', data = {}, toolCallId, session = SESSION,
}) {
  return {
    protocol: 'nc-chat/1',
    type: 'event',
    target,
    event: {
      sessionId: session,
      runId: run,
      ...(toolCallId ? { toolCallId } : {}),
      type,
      source: { kind, ownerId: OWNER, bootId: boot, generation: gen, seq },
      data,
    },
  };
}

function reset({ target = TARGETS.cli, boot, gen, seq = 10, scope = 'source', session = SESSION, reason = 'host_restart' }) {
  return {
    protocol: 'nc-chat/1',
    type: 'reset',
    target,
    sessionId: session,
    scope,
    reason,
    currentCursor: { ownerId: OWNER, nodeId: NODE, sessionId: session, bootId: boot, generation: gen, seq },
  };
}

function eventReset({ boot, gen, seq = 10, scope = 'source', session = SESSION, sourceBoot = boot, sourceGen = gen }) {
  return frame({
    boot: sourceBoot, gen: sourceGen, seq, type: 'stream_reset',
    session,
    data: {
      scope,
      reason: 'host_restart',
      currentCursor: { ownerId: OWNER, nodeId: NODE, sessionId: session, bootId: boot, generation: gen, seq },
    },
  });
}

const approval = (seq, id = 'a1', hash = 'a'.repeat(64), run = 'r1') => frame({
  seq, type: 'approval_requested', run,
  data: { approvalId: id, commandHash: hash, epoch: 1, ruleIds: ['d2.rm'], coverage: 'complete', remainingMs: 90000, reviewAvailable: true },
});

const resolved = (seq, id = 'a1', decision = 'approved', run = 'r1') => frame({
  seq, type: 'approval_resolved', run, data: { approvalId: id, decision },
});

const start = (seq = 1, run = 'r1', boot = 'boot-a', gen = 1) => frame({ seq, run, boot, gen, type: 'run_started', data: {} });

function reduce(frames, { viewer = { canApprove: true }, reviews = INV_REVIEWS, target } = {}) {
  const t = target || frames[0]?.target || TARGETS.cli;
  return applyEvents(createView({ target: t, viewer, now: BASE, reviews }), frames);
}

function renderFrames(frames, props = {}) {
  const target = props.target || frames[0]?.target || TARGETS.cli;
  return render(
    <ChatTileView target={target} events={frames} now={BASE} reviews={INV_REVIEWS} viewer={{ canApprove: true }} {...props} />,
  );
}

// ---------------------------------------------------------------------------
describe('I1 — reset validated against the previous state', () => {
  const cases = [
    ['event reset, same boot, lower generation', [start(1, 'r1', 'boot-a', 7), eventReset({ boot: 'boot-a', gen: 6, seq: 100 })], 'boot-a', 7, 'older-same-boot'],
    ['top-level reset, same boot, lower generation', [start(1, 'r1', 'boot-a', 7), reset({ boot: 'boot-a', gen: 6, seq: 100 })], 'boot-a', 7, 'older-same-boot'],
    ['event reset, same boot, higher generation', [start(1, 'r1', 'boot-a', 7), eventReset({ boot: 'boot-a', gen: 8, seq: 100 })], 'boot-a', 8, null],
    ['top-level reset, same boot, higher generation', [start(1, 'r1', 'boot-a', 7), reset({ boot: 'boot-a', gen: 8, seq: 100 })], 'boot-a', 8, null],
    ['event reset, new boot from 7 to 1', [start(1, 'r1', 'boot-a', 7), eventReset({ boot: 'boot-b', gen: 1, seq: 100 })], 'boot-b', 1, null],
    ['top-level reset, new boot from 7 to 1', [start(1, 'r1', 'boot-a', 7), reset({ boot: 'boot-b', gen: 1, seq: 100 })], 'boot-b', 1, null],
  ];

  it.each(cases)('%s', (_name, frames, boot, gen, reason) => {
    const view = reduce(frames);
    expect(view.bootId).toBe(boot);
    expect(view.generation).toBe(gen);
    if (reason) expect(view.conflicts.some((c) => c.kind === 'stale-reset' && c.reason === reason)).toBe(true);
    else expect(view.conflicts.some((c) => c.kind === 'stale-reset')).toBe(false);
  });

  it('refuses a reset without a cursor', () => {
    const bad = frame({ seq: 100, type: 'stream_reset', data: { scope: 'source', reason: 'host_restart' } });
    const view = reduce([start(), bad]);
    expect(view.conflicts.some((c) => c.kind === 'stale-reset' && c.reason === 'missing-cursor')).toBe(true);
    expect(view.generation).toBe(1);
  });

  it('refuses a cursor that contradicts the source boot', () => {
    const bad = eventReset({ boot: 'boot-c', gen: 2, seq: 100, sourceBoot: 'boot-b', sourceGen: 2 });
    const view = reduce([start(), bad]);
    expect(view.conflicts.some((c) => c.kind === 'stale-reset' && c.reason === 'cursor-source-mismatch')).toBe(true);
  });

  it('drops a non-reset frame from another epoch', () => {
    const view = reduce([start(), reset({ boot: 'boot-b', gen: 2, seq: 10 }), frame({ boot: 'boot-a', seq: 99, type: 'text_delta', data: { text: 'vecchio', fragmentIndex: 0 } })]);
    expect(view.bootId).toBe('boot-b');
    expect(view.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('I2 — view reset and source-epoch change are distinct', () => {
  it('accepts repeated broker_view resets on the same source', () => {
    const view = reduce([
      start(1),
      reset({ boot: 'boot-a', gen: 1, seq: 10, scope: 'broker_view' }),
      reset({ boot: 'boot-a', gen: 1, seq: 11, scope: 'broker_view' }),
    ]);
    expect(view.conflicts).toHaveLength(0);
    expect(view.retired).toHaveLength(0);
    expect(view.bootId).toBe('boot-a');
    expect(view.lastSeq).toBe(11);
  });

  it('accepts two broker_view resets in the event form too', () => {
    const view = reduce([
      start(1),
      eventReset({ boot: 'boot-a', gen: 1, seq: 10, scope: 'broker_view' }),
      eventReset({ boot: 'boot-a', gen: 1, seq: 11, scope: 'broker_view' }),
    ]);
    expect(view.conflicts).toHaveLength(0);
    expect(view.bootId).toBe('boot-a');
  });

  it('refuses a broker_view reset that tries to move the source epoch', () => {
    const view = reduce([start(1), reset({ boot: 'boot-b', gen: 2, seq: 10, scope: 'broker_view' })]);
    expect(view.bootId).toBe('boot-a');
    expect(view.conflicts.some((c) => c.kind === 'stale-reset' && c.reason === 'broker-reset-source-mismatch')).toBe(true);
  });

  it('retires the old epoch only on a real source change, then refuses it', () => {
    const view = reduce([
      start(1),
      reset({ boot: 'boot-b', gen: 2, seq: 10, scope: 'source' }),
      reset({ boot: 'boot-a', gen: 1, seq: 50, scope: 'source' }),
    ]);
    expect(view.bootId).toBe('boot-b');
    expect(view.conflicts.some((c) => c.kind === 'stale-reset' && c.reason === 'retired-epoch')).toBe(true);
  });

  it('keeps two broker_view resets valid after a source change', () => {
    const view = reduce([
      start(1),
      reset({ boot: 'boot-b', gen: 2, seq: 10, scope: 'source' }),
      reset({ boot: 'boot-b', gen: 2, seq: 11, scope: 'broker_view' }),
      reset({ boot: 'boot-b', gen: 2, seq: 12, scope: 'broker_view' }),
    ]);
    expect(view.conflicts).toHaveLength(0);
    expect(view.bootId).toBe('boot-b');
  });
});

// ---------------------------------------------------------------------------
describe('I3 — invalidation is durable until reconciliation', () => {
  it('keeps the request invalid across a later delivery of the same id', () => {
    const view = reduce([
      start(1),
      approval(2, 'a1', 'a'.repeat(64)),
      approval(2, 'a1', 'b'.repeat(64)), // same key, different payload
      approval(3, 'a1', 'a'.repeat(64)), // new delivery, no reconciliation
    ]);
    expect(view.conflicts.some((c) => c.kind === 'seq-payload')).toBe(true);
    expect(view.approval.approvalId).toBe('a1');
    expect(view.approval.actionable).toBe(false);
    expect(view.approval.invalidated).toBe('seq-payload');
    expect(view.approvalInvalid.a1).toBe('seq-payload');
  });

  it('does not invalidate a valid request, and an identical replay stays inert', () => {
    const request = approval(2);
    const view = reduce([start(1), request, { ...request, event: { ...request.event, data: { ...request.event.data } } }]);
    expect(view.conflicts).toHaveLength(0);
    expect(view.approval.actionable).toBe(true);
    expect(view.approval.invalidated).toBeUndefined();
  });

  it('reconciles the invalidation when the request is resolved', () => {
    const view = reduce([
      start(1),
      approval(2, 'a1', 'a'.repeat(64)),
      approval(2, 'a1', 'b'.repeat(64)),
      resolved(3, 'a1'),
    ]);
    expect(view.approvalInvalid.a1).toBeUndefined();
    expect(view.approval.resolved).toBe('approved');
    expect(view.state).toBe(RUN_STATE.RUNNING);
  });

  it('reconciles the invalidation on a new run', () => {
    const view = reduce([
      start(1),
      approval(2, 'a1', 'a'.repeat(64)),
      approval(2, 'a1', 'b'.repeat(64)),
      start(4, 'r2'),
    ]);
    expect(view.approvalInvalid).toEqual({});
    expect(view.state).toBe(RUN_STATE.ADMITTED);
    expect(view.runId).toBe('r2');
  });

  it('never enables the action for a reader', () => {
    const view = reduce([start(1), approval(2)], { viewer: { canApprove: false } });
    expect(view.approval.actionable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('I4 — cancel fences the run until terminal or reconciliation', () => {
  const cancel = { type: 'cancel_requested' };

  it('fences and invalidates a pending request', () => {
    const view = reduce([start(1), approval(2), cancel]);
    expect(view.state).toBe(RUN_STATE.CANCEL_REQUESTED);
    expect(view.fenced).toBe(true);
    expect(view.approval.actionable).toBe(false);
    expect(view.approval.invalidated).toBe('cancel_requested');
  });

  it('stays fenced when the current request is resolved', () => {
    const view = reduce([start(1), approval(2), cancel, resolved(3, 'a1')]);
    expect(view.state).toBe(RUN_STATE.CANCEL_REQUESTED);
    expect(view.approval.resolved).toBe('approved');
    expect(view.approval.actionable).toBe(false);
  });

  it('stays fenced when the same request is delivered again', () => {
    const view = reduce([start(1), approval(2), cancel, approval(3)]);
    expect(view.state).toBe(RUN_STATE.CANCEL_REQUESTED);
    expect(view.approval.approvalId).toBe('a1');
    expect(view.approval.actionable).toBe(false);
    expect(view.approval.invalidated).toBe('cancel_requested');
  });

  it('stays fenced on late content', () => {
    const view = reduce([start(1), approval(2), cancel, frame({ seq: 3, type: 'text_delta', data: { text: 'tardi', fragmentIndex: 0 } })]);
    expect(view.state).toBe(RUN_STATE.CANCEL_REQUESTED);
    expect(view.messages.at(-1).text).toBe('tardi');
  });

  it('closes on a terminal', () => {
    const view = reduce([start(1), approval(2), cancel, frame({ seq: 3, type: 'run_done', data: { stopReason: 'cancelled' } })]);
    expect(view.state).toBe(RUN_STATE.DONE);
    expect(view.fenced).toBe(false);
  });

  it('reconciles on a new run', () => {
    const view = reduce([start(1), approval(2), cancel, start(4, 'r2')]);
    expect(view.fenced).toBe(false);
    expect(view.state).toBe(RUN_STATE.ADMITTED);
  });

  it('reconciles on a source-epoch reset', () => {
    const view = reduce([start(1), approval(2), cancel, reset({ boot: 'boot-b', gen: 2, seq: 10, scope: 'source' })]);
    expect(view.fenced).toBe(false);
    expect(view.state).toBe(RUN_STATE.UNKNOWN);
  });
});

// ---------------------------------------------------------------------------
describe('I5 — awaiting only with a current pending request', () => {
  it('moves to running when the current request is resolved', () => {
    const view = reduce([start(1), approval(2, 'a1'), resolved(3, 'a1')]);
    expect(view.state).toBe(RUN_STATE.RUNNING);
  });

  it('stays awaiting when another request is still pending', () => {
    const view = reduce([start(1), approval(2, 'a1'), approval(3, 'a2'), resolved(4, 'a1')]);
    expect(view.approval.approvalId).toBe('a2');
    expect(view.approval.resolved).toBeNull();
    expect(view.state).toBe(RUN_STATE.AWAITING_APPROVAL);
  });

  it('does not recreate awaiting from a foreign resolution after the decision', () => {
    const view = reduce([start(1), approval(2, 'a1'), resolved(3, 'a1'), resolved(4, 'zzz', 'denied')]);
    expect(view.state).toBe(RUN_STATE.RUNNING);
  });

  it('does not reopen a consumed decision', () => {
    const view = reduce([start(1), approval(2, 'a1'), resolved(3, 'a1'), approval(4, 'a1')]);
    expect(view.approval.resolved).toBe('approved');
    expect(view.state).toBe(RUN_STATE.RUNNING);
  });

  it('does not touch a terminal with a foreign resolution', () => {
    const view = reduce([start(1), frame({ seq: 2, type: 'run_done', data: { stopReason: 'stop' } }), resolved(3, 'zzz')]);
    expect(view.state).toBe(RUN_STATE.DONE);
    expect(view.terminal.type).toBe('run_done');
  });

  it('does not touch a cancelled run with a foreign resolution', () => {
    const view = reduce([start(1), approval(2), { type: 'cancel_requested' }, resolved(4, 'zzz')]);
    expect(view.state).toBe(RUN_STATE.CANCEL_REQUESTED);
  });
});

// ---------------------------------------------------------------------------
describe('renderer — the same invariants are visible', () => {
  it('shows the conflict and keeps the previous epoch after a bad event reset', () => {
    const { container } = renderFrames([start(1, 'r1', 'boot-a', 7), eventReset({ boot: 'boot-a', gen: 6, seq: 100 })]);
    expect(container.querySelector('[data-testid="chat-conflicts"]')).toBeTruthy();
    expect(container.textContent).toContain('reset rifiutato');
  });

  it('shows no conflict for two legitimate broker_view resets', () => {
    const { container } = renderFrames([
      start(1, 'r1', 'boot-a', 1),
      reset({ boot: 'boot-a', gen: 1, seq: 10, scope: 'broker_view' }),
      reset({ boot: 'boot-a', gen: 1, seq: 11, scope: 'broker_view' }),
    ]);
    expect(container.querySelector('[data-testid="chat-conflicts"]')).toBeNull();
  });

  it('keeps Approva disabled after a conflict and a later delivery', () => {
    const { container } = renderFrames([
      start(1),
      approval(2, 'a1', 'a'.repeat(64)),
      approval(2, 'a1', 'b'.repeat(64)),
      approval(3, 'a1', 'a'.repeat(64)),
    ]);
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(true);
    expect(screen.getByTestId('approval-invalidated').textContent).toContain('seq-payload');
    expect(container.querySelector('[data-testid="chat-conflicts"]')).toBeTruthy();
  });

  it('keeps the run cancelled and Approva disabled after a later delivery', () => {
    const { container } = renderFrames([start(1), approval(2), { type: 'cancel_requested' }, approval(3)]);
    expect(container.querySelector('.nc-chat').getAttribute('data-state')).toBe('cancel_requested');
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(true);
  });

  it('does not show awaiting after a foreign resolution', () => {
    const { container } = renderFrames([start(1), approval(2, 'a1'), resolved(3, 'a1'), resolved(4, 'zzz')]);
    expect(container.querySelector('.nc-chat').getAttribute('data-state')).toBe('running');
  });

  it('preserves the valid cases: actionable approval and normal done', () => {
    const active = renderFrames([start(1), approval(2)]);
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(false);
    active.unmount();
    const { container } = renderFrames([start(1), frame({ seq: 2, type: 'run_done', data: { stopReason: 'stop' } })]);
    expect(container.querySelector('.nc-chat').getAttribute('data-state')).toBe('done');
  });
});
