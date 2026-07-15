'use strict';
// lib/settings/public-peering-routes.js — public peering surface (the one-time
// invite itself is the capability). Extracted verbatim from
// lib/settings/routes.js (behavior-preserving modularization); routes.js
// re-exports publicPeeringRoutes for backward compatibility.
//
// The route exposes no generic API and creates a scoped peer credential, never
// a UI token. Identity proof does not consume the capability and never receives
// invite/token in clear text: it prevents any HTTP listener on the -L port from
// being mistaken for the node contained in the link.
const os = require('node:os');
const express = require('express');

const nodesStore = require('../nodes/store.js');
const peering = require('../nodes/peering.js');
const { readRoles } = require('../cli/commands.js');
const { configJsonPath } = require('../config.js');

function validPeerName(name) { return typeof name === 'string' && nodesStore.NODE_NAME_RE.test(name); }

function publicPeeringRoutes(deps = {}) {
  const cfg = deps.cfg || {};
  const home = cfg.home || os.homedir();
  const configPath = cfg.configPath || configJsonPath();
  const nodesPath = deps.nodesPath || cfg.nodesPath || nodesStore.defaultNodesPath(home);
  const invitesPath = cfg.invitesPath || peering.defaultInvitesPath(home);
  const pendingPath = cfg.pendingPairingsPath || peering.defaultPendingPath(home);
  const r = express.Router();
  const attempts = new Map();
  r.use(express.json({ limit: '8kb' }));
  // Identity proof non consuma la capability e non riceve mai invite/token in
  // chiaro. Serve a impedire che un qualunque listener HTTP sulla porta -L
  // venga scambiato per il nodo contenuto nel link.
  r.post('/identity', (req, res) => {
    const key = `identity:${String(req.socket && req.socket.remoteAddress || 'local')}`;
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((x) => now - x < 60_000);
    recent.push(now); attempts.set(key, recent);
    if (recent.length > 30) return res.status(429).json({ error: 'troppi tentativi' });
    const b = req.body || {};
    const proof = peering.capabilityIdentity({
      invitesPath, pendingPath, capabilityId: b.capabilityId, challenge: b.challenge, now,
    });
    if (!proof) return res.status(404).json({ error: 'capability non valida' });
    const st = nodesStore.loadStore(nodesPath);
    if (!st || !nodesStore.NODE_ID_RE.test(st.nodeId)) return res.status(503).json({ error: 'identita nodo non disponibile' });
    return res.json({ ok: true, instanceId: st.nodeId, proof });
  });
  r.post('/join', (req, res) => {
    const key = `join:${String(req.socket && req.socket.remoteAddress || 'local')}`;
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((x) => now - x < 60_000);
    recent.push(now); attempts.set(key, recent);
    if (recent.length > 10) return res.status(429).json({ error: 'troppi tentativi di pairing' });
    const b = req.body || {};
    const peerRoles = b.roles === undefined ? null : nodesStore.parseRoles(b.roles);
    if (!nodesStore.validToken(b.invite) || !nodesStore.NODE_ID_RE.test(b.instanceId)
      || !validPeerName(b.name) || !nodesStore.isPort(b.port) || !nodesStore.validToken(b.acceptToken)
      || (b.roles !== undefined && !peerRoles)
      // Pairing is always private. Publishing is a separate authenticated
      // action after the reverse channel is live and health-checked.
      || (b.shared !== undefined && b.shared !== false)) {
      return res.status(400).json({ error: 'pairing request non valida' });
    }
    if (b.label !== undefined && !nodesStore.validLabel(b.label)) {
      return res.status(400).json({ error: 'label non valida' });
    }
    if (!peering.consumeInvite({ invitesPath, invite: b.invite })) return res.status(410).json({ error: 'invito scaduto o gia usato' });
    try {
      const st = nodesStore.loadOrInitStore(nodesPath);
      if (st.nodeId === b.instanceId || st.nodes.some((n) => n.nodeId === b.instanceId)) return res.status(409).json({ error: 'peer duplicato' });
      let name = b.name;
      for (let i = 2; nodesStore.getNode(st, name); i += 1) name = `${b.name.slice(0, 28)}-${i}`;
      const reversePort = peering.allocateReversePort(st.nodes);
      const credential = peering.createPending({ pendingPath, data: {
        name, remotePort: b.port, reversePort, instanceId: b.instanceId, acceptToken: b.acceptToken,
        shared: false,
        label: nodesStore.sanitizeLabel(b.label, name),
        ...(peerRoles ? { roles: { ...peerRoles, node: false }, rolesKnown: true } : { rolesKnown: false }),
      } });
      res.json({ paired: true, instanceId: st.nodeId, reversePort, credential, roles: readRoles(configPath) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  r.post('/confirm', (req, res) => {
    const b = req.body || {};
    if (!nodesStore.validToken(b.credential)) return res.status(400).json({ error: 'confirm non valido' });
    const pending = peering.consumePending({ pendingPath, credential: b.credential });
    if (!pending) {
      const st = nodesStore.loadStore(nodesPath);
      if (st && st.nodes.some((n) => n.acceptToken && peering.safeEqual(n.acceptToken, b.credential))) return res.json({ confirmed: true, idempotent: true });
      return res.status(410).json({ error: 'pairing pending scaduto o gia usato' });
    }
    try {
      let st = nodesStore.loadOrInitStore(nodesPath);
      if (st.nodeId === pending.instanceId || st.nodes.some((n) => n.nodeId === pending.instanceId)) return res.status(409).json({ error: 'peer duplicato' });
      st = nodesStore.addNode(st, {
        name: pending.name, remotePort: pending.remotePort, localPort: pending.reversePort,
        direction: 'inbound', transport: 'inbound', autostart: true,
        visibility: 'network', shared: pending.shared === true, nodeId: pending.instanceId,
        token: pending.acceptToken, acceptToken: b.credential,
        ...(pending.roles ? { roles: pending.roles } : {}),
        rolesKnown: pending.rolesKnown === true,
        ...(pending.label ? { label: pending.label } : {}),
      });
      nodesStore.atomicWriteStore(nodesPath, st);
      res.json({ confirmed: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  r.post('/cancel', (req, res) => {
    const b = req.body || {};
    if (!nodesStore.NODE_ID_RE.test(b.instanceId) || !nodesStore.validToken(b.credential)) return res.status(400).json({ error: 'cancel non valido' });
    try {
      const pending = peering.consumePending({ pendingPath, credential: b.credential });
      if (!pending || pending.instanceId !== b.instanceId) {
        const st = nodesStore.loadStore(nodesPath);
        const peer = st && st.nodes.find((n) => n.nodeId === b.instanceId && n.acceptToken && peering.safeEqual(n.acceptToken, b.credential));
        if (!peer) return res.status(404).json({ error: 'pair non trovato' });
        nodesStore.atomicWriteStore(nodesPath, nodesStore.removeNode(st, peer.name));
      }
      res.json({ cancelled: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  return r;
}

module.exports = { publicPeeringRoutes };
