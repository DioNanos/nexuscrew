'use strict';
// tests/access-view-effective.test.js — the access VIEWS show the grants the
// authorization code APPLIES.
//
// `nodes inspect`, `nodes access` and the read view of /api/nodes|/api/peers used
// to show an all-denied vector for any record whose `accessConfigured` marker was
// not set, while the resource gate (allowedByClass) reads the stored booleans and
// ignores the marker. A valid legacy record with `eventsAccess: true` and no
// marker therefore read "unconfigured, eventsAccess off" in the views while the
// event feed class was GRANTED. That is a display defect, not a change of access:
// the legacy semantics are untouched, only what is shown is.
//
// What stays separate on purpose: the label and the `configured` flag are
// PROVENANCE ("was this vector set deliberately?"), the vector is what runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/nodes/store.js');
const cmds = require('../lib/nodes/commands.js');
const accessPresets = require('../lib/nodes/access-presets.js');
const resourceAcl = require('../lib/proxy/resource-acl.js');

const SELF = 'f'.repeat(32);
const BOOLS = accessPresets.BOOLEAN_GRANTS;

function record(over = {}) {
  return { name: 'peer', ssh: 'peer', remotePort: 41820, localPort: 43001, nodeId: 'c'.repeat(32), token: 't', acceptToken: 'a',
    direction: 'outbound', transport: 'auto', autostart: true, shared: false, visibility: 'network', roles: { client: true, node: false }, ...over };
}
const parsed = (over) => store.parseNode(record(over));

// Every class the gate has, read through the SAME function that decides.
function gate(rec) { return Object.fromEntries(resourceAcl.CLASS_NAMES.map((cls) => [cls, resourceAcl.allowedByClass(cls, rec)])); }

// The vector a view shows, turned back into a record the gate can read.
const asRecord = (vector) => ({ ...vector });

test('A3c: a valid legacy record with eventsAccess and no marker is shown as granted, still labelled unconfigured', () => {
  const node = parsed({ eventsAccess: true });
  assert.ok(node, 'the parser accepts it');
  assert.equal(node.accessConfigured, false);
  assert.equal(resourceAcl.allowedByClass('event-feed', node), true, 'the gate grants the event feed');
  const view = accessPresets.accessView(node);
  assert.equal(view.access.eventsAccess, true);
  assert.equal(view.accessConfigured, false, 'provenance is not rewritten');
  assert.equal(view.accessLabel, 'unconfigured', 'neither is the label');
  const inv = store.accessInventory({ nodes: [node], accessRevision: 0 }).peers[0];
  assert.equal(inv.configured, false);
  assert.equal(inv.label, 'unconfigured');
  assert.equal(inv.grants.eventsAccess, true);
});

test('matrix: for every combination of grants, scope and marker the displayed vector is allowed by the gate exactly as the record is', () => {
  const scopes = [{ cellVisibility: 'all' }, { cellVisibility: 'none' }, { cellVisibility: 'selected', cells: ['Dev'] }];
  let checked = 0;
  for (let mask = 0; mask < 1 << BOOLS.length; mask += 1) {
    for (const scope of scopes) {
      for (const accessConfigured of [false, true]) {
        const grants = Object.fromEntries(BOOLS.map((key, i) => [key, (mask & (1 << i)) !== 0]));
        const node = parsed({ ...grants, ...scope, accessConfigured });
        assert.ok(node, `parsable: ${JSON.stringify({ mask, scope, accessConfigured })}`);
        const want = gate(node);
        const shown = [
          ['accessView', accessPresets.accessView(store.redactNode(node)).access],
          ['accessView(stored)', accessPresets.accessView(node).access],
          ['accessInventory', store.accessInventory({ nodes: [node], accessRevision: 0 }).peers[0].grants],
          ['effectiveGrants', accessPresets.effectiveGrants(node)],
        ];
        for (const [name, vector] of shown) {
          assert.deepEqual(gate(asRecord(vector)), want, `${name} ≡ allowedByClass for ${JSON.stringify({ mask, scope, accessConfigured })}`);
          for (const key of BOOLS) assert.equal(vector[key], node[key] === true, `${name}.${key}`);
        }
        checked += 1;
      }
    }
  }
  assert.equal(checked, 128 * 3 * 2);
});

test('a record with no grants at all shows what the gate really applies: nothing granted, the cell scope the record has', () => {
  const node = parsed({});
  const view = accessPresets.accessView(node);
  for (const key of BOOLS) assert.equal(view.access[key], false);
  assert.equal(view.access.cellVisibility, 'all', 'an absent scope parses to all, and the inventory class is open to a paired peer');
  assert.equal(resourceAcl.allowedByClass('inventory', node), true);
  assert.equal(view.accessLabel, 'unconfigured');
  assert.equal(view.accessConfigured, false);
});

function cliFixture(records) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-access-view-'));
  const nodesPath = store.defaultNodesPath(home);
  fs.mkdirSync(path.dirname(nodesPath), { recursive: true });
  let st = store.emptyStore(SELF);
  records.forEach((rec, i) => { st = store.addNode(st, record({ name: `p${i}`, nodeId: String(i + 1).padStart(32, 'a').replace(/[^a-f0-9]/g, 'b'), localPort: 43100 + i, ...rec })); });
  store.atomicWriteStore(nodesPath, st);
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}
const KEYS = [...cmds.ACCESS_GRANT_KEYS, 'panelAccess', 'liveHostAccess'];
function parseGrantLine(line) { return Object.fromEntries([...line.matchAll(/(\w+)=(on|off)/g)].map((m) => [m[1], m[2] === 'on'])); }

test('CLI: `nodes inspect` and `nodes access` print the same effective vector as the gate, including the legacy partial records', () => {
  const cases = [
    { eventsAccess: true },                                         // A3c
    { filesReadAccess: true, nodeEventsAccess: true },
    { peerOperatorAccess: true },
    { peerOperatorAccess: true, panelAccess: true },                // the panel class needs both
    { panelAccess: true },                                          // the panel class does NOT open on its own
    { liveHostAccess: true },                                       // incoherent without the admin set, still applied by the gate
    { eventsAccess: true, cellVisibility: 'none' },
    { eventsAccess: true, cellVisibility: 'selected', cells: ['Dev'] },
    { eventsAccess: true, accessConfigured: true },
    {},
  ];
  const f = cliFixture(cases);
  try {
    const inspected = cases.map((_c, i) => {
      const lines = []; cmds.nodesInspect({ home: f.home, log: (m) => lines.push(String(m)), ref: `p${i}` });
      return lines;
    });
    const accessLines = []; cmds.nodesAccess({ home: f.home, log: (m) => accessLines.push(String(m)), json: true });
    const access = Object.fromEntries(JSON.parse(accessLines.join('')).peers.map((p) => [p.name, p]));
    const st = store.loadStoreStrict(store.defaultNodesPath(f.home));
    cases.forEach((c, i) => {
      const node = store.getNode(st, `p${i}`);
      const want = gate(node);
      const line = inspected[i].find((l) => l.startsWith('grant:'));
      assert.ok(line, `inspect prints the grants: ${JSON.stringify(c)}`);
      const shown = parseGrantLine(line);
      for (const key of KEYS) assert.equal(shown[key], node[key] === true, `inspect ${key} for ${JSON.stringify(c)}`);
      const scope = (inspected[i].find((l) => l.startsWith('scope:')) || '').replace(/^scope:\s*celle\s*/, '');
      assert.equal(scope, node.cellVisibility, `inspect scope for ${JSON.stringify(c)}`);
      const fromInspect = { ...shown, cellVisibility: scope };
      assert.deepEqual(gate(fromInspect), want, `inspect ≡ allowedByClass for ${JSON.stringify(c)}`);
      const a = access[`p${i}`];
      assert.equal(a.configured, node.accessConfigured === true, 'provenance in nodes access');
      assert.deepEqual(gate(asRecord(a.grants)), want, `nodes access ≡ allowedByClass for ${JSON.stringify(c)}`);
      for (const key of KEYS) assert.equal(a.grants[key], node[key] === true, `access ${key} for ${JSON.stringify(c)}`);
      if (!node.accessConfigured) {
        assert.ok(inspected[i].some((l) => /^accesso:\s+unconfigured/.test(l)), 'the label still says unconfigured');
        assert.equal(a.label, 'unconfigured');
      }
    });
    // A3c, spelled out.
    assert.match(inspected[0].find((l) => l.startsWith('grant:')), /eventsAccess=on/);
    assert.equal(access.p0.grants.eventsAccess, true);
    assert.equal(access.p0.label, 'unconfigured');
    assert.ok(inspected[0].some((l) => /^nota:/.test(l)), 'a legacy record carries the explanation of what is shown');
    assert.ok(!inspected[8].some((l) => /^nota:/.test(l)), 'a configured record needs none');
  } finally { f.cleanup(); }
});

test('the legacy semantics of the access did not change: the feed ACL still requires a configured vector, the gate still reads the booleans', () => {
  const eventFeedAcl = require('../lib/notify/event-feed-acl.js');
  const legacy = parsed({ eventsAccess: true, direction: 'inbound', transport: 'inbound', ssh: undefined, shared: true });
  const st = { schemaVersion: 3, nodeId: SELF, nodes: [legacy] };
  assert.equal(resourceAcl.allowedByClass('event-feed', legacy), true);
  assert.equal(eventFeedAcl.peerGrants(st, legacy.nodeId).eventsAccess, false, 'the stream ACL is as it was: unconfigured means no feed');
  assert.equal(accessPresets.grantsOf(legacy).configured, false);
  assert.equal(accessPresets.grantsOf(legacy).grants.eventsAccess, false, 'grantsOf keeps denying (it feeds decisions, not views)');
});

test('effectiveGrants reads a raw record the way the gate does: absent scope is `all`, a selected scope keeps its cells, junk reads as nothing', () => {
  assert.equal(accessPresets.effectiveGrants({}).cellVisibility, 'all');
  assert.equal(accessPresets.effectiveGrants({ cellVisibility: 'bogus' }).cellVisibility, 'all');
  assert.equal(accessPresets.effectiveGrants(null).cellVisibility, 'all');
  assert.equal(accessPresets.effectiveGrants({ cellVisibility: 'none' }).cellVisibility, 'none');
  const selected = accessPresets.effectiveGrants({ cellVisibility: 'selected', cells: ['Dev', 'Fork'], eventsAccess: true });
  assert.deepEqual(selected.cells, ['Dev', 'Fork']);
  assert.equal(accessPresets.effectiveGrants({ cellVisibility: 'selected' }).cells.length, 0);
  assert.equal('cells' in accessPresets.effectiveGrants({ cellVisibility: 'all', cells: ['Dev'] }), false, 'cells only exist under `selected`');
  // Only a literal `true` grants: truthy junk does not.
  const junk = accessPresets.effectiveGrants({ eventsAccess: 'yes', filesReadAccess: 1, askReplyAccess: true });
  assert.equal(junk.eventsAccess, false);
  assert.equal(junk.filesReadAccess, false);
  assert.equal(junk.askReplyAccess, true);
  // The returned cells are a copy: a caller cannot edit the record through the view.
  const rec = { cellVisibility: 'selected', cells: ['Dev'] };
  accessPresets.effectiveGrants(rec).cells.push('X');
  assert.deepEqual(rec.cells, ['Dev']);
});

test('CLI text output of `nodes access` lists all seven grants of a legacy partial record, not only the five edit flags', () => {
  const f = cliFixture([{ panelAccess: true, peerOperatorAccess: true, eventsAccess: true }]);
  try {
    const lines = []; cmds.nodesAccess({ home: f.home, log: (m) => lines.push(String(m)) });
    const line = lines.find((l) => /eventsAccess=/.test(l));
    assert.ok(line, lines.join(' | '));
    const shown = parseGrantLine(line);
    assert.deepEqual(Object.keys(shown).sort(), [...KEYS].sort());
    assert.equal(shown.eventsAccess, true);
    assert.equal(shown.panelAccess, true);
    assert.equal(shown.peerOperatorAccess, true);
    assert.equal(shown.liveHostAccess, false);
  } finally { f.cleanup(); }
});
