'use strict';
// Canale produttivo del contesto shared per il bridge MCP.
//
// Il proof child authority-backed, ottenuto da register/refresh in authority
// mode, viene persistito accanto al token in una directory privata del nodo:
// quello è l'unico canale condiviso fra i processi della cella (contratto:
// nessun isolamento fra processi dello stesso UID). L'env seleziona il FILE
// del canale ma mai l'identità: questa arriva soltanto dal proof firmato,
// verificato online dall'hub a ogni introspezione. Senza canale non esiste
// provider e il bridge resta sul percorso embedded legacy.

const fs = require('node:fs');
const path = require('node:path');
const { readTokenSafe } = require('../auth/token.js');
const { cellIdFromTmuxSession, tmuxSessionForCell } = require('../fleet/definitions.js');
const {
  identityContextError, IDENTITY_CONTEXT_AUTHORITY_UNAVAILABLE,
  IDENTITY_CONTEXT_VERIFIED_ENV_INVALID,
} = require('./identity-schema.js');

const INTROSPECT_TIMEOUT_MS = 8000;

function identityChannelDir(tokenPath) {
  return path.join(path.dirname(tokenPath), 'mcp-identity');
}

function identityChannelPath({ tokenPath, session }) {
  return path.join(identityChannelDir(tokenPath), `${session}.json`);
}

// i metadati verified consegnati dal launcher VL al figlio MCP
// (solo su sessione bound). La fonte e' PRESENTE se la version key esiste:
// presence parziale o valori incompleti = fonte invalida (fail-closed), mai
// assenza. Nessun valore torna al chiamante: solo coerenza booleana.
const VERIFIED_ENV_VERSION_KEY = 'NEXUSCREW_VERIFIED_ENV_VERSION';
const VERIFIED_ENV_FIELDS = Object.freeze({
  ownerInstanceId: 'NEXUSCREW_VERIFIED_OWNER_INSTANCE_ID',
  cellId: 'NEXUSCREW_VERIFIED_CELL_ID',
  incarnationId: 'NEXUSCREW_VERIFIED_INCARNATION_ID',
  bindingId: 'NEXUSCREW_VERIFIED_BINDING_ID',
  origin: 'NEXUSCREW_VERIFIED_ORIGIN',
  threadId: 'NEXUSCREW_VERIFIED_THREAD_ID',
});

function readVerifiedEnv(env) {
  const raw = env && env[VERIFIED_ENV_VERSION_KEY];
  if (typeof raw !== 'string') return null; // del tutto assente -> percorso legacy
  const fields = {};
  for (const [key, name] of Object.entries(VERIFIED_ENV_FIELDS)) {
    const value = env[name];
    fields[key] = typeof value === 'string' && value.trim() ? value.trim() : null;
  }
  return { present: true, version: raw.trim(), ...fields };
}

function verifiedEnvFault(verified, { localInstanceId } = {}) {
  if (verified.version !== '1') return 'version';
  if (!verified.ownerInstanceId) return 'owner';
  if (localInstanceId && verified.ownerInstanceId !== localInstanceId) return 'owner';
  if (!verified.cellId) return 'cell';
  if (!verified.incarnationId) return 'incarnation';
  return null;
}

function readIdentityChannel(filePath) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { cellId, proof, expiresAt } = raw;
  if (typeof cellId !== 'string' || !cellId || !proof || typeof proof !== 'object'
    || Array.isArray(proof) || !Number.isSafeInteger(expiresAt)) return null;
  return { cellId, proof, expiresAt };
}

function persistIdentityChannel({ tokenPath, session, cellId, proof, expiresAt }) {
  if (!tokenPath || !session || cellIdFromTmuxSession(session) !== cellId) return false;
  const dir = identityChannelDir(tokenPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = identityChannelPath({ tokenPath, session });
  fs.writeFileSync(filePath, `${JSON.stringify({ cellId, proof, expiresAt })}\n`, { mode: 0o600 });
  return true;
}

function sharedContextFromIntrospection(out, now) {
  const issuedAt = Number.isSafeInteger(Number(out.issuedAt)) ? Number(out.issuedAt) : now();
  const incarnationId = typeof out.incarnationId === 'string' ? out.incarnationId : '';
  const tmuxSession = typeof out.tmuxSession === 'string' && out.tmuxSession
    ? out.tmuxSession : tmuxSessionForCell(out.cellId);
  return {
    version: '1',
    kind: 'mcp-v1',
    verified: true,
    mode: 'shared',
    bindingId: `${out.cellId}:${incarnationId}`,
    ownerInstanceId: out.instanceId,
    cellId: out.cellId,
    tmuxSession,
    connectionId: `${out.cellId}:${incarnationId}`,
    threadId: incarnationId,
    origin: 'daemon',
    audience: 'nexuscrew-mcp',
    scopes: ['mcp:tools/call'],
    issuedAt,
    notBefore: issuedAt,
    expiresAt: out.expiresAt,
  };
}

function createMcpIdentityProvider({ config, env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const cfg = config || require('../config.js').loadConfig();
  const tokenPath = cfg && cfg.tokenPath;
  const port = cfg && cfg.port;
  const verified = readVerifiedEnv(env);
  const legacySession = env && env.NEXUSCREW_MCP_SESSION;

  // la fonte verified ha PRECEDENZA ASSOLUTA. Se i metadati verified
  // sono presenti il provider esiste SEMPRE (anche con metadati incompleti):
  // la validazione completa e' per-richiesta e fallisce closed con
  // VERIFIED_ENV_INVALID. Mai un ritorno a null che riaprirebbe il percorso
  // legacy accanto a metadati verified di provenienza non dimostrata.
  let mode = null;
  let channelSession = null;
  if (verified && verified.present) {
    mode = 'verified-env';
    // (c) cellId -> tmuxSession con la stessa mappatura deterministica del
    // launcher (definitions.tmuxSessionForCell): il canale identity di quella
    // sessione e' l'unico archivo condiviso della cella su questo nodo.
    channelSession = verified.cellId ? tmuxSessionForCell(verified.cellId) : null;
  } else if (legacySession) {
    mode = 'legacy-session';
    channelSession = legacySession;
  }
  if (!tokenPath || !Number.isSafeInteger(port) || !mode) return null;
  if (mode === 'legacy-session' && !channelSession) return null;
  // In verified mode un canale sessione non derivabile NON degrada a null:
  // il provider resta in piedi e fallisce closed per-richiesta.
  const channelPath = identityChannelPath({ tokenPath, session: channelSession || '__unverified__' });
  if (mode === 'legacy-session' && !readIdentityChannel(channelPath)) return null;
  const baseUrl = `http://127.0.0.1:${port}`;

  // l'ownerInstanceId dichiarato deve coincidere con l'instanceId
  // locale del nodo. Fonte: config.injectabile (test) oppure nodes.json.
  function localInstanceId() {
    if (typeof cfg.identityOwnerInstanceId === 'string' && cfg.identityOwnerInstanceId) {
      return cfg.identityOwnerInstanceId;
    }
    try {
      const nodesStore = require('../nodes/store.js');
      const nodesPath = cfg.nodesPath
        || nodesStore.defaultNodesPath(cfg.home || require('node:os').homedir());
      const store = nodesStore.loadStore(nodesPath);
      return (store && store.nodeId) || null;
    } catch (_) {
      return null;
    }
  }

  function verifiedFault() {
    const fault = verifiedEnvFault(verified, { localInstanceId: localInstanceId() });
    if (fault) return fault;
    if (!channelSession) return 'cell';
    if (!readIdentityChannel(channelPath)) return 'channel';
    return null;
  }

  async function introspectVerified() {
    const fault = verifiedFault();
    if (fault) {
      throw identityContextError(IDENTITY_CONTEXT_VERIFIED_ENV_INVALID,
        `NEXUSCREW_MCP_IDENTITY_VERIFIED_ENV_INVALID: verified env incoerente (${fault})`);
    }
    let response;
    try {
      const token = readTokenSafe(tokenPath);
      response = await fetchImpl(`${baseUrl}/api/lease/introspect`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ proof: readIdentityChannel(channelPath).proof }),
        signal: AbortSignal.timeout(INTROSPECT_TIMEOUT_MS),
      });
    } catch (_) {
      throw identityContextError(IDENTITY_CONTEXT_AUTHORITY_UNAVAILABLE,
        'NEXUSCREW_MCP_IDENTITY_AUTHORITY_UNAVAILABLE: authority non raggiungibile');
    }
    if (response.status >= 500) {
      throw identityContextError(IDENTITY_CONTEXT_AUTHORITY_UNAVAILABLE,
        'NEXUSCREW_MCP_IDENTITY_AUTHORITY_UNAVAILABLE: authority non raggiungibile');
    }
    if (!response.ok) {
      throw identityContextError(IDENTITY_CONTEXT_VERIFIED_ENV_INVALID,
        'NEXUSCREW_MCP_IDENTITY_VERIFIED_ENV_INVALID: introspezione rifiutata dall\'authority');
    }
    const out = await response.json().catch(() => null);
    const coherent = out && out.status === 'live' && out.identityMode === 'authority'
      && out.cellId === verified.cellId && out.tmuxSession === channelSession
      && typeof out.instanceId === 'string' && out.instanceId === verified.ownerInstanceId
      && Number.isSafeInteger(Number(out.expiresAt)) && Number(out.expiresAt) > now()
      && typeof out.incarnationId === 'string' && out.incarnationId === verified.incarnationId;
    if (!coherent) {
      throw identityContextError(IDENTITY_CONTEXT_VERIFIED_ENV_INVALID,
        'NEXUSCREW_MCP_IDENTITY_VERIFIED_ENV_INVALID: introspezione non coerente coi metadati verified');
    }
    return { context: sharedContextFromIntrospection({ ...out, expiresAt: Number(out.expiresAt) }, now()), proof: readIdentityChannel(channelPath).proof };
  }

  async function introspectLegacy() {
    const channel = readIdentityChannel(channelPath);
    if (!channel) return { verified: false, mode: 'shared' };
    let response;
    try {
      const token = readTokenSafe(tokenPath);
      response = await fetchImpl(`${baseUrl}/api/lease/introspect`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ proof: channel.proof }),
        signal: AbortSignal.timeout(INTROSPECT_TIMEOUT_MS),
      });
    } catch (_) {
      throw identityContextError(IDENTITY_CONTEXT_AUTHORITY_UNAVAILABLE,
        'NEXUSCREW_MCP_IDENTITY_AUTHORITY_UNAVAILABLE: authority non raggiungibile');
    }
    if (response.status >= 500) {
      throw identityContextError(IDENTITY_CONTEXT_AUTHORITY_UNAVAILABLE,
        'NEXUSCREW_MCP_IDENTITY_AUTHORITY_UNAVAILABLE: authority non raggiungibile');
    }
    if (!response.ok) return { verified: false, mode: 'shared' };
    const out = await response.json().catch(() => null);
    if (!out || out.status !== 'live' || out.identityMode !== 'authority'
      || out.cellId !== channel.cellId || typeof out.instanceId !== 'string' || !out.instanceId
      || !Number.isSafeInteger(Number(out.expiresAt)) || Number(out.expiresAt) <= now()
      || typeof out.incarnationId !== 'string' || !out.incarnationId
      || out.incarnationId !== channel.proof.incarnationId) {
      return { verified: false, mode: 'shared' };
    }
    return { context: sharedContextFromIntrospection({ ...out, expiresAt: Number(out.expiresAt) }, now()), proof: channel.proof };
  }

  const introspectChannel = mode === 'verified-env' ? introspectVerified : introspectLegacy;

  async function provider({ tool } = {}) {
    void tool; // il canale lease è per-connessione cella, non per-tool
    const out = await introspectChannel();
    return out.context ? out.context : out;
  }
  // il server espone `source: 'verified-env'` in nc_identity quando la
  // fonte dei metadati e' il launcher verified e non la sessione legacy.
  provider.identitySource = mode === 'verified-env' ? 'verified-env' : 'online';
  provider.currentProof = () => {
    const channel = readIdentityChannel(channelPath);
    return channel ? channel.proof : null;
  };
  return provider;
}

module.exports = {
  createMcpIdentityProvider,
  persistIdentityChannel,
  identityChannelPath,
  readVerifiedEnv,
};
