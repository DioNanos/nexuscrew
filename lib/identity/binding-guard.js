'use strict';

const { normalizeIdentityContext } = require('../mcp/identity-schema.js');

const IDENTITY_BINDING_HEADER = 'x-nexuscrew-identity-binding';
const IDENTITY_BINDING_MISSING = 'NEXUSCREW_IDENTITY_BINDING_MISSING';
const IDENTITY_BINDING_INVALID = 'NEXUSCREW_IDENTITY_BINDING_INVALID';
const IDENTITY_BINDING_MISMATCH = 'NEXUSCREW_IDENTITY_BINDING_MISMATCH';

function bindingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveInstanceId(instanceId) {
  return typeof instanceId === 'function' ? instanceId() : instanceId;
}

function expectedFromSession(session, instanceId) {
  if (!session) return null;
  return { instanceId: resolveInstanceId(instanceId), tmuxSession: session };
}

// Il proof child firma i timestamp come stringhe decimali (JSON del canale
// persistito). Il contesto shared prodotto dal provider li converte, ma un
// binding che copia il proof deve restare verificabile senza allargare lo
// schema MCP generale: qui si accettano SOLO stringhe decimali intere.
function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function normalizeBindingContext(raw) {
  return {
    ...raw,
    issuedAt: canonicalTimestamp(raw && raw.issuedAt),
    notBefore: canonicalTimestamp(raw && raw.notBefore),
    expiresAt: canonicalTimestamp(raw && raw.expiresAt),
  };
}

function createIdentityBindingGuard({
  fleetP = null, instanceId = null, now = Date.now, sharedRequired = false,
} = {}) {
  async function verify(req, { expected = null, localOnly = true } = {}) {
    const raw = req && req.headers && req.headers[IDENTITY_BINDING_HEADER];
    if (raw === undefined) {
      if (sharedRequired) {
        throw bindingError(IDENTITY_BINDING_MISSING, 'binding identita obbligatorio');
      }
      return null;
    }

    let parsed;
    try { parsed = JSON.parse(String(raw)); } catch (_) {
      throw bindingError(IDENTITY_BINDING_INVALID, 'binding identita non valido');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw bindingError(IDENTITY_BINDING_INVALID, 'binding identita non valido');
    }

    let context;
    try { context = normalizeIdentityContext(normalizeBindingContext(parsed.context), { now }); } catch (_) {
      throw bindingError(IDENTITY_BINDING_INVALID, 'binding identita non valido');
    }

    const proof = parsed.proof;
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
      throw bindingError(IDENTITY_BINDING_INVALID, 'binding identita non valido');
    }

    const localId = resolveInstanceId(instanceId);
    if (localOnly && localId && context.ownerInstanceId !== localId) {
      throw bindingError(IDENTITY_BINDING_MISMATCH, 'binding identita locale atteso');
    }

    if (expected) {
      if (expected.instanceId !== undefined && context.ownerInstanceId !== expected.instanceId) {
        throw bindingError(IDENTITY_BINDING_MISMATCH, 'binding identita nodo discordante');
      }
      if (expected.cell !== undefined && context.cellId !== expected.cell) {
        throw bindingError(IDENTITY_BINDING_MISMATCH, 'binding identita cella discordante');
      }
      if (expected.tmuxSession !== undefined && context.tmuxSession !== expected.tmuxSession) {
        throw bindingError(IDENTITY_BINDING_MISMATCH, 'binding identita sessione discordante');
      }
    }

    let fleet = null;
    try { fleet = await fleetP; } catch (_) { fleet = null; }
    const lease = fleet && fleet.lease;
    if (!lease || typeof lease.childIntrospect !== 'function') {
      throw bindingError(IDENTITY_BINDING_INVALID, 'binding identita non verificabile');
    }

    const out = lease.childIntrospect(proof);
    if (!out || out.status !== 'live' || out.cellId !== context.cellId
      || out.incarnationId !== context.threadId
      || Number(out.expiresAt) !== Number(context.expiresAt)) {
      throw bindingError(IDENTITY_BINDING_INVALID, 'binding identita non valido');
    }

    return context;
  }

  return {
    verify,
    header: IDENTITY_BINDING_HEADER,
    codes: {
      missing: IDENTITY_BINDING_MISSING,
      invalid: IDENTITY_BINDING_INVALID,
      mismatch: IDENTITY_BINDING_MISMATCH,
    },
  };
}

module.exports = {
  IDENTITY_BINDING_HEADER,
  IDENTITY_BINDING_MISSING,
  IDENTITY_BINDING_INVALID,
  IDENTITY_BINDING_MISMATCH,
  bindingError,
  createIdentityBindingGuard,
  expectedFromSession,
  resolveInstanceId,
};
