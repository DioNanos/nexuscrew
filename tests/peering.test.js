'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const peering = require('../lib/nodes/peering.js');

test('pairing invite: URL round-trip, 0600, one-time and expiry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair-'));
  const p = path.join(dir, 'invites.json');
  const now = 1000;
  const made = peering.createInvite({ invitesPath: p, instanceId: 'a'.repeat(32), port: 41820, label: 'Relay', now });
  const parsed = peering.parsePairingUrl(made.pairingUrl);
  assert.equal(parsed.instanceId, 'a'.repeat(32));
  assert.equal(parsed.port, 41820);
  assert.equal(parsed.label, 'Relay');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.equal(peering.consumeInvite({ invitesPath: p, invite: parsed.invite, now: now + 1 }), true);
  assert.equal(peering.consumeInvite({ invitesPath: p, invite: parsed.invite, now: now + 2 }), false);
  const expired = peering.createInvite({ invitesPath: p, instanceId: 'b'.repeat(32), port: 41821, now });
  assert.equal(peering.consumeInvite({ invitesPath: p, invite: peering.parsePairingUrl(expired.pairingUrl).invite, now: now + peering.INVITE_TTL_MS + 1 }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pairing parser rejects malformed payloads and reverse ports do not collide', () => {
  assert.equal(peering.parsePairingUrl('not a URL'), null);
  assert.equal(peering.decodePairing('garbage'), null);
  assert.equal(peering.allocateReversePort([{ localPort: 44001 }, { reversePort: 44002 }]), 44003);
});
