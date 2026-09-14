// The star (pin -> live) as ONE implementation.
//
// The pure state machine already lives in host-designation.js. What was copied
// into every surface that lists cells — the home, the desktop sidebar, and now
// the compact selector — is the surrounding part: how a row's state is read,
// which key labels it, and what a single tap does. Three copies of that is how
// the same defect comes back on a surface nobody re-checked, so it lives here.
import {
  hostNextAction, hostRenderState, hostThreadTitleKey, hostRouteKey,
} from './host-designation.js';

// A caller answers either a boolean (the clear path in App.jsx) or an
// { ok, error } outcome. Both are read here so a surface can say WHY a
// designation failed instead of losing the reason.
async function outcomeOf(result) {
  let value;
  try { value = await result; } catch (error) { return { ok: false, error }; }
  if (value === true) return { ok: true };
  if (value === false || value == null) return { ok: false };
  return { ok: value.ok === true, error: value.error };
}

// The star of one row. Only `item.key` (the pin identity) and `item.value.cell`
// (the identity the node stores as hostCell) are read, so every surface can
// build the item it needs from its own row shape.
export function cellStarView({ item, pins, hostByRoute, route }) {
  const host = (hostByRoute || {})[hostRouteKey(route)] || {};
  const state = hostRenderState({
    hostCell: host.hostCell ?? null, threadStatus: host.threadStatus, pins, item,
  });
  const threadTitleKey = hostThreadTitleKey(state);
  return {
    state,
    live: !!threadTitleKey,
    favorite: state === 'favorite',
    filled: state !== 'none',
    titleKey: threadTitleKey || 'pin',
    action: hostNextAction(state),
  };
}

// One tap on the star: none -> pin (local, client-owned), favorite -> ask the
// node to designate that cell, live -> clear on the node and unpin ONLY after
// the node answered (API first, never before). Returns the outcome for the
// callers that need to say something about it.
export async function applyCellStar({
  view, itemKey, cellName, route, togglePin, removePin, designate, clearHost,
}) {
  if (view.action === 'addPin') { togglePin(itemKey); return { ok: true }; }
  if (view.action === 'designate') {
    if (!designate) return { ok: false };
    return outcomeOf(designate(cellName, route));
  }
  if (view.action === 'clearAndUnpin') {
    if (!clearHost) return { ok: false };
    const outcome = await outcomeOf(clearHost(route));
    if (outcome.ok) removePin(itemKey);
    return outcome;
  }
  return { ok: false };
}
