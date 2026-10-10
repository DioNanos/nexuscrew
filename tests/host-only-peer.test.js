'use strict';
// tests/host-only-peer.test.js — host-only publication of a remote peer
// (`nodes publish-remote <peer> on --audience <ids>|off`, schema 4, 0.9.66).
//
// What is proven here, with the SAME functions the runtime uses to decide:
//   - the zeroed vector is read through classGateCheck/allowedByClass (the code
//     that authorizes), never through a label or the CLI view;
//   - canTransit is directional: audience -> peer yes, peer -> anyone never;
//   - the HTTP relay, the WebSocket upgrade, /federation/topology and the
//     topology collector all follow it, re-reading the store on every call;
//   - schema 4 is written only at the opt-in, after a backup, and everything
//     older keeps loading byte for byte.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const WebSocket = require('ws');
const store = require('../lib/nodes/store.js');
const accessPresets = require('../lib/nodes/access-presets.js');
const resourceAcl = require('../lib/proxy/resource-acl.js');
const fed = require('../lib/proxy/federation.js');
const cmds = require('../lib/nodes/commands.js');
const { dispatch } = require('../lib/cli/commands.js');

const ID = (c) => c.repeat(32);
const SELF = ID('f');
const BOX = ID('c');
const READER1 = ID('a');
const READER2 = ID('b');
const INTRUDER = ID('1');
const OTHER = ID('2');

function peer(name, nodeId, over = {}) {
  return {
    name, ssh: name, remotePort: 41820, localPort: 43000 + (parseInt(nodeId.slice(0, 2), 16) % 200), nodeId,
    token: `to-${name}`, acceptToken: `from-${name}`, direction: 'outbound',
    transport: 'auto', autostart: true, shared: true, visibility: 'network', peerOperatorAccess: true,
    roles: { client: true, node: false }, ...over,
  };
}

// The "user" preset with cells none: the combination that stays open (events,
// node events and file reads stay granted although no cell is visible).
const BOX_USER = (over = {}) => peer('box', BOX, {
  shared: false, ssh: 'private-link', peerOperatorAccess: false,
  cellVisibility: 'none', eventsAccess: true, nodeEventsAccess: true, filesReadAccess: true,
  askReplyAccess: false, panelAccess: false, liveHostAccess: false, accessConfigured: true,
  ...over,
});

function fixture(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hostonly-'));
  const nodesPath = path.join(dir, 'nodes.json');
  let st = store.emptyStore(SELF);
  st = store.addNode(st, peer('reader1', READER1, { localPort: 43101 }));
  st = store.addNode(st, peer('reader2', READER2, { localPort: 43102 }));
  st = store.addNode(st, peer('intruder', INTRUDER, { localPort: 43103 }));
  st = store.addNode(st, peer('other', OTHER, { localPort: 43104, peerOperatorAccess: false }));
  st = store.addNode(st, BOX_USER({ localPort: 43105, ...extra }));
  store.atomicWriteStore(nodesPath, st);
  return { dir, nodesPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const enable = (nodesPath, audience = [READER1, READER2]) =>
  store.setPublishRemoteCas({ filePath: nodesPath, name: 'box', enabled: true, audience });
const load = (nodesPath) => store.loadStoreStrict(nodesPath);
const boxOf = (nodesPath) => store.getNode(load(nodesPath), 'box');
const byName = (st, name) => store.getNode(st, name);

// ---------------------------------------------------------------- store

test('store: enabling writes schema 4, publication, audience and the zeroed vector in ONE save', () => {
  const f = fixture();
  try {
    assert.equal(load(f.nodesPath).schemaVersion, 3, 'start from a schema 3 store');
    const before = load(f.nodesPath);
    const res = enable(f.nodesPath, [READER2, READER1]);
    assert.equal(res.ok, true);
    assert.equal(res.schemaVersion, 4);
    const st = load(f.nodesPath);
    assert.equal(st.schemaVersion, 4);
    const box = byName(st, 'box');
    assert.equal(box.publishRemote, true);
    assert.deepEqual(box.publishRemoteAudience, [READER1, READER2], 'audience is deduplicated and sorted');
    assert.equal(box.cellVisibility, 'none');
    assert.equal(box.cells, undefined);
    assert.equal(box.eventsReceive, false);
    assert.equal(box.accessConfigured, true);
    for (const key of accessPresets.BOOLEAN_GRANTS) assert.equal(box[key], false, key);
    assert.equal(box.shared, false, 'Share is untouched');
    assert.equal(st.accessRevision, (before.accessRevision || 0) + 1);
    // Nothing about the transport changed.
    const was = byName(before, 'box');
    for (const key of ['ssh', 'sshPort', 'localPort', 'remotePort', 'autostart', 'token', 'acceptToken', 'direction', 'transport', 'visibility', 'reversePort']) {
      assert.deepEqual(box[key], was[key], `${key} must not change`);
    }
    // The other peers are identical.
    for (const name of ['reader1', 'reader2', 'intruder', 'other']) assert.deepEqual(byName(st, name), byName(before, name));
  } finally { f.cleanup(); }
});

test('store: enabling is refused for unknown, non-admin, self, malformed, duplicate-mode and incompatible cases', () => {
  const f = fixture();
  try {
    const st = load(f.nodesPath);
    const refuse = (label, fn, rx) => assert.throws(fn, rx, label);
    refuse('empty audience', () => store.enablePublishRemote(st, 'box', []), /audience vuota/);
    refuse('missing audience', () => store.enablePublishRemote(st, 'box'), /audience vuota/);
    refuse('unknown id', () => store.enablePublishRemote(st, 'box', [ID('9')]), /sconosciuto/);
    refuse('reader without operator grant', () => store.enablePublishRemote(st, 'box', [OTHER]), /non e' un nodo admin/);
    refuse('the published peer itself', () => store.enablePublishRemote(st, 'box', [BOX]), /non puo' contenere il peer pubblicato/);
    refuse('malformed id', () => store.enablePublishRemote(st, 'box', ['not-an-id']), /non valido/);
    refuse('non-string id', () => store.enablePublishRemote(st, 'box', [42]), /non valido/);
    refuse('unknown peer name', () => store.enablePublishRemote(st, 'nessuno', [READER1]), /nodo sconosciuto/);
    refuse('shared peer', () => store.enablePublishRemote(store.updateNode(st, 'box', { shared: true }), 'box', [READER1]), /Share/);
    const noToken = { ...st, nodes: st.nodes.map((n) => { if (n.name !== 'box') return n; const { token, ...rest } = n; return rest; }) };
    refuse('unpaired peer (no token)', () => store.enablePublishRemote(noToken, 'box', [READER1]), /non e' accoppiato/);
    // An inbound peer cannot be published (the mode is for outbound peers).
    let withInbound = store.addNode(st, peer('client', ID('4'), { direction: 'inbound', transport: 'inbound', shared: false, localPort: 43106, ssh: undefined }));
    refuse('inbound peer', () => store.enablePublishRemote(withInbound, 'client', [READER1]), /in uscita/);
    const on = store.enablePublishRemote(st, 'box', [READER1]);
    refuse('already on', () => store.enablePublishRemote(on, 'box', [READER2]), /gia' acceso/);
    // A host-only peer cannot be a reader of another one.
    const second = store.addNode(on, peer('box2', ID('3'), { shared: false, localPort: 43107 }));
    refuse('a host-only peer as reader', () => store.enablePublishRemote(second, 'box2', [BOX]), /solo-host/);
    assert.equal(load(f.nodesPath).schemaVersion, 3, 'a refusal writes nothing');
  } finally { f.cleanup(); }
});

test('regression user + cells none: the gap is real before, and every class is denied after, through the authorization code', () => {
  const f = fixture();
  try {
    const samples = [
      ['/event-feed', 'GET'], [`/event-feed/node/${ID('a')}`, 'GET'], ['/event-feed/Dev', 'GET'],
      ['/event-feed/asks/aaaaaaaa/answer', 'POST'], ['/event-feed/notices/dismiss-all', 'POST'],
      ['/files', 'GET'], ['/files/download', 'GET'], ['/files/upload', 'POST'], ['/files', 'DELETE'],
      ['/cells', 'GET'], ['/sessions', 'GET'], ['/sessions', 'POST'], ['/cells/send', 'POST'],
      ['/live-host', 'GET'], ['/live-host/designate', 'POST'], ['/panel/Dev/index.html', 'GET'],
      ['/config', 'GET'], ['/fs/dirs', 'GET'], ['/topology', 'GET'], ['/notify', 'POST'], ['/asks', 'POST'],
      ['/diagnostics/status', 'GET'], ['/diagnostics/logs', 'GET'], ['/fleet/status', 'GET'], ['/fleet/up', 'POST'],
      ['/decks', 'GET'], ['/audio/speak', 'POST'], ['/ws', 'GET'], [`/vl-nodes/${ID('a')}/events`, 'GET'],
    ];
    const verdict = (box) => samples.map(([resource, method]) => [resource, method, fed.classGateCheck(resource, method, box)]);
    const open = verdict(boxOf(f.nodesPath)).filter(([, , g]) => g.ok).map(([r, m]) => `${m} ${r}`);
    // The old state: the gap of the "user" preset with no visible cell. If this stops being true the test
    // would prove nothing about the fix.
    assert.ok(open.includes('GET /event-feed'), `events open before: ${open}`);
    assert.ok(open.includes('GET /files'), `file reads open before: ${open}`);
    assert.ok(open.some((x) => x.includes('/event-feed/node/')), `node events open before: ${open}`);

    enable(f.nodesPath);
    const box = boxOf(f.nodesPath);
    for (const [resource, method, gate] of verdict(box)) {
      assert.equal(gate.ok, false, `${method} ${resource} must be denied for a host-only peer`);
    }
    // And through allowedByClass for EVERY class, on the stored record itself.
    for (const cls of resourceAcl.CLASS_NAMES) {
      assert.equal(resourceAcl.allowedByClass(cls, box), false, `class ${cls}`);
    }
    assert.equal(fed.panelAllowedFor(box), false);
    assert.equal(fed.liveHostAllowedFor(box), false);
    assert.equal(box.eventsReceive, false);
    // Even a record that gained every grant stays denied by the second lock.
    const forged = { ...box, eventsAccess: true, nodeEventsAccess: true, filesReadAccess: true, peerOperatorAccess: true, panelAccess: true, liveHostAccess: true, askReplyAccess: true, cellVisibility: 'all' };
    for (const [resource, method] of samples) {
      const gate = fed.classGateCheck(resource, method, forged);
      assert.equal(gate.ok, false, `forged ${method} ${resource}`);
      assert.equal(gate.reason, 'host-only-peer');
    }
  } finally { f.cleanup(); }
});

test('widening any grant while the mode is on is refused, with the reason, by every mutator', () => {
  const f = fixture();
  try {
    enable(f.nodesPath);
    const st = load(f.nodesPath);
    const widen = {
      eventsAccess: true, nodeEventsAccess: true, askReplyAccess: true, filesReadAccess: true,
      peerOperatorAccess: true, panelAccess: true, liveHostAccess: true, eventsReceive: true, shared: true,
      cellVisibility: 'all',
    };
    for (const [key, value] of Object.entries(widen)) {
      assert.throws(() => store.updateNode(st, 'box', { [key]: value }), /publish-remote attivo/, `updateNode ${key}`);
    }
    assert.throws(() => store.updateNode(st, 'box', { cellVisibility: 'selected', cells: ['Dev'] }), /publish-remote attivo/);
    assert.throws(() => store.setPeerAccessPreset(st, 'box', 'admin'), /publish-remote attivo/);
    assert.throws(() => store.setPeerAccessPreset(st, 'box', 'user'), /publish-remote attivo/);
    assert.throws(() => store.setPeerAccessGrants(st, 'box', accessPresets.ADMIN_GRANTS), /publish-remote attivo/);
    assert.throws(() => store.setPeerAccessGrantsCas({
      filePath: f.nodesPath, name: 'box', grants: { ...accessPresets.NEXUSHOST_GRANTS, filesReadAccess: true }, expectedRevision: st.accessRevision,
    }), /publish-remote attivo/);
    assert.throws(() => store.setPeerAccessPresetCas({ filePath: f.nodesPath, name: 'box', presetName: 'admin', expectedRevision: st.accessRevision }), /publish-remote attivo/);
    // Non-grant edits still work.
    const relabeled = store.updateNode(st, 'box', { label: 'Box' });
    assert.equal(byName(relabeled, 'box').label, 'Box');
    assert.equal(byName(relabeled, 'box').publishRemote, true);
    // The store on disk was never touched by a refusal.
    assert.deepEqual(load(f.nodesPath), st);
  } finally { f.cleanup(); }
});

test('a hand-edited store that breaks the invariants is rejected at parse time', () => {
  const f = fixture();
  try {
    enable(f.nodesPath);
    const raw = JSON.parse(fs.readFileSync(f.nodesPath, 'utf8'));
    const mutate = (fn) => { const copy = JSON.parse(JSON.stringify(raw)); fn(copy.nodes.find((n) => n.name === 'box')); return store.parseStore(copy); };
    assert.ok(store.parseStore(raw), 'the written store is valid');
    for (const key of ['eventsAccess', 'nodeEventsAccess', 'askReplyAccess', 'filesReadAccess', 'peerOperatorAccess', 'panelAccess', 'liveHostAccess', 'eventsReceive', 'shared']) {
      assert.equal(mutate((n) => { n[key] = true; }), null, key);
    }
    assert.equal(mutate((n) => { n.cellVisibility = 'all'; }), null);
    assert.equal(mutate((n) => { n.publishRemoteAudience = []; }), null, 'empty audience while on');
    assert.equal(mutate((n) => { n.publishRemoteAudience = [n.nodeId]; }), null, 'self in the audience');
    assert.equal(mutate((n) => { n.publishRemoteAudience = ['xyz']; }), null, 'malformed id');
    assert.equal(mutate((n) => { n.publishRemote = 'yes'; }), null, 'non-boolean');
    assert.equal(mutate((n) => { n.direction = 'inbound'; n.transport = 'inbound'; }), null, 'inbound');
    assert.equal(mutate((n) => { n.publishRemote = false; }), null, 'off with a lingering audience');
    assert.ok(mutate((n) => { n.publishRemote = false; delete n.publishRemoteAudience; }), 'off without audience is valid');
    // The fields do not exist before schema 4.
    const old = JSON.parse(JSON.stringify(raw)); old.schemaVersion = 3;
    assert.equal(store.parseStore(old), null, 'schema 3 carrying the fields is refused');
  } finally { f.cleanup(); }
});

test('off: publication and audience go away at once, the grants STAY zero, the schema stays 4', () => {
  const f = fixture();
  try {
    enable(f.nodesPath);
    const off = store.setPublishRemoteCas({ filePath: f.nodesPath, name: 'box', enabled: false });
    assert.equal(off.ok, true);
    assert.equal(off.enabled, false);
    const st = load(f.nodesPath);
    assert.equal(st.schemaVersion, 4);
    const box = byName(st, 'box');
    assert.equal(box.publishRemote, false);
    assert.equal(box.publishRemoteAudience, undefined);
    assert.equal(box.cellVisibility, 'none');
    for (const key of accessPresets.BOOLEAN_GRANTS) assert.equal(box[key], false, `${key} is not restored`);
    assert.equal(box.eventsReceive, false);
    assert.equal(fed.canTransit(byName(st, 'reader1'), box), false, 'no one transits to it any more');
    assert.equal(fed.canTransit(null, box), true, 'the owner still reaches its own peer');
    // Turning it off again is a no-op, not an error.
    const again = store.setPublishRemoteCas({ filePath: f.nodesPath, name: 'box', enabled: false });
    assert.equal(again.ok, true);
    assert.equal(again.unchanged, true);
    // Widening AFTER off is possible, but only as an explicit act.
    const widened = store.setPeerAccessPreset(st, 'box', 'user');
    assert.equal(byName(widened, 'box').eventsAccess, true);
    assert.equal(byName(widened, 'box').publishRemote, false);
  } finally { f.cleanup(); }
});

test('opt-in takes a protected full backup BEFORE writing; a failed backup leaves the store untouched', () => {
  const f = fixture();
  try {
    const original = fs.readFileSync(f.nodesPath);
    const sha = crypto.createHash('sha256').update(original).digest('hex');
    const res = enable(f.nodesPath);
    assert.ok(res.backup && res.backup.path.startsWith(`${f.nodesPath}.pre-publish-remote-`));
    assert.equal(res.backup.sha256, sha);
    assert.equal(fs.statSync(res.backup.path).mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(res.backup.path).equals(original), 'the backup is the pre-opt-in file, byte for byte');
    assert.equal(JSON.parse(fs.readFileSync(res.backup.path, 'utf8')).schemaVersion, 3);
    // `off` takes no backup.
    const before = fs.readdirSync(f.dir).filter((n) => n.includes('.bak')).length;
    store.setPublishRemoteCas({ filePath: f.nodesPath, name: 'box', enabled: false });
    assert.equal(fs.readdirSync(f.dir).filter((n) => n.includes('.bak')).length, before);

    // A backup that cannot be written aborts the opt-in: same store, no schema 4.
    const g = fixture();
    try {
      const snapshot = fs.readFileSync(g.nodesPath);
      fs.chmodSync(g.dir, 0o500);
      try {
        assert.throws(() => enable(g.nodesPath), /EACCES|permission/i);
      } finally { fs.chmodSync(g.dir, 0o700); }
      assert.ok(fs.readFileSync(g.nodesPath).equals(snapshot), 'the store was not written');
      assert.equal(load(g.nodesPath).schemaVersion, 3);
    } finally { g.cleanup(); }

    // Never overwrite a previous backup.
    const when = new Date('2026-10-10T12:00:00Z');
    const h = fixture();
    try {
      store.backupStoreFile(h.nodesPath, when);
      assert.throws(() => store.backupStoreFile(h.nodesPath, when), /EEXIST/);
    } finally { h.cleanup(); }
  } finally { f.cleanup(); }
});

test('opt-in is a compare-and-set on the access revision: a stale revision is refused and writes nothing', () => {
  const f = fixture();
  try {
    const rev = load(f.nodesPath).accessRevision || 0;
    const stale = store.setPublishRemoteCas({ filePath: f.nodesPath, name: 'box', enabled: true, audience: [READER1], expectedRevision: rev + 5 });
    assert.equal(stale.ok, false);
    assert.equal(stale.conflict, true);
    assert.equal(load(f.nodesPath).schemaVersion, 3);
    assert.equal(fs.readdirSync(f.dir).filter((n) => n.includes('.bak')).length, 0, 'no backup for a refused request');
    const ok = store.setPublishRemoteCas({ filePath: f.nodesPath, name: 'box', enabled: true, audience: [READER1], expectedRevision: rev });
    assert.equal(ok.ok, true);
    assert.equal(ok.revision, rev + 1);
  } finally { f.cleanup(); }
});

test('schemas 1, 2 and 3 keep loading unchanged; the schema moves to 4 only at the opt-in; schema 4 survives other mutators', () => {
  const f = fixture();
  try {
    // v3 round-trip: nothing is rewritten with a new schema or new fields.
    const st3 = load(f.nodesPath);
    const rt = store.atomicWriteStore(f.nodesPath, st3);
    assert.equal(rt.schemaVersion, 3);
    assert.ok(!JSON.stringify(rt).includes('publishRemote'));
    // v2 and v1 stores still parse.
    const v2 = { schemaVersion: 2, nodeId: SELF, nodes: [{ name: 'p', ssh: 'p', remotePort: 41820, localPort: 43500 }] };
    assert.ok(store.parseStore(v2));
    const v1 = { schemaVersion: 1, nodeId: SELF, nodes: [{ name: 'p', ssh: 'u@h', keyPath: '/k', remotePort: 41820, localPort: 43500 }] };
    assert.ok(store.parseStore(v1));
    assert.equal(store.parseStore({ ...v2, nodes: [{ ...v2.nodes[0], publishRemote: false }] }), null, 'v2 with the fields is refused');
    assert.equal(store.parseStore({ schemaVersion: 5, nodeId: SELF, nodes: [] }), null, 'unknown future schema is refused');

    // A v2 store can opt in: it goes straight to 4.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hostonly-v2-'));
    try {
      const p2 = path.join(dir2, 'nodes.json');
      let s2 = store.parseStore({ schemaVersion: 2, nodeId: SELF, nodes: [] });
      s2 = store.addNode(s2, peer('reader1', READER1, { localPort: 43201 }));
      s2 = store.addNode(s2, BOX_USER({ localPort: 43202 }));
      store.atomicWriteStore(p2, s2);
      assert.equal(load(p2).schemaVersion, 2);
      const r = store.setPublishRemoteCas({ filePath: p2, name: 'box', enabled: true, audience: [READER1] });
      assert.equal(r.ok, true);
      assert.equal(load(p2).schemaVersion, 4);
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }

    // Once at 4, ordinary mutators must NOT lower the schema (that would drop the fields).
    enable(f.nodesPath);
    let st = load(f.nodesPath);
    assert.equal(st.schemaVersion, 4);
    st = store.setNodeToken(st, 'reader1', 'new-token');
    assert.equal(st.schemaVersion, 4);
    st = store.setPeerAccessPreset(st, 'reader2', 'user');
    assert.equal(st.schemaVersion, 4);
    st = store.addNode(st, peer('late', ID('5'), { localPort: 43300 }));
    assert.equal(st.schemaVersion, 4);
    st = store.removeNode(st, 'late');
    assert.equal(st.schemaVersion, 4);
    const written = store.atomicWriteStore(f.nodesPath, st);
    assert.equal(written.schemaVersion, 4);
    assert.equal(byName(written, 'box').publishRemote, true);
    const migrated = store.migrateAdminReception({ filePath: f.nodesPath });
    assert.ok(migrated);
    assert.equal(load(f.nodesPath).schemaVersion, 4);
    assert.equal(byName(load(f.nodesPath), 'box').publishRemote, true);
    // And redaction exposes the publication but never a credential.
    const red = store.redactNode(byName(load(f.nodesPath), 'box'));
    assert.equal(red.publishRemote, true);
    assert.deepEqual(red.publishRemoteAudience, [READER1, READER2]);
    assert.equal(red.token, undefined);
    assert.equal(red.acceptToken, undefined);
    assert.ok(!JSON.stringify(red).includes('to-box') && !JSON.stringify(red).includes('from-box'));
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------- canTransit

test('canTransit matrix: audience -> peer yes, everything else no, in both directions; legacy unchanged', () => {
  const f = fixture();
  try {
    enable(f.nodesPath, [READER1]);
    const st = load(f.nodesPath);
    const box = byName(st, 'box'); const r1 = byName(st, 'reader1'); const r2 = byName(st, 'reader2');
    const intruder = byName(st, 'intruder'); const other = byName(st, 'other');
    assert.equal(fed.canTransit(null, box), true, 'owner -> peer');
    assert.equal(fed.canTransit(r1, box), true, 'audience admin -> peer');
    assert.equal(fed.canTransit(r2, box), false, 'admin outside the audience');
    assert.equal(fed.canTransit(intruder, box), false, 'admin outside the audience');
    assert.equal(fed.canTransit(other, box), false, 'no operator grant');
    assert.equal(fed.canTransit({ ...r1, peerOperatorAccess: false }, box), false, 'audience member that lost the operator grant (live re-read)');
    assert.equal(fed.canTransit({ ...r1, nodeId: undefined }, box), false, 'no identity, no audience');
    assert.equal(fed.canTransit({ ...r1, nodeId: READER2 }, box), false, 'identity comes from the record, not from a claim');
    assert.equal(fed.canTransit({ ...r1, visibility: 'relay-only' }, box), true, 'visibility is the legacy ACL, not the audience');
    // peer -> anyone: never, whatever the destination or the peer's own claims.
    for (const target of [r1, r2, intruder, other]) {
      assert.equal(fed.canTransit(box, target), false, `peer -> ${target.name}`);
      assert.equal(fed.canTransit({ ...box, peerOperatorAccess: true, visibility: 'network', shared: true }, target), false, `forged admin peer -> ${target.name}`);
    }
    assert.equal(fed.canTransit(box, box), false, 'ingress equals egress');
    assert.equal(fed.canTransit(box, null), false);
    // A host-only peer cannot be a reader of another host-only peer.
    const box2 = { ...box, name: 'box2', nodeId: ID('3'), publishRemoteAudience: [BOX] };
    assert.equal(fed.canTransit(box, box2), false);
    // Legacy: unchanged.
    assert.equal(fed.canTransit(r1, { ...r2, shared: true }), true, 'legacy shared/network');
    assert.equal(fed.canTransit(r1, { ...r2, shared: false }), false, 'legacy private peer');
    assert.equal(fed.canTransit(r1, { ...r2, visibility: 'relay-only' }), false, 'legacy relay-only');
    assert.equal(fed.canTransit({ ...r1, visibility: 'selected', selected: [READER2] }, r2), true, 'legacy selected');
    // Off: the very same record stops being reachable.
    store.setPublishRemoteCas({ filePath: f.nodesPath, name: 'box', enabled: false });
    assert.equal(fed.canTransit(byName(load(f.nodesPath), 'reader1'), byName(load(f.nodesPath), 'box')), false);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------- HTTP relay

const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const closeServer = (s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(resolve); });

async function relayFixture(t) {
  const calls = [];
  const upstream = await listen((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization, method: req.method });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  const f = fixture({ localPort: upstream.address().port });
  enable(f.nodesPath, [READER1]);
  const app = express();
  app.use('/federation', fed.peerRouter({ nodesPath: f.nodesPath, localPort: 1, localCredential: () => 'hub-main', fetchImpl: async () => { throw new Error('no network in this test'); } }));
  const hub = await listen(app);
  t.after(async () => { await closeServer(hub); await closeServer(upstream); f.cleanup(); });
  const get = (pathname, who, headers = {}) => fetch(`http://127.0.0.1:${hub.address().port}${pathname}`, {
    headers: { ...(who ? { authorization: `Bearer from-${who.name}`, 'x-nexuscrew-visited': who.nodeId } : {}), ...headers },
  });
  return { f, calls, get, hub };
}

test('HTTP relay: audience reaches the peer, every other caller is refused, and the peer reaches nothing', async (t) => {
  const { f, calls, get } = await relayFixture(t);
  const st = load(f.nodesPath);
  const r1 = byName(st, 'reader1'); const r2 = byName(st, 'reader2'); const intruder = byName(st, 'intruder'); const other = byName(st, 'other'); const box = byName(st, 'box');

  const ok = await get('/federation/route/box/_/cells', r1);
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/federation/route/_/cells');
  assert.equal(calls[0].auth, 'Bearer to-box', 'the relay uses OUR credential for the peer, never the reader\'s');

  for (const who of [r2, intruder, other]) {
    const denied = await get('/federation/route/box/_/cells', who);
    assert.equal(denied.status, 403, who.name);
    assert.equal((await denied.json()).error, 'route non consentita');
  }
  assert.equal((await get('/federation/route/box/_/cells', null)).status, 401, 'no credential');
  assert.equal((await get('/federation/route/box/_/cells', { name: 'reader1', nodeId: READER1 }, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal(calls.length, 1, 'nothing else reached the peer');

  // The peer as the caller: no other peer, no resource of ours, no topology.
  for (const target of ['reader1', 'reader2', 'intruder', 'other']) {
    const res = await get(`/federation/route/${target}/_/cells`, box);
    assert.equal(res.status, 403, `peer -> ${target}`);
  }
  const own = await get('/federation/route/_/cells', box);
  assert.equal(own.status, 403, 'peer -> our own resources');
  assert.equal((await own.json()).reason, 'host-only-peer');
  const evt = await get('/federation/route/_/event-feed', box);
  assert.equal(evt.status, 403);
  const topo = await get('/federation/topology', box);
  assert.equal(topo.status, 403);
  assert.equal((await topo.json()).reason, 'host-only-peer');
  // A forged visited chain does not turn a refused peer into an allowed one.
  const forged = await get('/federation/route/reader2/_/cells', box, { 'x-nexuscrew-visited': `${READER1},${BOX}` });
  assert.ok([403, 409].includes(forged.status), `forged chain: ${forged.status}`);
  assert.equal(calls.length, 1);
});

test('HTTP relay: revocation takes effect on the very next call (audience, operator grant, mode off)', async (t) => {
  const { f, calls, get } = await relayFixture(t);
  const reader = () => byName(load(f.nodesPath), 'reader1');
  assert.equal((await get('/federation/route/box/_/cells', reader())).status, 200);

  // 1) the reader loses the operator grant
  let st = load(f.nodesPath);
  store.atomicWriteStore(f.nodesPath, store.updateNode(st, 'reader1', { peerOperatorAccess: false }));
  assert.equal((await get('/federation/route/box/_/cells', reader())).status, 403, 'operator grant revoked');
  store.atomicWriteStore(f.nodesPath, store.updateNode(load(f.nodesPath), 'reader1', { peerOperatorAccess: true }));
  assert.equal((await get('/federation/route/box/_/cells', reader())).status, 200, 'granted again');

  // 2) the audience changes (off, then on for someone else)
  store.setPublishRemoteCas({ filePath: f.nodesPath, name: 'box', enabled: false });
  assert.equal((await get('/federation/route/box/_/cells', reader())).status, 403, 'mode off');
  store.setPublishRemoteCas({ filePath: f.nodesPath, name: 'box', enabled: true, audience: [READER2] });
  assert.equal((await get('/federation/route/box/_/cells', reader())).status, 403, 'reader1 is no longer in the audience');
  assert.equal((await get('/federation/route/box/_/cells', byName(load(f.nodesPath), 'reader2'))).status, 200);
  assert.equal(calls.length, 3);
});

// ---------------------------------------------------------------- WebSocket

test('WebSocket upgrade: same decision as the HTTP relay (audience yes, others and the peer no)', async (t) => {
  const upstreamHits = [];
  const upstream = await listen(() => {});
  const wss = new WebSocket.Server({ server: upstream });
  wss.on('connection', (ws, req) => { upstreamHits.push({ url: req.url, auth: req.headers.authorization }); ws.send('hello'); });
  const f = fixture({ localPort: upstream.address().port });
  enable(f.nodesPath, [READER1]);
  const hub = await listen(() => {});
  hub.on('upgrade', (req, socket, head) => {
    const ingress = fed.peerFromToken(f.nodesPath, (req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!ingress) return socket.destroy();
    fed.forwardUpgrade({ req, socket, head, nodesPath: f.nodesPath, localPort: 1, localCredential: () => 'hub-main', ingress, readonly: () => false, hopSecret: null });
  });
  t.after(async () => { wss.close(); await closeServer(hub); await closeServer(upstream); f.cleanup(); });
  const st = load(f.nodesPath);
  const attempt = (pathname, who) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.address().port}${pathname}`, {
      headers: { authorization: `Bearer from-${who.name}`, 'x-nexuscrew-visited': who.nodeId },
    });
    const done = (value) => { try { ws.terminate(); } catch (_) { /* gone */ } resolve(value); };
    // A refused upgrade may still be "accepted then closed" with an error frame
    // (rejectAsNoSuchSession): only the upstream's own greeting means we got through.
    ws.on('message', (data) => done(String(data) === 'hello' ? 'open' : `refused-frame:${String(data).slice(0, 40)}`));
    ws.on('unexpected-response', (_req, res) => done(`http-${res.statusCode}`));
    ws.on('error', () => done('error'));
    ws.on('close', () => done('closed'));
    setTimeout(() => done('timeout'), 4000);
  });
  assert.equal(await attempt('/federation/route/box/_/ws', byName(st, 'reader1')), 'open', 'audience admin');
  assert.equal(upstreamHits.length, 1);
  assert.equal(upstreamHits[0].url, '/federation/route/_/ws');
  assert.equal(upstreamHits[0].auth, 'Bearer to-box');
  for (const name of ['reader2', 'intruder', 'other']) {
    assert.notEqual(await attempt('/federation/route/box/_/ws', byName(st, name)), 'open', name);
  }
  for (const target of ['reader1', 'reader2', 'intruder']) {
    assert.notEqual(await attempt(`/federation/route/${target}/_/ws`, byName(st, 'box')), 'open', `peer -> ${target}`);
  }
  assert.notEqual(await attempt('/federation/route/_/ws', byName(st, 'box')), 'open', 'peer -> our own terminals');
  assert.equal(upstreamHits.length, 1, 'only the audience request reached the peer');
  // Revocation: the next upgrade is refused.
  store.setPublishRemoteCas({ filePath: f.nodesPath, name: 'box', enabled: false });
  assert.notEqual(await attempt('/federation/route/box/_/ws', byName(load(f.nodesPath), 'reader1')), 'open', 'off');
  assert.equal(upstreamHits.length, 1);
});

// ---------------------------------------------------------------- topology

function topologyFetch(log, children = [{ instanceId: ID('7'), name: 'evil', route: ['evil'] }]) {
  return async (url) => {
    log.push(String(url));
    const port = Number(new URL(String(url)).port);
    return { ok: true, json: async () => ({ instanceId: port === 43105 ? BOX : ID('a'), nodes: children }) };
  };
}

test('topology: the peer is announced only to the audience, as a leaf; it never announces anything', async () => {
  const f = fixture();
  try {
    enable(f.nodesPath, [READER1]);
    const st = load(f.nodesPath);
    const log = [];
    const routes = async (ingress) => (await fed.collectTopology({ nodesPath: f.nodesPath, ingress, fetchImpl: topologyFetch(log), timeoutMs: 500 }))
      .nodes.map((n) => n.route.join('/')).sort();

    const owner = await routes(null);
    assert.ok(owner.includes('box'), 'the owner sees its peer');
    assert.ok(!owner.some((r) => r.startsWith('box/')), 'a host-only peer is a leaf: what it announces never appears');
    assert.ok(!log.some((u) => u.includes(':43105/')), 'the peer\'s topology is never even requested');

    const audience = await routes(byName(st, 'reader1'));
    assert.ok(audience.includes('box'), 'audience sees it');
    assert.ok(!audience.some((r) => r.startsWith('box/')));
    const outside = await routes(byName(st, 'reader2'));
    assert.ok(!outside.includes('box'), 'an admin outside the audience does not see it');
    assert.ok(outside.includes('reader1'), 'legacy peers are announced as before');
    const lacking = await routes(byName(st, 'other'));
    assert.ok(!lacking.includes('box'));
    const asPeer = await routes(byName(st, 'box'));
    assert.deepEqual(asPeer, [], 'asked by the peer itself: nothing');

    // After off, nobody sees it any more.
    store.setPublishRemoteCas({ filePath: f.nodesPath, name: 'box', enabled: false });
    assert.ok(!(await routes(byName(load(f.nodesPath), 'reader1'))).includes('box'));
  } finally { f.cleanup(); }
});

test('topology cache: entries cached behind the peer are purged once it is host-only; a reader drops it after off', async () => {
  const f = fixture();
  try {
    const cachePath = path.join(f.dir, 'topology-cache.json');
    const topologyCache = require('../lib/nodes/topology-cache.js');
    // Before the mode: the peer's child is cached on this node.
    topologyCache.atomicWriteCache(cachePath, { schemaVersion: 1, nodes: [{ instanceId: ID('7'), name: 'evil', route: ['box', 'evil'], lastSeen: 1000 }] });
    const noNetwork = async () => { throw new Error('unreachable'); };
    let local = await fed.collectLocalTopology({ nodesPath: f.nodesPath, cachePath, fetchImpl: noNetwork, timeoutMs: 100 });
    assert.ok(local.nodes.some((n) => n.route.join('/') === 'box/evil'), 'legacy: a cached child behind a direct peer is served stale');
    enable(f.nodesPath, [READER1]);
    local = await fed.collectLocalTopology({ nodesPath: f.nodesPath, cachePath, fetchImpl: noNetwork, timeoutMs: 100 });
    assert.ok(!local.nodes.some((n) => n.route[0] === 'box' && n.route.length > 1), 'host-only: nothing cached behind the peer survives');
    assert.ok(!(topologyCache.loadCache(cachePath).nodes).some((n) => n.route[0] === 'box'), 'and it is gone from the file too');

    // Reader side: it cached Box as a transitive node through the hub; the hub
    // (authoritative) stops announcing it after `off` and the entry disappears.
    const readerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hostonly-reader-'));
    try {
      const readerPath = path.join(readerDir, 'nodes.json');
      let rs = store.emptyStore(READER1);
      rs = store.addNode(rs, peer('hubnode', SELF, { localPort: 43901 }));
      store.atomicWriteStore(readerPath, rs);
      const readerCache = path.join(readerDir, 'topology-cache.json');
      const announce = (nodes) => async () => ({ ok: true, json: async () => ({ instanceId: SELF, nodes }) });
      let view = await fed.collectLocalTopology({ nodesPath: readerPath, cachePath: readerCache, fetchImpl: announce([{ instanceId: BOX, name: 'box', route: ['box'], label: 'Box' }]), timeoutMs: 200 });
      assert.ok(view.nodes.some((n) => n.route.join('/') === 'hubnode/box'), 'published: visible to the reader');
      view = await fed.collectLocalTopology({ nodesPath: readerPath, cachePath: readerCache, fetchImpl: announce([]), timeoutMs: 200 });
      assert.ok(!view.nodes.some((n) => n.route.join('/') === 'hubnode/box'), 'after off: not served, not stale');
      assert.ok(!topologyCache.loadCache(readerCache).nodes.some((n) => n.instanceId === BOX), 'and not left in the cache file');
    } finally { fs.rmSync(readerDir, { recursive: true, force: true }); }
  } finally { f.cleanup(); }
});

test('/federation/topology over HTTP follows the same rule per caller', async (t) => {
  const { f, get } = await relayFixture(t);
  const st = load(f.nodesPath);
  const names = async (who) => {
    const res = await get('/federation/topology?ttl=1', who);
    assert.equal(res.status, 200, who.name);
    return (await res.json()).nodes.map((n) => n.name).sort();
  };
  assert.ok((await names(byName(st, 'reader1'))).includes('box'));
  assert.ok(!(await names(byName(st, 'reader2'))).includes('box'));
  assert.ok(!(await names(byName(st, 'other'))).includes('box'));
  assert.equal((await get('/federation/topology?ttl=1', byName(st, 'box'))).status, 403, 'the peer is refused outright');
});

// ---------------------------------------------------------------- protocol surface and Share

test('the peer reaches nothing over the protocol (only the health probe); Share is refused on it', async (t) => {
  const { f, get, calls, hub } = await relayFixture(t);
  const base = `http://127.0.0.1:${hub.address().port}`;
  const box = byName(load(f.nodesPath), 'box');
  const health = await get('/federation/health', box);
  assert.equal(health.status, 200, 'the health probe still works');
  for (const [pathname, method] of [['/federation/share', 'POST'], ['/federation/topology', 'GET'], ['/federation/reverse-pool/status', 'GET'], ['/federation/reverse-pool/reserve', 'POST'], ['/federation/route/_/cells', 'GET'], ['/federation/route/reader1/_/cells', 'GET']]) {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { authorization: 'Bearer from-box', 'x-nexuscrew-visited': box.nodeId, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: '{"shared":true}' } : {}),
    });
    assert.equal(res.status, 403, `${method} ${pathname}`);
    assert.equal((await res.json()).reason, 'host-only-peer', pathname);
  }
  assert.equal(calls.length, 0, 'nothing reached the peer');
  assert.equal(byName(load(f.nodesPath), 'box').shared, false, 'the peer could not turn Share on');
});

test('Settings Share ON on a published peer is refused at once (409) and touches neither SSH nor the store', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hostonly-settings-'));
  const configDir = path.join(dir, '.nexuscrew'); fs.mkdirSync(configDir, { recursive: true });
  const paths = { home: dir, configDir, configPath: path.join(configDir, 'config.json'), nodesPath: path.join(configDir, 'nodes.json'), tokenPath: path.join(configDir, 'token') };
  let st = store.emptyStore(SELF);
  st = store.addNode(st, peer('reader1', READER1, { localPort: 43101 }));
  st = store.addNode(st, BOX_USER({ localPort: 43105, reversePort: 41830 }));
  store.atomicWriteStore(paths.nodesPath, st);
  store.setPublishRemoteCas({ filePath: paths.nodesPath, name: 'box', enabled: true, audience: [READER1] });
  const effects = [];
  const { createServer } = require('../lib/server.js');
  const { server, token, watcher } = createServer({
    ...paths, filesRoot: path.join(dir, 'files'), port: 41999, fleetEnabled: false,
    settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { effects.push('exec'); throw new Error('no exec'); }, spawnImpl: () => { effects.push('spawn'); return { pid: 4193999, unref() {} }; },
      fetchImpl: async () => { effects.push('fetch'); throw new Error('no network'); }, sshVersion: () => ({ major: 9, minor: 6 }) },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = fs.readFileSync(paths.nodesPath);
  const on = await fetch(`${base}/api/settings/nodes/box/share`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ shared: true }) });
  assert.equal(on.status, 409);
  assert.equal((await on.json()).reason, 'publish-remote-active');
  assert.deepEqual(effects, [], 'no SSH restart, no hub call, no reverse negotiation');
  assert.ok(fs.readFileSync(paths.nodesPath).equals(before), 'the store was not touched');
});

// ---------------------------------------------------------------- CLI

function cliHome(extraPeers = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hostonly-home-'));
  const nodesPath = store.defaultNodesPath(home);
  fs.mkdirSync(path.dirname(nodesPath), { recursive: true });
  let st = store.emptyStore(SELF);
  if (extraPeers) {
    st = store.addNode(st, peer('reader1', READER1, { localPort: 43101 }));
    st = store.addNode(st, peer('reader2', READER2, { localPort: 43102 }));
    st = store.addNode(st, peer('other', OTHER, { localPort: 43104, peerOperatorAccess: false }));
    st = store.addNode(st, BOX_USER({ localPort: 43105 }));
  }
  store.atomicWriteStore(nodesPath, st);
  return { home, nodesPath, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('CLI: publish-remote on/off/status; no Share, no tunnel, no SSH, no reverse pool', async () => {
  const h = cliHome();
  try {
    const lines = []; const log = (m) => lines.push(String(m));
    const spawned = [];
    const seams = { spawnImpl: (...a) => { spawned.push(a); throw new Error('must not spawn'); }, spawnSyncImpl: (...a) => { spawned.push(a); throw new Error('must not spawn'); },
      fetchImpl: () => { spawned.push('fetch'); throw new Error('must not fetch'); }, startForward: () => spawned.push('start'), stopTunnel: () => spawned.push('stop') };
    const before = load(h.nodesPath);

    assert.equal((await dispatch(['nodes', 'publish-remote', 'box', 'status'], { home: h.home, log, ...seams })).code, 0);
    assert.match(lines.at(-1), /off/);

    // `on` needs an audience.
    assert.equal((await dispatch(['nodes', 'publish-remote', 'box', 'on'], { home: h.home, log, ...seams })).code, 1);
    assert.match(lines.at(-1), /--audience/);
    assert.equal(load(h.nodesPath).schemaVersion, 3, 'nothing written');
    // `--audience` is only for `on`.
    assert.equal((await dispatch(['nodes', 'publish-remote', 'box', 'off', '--audience', READER1], { home: h.home, log, ...seams })).code, 1);
    // Refusals carry the reason and write nothing.
    for (const audience of [OTHER, ID('9'), 'not-an-id', BOX]) {
      const r = await dispatch(['nodes', 'publish-remote', 'box', 'on', '--audience', audience], { home: h.home, log, ...seams });
      assert.equal(r.code, 1, audience);
    }
    assert.equal(load(h.nodesPath).schemaVersion, 3);
    // READONLY blocks the mutation, not the status.
    assert.equal((await dispatch(['nodes', 'publish-remote', 'box', 'on', '--audience', READER1], { home: h.home, log, readonly: true, ...seams })).code, 1);
    assert.equal(load(h.nodesPath).schemaVersion, 3);
    assert.equal((await dispatch(['nodes', 'publish-remote', 'box', 'status'], { home: h.home, log, readonly: true, ...seams })).code, 0);
    // Unknown peer.
    assert.equal((await dispatch(['nodes', 'publish-remote', 'nessuno', 'on', '--audience', READER1], { home: h.home, log, ...seams })).code, 1);

    // The real thing, both flag forms.
    assert.equal((await dispatch(['nodes', 'publish-remote', 'box', 'on', '--audience', `${READER2},${READER1}`], { home: h.home, log, ...seams })).code, 0);
    assert.ok(lines.some((l) => l.includes('on · audience')) && lines.some((l) => l.includes('backup dello store')));
    const st = load(h.nodesPath);
    assert.equal(st.schemaVersion, 4);
    assert.deepEqual(byName(st, 'box').publishRemoteAudience, [READER1, READER2]);
    // Re-issuing `on` is refused (change the audience by off + on).
    assert.equal((await dispatch(['nodes', 'publish-remote', 'box', 'on', `--audience=${READER1}`], { home: h.home, log, ...seams })).code, 1);
    // status --json
    const json = [];
    assert.equal((await dispatch(['nodes', 'publish-remote', 'box', 'status', '--json'], { home: h.home, log: (m) => json.push(m), ...seams })).code, 0);
    assert.deepEqual(JSON.parse(json.join('')), { name: 'box', enabled: true, audience: [READER1, READER2] });
    // Nothing but the access vector / publication changed on the peer; the other peers are identical.
    const was = byName(before, 'box'); const now = byName(st, 'box');
    for (const key of ['ssh', 'sshPort', 'localPort', 'remotePort', 'autostart', 'shared', 'reversePort', 'reversePool', 'token', 'acceptToken', 'direction', 'transport', 'visibility']) {
      assert.deepEqual(now[key], was[key], `${key} must not change (no share, no restart)`);
    }
    for (const name of ['reader1', 'reader2', 'other']) assert.deepEqual(byName(st, name), byName(before, name));
    assert.deepEqual(spawned, [], 'no process, no network, no tunnel start/stop');

    // The widening commands are refused while it is on.
    for (const argv of [['nodes', 'edit', 'box', '--access-role', 'user'], ['nodes', 'edit', 'box', '--events-access', 'on'], ['nodes', 'panel', 'box', 'on'], ['nodes', 'cells', 'box', 'all'], ['nodes', 'edit', 'box', '--events-receive', 'on']]) {
      const r = await dispatch(argv, { home: h.home, log, ...seams });
      assert.equal(r.code, 1, argv.join(' '));
    }
    assert.deepEqual(byName(load(h.nodesPath), 'box'), now, 'the peer record is unchanged by every refused edit');
    assert.equal((await dispatch(['nodes', 'edit', 'box', '--label', 'Box'], { home: h.home, log, ...seams })).code, 0, 'unrelated edits still work');

    // Off.
    assert.equal((await dispatch(['nodes', 'publish-remote', 'box', 'off'], { home: h.home, log, ...seams })).code, 0);
    const off = byName(load(h.nodesPath), 'box');
    assert.equal(off.publishRemote, false);
    assert.equal(off.eventsAccess, false);
    assert.equal(load(h.nodesPath).schemaVersion, 4);
    assert.deepEqual(spawned, []);
  } finally { h.cleanup(); }
});

test('CLI help lists the command and the value flag is registered', () => {
  const lines = [];
  dispatch(['nodes', 'help'], { log: (m) => lines.push(String(m)) });
  assert.ok(lines.join('\n').includes('nodes publish-remote <name|nodeId> on --audience'));
});

// ---------------------------------------------------------------- inspect vs access

test('nodes inspect reports the same EFFECTIVE grants as nodes access (and as the authorization code)', async () => {
  const h = cliHome();
  try {
    const user = [];
    const inspect = cmds.nodesInspect({ home: h.home, log: (m) => user.push(String(m)), ref: 'box' });
    assert.equal(inspect.code, 0);
    const grantLine = user.find((l) => l.startsWith('grant:'));
    assert.match(grantLine, /eventsAccess=on/, `inspect must show the real grant: ${grantLine}`);
    assert.match(grantLine, /nodeEventsAccess=on/);
    assert.match(grantLine, /filesReadAccess=on/);
    assert.match(grantLine, /askReplyAccess=off/);
    assert.match(grantLine, /peerOperatorAccess=off/);
    assert.ok(user.some((l) => l.startsWith('accesso:   user')), `label: ${user.join(' | ')}`);

    const accessLines = []; cmds.nodesAccess({ home: h.home, log: (m) => accessLines.push(String(m)), json: true });
    const access = JSON.parse(accessLines.join('')).peers.find((p) => p.name === 'box');
    const stored = boxOf(h.nodesPath);
    for (const key of cmds.ACCESS_GRANT_KEYS) {
      assert.equal(access.grants[key], stored[key] === true, `access ${key}`);
      assert.match(grantLine, new RegExp(`${key}=${stored[key] ? 'on' : 'off'}`), `inspect ${key}`);
      // ... and the authorization code agrees with both views.
    }
    assert.equal(resourceAcl.allowedByClass('event-feed', stored), true);
    assert.equal(resourceAcl.allowedByClass('files-read', stored), true);
    assert.equal(resourceAcl.allowedByClass('operator', stored), false);

    // After the opt-in, all three agree on "everything off".
    store.setPublishRemoteCas({ filePath: h.nodesPath, name: 'box', enabled: true, audience: [READER1] });
    const after = []; cmds.nodesInspect({ home: h.home, log: (m) => after.push(String(m)), ref: 'box' });
    assert.match(after.find((l) => l.startsWith('grant:')), /^grant:\s+eventsAccess=off nodeEventsAccess=off askReplyAccess=off filesReadAccess=off peerOperatorAccess=off panelAccess=off liveHostAccess=off$/);
    assert.ok(after.some((l) => l.startsWith('pubblicato: solo-host')), after.join(' | '));
    const stored2 = boxOf(h.nodesPath);
    for (const cls of resourceAcl.CLASS_NAMES) assert.equal(resourceAcl.allowedByClass(cls, stored2), false, cls);
    // The JSON inspect carries the publication but never a token.
    const j = []; cmds.nodesInspect({ home: h.home, log: (m) => j.push(String(m)), ref: 'box', json: true });
    const parsed = JSON.parse(j.join(''));
    assert.equal(parsed.publishRemote, true);
    assert.ok(!JSON.stringify(parsed).includes('to-box'));
  } finally { h.cleanup(); }
});
