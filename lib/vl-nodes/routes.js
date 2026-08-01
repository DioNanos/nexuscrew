'use strict';

const express = require('express');
const { bearerFrom } = require('../auth/middleware.js');
const store = require('./store.js');
const { PROTOCOL, MAX_WAIT_MS } = require('./broker.js');

const OWNER_ID_RE = /^[a-f0-9]{16,64}$/;
const SIMPLE_COMMANDS = new Set([
  'status', 'health', 'start', 'stop', 'restart', 'version', 'capabilities', 'unpair',
]);
const MAX_CANDIDATE_BYTES = 2_621_440;

function commandOf(body) {
  if (!body || typeof body.kind !== 'string') return null;
  if (SIMPLE_COMMANDS.has(body.kind)) {
    if (body.args !== undefined && (typeof body.args !== 'object' || body.args === null
      || Array.isArray(body.args) || Object.keys(body.args).length > 0)) return null;
    return { kind: body.kind, args: {} };
  }
  if (body.kind === 'logs') {
    const limit = body.args && body.args.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
    return { kind: 'logs', args: { limit } };
  }
  if (body.kind === 'update_candidate') {
    const args = body.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    const keys = Object.keys(args).sort();
    if (keys.join(',') !== 'sha256,size,url,version') return null;
    if (typeof args.url !== 'string' || args.url.length > 2048) return null;
    let parsed;
    try { parsed = new URL(args.url); } catch (_) { return null; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    if (!/^[a-f0-9]{64}$/.test(String(args.sha256 || ''))) return null;
    if (!Number.isSafeInteger(args.size) || args.size < 1 || args.size > MAX_CANDIDATE_BYTES) return null;
    if (typeof args.version !== 'string' || !/^[A-Za-z0-9._+-]{1,64}$/.test(args.version)) return null;
    return {
      kind: body.kind,
      args: { url: parsed.toString(), sha256: args.sha256, size: args.size, version: args.version },
    };
  }
  return null;
}

function nodeToken(req) {
  const token = bearerFrom(req);
  return store.TOKEN_RE.test(String(token || '')) ? token : null;
}

function publicRoutes({ storePath, broker, ownerId }) {
  const r = express.Router();
  const body = express.json({ limit: '20kb' });

  r.post('/pair', body, (req, res) => {
    const localOwner = ownerId();
    if (!OWNER_ID_RE.test(String(localOwner || ''))) return res.status(503).json({ error: 'owner identity unavailable' });
    if (!req.body || req.body.protocol !== PROTOCOL) return res.status(400).json({ error: 'unsupported protocol' });
    const invite = req.get('x-vl-invite');
    const paired = store.pairNode(storePath, {
      invite,
      nodeId: req.body.nodeId,
      label: req.body.label,
    });
    if (!paired.ok) {
      const status = paired.code === 'node-exists' ? 409
        : paired.code === 'invite-expired-or-used' ? 410 : 400;
      return res.status(status).json({ error: paired.code });
    }
    return res.status(201).json({
      protocol: PROTOCOL,
      ownerId: localOwner,
      nodeId: paired.node.nodeId,
      label: paired.node.label,
      token: paired.token,
      pollMaxMs: MAX_WAIT_MS,
    });
  });

  r.post('/poll', body, async (req, res) => {
    const token = nodeToken(req);
    const node = token && store.authenticate(storePath, token);
    if (!node || req.body?.nodeId !== node.nodeId) return res.status(401).json({ error: 'unauthorized-node' });
    const abort = new AbortController();
    req.once('aborted', () => abort.abort());
    const result = await broker.poll(node, req.body, {
      waitMs: Number(req.get('x-vl-wait-ms')) || MAX_WAIT_MS,
      signal: abort.signal,
    });
    if (res.headersSent || res.destroyed) return undefined;
    if (result.type === 'command') return res.json({ protocol: PROTOCOL, command: result.command });
    if (result.type === 'idle' || result.type === 'aborted' || result.type === 'acknowledged') {
      return res.status(204).end();
    }
    if (result.type === 'superseded') return res.status(409).json({ error: 'stale-session', generation: result.generation });
    if (result.type === 'revoked') return res.status(401).json({ error: 'unpaired' });
    return res.status(400).json({ error: result.code || 'invalid-heartbeat' });
  });

  r.post('/unpair', body, (req, res) => {
    const token = nodeToken(req);
    const node = token && store.authenticate(storePath, token);
    if (!node || req.body?.nodeId !== node.nodeId || req.body?.protocol !== PROTOCOL) {
      return res.status(401).json({ error: 'unauthorized-node' });
    }
    store.removeNode(storePath, node.nodeId);
    broker.forget(node.nodeId);
    return res.status(204).end();
  });

  return r;
}

function apiRoutes({ storePath, broker, ownerId, readonly = () => false }) {
  const r = express.Router();

  r.get('/', (_req, res) => {
    const localOwner = ownerId();
    if (!OWNER_ID_RE.test(String(localOwner || ''))) return res.status(503).json({ error: 'owner identity unavailable' });
    const nodes = broker.list(store.listNodes(storePath)).map((node) => ({
      ...node,
      id: `${localOwner}:VL-${node.nodeId}`,
      instanceId: localOwner,
      cell: `VL-${node.nodeId.slice(0, 8)}`,
      canReceive: false,
      canManage: node.online === true,
    }));
    return res.json({ instanceId: localOwner, protocol: PROTOCOL, nodes });
  });

  r.post('/invite', express.json({ limit: '4kb' }), (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: invite blocked' });
    const localOwner = ownerId();
    if (!OWNER_ID_RE.test(String(localOwner || ''))) return res.status(503).json({ error: 'owner identity unavailable' });
    const ttlSeconds = req.body?.ttlSeconds === undefined ? undefined : Number(req.body.ttlSeconds);
    if (ttlSeconds !== undefined && (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 3600)) {
      return res.status(400).json({ error: 'ttlSeconds must be 30..3600' });
    }
    const invite = store.createInvite(storePath, {
      label: req.body?.label,
      ...(ttlSeconds === undefined ? {} : { ttlMs: ttlSeconds * 1000 }),
    });
    return res.status(201).json({ protocol: PROTOCOL, ownerId: localOwner, ...invite });
  });

  r.post('/:nodeId/commands', express.json({ limit: '8kb' }), (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: command blocked' });
    if (!store.NODE_ID_RE.test(String(req.params.nodeId || ''))
      || !store.listNodes(storePath).some((node) => node.nodeId === req.params.nodeId)) {
      return res.status(404).json({ error: 'node not paired' });
    }
    const command = commandOf(req.body);
    if (!command) return res.status(400).json({ error: 'invalid bounded command' });
    const result = broker.dispatch(req.params.nodeId, command);
    if (!result.ok) {
      const status = result.code === 'node-offline' || result.code === 'command-in-flight' ? 409 : 400;
      return res.status(status).json({ error: result.code });
    }
    return res.status(202).json({
      id: result.id,
      status: result.status,
      note: 'submitted confirms delivery to a live poll only; completion requires the node ack',
    });
  });

  r.delete('/:nodeId', (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: revoke blocked' });
    if (!store.removeNode(storePath, req.params.nodeId)) return res.status(404).json({ error: 'node not paired' });
    broker.forget(req.params.nodeId);
    return res.status(204).end();
  });

  r.use((error, _req, res, _next) => {
    if (error && (error.type === 'entity.too.large' || error.status === 413)) {
      return res.status(413).json({ error: 'body too large' });
    }
    if (error instanceof SyntaxError) return res.status(400).json({ error: 'invalid JSON' });
    return res.status(400).json({ error: String(error?.message || error) });
  });

  return r;
}

module.exports = {
  OWNER_ID_RE,
  SIMPLE_COMMANDS,
  MAX_CANDIDATE_BYTES,
  commandOf,
  publicRoutes,
  apiRoutes,
};
