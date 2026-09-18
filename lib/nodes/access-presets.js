'use strict';

// Access presets for paired peers.
//
// A preset is a vector of grants written in ONE validated write on the node
// that owns the resources. There is no persistent `role` field: the label
// (`admin`, `user`, `nexushost`, `custom`, `unconfigured`) is DERIVED from the
// effective grants, and request handlers check grants, never the label.
//
// The owner node decides what a peer may do with its own resources. A grant
// that is missing or malformed is denied, and a record written before these
// fields existed stays denied until an explicit migration sets them: being
// paired is not, by itself, a permission.

const MAX_CELLS = 128;
const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;

const CELL_VISIBILITY = Object.freeze(['all', 'selected', 'none']);

// Grants owned by the local node towards one peer.
const BOOLEAN_GRANTS = Object.freeze([
  'eventsAccess',
  'nodeEventsAccess',
  'askReplyAccess',
  'filesReadAccess',
  'liveHostAccess',
  'panelAccess',
  'peerOperatorAccess',
]);

// `eventsReceive` is the receiving client's local choice, so it is excluded
// from every preset: applying a preset never toggles who receives events.
const EXCLUDED_GRANTS = Object.freeze(['eventsReceive']);

const GRANT_FIELDS = Object.freeze(['cellVisibility', 'cells', ...BOOLEAN_GRANTS]);

// Provenance marker of an explicitly configured vector. It is not a grant and
// never a role: it only separates "set on purpose" from "defaulted".
const CONFIGURED_MARKER = 'accessConfigured';

const ADMIN_GRANTS = Object.freeze({
  cellVisibility: 'all',
  eventsAccess: true,
  nodeEventsAccess: true,
  askReplyAccess: true,
  filesReadAccess: true,
  liveHostAccess: true,
  panelAccess: true,
  peerOperatorAccess: true,
});

const USER_GRANTS = Object.freeze({
  cellVisibility: 'all',
  eventsAccess: true,
  nodeEventsAccess: true,
  askReplyAccess: false,
  filesReadAccess: true,
  liveHostAccess: false,
  panelAccess: false,
  peerOperatorAccess: false,
});

const NEXUSHOST_GRANTS = Object.freeze({
  cellVisibility: 'none',
  eventsAccess: false,
  nodeEventsAccess: false,
  askReplyAccess: false,
  filesReadAccess: false,
  liveHostAccess: false,
  panelAccess: false,
  peerOperatorAccess: false,
});

const PRESETS = Object.freeze({
  admin: ADMIN_GRANTS,
  user: USER_GRANTS,
  nexushost: NEXUSHOST_GRANTS,
});

const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

// Every grant denied: what an unknown peer gets.
const DENIED_GRANTS = Object.freeze({
  cellVisibility: 'none',
  ...Object.fromEntries(BOOLEAN_GRANTS.map((k) => [k, false])),
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isCellId(v) {
  return typeof v === 'string' && CELL_ID_RE.test(v);
}

// The admin vector is all-or-nothing: live hosting is an administrative act
// on the owner's own host, so it is granted only together with the complete
// admin set. A granular edit that keeps live hosting while dropping any other
// admin grant is refused.
function isCompleteAdminVector(g) {
  if (!isPlainObject(g)) return false;
  if (g.cellVisibility !== 'all') return false;
  if (Array.isArray(g.cells) && g.cells.length !== 0) return false;
  return BOOLEAN_GRANTS.every((k) => g[k] === true);
}

// Validates a grant vector. Returns { ok, errors }: `ok` means the vector is
// complete and coherent, so a label may be derived from it. A vector that is
// not ok is DENIED by callers; it is never completed with defaults.
function validateGrants(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['grants must be an object'] };
  }
  for (const key of Object.keys(input)) {
    if (key === 'role') {
      errors.push('role is not a grant: the label is derived from the grants');
    } else if (EXCLUDED_GRANTS.includes(key)) {
      errors.push(`${key} is a local client choice and is not part of a preset`);
    } else if (!GRANT_FIELDS.includes(key)) {
      errors.push(`unknown grant field: ${key}`);
    }
  }

  if (!CELL_VISIBILITY.includes(input.cellVisibility)) {
    errors.push('cellVisibility must be one of all|selected|none');
  }

  let cells = [];
  if (input.cells !== undefined) {
    if (!Array.isArray(input.cells)) {
      errors.push('cells must be an array');
    } else if (input.cells.length > MAX_CELLS) {
      errors.push(`cells must hold at most ${MAX_CELLS} entries`);
    } else if (!input.cells.every(isCellId)) {
      errors.push('cells entries must be cell names');
    } else if (new Set(input.cells).size !== input.cells.length) {
      errors.push('cells must not repeat an entry');
    } else {
      cells = input.cells;
    }
  }
  if (input.cellVisibility === 'selected' && cells.length === 0) {
    errors.push('cellVisibility selected needs at least one cell');
  }
  if ((input.cellVisibility === 'all' || input.cellVisibility === 'none') && cells.length > 0) {
    errors.push('cells are allowed only with cellVisibility selected');
  }

  for (const key of BOOLEAN_GRANTS) {
    if (!(key in input)) errors.push(`missing grant: ${key}`);
    else if (typeof input[key] !== 'boolean') errors.push(`grant must be a boolean: ${key}`);
  }

  if (input.liveHostAccess === true && !isCompleteAdminVector(input)) {
    errors.push('liveHostAccess requires the complete admin grant set');
  }

  return { ok: errors.length === 0, errors };
}

// A record is configured only when its grant vector is complete and coherent.
// Records written before these fields existed, or damaged ones, are denied.
function isConfigured(input) {
  return validateGrants(input).ok;
}

function sameBooleans(a, b) {
  return BOOLEAN_GRANTS.every((k) => a[k] === b[k]);
}

// Derives the label from the effective grants. `custom` means a coherent
// vector that matches no preset; `unconfigured` means the vector is not
// complete, so no preset may be inferred from it.
function deriveLabel(input) {
  if (!isConfigured(input)) return 'unconfigured';
  if (sameBooleans(input, ADMIN_GRANTS) && input.cellVisibility === 'all') return 'admin';
  if (sameBooleans(input, NEXUSHOST_GRANTS) && input.cellVisibility === 'none') return 'nexushost';
  // The owner may narrow the visible cells of a user peer without granting
  // anything new, so any of the three visibility values still reads `user`.
  if (sameBooleans(input, USER_GRANTS) && CELL_VISIBILITY.includes(input.cellVisibility)) return 'user';
  return 'custom';
}

// Returns a copy of the peer record with the grants of the named preset.
// The input is never mutated; `role` is dropped, because it is not a field
// that this model persists.
function applyPreset(peer, name) {
  if (!isPlainObject(peer)) throw new Error('peer must be an object');
  if (!Object.prototype.hasOwnProperty.call(PRESETS, name)) {
    throw new Error(`unknown preset: ${name}`);
  }
  const out = { ...peer };
  delete out.role;
  const preset = PRESETS[name];
  // Applying a preset IS the explicit act: the record is marked as configured
  // so a legacy peer with defaulted (denied) grants is never mistaken for a
  // deliberate vector that denies everything.
  out.accessConfigured = true;
  out.cellVisibility = preset.cellVisibility;
  if (preset.cellVisibility === 'selected') out.cells = [...(preset.cells || [])];
  else delete out.cells;
  for (const key of BOOLEAN_GRANTS) out[key] = preset[key];
  return out;
}

// Extracts the grant vector from a peer record. An unconfigured record yields
// every grant denied.
function grantsOf(peer) {
  if (!isPlainObject(peer)) return { configured: false, label: 'unconfigured', grants: { ...DENIED_GRANTS } };
  const grants = {};
  grants.cellVisibility = peer.cellVisibility;
  if (peer.cells !== undefined) grants.cells = peer.cells;
  for (const key of BOOLEAN_GRANTS) grants[key] = peer[key];
  // A record is configured only when its vector is coherent AND the vector was
  // set explicitly. Grants alone cannot tell a legacy record (everything
  // defaulted to denied) from a deliberate vector that denies everything.
  const configured = peer.accessConfigured === true && isConfigured(grants);
  return {
    configured,
    label: configured ? deriveLabel(grants) : 'unconfigured',
    grants: configured ? grants : { ...DENIED_GRANTS },
  };
}


// Read view of ONE peer for listing endpoints and the settings UI: the
// derived label, the configured marker and the EFFECTIVE grant vector. The
// vector is flat and always complete (denied for records that are not
// configured), so a caller never has to guess defaults and no token or
// secret is ever included: grants are decisions, not credentials.
function accessView(peer) {
  const view = grantsOf(peer);
  const access = { cellVisibility: view.grants.cellVisibility };
  for (const key of BOOLEAN_GRANTS) access[key] = view.grants[key] === true;
  return { accessLabel: view.label, accessConfigured: view.configured, access };
}

module.exports = {
  ADMIN_GRANTS,
  BOOLEAN_GRANTS,
  CELL_VISIBILITY,
  CONFIGURED_MARKER,
  DENIED_GRANTS,
  EXCLUDED_GRANTS,
  GRANT_FIELDS,
  NEXUSHOST_GRANTS,
  PRESETS,
  PRESET_NAMES,
  USER_GRANTS,
  accessView,
  applyPreset,
  deriveLabel,
  grantsOf,
  isCompleteAdminVector,
  isConfigured,
  validateGrants,
};
