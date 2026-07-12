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

// --- v2: singolo link con SSH/slug (NIENTE segreti); v1 backward-compat --------

test('pairing v2: un solo link porta slug + Host SSH + porta; round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair2-'));
  const p = path.join(dir, 'invites.json');
  const made = peering.createInvite({
    invitesPath: p, instanceId: 'a'.repeat(32), port: 41820, label: 'Relay',
    ssh: 'user@relay.example', sshPort: 2222, name: 'home-relay',
  });
  assert.equal(made.version, 2);
  const parsed = peering.parsePairingUrl(made.pairingUrl);
  assert.equal(parsed.v, 2);
  assert.equal(parsed.name, 'home-relay');
  assert.equal(parsed.ssh, 'user@relay.example');
  assert.equal(parsed.sshPort, 2222);
  assert.equal(parsed.label, 'Relay');
  assert.ok(parsed.invite);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pairing v2: con Host SSH e senza name deriva sempre lo slug dalla label', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair2-auto-'));
  const p = path.join(dir, 'invites.json');
  const made = peering.createInvite({
    invitesPath: p, instanceId: 'd'.repeat(32), port: 41820,
    label: 'Main Relay', ssh: 'relay-host',
  });
  const parsed = peering.parsePairingUrl(made.pairingUrl);
  assert.equal(made.version, 2);
  assert.equal(parsed.name, 'main-relay');
  assert.equal(parsed.ssh, 'relay-host');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pairing v1: senza ssh resta v1 (compat con link 0.8.x esistenti)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair1-'));
  const p = path.join(dir, 'invites.json');
  const made = peering.createInvite({ invitesPath: p, instanceId: 'b'.repeat(32), port: 41821, label: 'Solo' });
  assert.equal(made.version, 1);
  const parsed = peering.parsePairingUrl(made.pairingUrl);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.ssh, undefined);
  assert.equal(parsed.name, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pairing strict allowlist: campi ignoti o segreti -> rifiutato (null)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pairsec-'));
  const p = path.join(dir, 'invites.json');
  const made = peering.createInvite({ invitesPath: p, instanceId: 'c'.repeat(32), port: 41822, label: 'X', ssh: 'u@h', name: 'n' });
  const base = made.pairingUrl;
  // Campo segreto in più (identityFile) -> rifiutato
  const x = JSON.parse(Buffer.from(new URL(base).hash.replace(/^#pair=/, ''), 'base64url').toString('utf8'));
  const withSecret = { ...x, identityFile: '/home/example/.ssh/id_ed25519' };
  const url = `http://127.0.0.1:41822/#pair=${Buffer.from(JSON.stringify(withSecret)).toString('base64url')}`;
  assert.equal(peering.parsePairingUrl(url), null);
  // apiKey extra -> rifiutato
  const withKey = { ...x, apiKey: 'sk-secret' };
  const url2 = `http://127.0.0.1:41822/#pair=${Buffer.from(JSON.stringify(withKey)).toString('base64url')}`;
  assert.equal(peering.parsePairingUrl(url2), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
