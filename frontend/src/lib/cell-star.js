// The star (pin -> live) as ONE implementation.
//
// The pure state machine already lives in host-designation.js. What was copied
// into every surface that lists cells — the home, the desktop sidebar, and now
// the compact selector — is the surrounding part: how a row's state is read,
// which key labels it, and what a single tap does. Three copies of that is how
// the same defect comes back on a surface nobody re-checked, so it lives here.
import {
  HOST_FAVORITE, hostRenderState, hostThreadTitleKey, hostRouteKey,
} from './host-designation.js';

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
    // The tap toggles the pin only; the host state above stays for display.
    action: state === HOST_FAVORITE ? 'removePin' : 'addPin',
  };
}

// One tap on the star: pin, or unpin. The star is a PREFERENCE (client-owned,
// local); it does not designate anything any more — a designation is a choice
// about the node that deserves a sentence, a revision and a visible outcome, and
// it lives in its own command (see live-host-command.js). The star keeps SHOWING
// the host state (colour, title): read-only information is not an action.
export async function applyCellStar({ view, itemKey, togglePin, removePin }) {
  if (view.action === 'removePin') { removePin(itemKey); return { ok: true }; }
  togglePin(itemKey);
  return { ok: true };
}
