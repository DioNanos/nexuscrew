// Static nc-chat/1 fixtures for UI-0. No network, no clock at module load:
// timestamps are fixed numbers, so the same fixture renders identically in
// every run. Approval `remainingMs` is relative to the view's `now`.

export const BASE = 1792400000000;
export const OWNER = '36b876f26ed141bae485dd75437704ca';

export const TARGETS = Object.freeze({
  vl: { kind: 'vl_node', ref: `${OWNER}:VL-82dffb30040048879162878d75306bbe` },
  cli: { kind: 'cli_cell', ref: `${OWNER}:cell-cloud-Dev` },
});

const hex64 = 'a'.repeat(64);

function frame({ target, sessionId, sourceKind = 'vl_host', bootId = 'boot-a', generation = 1, seq, type, runId = 'run-1', data = {} }) {
  const source = {
    kind: sourceKind,
    ownerId: OWNER,
    ...(sourceKind === 'vl_host' ? { nodeId: '82dffb30040048879162878d75306bbe' } : { cellId: 'Dev' }),
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
      ...(data.toolCallId ? { toolCallId: data.toolCallId } : {}),
      type,
      source,
      data,
    },
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

export function cliApprovalEvents(sessionId = 'sess-cli-1', { remainingMs = 96000 } = {}) {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: { originRequestId: 'req-2' } }),
    frame({ ...t, seq: 2, type: 'context_status', data: { cwd: '/srv/app', contextPct: 18 } }),
    frame({ ...t, seq: 3, type: 'tool_start', data: { name: 'bash', toolCallId: 'tc-1', at: BASE } }),
    frame({ ...t, seq: 4, type: 'tool_end', data: { name: 'bash', toolCallId: 'tc-1', at: BASE + 180, isError: false, resultAvailable: true } }),
    frame({ ...t, seq: 5, type: 'text_delta', data: { text: 'Serve il tuo OK', fragmentIndex: 0 } }),
    frame({
      ...t,
      seq: 6,
      type: 'approval_requested',
      data: {
        approvalId: 'ap-1',
        commandHash: hex64,
        epoch: 1,
        ruleIds: ['d2.rm-recursive'],
        coverage: 'complete',
        remainingMs,
        reviewAvailable: true,
        // Only an authorized approver receives this detail. A reader gets
        // the summary only; the renderer must not synthesize the command.
        review: {
          displayCommand: 'rm -rf build/tmp',
          cwd: '/srv/app',
          targets: ['build/tmp'],
          effectiveUser: 'dag',
          complete: true,
        },
      },
    }),
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
    frame({ ...t, seq: 3, type: 'tool_start', data: { name: 'read', toolCallId: 'tc-2', at: BASE + 500 } }),
  ];
}

export function turnEndThenToolEvents(sessionId = 'sess-cli-turn') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'text_delta', data: { text: 'Prima risposta', fragmentIndex: 0 } }),
    frame({ ...t, seq: 3, type: 'turn_end', data: {} }),
    frame({ ...t, seq: 4, type: 'tool_start', data: { name: 'bash', toolCallId: 'tc-3', at: BASE + 1000 } }),
    frame({ ...t, seq: 5, type: 'tool_end', data: { name: 'bash', toolCallId: 'tc-3', at: BASE + 1200, isError: false } }),
    frame({ ...t, seq: 6, type: 'text_delta', data: { text: ' e poi il tool', fragmentIndex: 1 } }),
    frame({ ...t, seq: 7, type: 'run_done', data: { stopReason: 'stop', effectsState: 'completed' } }),
  ];
}

export function duplicateSeqEvents(sessionId = 'sess-dup') {
  const t = { target: TARGETS.cli, sessionId, sourceKind: 'cli_adapter', seq: 0 };
  return [
    frame({ ...t, seq: 1, type: 'run_started', data: {} }),
    frame({ ...t, seq: 2, type: 'text_delta', data: { text: 'primo', fragmentIndex: 0 } }),
    frame({ ...t, seq: 2, type: 'text_delta', data: { text: ' duplicato', fragmentIndex: 0 } }),
    frame({ ...t, seq: 3, type: 'run_done', data: { stopReason: 'stop', effectsState: 'none' } }),
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
        currentCursor: { ownerId: OWNER, nodeId: '82dffb30040048879162878d75306bbe', sessionId, bootId: 'boot-b', generation: 2, seq: 10 },
      },
    }),
    frame({ ...a, seq: 99, type: 'text_delta', data: { text: ' vecchissimo', fragmentIndex: 1 } }),
    frame({ ...b, seq: 11, type: 'text_delta', data: { text: ' nuovo', fragmentIndex: 2 } }),
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
        currentCursor: { ownerId: OWNER, nodeId: '82dffb30040048879162878d75306bbe', sessionId, bootId: 'boot-a', generation: 1, seq: 3 },
      },
    }),
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

export const DEMO = Object.freeze({
  vl: {
    label: 'N900',
    sub: 'nodo VL · remoto · vl-agent/1',
    target: TARGETS.vl,
    events: vlDoneEvents(),
    viewer: { canApprove: false },
  },
  cli: {
    label: 'Dev',
    sub: 'cella CLI · ACP · chat',
    target: TARGETS.cli,
    events: cliApprovalEvents(),
    viewer: { canApprove: true },
  },
});
