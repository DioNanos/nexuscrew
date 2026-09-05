'use strict';

function issueIdentityChallenge({
  identityAuthority,
  daemonCredential,
  audience,
  daemonBootId,
  connectionId,
} = {}) {
  if (!identityAuthority || typeof identityAuthority.registerDaemonChallenge !== 'function') {
    return { ok: false, reason: 'identity-authority' };
  }
  const out = identityAuthority.registerDaemonChallenge({
    daemonCredential,
    audience,
    daemonBootId,
    connectionId,
  });
  if (!out.ok) return out;
  return { challenge: out.challenge, issuedAt: out.issuedAt, expiresAt: out.expiresAt };
}

function issueLaunchIdentity({
  identityAuthority,
  daemonCredential,
  launcherCredential,
  audience,
  daemonBootId,
  connectionId,
  subject,
} = {}) {
  const challenge = issueIdentityChallenge({
    identityAuthority,
    daemonCredential,
    audience,
    daemonBootId,
    connectionId,
  });
  if (!challenge || !challenge.challenge) {
    return { ok: false, reason: challenge && challenge.reason ? challenge.reason : 'challenge' };
  }
  const grant = identityAuthority.issueLaunchGrant({
    launcherCredential,
    challenge: challenge.challenge,
    subject,
  });
  if (!grant || !grant.ok) {
    return { ok: false, reason: grant && grant.reason ? grant.reason : 'grant' };
  }
  const proof = identityAuthority.issueChallengeProof({
    launchGrant: grant.grant,
    challenge: challenge.challenge,
  });
  if (!proof || !proof.ok) {
    return { ok: false, reason: proof && proof.reason ? proof.reason : 'proof' };
  }
  return {
    ok: true,
    audience,
    daemonBootId,
    connectionId,
    challenge: challenge.challenge,
    grant: grant.grant,
    proof: proof.proof,
  };
}

module.exports = { issueIdentityChallenge, issueLaunchIdentity };
