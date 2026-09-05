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

module.exports = { issueIdentityChallenge };
