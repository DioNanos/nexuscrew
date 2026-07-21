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
const TOPOLOGY_PEER_TIMEOUT_MS = 1500;

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
  // `shared` is the explicit publication gate. Visibility remains the hub ACL,
  // but it cannot make a private peer routable on its own.
  return egress.shared === true
    && peerAllows(ingress, egress.nodeId) && peerAllows(egress, ingress.nodeId);
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
    || /^\/sessions\/[\w.@%:+-]{1,128}(?:\/visibility)?$/.test(resource)
    || resource === '/config'
    || resource === '/fs/dirs'
    || resource === '/files'
    || resource === '/files/download'
    || resource === '/files/upload'
    || resource === '/cells'
    || resource === '/cells/send'
    || resource === '/decks'
    || /^\/decks\/[a-z0-9-]{1,32}$/.test(resource)
    || resource === '/topology'
    || resource === '/diagnostics/status'
    || resource === '/diagnostics/logs'
    || resource === '/diagnostics/verbose'
    // A connected client may ask its hub to mint a hub-owned, one-time
    // pairing invite. This is the only settings mutation exposed through
    // Hydra: the rest of /settings stays unreachable.
    || resource === '/settings/peering/invite'
    || resource === '/ws'
    || /^\/fleet\/(status|schema|definitions|credentials\/status|credentials\/(?:set|remove)|up|down|restart|engine|boot|define-engine|edit-engine|remove-engine|define-cell|edit-cell|remove-cell|restore-cells|restore-engines)$/.test(resource);
}

function allowedResource(resource, method = 'GET') {
  if (resource === '/sessions') return method === 'GET' || method === 'POST';
  if (/^\/sessions\/[\w.@%:+-]{1,128}$/.test(resource)) return method === 'DELETE';
  if (/^\/sessions\/[\w.@%:+-]{1,128}\/visibility$/.test(resource)) return method === 'PATCH';
  if (resource === '/config') return method === 'GET';
  if (resource === '/fs/dirs') return method === 'GET';
  if (resource === '/files') return method === 'GET' || method === 'DELETE';
  if (resource === '/files/download') return method === 'GET';
  if (resource === '/files/upload') return method === 'POST';
  if (resource === '/cells') return method === 'GET';
  if (resource === '/cells/send') return method === 'POST';
  if (resource === '/decks') return method === 'GET' || method === 'POST';
  if (/^\/decks\/[a-z0-9-]{1,32}$/.test(resource)) {
    return method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  }
  if (resource === '/topology') return method === 'GET';
  if (resource === '/diagnostics/status') return method === 'GET';
  if (resource === '/diagnostics/logs') return method === 'GET' || method === 'DELETE';
  if (resource === '/diagnostics/verbose') return method === 'PATCH';
  if (resource === '/settings/peering/invite') return method === 'POST';
  if (resource === '/ws') return method === 'GET';
  if (/^\/fleet\/(status|schema|definitions|credentials\/status)$/.test(resource)) return method === 'GET';
  if (/^\/fleet\/(credentials\/(?:set|remove)|up|down|restart|engine|boot|define-engine|edit-engine|remove-engine|define-cell|edit-cell|remove-cell|restore-cells|restore-engines)$/.test(resource)) return method === 'POST';
  return false;
}

function allowedQuery(resource, method, rawUrl) {
  if (!resource.startsWith('/diagnostics/')) return true;
  const index = String(rawUrl || '').indexOf('?');
  if (index < 0) return true;
  const raw = String(rawUrl).slice(index + 1);
  if (!raw) return true;
  if (resource !== '/diagnostics/logs' || method !== 'GET') return false;
  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  if (keys.some((key) => !['after', 'limit'].includes(key))) return false;
  if (params.getAll('after').length > 1 || params.getAll('limit').length > 1) return false;
  const after = params.get('after'); const limit = params.get('limit');
  if (after !== null && (!/^\d{1,16}$/.test(after) || !Number.isSafeInteger(Number(after)))) return false;
  if (limit !== null && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200)) return false;
  return true;
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
    if (!parsed || !allowedResource(parsed.resource, req.method)
      || !allowedQuery(parsed.resource, req.method, req.url)) return res.status(404).json({ error: 'not found' });
    if (readonly() && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return res.status(403).json({ error: 'READONLY: federated mutation blocked' });
    const st = store.loadStore(nodesPath);
    if (!st) return res.status(503).json({ error: 'node store unavailable' });
    const visited = controlledVisited(req, ingress, st.nodeId);
    if (!visited) return res.status(409).json({ error: 'federation cycle rejected' });
    if (parsed.route.length === 0) {
      return proxyHttp(req, res, {
        port: typeof localPort === 'function' ? localPort() : localPort,
        path: `/api${parsed.resource}${queryOf(req.url)}`,
        credential: localCredential(),
        visited,
      });
    }
    const next = st && store.getNode(st, parsed.route[0]);
    const privateInbound = next && next.direction === 'inbound' && next.shared !== true;
    if (!next || !next.token || privateInbound || (ingress && !canTransit(ingress, next))) return res.status(403).json({ error: 'route non consentita' });
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
    const request = fetchImpl(`http://127.0.0.1:${port}/federation/health`, {
      headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal,
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        const e = new Error(`health timeout (${timeoutMs}ms)`); e.name = 'AbortError'; reject(e);
      }, timeoutMs);
    });
    r = await Promise.race([request, timeout]);
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
      if (body.roles !== undefined) {
        const roles = store.parseRoles(body.roles);
        if (!roles) {
          out.reachability = 'failed'; out.status = 'degraded'; out.detail = 'health roles non validi';
          return out;
        }
        out.roles = roles; out.rolesKnown = true;
      }
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

// A freshly restarted SSH supervisor returns before both forwards are
// necessarily accepting traffic.  Share must therefore wait for the actual
// authenticated federation channel instead of racing a single immediate
// fetch.  Auth/identity failures are terminal; transport startup is retried
// for a short bounded window.
async function waitForHealthyPeer(opts = {}) {
  const attempts = Number.isInteger(opts.attempts) && opts.attempts > 0 ? Math.min(opts.attempts, 12) : 6;
  const delayMs = Number.isInteger(opts.delayMs) && opts.delayMs >= 0 ? Math.min(opts.delayMs, 2000) : 200;
  const delay = typeof opts.delay === 'function'
    ? opts.delay : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const probeOpts = { ...opts };
  delete probeOpts.attempts; delete probeOpts.delayMs; delete probeOpts.delay;
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await probeHealth(probeOpts);
    if (last.status === 'healthy') return last;
    if (last.auth === 'failed' || /instanceId inatteso/.test(last.detail || '')) break;
    if (attempt + 1 < attempts) await delay(delayMs);
  }
  return last || { status: 'down', detail: 'peer non raggiungibile' };
}

// Aggiorna lo stato Share sul hub attraverso il canale -L autenticato. Non
// legge mai il body remoto (potrebbe contenere diagnostica non sicura) e non
// include credenziali negli errori. Usato sia dal toggle interattivo sia dalla
// riconciliazione al boot.
async function notifyHubShare({ node, shared, fetchImpl = fetch, timeoutMs = 5000 }) {
  if (!node || !store.isPort(node.localPort) || !store.validToken(node.token)
    || typeof shared !== 'boolean') throw new Error('parametri riconciliazione Share non validi');
  const ctrl = new AbortController();
  const budget = Number.isInteger(timeoutMs) ? Math.max(100, Math.min(timeoutMs, 30000)) : 5000;
  let timer;
  try {
    const request = fetchImpl(`http://127.0.0.1:${node.localPort}/federation/share`, {
      method: 'POST', signal: ctrl.signal,
      headers: { authorization: `Bearer ${node.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ shared }),
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        const e = new Error(`hub Share timeout (${budget}ms)`); e.code = 'ETIMEDOUT'; reject(e);
      }, budget);
    });
    const response = await Promise.race([request, timeout]);
    if (!response || !response.ok) throw new Error(`hub Share HTTP ${response && response.status || 'unknown'}`);
    return { shared };
  } finally { clearTimeout(timer); }
}

// Il file locale contiene lo stato desiderato. Dopo un crash in qualunque
// punto del toggle, il boot ristabilisce il tunnel coerente e ripete l'update
// del hub: ON torna pubblicato, OFF revoca record stale. Tutto e' bounded.
async function reconcilePeerShare(opts = {}) {
  const node = opts.node;
  const shared = opts.shared === true;
  if (!node || !store.validToken(node.token) || !store.NODE_ID_RE.test(String(node.nodeId || ''))) {
    throw new Error('peer non associato: riconciliazione Share impossibile');
  }
  const fetchImpl = opts.fetchImpl || fetch;
  const delay = typeof opts.delay === 'function'
    ? opts.delay : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const health = await waitForHealthyPeer({
    port: node.localPort, token: node.token, expectedInstanceId: node.nodeId,
    fetchImpl,
    attempts: Number.isInteger(opts.healthAttempts) ? opts.healthAttempts : 6,
    delayMs: Number.isInteger(opts.delayMs) ? opts.delayMs : 200,
    delay,
  });
  if (!health || health.status !== 'healthy') {
    throw new Error((health && health.detail) || 'hub non raggiungibile per riconciliare Share');
  }
  const attempts = Number.isInteger(opts.notifyAttempts)
    ? Math.max(1, Math.min(opts.notifyAttempts, 6)) : (shared ? 3 : 1);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await notifyHubShare({ node, shared, fetchImpl, timeoutMs: opts.timeoutMs });
      return { shared, health };
    } catch (e) {
      lastError = e;
      if (attempt + 1 < attempts) await delay(Number.isInteger(opts.delayMs) ? opts.delayMs : 200);
    }
  }
  throw lastError || new Error('riconciliazione Share fallita');
}

function controlledVisited(req, ingress, instanceId) {
  const raw = ingress ? String(req.headers['x-nexuscrew-visited'] || '') : '';
  const seen = raw ? raw.split(',').filter(Boolean) : [];
  // On a peer-facing route the last server-controlled hop must be the peer
  // authenticated by its scoped federation token.  Without this binding a
  // token holder could forge the first visited ID and impersonate another
  // cell-network sender at the destination.
  if (ingress && (!store.NODE_ID_RE.test(String(ingress.nodeId || ''))
    || !seen.length || seen.at(-1) !== ingress.nodeId)) return null;
  if (seen.some((id) => !store.NODE_ID_RE.test(id)) || seen.includes(instanceId) || seen.length > MAX_HOPS) return null;
  return [...seen, instanceId];
}

async function fetchPeerTopology({ node, ttl, seen, fetchImpl, timeoutMs }) {
  const ctrl = new AbortController();
  const budget = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.min(30000, Math.floor(timeoutMs))) : TOPOLOGY_PEER_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      const error = new Error(`topology peer timeout (${budget}ms)`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, budget);
  });
  const request = (async () => {
    const u = `http://127.0.0.1:${node.localPort}/federation/topology?ttl=${ttl - 1}&visited=${encodeURIComponent([...seen].join(','))}`;
    const response = await fetchImpl(u, {
      headers: { authorization: `Bearer ${node.token}` }, signal: ctrl.signal,
    });
    return { response, body: await response.json() };
  })();
  try { return await Promise.race([request, timeout]); }
  finally { clearTimeout(timer); }
}

async function collectTopologyDetailed({
  nodesPath, ingress = null, ttl = MAX_HOPS, visited = [], fetchImpl = fetch,
  timeoutMs = TOPOLOGY_PEER_TIMEOUT_MS,
}) {
  const st = store.loadStore(nodesPath);
  if (!st) return { instanceId: null, nodes: [], authoritative: [] };
  const seen = new Set(visited.filter((x) => store.NODE_ID_RE.test(x)));
  seen.add(st.nodeId);
  const out = [];
  const authoritative = [];
  const probes = [];
  for (const n of st.nodes) {
    // The local installation always keeps its outbound hub visible. Inbound
    // clients become part of Hydra only after their explicit Share toggle.
    if (!n.nodeId || seen.has(n.nodeId)
      || (!ingress && n.direction === 'inbound' && n.shared !== true)
      || (ingress && !canTransit(ingress, n))) continue;
    out.push({ instanceId: n.nodeId, name: n.name, route: [n.name], direct: true });
    if (ttl <= 1 || !n.token) continue;
    probes.push({ n, pending: fetchPeerTopology({ node: n, ttl, seen, fetchImpl, timeoutMs }) });
  }
  const results = await Promise.all(probes.map(async ({ n, pending }) => {
    try { return { n, ...(await pending) }; } catch (_) { return { n, response: null, body: null }; }
  }));
  for (const { n, response, body } of results) {
    if (!response || !response.ok || body.instanceId !== n.nodeId || !Array.isArray(body.nodes)) continue;
    authoritative.push(n.name);
    for (const child of body.nodes) {
        if (!child || !store.NODE_ID_RE.test(child.instanceId) || child.instanceId === n.nodeId || seen.has(child.instanceId)
          || !store.NODE_NAME_RE.test(child.name)
          || !Array.isArray(child.route) || child.route.length < 1 || child.route.length >= ttl
          || child.route.some((x) => !store.NODE_NAME_RE.test(x))
          || new Set(child.route).size !== child.route.length
          || child.name !== child.route[child.route.length - 1]
          || child.route.includes(n.name)) continue;
        out.push({ instanceId: child.instanceId, name: child.name, route: [n.name, ...child.route], direct: false });
    }
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
async function collectLocalTopology({
  nodesPath, cachePath, fetchImpl = fetch, now = Math.floor(Date.now() / 1000),
  timeoutMs = TOPOLOGY_PEER_TIMEOUT_MS,
}) {
  const live = await collectTopologyDetailed({ nodesPath, fetchImpl, timeoutMs });
  const st = store.loadStore(nodesPath);
  const directNames = new Set(((st && st.nodes) || [])
    .filter((n) => n.direction !== 'inbound' || n.shared === true)
    .map((n) => n.name));
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

function peerRouter({ nodesPath, localPort, localCredential, fetchImpl, readonly = () => false, version = null, roles = null }) {
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
    const advertisedRoles = typeof roles === 'function' ? roles() : null;
    res.json({ ok: true, instanceId: (st && st.nodeId) || null, version, readonly: !!readonly(),
      ...(advertisedRoles ? { roles: advertisedRoles } : {}) });
  });
  r.get('/topology', async (req, res) => {
    const ttl = Math.max(0, Math.min(MAX_HOPS, Number(req.query.ttl) || MAX_HOPS));
    const visited = String(req.query.visited || '').split(',');
    res.json(await collectTopology({ nodesPath, ingress: req.peer, ttl, visited, fetchImpl }));
  });
  // A connected client publishes itself through the SAME SSH connection by
  // toggling its optional -R channel. The hub records that intent only after a
  // real authenticated health probe succeeds; Share off is immediate/fail-safe.
  r.post('/share', express.json({ limit: '1kb' }), async (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: share bloccato' });
    const body = req.body || {};
    if (Object.keys(body).some((k) => k !== 'shared') || typeof body.shared !== 'boolean') {
      return res.status(400).json({ error: 'body non valido: atteso {shared:boolean}' });
    }
    try {
      if (body.shared) {
        const health = await waitForHealthyPeer({
          port: req.peer.localPort,
          token: req.peer.token,
          expectedInstanceId: req.peer.nodeId || null,
          fetchImpl: fetchImpl || fetch,
          attempts: 6,
          delayMs: 200,
        });
        if (health.status !== 'healthy') {
          return res.status(409).json({
            error: 'canale share non raggiungibile',
            detail: health.detail || 'reverse SSH non pronto',
          });
        }
      }
      let st = store.loadStoreStrict(nodesPath);
      const current = store.getNode(st, req.peer.name);
      if (!current) return res.status(404).json({ error: 'peer non trovato' });
      st = store.updateNode(st, current.name, {
        shared: body.shared,
        roles: { ...current.roles, node: body.shared },
        rolesKnown: true,
      });
      store.atomicWriteStore(nodesPath, st);
      return res.json({ shared: body.shared });
    } catch (e) {
      return res.status(e.status || 500).json({ error: String(e && e.message || e), ...(e.code ? { code: e.code } : {}) });
    }
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
    const privateInbound = next && next.direction === 'inbound' && next.shared !== true;
    if (!next || !next.token || privateInbound || (ingress && !canTransit(ingress, next))) return reject(socket, 403);
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
  MAX_HOPS, ROUTE_DELIMITER, TOPOLOGY_PEER_TIMEOUT_MS,
  peerFromToken, peerAllows, canTransit, parseRoute, knownResource, allowedResource, allowedQuery,
  collectTopology, collectTopologyDetailed, collectLocalTopology, peerRouter, localRouter, forwardUpgrade,
  probeHealth, waitForHealthyPeer, notifyHubShare, reconcilePeerShare,
};
