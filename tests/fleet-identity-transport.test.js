'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createLaunchBroker, MAX_PAYLOAD } = require('../lib/fleet/launch-broker.js');
const { createIdentityAuthority } = require('../lib/fleet/identity-authority.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function authority(dir, daemonCredential = 'daemon-good') {
  return createIdentityAuthority({
    dir,
    daemonCredential,
    launcherCredential: 'launcher-good',
    subjectResolver: () => true,
  });
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

test('identity_challenge_rejects_wrong_credential', async () => {
  const home = tmpdir('nc-identity-transport-');
  const auth = authority(path.join(home, 'identity'));
  const broker = createLaunchBroker({
    home,
    identityMode: 'authority',
    identityAuthority: auth,
    identityDaemonCredential: 'daemon-wrong',
  });
  try {
    await assert.rejects(
      broker.issue({
        command: 'node',
        args: [],
        env: {},
        identity: { audience: 'nexuscrew-launch', daemonBootId: 'boot-a', connectionId: 'connection-a' },
      }),
      /daemon-credential/,
    );
  } finally {
    await broker.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('identity_challenge_travels_only_in_socket_payload', async () => {
  const home = tmpdir('nc-identity-transport-');
  const auth = authority(path.join(home, 'identity'));
  const broker = createLaunchBroker({
    home,
    identityMode: 'authority',
    identityAuthority: auth,
    identityDaemonCredential: 'daemon-good',
  });
  try {
    const ticket = await broker.issue({
      command: 'node',
      args: ['-e', 'process.exit(0)'],
      env: { PATH: '/usr/bin' },
      identity: { audience: 'nexuscrew-launch', daemonBootId: 'boot-a', connectionId: 'connection-a' },
    });
    assert.equal(ticket.challenge, undefined, 'issue() non deve restituire la challenge al chiamante');
    const payload = await readPayload(ticket.socketPath, ticket.nonce);
    assert.ok(payload.identity);
    assert.match(payload.identity.challenge, /^[a-f0-9]{64}$/);
    assert.equal(payload.identity.audience, 'nexuscrew-launch');
    assert.equal(payload.identity.daemonBootId, 'boot-a');
    assert.equal(payload.identity.connectionId, 'connection-a');
    assert.deepEqual(Object.keys(payload.identity).sort(), ['audience', 'challenge', 'connectionId', 'daemonBootId', 'expiresAt', 'issuedAt']);
    const nonPayload = JSON.stringify([payload.command, ...payload.args, payload.env]);
    assert.ok(!nonPayload.includes(payload.identity.challenge), 'la challenge non deve viaggiare in argv/env');
  } finally {
    await broker.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('legacy_launch_without_authority_unchanged', async () => {
  const home = tmpdir('nc-identity-transport-legacy-');
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
