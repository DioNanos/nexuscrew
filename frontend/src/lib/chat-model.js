// nc-chat/1 view model for UI-0.
//
// Pure functions only: no fetch, no WebSocket, no storage, no timers. The
// demo and the future real route feed the same reducer with nc-chat/1 event
// frames; the renderer never parses ACP or vl-agent/1 payloads.
//
// Event names and payloads follow the contracts (VL lotto 0 v2, §4.1/§9.3):
// run_started, text_delta, message, tool_start, tool_end, turn_end,
// approval_requested, approval_resolved, context_status, run_done, run_error,
// run_cancelled, gap, stream_reset.

export const RUN_STATE = Object.freeze({
  SUBMITTED: 'submitted',
  ADMITTED: 'admitted',
  AWAITING_APPROVAL: 'awaiting_approval',
  RUNNING: 'running',
  CANCEL_REQUESTED: 'cancel_requested',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
});

export const RUN_STATE_LABEL = Object.freeze({
  [RUN_STATE.SUBMITTED]: 'inviato',
  [RUN_STATE.ADMITTED]: 'ammesso',
  [RUN_STATE.AWAITING_APPROVAL]: 'in attesa di OK',
  [RUN_STATE.RUNNING]: 'in corso',
  [RUN_STATE.CANCEL_REQUESTED]: 'annullamento richiesto',
  [RUN_STATE.DONE]: 'terminato',
  [RUN_STATE.ERROR]: 'errore',
  [RUN_STATE.CANCELLED]: 'annullato',
  [RUN_STATE.UNKNOWN]: 'esito incerto',
});

const TERMINALS = new Set(['run_done', 'run_error', 'run_cancelled']);
const TERMINAL_STATE = {
  run_done: RUN_STATE.DONE,
  run_error: RUN_STATE.ERROR,
  run_cancelled: RUN_STATE.CANCELLED,
};

function isTerminal(state) {
  return state.terminal !== null;
}

function withState(view, state) {
  return isTerminal(view) ? view : { ...view, state };
}

/// Accepts either the nc-chat/1 envelope
/// `{protocol,type:'event',target,event}` or the bare inner event.
export function normalizeFrame(frame) {
  if (!frame || typeof frame !== 'object') return null;
  if (frame.protocol === 'nc-chat/1' && frame.type === 'event') {
    if (!frame.target || !frame.event) return null;
    return { target: frame.target, event: frame.event };
  }
  if (frame.event && frame.target) return { target: frame.target, event: frame.event };
  return { target: null, event: frame };
}

export function targetKey(target) {
  if (!target || typeof target !== 'object') return '';
  return `${target.kind || 'unknown'}:${target.ref || ''}`;
}

export function createView({ target, viewer = { canApprove: false }, now = Date.now() } = {}) {
  return {
    target: target || null,
    targetKey: targetKey(target),
    sessionId: null,
    bootId: null,
    generation: null,
    lastSeq: -1,
    runId: null,
    state: RUN_STATE.SUBMITTED,
    started: false,
    turnEnded: false,
    messages: [],
    tools: [],
    items: [],
    approval: null,
    gap: null,
    reset: null,
    terminal: null,
    context: null,
    dropped: 0,
    viewer,
    now,
  };
}

function findApprovalItem(view) {
  return view.items.findIndex((item) => item.kind === 'approval');
}

function upsertDelta(messages, items, data, runId) {
  const messageId = data.messageId || `${runId || 'run'}:assistant`;
  const text = typeof data.text === 'string' ? data.text : '';
  const index = messages.findIndex((m) => m.messageId === messageId);
  if (index < 0) {
    return {
      messages: [...messages, { messageId, role: 'assistant', text, streaming: true }],
      items: [...items, { kind: 'message', messageId }],
    };
  }
  const next = messages.slice();
  next[index] = { ...next[index], text: next[index].text + text, streaming: true };
  return { messages: next, items };
}

function upsertFinal(messages, items, data) {
  const messageId = data.messageId || 'assistant';
  const role = data.role === 'user' ? 'user' : 'assistant';
  const text = typeof data.text === 'string' ? data.text : '';
  const index = messages.findIndex((m) => m.messageId === messageId);
  if (index >= 0) {
    const next = messages.slice();
    // The final message replaces the deltas already shown: one bubble, no
    // duplicate. Delivered deltas that belong to another messageId stay.
    next[index] = { ...next[index], role, text, streaming: false };
    return { messages: next, items };
  }
  return {
    messages: [...messages, { messageId, role, text, streaming: false }],
    items: [...items, { kind: 'message', messageId }],
  };
}

function applyToTools(tools, type, data) {
  const id = data.toolCallId || data.toolCallId === '' ? data.toolCallId : '';
  if (type === 'tool_start') {
    return [
      ...tools,
      {
        toolCallId: id || `tool-${tools.length + 1}`,
        name: data.name || 'tool',
        state: 'running',
        startedAt: Number.isFinite(data.at) ? data.at : null,
        endedAt: null,
        isError: false,
      },
    ];
  }
  const index = tools.findIndex((t) => t.toolCallId === id);
  if (index < 0) return tools;
  const next = tools.slice();
  next[index] = {
    ...next[index],
    state: data.isError === true ? 'error' : 'ok',
    isError: data.isError === true,
    endedAt: Number.isFinite(data.at) ? data.at : null,
  };
  return next;
}

export function applyEvent(view, frame) {
  const normalized = normalizeFrame(frame);
  if (!normalized || !normalized.event) return view;
  const event = normalized.event;
  const source = event.source || {};

  if (normalized.target && view.targetKey && targetKey(normalized.target) !== view.targetKey) {
    return view;
  }
  if (view.sessionId && event.sessionId && event.sessionId !== view.sessionId) {
    return view;
  }

  // A new boot/generation is not ordered against the old one. Only an
  // explicit stream_reset may switch epoch; anything else from another boot
  // is discarded instead of being merged into the current timeline.
  if (source.bootId && view.bootId
      && (source.bootId !== view.bootId || source.generation !== view.generation)
      && event.type !== 'stream_reset') {
    return { ...view, dropped: view.dropped + 1 };
  }

  if (typeof source.seq === 'number' && view.bootId === source.bootId
      && view.generation === source.generation && source.seq <= view.lastSeq) {
    return { ...view, dropped: view.dropped + 1 };
  }

  const base = {
    ...view,
    sessionId: event.sessionId || view.sessionId,
    bootId: source.bootId || view.bootId,
    generation: Number.isInteger(source.generation) ? source.generation : view.generation,
    lastSeq: typeof source.seq === 'number' ? source.seq : view.lastSeq,
    runId: event.runId || view.runId,
  };
  const data = event.data || {};

  switch (event.type) {
    case 'run_started':
      return { ...base, started: true, state: isTerminal(base) ? base.state : RUN_STATE.ADMITTED };

    case 'text_delta': {
      // For CLI, run_started only exists when a correlated update proves
      // activity: the first delta is that proof.
      const admitted = base.started || base.state !== RUN_STATE.SUBMITTED;
      const patched = upsertDelta(base.messages, base.items, data, base.runId);
      return {
        ...base,
        started: true,
        messages: patched.messages,
        items: patched.items,
        state: isTerminal(base) ? base.state : (admitted ? RUN_STATE.RUNNING : RUN_STATE.ADMITTED),
      };
    }

    case 'message': {
      const patched = upsertFinal(base.messages, base.items, data);
      return {
        ...base,
        started: true,
        messages: patched.messages,
        items: patched.items,
        state: isTerminal(base) ? base.state : RUN_STATE.RUNNING,
      };
    }

    case 'tool_start': {
      const tools = applyToTools(base.tools, 'tool_start', data);
      return {
        ...base,
        started: true,
        // A tool after turn_end means the run continues.
        turnEnded: false,
        tools,
        items: [...base.items, { kind: 'tool', toolCallId: tools[tools.length - 1].toolCallId }],
        state: isTerminal(base) ? base.state : RUN_STATE.RUNNING,
      };
    }

    case 'tool_end':
      return {
        ...base,
        tools: applyToTools(base.tools, 'tool_end', data),
        state: isTerminal(base) ? base.state : RUN_STATE.RUNNING,
      };

    case 'turn_end':
      // Closes one model response, not the run.
      return { ...base, turnEnded: true };

    case 'approval_requested': {
      const remainingMs = Number.isFinite(data.remainingMs) ? data.remainingMs : 0;
      const approval = {
        approvalId: data.approvalId || 'approval',
        summary: data,
        review: data.review || null,
        expiresAt: base.now + remainingMs,
        resolved: null,
      };
      const items = findApprovalItem(base) < 0
        ? [...base.items, { kind: 'approval', approvalId: approval.approvalId }]
        : base.items;
      return {
        ...base,
        approval,
        items,
        state: isTerminal(base) ? base.state : RUN_STATE.AWAITING_APPROVAL,
      };
    }

    case 'approval_resolved': {
      if (!base.approval) return base;
      const approval = { ...base.approval, resolved: data.decision || 'resolved' };
      return {
        ...base,
        approval,
        state: isTerminal(base) ? base.state : RUN_STATE.RUNNING,
      };
    }

    case 'context_status':
      return { ...base, context: { ...data } };

    case 'gap':
      // A hole is declared, never treated as "finished".
      return {
        ...base,
        gap: { count: data.count ?? null, reason: data.reason || 'unknown' },
        state: isTerminal(base) ? base.state : RUN_STATE.UNKNOWN,
      };

    case 'stream_reset': {
      const cursor = data.currentCursor || {};
      return {
        ...base,
        reset: { scope: data.scope || 'broker_view', reason: data.reason || 'unknown' },
        bootId: cursor.bootId || base.bootId,
        generation: Number.isInteger(cursor.generation) ? cursor.generation : base.generation,
        lastSeq: Number.isInteger(cursor.seq) ? cursor.seq : -1,
        state: isTerminal(base) ? base.state : RUN_STATE.UNKNOWN,
      };
    }

    case 'run_done':
    case 'run_error':
    case 'run_cancelled':
      return {
        ...base,
        terminal: {
          type: event.type,
          stopReason: data.stopReason || null,
          effectsState: data.effectsState || null,
          at: Number.isFinite(data.at) ? data.at : null,
        },
        state: TERMINAL_STATE[event.type],
      };

    default:
      // Unknown event types are inert: no invention, no state change.
      return base;
  }
}

export function applyEvents(view, frames) {
  return (frames || []).reduce((acc, frame) => applyEvent(acc, frame), view);
}

/// Local UI state only: it does not send or cancel anything.
export function markCancelRequested(view) {
  if (isTerminal(view)) return view;
  return { ...view, state: RUN_STATE.CANCEL_REQUESTED };
}

export function toolDuration(tool) {
  if (!tool || !Number.isFinite(tool.startedAt) || !Number.isFinite(tool.endedAt)) {
    return null; // "sconosciuta": the source did not carry both times
  }
  return Math.max(0, tool.endedAt - tool.startedAt);
}

export function isTerminalType(type) {
  return TERMINALS.has(type);
}
