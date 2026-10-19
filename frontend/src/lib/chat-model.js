// nc-chat/1 view model for UI-0.
//
// Pure functions only: no fetch, no WebSocket, no storage, no timers. The
// demo and the future real route feed the same reducer with nc-chat/1 event
// frames; the renderer never parses ACP or vl-agent/1 payloads.
//
// Event names and payloads follow the contracts (VL lotto 0 v2, §4.1/§9.3):
// run_started, text_delta, message, tool_start, tool_end, turn_end,
// approval_requested, approval_resolved, context_status, run_done, run_error,
// run_cancelled, gap, stream_reset. Top-level control frames `gap`/`reset`
// (server type, not event envelope) are accepted too.

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

const TERMINAL_STATE = {
  run_done: RUN_STATE.DONE,
  run_error: RUN_STATE.ERROR,
  run_cancelled: RUN_STATE.CANCELLED,
};

const CONTROL_TYPES = new Set(['gap', 'reset']);

function isTerminal(view) {
  return view.terminal !== null;
}

/// Accepts the nc-chat/1 envelope `{protocol,type:'event',target,event}`,
/// a top-level control frame `{protocol,type:'gap'|'reset',target,…}` and the
/// bare inner event. The target is preserved whenever it exists.
export function normalizeFrame(frame) {
  if (!frame || typeof frame !== 'object') return null;
  if (frame.type === 'event' && frame.event) {
    return { target: frame.target || null, event: frame.event };
  }
  if (frame.target && CONTROL_TYPES.has(frame.type)) {
    return { target: frame.target, event: controlEvent(frame) };
  }
  if (frame.event && frame.target) return { target: frame.target, event: frame.event };
  return { target: null, event: frame };
}

function controlEvent(frame) {
  const data = frame.data || {
    ...(frame.count !== undefined ? { count: frame.count } : {}),
    ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
    ...(frame.scope !== undefined ? { scope: frame.scope } : {}),
    ...(frame.currentCursor !== undefined ? { currentCursor: frame.currentCursor } : {}),
  };
  return {
    sessionId: frame.sessionId,
    runId: frame.runId,
    source: frame.source || {},
    type: frame.type === 'reset' ? 'stream_reset' : 'gap',
    data,
  };
}

export function targetKey(target) {
  if (!target || typeof target !== 'object') return '';
  return `${target.kind || 'unknown'}:${target.ref || ''}`;
}

function emptyRun(runId) {
  return {
    runId: runId || null,
    state: RUN_STATE.SUBMITTED,
    started: false,
    turnEnded: false,
    terminal: null,
    messages: [],
    tools: [],
    items: [],
    limit: null,
  };
}

export function createView({ target, viewer = { canApprove: false }, now = Date.now(), reviews = {} } = {}) {
  return {
    target: target || null,
    targetKey: targetKey(target),
    sessionId: null,
    bootId: null,
    generation: null,
    lastSeq: -1,
    ...emptyRun(null),
    approval: null,
    approvals: {},
    gap: null,
    reset: null,
    context: null,
    dropped: 0,
    conflicts: [],
    viewer,
    now,
    reviews,
    // Integrity bookkeeping (bounded in a real ring; small here).
    seen: {},
    retired: [],
  };
}

function fingerprint(event) {
  try {
    return JSON.stringify(event);
  } catch {
    return String(event);
  }
}

function isRetired(view, bootId, generation) {
  return view.retired.some((entry) => entry.bootId === bootId && entry.generation === generation);
}

function addConflict(view, kind, detail) {
  return { ...view, conflicts: [...view.conflicts, { kind, ...detail }] };
}

function upsertDelta(messages, items, data, runId) {
  const messageId = data.messageId || `${runId || 'run'}:assistant`;
  const fragment = Number.isInteger(data.fragmentIndex) ? data.fragmentIndex : null;
  const index = messages.findIndex((m) => m.messageId === messageId);
  if (index < 0) {
    return {
      messages: [...messages, {
        messageId,
        role: 'assistant',
        text: typeof data.text === 'string' ? data.text : '',
        streaming: true,
        fragments: fragment === null ? [] : [fragment],
      }],
      items: [...items, { kind: 'message', messageId }],
      applied: true,
    };
  }
  const current = messages[index];
  // A delta after the final message, or with an already applied fragment
  // index, does not append: the final message is authoritative.
  if (!current.streaming) return { messages, items, applied: false };
  if (fragment !== null && current.fragments.includes(fragment)) {
    return { messages, items, applied: false };
  }
  const next = messages.slice();
  next[index] = {
    ...current,
    text: current.text + (typeof data.text === 'string' ? data.text : ''),
    fragments: fragment === null ? current.fragments : [...current.fragments, fragment],
  };
  return { messages: next, items, applied: true };
}

function upsertFinal(messages, items, data, runId) {
  const messageId = data.messageId || `${runId || 'run'}:assistant`;
  const role = data.role === 'user' ? 'user' : 'assistant';
  const text = typeof data.text === 'string' ? data.text : '';
  const index = messages.findIndex((m) => m.messageId === messageId);
  if (index >= 0) {
    const next = messages.slice();
    next[index] = { ...next[index], role, text, streaming: false };
    return { messages: next, items };
  }
  return {
    messages: [...messages, { messageId, role, text, streaming: false, fragments: [] }],
    items: [...items, { kind: 'message', messageId }],
  };
}

function canonicalToolCallId(event, data) {
  // The contract puts the id on the event; `data.toolCallId` is tolerated for
  // older fixtures but never required.
  return event.toolCallId || data.toolCallId || '';
}

function applyToTools(tools, type, data, event) {
  const id = canonicalToolCallId(event, data);
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

function approvalFrom(view, event, data) {
  const approvalId = data.approvalId || 'approval';
  const ledger = view.approvals[approvalId];
  if (ledger?.resolved) return view; // a consumed decision is not reopened
  if (isTerminal(view)) return view;  // a finished run does not accept a new ask
  const remainingMs = Number.isFinite(data.remainingMs) ? data.remainingMs : 0;
  const review = view.viewer.canApprove === true ? (view.reviews[approvalId] || null) : null;
  const actionable = view.viewer.canApprove === true
    && review !== null
    && review.complete === true
    && !isTerminal(view)
    && view.gap === null
    && view.reset === null;
  const approval = {
    approvalId,
    runId: event.runId || view.runId,
    summary: data,
    review,
    expiresAt: view.now + remainingMs,
    resolved: null,
    actionable,
  };
  const items = view.items.some((item) => item.kind === 'approval' && item.approvalId === approvalId)
    ? view.items
    : [...view.items, { kind: 'approval', approvalId }];
  return { ...view, approval, items, state: RUN_STATE.AWAITING_APPROVAL };
}

/// Applies one frame. Returns a new view; never mutates the input.
export function applyEvent(view, frame) {
  const normalized = normalizeFrame(frame);
  if (!normalized || !normalized.event) return view;
  const event = normalized.event;
  const source = event.source || {};

  if (normalized.target && view.targetKey && targetKey(normalized.target) !== view.targetKey) {
    return { ...view, dropped: view.dropped + 1 };
  }
  if (view.sessionId && event.sessionId && event.sessionId !== view.sessionId) {
    return { ...view, dropped: view.dropped + 1 };
  }

  const bootId = source.bootId || view.bootId;
  const generation = Number.isInteger(source.generation) ? source.generation : view.generation;
  const seq = typeof source.seq === 'number' ? source.seq : null;

  // Dedup by the full key. Identical replay is inert; same key with a
  // different payload is an integrity conflict, not a silent drop.
  let next = view;
  if (seq !== null && bootId) {
    const key = `${bootId}:${generation}:${seq}`;
    const print = fingerprint(event);
    if (next.seen[key] !== undefined) {
      if (next.seen[key] === print) return { ...next, dropped: next.dropped + 1 };
      return addConflict({ ...next, dropped: next.dropped + 1 }, 'seq-payload', { key });
    }
    next = { ...next, seen: { ...next.seen, [key]: print } };
  }

  // Epoch handling. Only stream_reset may switch epoch, and only forward:
  // a reset back to a retired/older boot is refused.
  if (bootId && next.bootId && (bootId !== next.bootId || generation !== next.generation)) {
    if (event.type !== 'stream_reset') return { ...next, dropped: next.dropped + 1 };
    const cursor = event.data?.currentCursor || {};
    const targetGen = Number.isInteger(cursor.generation) ? cursor.generation : -1;
    if (isRetired(next, cursor.bootId, cursor.generation)
        || targetGen < (next.generation ?? -1)
        || (targetGen === next.generation && cursor.bootId !== next.bootId)) {
      return addConflict({ ...next, dropped: next.dropped + 1 }, 'stale-reset', {
        from: `${bootId}:${generation}`,
        to: `${cursor.bootId}:${cursor.generation}`,
      });
    }
  }

  const base = {
    ...next,
    sessionId: event.sessionId || next.sessionId,
    bootId,
    generation,
    lastSeq: seq !== null ? seq : next.lastSeq,
  };
  const data = event.data || {};
  const eventRun = event.runId || data.runId || base.runId;

  // A frame for another run never touches the current run's state.
  if (eventRun && base.runId && eventRun !== base.runId && event.type !== 'run_started') {
    return { ...base, dropped: base.dropped + 1 };
  }

  switch (event.type) {
    case 'run_started': {
      if (eventRun && base.runId && eventRun === base.runId) return base; // duplicate start
      if (eventRun && base.runId && eventRun !== base.runId) {
        // New run: the previous terminal stays with the previous run.
        return { ...base, ...emptyRun(eventRun), state: RUN_STATE.ADMITTED, started: true };
      }
      return { ...base, ...emptyRun(eventRun), state: RUN_STATE.ADMITTED, started: true };
    }

    case 'text_delta':
    case 'message': {
      if (isTerminal(base)) return base;
      let started = base.started;
      let limit = base.limit;
      let state = base.state;
      const wasStarted = started;
      if (!started) {
        if (source.kind === 'cli_adapter') {
          // CLI admission: the first correlated update proves activity.
          started = true;
          state = RUN_STATE.ADMITTED;
        } else {
          // VL admission exists only via the host's run_started.
          limit = 'missing_run_started';
          state = RUN_STATE.UNKNOWN;
        }
      }
      const patched = event.type === 'text_delta'
        ? upsertDelta(base.messages, base.items, data, base.runId)
        : { ...upsertFinal(base.messages, base.items, data, base.runId), applied: true };
      return {
        ...base,
        runId: eventRun || base.runId,
        started,
        limit,
        messages: patched.messages,
        items: patched.items,
        state: state === RUN_STATE.UNKNOWN
          ? state
          : (wasStarted ? RUN_STATE.RUNNING : RUN_STATE.ADMITTED),
      };
    }

    case 'tool_start': {
      if (isTerminal(base)) return base;
      if (!base.started) {
        if (source.kind === 'cli_adapter') {
          // first correlated update: admitted, then running
        } else {
          return { ...base, limit: 'missing_run_started', state: RUN_STATE.UNKNOWN };
        }
      }
      const tools = applyToTools(base.tools, 'tool_start', data, event);
      return {
        ...base,
        runId: eventRun || base.runId,
        started: true,
        turnEnded: false,
        tools,
        items: [...base.items, { kind: 'tool', toolCallId: tools[tools.length - 1].toolCallId }],
        state: RUN_STATE.RUNNING,
      };
    }

    case 'tool_end': {
      if (isTerminal(base)) return base;
      return {
        ...base,
        tools: applyToTools(base.tools, 'tool_end', data, event),
        state: base.state === RUN_STATE.UNKNOWN ? base.state : RUN_STATE.RUNNING,
      };
    }

    case 'turn_end':
      return isTerminal(base) ? base : { ...base, turnEnded: true };

    case 'approval_requested':
      return approvalFrom(base, event, data);

    case 'approval_resolved': {
      const id = data.approvalId;
      if (!id) return base;
      const approvals = {
        ...base.approvals,
        [id]: { resolved: data.decision || 'resolved' },
      };
      const current = base.approval && base.approval.approvalId === id
        ? { ...base.approval, resolved: data.decision || 'resolved', actionable: false }
        : base.approval;
      return {
        ...base,
        approvals,
        approval: current,
        state: isTerminal(base) ? base.state : RUN_STATE.RUNNING,
      };
    }

    case 'context_status':
      return { ...base, context: { ...data } };

    case 'gap':
      return {
        ...base,
        gap: { count: data.count ?? null, reason: data.reason || 'unknown' },
        approval: base.approval ? { ...base.approval, actionable: false } : null,
        state: isTerminal(base) ? base.state : RUN_STATE.UNKNOWN,
      };

    case 'stream_reset': {
      const cursor = data.currentCursor || {};
      const previous = { bootId: base.bootId, generation: base.generation };
      return {
        ...base,
        reset: { scope: data.scope || 'broker_view', reason: data.reason || 'unknown' },
        retired: previous.bootId && !isRetired(base, previous.bootId, previous.generation)
          ? [...base.retired, previous]
          : base.retired,
        bootId: cursor.bootId || base.bootId,
        generation: Number.isInteger(cursor.generation) ? cursor.generation : base.generation,
        lastSeq: Number.isInteger(cursor.seq) ? cursor.seq : -1,
        approval: base.approval ? { ...base.approval, actionable: false } : null,
        state: isTerminal(base) ? base.state : RUN_STATE.UNKNOWN,
      };
    }

    case 'run_done':
    case 'run_error':
    case 'run_cancelled': {
      if (base.terminal) {
        // One logical terminal per run: a later, different one is a
        // conflict, never a silent replacement.
        if (base.terminal.type === event.type) return { ...base, dropped: base.dropped + 1 };
        return addConflict(base, 'terminal-conflict', {
          runId: base.runId,
          kept: base.terminal.type,
          late: event.type,
        });
      }
      return {
        ...base,
        terminal: {
          type: event.type,
          stopReason: data.stopReason || null,
          effectsState: data.effectsState || null,
          at: Number.isFinite(data.at) ? data.at : null,
        },
        approval: base.approval ? { ...base.approval, actionable: false } : null,
        state: TERMINAL_STATE[event.type],
      };
    }

    default:
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
