'use strict';
// lib/nodes/health.js — modello di salute federato a 3 dimensioni per i nodi.
//
// Sostituisce il vecchio "inbound sempre up" (lib/server.js) con una valutazione
// onesta che NON mente sul verde:
//
//   transport    — la porta forward locale (127.0.0.1:localPort) risponde.
//                  Per outbound: pidfile del tunnel + probe TCP via /federation/health.
//   auth         — la federation accetta la credenziale del nodo (200 vs 401).
//   reachability — l'API remota risponde con payload (200 vs 5xx/network error).
//
// Inbound: il nodo ricevente NON possiede il lifecycle del peer, ma il reverse
// tunnel espone comunque il peer su localPort. Quindi la salute e' probeable;
// resta managed:false e la UI NON offre il power.
//
// Il probe federation e' costoso (fetch): cache per-processo con TTL, keyed by
// node name, cosi' il poll frequente della UI non re-probe la stessa porta.

const nodesTunnel = require('./tunnel.js');
const { probeHealth } = require('../proxy/federation.js');

const TTL_MS = 5000;
const cache = new Map(); // name -> { health, at }

function clearHealthCache() { cache.clear(); }

// Compatibilita' tunnel per il frontend attuale (che legge tunnel.status): deriva
// uno {status, managed} retro-compatibile dal model health, senza reintrodurre il
// verde hardcoded. inbound -> 'unknown' (la UI lo trattava come up prima: ora e'
// onesto). outbound down/401 -> 'down'/'degraded'.
function tunnelFromHealth(h) {
  if (!h) return { status: 'unknown', managed: false };
  const used = h.transportEngine ? { transport: h.transportEngine } : {};
  if (h.status === 'passive') return { status: 'passive', managed: false, ...used };
  if (h.transport === 'up' && h.auth === 'ok') return { status: 'up', managed: h.managed !== false, ...used };
  if (h.transport === 'up' && h.auth === 'failed') return { status: 'degraded', managed: h.managed !== false, ...used };
  if (h.transport === 'up') return { status: 'degraded', managed: h.managed !== false, ...used };
  if (h.transport === 'down') return { status: 'down', managed: h.managed !== false, ...used };
  return { status: 'unknown', managed: false }; // inbound / unknown
}

async function nodeHealth({ node, home, fetchImpl, now = Date.now(), force = false }) {
  if (!node || typeof node !== 'object') return null;
  const cacheKey = `${home || ''}\0${node.direction || 'outbound'}\0${node.name}\0${node.localPort}\0${node.nodeId || ''}\0${node.shared === true}\0${node.rolesKnown === true}\0${node.roles?.node === true}`;
  const cached = !force && cache.get(cacheKey);
  if (cached && (now - cached.at) < TTL_MS) return cached.health;

  let health;
  if (node.direction === 'inbound') {
    if (node.shared !== true) {
      health = {
        transport: 'unknown', auth: 'unknown', reachability: 'unknown', status: 'passive',
        detail: 'client privato collegato (Share disattivato)', expected: true, managed: false, at: now,
      };
    } else if (!node.token) {
      health = {
        transport: 'unknown', auth: 'unknown', reachability: 'unknown', status: 'degraded',
        detail: 'peer inbound senza credenziale federation — re-pair', managed: false, at: now,
      };
    } else {
      const probed = await probeHealth({
        port: node.localPort, token: node.token, expectedInstanceId: node.nodeId || null, fetchImpl, now,
      });
      // The receiving side does not own an inbound client's lifecycle. A
      // client-only (or legacy unknown-role) peer being offline is expected,
      // not a broken server. Live auth/payload failures remain real failures.
      if (probed.transport === 'down' && (node.rolesKnown !== true || node.roles?.node !== true)) {
        health = {
          ...probed, status: 'passive', expected: true, managed: false,
          detail: node.rolesKnown === true ? 'client peer offline (expected)' : 'inbound peer offline',
        };
      } else {
        health = { ...probed, managed: false };
      }
    }
  } else {
    const ts = nodesTunnel.readTunnelState(home, node.name);
    if (ts.status !== 'up') {
      const diagnostic = nodesTunnel.diagnoseTunnel(home, node, ts);
      health = {
        transport: 'down', auth: 'unknown', reachability: 'unknown', status: 'down',
        detail: diagnostic.detail, code: diagnostic.code, stage: diagnostic.stage,
        ...(diagnostic.hint ? { hint: diagnostic.hint } : {}),
        transportEngine: ts.transport || 'ssh', managed: ts.managed !== false, at: now,
      };
    } else if (!node.token) {
    health = {
      transport: 'up', auth: 'unknown', reachability: 'unknown', status: 'degraded',
      detail: 'tunnel up, credenziali federation assenti (token mancante) — re-pair',
      transportEngine: ts.transport || 'ssh', managed: true, at: now,
    };
    } else {
      const probed = await probeHealth({
        port: node.localPort, token: node.token, expectedInstanceId: node.nodeId || null, fetchImpl, now,
      });
      health = { ...probed, transportEngine: ts.transport || 'ssh', managed: true };
    }
  }
  cache.set(cacheKey, { health, at: now });
  return health;
}

async function nodesHealth({ nodes, home, fetchImpl, now = Date.now() }) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];
  return Promise.all(nodes.map((node) => nodeHealth({ node, home, fetchImpl, now })));
}

module.exports = { nodeHealth, nodesHealth, tunnelFromHealth, clearHealthCache, TTL_MS };
