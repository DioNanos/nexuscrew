import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatTileView from '../components/chat/ChatTileView.jsx';
import ChatDemoGrid from '../components/chat/ChatDemoGrid.jsx';
import { RUN_STATE, applyEvents, canApprove, createView } from './chat-model.js';
import { BASE, OWNER, TARGETS } from './chat-fixtures.js';

const SESSION = 's-can';
const REVIEW = { displayCommand: 'rm -rf demo', cwd: '/demo', targets: ['demo'], effectiveUser: 'demo', complete: true };
const REVIEWS = { a1: REVIEW, a2: REVIEW, zzz: REVIEW };

function frame({ target = TARGETS.cli, boot = 'boot-a', gen = 1, seq, type, run = 'r1', data = {}, kind = 'cli_adapter' }) {
  return {
    protocol: 'nc-chat/1',
    type: 'event',
    target,
    event: { sessionId: SESSION, runId: run, type, source: { kind, ownerId: OWNER, bootId: boot, generation: gen, seq }, data },
  };
}
const start = (seq = 1, run = 'r1') => frame({ seq, run, type: 'run_started' });
const approval = (seq, id = 'a1', hash = 'a'.repeat(64), run = 'r1') => frame({
  seq, type: 'approval_requested', run,
  data: { approvalId: id, commandHash: hash, epoch: 1, ruleIds: ['d2'], coverage: 'complete', remainingMs: 90000, reviewAvailable: true },
});
const resolved = (seq, id = 'a1', run = 'r1') => frame({ seq, type: 'approval_resolved', run, data: { approvalId: id, decision: 'approved' } });
const terminal = (seq, type = 'run_done', run = 'r1') => frame({ seq, type, run, data: { stopReason: 'stop' } });
const brokerReset = (seq = 10) => frame({
  seq, type: 'stream_reset',
  data: { scope: 'broker_view', reason: 'broker_restart', currentCursor: { ownerId: OWNER, sessionId: SESSION, bootId: 'boot-a', generation: 1, seq } },
});

function view(frames, viewer = { canApprove: true }) {
  return applyEvents(createView({ target: TARGETS.cli, viewer, now: BASE, reviews: REVIEWS }), frames);
}

const validRun = {
  state: RUN_STATE.AWAITING_APPROVAL, terminal: null, fenced: false, gap: null, reset: null,
};
const validApproval = { approvalId: 'a1', resolved: null, invalidated: null, actionable: true, review: REVIEW };
const approver = { canApprove: true };
const reader = { canApprove: false };

describe('canApprove — table', () => {
  const rows = [
    ['valid pending', validRun, validApproval, approver, true],
    ['running is eligible', { ...validRun, state: RUN_STATE.RUNNING }, validApproval, approver, true],
    ['admitted is eligible', { ...validRun, state: RUN_STATE.ADMITTED }, validApproval, approver, true],
    ['unknown', { ...validRun, state: RUN_STATE.UNKNOWN }, validApproval, approver, false],
    ['done', { ...validRun, state: RUN_STATE.DONE }, validApproval, approver, false],
    ['error', { ...validRun, state: RUN_STATE.ERROR }, validApproval, approver, false],
    ['cancelled', { ...validRun, state: RUN_STATE.CANCELLED }, validApproval, approver, false],
    ['cancel_requested', { ...validRun, state: RUN_STATE.CANCEL_REQUESTED }, validApproval, approver, false],
    ['submitted', { ...validRun, state: RUN_STATE.SUBMITTED }, validApproval, approver, false],
    ['no state', { ...validRun, state: null }, validApproval, approver, false],
    ['terminal object present', { ...validRun, terminal: { type: 'run_done' } }, validApproval, approver, false],
    ['fenced', { ...validRun, fenced: true }, validApproval, approver, false],
    ['gap', { ...validRun, gap: { count: 1 } }, validApproval, approver, false],
    ['reset', { ...validRun, reset: { scope: 'broker_view' } }, validApproval, approver, false],
    ['invalidated', validRun, { ...validApproval, invalidated: 'seq-payload' }, approver, false],
    ['resolved', validRun, { ...validApproval, resolved: 'approved' }, approver, false],
    ['model says not actionable', validRun, { ...validApproval, actionable: false }, approver, false],
    ['review missing', validRun, { ...validApproval, review: null }, approver, false],
    ['review incomplete', validRun, { ...validApproval, review: { ...REVIEW, complete: false } }, approver, false],
    ['review complete missing', validRun, { ...validApproval, review: { displayCommand: 'x' } }, approver, false],
    ['reader', validRun, validApproval, reader, false],
    ['no viewer', validRun, validApproval, {}, false],
    ['no approval', validRun, null, approver, false],
  ];

  it.each(rows)('%s', (_name, state, approval, viewer, expected) => {
    expect(canApprove(state, approval, viewer)).toBe(expected);
  });
});

describe('canApprove — R6.a: cancel after a terminal / other run', () => {
  const cases = [
    ['done then cancel', [start(1), approval(2), terminal(3, 'run_done'), { type: 'cancel_requested' }]],
    ['error then cancel', [start(1), approval(2), terminal(3, 'run_error'), { type: 'cancel_requested' }]],
    ['cancelled then cancel', [start(1), approval(2), terminal(3, 'run_cancelled'), { type: 'cancel_requested' }]],
    ['cancel of another run', [start(1, 'r1'), start(2, 'r2'), approval(3, 'a2', 'a'.repeat(64), 'r2'), { type: 'cancel_requested', runId: 'r1' }]],
  ];

  it.each(cases)('%s', (_name, frames) => {
    const v = view(frames);
    expect(v.approval).not.toBeNull();
    expect(canApprove(v, v.approval, approver)).toBe(false);
  });

  it('renders the button disabled for done then cancel', () => {
    const frames = [start(1), approval(2), terminal(3), { type: 'cancel_requested' }];
    render(<ChatTileView target={TARGETS.cli} events={frames} now={BASE} reviews={REVIEWS} viewer={approver} />);
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(true);
  });
});

describe('canApprove — R6.b: view reset leaves no approval', () => {
  const frames = [start(1), approval(2), brokerReset(10)];
  it('reducer: false even if the model left actionable true', () => {
    const v = view(frames);
    expect(v.state).toBe(RUN_STATE.UNKNOWN);
    expect(v.reset).not.toBeNull();
    expect(canApprove(v, v.approval, approver)).toBe(false);
  });
  it('renderer: disabled', () => {
    render(<ChatTileView target={TARGETS.cli} events={frames} now={BASE} reviews={REVIEWS} viewer={approver} />);
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(true);
  });
});

describe('canApprove — R6.c: foreign resolutions do not enable', () => {
  const cases = [
    ['gap then foreign', [start(1), approval(2), frame({ seq: 3, type: 'gap', data: { count: 2, reason: 'overflow' } }), resolved(4, 'zzz')]],
    ['reset then foreign', [start(1), approval(2), brokerReset(10), resolved(11, 'zzz')]],
    ['conflict then foreign', [start(1), approval(2, 'a1', 'a'.repeat(64)), approval(2, 'a1', 'b'.repeat(64)), resolved(3, 'zzz')]],
    ['no approval, foreign only', [start(1), resolved(2, 'zzz')]],
  ];

  it.each(cases)('%s', (_name, frames) => {
    const v = view(frames);
    expect(canApprove(v, v.approval, approver)).toBe(false);
  });

  it('renderer: conflict then foreign stays disabled', () => {
    const frames = [start(1), approval(2, 'a1', 'a'.repeat(64)), approval(2, 'a1', 'b'.repeat(64)), resolved(3, 'zzz')];
    render(<ChatTileView target={TARGETS.cli} events={frames} now={BASE} reviews={REVIEWS} viewer={approver} />);
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(true);
  });
});

describe('canApprove — R6.d: a new request after reconciliation stays disabled', () => {
  const sourceReset = {
    protocol: 'nc-chat/1', type: 'reset', target: TARGETS.cli, sessionId: SESSION,
    scope: 'source', reason: 'host_restart',
    currentCursor: { ownerId: OWNER, sessionId: SESSION, bootId: 'boot-b', generation: 1, seq: 10 },
  };
  const startB = frame({ seq: 20, run: 'r2', boot: 'boot-b', type: 'run_started' });
  const approvalB = frame({
    seq: 21, run: 'r2', boot: 'boot-b', type: 'approval_requested',
    data: { approvalId: 'a2', commandHash: 'c'.repeat(64), epoch: 1, ruleIds: ['d2'], coverage: 'complete', remainingMs: 90000, reviewAvailable: true },
  });
  const cases = [
    ['gap', [start(1, 'r1'), frame({ seq: 2, type: 'gap', data: { count: 1, reason: 'overflow' } }), start(20, 'r2'), approval(21, 'a2', 'c'.repeat(64), 'r2')]],
    ['broker reset', [start(1, 'r1'), brokerReset(10), start(20, 'r2'), approval(21, 'a2', 'c'.repeat(64), 'r2')]],
    ['source reset', [start(1, 'r1'), sourceReset, startB, approvalB]],
  ];

  it.each(cases)('%s then a new run and a new request', (_name, frames) => {
    const v = view(frames);
    expect(v.runId).toBe('r2');
    expect(v.approval.approvalId).toBe('a2');
    expect(canApprove(v, v.approval, approver)).toBe(false);
  });

  it('renderer: disabled after a broker reset and a new request', () => {
    const frames = [start(1, 'r1'), brokerReset(10), start(20, 'r2'), approval(21, 'a2', 'c'.repeat(64), 'r2')];
    render(<ChatTileView target={TARGETS.cli} events={frames} now={BASE} reviews={REVIEWS} viewer={approver} />);
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(true);
  });
});

describe('demo notice', () => {
  it('is present with role=status in a chat tile', () => {
    render(<ChatTileView target={TARGETS.cli} events={[start(1)]} now={BASE} reviews={REVIEWS} />);
    const notice = screen.getByTestId('chat-demo-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('approvazioni dimostrative, semantica non qualificata');
  });

  it('appears once per tile in the demo grid', () => {
    const { container } = render(<ChatDemoGrid />);
    const notices = Array.from(container.querySelectorAll('[data-testid="chat-demo-notice"]'));
    expect(notices).toHaveLength(2);
    expect(notices[0].textContent).toContain('semantica non qualificata');
  });
});
