// frontend/src/lib/access-presets.js — the peer access presets, client side.
//
// Mirror of the server contract (lib/nodes/access-presets.js): a preset is a
// vector of grants written in ONE validated write on the node that owns the
// resources. The label is DERIVED from the effective grants — `role` is not a
// field, never a value, and it must never travel in a request body. What this
// module adds for the settings UI is the BEFORE/AFTER matrix: the operator
// sees exactly what a preset would change before confirming it.
//
// One deliberate duplication: the vectors live here and on the server because
// a browser cannot import Node code. They are a frozen contract, not logic —
// any divergence is a bug to be caught by the tests, not something the UI can
// paper over.

// The eight effective grants. `cellVisibility` carries the cell scope, the
// other seven are booleans. `eventsReceive` is the receiving client's local
// choice, so it is excluded here exactly as it is on the server.
export const ACCESS_GRANT_KEYS = Object.freeze([
  'cellVisibility', 'eventsAccess', 'nodeEventsAccess', 'askReplyAccess',
  'filesReadAccess', 'liveHostAccess', 'panelAccess', 'peerOperatorAccess',
]);

export const PRESET_NAMES = Object.freeze(['admin', 'user', 'nexushost']);

export const PRESETS = Object.freeze({
  admin: Object.freeze({
    cellVisibility: 'all',
    eventsAccess: true,
    nodeEventsAccess: true,
    askReplyAccess: true,
    filesReadAccess: true,
    liveHostAccess: true,
    panelAccess: true,
    peerOperatorAccess: true,
  }),
  user: Object.freeze({
    cellVisibility: 'all',
    eventsAccess: true,
    nodeEventsAccess: true,
    askReplyAccess: false,
    filesReadAccess: true,
    liveHostAccess: false,
    panelAccess: false,
    peerOperatorAccess: false,
  }),
  nexushost: Object.freeze({
    cellVisibility: 'none',
    eventsAccess: false,
    nodeEventsAccess: false,
    askReplyAccess: false,
    filesReadAccess: false,
    liveHostAccess: false,
    panelAccess: false,
    peerOperatorAccess: false,
  }),
});

// One row per grant: what the peer effectively has now, what the preset would
// write, and whether the two differ. The caller renders it; this decides it.
// `changed` rows are exactly what the confirmation is about — hiding a change
// here would hide it from the person who must own it.
export function accessMatrix(currentGrants, presetName) {
  const preset = PRESETS[presetName];
  if (!preset) return [];
  const current = currentGrants && typeof currentGrants === 'object' ? currentGrants : {};
  return ACCESS_GRANT_KEYS.map((key) => {
    const next = preset[key];
    const before = current[key];
    return { key, current: before, next, changed: before !== next };
  });
}
