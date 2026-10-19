import { describe, expect, it } from 'vitest';
import {
  RUN_STATE, applyEvents, applyEvent, createView, markCancelRequested, toolDuration,
} from './chat-model.js';
import {
  BASE, TARGETS, cliApprovalEvents, cliApprovalResolvedEvents, cliCancelledEvents, cliErrorEvents,
  cliRunningEvents, duplicateSeqEvents, gapEvents, longTextEvents, markupEvents, oldBootEvents,
  resetEvents, turnEndThenToolEvents, vlDoneEvents,
} from './chat-fixtures.js';

// Target from the fixture itself: CLI fixtures must not be applied to a VL
// view (the reducer drops frames for another target, by design).
const viewOf = (events, viewer = { canApprove: false }) => applyEvents(
  createView({ target: events[0]?.target || TARGETS.vl, viewer, now: BASE }),
  events,
);

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

  it('exposes awaiting approval and keeps the review for approvers', () => {
    const view = viewOf(cliApprovalEvents('sess-cli-1'));
    expect(view.state).toBe(RUN_STATE.AWAITING_APPROVAL);
    expect(view.approval.approvalId).toBe('ap-1');
    expect(view.approval.review.displayCommand).toBe('rm -rf build/tmp');
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

describe('chat-model ordering and duplicates', () => {
  it('drops a duplicate seq', () => {
    const view = viewOf(duplicateSeqEvents());
    const texts = view.messages.map((m) => m.text).join('');
    expect(texts).toBe('primo');
    expect(view.dropped).toBe(1);
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

  it('renders one message when deltas are followed by the final message', () => {
    const view = viewOf(vlDoneEvents());
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0].text).toBe('Ciao dal nodo');
    expect(view.messages[0].streaming).toBe(false);
    expect(view.items.filter((i) => i.kind === 'message')).toHaveLength(1);
  });

  it('does not close the run on turn_end when a tool follows', () => {
    const view = viewOf(turnEndThenToolEvents());
    expect(view.state).toBe(RUN_STATE.DONE);
    expect(view.tools).toHaveLength(1);
    expect(view.terminal.type).toBe('run_done');
    const partial = applyEvents(createView({ target: TARGETS.cli, now: BASE }), turnEndThenToolEvents().slice(0, 3));
    expect(partial.turnEnded).toBe(true);
    expect(partial.state).not.toBe(RUN_STATE.DONE);
  });

  it('keeps two targets with the same sessionId independent', () => {
    const a = applyEvents(createView({ target: TARGETS.vl, now: BASE }), vlDoneEvents('sess-shared'));
    const b = applyEvents(createView({ target: TARGETS.cli, now: BASE }), cliApprovalEvents('sess-shared'));
    expect(a.targetKey).not.toBe(b.targetKey);
    expect(a.state).toBe(RUN_STATE.DONE);
    expect(b.state).toBe(RUN_STATE.AWAITING_APPROVAL);
    expect(a.messages[0].text).toBe('Ciao dal nodo');
    expect(b.messages[0].text).toBe('Serve il tuo OK');
  });

  it('ignores frames for another target', () => {
    const view = createView({ target: TARGETS.vl, now: BASE });
    const next = applyEvent(view, vlDoneEvents()[0]);
    const foreign = { ...vlDoneEvents()[1], target: TARGETS.cli };
    expect(applyEvent(next, foreign)).toBe(next);
  });
});

describe('chat-model approval lifecycle', () => {
  it('resolves an approval and returns to running', () => {
    const view = viewOf(cliApprovalResolvedEvents());
    expect(view.approval.resolved).toBe('denied');
    expect(view.state).toBe(RUN_STATE.DONE);
  });

  it('keeps the approval when a terminal arrives (no fake reopen)', () => {
    const done = {
      protocol: 'nc-chat/1',
      type: 'event',
      target: TARGETS.cli,
      event: {
        sessionId: 'sess-cli-1',
        runId: 'run-1',
        type: 'run_done',
        source: { kind: 'cli_adapter', bootId: 'boot-a', generation: 1, seq: 7 },
        data: { stopReason: 'stop', effectsState: 'none' },
      },
    };
    const view = viewOf([...cliApprovalEvents(), done]);
    expect(view.approval).not.toBeNull();
    expect(view.state).toBe(RUN_STATE.DONE);
  });
});

describe('chat-model tool duration', () => {
  it('returns null when the source has no both timestamps', () => {
    const view = applyEvents(createView({ target: TARGETS.cli, now: BASE }), [
      { protocol: 'nc-chat/1', type: 'event', target: TARGETS.cli, event: { sessionId: 's', runId: 'r', type: 'tool_start', source: { kind: 'cli_adapter', bootId: 'b', generation: 1, seq: 1 }, data: { name: 'bash', toolCallId: 't1' } } },
      { protocol: 'nc-chat/1', type: 'event', target: TARGETS.cli, event: { sessionId: 's', runId: 'r', type: 'tool_end', source: { kind: 'cli_adapter', bootId: 'b', generation: 1, seq: 2 }, data: { name: 'bash', toolCallId: 't1', isError: false } } },
    ]);
    expect(toolDuration(view.tools[0])).toBeNull();
    expect(view.tools[0].state).toBe('ok');
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
