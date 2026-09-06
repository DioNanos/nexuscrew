'use strict';

const express = require('express');
const { createRateLimiter } = require('../notify/routes.js');
const { tmuxSessionForCell } = require('../fleet/definitions.js');

const RATE_MAX = 10;
const RATE_WINDOW_MS = 60 * 1000;

function parseTimestamp(val) {
  if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 0) return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;
    if (/^[0-9]+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isSafeInteger(num) && num >= 0) return num;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function resolveInstanceId(instanceId) {
  return typeof instanceId === 'function' ? instanceId() : instanceId;
}

function identityRoutes({
  fleetP = null,
  identityAuthority = null,
  identityMode = 'legacy',
  instanceId = null,
  daemonCredential = null,
  launcherCredential = null,
  serviceCredential = null,
  rateCfg = {},
  now = Date.now,
  log = () => {},
} = {}) {
  const router = express.Router();
  const smallJson = express.json({ limit: '8kb' });
  const limiter = createRateLimiter({
    max: rateCfg.max || RATE_MAX,
    windowMs: rateCfg.windowMs || RATE_WINDOW_MS,
    now,
  });

  const ALLOWED_BODY_KEYS = new Set(['proof', 'challenge']);
  const REQUIRED_CHALLENGE_KEYS = [
    'version', 'connectionId', 'daemonBootId', 'audience', 'nonce', 'issuedAt', 'expiresAt',
  ];

  router.post('/challenge-proof', smallJson, async (req, res) => {
    // 1. Validazione base del corpo richiesta
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'corpo della richiesta non valido', code: 'IDENTITY_UNVERIFIED' });
    }

    // Schema chiuso sul body
    const bodyKeys = Object.keys(req.body);
    for (const key of bodyKeys) {
      if (!ALLOWED_BODY_KEYS.has(key)) {
        return res.status(400).json({ error: `campo non consentito nel body: ${key}`, code: 'IDENTITY_UNVERIFIED' });
      }
    }

    const { proof: cellProof, challenge } = req.body;
    if (!cellProof || typeof cellProof !== 'object' || Array.isArray(cellProof)) {
      return res.status(400).json({ error: 'proof di cella mancante o non valido', code: 'IDENTITY_UNVERIFIED' });
    }

    if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)) {
      return res.status(400).json({ error: 'challenge mancante o non valida', code: 'AUDIENCE_MISMATCH' });
    }

    // Schema chiuso sui campi della challenge
    const challengeKeys = Object.keys(challenge);
    for (const key of challengeKeys) {
      if (!REQUIRED_CHALLENGE_KEYS.includes(key)) {
        return res.status(400).json({ error: `campo non consentito nella challenge: ${key}`, code: 'AUDIENCE_MISMATCH' });
      }
    }

    for (const key of REQUIRED_CHALLENGE_KEYS) {
      if (challenge[key] === undefined || challenge[key] === null || String(challenge[key]).trim().length === 0) {
        return res.status(400).json({ error: `campo challenge mancante: ${key}`, code: 'AUDIENCE_MISMATCH' });
      }
    }

    // Validazione versione challenge
    if (String(challenge.version) !== '1') {
      return res.status(400).json({ error: 'versione challenge non supportata', code: 'AUDIENCE_MISMATCH' });
    }

    // Validazione audience: formato fisso daemon/<connectionId>
    const expectedAudience = `daemon/${challenge.connectionId}`;
    if (challenge.audience !== expectedAudience) {
      return res.status(400).json({ error: 'audience non conforme a daemon/<connectionId>', code: 'AUDIENCE_MISMATCH' });
    }

    // Validazione timestamp della challenge
    const challengeIssuedAt = parseTimestamp(challenge.issuedAt);
    const challengeExpiresAt = parseTimestamp(challenge.expiresAt);
    if (challengeIssuedAt === null || challengeExpiresAt === null || challengeExpiresAt <= challengeIssuedAt) {
      return res.status(400).json({ error: 'timestamp challenge non validi', code: 'AUDIENCE_MISMATCH' });
    }

    const currentTick = Number(now());
    if (currentTick >= challengeExpiresAt) {
      return res.status(410).json({ error: 'challenge scaduta', code: 'EXPIRED' });
    }

    // 2. Rate limiting per sessione
    const declaredSession = typeof cellProof.cellId === 'string' && cellProof.cellId
      ? cellProof.cellId : 'default';
    if (!limiter.allow(declaredSession)) {
      return res.status(429).json({ error: 'rate limit superato per la sessione', code: 'RATE_LIMIT_EXCEEDED' });
    }

    // 3. Verifica modalità e disponibilità authority
    if (identityMode !== 'authority') {
      return res.status(503).json({ error: 'identity authority non attiva su questo nodo', code: 'AUTHORITY_UNAVAILABLE' });
    }

    let fleet = null;
    try {
      fleet = fleetP ? await fleetP : null;
    } catch (_) {
      return res.status(503).json({ error: 'servizio fleet non disponibile', code: 'AUTHORITY_UNAVAILABLE' });
    }

    const authority = identityAuthority || (fleet && fleet.identityAuthority);
    if (!authority || typeof authority.issueChallengeProof !== 'function') {
      return res.status(503).json({ error: 'identity authority non disponibile', code: 'AUTHORITY_UNAVAILABLE' });
    }

    // 4. Introspezione rigorosa del proof di cella
    let verifiedCellId = null;
    let verifiedIncarnationId = null;
    let verifiedOwnerInstanceId = null;
    let verifiedLaunchEpoch = null;
    let cellExpiresAt = null;

    if (cellProof.kind === 'child') {
      if (!fleet || !fleet.lease || typeof fleet.lease.childIntrospect !== 'function') {
        return res.status(503).json({ error: 'lease manager non disponibile', code: 'AUTHORITY_UNAVAILABLE' });
      }
      const intro = fleet.lease.childIntrospect(cellProof);
      if (intro.status === 'expired') {
        return res.status(410).json({ error: 'proof di cella scaduto', code: 'EXPIRED' });
      }
      if (intro.status !== 'live' || intro.identityMode !== 'authority') {
        return res.status(403).json({ error: `proof di cella non verificato (${intro.reason || intro.status})`, code: 'IDENTITY_UNVERIFIED' });
      }
      verifiedCellId = intro.cellId;
      verifiedIncarnationId = intro.incarnationId;
      cellExpiresAt = Number(intro.expiresAt);
      verifiedOwnerInstanceId = resolveInstanceId(instanceId) || intro.instanceId || 'owner';
      verifiedLaunchEpoch = String(cellProof.launchEpoch || intro.issuedAt || 'epoch');
    } else if (cellProof.kind === 'identity-proof') {
      const checked = authority.verifyChallengeProof(cellProof);
      if (!checked.ok) {
        if (checked.reason === 'expired') {
          return res.status(410).json({ error: 'proof di cella scaduto', code: 'EXPIRED' });
        }
        return res.status(403).json({ error: `proof di cella non verificato (${checked.reason})`, code: 'IDENTITY_UNVERIFIED' });
      }
      verifiedCellId = checked.claims.cellId;
      verifiedIncarnationId = checked.claims.incarnationId;
      cellExpiresAt = Number(checked.claims.expiresAt);
      verifiedOwnerInstanceId = resolveInstanceId(instanceId) || checked.claims.ownerInstanceId || 'owner';
      verifiedLaunchEpoch = String(checked.claims.launchEpoch || 'epoch');
    } else {
      return res.status(403).json({ error: 'tipo di proof di cella non riconosciuto', code: 'IDENTITY_UNVERIFIED' });
    }

    if (!Number.isSafeInteger(cellExpiresAt) || currentTick >= cellExpiresAt) {
      return res.status(410).json({ error: 'lease di cella scaduto', code: 'EXPIRED' });
    }

    const effectiveExpiresAt = Math.min(challengeExpiresAt, cellExpiresAt);
    if (effectiveExpiresAt <= currentTick) {
      return res.status(410).json({ error: 'scadenza calcolata non valida o gia trascorsa', code: 'EXPIRED' });
    }

    // 5. Anti-Replay: il nonce della challenge deve essere monouso
    if (typeof authority.reserveReplay === 'function') {
      const replayOutcome = authority.reserveReplay(`challenge:${challenge.nonce}`, effectiveExpiresAt);
      if (!replayOutcome.ok) {
        return res.status(409).json({ error: 'challenge nonce gia utilizzato (replay)', code: 'REPLAY' });
      }
    }

    // 6. Emissione del challenge-proof connection-v1
    const subject = {
      ownerInstanceId: verifiedOwnerInstanceId,
      cellId: verifiedCellId,
      tmuxSession: tmuxSessionForCell(verifiedCellId),
      incarnationId: verifiedIncarnationId,
      launchEpoch: verifiedLaunchEpoch,
    };

    let issued;
    if (typeof authority.issueConnectionProof === 'function') {
      issued = authority.issueConnectionProof({
        subject,
        challenge,
        daemonCredential,
        launcherCredential,
        serviceCredential,
        expiresAt: effectiveExpiresAt,
      });
    } else {
      const challengeKey = challenge.nonce || challenge.connectionId;
      const reg = authority.registerDaemonChallenge({
        daemonCredential: daemonCredential || serviceCredential,
        audience: challenge.audience,
        daemonBootId: challenge.daemonBootId,
        connectionId: challenge.connectionId,
        challenge: challengeKey,
        expiresAt: effectiveExpiresAt,
      });
      if (!reg.ok) {
        return res.status(503).json({ error: `registrazione challenge fallita (${reg.reason})`, code: 'AUTHORITY_UNAVAILABLE' });
      }
      const grant = authority.issueLaunchGrant({
        launcherCredential: launcherCredential || serviceCredential,
        challenge: challengeKey,
        subject,
        audience: challenge.audience,
        daemonBootId: challenge.daemonBootId,
        connectionId: challenge.connectionId,
      });
      if (!grant.ok) {
        return res.status(503).json({ error: `emissione grant fallita (${grant.reason})`, code: 'AUTHORITY_UNAVAILABLE' });
      }
      issued = authority.issueChallengeProof({
        launchGrant: grant.grant,
        challenge: challengeKey,
        nonce: challenge.nonce,
        expiresAt: effectiveExpiresAt,
      });
    }

    if (!issued || !issued.ok) {
      const reason = issued && issued.reason;
      if (reason === 'replay' || reason === 'challenge-replay') {
        return res.status(409).json({ error: 'challenge gia utilizzata', code: 'REPLAY' });
      }
      if (reason === 'expired') {
        return res.status(410).json({ error: 'challenge o grant scaduto', code: 'EXPIRED' });
      }
      return res.status(503).json({ error: `emissione challenge proof fallita (${reason || 'ignota'})`, code: 'AUTHORITY_UNAVAILABLE' });
    }

    // Log senza segreti né digest sensibili
    log(`identity-routes: challenge-proof emesso per cella ${verifiedCellId} (conn: ${challenge.connectionId})`);

    return res.status(200).json({
      ok: true,
      proof: issued.proof,
    });
  });

  router.use((err, _req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(413).json({ error: 'payload troppo grande', code: 'PAYLOAD_TOO_LARGE' });
    }
    next(err);
  });

  return router;
}

module.exports = { identityRoutes, RATE_MAX, RATE_WINDOW_MS };
