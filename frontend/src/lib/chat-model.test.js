import { describe, expect, it } from 'vitest';
import {
  RUN_STATE, applyEvents, applyEvent, createView, markCancelRequested, toolDuration,
} from './chat-model.js';
import {
  BASE, REVIEWS, TARGETS, approvalConflictEvents, approvalReplayEvents, approvalThenTerminalEvents, cliApprovalEvents,
  cliApprovalResolvedEvents, cliCancelledEvents, cliErrorEvents, cliNoRunStartedEvents,
  cliRunningEvents, duplicateSeqEvents, gapEvents, identicalReplayEvents, incompleteReviewEvents,
  longTextEvents, markupEvents, oldBootEvents, oldResetEvents, repeatedFragmentEvents,
  generationRestartEvents, resetEvents, terminalConflictEvents, topLevelGapEvents, topLevelOldResetEvents, topLevelResetEvents,
  turnEndThenToolEvents, twoApprovalsEvents, twoRunsEvents, vlDoneEvents, vlNoStartEvents,
} from './chat-fixtures.js';

// Target from the fixture itself: CLI fixtures must not be applied to a VL
// view (the reducer drops frames for another target, by design).
function viewOf(events, viewer = { canApprove: false }, reviews = {}) {
  return applyEvents(
    createView({ target: events[0]?.target || TARGETS.vl, viewer, now: BASE, reviews }),
    events,
  );
}

describe('chat-model states', () => {
  it('starts submitted with no events', () => {
    expect(createView({ target: TARGETS.vl }).state).toBe(RUN_STATE.SUBMITTED);
  });

  it('moves to admitted, then running, then done', () => {
    const events = vlDoneEvents();
    expect(viewOf(events.slice(0, 1)).state).toBe(RUN_STATE.ADMITTED);
    expect(viewOf(events.slice(0, 2)).state).toBe(RUN_STATE.RUNNING);
    expect(viewOf(events).state).toBe(RUN_STATE.DONE);
  });

  it('admits a CLI run from its first correlated update when run_started is absent', () => {
    const events = cliNoRunStartedEvents();
    const partial = viewOf(events.slice(0, 1));
    expect(partial.started).toBe(true);
    // The first correlated update is the admission proof; the next one runs.
    expect(partial.state).toBe(RUN_STATE.ADMITTED);
    expect(viewOf(events).state).toBe(RUN_STATE.DONE);
  });

  it('does not admit a VL run without the host run_started', () => {
    const view = viewOf(vlNoStartEvents());
    expect(view.started).toBe(false);
    expect(view.state).toBe(RUN_STATE.UNKNOWN);
    expect(view.limit).toBe('missing_run_started');
  });

  it('exposes awaiting approval and keeps the review only for approvers', () => {
    const approver = viewOf(cliApprovalEvents(), { canApprove: true }, REVIEWS);
    expect(approver.state).toBe(RUN_STATE.AWAITING_APPROVAL);
    expect(approver.approval.review.displayCommand).toBe('rm -rf build/tmp');
    expect(approver.approval.actionable).toBe(true);

    const reader = viewOf(cliApprovalEvents(), { canApprove: false }, REVIEWS);
    expect(reader.approval.review).toBeNull();
    expect(reader.approval.actionable).toBe(false);
  });

  it('closes on error and on cancel, not on turn_end', () => {
    expect(viewOf(cliErrorEvents()).state).toBe(RUN_STATE.ERROR);
    expect(viewOf(cliCancelledEvents()).state).toBe(RUN_STATE.CANCELLED);
  });

  it('marks a local cancel request without inventing a terminal', () => {
    const view = markCancelRequested(viewOf(cliRunningEvents()));
    expect(view.state).toBe(RUN_STATE.CANCEL_REQUESTED);
    expect(view.terminal).toBeNull();
  });

  it('treats gap and reset as unknown, never as finished', () => {
    const gap = viewOf(gapEvents());
    expect(gap.state).toBe(RUN_STATE.UNKNOWN);
    expect(gap.terminal).toBeNull();
    expect(gap.gap.count).toBe(3);

    const reset = viewOf(resetEvents());
    expect(reset.state).toBe(RUN_STATE.UNKNOWN);
    expect(reset.terminal).toBeNull();
    expect(reset.reset.reason).toBe('broker_restart');
  });
});

describe('chat-model runs and terminals', () => {
  it('does not let a new run inherit the previous terminal', () => {
    const view = viewOf(twoRunsEvents());
    expect(view.runId).toBe('r2');
    expect(view.state).toBe(RUN_STATE.ADMITTED);
    expect(view.terminal).toBeNull();
    expect(view.messages).toHaveLength(0);
  });

  it('ignores a late terminal from the previous run', () => {
    const events = twoRunsEvents().filter((f) => f.event.type !== 'run_error');
    const withLate = [...events, twoRunsEvents()[4]];
    const view = viewOf(withLate);
    expect(view.runId).toBe('r2');
    expect(view.terminal).toBeNull();
    expect(view.state).toBe(RUN_STATE.ADMITTED);
  });

  it('keeps one logical terminal and reports a conflict instead of replacing it', () => {
    const view = viewOf(terminalConflictEvents());
    expect(view.state).toBe(RUN_STATE.DONE);
    expect(view.terminal.type).toBe('run_done');
    expect(view.conflicts.some((c) => c.kind === 'terminal-conflict')).toBe(true);
  });
});

describe('chat-model ordering and integrity', () => {
  it('drops an identical replay without changing the view', () => {
    const view = viewOf(identicalReplayEvents());
    const texts = view.messages.map((m) => m.text).join('');
    expect(texts).toBe('una volta');
    expect(view.dropped).toBeGreaterThanOrEqual(1);
    expect(view.conflicts).toHaveLength(0);
  });

  it('reports the same seq with a different payload as an integrity conflict', () => {
    const view = viewOf(duplicateSeqEvents());
    expect(view.messages.map((m) => m.text).join('')).toBe('primo');
    expect(view.conflicts.some((c) => c.kind === 'seq-payload')).toBe(true);
    // The conflict does not turn the run into a success or a failure.
    expect(view.state).toBe(RUN_STATE.DONE);
  });

  it('does not duplicate text when a fragment is repeated after the final message', () => {
    const view = viewOf(repeatedFragmentEvents());
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0].text).toBe('A');
  });

  it('drops events from an old boot after a source reset', () => {
    const view = viewOf(oldBootEvents());
    const texts = view.messages.map((m) => m.text).join('');
    expect(texts).toContain('vecchio');
    expect(texts).toContain('nuovo');
    expect(texts).not.toContain('vecchissimo');
    expect(view.bootId).toBe('boot-b');
    expect(view.generation).toBe(2);
  });

  it('refuses a reset back to a retired boot', () => {
    const view = viewOf(oldResetEvents());
    expect(view.bootId).toBe('boot-b');
    expect(view.conflicts.some((c) => c.kind === 'stale-reset')).toBe(true);
    expect(view.messages.map((m) => m.text).join('')).toContain('nuovo');
  });

  it('refuses a replayed top-level reset back to a retired boot', () => {
    const view = viewOf(topLevelOldResetEvents());
    expect(view.bootId).toBe('boot-b');
    expect(view.generation).toBe(2);
    expect(view.messages.map((m) => m.text).join('')).toBe('nuovo');
    expect(view.conflicts.some((c) => c.kind === 'stale-reset' && c.reason === 'retired-epoch')).toBe(true);
  });

  it('accepts a new boot whose generation restarts lower', () => {
    const view = viewOf(generationRestartEvents());
    expect(view.bootId).toBe('boot-b');
    expect(view.generation).toBe(1);
    expect(view.conflicts.some((c) => c.kind === 'stale-reset')).toBe(false);
    expect(view.messages.map((m) => m.text).join('')).toContain('host nuovo');
  });

  it('ignores a top-level gap frame for another target', () => {
    const view = createView({ target: TARGETS.vl, now: BASE });
    const withStart = applyEvent(view, vlDoneEvents()[0]);
    const next = applyEvent(withStart, topLevelGapEvents()[0]);
    expect(next.gap).toBeNull();
    expect(next.state).not.toBe(RUN_STATE.UNKNOWN);
  });

  it('applies a top-level reset frame for the current target', () => {
    const view = viewOf([vlDoneEvents()[0], topLevelResetEvents('sess-vl-1')[0]]);
    expect(view.reset.reason).toBe('broker_restart');
    expect(view.state).toBe(RUN_STATE.UNKNOWN);
  });

  it('uses the canonical toolCallId on the event', () => {
    const ev = (seq, type, extra = {}) => ({
      protocol: 'nc-chat/1',
      type: 'event',
      target: TARGETS.cli,
      event: { sessionId: 's', runId: 'r', type, source: { kind: 'cli_adapter', bootId: 'b', generation: 1, seq }, ...extra },
    });
    const view = viewOf([
      ev(1, 'run_started'),
      ev(2, 'tool_start', { toolCallId: 'tc-9', data: { name: 'bash', at: 10 } }),
      ev(3, 'tool_end', { toolCallId: 'tc-9', data: { name: 'bash', at: 20, isError: false } }),
    ]);
    expect(view.tools[0].toolCallId).toBe('tc-9');
    expect(view.tools[0].state).toBe('ok');
    expect(view.tools[0].endedAt).toBe(20);
  });
});

describe('chat-model approval lifecycle', () => {
  it('correlates a resolution to its approvalId', () => {
    const view = viewOf(twoApprovalsEvents(), { canApprove: true }, REVIEWS);
    expect(view.approval.approvalId).toBe('ap-2');
    expect(view.approval.resolved).toBeNull();
    expect(view.approvals['ap-1'].resolved).toBe('denied');
    expect(view.state).toBe(RUN_STATE.AWAITING_APPROVAL);
  });

  it('does not reopen a consumed decision at replay', () => {
    const view = viewOf(approvalReplayEvents(), { canApprove: true }, REVIEWS);
    expect(view.approval.resolved).toBe('approved');
    expect(view.approval.actionable).toBe(false);
    expect(view.state).not.toBe(RUN_STATE.AWAITING_APPROVAL);
  });

  it('removes the action when the run ends, the source gaps or a review is incomplete', () => {
    const terminal = viewOf(approvalThenTerminalEvents(), { canApprove: true }, REVIEWS);
    expect(terminal.approval.actionable).toBe(false);

    const cliGap = { protocol: 'nc-chat/1', type: 'gap', target: TARGETS.cli, sessionId: 'sess-cli-1', count: 2, reason: 'overflow' };
    const gapped = applyEvents(
      createView({ target: TARGETS.cli, viewer: { canApprove: true }, now: BASE, reviews: REVIEWS }),
      [...cliApprovalEvents(), cliGap],
    );
    expect(gapped.approval.actionable).toBe(false);

    const incomplete = viewOf(incompleteReviewEvents(), { canApprove: true }, REVIEWS);
    expect(incomplete.approval.review.complete).toBe(false);
    expect(incomplete.approval.actionable).toBe(false);
  });

  it('invalidates the pending approval on an integrity conflict', () => {
    const view = viewOf(approvalConflictEvents(), { canApprove: true }, REVIEWS);
    expect(view.approval.actionable).toBe(false);
    expect(view.approval.invalidated).toBe('seq-payload');
    expect(view.conflicts.some((c) => c.kind === 'seq-payload')).toBe(true);
  });

  it('invalidates the pending approval when cancel is requested', () => {
    const view = markCancelRequested(viewOf(cliApprovalEvents(), { canApprove: true }, REVIEWS));
    expect(view.state).toBe(RUN_STATE.CANCEL_REQUESTED);
    expect(view.approval.actionable).toBe(false);
    expect(view.approval.invalidated).toBe('cancel_requested');
  });

  it('keeps the approval when a terminal arrives (no fake reopen)', () => {
    const view = viewOf(approvalThenTerminalEvents(), { canApprove: true }, REVIEWS);
    expect(view.approval).not.toBeNull();
    expect(view.state).toBe(RUN_STATE.DONE);
  });
});

describe('chat-model tool duration', () => {
  it('returns null when the source has no both timestamps', () => {
    const view = viewOf(cliRunningEvents());
    expect(toolDuration(view.tools[0])).toBeNull();
  });

  it('computes the duration when both times exist', () => {
    const view = viewOf(cliApprovalEvents());
    expect(toolDuration(view.tools[0])).toBe(180);
  });
});

describe('chat-model inert data', () => {
  it('keeps markup as text', () => {
    const view = viewOf(markupEvents());
    expect(view.messages[0].text).toContain('<script>');
    expect(view.messages[0].text).toContain('<img');
  });

  it('keeps a long message intact', () => {
    const view = viewOf(longTextEvents());
    expect(view.messages[0].text).toHaveLength(9000);
  });
});
