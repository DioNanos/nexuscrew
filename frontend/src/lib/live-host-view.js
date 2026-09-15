// The Live host as the UI must describe it — one place, purely.
//
// A node has at most one designated Live host cell. What that cell will do when
// a Live starts is NOT a setting: the bridge opens a native thread only for
// codex-vl engines (lib/live-host/bridge.js, resolveForLive) and works through
// the cell's tmux session for every other engine. The UI has the engine from the
// roster, so it can say which one it will be before anyone starts a Live there.
//
// No fetch here: the caller passes the node's live-host reading (the shape of
// GET /api/live-host, or the per-route entry App.jsx keeps in hostByRoute), the
// cells it knows and its own node id. Pure, so the wording and the classification
// are testable without a browser.
import { HOST_NONE, hostThreadState } from './host-designation.js';

export const LIVE_HOST_NATIVE = 'native';
export const LIVE_HOST_TMUX = 'tmux';

export const LIVE_HOST_STATE_NONE = 'none';

export function liveHostMode(engine) {
  if (typeof engine !== 'string' || !engine) return null;
  return engine.startsWith('codex-vl') ? LIVE_HOST_NATIVE : LIVE_HOST_TMUX;
}

// `ownerId` is the node the reading belongs to (null/undefined for the node
// serving the page). `remote` is true when that is a different node: the
// designation is a choice of the node that owns the cells, and the UI must not
// present someone else's host as local.
export function liveHostView({ liveHost, cells = [], localNodeId = '', ownerId = null } = {}) {
  const hostCell = liveHost && typeof liveHost.hostCell === 'string' && liveHost.hostCell
    ? liveHost.hostCell : null;
  const cell = hostCell
    ? (Array.isArray(cells) ? cells : []).find((candidate) => candidate && candidate.cell === hostCell) || null
    : null;
  const engine = cell && typeof cell.engine === 'string' && cell.engine ? cell.engine : null;
  return {
    hostCell,
    cell: hostCell,
    known: !!cell,
    engine,
    mode: liveHostMode(engine),
    state: hostCell ? hostThreadState(liveHost && liveHost.threadStatus) : HOST_NONE,
    remote: !!(ownerId && localNodeId && ownerId !== localNodeId),
    lease: (liveHost && (liveHost.hostLease
      || (liveHost.host && typeof liveHost.host.lease === 'string' ? liveHost.host.lease : null))) || null,
  };
}

// i18n keys for a view, never a sentence: two surfaces say the same thing in
// different shapes (a full row in the sidebar/selector, a dot in the header).
export function liveHostIndicatorKeys(view) {
  const state = view && view.state ? view.state : HOST_NONE;
  return {
    modeKey: view && view.mode ? `live-host-mode-${view.mode}` : null,
    stateKey: `live-host-state-${state}`,
  };
}

// The dot is the only host affordance the phone header can afford: one
// colour per state, and "no designation" is grey — never invisible, because a
// grey dot says "no Live host yet", which is information.
export function liveHostDotClass(view) {
  const state = view && view.state ? view.state : HOST_NONE;
  if (state === 'thread-active') return 'active';
  if (state === 'thread-present') return 'present';
  if (state === HOST_NONE) return 'none';
  if (state === 'thread-unknown') return 'unknown';
  return 'designated';
}
