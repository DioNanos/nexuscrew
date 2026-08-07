'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/vl-nodes/store.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vl-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'vl-nodes.json');
}

test('VL invite is one-time and store never persists invite or node token plaintext', (t) => {
  const file = fixture(t);
  let fill = 1;
  const seams = { now: () => 1_000, randomBytes: (n) => Buffer.alloc(n, fill++) };
  const issued = store.createInvite(file, { label: 'N900', ttlMs: 60_000 }, seams);
  const paired = store.pairNode(file, {
    invite: issued.invite,
    nodeId: 'a'.repeat(32),
    label: 'Nokia N900',
  }, seams);
  assert.equal(paired.ok, true);
  assert.equal(store.authenticate(file, paired.token).nodeId, 'a'.repeat(32));
  assert.equal(store.pairNode(file, {
    invite: issued.invite, nodeId: 'b'.repeat(32), label: 'replay',
  }, seams).code, 'invite-expired-or-used');
  const persisted = fs.readFileSync(file, 'utf8');
  assert.equal(persisted.includes(issued.invite), false);
  assert.equal(persisted.includes(paired.token), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('VL pairing rejects duplicate stable identity until explicit revoke', (t) => {
  const file = fixture(t);
  let fill = 3;
  const seams = { now: () => 2_000, randomBytes: (n) => Buffer.alloc(n, fill++) };
  const firstInvite = store.createInvite(file, { label: 'N900' }, seams);
  const first = store.pairNode(file, {
    invite: firstInvite.invite, nodeId: 'c'.repeat(32), label: 'N900',
  }, seams);
  assert.equal(first.ok, true);
  const secondInvite = store.createInvite(file, { label: 'N900' }, seams);
  assert.equal(store.pairNode(file, {
    invite: secondInvite.invite, nodeId: 'c'.repeat(32), label: 'duplicate',
  }, seams).code, 'node-exists');
  assert.equal(store.removeNode(file, 'c'.repeat(32)), true);
  assert.equal(store.authenticate(file, first.token), null);
});

test('expired invites are removed without creating a node', (t) => {
  const file = fixture(t);
  let now = 1_000;
  const seams = { now: () => now, randomBytes: (n) => Buffer.alloc(n, 7) };
  const invite = store.createInvite(file, { ttlMs: 30_000 }, seams);
  now += 30_001;
  assert.equal(store.pairNode(file, {
    invite: invite.invite, nodeId: 'd'.repeat(32), label: 'late',
  }, seams).code, 'invite-expired-or-used');
  assert.deepEqual(store.listNodes(file, now), []);
});

test('VL node store rejects symlinks and loose permissions', (t) => {
  const file = fixture(t);
  store.createInvite(file, { label: 'safe' });
  fs.chmodSync(file, 0o644);
  assert.throws(() => store.listNodes(file), /unsafe VL node store/);

  fs.chmodSync(file, 0o600);
  const target = `${file}.target`;
  fs.renameSync(file, target);
  fs.symlinkSync(target, file);
  assert.throws(() => store.listNodes(file), /unsafe VL node store|ELOOP/);
  assert.throws(() => store.createInvite(file, { label: 'blocked' }), /unsafe VL node store|ELOOP/);
});
