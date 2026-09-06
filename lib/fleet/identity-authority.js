'use strict';

// Server-only authority for the identity.v1 launch handshake.  The daemon may
// register a challenge and the TUI may redeem a one-shot launch grant, but the
// HMAC key never leaves this module.  This is deliberately separate from the
// Live lease proof: a lease says that a cell is alive, while this proof binds a
// particular daemon connection to an audience and a challenge.

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { loadOrCreateVerifier } = require('./lease-verifier.js');

const CHALLENGE_TTL_MS = 15_000;
const GRANT_TTL_MS = 60_000;
const NONCE_BYTES = 32;
const DEFAULT_REPLAY_LIMIT = 4096;
const DEFAULT_CHALLENGE_LIMIT = 4096;
const DEFAULT_REVOKE_LIMIT = 4096;

const GRANT_FIELDS = Object.freeze([
  'kind', 'ownerInstanceId', 'cellId', 'audience', 'incarnationId',
  'launchEpoch', 'daemonBootId', 'connectionId', 'challenge', 'nonce',
  'jti', 'issuedAt', 'expiresAt',
]);
const PROOF_FIELDS = Object.freeze([
  ...GRANT_FIELDS.slice(0, 9), 'nonce', 'parentJti', 'jti', 'issuedAt', 'expiresAt', 'generation',
]);

function nonEmpty(value) { return typeof value === 'string' && value.length > 0; }

function present(value) {
  return value !== undefined && value !== null && String(value).length > 0;
}

function hexNonce(randomBytes) {
  return randomBytes(NONCE_BYTES).toString('hex');
}

function canonical(fields, claims) {
  const parts = [];
  for (const field of fields) {
    const value = claims[field];
    if (value === undefined || value === null || String(value).length === 0) {
      throw new Error(`claim mancante: ${field}`);
    }
    const bytes = Buffer.from(String(value), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length, 0);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

function sign(verifier, fields, claims) {
  const proof = crypto.createHmac('sha256', verifier.secret)
    .update(canonical(fields, claims)).digest('hex');
  return { ...claims, proof };
}

function safeEqual(left, right) {
  if (!nonEmpty(left) || !nonEmpty(right)) return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verify(verifier, fields, candidate, { now, expected = {} } = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'malformed' };
  }
  for (const field of fields) if (!present(candidate[field])) return { ok: false, reason: 'malformed' };
  if (!/^[a-f0-9]{64}$/.test(candidate.proof)) return { ok: false, reason: 'malformed' };
  const issuedAt = Number(candidate.issuedAt);
  const expiresAt = Number(candidate.expiresAt);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
    return { ok: false, reason: 'malformed' };
  }
  if (Number(now()) >= expiresAt) return { ok: false, reason: 'expired' };
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && candidate[field] !== value) return { ok: false, reason: field };
  }
  const expectedProof = crypto.createHmac('sha256', verifier.secret)
    .update(canonical(fields, candidate)).digest('hex');
  if (!safeEqual(expectedProof, candidate.proof)) return { ok: false, reason: 'bad-proof' };
  return { ok: true, claims: { ...candidate } };
}

function createIdentityAuthority({
  dir = path.join(os.homedir(), '.nexuscrew', 'identity-authority'),
  fsImpl,
  serviceCredential,
  daemonCredential,
  launcherCredential,
  subjectResolver = () => true,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  maxReplayEntries = DEFAULT_REPLAY_LIMIT,
  maxChallenges = DEFAULT_CHALLENGE_LIMIT,
  maxRevokeEntries = DEFAULT_REVOKE_LIMIT,
  log = () => {},
} = {}) {
  const legacyCredential = nonEmpty(serviceCredential) ? serviceCredential : null;
  const daemonSecret = daemonCredential || legacyCredential;
  const launcherSecret = launcherCredential || legacyCredential;
  if (!nonEmpty(daemonSecret) || !nonEmpty(launcherSecret)) {
    throw new Error('identity authority: daemon e launcher credential obbligatorie');
  }
  if ((daemonCredential || launcherCredential) && safeEqual(daemonSecret, launcherSecret)) {
    throw new Error('identity authority: daemon e launcher credential devono essere distinte');
  }
  if (typeof subjectResolver !== 'function') throw new Error('identity authority: subject resolver non valido');
  if (!Number.isSafeInteger(maxReplayEntries) || maxReplayEntries < 1) {
    throw new Error('identity authority: replay limit non valido');
  }
  if (!Number.isSafeInteger(maxChallenges) || maxChallenges < 1) {
    throw new Error('identity authority: challenge limit non valido');
  }
  if (!Number.isSafeInteger(maxRevokeEntries) || maxRevokeEntries < 1) {
    throw new Error('identity authority: revoke limit non valido');
  }
  // `fsImpl` is injectable only for tests; production always uses the real
  // filesystem and the dedicated 0600 key managed by lease-verifier.js.
  const verifier = loadOrCreateVerifier({ dir, ...(fsImpl ? { fsImpl } : {}), log });
  // Fresh per authority incarnation and never persisted: a restart of the
  // authority changes it, so every proof issued before the restart fails
  // closed instead of surviving with the persisted HMAC key.
  const generation = hexNonce(randomBytes);
  const challenges = new Map();
  // Bounded stores: every entry carries its own expiry, saturated stores
  // reject instead of evicting valid entries, and only expired entries are
  // collected on the next operation that touches the store.
  const replay = new Map();
  const revoked = new Map();

  function sweepExpired() {
    const tick = Number(now());
    for (const [challenge, record] of challenges) {
      if (tick >= record.expiresAt) challenges.delete(challenge);
    }
    for (const [value, expiresAt] of replay) {
      if (tick >= expiresAt) replay.delete(value);
    }
    for (const [jti, expiresAt] of revoked) {
      if (tick >= expiresAt) revoked.delete(jti);
    }
  }

  function credentialMatches(candidate, expected) { return safeEqual(expected, candidate); }

  function validConnection(args) {
    return ['audience', 'daemonBootId', 'connectionId']
      .every((field) => nonEmpty(args && args[field]));
  }

  function validSubject(args) {
    return ['ownerInstanceId', 'cellId', 'incarnationId', 'launchEpoch']
      .every((field) => nonEmpty(args && args[field]));
  }

  const strictCredentials = !!(daemonCredential || launcherCredential);

  function reserveReplay(value, expiresAt) {
    sweepExpired();
    if (replay.has(value)) return { ok: false, reason: 'replay' };
    if (replay.size >= maxReplayEntries) return { ok: false, reason: 'replay-store-full' };
    replay.set(value, expiresAt);
    return { ok: true };
  }

  function registerDaemonChallenge(args = {}) {
    const credential = args.daemonCredential || args.serviceCredential;
    if (!credentialMatches(credential, daemonSecret)) {
      return { ok: false, reason: strictCredentials ? 'daemon-credential' : 'service-credential' };
    }
    if (!validConnection(args)) return { ok: false, reason: 'claims' };
    sweepExpired();
    if (challenges.size >= maxChallenges) return { ok: false, reason: 'challenge-store-full' };
    const issuedAt = Number(now());
    const challenge = hexNonce(randomBytes);
    const record = {
      challenge,
      audience: args.audience,
      daemonBootId: args.daemonBootId,
      connectionId: args.connectionId,
      issuedAt,
      expiresAt: issuedAt + CHALLENGE_TTL_MS,
      used: false,
    };
    challenges.set(challenge, record);
    return { ok: true, challenge, issuedAt, expiresAt: record.expiresAt };
  }

  function issueLaunchGrant(args = {}) {
    const credential = args.launcherCredential || args.serviceCredential || args.daemonCredential;
    if (!credentialMatches(credential, launcherSecret)
      || (strictCredentials && !args.launcherCredential)) return { ok: false, reason: 'launcher-credential' };
    const record = challenges.get(args.challenge);
    if (!record) return { ok: false, reason: 'challenge' };
    if (record.used) return { ok: false, reason: 'challenge-replay' };
    if (Number(now()) >= record.expiresAt) return { ok: false, reason: 'challenge' };
    const subject = args.subject || (strictCredentials ? null : args);
    if (!validSubject(subject) || (strictCredentials && subjectResolver(subject) !== true)) {
      return { ok: false, reason: 'subject' };
    }
    if (!validConnection(record)) return { ok: false, reason: 'claims' };
    for (const field of ['audience', 'daemonBootId', 'connectionId']) {
      if (args[field] !== undefined && args[field] !== record[field]) return { ok: false, reason: field };
    }
    const issuedAt = Number(now());
    const claims = {
      kind: 'launch-grant', ...Object.fromEntries([
        'ownerInstanceId', 'cellId', 'incarnationId', 'launchEpoch',
      ].map((field) => [field, subject[field]])
        .concat(['audience', 'daemonBootId', 'connectionId']
          .map((field) => [field, record[field]]))),
      challenge: record.challenge,
      nonce: hexNonce(randomBytes),
      jti: hexNonce(randomBytes),
      issuedAt,
      expiresAt: Math.min(record.expiresAt, issuedAt + GRANT_TTL_MS),
    };
    if (claims.expiresAt <= issuedAt) return { ok: false, reason: 'challenge' };
    return { ok: true, grant: sign(verifier, GRANT_FIELDS, claims) };
  }

  function issueChallengeProof({ launchGrant, challenge } = {}) {
    const checked = verify(verifier, GRANT_FIELDS, launchGrant, { now, expected: { kind: 'launch-grant', challenge } });
    if (!checked.ok) return checked;
    const record = challenges.get(challenge);
    if (!record) return { ok: false, reason: 'challenge' };
    if (record.used) return { ok: false, reason: 'challenge-replay' };
    if (Number(now()) >= record.expiresAt) return { ok: false, reason: 'challenge' };
    for (const field of ['audience', 'daemonBootId', 'connectionId']) {
      if (checked.claims[field] !== record[field]) return { ok: false, reason: field };
    }
    const reserved = reserveReplay(checked.claims.nonce, Number(checked.claims.expiresAt));
    if (!reserved.ok) return { ok: false, reason: reserved.reason };
    record.used = true;
    const issuedAt = Number(now());
    const claims = {
      kind: 'identity-proof', ...Object.fromEntries([
        'ownerInstanceId', 'cellId', 'audience', 'incarnationId',
        'launchEpoch', 'daemonBootId', 'connectionId', 'challenge',
      ].map((field) => [field, checked.claims[field]])),
      nonce: hexNonce(randomBytes),
      parentJti: checked.claims.jti,
      jti: hexNonce(randomBytes),
      issuedAt,
      expiresAt: Math.min(Number(checked.claims.expiresAt), issuedAt + GRANT_TTL_MS),
      generation,
    };
    if (claims.expiresAt <= issuedAt) return { ok: false, reason: 'expired' };
    return { ok: true, proof: sign(verifier, PROOF_FIELDS, claims) };
  }

  function verifyChallengeProof(proof, expected = {}) {
    const checked = verify(verifier, PROOF_FIELDS, proof, { now, expected: { kind: 'identity-proof', ...expected } });
    if (!checked.ok) return checked;
    if (!safeEqual(checked.claims.generation, generation)) return { ok: false, reason: 'generation' };
    if (revoked.has(checked.claims.jti) || revoked.has(checked.claims.parentJti)) {
      return { ok: false, reason: 'revoked' };
    }
    const reserved = reserveReplay(checked.claims.nonce, Number(checked.claims.expiresAt));
    if (!reserved.ok) return { ok: false, reason: reserved.reason };
    return checked;
  }

  function revoke(jti, expiresAt) {
    if (!nonEmpty(jti)) return false;
    sweepExpired();
    const tick = Number(now());
    // Without an explicit horizon a revocation covers the widest proof it
    // can still affect, then it expires like the proofs it invalidates.
    const horizon = Number.isSafeInteger(expiresAt)
      ? expiresAt
      : tick + CHALLENGE_TTL_MS + GRANT_TTL_MS;
    if (tick >= horizon) return false;
    if (!revoked.has(jti) && revoked.size >= maxRevokeEntries) return false;
    revoked.set(jti, Math.max(horizon, revoked.get(jti) || 0));
    return true;
  }

  return {
    registerDaemonChallenge,
    issueLaunchGrant,
    issueChallengeProof,
    verifyChallengeProof,
    revoke,
    constants: Object.freeze({ CHALLENGE_TTL_MS, GRANT_TTL_MS, NONCE_BYTES }),
  };
}

module.exports = {
  createIdentityAuthority,
  CHALLENGE_TTL_MS,
  GRANT_TTL_MS,
  NONCE_BYTES,
};
