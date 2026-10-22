// Static nc-chat/1 fixtures for UI-0. No network, no clock at module load:
// timestamps are fixed numbers, so the same fixture renders identically in
// every run. Approval `remainingMs` is relative to the view's `now`.
//
// Identities are synthetic on purpose: owner/node/cell are reserved demo
// values, never derived from the live fleet directory.

export const BASE = 1792400000000;
export const OWNER = '00000000000000000000000000000000';
export const NODE = '11111111111111111111111111111111';
export const CELL = 'ui0-demo-cell';

export const TARGETS = Object.freeze({
  vl: { kind: 'vl_node', ref: `${OWNER}:VL-${NODE}` },
  cli: { kind: 'cli_cell', ref: `${OWNER}:cell-${CELL}` },
});

export const REVIEWS = Object.freeze({
  'ap-1': Object.freeze({
    displayCommand: 'rm -rf build/tmp',
    cwd: '/srv/app',
    targets: Object.freeze(['build/tmp']),
    effectiveUser: 'demo',
    complete: true,
  }),
  'ap-incomplete': Object.freeze({
    displayCommand: 'rm -rf …',
    cwd: '/srv/app',
    targets: Object.freeze(['build/tmp']),
    effectiveUser: 'demo',
    complete: false,
  }),
});

const hex64 = 'a'.repeat(64);

function frame({ target, sessionId, sourceKind = 'vl_host', bootId = 'boot-a', generation = 1, seq, type, runId = 'run-1', toolCallId, data = {} }) {
  const source = {
    kind: sourceKind,
    ownerId: OWNER,
    ...(sourceKind === 'vl_host' ? { nodeId: NODE } : { cellId: CELL }),
    bootId,
    generation,
    seq,
  };
  return {
    protocol: 'nc-chat/1',
    type: 'event',
    target,
    event: {
      sessionId,
      runId,
      ...(toolCallId ? { toolCallId } : {}),
      type,
      source,
      data,
    },
  };
}

function approvalSummary(approvalId, remainingMs = 96000, commandHash = hex64) {
  return {
    approvalId,
    commandHash,
    epoch: 1,
    ruleIds: ['d2.rm-recursive'],
    coverage: 'complete',
    remainingMs,
    reviewAvailable: true,
  };
}

export function vlDoneEvents(sessionId = 'sess-vl-1') {
  const t = { target: TARGETS.vl, sessionId, sourceKind: 'vl_host', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: { originRequestId: 'req-1' } }),
    frame({ ...t, seq: 2, type: 'text_delta', data: { text: 'Ciao', fragmentIndex: 0 } }),
    frame({ ...t, seq: 3, type: 'text_delta', data: { text: ' dal nodo', fragmentIndex: 1 } }),
    frame({ ...t, seq: 4, type: 'message', data: { messageId: 'run-1:assistant', role: 'assistant', text: 'Ciao dal nodo' } }),
    frame({ ...t, seq: 5, type: 'context_status', data: { contextPct: 18 } }),
    frame({ ...t, seq: 6, type: 'turn_end', data: {} }),
    frame({ ...t, seq: 7, type: 'run_done', data: { stopReason: 'stop', effectsState: 'none' } }),
  ];
}

export function cliApprovalEvents(sessionId = 'sess-cli-1', { remainingMs = 96000, approvalId = 'ap-1' } = {}) {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: { originRequestId: 'req-2' } }),
    frame({ ...t, seq: 2, type: 'context_status', data: { cwd: '/srv/app', contextPct: 18 } }),
    frame({ ...t, seq: 3, type: 'tool_start', toolCallId: 'tc-1', data: { name: 'bash', at: BASE } }),
    frame({ ...t, seq: 4, type: 'tool_end', toolCallId: 'tc-1', data: { name: 'bash', at: BASE + 180, isError: false, resultAvailable: true } }),
    frame({ ...t, seq: 5, type: 'text_delta', data: { text: 'Serve il tuo OK', fragmentIndex: 0 } }),
    frame({ ...t, seq: 6, type: 'approval_requested', data: approvalSummary(approvalId, remainingMs) }),
  ];
}

export function cliApprovalResolvedEvents(sessionId = 'sess-cli-1') {
  return [
    ...cliApprovalEvents(sessionId),
    frame({ target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 7, type: 'approval_resolved', data: { approvalId: 'ap-1', decision: 'denied' } }),
    frame({ target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 8, type: 'run_done', data: { stopReason: 'stop', effectsState: 'none' } }),
  ];
}

export function cliErrorEvents(sessionId = 'sess-cli-err') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'run_error', data: { stopReason: 'provider_error', effectsState: 'unknown' } }),
  ];
}

export function cliCancelledEvents(sessionId = 'sess-cli-cancel') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'run_cancelled', data: { stopReason: 'cancelled', effectsState: 'unknown' } }),
  ];
}

export function cliRunningEvents(sessionId = 'sess-cli-run') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'text_delta', data: { text: 'Leggo i file', fragmentIndex: 0 } }),
    frame({ ...t, seq: 3, type: 'tool_start', toolCallId: 'tc-2', data: { name: 'read', at: BASE + 500 } }),
  ];
}

// A CLI adapter without a start ACK: the first correlated update proves
// activity, so the view admits the run without a synthetic run_started.
export function cliNoRunStartedEvents(sessionId = 'sess-cli-admit') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'text_delta', data: { text: 'attività', fragmentIndex: 0 } }),
    frame({ ...t, seq: 2, type: 'run_done', data: { stopReason: 'stop', effectsState: 'none' } }),
  ];
}

// VL has no admission without the host's run_started: the same shape must
// not be admitted, and the view declares the missing start.
export function vlNoStartEvents(sessionId = 'sess-vl-nostart') {
  const t = { target: TARGETS.vl, sessionId, sourceKind: 'vl_host', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'text_delta', data: { text: 'senza start', fragmentIndex: 0 } }),
  ];
}

export function turnEndThenToolEvents(sessionId = 'sess-cli-turn') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'text_delta', data: { text: 'Prima risposta', fragmentIndex: 0 } }),
    frame({ ...t, seq: 3, type: 'turn_end', data: {} }),
    frame({ ...t, seq: 4, type: 'tool_start', toolCallId: 'tc-3', data: { name: 'bash', at: BASE + 1000 } }),
    frame({ ...t, seq: 5, type: 'tool_end', toolCallId: 'tc-3', data: { name: 'bash', at: BASE + 1200, isError: false } }),
    frame({ ...t, seq: 6, type: 'text_delta', data: { text: ' e poi il tool', fragmentIndex: 1 } }),
    frame({ ...t, seq: 7, type: 'run_done', data: { stopReason: 'stop', effectsState: 'completed' } }),
  ];
}

// Same key, different payload: an integrity conflict, not a replay.
export function duplicateSeqEvents(sessionId = 'sess-dup') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'text_delta', data: { text: 'primo', fragmentIndex: 0 } }),
    frame({ ...t, seq: 2, type: 'text_delta', data: { text: ' duplicato', fragmentIndex: 0 } }),
    frame({ ...t, seq: 3, type: 'run_done', data: { stopReason: 'stop', effectsState: 'none' } }),
  ];
}

export function identicalReplayEvents(sessionId = 'sess-replay') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  const delta = frame({ ...t, seq: 2, type: 'text_delta', data: { text: 'una volta', fragmentIndex: 0 } });
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    delta,
    { ...delta, event: { ...delta.event, data: { ...delta.event.data } } },
    frame({ ...t, seq: 3, type: 'run_done', data: { stopReason: 'stop', effectsState: 'none' } }),
  ];
}

export function repeatedFragmentEvents(sessionId = 'sess-frag') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'text_delta', data: { text: 'A', fragmentIndex: 0, messageId: 'm-1' } }),
    frame({ ...t, seq: 3, type: 'message', data: { messageId: 'm-1', role: 'assistant', text: 'A' } }),
    frame({ ...t, seq: 4, type: 'text_delta', data: { text: 'A', fragmentIndex: 0, messageId: 'm-1' } }),
  ];
}

export function oldBootEvents(sessionId = 'sess-boot') {
  const a = { target: TARGETS.vl, sessionId, sourceKind: 'vl_host', bootId: 'boot-a', generation: 1 };
  const b = { target: TARGETS.vl, sessionId, sourceKind: 'vl_host', bootId: 'boot-b', generation: 2 };
  return [
    frame({ ...a, seq: 1, type: 'run_started', data: {} }),
    frame({ ...a, seq: 2, type: 'text_delta', data: { text: 'vecchio', fragmentIndex: 0 } }),
    frame({
      ...b,
      seq: 10,
      type: 'stream_reset',
      data: {
        scope: 'source',
        reason: 'host_restart',
        currentCursor: { ownerId: OWNER, nodeId: NODE, sessionId, bootId: 'boot-b', generation: 2, seq: 10 },
      },
    }),
    frame({ ...a, seq: 99, type: 'text_delta', data: { text: ' vecchissimo', fragmentIndex: 1 } }),
    frame({ ...b, seq: 11, type: 'text_delta', data: { text: ' nuovo', fragmentIndex: 2 } }),
  ];
}

export function oldResetEvents(sessionId = 'sess-oldreset') {
  const a = { target: TARGETS.vl, sessionId, sourceKind: 'vl_host', bootId: 'boot-a', generation: 1 };
  const b = { target: TARGETS.vl, sessionId, sourceKind: 'vl_host', bootId: 'boot-b', generation: 2 };
  return [
    frame({ ...a, seq: 1, type: 'run_started', data: {} }),
    frame({ ...a, seq: 2, type: 'text_delta', data: { text: 'vecchio', fragmentIndex: 0 } }),
    frame({
      ...b,
      seq: 10,
      type: 'stream_reset',
      data: {
        scope: 'source',
        reason: 'host_restart',
        currentCursor: { ownerId: OWNER, nodeId: NODE, sessionId, bootId: 'boot-b', generation: 2, seq: 10 },
      },
    }),
    frame({
      ...a,
      seq: 50,
      type: 'stream_reset',
      data: {
        scope: 'source',
        reason: 'host_restart',
        currentCursor: { ownerId: OWNER, nodeId: NODE, sessionId, bootId: 'boot-a', generation: 1, seq: 50 },
      },
    }),
    frame({ ...b, seq: 11, type: 'text_delta', data: { text: 'nuovo', fragmentIndex: 1 } }),
  ];
}

export function gapEvents(sessionId = 'sess-gap') {
  const t = { target: TARGETS.vl, sessionId, sourceKind: 'vl_host', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'text_delta', data: { text: 'parziale', fragmentIndex: 0 } }),
    frame({ ...t, seq: 3, type: 'gap', data: { count: 3, reason: 'overflow' } }),
  ];
}

export function resetEvents(sessionId = 'sess-reset') {
  const t = { target: TARGETS.vl, sessionId, sourceKind: 'vl_host', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'text_delta', data: { text: 'prima', fragmentIndex: 0 } }),
    frame({
      ...t,
      seq: 3,
      type: 'stream_reset',
      data: {
        scope: 'broker_view',
        reason: 'broker_restart',
        currentCursor: { ownerId: OWNER, nodeId: NODE, sessionId, bootId: 'boot-a', generation: 1, seq: 3 },
      },
    }),
  ];
}

// Top-level control frame (server type), not an event envelope.
export function topLevelGapEvents(sessionId = 'sess-topgap') {
  return [
    { protocol: 'nc-chat/1', type: 'gap', target: TARGETS.cli, sessionId, count: 2, reason: 'overflow' },
  ];
}

export function topLevelResetEvents(sessionId = 'sess-topreset') {
  return [
    {
      protocol: 'nc-chat/1',
      type: 'reset',
      target: TARGETS.vl,
      sessionId,
      scope: 'broker_view',
      reason: 'broker_restart',
      currentCursor: { ownerId: OWNER, nodeId: NODE, sessionId, bootId: 'boot-a', generation: 1, seq: 5 },
    },
  ];
}

export function markupEvents(sessionId = 'sess-markup') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({
      ...t,
      seq: 2,
      type: 'message',
      data: {
        messageId: 'm-markup',
        role: 'assistant',
        text: '<script>window.__pwned = 1</script> <img src=x onerror="window.__pwned = 2"> **non grassetto**',
      },
    }),
    frame({ ...t, seq: 3, type: 'run_done', data: { stopReason: 'stop', effectsState: 'none' } }),
  ];
}

export function longTextEvents(sessionId = 'sess-long') {
  const t = { target: TARGETS.vl, sessionId, sourceKind: 'vl_host', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'message', data: { messageId: 'm-long', role: 'assistant', text: 'A'.repeat(9000) } }),
    frame({ ...t, seq: 3, type: 'run_done', data: { stopReason: 'stop', effectsState: 'none' } }),
  ];
}

export function twoRunsEvents(sessionId = 'sess-two-runs') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', runId: 'r1', data: {} }),
    frame({ ...t, seq: 2, type: 'text_delta', runId: 'r1', data: { text: 'primo run', fragmentIndex: 0 } }),
    frame({ ...t, seq: 3, type: 'run_done', runId: 'r1', data: { stopReason: 'stop', effectsState: 'none' } }),
    frame({ ...t, seq: 4, type: 'run_started', runId: 'r2', data: {} }),
    frame({ ...t, seq: 5, type: 'run_error', runId: 'r1', data: { stopReason: 'provider_error' } }),
  ];
}

export function terminalConflictEvents(sessionId = 'sess-terminal-conflict') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'run_done', data: { stopReason: 'stop', effectsState: 'none' } }),
    frame({ ...t, seq: 3, type: 'run_error', data: { stopReason: 'provider_error' } }),
  ];
}

export function twoApprovalsEvents(sessionId = 'sess-two-approvals') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'approval_requested', data: approvalSummary('ap-1') }),
    frame({ ...t, seq: 3, type: 'approval_requested', data: approvalSummary('ap-2') }),
    frame({ ...t, seq: 4, type: 'approval_resolved', data: { approvalId: 'ap-1', decision: 'denied' } }),
  ];
}

export function approvalReplayEvents(sessionId = 'sess-approval-replay') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'approval_requested', data: approvalSummary('ap-1') }),
    frame({ ...t, seq: 3, type: 'approval_resolved', data: { approvalId: 'ap-1', decision: 'approved' } }),
    frame({ ...t, seq: 4, type: 'approval_requested', data: approvalSummary('ap-1') }),
  ];
}

export function incompleteReviewEvents(sessionId = 'sess-incomplete') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'approval_requested', data: approvalSummary('ap-incomplete') }),
  ];
}

export function approvalThenTerminalEvents(sessionId = 'sess-approval-terminal') {
  return [
    ...cliApprovalEvents(sessionId),
    frame({ target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 7, type: 'run_done', data: { stopReason: 'stop', effectsState: 'none' } }),
  ];
}

export const DEMO = Object.freeze({
  vl: {
    label: 'N900 (demo)',
    sub: 'nodo VL sintetico · vl-agent/1',
    target: TARGETS.vl,
    events: vlDoneEvents(),
    viewer: { canApprove: false },
    reviews: {},
  },
  cli: {
    label: 'Dev (demo)',
    sub: 'cella CLI sintetica · ACP',
    target: TARGETS.cli,
    events: cliApprovalEvents(),
    viewer: { canApprove: true },
    reviews: REVIEWS,
  },
});

// Enumerated builders for the fixture-format contract test: adding a scenario
// here keeps it under the same schema checks.
export const FIXTURE_BUILDERS = Object.freeze({
  vlDone: () => vlDoneEvents(),
  cliApproval: () => cliApprovalEvents(),
  cliApprovalResolved: () => cliApprovalResolvedEvents(),
  cliError: () => cliErrorEvents(),
  cliCancelled: () => cliCancelledEvents(),
  cliRunning: () => cliRunningEvents(),
  cliNoRunStarted: () => cliNoRunStartedEvents(),
  vlNoStart: () => vlNoStartEvents(),
  turnEndThenTool: () => turnEndThenToolEvents(),
  duplicateSeq: () => duplicateSeqEvents(),
  identicalReplay: () => identicalReplayEvents(),
  repeatedFragment: () => repeatedFragmentEvents(),
  oldBoot: () => oldBootEvents(),
  oldReset: () => oldResetEvents(),
  gap: () => gapEvents(),
  reset: () => resetEvents(),
  topLevelGap: () => topLevelGapEvents(),
  topLevelReset: () => topLevelResetEvents(),
  markup: () => markupEvents(),
  longText: () => longTextEvents(),
  twoRuns: () => twoRunsEvents(),
  terminalConflict: () => terminalConflictEvents(),
  twoApprovals: () => twoApprovalsEvents(),
  approvalReplay: () => approvalReplayEvents(),
  incompleteReview: () => incompleteReviewEvents(),
  approvalThenTerminal: () => approvalThenTerminalEvents(),
  approvalConflict: () => approvalConflictEvents(),
  generationRestart: () => generationRestartEvents(),
  topLevelOldReset: () => topLevelOldResetEvents(),
});

// Residual fixture sequences: approval conflicts and generation restarts.
export function approvalConflictEvents(sessionId = 'sess-approval-conflict') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'approval_requested', data: approvalSummary('ap-1') }),
    // Same key, different command: the pending snapshot is ambiguous.
    frame({ ...t, seq: 2, type: 'approval_requested', data: approvalSummary('ap-1', 96000, 'b'.repeat(64)) }),
  ];
}

export function generationRestartEvents(sessionId = 'sess-gen-restart') {
  const a = { target: TARGETS.vl, sessionId, sourceKind: 'vl_host', bootId: 'boot-a', generation: 7 };
  const b = { target: TARGETS.vl, sessionId, sourceKind: 'vl_host', bootId: 'boot-b', generation: 1 };
  return [
    frame({ ...a, seq: 1, type: 'run_started', data: {} }),
    frame({ ...a, seq: 2, type: 'text_delta', data: { text: 'host vecchio', fragmentIndex: 0 } }),
    {
      protocol: 'nc-chat/1',
      type: 'reset',
      target: TARGETS.vl,
      sessionId,
      scope: 'source',
      reason: 'host_restart',
      currentCursor: { ownerId: OWNER, nodeId: NODE, sessionId, bootId: 'boot-b', generation: 1, seq: 0 },
    },
    frame({ ...b, seq: 1, type: 'text_delta', data: { text: 'host nuovo', fragmentIndex: 1 } }),
  ];
}

export function topLevelOldResetEvents(sessionId = 'sess-top-old-reset') {
  const a = { target: TARGETS.vl, sessionId, sourceKind: 'vl_host', bootId: 'boot-a', generation: 1 };
  const b = { target: TARGETS.vl, sessionId, sourceKind: 'vl_host', bootId: 'boot-b', generation: 2 };
  return [
    frame({ ...a, seq: 1, type: 'run_started', data: {} }),
    {
      protocol: 'nc-chat/1',
      type: 'reset',
      target: TARGETS.vl,
      sessionId,
      scope: 'source',
      reason: 'host_restart',
      currentCursor: { ownerId: OWNER, nodeId: NODE, sessionId, bootId: 'boot-b', generation: 2, seq: 10 },
    },
    frame({ ...b, seq: 11, type: 'text_delta', data: { text: 'nuovo', fragmentIndex: 0 } }),
    // Replay of an older top-level control: must not bring boot-a back.
    {
      protocol: 'nc-chat/1',
      type: 'reset',
      target: TARGETS.vl,
      sessionId,
      scope: 'source',
      reason: 'host_restart',
      currentCursor: { ownerId: OWNER, nodeId: NODE, sessionId, bootId: 'boot-a', generation: 1, seq: 50 },
    },
  ];
}
