'use strict';

const { isValidSession } = require('../files/store.js');

const IDENTITY_SCHEMA_VERSION = '1';
const IDENTITY_KINDS = Object.freeze(new Set(['connection-v1', 'thread-v1', 'mcp-v1']));
const IDENTITY_ORIGINS = Object.freeze(new Set(['local_tui', 'remote_live', 'daemon']));
const IDENTITY_CONTEXT_MISSING = 'NEXUSCREW_MCP_IDENTITY_CONTEXT_MISSING';
const IDENTITY_CONTEXT_UNVERIFIED = 'NEXUSCREW_MCP_IDENTITY_CONTEXT_UNVERIFIED';
const IDENTITY_CONTEXT_FROM_MISMATCH = 'NEXUSCREW_MCP_IDENTITY_CONTEXT_FROM_MISMATCH';
const IDENTITY_CONTEXT_AUTHORITY_UNAVAILABLE = 'NEXUSCREW_MCP_IDENTITY_AUTHORITY_UNAVAILABLE';
const IDENTITY_CONTEXT_VERIFIED_ENV_INVALID = 'NEXUSCREW_MCP_IDENTITY_VERIFIED_ENV_INVALID';

function identityContextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredString(value, name, { max = 128 } = {}) {
  if (typeof value !== 'string' || !value.trim() || (max !== null && value.length > max)) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING,
      `contesto identita online: ${name} non valido`);
  }
  return value.trim();
}

function timestamp(value, name) {
  const parsed = Number.isSafeInteger(value) && value >= 0
    ? value
    : (typeof value === 'string' && value.trim() ? Date.parse(value) : NaN);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING,
      `contesto identita online: ${name} non valido`);
  }
  return parsed;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING,
      `contesto identita online: ${name} non valido`);
  }
  return value;
}

function normalizeLiveHost(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING,
      'contesto identita online: liveHost non valido');
  }
  const out = {
    ownerInstanceId: requiredString(raw.ownerInstanceId, 'liveHost.ownerInstanceId'),
    cellId: requiredString(raw.cellId, 'liveHost.cellId'),
    tmuxSession: requiredString(raw.tmuxSession, 'liveHost.tmuxSession'),
    leaseId: requiredString(raw.leaseId, 'liveHost.leaseId'),
    generation: nonNegativeInteger(raw.generation, 'liveHost.generation'),
    epoch: nonNegativeInteger(raw.epoch, 'liveHost.epoch'),
    designation: requiredString(raw.designation, 'liveHost.designation'),
    pairingSessionId: requiredString(raw.pairingSessionId, 'liveHost.pairingSessionId'),
  };
  if (!isValidSession(out.tmuxSession) || out.cellId !== out.tmuxSession.slice(6)) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING,
      'contesto identita online: liveHost cella/sessione incoerenti');
  }
  return Object.freeze(out);
}

function normalizeScopes(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING,
      'contesto identita online: scopes non validi');
  }
  const scopes = raw.map((scope) => requiredString(scope, 'scope', { max: 64 }));
  if (new Set(scopes).size !== scopes.length) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING,
      'contesto identita online: scopes duplicati');
  }
  return Object.freeze(scopes);
}

function normalizeIdentityContext(raw, { now = Date.now } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING, 'contesto identita online assente');
  }
  if (raw.verified !== true || raw.mode !== 'shared') {
    throw identityContextError(IDENTITY_CONTEXT_UNVERIFIED,
      'contesto identita online non verificato: binding condiviso rifiutato');
  }
  if (raw.version !== IDENTITY_SCHEMA_VERSION || !IDENTITY_KINDS.has(raw.kind)) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING,
      'contesto identita online: versione o kind non validi');
  }
  if (!IDENTITY_ORIGINS.has(raw.origin)) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING,
      'contesto identita online: origin non valida');
  }
  const ownerInstanceId = requiredString(raw.ownerInstanceId, 'ownerInstanceId');
  const cellId = requiredString(raw.cellId, 'cellId');
  const tmuxSession = requiredString(raw.tmuxSession || raw.session, 'tmuxSession');
  if (!isValidSession(tmuxSession) || cellId !== tmuxSession.slice(6)) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING,
      'contesto identita online: cella/sessione incoerenti');
  }
  const bindingId = requiredString(raw.bindingId, 'bindingId');
  const audience = requiredString(raw.audience, 'audience');
  const connectionId = requiredString(raw.connectionId, 'connectionId');
  if ((raw.kind === 'thread-v1' || raw.kind === 'mcp-v1')) {
    requiredString(raw.threadId, 'threadId');
  }
  const scopes = normalizeScopes(raw.scopes);
  const issuedAt = timestamp(raw.issuedAt, 'issuedAt');
  const notBefore = timestamp(raw.notBefore, 'notBefore');
  const expiresAt = timestamp(raw.expiresAt, 'expiresAt');
  const clock = Number(now());
  if (!Number.isFinite(clock) || notBefore > clock) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING,
      'contesto identita online non ancora valido');
  }
  if (expiresAt <= clock || expiresAt <= issuedAt || notBefore > expiresAt) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING,
      'contesto identita online scaduto o temporalmente incoerente');
  }
  const from = { instanceId: ownerInstanceId, cell: cellId, tmuxSession };
  if (raw.from !== undefined && JSON.stringify(raw.from) !== JSON.stringify(from)) {
    throw identityContextError(IDENTITY_CONTEXT_FROM_MISMATCH,
      'contesto identita online: from discordante rifiutato');
  }
  const context = {
    version: IDENTITY_SCHEMA_VERSION,
    kind: raw.kind,
    verified: true,
    mode: 'shared',
    origin: raw.origin,
    bindingId,
    ownerInstanceId,
    cellId,
    tmuxSession,
    from,
    audience,
    connectionId,
    scopes,
    issuedAt: raw.issuedAt,
    notBefore: raw.notBefore,
    expiresAt: raw.expiresAt,
  };
  if (raw.threadId !== undefined) context.threadId = requiredString(raw.threadId, 'threadId');
  // cwd is intentionally not subject to the short identity-field bound: it is
  // a path claim, while the signed identity fields remain bounded above.
  if (raw.cwd !== undefined) context.cwd = requiredString(raw.cwd, 'cwd', { max: null });
  if (raw.liveHost !== undefined) context.liveHost = normalizeLiveHost(raw.liveHost);
  if (raw.origin === 'remote_live' && !context.liveHost) {
    throw identityContextError(IDENTITY_CONTEXT_MISSING,
      'contesto identita online: liveHost obbligatorio per remote_live');
  }
  return Object.freeze(context);
}

module.exports = {
  IDENTITY_SCHEMA_VERSION,
  IDENTITY_KINDS,
  IDENTITY_ORIGINS,
  IDENTITY_CONTEXT_MISSING,
  IDENTITY_CONTEXT_UNVERIFIED,
  IDENTITY_CONTEXT_FROM_MISMATCH,
  IDENTITY_CONTEXT_AUTHORITY_UNAVAILABLE,
  IDENTITY_CONTEXT_VERIFIED_ENV_INVALID,
  identityContextError,
  normalizeIdentityContext,
};
