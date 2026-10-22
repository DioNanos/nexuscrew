// nc-chat/1 view model for UI-0.
//
// Pure functions only: no fetch, no WebSocket, no storage, no timers.
//
// The five invariants live in one gate, `epochGate`, applied to the state
// BEFORE the frame is adopted. The switch below never re-validates epochs:
//
// I1. A reset/source change is validated against the previous state, with the
//     same rules for the event form and the top-level control form. Inside
//     one boot the generation never goes down; a new boot may restart at 1.
// I2. A broker_view view-reset is not a source-epoch change: repeated view
//     resets on the same source are valid, and only a truly retired source
//     epoch is refused.
// I3. An invalidated approval stays invalid until an explicit reconciliation
//     (its resolution, a new run, or a source-epoch change). A new
//     approval_requested with the same id is not reconciliation.
// I4. After cancel_requested the run is fenced until a terminal or an explicit
//     reconciliation: replies and re-deliveries cannot reopen it.
// I5. awaiting_approval only exists while a current request is really pending;
//     resolving another id never changes the state, and terminals are never
//     touched by approvals.

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
const LOCAL_TYPES = new Set(['cancel_requested']);

function isTerminal(view) {
  return view.terminal !== null;
}

function isPending(approval) {
  return Boolean(approval && approval.resolved == null && !approval.invalidated);
}

/// Accepts the nc-chat/1 envelope `{protocol,type:'event',target,event}`,
/// a top-level control frame `{protocol,type:'gap'|'reset',target,…}`, a local
/// action (`cancel_requested`) and the bare inner event. Target preserved.
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
    /** Durable per-approval invalidation (I3): id -> reason. */
    approvalInvalid: {},
    /** Cancel fence (I4). */
    fenced: false,
    gap: null,
    reset: null,
    context: null,
    dropped: 0,
    conflicts: [],
    viewer,
    now,
    reviews,
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

function sameEpoch(a, b) {
  return Boolean(a && b && a.bootId === b.bootId && a.generation === b.generation);
}

function isRetired(view, bootId, generation) {
  return view.retired.some((entry) => entry.bootId === bootId && entry.generation === generation);
}

function epochLabel(state) {
  if (!state || !state.bootId) return 'none';
  return `${state.bootId}:${state.generation}`;
}

// --- INVARIANT GATE (I1/I2) ------------------------------------------------
// Validated against the state BEFORE the frame. Returns null (adopt), or a
// drop/conflict decision. The same function sees both reset forms, because
// normalizeFrame turns the top-level `reset` into the same event shape.
function epochGate(prev, event) {
  const data = event.data || {};
  if (event.type !== 'stream_reset') {
    const source = event.source || {};
    if (prev.bootId && source.bootId
        && (source.bootId !== prev.bootId || source.generation !== prev.generation)) {
      return { kind: 'drop' };
    }
    return null;
  }

  const cursor = data.currentCursor;
  if (!cursor || !cursor.bootId) return { kind: 'conflict', reason: 'missing-cursor' };
  const source = event.source || {};
  if (source.bootId && source.bootId !== cursor.bootId) {
    return { kind: 'conflict', reason: 'cursor-source-mismatch' };
  }
  if (isRetired(prev, cursor.bootId, cursor.generation)) {
    return { kind: 'conflict', reason: 'retired-epoch' };
  }
  // Same boot: generation never goes down (I1).
  if (prev.bootId && cursor.bootId === prev.bootId
      && Number.isInteger(cursor.generation) && Number.isInteger(prev.generation)
      && cursor.generation < prev.generation) {
    return { kind: 'conflict', reason: 'older-same-boot' };
  }
  // I2: a view reset may not move the source epoch.
  if (prev.bootId && (data.scope || 'broker_view') === 'broker_view'
      && (cursor.bootId !== prev.bootId || cursor.generation !== prev.generation)) {
    return { kind: 'conflict', reason: 'broker-reset-source-mismatch' };
  }
  return null;
}

// --- conflicts and durable invalidation ------------------------------------
function invalidateApproval(view, reason) {
  if (!view.approval) return view;
  return {
    ...view,
    approvalInvalid: { ...view.approvalInvalid, [view.approval.approvalId]: reason },
    approval: { ...view.approval, actionable: false, invalidated: reason },
  };
}

function addConflict(view, kind, detail) {
  // A conflict makes the pending request ambiguous: keep the card visible but
  // non-actionable, and remember the invalidation by approval id (I3).
  const next = invalidateApproval(view, kind);
  return { ...next, conflicts: [...next.conflicts, { kind, ...detail }] };
}

// --- messages --------------------------------------------------------------
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
    };
  }
  const current = messages[index];
  if (!current.streaming) return { messages, items };
  if (fragment !== null && current.fragments.includes(fragment)) return { messages, items };
  const next = messages.slice();
  next[index] = {
    ...current,
    text: current.text + (typeof data.text === 'string' ? data.text : ''),
    fragments: fragment === null ? current.fragments : [...current.fragments, fragment],
  };
  return { messages: next, items };
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

// --- tools -----------------------------------------------------------------
function canonicalToolCallId(event, data) {
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

// --- approvals (I3/I4/I5) ---------------------------------------------------
function approvalFrom(view, event, data) {
  const approvalId = data.approvalId || 'approval';
  const ledger = view.approvals[approvalId];
  if (ledger?.resolved) return view; // a consumed decision is not reopened
  if (isTerminal(view)) return view;  // a finished run does not accept a new ask

  const remainingMs = Number.isFinite(data.remainingMs) ? data.remainingMs : 0;
  const review = view.viewer.canApprove === true ? (view.reviews[approvalId] || null) : null;
  // I3: a durable invalidation survives a re-delivery of the same request.
  const invalidated = view.approvalInvalid[approvalId] || (view.fenced ? 'cancel_requested' : null);
  const actionable = view.viewer.canApprove === true
    && review !== null
    && review.complete === true
    && !isTerminal(view)
    && view.gap === null
    && view.reset === null
    && !invalidated
    && !view.fenced;

  const approval = {
    approvalId,
    runId: event.runId || view.runId,
    summary: data,
    review,
    expiresAt: view.now + remainingMs,
    resolved: null,
    actionable,
    ...(invalidated ? { invalidated } : {}),
  };
  const items = view.items.some((item) => item.kind === 'approval' && item.approvalId === approvalId)
    ? view.items
    : [...view.items, { kind: 'approval', approvalId }];
  return {
    ...view,
    approval,
    items,
    // I4: a cancelled run does not go back to awaiting.
    state: view.fenced ? RUN_STATE.CANCEL_REQUESTED : RUN_STATE.AWAITING_APPROVAL,
  };
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
  // different payload is an integrity conflict.
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

  // I1/I2: one gate, before adopting the frame, against the previous state.
  const gate = epochGate(next, event);
  if (gate?.kind === 'drop') return { ...next, dropped: next.dropped + 1 };
  if (gate?.kind === 'conflict') {
    return addConflict({ ...next, dropped: next.dropped + 1 }, 'stale-reset', {
      reason: gate.reason,
      from: epochLabel(next),
      to: epochLabel(event.data?.currentCursor),
    });
  }

  const data = event.data || {};
  const eventRun = event.runId || data.runId || next.runId;

  switch (event.type) {
    case 'cancel_requested': {
      // Local action, not a protocol event: fences the current run (I4).
      const fenced = { ...next, fenced: true, state: RUN_STATE.CANCEL_REQUESTED };
      return invalidateApproval(fenced, 'cancel_requested');
    }

    case 'run_started': {
      // A duplicate start of the current run is inert.
      if (next.started && eventRun && eventRun === next.runId) return next;
      // A new run is an explicit reconciliation of the previous fence and of
      // the approval invalidations.
      return {
        ...next,
        ...emptyRun(eventRun),
        sessionId: event.sessionId || next.sessionId,
        bootId: bootId || next.bootId,
        generation: Number.isInteger(generation) ? generation : next.generation,
        lastSeq: seq !== null ? seq : next.lastSeq,
        fenced: false,
        approval: null,
        approvalInvalid: {},
        state: RUN_STATE.ADMITTED,
        started: true,
      };
    }
  }

  // A frame for another run never touches the current run's state.
  if (eventRun && next.runId && eventRun !== next.runId) {
    return { ...next, dropped: next.dropped + 1 };
  }

  const base = {
    ...next,
    sessionId: event.sessionId || next.sessionId,
    bootId,
    generation,
    lastSeq: seq !== null ? seq : next.lastSeq,
    runId: eventRun || next.runId,
  };

  switch (event.type) {
    case 'text_delta':
    case 'message': {
      if (isTerminal(base)) return base;
      const wasStarted = base.started;
      let started = base.started;
      let limit = base.limit;
      let state = base.state;
      if (!started) {
        if (source.kind === 'cli_adapter') {
          started = true;
          state = RUN_STATE.ADMITTED;
        } else {
          limit = 'missing_run_started';
          state = RUN_STATE.UNKNOWN;
        }
      }
      const patched = event.type === 'text_delta'
        ? upsertDelta(base.messages, base.items, data, base.runId)
        : upsertFinal(base.messages, base.items, data, base.runId);
      // I4: content still arrives, but the run stays fenced.
      const nextState = base.fenced
        ? RUN_STATE.CANCEL_REQUESTED
        : (state === RUN_STATE.UNKNOWN ? state : (wasStarted ? RUN_STATE.RUNNING : RUN_STATE.ADMITTED));
      return {
        ...base,
        started,
        limit,
        messages: patched.messages,
        items: patched.items,
        state: nextState,
      };
    }

    case 'tool_start': {
      if (isTerminal(base)) return base;
      if (!base.started && source.kind !== 'cli_adapter') {
        return { ...base, limit: 'missing_run_started', state: RUN_STATE.UNKNOWN };
      }
      const tools = applyToTools(base.tools, 'tool_start', data, event);
      return {
        ...base,
        started: true,
        turnEnded: false,
        tools,
        items: [...base.items, { kind: 'tool', toolCallId: tools[tools.length - 1].toolCallId }],
        state: base.fenced ? RUN_STATE.CANCEL_REQUESTED : RUN_STATE.RUNNING,
      };
    }

    case 'tool_end': {
      if (isTerminal(base)) return base;
      return {
        ...base,
        tools: applyToTools(base.tools, 'tool_end', data, event),
        state: base.fenced
          ? RUN_STATE.CANCEL_REQUESTED
          : (base.state === RUN_STATE.UNKNOWN ? base.state : RUN_STATE.RUNNING),
      };
    }

    case 'turn_end':
      return isTerminal(base) ? base : { ...base, turnEnded: true };

    case 'approval_requested':
      return approvalFrom(base, event, data);

    case 'approval_resolved': {
      // I5: a resolution of another id never changes the state; awaiting only
      // survives while the current request is really pending.
      const id = data.approvalId;
      if (!id) return base;
      const approvals = { ...base.approvals, [id]: { resolved: data.decision || 'resolved' } };
      const approvalInvalid = { ...base.approvalInvalid };
      delete approvalInvalid[id]; // explicit reconciliation of that request
      const isCurrent = Boolean(base.approval && base.approval.approvalId === id);
      const current = isCurrent
        ? { ...base.approval, resolved: data.decision || 'resolved', actionable: false }
        : base.approval;
      let state;
      if (isTerminal(base)) state = base.state;
      else if (base.fenced) state = RUN_STATE.CANCEL_REQUESTED; // I4
      else if (isCurrent) state = RUN_STATE.RUNNING;
      else state = isPending(current) ? RUN_STATE.AWAITING_APPROVAL : RUN_STATE.RUNNING;
      return {
        ...base,
        approvals,
        approvalInvalid,
        approval: current,
        state,
      };
    }

    case 'context_status':
      return { ...base, context: { ...data } };

    case 'gap':
      return {
        ...invalidateApproval(base, 'gap'),
        gap: { count: data.count ?? null, reason: data.reason || 'unknown' },
        state: isTerminal(base)
          ? base.state
          : (base.fenced ? RUN_STATE.CANCEL_REQUESTED : RUN_STATE.UNKNOWN),
      };

    case 'stream_reset': {
      const cursor = data.currentCursor;
      const scope = data.scope || 'broker_view';
      const changed = !sameEpoch(next, cursor);
      // I2: only a real source-epoch change retires the previous epoch.
      const retired = changed && next.bootId
        ? [...next.retired, { bootId: next.bootId, generation: next.generation }]
        : next.retired;
      const reset = { scope, reason: data.reason || 'unknown' };
      if (changed) {
        // New source epoch: explicit reconciliation of approvals and fence.
        return {
          ...base,
          reset,
          bootId: cursor.bootId,
          generation: cursor.generation,
          lastSeq: Number.isInteger(cursor.seq) ? cursor.seq : -1,
          retired,
          gap: null,
          approval: null,
          approvalInvalid: {},
          fenced: false,
          state: isTerminal(base) ? base.state : RUN_STATE.UNKNOWN,
        };
      }
      // Same source epoch (broker_view or a same-epoch reset): the request and
      // the fence survive; only the view cursor moves.
      return {
        ...base,
        reset,
        lastSeq: Number.isInteger(cursor.seq) ? cursor.seq : base.lastSeq,
        retired,
        gap: null,
        state: isTerminal(base)
          ? base.state
          : (base.fenced ? RUN_STATE.CANCEL_REQUESTED : RUN_STATE.UNKNOWN),
      };
    }

    case 'run_done':
    case 'run_error':
    case 'run_cancelled': {
      if (base.terminal) {
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
        // The run is over: the fence no longer applies to future state.
        fenced: false,
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

// --- approval guard ---------------------------------------------------------
// One function, independent from the run label alone: a foreign resolution or
// a stale view can change `state` while the request is no longer decidable.
// `state` is the run snapshot (the view): state, gap, reset, fenced, terminal.
const INELIGIBLE_STATES = new Set([
  RUN_STATE.SUBMITTED,
  RUN_STATE.UNKNOWN,
  RUN_STATE.DONE,
  RUN_STATE.ERROR,
  RUN_STATE.CANCELLED,
  RUN_STATE.CANCEL_REQUESTED,
]);

export function canApprove(state, approval, viewer = {}) {
  if (!state || !approval) return false;
  if (viewer?.canApprove !== true) return false;
  if (approval.resolved != null) return false;
  if (approval.invalidated) return false;
  if (approval.actionable === false) return false;
  if (!approval.review || approval.review.complete !== true) return false;
  if (!state.state || INELIGIBLE_STATES.has(state.state)) return false;
  if (state.terminal) return false;
  if (state.fenced) return false;
  if (state.gap) return false;
  if (state.reset) return false;
  return true;
}

/// Local UI action: the same reducer path as the `cancel_requested` frame.
export function markCancelRequested(view) {
  return applyEvent(view, { type: 'cancel_requested' });
}

export function toolDuration(tool) {
  if (!tool || !Number.isFinite(tool.startedAt) || !Number.isFinite(tool.endedAt)) {
    return null; // "sconosciuta": the source did not carry both times
  }
  return Math.max(0, tool.endedAt - tool.startedAt);
}
