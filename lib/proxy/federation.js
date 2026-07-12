'use strict';

const http = require('node:http');
const net = require('node:net');
const express = require('express');
const store = require('../nodes/store.js');
const topologyCache = require('../nodes/topology-cache.js');
const { bearerFrom } = require('../auth/middleware.js');
const { safeEqual } = require('../nodes/peering.js');
const {
  sanitizeRequestHeaders, sanitizeResponseHeaders, stripLocalTokenQuery,
} = require('./node-proxy.js');

const MAX_HOPS = 4;
const ROUTE_DELIMITER = '_';

function peerFromToken(nodesPath, token) {
  const st = store.loadStore(nodesPath);
  if (!st || !token) return null;
  return st.nodes.find((n) => n.acceptToken && safeEqual(n.acceptToken, token)) || null;
}

function peerAllows(peer, otherId) {
  if (!peer) return true;
  if (peer.visibility === 'network') return true;
  if (peer.visibility === 'relay-only') return false;
  return Array.isArray(peer.selected) && peer.selected.includes(otherId);
}

function canTransit(ingress, egress) {
  if (!ingress || !egress || ingress.name === egress.name) return !ingress;
  return peerAllows(ingress, egress.nodeId) && peerAllows(egress, ingress.nodeId);
}

function parseRoute(raw) {
  const parts = String(raw || '').split('?')[0].split('/').filter(Boolean);
  const idx = parts.indexOf(ROUTE_DELIMITER);
  // The delimiter cannot occur in a strict peer name, so the first occurrence
  // is authoritative. Resource segments may legitimately be "_" (a valid
  // tmux session name) and must not be mistaken for another boundary.
  if (idx < 0) return null;
  const route = parts.slice(0, idx);
  const resource = `/${parts.slice(idx + 1).join('/')}`;
  if (route.length > MAX_HOPS || route.some((n) => !store.NODE_NAME_RE.test(n))) return null;
  if (new Set(route).size !== route.length || !knownResource(resource)) return null;
  return { route, resource };
}

function knownResource(resource) {
  return resource === '/sessions'
    || /^\/sessions\/[\w.@%:+-]{1,128}$/.test(resource)
    || resource === '/config'
    || resource === '/fs/dirs'
    || resource === '/files'
    || resource === '/files/download'
    || resource === '/files/upload'
    || resource === '/ws'
    || /^\/fleet\/(status|schema|definitions|up|down|restart|engine|boot|define-engine|edit-engine|remove-engine|define-cell|edit-cell|remove-cell)$/.test(resource);
}

function allowedResource(resource, method = 'GET') {
  if (resource === '/sessions') return method === 'GET' || method === 'POST';
  if (/^\/sessions\/[\w.@%:+-]{1,128}$/.test(resource)) return method === 'DELETE';
  if (resource === '/config') return method === 'GET';
  if (resource === '/fs/dirs') return method === 'GET';
  if (resource === '/files') return method === 'GET' || method === 'DELETE';
  if (resource === '/files/download') return method === 'GET';
  if (resource === '/files/upload') return method === 'POST';
  if (resource === '/ws') return method === 'GET';
  if (/^\/fleet\/(status|schema|definitions)$/.test(resource)) return method === 'GET';
  if (/^\/fleet\/(up|down|restart|engine|boot|define-engine|edit-engine|remove-engine|define-cell|edit-cell|remove-cell)$/.test(resource)) return method === 'POST';
  return false;
}

function cleanHeaders(headers, credential, visited = null) {
  const out = sanitizeRequestHeaders(headers, credential);
  for (const key of Object.keys(out)) {
    if (['x-nexuscrew-route', 'x-nexuscrew-visited', 'x-nexuscrew-hop'].includes(key.toLowerCase())) delete out[key];
  }
  if (Array.isArray(visited) && visited.length) out['x-nexuscrew-visited'] = visited.join(',');
  return out;
}

function proxyHttp(req, res, { port, path, credential, visited = null }) {
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path, headers: cleanHeaders(req.headers, credential, visited) }, (r) => {
    res.writeHead(r.statusCode, sanitizeResponseHeaders(r.headers)); r.pipe(res);
  });
  up.setTimeout(30000, () => up.destroy());
  up.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'peer non raggiungibile' }); else res.destroy(); });
  req.pipe(up);
}

function routeHandler({ nodesPath, localPort, localCredential, ingress = null, readonly = () => false }) {
  return (req, res) => {
    const parsed = parseRoute(req.url);
    if (!parsed || !allowedResource(parsed.resource, req.method)) return res.status(404).json({ error: 'not found' });
    if (readonly() && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return res.status(403).json({ error: 'READONLY: federated mutation blocked' });
    const st = store.loadStore(nodesPath);
    if (!st) return res.status(503).json({ error: 'node store unavailable' });
    const visited = controlledVisited(req, ingress, st.nodeId);
    if (!visited) return res.status(409).json({ error: 'federation cycle rejected' });
    if (parsed.route.length === 0) {
      return proxyHttp(req, res, { port: typeof localPort === 'function' ? localPort() : localPort, path: `/api${parsed.resource}${queryOf(req.url)}`, credential: localCredential() });
    }
    const next = st && store.getNode(st, parsed.route[0]);
    if (!next || !next.token || (ingress && !canTransit(ingress, next))) return res.status(403).json({ error: 'route non consentita' });
    const rest = parsed.route.slice(1);
    const path = `/federation/route/${rest.length ? `${rest.join('/')}/` : ''}${ROUTE_DELIMITER}${parsed.resource}${queryOf(req.url)}`;
    proxyHttp(req, res, { port: next.localPort, path, credential: next.token, visited });
  };
}

function queryOf(url) {
  const i = String(url).indexOf('?');
  return i < 0 ? '' : stripLocalTokenQuery(String(url).slice(i));
}

// probeHealth: probe federato di un peer verso la sua porta forward locale
// (127.0.0.1:port) autenticato con il token del nodo (Bearer accettato dal
// peerRouter via acceptToken). Modella 3 dimensioni invece di un boolean "up":
//   transport    — la porta TCP risponde (qualcuno e' in ascolto)
//   auth         — la federation accetta la credenziale (200 vs 401)
//   reachability — l'API risponde con payload comprensibile (200 vs 5xx)
// Mai lancia: ogni guasto (refused/timeout/abort) -> {transport:'down',...}.
// Questo e' il cuore del fix "peer localhost risponde in porta ma federation 401":
// il 401 emerge come auth:'failed' con diagnostica esplicita invece di essere
// mascherato da uno stato verde hardcoded.
async function probeHealth({ port, token, expectedInstanceId = null, fetchImpl = fetch, timeoutMs = 1500, now = Date.now() }) {
  const out = { transport: 'unknown', auth: 'unknown', reachability: 'unknown', status: 'unknown', detail: '', httpStatus: null, at: now };
  let r;
  let timer;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
    r = await fetchImpl(`http://127.0.0.1:${port}/federation/health`, {
      headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal,
    });
  } catch (e) {
    out.transport = 'down';
    out.status = 'down';
    out.detail = (e && (e.name === 'AbortError' || e.code === 'ETIMEDOUT'))
      ? `peer non raggiungibile (timeout ${timeoutMs}ms)` : 'peer non raggiungibile (tcp refused/down)';
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }
  out.transport = 'up';
  out.httpStatus = r.status;
  if (r.status === 200) {
    out.auth = 'ok';
    let body;
    try { body = await r.json(); } catch (_) { body = null; }
    if (!body || body.ok !== true || typeof body.instanceId !== 'string') {
      out.reachability = 'failed'; out.status = 'degraded'; out.detail = 'health payload non valido';
    } else if (expectedInstanceId && body.instanceId !== expectedInstanceId) {
      out.reachability = 'failed'; out.status = 'degraded'; out.detail = 'peer instanceId inatteso — tunnel/porta punta al nodo sbagliato';
    } else {
      out.reachability = 'ok'; out.status = 'healthy'; out.detail = 'ok';
    }
  } else if (r.status === 401) {
    out.auth = 'failed'; out.reachability = 'ok'; out.status = 'degraded';
    out.detail = 'federation 401 — acceptToken non valido, re-pair richiesto';
  } else if (r.status === 403) {
    out.auth = 'ok'; out.reachability = 'ok'; out.status = 'degraded';
    out.detail = 'peer in READONLY o transito negato (403)';
  } else if (r.status >= 500) {
    out.reachability = 'failed'; out.status = 'degraded'; out.detail = `peer HTTP ${r.status}`;
  } else {
    out.reachability = 'failed'; out.status = 'degraded'; out.detail = `peer HTTP ${r.status}`;
  }
  return out;
}

function controlledVisited(req, ingress, instanceId) {
  const raw = ingress ? String(req.headers['x-nexuscrew-visited'] || '') : '';
  const seen = raw ? raw.split(',').filter(Boolean) : [];
  if (seen.some((id) => !store.NODE_ID_RE.test(id)) || seen.includes(instanceId) || seen.length > MAX_HOPS) return null;
  return [...seen, instanceId];
}

async function collectTopologyDetailed({ nodesPath, ingress = null, ttl = MAX_HOPS, visited = [], fetchImpl = fetch }) {
  const st = store.loadStore(nodesPath);
  if (!st) return { instanceId: null, nodes: [], authoritative: [] };
  const seen = new Set(visited.filter((x) => store.NODE_ID_RE.test(x)));
  seen.add(st.nodeId);
  const out = [];
  const authoritative = [];
  for (const n of st.nodes) {
    if (!n.nodeId || seen.has(n.nodeId) || (ingress && !canTransit(ingress, n))) continue;
    out.push({ instanceId: n.nodeId, name: n.name, route: [n.name], direct: true });
    if (ttl <= 1 || !n.token) continue;
    try {
      const u = `http://127.0.0.1:${n.localPort}/federation/topology?ttl=${ttl - 1}&visited=${encodeURIComponent([...seen].join(','))}`;
      const r = await fetchImpl(u, { headers: { authorization: `Bearer ${n.token}` } });
      const j = await r.json();
      if (!r.ok || j.instanceId !== n.nodeId || !Array.isArray(j.nodes)) continue;
      authoritative.push(n.name);
      for (const child of j.nodes) {
        if (!child || !store.NODE_ID_RE.test(child.instanceId) || child.instanceId === n.nodeId || seen.has(child.instanceId)
          || !store.NODE_NAME_RE.test(child.name)
          || !Array.isArray(child.route) || child.route.length < 1 || child.route.length >= ttl
          || child.route.some((x) => !store.NODE_NAME_RE.test(x))
          || new Set(child.route).size !== child.route.length
          || child.name !== child.route[child.route.length - 1]
          || child.route.includes(n.name)) continue;
        out.push({ instanceId: child.instanceId, name: child.name, route: [n.name, ...child.route], direct: false });
      }
    } catch (_) {}
  }
  const ids = new Set(); const routes = new Set(); const unique = [];
  for (const n of out.sort((a, b) => a.route.length - b.route.length)) {
    const routeKey = n.route.join('/');
    if (ids.has(n.instanceId) || routes.has(routeKey)) continue;
    ids.add(n.instanceId); routes.add(routeKey); unique.push(n);
  }
  return { instanceId: st.nodeId, nodes: unique, authoritative };
}

async function collectTopology(opts) {
  const out = await collectTopologyDetailed(opts);
  return { instanceId: out.instanceId, nodes: out.nodes };
}

// Local roster: live topology plus a credential-free cache of previously seen
// transitive nodes. Stale entries are never returned by the peer endpoint.
async function collectLocalTopology({ nodesPath, cachePath, fetchImpl = fetch, now = Math.floor(Date.now() / 1000) }) {
  const live = await collectTopologyDetailed({ nodesPath, fetchImpl });
  const st = store.loadStore(nodesPath);
  const directNames = new Set(((st && st.nodes) || []).map((n) => n.name));
  const authoritative = new Set(live.authoritative);
  const liveIds = new Set(live.nodes.map((n) => n.instanceId));
  const liveRoutes = new Set(live.nodes.map((n) => n.route.join('/')));
  const cacheFile = cachePath || topologyCache.defaultPath();
  const old = topologyCache.loadCache(cacheFile) || topologyCache.emptyCache();
  const next = new Map();

  for (const entry of old.nodes) {
    const first = entry.route[0];
    if (!directNames.has(first)) continue;
    if (authoritative.has(first) && !liveIds.has(entry.instanceId) && !liveRoutes.has(entry.route.join('/'))) continue;
    next.set(entry.instanceId, entry);
  }
  for (const n of live.nodes) {
    if (n.route.length > 1) next.set(n.instanceId, { instanceId: n.instanceId, name: n.name, route: [...n.route], lastSeen: now });
  }
  const cached = [...next.values()].sort((a, b) => a.route.join('/').localeCompare(b.route.join('/'))).slice(0, topologyCache.MAX_ENTRIES);
  const serialized = { schemaVersion: topologyCache.SCHEMA_VERSION, nodes: cached };
  if (JSON.stringify(serialized) !== JSON.stringify(old)) {
    try { topologyCache.atomicWriteCache(cacheFile, serialized); } catch (_) {}
  }

  const nodes = live.nodes.map((n) => ({ ...n, stale: false, lastSeen: now }));
  for (const n of cached) {
    if (!liveIds.has(n.instanceId) && !liveRoutes.has(n.route.join('/'))) nodes.push({ ...n, direct: false, stale: true });
  }
  return { instanceId: live.instanceId, nodes };
}

function peerRouter({ nodesPath, localPort, localCredential, fetchImpl, readonly, version = null }) {
  const r = express.Router();
  r.use((req, res, next) => {
    const peer = peerFromToken(nodesPath, bearerFrom(req));
    if (!peer) return res.status(401).json({ error: 'unauthorized peer' });
    req.peer = peer; next();
  });
  // Health federato: il peer autenticato (acceptToken matchato sopra) ottiene un
  // 200 esplicito con instanceId/version. Serve da target di probeHealth() lato
  // Initiator: distingue transport (porta aperta) da auth (200 vs 401) da
  // reachability (payload). Nessun segreto in risposta.
  r.get('/health', (_req, res) => {
    const st = store.loadStore(nodesPath);
    res.json({ ok: true, instanceId: (st && st.nodeId) || null, version, readonly: !!readonly() });
  });
  r.get('/topology', async (req, res) => {
    const ttl = Math.max(0, Math.min(MAX_HOPS, Number(req.query.ttl) || MAX_HOPS));
    const visited = String(req.query.visited || '').split(',');
    res.json(await collectTopology({ nodesPath, ingress: req.peer, ttl, visited, fetchImpl }));
  });
  r.use('/route', (req, res) => routeHandler({ nodesPath, localPort, localCredential, ingress: req.peer, readonly })(req, res));
  return r;
}

function localRouter({ nodesPath, localPort, localCredential, readonly }) {
  const r = express.Router();
  r.use((req, res) => routeHandler({ nodesPath, localPort, localCredential, readonly })(req, res));
  return r;
}

function forwardUpgrade({ req, socket, head, nodesPath, localPort, localCredential, ingress, readonly = () => false, activeSockets = null }) {
  if (readonly()) return reject(socket, 403);
  const parsed = parseRoute(req.url.replace(/^\/(?:api\/route|federation\/route)/, ''));
  if (!parsed || parsed.resource !== '/ws') return reject(socket, 404);
  const st = store.loadStore(nodesPath);
  if (!st) return reject(socket, 503);
  const visited = controlledVisited(req, ingress, st.nodeId);
  if (!visited) return reject(socket, 409);
  let port = typeof localPort === 'function' ? localPort() : localPort; let credential = localCredential(); let path = '/ws';
  if (parsed.route.length) {
    const next = store.getNode(st, parsed.route[0]);
    if (!next || !next.token || (ingress && !canTransit(ingress, next))) return reject(socket, 403);
    port = next.localPort; credential = next.token;
    const rest = parsed.route.slice(1);
    path = `/federation/route/${rest.length ? `${rest.join('/')}/` : ''}${ROUTE_DELIMITER}/ws`;
  }
  const up = net.connect({ host: '127.0.0.1', port });
  up.once('connect', () => {
    const headers = cleanHeaders(req.headers, credential, parsed.route.length ? visited : null);
    const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    lines.push('Connection: Upgrade', 'Upgrade: websocket', '', '');
    up.write(lines.join('\r\n')); if (head && head.length) up.write(head);
    if (activeSockets && typeof activeSockets.add === 'function') {
      activeSockets.add(socket); activeSockets.add(up);
      const remove = () => { activeSockets.delete(socket); activeSockets.delete(up); };
      socket.once('close', remove); up.once('close', remove);
    }
    socket.pipe(up); up.pipe(socket);
  });
  up.on('error', () => reject(socket, 502)); socket.on('error', () => up.destroy());
}

function reject(socket, code) { try { socket.end(`HTTP/1.1 ${code} Error\r\nConnection: close\r\n\r\n`); } catch (_) {} }

module.exports = {
  MAX_HOPS, ROUTE_DELIMITER, peerFromToken, peerAllows, canTransit, parseRoute, knownResource, allowedResource,
  collectTopology, collectTopologyDetailed, collectLocalTopology, peerRouter, localRouter, forwardUpgrade,
  probeHealth,
};
