'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const express = require('express');
const { createLaunchBroker, MAX_PAYLOAD } = require('../lib/fleet/launch-broker.js');
const { createIdentityAuthority } = require('../lib/fleet/identity-authority.js');
const { issueLaunchIdentity } = require('../lib/fleet/identity-transport.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { leaseRoutes } = require('../lib/fleet/lease-routes.js');

const DAEMON = 'daemon-good';
const LAUNCHER = 'launcher-good';

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function authority(dir) {
  return createIdentityAuthority({
    dir,
    daemonCredential: DAEMON,
    launcherCredential: LAUNCHER,
    subjectResolver: () => true,
  });
}

function subject(overrides = {}) {
  return {
    ownerInstanceId: 'owner-a',
    cellId: 'Dev',
    incarnationId: 'incarnation-a',
    launchEpoch: 'epoch-a',
    ...overrides,
  };
}

function identityArgs(overSubject = {}) {
  return {
    audience: 'nexuscrew-lease',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
    subject: subject(overSubject),
  };
}

function readPayload(socketPath, nonce) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = Buffer.alloc(0);
    let expected = null;
    const finish = (error, payload) => {
      socket.destroy();
      if (error) reject(error); else resolve(payload);
    };
    socket.setTimeout(2000, () => finish(new Error('timeout')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ nonce })}\n`));
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (expected === null && data.length >= 4) {
        expected = data.readUInt32BE(0);
        data = data.subarray(4);
        if (!expected || expected > MAX_PAYLOAD) return finish(new Error('invalid payload length'));
      }
      if (expected !== null && data.length >= expected) {
        try { finish(null, JSON.parse(data.subarray(0, expected).toString('utf8'))); }
        catch (error) { finish(error); }
      }
    });
    socket.once('error', finish);
    socket.once('end', () => finish(new Error('closed early')));
  });
}

test('identity_launch_grant_binds_subject', async () => {
  const home = tmpdir('nc-identity-grant-');
  const auth = authority(path.join(home, 'identity'));
  const args = identityArgs();
  const out = issueLaunchIdentity({
    identityAuthority: auth,
    daemonCredential: DAEMON,
    launcherCredential: LAUNCHER,
    ...args,
  });
  try {
    assert.equal(out.ok, true);
    assert.equal(out.grant.kind, 'launch-grant');
    assert.equal(out.grant.ownerInstanceId, args.subject.ownerInstanceId);
    assert.equal(out.grant.cellId, args.subject.cellId);
    assert.equal(out.grant.incarnationId, args.subject.incarnationId);
    assert.equal(out.grant.launchEpoch, args.subject.launchEpoch);
    assert.equal(out.grant.audience, args.audience);
    assert.equal(out.grant.daemonBootId, args.daemonBootId);
    assert.equal(out.grant.connectionId, args.connectionId);
    assert.equal(out.proof.kind, 'identity-proof');
    assert.equal(out.proof.parentJti, out.grant.jti);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('identity_grant_requires_launcher_credential', async () => {
  const home = tmpdir('nc-identity-launcher-');
  const auth = authority(path.join(home, 'identity'));
  const out = issueLaunchIdentity({
    identityAuthority: auth,
    daemonCredential: DAEMON,
    launcherCredential: DAEMON,
    ...identityArgs(),
  });
  try {
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'launcher-credential');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('identity_proof_one_shot_and_generation_scoped', async () => {
  const home = tmpdir('nc-identity-proof-');
  const dir = path.join(home, 'identity');
  const first = authority(dir);
  const out = issueLaunchIdentity({
    identityAuthority: first,
    daemonCredential: DAEMON,
    launcherCredential: LAUNCHER,
    ...identityArgs(),
  });
  assert.equal(out.ok, true);
  const replay = first.issueChallengeProof({
    launchGrant: out.grant,
    challenge: out.challenge,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'challenge-replay');

  const second = authority(dir);
  const verified = second.verifyChallengeProof(out.proof, { audience: 'nexuscrew-lease' });
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, 'generation');
  fs.rmSync(home, { recursive: true, force: true });
});

test('lease_register_authority_rejects_forged_subject', async () => {
  const home = tmpdir('nc-identity-lease-');
  const auth = authority(path.join(home, 'identity'));
  const out = issueLaunchIdentity({
    identityAuthority: auth,
    daemonCredential: DAEMON,
    launcherCredential: LAUNCHER,
    ...identityArgs({ cellId: 'Dev' }),
  });
  const manager = createLeaseManager({ home, log: () => {} });
  await manager.track('Dev');
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use('/api/lease', leaseRoutes({
    fleetP: Promise.resolve({ available: true, lease: manager, identityAuthority: auth }),
    identityMode: 'authority',
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const forged = { ...out.proof, cellId: 'Research' };
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/lease/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: forged }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'denied');
    assert.equal(body.reason, 'bad-proof');
  } finally {
    server.close();
    manager.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('identity_grant_and_proof_never_reach_child_argv_env', async () => {
  const home = tmpdir('nc-identity-child-');
  const auth = authority(path.join(home, 'identity'));
  const broker = createLaunchBroker({
    home,
    identityMode: 'authority',
    identityAuthority: auth,
    identityDaemonCredential: DAEMON,
    identityLauncherCredential: LAUNCHER,
  });
  const outPath = path.join(home, 'child.json');
  const script = 'require("fs").writeFileSync(process.argv[1], JSON.stringify({argv:process.argv, env:process.env}))';
  try {
    const makePayload = () => ({
      command: process.execPath,
      args: ['-e', script, outPath],
      env: { PATH: '/usr/bin' },
      supervise: { enabled: false },
      identity: identityArgs(),
    });
    const inspectTicket = await broker.issue(makePayload());
    const payload = await readPayload(inspectTicket.socketPath, inspectTicket.nonce);
    assert.ok(payload.identity);
    assert.equal(payload.identity.grant.kind, 'launch-grant');
    assert.equal(payload.identity.proof.kind, 'identity-proof');
    assert.ok(!JSON.stringify([payload.command, ...payload.args, payload.env]).includes(payload.identity.grant.proof));
    assert.ok(!JSON.stringify([payload.command, ...payload.args, payload.env]).includes(payload.identity.proof.proof));

    const childTicket = await broker.issue(makePayload());
    const cellExec = path.join(__dirname, '..', 'lib', 'fleet', 'cell-exec.js');
    const child = spawn(process.execPath, [cellExec, '--socket', childTicket.socketPath, '--nonce', childTicket.nonce]);
    const code = await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(code, 0);
    const observed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    // Copertura generale: il leak può usare un nome arbitrario, quindi il
    // controllo per valore non si limita al materiale di questa issue payload.
    const secretMaterial = [
      payload.identity.challenge,
      payload.identity.grant.proof,
      payload.identity.proof.proof,
      JSON.stringify(payload.identity),
    ];
    const childKeys = Object.keys(observed.env);
    const childValues = childKeys.map((key) => observed.env[key]);
    const serializedChild = JSON.stringify([observed.argv, childKeys, childValues]);
    for (const material of secretMaterial) {
      assert.ok(typeof material === 'string' && material.length > 0);
      assert.ok(!observed.argv.includes(material));
      assert.ok(!childValues.some((value) => String(value).includes(material)));
      assert.ok(!serializedChild.includes(material));
    }
    assert.equal(observed.env.NEXUSCREW_IDENTITY_FD, '3:4',
      'metadata dei descrittori, non una capability');
    for (const key of childKeys) {
      assert.doesNotMatch(key, /^NEXUSCREW_(LAUNCH|PROOF|GRANT|CHALLENGE)/);
      assert.doesNotMatch(key, /^NEXUSCREW_IDENTITY(?!_FD$)/);
    }
    // Ogni challenge e proof del contract è un token esadecimale di 64 caratteri;
    // un leak serializzato con nome arbitrario deve restare osservabile.
    assert.doesNotMatch(serializedChild, /[0-9a-f]{64}/i);
  } finally {
    await broker.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('legacy_launch_without_authority_unchanged_after_grant', async () => {
  const home = tmpdir('nc-identity-legacy-');
  const broker = createLaunchBroker({ home, identityMode: 'legacy' });
  const input = { command: 'node', args: ['-e', 'process.exit(0)'], env: { PATH: '/usr/bin' } };
  try {
    const ticket = await broker.issue(input);
    const payload = await readPayload(ticket.socketPath, ticket.nonce);
    assert.deepEqual(payload, input);
    assert.equal(payload.identity, undefined);
  } finally {
    await broker.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
