'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIdentityAuthority } = require('../lib/fleet/identity-authority.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-identity-authority-'));
}

function identityArgs(challenge) {
  return {
    challenge,
    ownerInstanceId: 'owner-a',
    cellId: 'Dev',
    audience: 'codex-vl-app-server',
    incarnationId: 'incarnation-a',
    launchEpoch: 'epoch-a',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
  };
}

test('identity authority: daemon challenge, launch grant and child proof round-trip', () => {
  let now = 100_000;
  const serviceCredential = 'fixture-service-credential';
  const authority = createIdentityAuthority({
    dir: tmpdir(),
    serviceCredential,
    now: () => now,
  });

  const registered = authority.registerDaemonChallenge({
    serviceCredential,
    ownerInstanceId: 'owner-a',
    cellId: 'Dev',
    audience: 'codex-vl-app-server',
    incarnationId: 'incarnation-a',
    launchEpoch: 'epoch-a',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
  });
  assert.equal(registered.ok, true);
  assert.match(registered.challenge, /^[a-f0-9]{64}$/);

  const grant = authority.issueLaunchGrant({
    serviceCredential,
    ...identityArgs(registered.challenge),
  });
  assert.equal(grant.ok, true);
  assert.equal(grant.grant.kind, 'launch-grant');
  assert.equal(grant.grant.challenge, registered.challenge);

  now += 100;
  const proof = authority.issueChallengeProof({
    launchGrant: grant.grant,
    challenge: registered.challenge,
  });
  assert.equal(proof.ok, true);
  assert.equal(proof.proof.kind, 'identity-proof');
  assert.equal(proof.proof.parentJti, grant.grant.jti);
  assert.equal(proof.proof.audience, 'codex-vl-app-server');
  assert.equal(proof.proof.daemonBootId, 'boot-a');
  assert.equal(proof.proof.connectionId, 'connection-a');

  const verified = authority.verifyChallengeProof(proof.proof, {
    audience: 'codex-vl-app-server',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
  });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.claims.cellId, 'Dev');
});

test('identity authority: service credential and challenge binding fail closed', () => {
  const authority = createIdentityAuthority({
    dir: tmpdir(),
    serviceCredential: 'fixture-service-credential',
  });
  const bad = authority.registerDaemonChallenge({
    serviceCredential: 'wrong-credential',
    ...identityArgs('a'.repeat(64)),
  });
  assert.deepEqual(bad, { ok: false, reason: 'service-credential' });

  const good = authority.registerDaemonChallenge({
    serviceCredential: 'fixture-service-credential',
    ...identityArgs('ignored-by-authority'),
  });
  assert.equal(good.ok, true);
  const missing = authority.issueLaunchGrant({
    serviceCredential: 'fixture-service-credential',
    ...identityArgs('b'.repeat(64)),
  });
  assert.deepEqual(missing, { ok: false, reason: 'challenge' });
});

test('identity authority: proof challenge is one-shot and expiry is enforced', () => {
  let now = 200_000;
  const authority = createIdentityAuthority({
    dir: tmpdir(),
    serviceCredential: 'fixture-service-credential',
    now: () => now,
  });
  const registered = authority.registerDaemonChallenge({
    serviceCredential: 'fixture-service-credential',
    ...identityArgs('ignored'),
  });
  const grant = authority.issueLaunchGrant({
    serviceCredential: 'fixture-service-credential',
    ...identityArgs(registered.challenge),
  });
  const first = authority.issueChallengeProof({ launchGrant: grant.grant, challenge: registered.challenge });
  assert.equal(first.ok, true);
  const second = authority.issueChallengeProof({ launchGrant: grant.grant, challenge: registered.challenge });
  assert.deepEqual(second, { ok: false, reason: 'challenge-replay' });

  const check = authority.verifyChallengeProof(first.proof, { audience: 'codex-vl-app-server' });
  assert.equal(check.ok, true);
  const replay = authority.verifyChallengeProof(first.proof, { audience: 'codex-vl-app-server' });
  assert.deepEqual(replay, { ok: false, reason: 'replay' });

  now += 60_001;
  const expired = authority.verifyChallengeProof(first.proof, { audience: 'codex-vl-app-server' });
  assert.deepEqual(expired, { ok: false, reason: 'expired' });
});

function authorityV1(overrides = {}) {
  let now = 100_000;
  const subject = {
    ownerInstanceId: 'owner-a', cellId: 'Dev', incarnationId: 'incarnation-a',
    launchEpoch: 'epoch-a',
  };
  const authority = createIdentityAuthority({
    dir: tmpdir(), daemonCredential: 'daemon-credential',
    launcherCredential: 'launcher-credential', now: () => now,
    subjectResolver: (candidate) => Object.entries(subject)
      .every(([key, value]) => candidate[key] === value),
    ...overrides,
  });
  return { authority, subject, advance: (ms) => { now += ms; } };
}

function registerV1(authority, credential = 'daemon-credential') {
  return authority.registerDaemonChallenge({
    daemonCredential: credential, audience: 'nexuscrew-lease',
    daemonBootId: 'boot-a', connectionId: 'connection-a',
  });
}

test('identity authority: daemon credential cannot choose subject or issue launcher grant', () => {
  const { authority, subject } = authorityV1();
  const challenge = registerV1(authority);
  assert.equal(challenge.ok, true);
  const denied = authority.issueLaunchGrant({
    daemonCredential: 'daemon-credential', challenge: challenge.challenge, subject,
  });
  assert.deepEqual(denied, { ok: false, reason: 'launcher-credential' });
});

test('identity authority: launcher grant is bound to the current server subject', () => {
  const { authority, subject } = authorityV1();
  const challenge = registerV1(authority);
  const missing = authority.issueLaunchGrant({
    launcherCredential: 'launcher-credential', challenge: challenge.challenge,
  });
  assert.deepEqual(missing, { ok: false, reason: 'subject' });
  const foreign = authority.issueLaunchGrant({
    launcherCredential: 'launcher-credential', challenge: challenge.challenge,
    subject: { ...subject, cellId: 'Research' },
  });
  assert.deepEqual(foreign, { ok: false, reason: 'subject' });
  const grant = authority.issueLaunchGrant({
    launcherCredential: 'launcher-credential', challenge: challenge.challenge, subject,
  });
  assert.equal(grant.ok, true);
  assert.equal(grant.grant.cellId, 'Dev');
});
