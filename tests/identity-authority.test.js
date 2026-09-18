'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createIdentityAuthority,
  CHALLENGE_TTL_MS,
  GRANT_TTL_MS,
} = require('../lib/fleet/identity-authority.js');

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

test('identity authority: challenge expiry caps proof and caller extras stay unsigned', () => {
  let now = 125_000;
  const serviceCredential = 'fixture-service-credential';
  const authority = createIdentityAuthority({
    dir: tmpdir(),
    serviceCredential,
    now: () => now,
  });
  const registered = authority.registerDaemonChallenge({
    serviceCredential,
    audience: 'codex-vl-app-server',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
    expiresAt: now + 10_000,
  });
  assert.equal(registered.ok, true);
  const grant = authority.issueLaunchGrant({
    serviceCredential,
    ...identityArgs(registered.challenge),
  });
  assert.equal(grant.ok, true, JSON.stringify(grant));

  const signedGrant = { ...grant.grant, spoofedClaim: 'caller-controlled' };
  const capped = authority.issueChallengeProof({
    launchGrant: signedGrant,
    challenge: registered.challenge,
    expiresAt: now + 30_000,
  });
  assert.equal(capped.ok, true, JSON.stringify(capped));
  assert.equal(capped.proof.expiresAt, registered.expiresAt,
    'a caller expiry after the signed grant must be capped');
  assert.equal('spoofedClaim' in capped.proof, false,
    'a top-level extra on the grant must not become a signed proof claim');

  const secondChallenge = authority.registerDaemonChallenge({
    serviceCredential,
    audience: 'codex-vl-app-server',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
    expiresAt: now + 20_000,
  });
  const secondGrant = authority.issueLaunchGrant({
    serviceCredential,
    ...identityArgs(secondChallenge.challenge),
  });
  const shorter = authority.issueChallengeProof({
    launchGrant: { ...secondGrant.grant, spoofedClaim: 'ignored' },
    challenge: secondChallenge.challenge,
    expiresAt: now + 1_000,
  });
  assert.equal(shorter.ok, true, JSON.stringify(shorter));
  assert.equal(shorter.proof.expiresAt, now + 1_000,
    'a shorter caller expiry is the effective minimum');
});

test('identity authority: an expired registered challenge cannot issue a proof', () => {
  let now = 150_000;
  const serviceCredential = 'fixture-service-credential';
  const authority = createIdentityAuthority({
    dir: tmpdir(),
    serviceCredential,
    now: () => now,
  });
  const registered = authority.registerDaemonChallenge({
    serviceCredential,
    audience: 'codex-vl-app-server',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
    expiresAt: now + 1_000,
  });
  const grant = authority.issueLaunchGrant({
    serviceCredential,
    ...identityArgs(registered.challenge),
  });
  assert.equal(grant.ok, true, JSON.stringify(grant));
  now += 1_001;
  assert.deepEqual(
    authority.issueChallengeProof({ launchGrant: grant.grant, challenge: registered.challenge }),
    { ok: false, reason: 'expired' },
  );
});

test('identity authority: a forged proof is rejected before replay is reserved', () => {
  let now = 175_000;
  const serviceCredential = 'fixture-service-credential';
  const authority = createIdentityAuthority({
    dir: tmpdir(),
    serviceCredential,
    now: () => now,
  });
  const registered = authority.registerDaemonChallenge({
    serviceCredential,
    audience: 'codex-vl-app-server',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
  });
  const grant = authority.issueLaunchGrant({
    serviceCredential,
    ...identityArgs(registered.challenge),
  });
  now += 100;
  const issued = authority.issueChallengeProof({
    launchGrant: grant.grant,
    challenge: registered.challenge,
  });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  const forged = { ...issued.proof, cellId: 'Research' };
  assert.deepEqual(authority.verifyChallengeProof(forged), { ok: false, reason: 'bad-proof' });
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

function authorityFix3() {
  let now = 100_000;
  const subject = {
    ownerInstanceId: 'owner-test', cellId: 'cell-test',
    incarnationId: 'inc-test', launchEpoch: 'epoch-test',
  };
  const challenge = {
    version: 1,
    audience: 'daemon/conn-test',
    daemonBootId: 'boot-test',
    connectionId: 'conn-test',
    nonce: 'registered-nonce',
    issuedAt: 99_000,
    expiresAt: 101_000,
  };
  const authority = createIdentityAuthority({
    dir: tmpdir(),
    daemonCredential: 'fixture-daemon',
    launcherCredential: 'fixture-launcher',
    subjectResolver: (candidate) => Object.entries(subject)
      .every(([field, value]) => candidate[field] === value),
    now: () => now,
  });
  return {
    authority,
    subject,
    challenge,
    issue: (overrides = {}) => authority.issueConnectionProof({
      subject,
      challenge,
      daemonCredential: 'fixture-daemon',
      launcherCredential: 'fixture-launcher',
      ...overrides,
    }),
  };
}

test('identity authority: helper caps issuance at daemon challenge expiry', () => {
  const { issue, challenge } = authorityFix3();
  const issued = issue({ expiresAt: 120_000 });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  assert.equal(issued.proof.expiresAt, challenge.expiresAt,
    'an external expiry cannot extend the daemon challenge');
});

test('identity authority: helper rejects an expired daemon challenge', () => {
  const { issue, challenge } = authorityFix3();
  const issued = issue({ challenge: { ...challenge, expiresAt: 99_999 }, expiresAt: 120_000 });
  assert.deepEqual(issued, { ok: false, reason: 'expired' });
});

test('identity authority: helper requires daemon nonce and bounded expiry input', () => {
  const { issue, challenge } = authorityFix3();
  const missingNonce = issue({ challenge: { ...challenge, nonce: '' } });
  assert.deepEqual(missingNonce, { ok: false, reason: 'challenge' });
  const missingExpiry = issue({ challenge: { ...challenge, expiresAt: undefined } });
  assert.deepEqual(missingExpiry, { ok: false, reason: 'challenge' });
  const invalidExternal = issue({ expiresAt: '120000' });
  assert.deepEqual(invalidExternal, { ok: false, reason: 'challenge' });
  const shorter = issue({ expiresAt: 100_500 });
  assert.equal(shorter.ok, true, JSON.stringify(shorter));
  assert.equal(shorter.proof.expiresAt, 100_500,
    'an external expiry may only shorten the daemon challenge');
});

test('identity authority: redemption nonce must match registered challenge', () => {
  const { authority, subject, challenge } = authorityFix3();
  const registered = authority.registerDaemonChallenge({
    ...challenge, challenge: challenge.nonce, daemonCredential: 'fixture-daemon',
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const grant = authority.issueLaunchGrant({
    subject, challenge: registered.challenge, launcherCredential: 'fixture-launcher',
  });
  assert.equal(grant.ok, true, JSON.stringify(grant));
  const divergent = authority.issueChallengeProof({
    launchGrant: grant.grant, challenge: registered.challenge, nonce: 'unregistered-nonce',
  });
  assert.deepEqual(divergent, { ok: false, reason: 'nonce' });
  const bound = authority.issueChallengeProof({
    launchGrant: grant.grant, challenge: registered.challenge, nonce: challenge.nonce,
  });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  assert.equal(bound.proof.nonce, challenge.nonce);
});

test('identity authority: helper rejects repeated registered challenge issuance', () => {
  const { issue } = authorityFix3();
  const args = { expiresAt: 101_000 };
  const first = issue(args);
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = issue(args);
  assert.deepEqual(second, { ok: false, reason: 'challenge-replay' });
});

test('identity authority: signed subject tampering is rejected and extras do not alter claims', () => {
  const { authority, subject, challenge } = authorityFix3();
  const registered = authority.registerDaemonChallenge({
    ...challenge, challenge: challenge.nonce, daemonCredential: 'fixture-daemon',
  });
  const grant = authority.issueLaunchGrant({
    subject, challenge: registered.challenge, launcherCredential: 'fixture-launcher',
  });
  for (const field of Object.keys(subject)) {
    assert.deepEqual(
      authority.issueChallengeProof({
        launchGrant: { ...grant.grant, [field]: 'spoof' }, challenge: registered.challenge,
      }),
      { ok: false, reason: 'bad-proof' },
    );
  }
  const valid = authority.issueChallengeProof({
    launchGrant: grant.grant, challenge: registered.challenge, cellId: 'spoof',
  });
  assert.equal(valid.ok, true, JSON.stringify(valid));
  for (const field of Object.keys(subject)) assert.equal(valid.proof[field], subject[field]);
});

test('identity authority: duplicate helper challenge cannot bypass first-proof replay', () => {
  const { authority, issue } = authorityFix3();
  const first = issue({ expiresAt: 101_000 });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = issue({ expiresAt: 101_000 });
  assert.deepEqual(second, { ok: false, reason: 'challenge-replay' });
  assert.equal(authority.verifyChallengeProof(first.proof).ok, true);
  assert.deepEqual(
    authority.verifyChallengeProof(first.proof),
    { ok: false, reason: 'replay' },
  );
});

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

test('identity authority: restart fails closed for consumed and revoked proofs', () => {
  let now = 300_000;
  const serviceCredential = 'fixture-service-credential';
  const dir = tmpdir();
  const expected = {
    audience: 'codex-vl-app-server',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
  };

  function issueProof(authority) {
    const registered = authority.registerDaemonChallenge({
      serviceCredential,
      audience: 'codex-vl-app-server',
      daemonBootId: 'boot-a',
      connectionId: 'connection-a',
    });
    assert.equal(registered.ok, true);
    const grant = authority.issueLaunchGrant({
      serviceCredential,
      ...identityArgs(registered.challenge),
    });
    assert.equal(grant.ok, true, JSON.stringify(grant));
    now += 100;
    const proof = authority.issueChallengeProof({
      launchGrant: grant.grant,
      challenge: registered.challenge,
    });
    assert.equal(proof.ok, true, JSON.stringify(proof));
    return proof.proof;
  }

  const first = createIdentityAuthority({ dir, serviceCredential, now: () => now });
  const consumedProof = issueProof(first);
  assert.equal(first.verifyChallengeProof(consumedProof, expected).ok, true);
  const revokedProof = issueProof(first);
  assert.equal(first.revoke(revokedProof.parentJti), true);

  const second = createIdentityAuthority({ dir, serviceCredential, now: () => now });
  const replayAfterRestart = second.verifyChallengeProof(consumedProof, expected);
  assert.equal(replayAfterRestart.ok, false, 'a consumed proof must not survive the restart');
  const revokedAfterRestart = second.verifyChallengeProof(revokedProof, expected);
  assert.equal(revokedAfterRestart.ok, false, 'a revoked proof must not survive the restart');
});

test('identity authority: expired challenges are collected and challenge capacity is enforced', () => {
  let now = 400_000;
  const serviceCredential = 'fixture-service-credential';
  const authority = createIdentityAuthority({
    dir: tmpdir(),
    serviceCredential,
    now: () => now,
    maxChallenges: 2,
  });
  const register = () => authority.registerDaemonChallenge({
    serviceCredential,
    audience: 'codex-vl-app-server',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
  });

  assert.equal(register().ok, true);
  assert.equal(register().ok, true);
  const full = register();
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'challenge-store-full');

  now += CHALLENGE_TTL_MS + 1;
  const afterExpiry = register();
  assert.equal(afterExpiry.ok, true, 'expired challenges must be collected, not evicted');
});

test('identity authority: expired replay entries are collected and replay capacity is enforced', () => {
  let now = 500_000;
  const serviceCredential = 'fixture-service-credential';
  const authority = createIdentityAuthority({
    dir: tmpdir(),
    serviceCredential,
    now: () => now,
    maxReplayEntries: 2,
  });
  const expected = {
    audience: 'codex-vl-app-server',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
  };

  function beginHandshake() {
    const registered = authority.registerDaemonChallenge({
      serviceCredential,
      audience: 'codex-vl-app-server',
      daemonBootId: 'boot-a',
      connectionId: 'connection-a',
    });
    assert.equal(registered.ok, true);
    const grant = authority.issueLaunchGrant({
      serviceCredential,
      ...identityArgs(registered.challenge),
    });
    assert.equal(grant.ok, true, JSON.stringify(grant));
    now += 100;
    return authority.issueChallengeProof({
      launchGrant: grant.grant,
      challenge: registered.challenge,
    });
  }

  const first = beginHandshake();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(authority.verifyChallengeProof(first.proof, expected).ok, true);

  const second = beginHandshake();
  assert.equal(second.ok, false, 'a full replay store must reject instead of evicting');
  assert.equal(second.reason, 'replay-store-full');

  now += CHALLENGE_TTL_MS + 1;
  const third = beginHandshake();
  assert.equal(third.ok, true, 'expired replay entries must be collected, not evicted');
  assert.equal(authority.verifyChallengeProof(third.proof, expected).ok, true);
});

test('identity authority: revocations are bounded and expire with the proofs they cover', () => {
  let now = 600_000;
  const serviceCredential = 'fixture-service-credential';
  const authority = createIdentityAuthority({
    dir: tmpdir(),
    serviceCredential,
    now: () => now,
    maxRevokeEntries: 2,
  });
  const expected = {
    audience: 'codex-vl-app-server',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
  };

  function unconsumedProof() {
    const registered = authority.registerDaemonChallenge({
      serviceCredential,
      audience: 'codex-vl-app-server',
      daemonBootId: 'boot-a',
      connectionId: 'connection-a',
    });
    assert.equal(registered.ok, true);
    const grant = authority.issueLaunchGrant({
      serviceCredential,
      ...identityArgs(registered.challenge),
    });
    assert.equal(grant.ok, true, JSON.stringify(grant));
    now += 100;
    const proof = authority.issueChallengeProof({
      launchGrant: grant.grant,
      challenge: registered.challenge,
    });
    assert.equal(proof.ok, true, JSON.stringify(proof));
    return proof.proof;
  }

  const proof1 = unconsumedProof();
  const proof2 = unconsumedProof();
  const proof3 = unconsumedProof();

  assert.equal(authority.revoke(proof1.parentJti), true);
  assert.equal(authority.revoke(proof2.parentJti), true);
  assert.equal(authority.revoke(proof3.parentJti), false, 'a full revocation store must reject instead of evicting');

  assert.deepEqual(authority.verifyChallengeProof(proof1, expected), { ok: false, reason: 'revoked' });
  assert.deepEqual(authority.verifyChallengeProof(proof2, expected), { ok: false, reason: 'revoked' });
  assert.equal(authority.verifyChallengeProof(proof3, expected).ok, true);

  now += CHALLENGE_TTL_MS + GRANT_TTL_MS + 1;
  assert.equal(authority.revoke(proof3.parentJti), true, 'expired revocations must be collected, not evicted');
  assert.equal(authority.verifyChallengeProof(proof3, expected).ok, false, 'an expired proof stays rejected');
});
