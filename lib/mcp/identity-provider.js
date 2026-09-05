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

const INTROSPECT_TIMEOUT_MS = 8000;

function identityChannelDir(tokenPath) {
  return path.join(path.dirname(tokenPath), 'mcp-identity');
}

function identityChannelPath({ tokenPath, session }) {
  return path.join(identityChannelDir(tokenPath), `${session}.json`);
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
  const session = env && env.NEXUSCREW_MCP_SESSION;
  if (!tokenPath || !Number.isSafeInteger(port) || !session) return null;
  const channelPath = identityChannelPath({ tokenPath, session });
  if (!readIdentityChannel(channelPath)) return null;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function introspectChannel() {
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
      return { verified: false, mode: 'shared' };
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

  async function provider({ tool } = {}) {
    void tool; // il canale lease è per-connessione cella, non per-tool
    const out = await introspectChannel();
    return out.context ? out.context : out;
  }
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
};
