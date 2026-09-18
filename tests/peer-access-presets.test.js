const { test } = require('node:test');
const assert = require('node:assert');
const {
  ADMIN_GRANTS,
  BOOLEAN_GRANTS,
  DENIED_GRANTS,
  GRANT_FIELDS,
  NEXUSHOST_GRANTS,
  PRESET_NAMES,
  USER_GRANTS,
  applyPreset,
  deriveLabel,
  grantsOf,
  isConfigured,
  validateGrants,
} = require('../lib/nodes/access-presets.js');

// A minimal peer record: no internal names, no paths, only the shape the store
// keeps for a paired peer.
function peer(extra = {}) {
  return { name: 'peer-a', direction: 'outbound', remotePort: 2222, localPort: 2222, ...extra };
}

// The grant vector of a preset, extracted from the record shape the store
// keeps: validation and label derivation apply to the vector, never to the
// whole peer record.
function grantVector(name) {
  const applied = applyPreset({ name: 'peer-a' }, name);
  const vector = {};
  for (const key of GRANT_FIELDS) if (key in applied) vector[key] = applied[key];
  return vector;
}

test('the three presets are complete and coherent', () => {
  assert.deepStrictEqual([...PRESET_NAMES].sort(), ['admin', 'nexushost', 'user']);
  for (const name of PRESET_NAMES) {
    const v = validateGrants(grantVector(name));
    assert.strictEqual(v.ok, true, `${name}: ${v.errors.join('; ')}`);
  }
});

test('admin grants every federated capability, including live hosting', () => {
  const g = grantVector('admin');
  assert.strictEqual(g.cellVisibility, 'all');
  for (const key of BOOLEAN_GRANTS) assert.strictEqual(g[key], true, key);
  assert.strictEqual(deriveLabel(g), 'admin');
});

test('user reads events, node events and files, and cannot act', () => {
  const g = grantVector('user');
  assert.strictEqual(g.cellVisibility, 'all');
  assert.strictEqual(g.eventsAccess, true);
  assert.strictEqual(g.nodeEventsAccess, true);
  assert.strictEqual(g.filesReadAccess, true);
  assert.strictEqual(g.askReplyAccess, false);
  assert.strictEqual(g.liveHostAccess, false);
  assert.strictEqual(g.panelAccess, false);
  assert.strictEqual(g.peerOperatorAccess, false);
  assert.strictEqual(deriveLabel(g), 'user');
});

test('nexushost sees nothing of the owner, and the owner still sees it', () => {
  const g = grantVector('nexushost');
  assert.strictEqual(g.cellVisibility, 'none');
  for (const key of BOOLEAN_GRANTS) assert.strictEqual(g[key], false, key);
  assert.strictEqual(deriveLabel(g), 'nexushost');
});

test('the owner may narrow a user to selected or none cells without adding rights', () => {
  const selected = { ...USER_GRANTS, cellVisibility: 'selected', cells: ['cell-a', 'cell-b'] };
  assert.strictEqual(validateGrants(selected).ok, true);
  assert.strictEqual(deriveLabel(selected), 'user');
  const none = { ...USER_GRANTS, cellVisibility: 'none' };
  assert.strictEqual(validateGrants(none).ok, true);
  assert.strictEqual(deriveLabel(none), 'user');
});

test('live hosting is all-or-nothing: it must come with the complete admin set', () => {
  const narrowed = { ...ADMIN_GRANTS, panelAccess: false };
  const v = validateGrants(narrowed);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /complete admin grant set/.test(e)), v.errors.join('; '));
  // The same vector without live hosting stays a coherent (custom) vector.
  const noLive = { ...narrowed, liveHostAccess: false };
  assert.strictEqual(validateGrants(noLive).ok, true);
  assert.strictEqual(deriveLabel(noLive), 'custom');
});

test('a missing or malformed grant is denied, never completed by default', () => {
  const missing = { ...USER_GRANTS };
  delete missing.filesReadAccess;
  const v1 = validateGrants(missing);
  assert.strictEqual(v1.ok, false);
  assert.ok(v1.errors.some((e) => /missing grant: filesReadAccess/.test(e)), v1.errors.join('; '));

  const malformed = { ...USER_GRANTS, eventsAccess: 'yes' };
  const v2 = validateGrants(malformed);
  assert.strictEqual(v2.ok, false);
  assert.ok(v2.errors.some((e) => /grant must be a boolean/.test(e)), v2.errors.join('; '));
});

test('a record written before these fields existed stays unconfigured and denied', () => {
  const legacy = peer({ panelAccess: true, liveHostAccess: false, cellVisibility: 'all' });
  assert.strictEqual(isConfigured(legacy), false);
  assert.strictEqual(deriveLabel(legacy), 'unconfigured');
  const view = grantsOf(legacy);
  assert.strictEqual(view.configured, false);
  assert.deepStrictEqual(view.grants, DENIED_GRANTS);
  for (const key of BOOLEAN_GRANTS) assert.strictEqual(view.grants[key], false, key);
});

test('role is refused: the label is derived, never declared', () => {
  const v = validateGrants({ ...USER_GRANTS, role: 'admin' });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /role is not a grant/.test(e)), v.errors.join('; '));
});

test('eventsReceive is a local client choice and is not part of a preset', () => {
  for (const name of PRESET_NAMES) {
    const g = grantVector(name);
    assert.strictEqual('eventsReceive' in g, false, name);
  }
  const v = validateGrants({ ...USER_GRANTS, eventsReceive: true });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /local client choice/.test(e)), v.errors.join('; '));
});

test('cells are allowed only with a selected visibility', () => {
  const wrong = { ...USER_GRANTS, cellVisibility: 'all', cells: ['cell-a'] };
  assert.strictEqual(validateGrants(wrong).ok, false);
  const empty = { ...USER_GRANTS, cellVisibility: 'selected' };
  assert.strictEqual(validateGrants(empty).ok, false);
  const bad = { ...USER_GRANTS, cellVisibility: 'selected', cells: ['not a cell'] };
  assert.strictEqual(validateGrants(bad).ok, false);
});

test('applying a preset returns a copy and never mutates the peer', () => {
  const before = peer({ panelAccess: false, liveHostAccess: false });
  const snapshot = JSON.stringify(before);
  const after = applyPreset(before, 'admin');
  assert.strictEqual(JSON.stringify(before), snapshot);
  assert.notStrictEqual(after, before);
  assert.strictEqual(after.name, 'peer-a');
  assert.strictEqual(after.liveHostAccess, true);
  // A stale role field cannot survive the write.
  const withRole = applyPreset(peer({ role: 'admin' }), 'user');
  assert.strictEqual('role' in withRole, false);
});

test('an unknown preset is refused', () => {
  assert.throws(() => applyPreset(peer(), 'superuser'), /unknown preset/);
  assert.throws(() => applyPreset(peer(), 'toString'), /unknown preset/);
  assert.throws(() => applyPreset(peer(), '__proto__'), /unknown preset/);
  assert.throws(() => applyPreset(peer(), ''), /unknown preset/);
});

test('a coherent vector that matches no preset reads custom', () => {
  const custom = { ...USER_GRANTS, filesReadAccess: false };
  assert.strictEqual(validateGrants(custom).ok, true);
  assert.strictEqual(deriveLabel(custom), 'custom');
});

test('grantsOf reports the effective grants and the derived label', () => {
  const view = grantsOf(applyPreset(peer(), 'user'));
  assert.strictEqual(view.configured, true);
  assert.strictEqual(view.label, 'user');
  assert.strictEqual(view.grants.filesReadAccess, true);
  assert.strictEqual(view.grants.peerOperatorAccess, false);
  assert.strictEqual(grantsOf(null).label, 'unconfigured');
  assert.strictEqual(grantsOf({ name: 'peer-a' }).configured, false);
});

test('the admin preset is the only vector that grants live hosting', () => {
  for (const name of PRESET_NAMES) {
    const g = grantVector(name);
    assert.strictEqual(g.liveHostAccess, name === 'admin', name);
  }
  assert.strictEqual(NEXUSHOST_GRANTS.liveHostAccess, false);
  assert.strictEqual(USER_GRANTS.liveHostAccess, false);
});

test('a legacy record is not configured: defaults denied are not a preset', () => {
  // Every grant defaulted to denied, without the explicit marker.
  const legacy = { name: 'peer-a', cellVisibility: 'all', ...Object.fromEntries(BOOLEAN_GRANTS.map((k) => [k, false])) };
  const view = grantsOf(legacy);
  assert.strictEqual(view.configured, false);
  assert.strictEqual(view.label, 'unconfigured');
  assert.deepStrictEqual(view.grants, DENIED_GRANTS);
  // The same vector, set explicitly, is a coherent vector that denies
  // everything — reported as such, and still granting nothing.
  const explicit = grantsOf({ ...legacy, accessConfigured: true });
  assert.strictEqual(explicit.configured, true);
  assert.strictEqual(explicit.label, 'custom');
  for (const key of BOOLEAN_GRANTS) assert.strictEqual(explicit.grants[key], false, key);
});

test('applying a preset marks the record as explicitly configured', () => {
  const applied = applyPreset({ name: 'peer-a' }, 'nexushost');
  assert.strictEqual(applied.accessConfigured, true);
  assert.strictEqual(grantsOf(applied).label, 'nexushost');
});
