'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
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

test('pairing invite: landing port and remote NexusCrew port are independent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair-ports-'));
  const made = peering.createInvite({
    invitesPath: path.join(dir, 'invites.json'), instanceId: 'e'.repeat(32),
    port: 43001, linkPort: 41820, label: 'Relay', ssh: 'relay-host',
  });
  assert.equal(new URL(made.pairingUrl).port, '41820', 'link opens on the receiver/local PWA port');
  const parsed = peering.parsePairingUrl(made.pairingUrl);
  assert.equal(parsed.port, 43001, 'payload keeps the published remote HTTP port');
  assert.equal(parsed.sshPort, undefined, 'published HTTP port is never inferred as SSH port');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pairing parser rejects malformed payloads and reverse ports do not collide', () => {
  assert.equal(peering.parsePairingUrl('not a URL'), null);
  assert.equal(peering.decodePairing('garbage'), null);
  assert.equal(peering.allocateReversePort([{ localPort: 44001 }, { reversePort: 44002 }]), 44003);
  assert.equal(peering.allocateReversePort([{ localPort: 44001 }], [{ reversePort: 44002 }]), 44003,
    'active pending reservations participate in allocation');
});

test('reverse allocator skips a live loopback listener absent from persistent state', async () => {
  let calls = 0;
  const createServerImpl = () => {
    const server = new EventEmitter();
    server.listen = () => {
      calls += 1;
      queueMicrotask(() => {
        if (calls === 1) {
          const error = new Error('busy'); error.code = 'EADDRINUSE'; server.emit('error', error);
        } else server.emit('listening');
      });
    };
    server.close = (done) => done();
    server.unref = () => {};
    return server;
  };
  assert.equal(await peering.allocateAvailableReversePort([], [], { createServerImpl }), 44002);
  assert.equal(calls, 2);
});

// --- v2: singolo link con SSH/slug (NIENTE segreti); v1 backward-compat --------

test('pairing v2: un solo link porta slug + Host SSH + porta; round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair2-'));
  const p = path.join(dir, 'invites.json');
  const made = peering.createInvite({
    invitesPath: p, instanceId: 'a'.repeat(32), port: 41820, label: 'Relay',
    ssh: 'dag@relay.example', sshPort: 2222, name: 'home-relay',
  });
  assert.equal(made.version, 2);
  const parsed = peering.parsePairingUrl(made.pairingUrl);
  assert.equal(parsed.v, 2);
  assert.equal(parsed.name, 'home-relay');
  assert.equal(parsed.ssh, 'dag@relay.example');
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
    label: 'Edge 3 Relay', ssh: 'edge3-relay',
  });
  const parsed = peering.parsePairingUrl(made.pairingUrl);
  assert.equal(made.version, 2);
  assert.equal(parsed.name, 'edge-3-relay');
  assert.equal(parsed.ssh, 'edge3-relay');
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

test('transport probe: capability proof + instanceId esatti, non un HTTP/401 qualunque', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair-proof-'));
  const invitesPath = path.join(dir, 'invites.json');
  const pendingPath = path.join(dir, 'pending.json');
  const instanceId = 'e'.repeat(32);
  const made = peering.createInvite({ invitesPath, instanceId, port: 41820, label: 'Relay' });
  const pair = peering.parsePairingUrl(made.pairingUrl);
  const proofServer = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const proof = peering.capabilityIdentity({ invitesPath, pendingPath, ...body });
    return { status: proof ? 200 : 404, json: async () => (proof ? { ok: true, instanceId, proof } : { error: 'not found' }) };
  };
  const ok = await peering.probeTransportReady({
    port: 43001, capability: pair.invite, expectedInstanceId: instanceId,
    fetchImpl: proofServer, attempts: 1,
  });
  assert.equal(ok.ready, true);

  const foreign401 = await peering.probeTransportReady({
    port: 43001, capability: pair.invite, expectedInstanceId: instanceId,
    fetchImpl: async () => ({ status: 401, json: async () => ({}) }), attempts: 1,
  });
  assert.equal(foreign401.ready, false);
  assert.equal(foreign401.code, 'identity-proof-rejected');

  const fake200 = await peering.probeTransportReady({
    port: 43001, capability: pair.invite, expectedInstanceId: instanceId,
    fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, instanceId, proof: crypto.randomBytes(32).toString('base64url') }) }),
    attempts: 1,
  });
  assert.equal(fake200.ready, false);
  assert.equal(fake200.code, 'identity-proof-invalid');

  const wrongIdentity = await peering.probeTransportReady({
    port: 43001, capability: pair.invite, expectedInstanceId: 'f'.repeat(32),
    fetchImpl: proofServer, attempts: 1,
  });
  assert.equal(wrongIdentity.ready, false);
  assert.equal(wrongIdentity.code, 'peer-identity-mismatch');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transport proof supports pending credential after invite consumption', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair-pending-proof-'));
  const invitesPath = path.join(dir, 'invites.json');
  const pendingPath = path.join(dir, 'pending.json');
  const instanceId = 'a'.repeat(32);
  const credential = peering.createPending({ pendingPath, data: { instanceId: 'b'.repeat(32) } });
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const proof = peering.capabilityIdentity({ invitesPath, pendingPath, ...body });
    return { status: proof ? 200 : 404, json: async () => ({ ok: !!proof, instanceId, proof }) };
  };
  const out = await peering.probeTransportReady({
    port: 44001, capability: credential, expectedInstanceId: instanceId, fetchImpl, attempts: 1,
  });
  assert.equal(out.ready, true);
  peering.consumePending({ pendingPath, credential });
  const consumed = await peering.probeTransportReady({
    port: 44001, capability: credential, expectedInstanceId: instanceId, fetchImpl, attempts: 1,
  });
  assert.equal(consumed.ready, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transport probe waits for a slow SSH forward instead of exhausting in 3.75 seconds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair-slow-forward-'));
  const invitesPath = path.join(dir, 'invites.json');
  const pendingPath = path.join(dir, 'pending.json');
  const instanceId = 'c'.repeat(32);
  const made = peering.createInvite({ invitesPath, instanceId, port: 41777, label: 'Slow relay' });
  const pair = peering.parsePairingUrl(made.pairingUrl);
  let clock = 0;
  let calls = 0;
  const fetchImpl = async (_url, opts) => {
    calls += 1;
    if (clock < 8000) throw new Error('fetch failed');
    const body = JSON.parse(opts.body);
    const proof = peering.capabilityIdentity({ invitesPath, pendingPath, ...body });
    return { status: 200, json: async () => ({ ok: true, instanceId, proof }) };
  };
  const out = await peering.probeTransportReady({
    port: 43001, capability: pair.invite, expectedInstanceId: instanceId,
    fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  assert.equal(out.ready, true);
  assert.ok(clock >= 8000, `probe terminated too early at ${clock}ms`);
  assert.ok(calls > 6, 'regression: the old implementation stopped after six immediate refusals');
  assert.equal(out.elapsedMs, clock);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transport probe remains deadline-bounded when the SSH forward never appears', async () => {
  let clock = 0;
  const out = await peering.probeTransportReady({
    port: 43001, capability: 'A'.repeat(43), expectedInstanceId: 'd'.repeat(32),
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    deadlineMs: 5000, now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  assert.equal(out.ready, false);
  assert.equal(out.code, 'transport-not-ready');
  assert.ok(clock >= 5000 && clock <= 5000, `deadline non rispettata: ${clock}`);
  assert.ok(out.attempts > 1 && out.attempts < 16);
});
