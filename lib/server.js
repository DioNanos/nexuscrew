'use strict';
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const { defaults, loadConfig, assertLoopback, configJsonPath } = require('./config.js');
const { writeConfigAtomic } = require('./cli/init.js');
const { listSessions, attachedClients, setSessionVisibility } = require('./tmux/list.js');
const { runAction, pasteToSession, submitToSession } = require('./tmux/actions.js');
const { createSession, killSession, isProtectedSession } = require('./tmux/lifecycle.js');
const { createPreviewSampler } = require('./tmux/preview.js');
const { requireSharedTmuxProtection } = require('./tmux/shared-server.js');
const { openAttach } = require('./pty/attach.js');
const { bindWs } = require('./ws/bridge.js');
const { loadOrCreateToken, verify } = require('./auth/token.js');
const { requireToken, bearerFrom } = require('./auth/middleware.js');
const { filesRoutes } = require('./files/routes.js');
const { createOutboxWatcher } = require('./files/watcher.js');
const VERSION = require('../package.json').version;
const { transcribe } = require('./voice/transcribe.js');
const { selectProvider } = require('./fleet/provider.js');
const { fleetRoutes } = require('./fleet/routes.js');
const { cellsRoutes } = require('./cells/routes.js');
const { fsRoutes } = require('./fs/routes.js');
const nodesStore = require('./nodes/store.js');
const nodesTunnel = require('./nodes/tunnel.js');
const nodesHealth = require('./nodes/health.js');
const nodesInventory = require('./nodes/inventory.js');
const topologyCache = require('./nodes/topology-cache.js');
const { createNodeProxy, handleNodeUpgrade } = require('./proxy/node-proxy.js');
const federation = require('./proxy/federation.js');
const { settingsRoutes, publicPeeringRoutes } = require('./settings/routes.js');
const decksStore = require('./decks/store.js');
const { decksRoutes } = require('./decks/routes.js');
const { createEventsHub } = require('./notify/events.js');
const { createPushService } = require('./notify/push.js');
const { createAsksStore } = require('./notify/asks.js');
const { createNotifier } = require('./notify/notifier.js');
const { notifyRoutes } = require('./notify/routes.js');
const { createNpmUpdater } = require('./update/manager.js');
const { createDiagnostics } = require('./diagnostics/store.js');
const { diagnosticsRoutes } = require('./diagnostics/routes.js');

function sessionExists(tmuxBin, name) {
  if (typeof name !== 'string' || !/^[\w.@%:+-]{1,128}$/.test(name)) return false;
  try { execFileSync(tmuxBin, ['has-session', '-t', `=${name}`], { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}

function uiBuildVersion(distDir) {
  try {
    const x = JSON.parse(require('node:fs').readFileSync(path.join(distDir, 'version.json'), 'utf8'));
    return typeof x.version === 'string' ? x.version : null;
  } catch (_) { return null; }
}

function createServer(opts = {}) {
  const cfg = loadConfig(opts);
  assertLoopback(cfg.bind);
  // Token holder LIVE (audit F7 / §4b(3)): requireToken/verify leggono tokenStore.get()
  // ad ogni richiesta, cosi' una rotazione via Settings API invalida il VECCHIO token
  // (401) e attiva il NUOVO (200) SENZA restart. Prima il token era catturato una volta
  // allo startup e restava valido fino al restart manuale.
  const tokenHolder = { value: loadOrCreateToken(cfg.tokenPath) };
  const tokenStore = {
    get: () => tokenHolder.value,
    reload: () => { tokenHolder.value = loadOrCreateToken(cfg.tokenPath); return tokenHolder.value; },
  };
  const proxySockets = new Set();
  // wss viene creato piu' sotto; closeSessions lo raggiunge a request-time (mai durante
  // createServer) per chiudere le sessioni WS attive sulla rotazione token (§4b(3)).
  let wss = null;
  const closeSessions = () => {
    if (wss) {
      for (const ws of wss.clients) { try { ws.close(4001, 'token rotated'); } catch (_) { /* best-effort */ } }
    }
    for (const socket of proxySockets) { try { socket.destroy(); } catch (_) {} }
    proxySockets.clear();
  };
  const watcher = createOutboxWatcher({ root: cfg.filesRoot });
  // server e' creato piu' sotto (http.createServer); lo dichiariamo qui perche' le
  // closure localPort/localCredential dei router federation lo riferiscono lazy, al
  // request time. localPort DEVE leggere la porta effettiva (server.address().port)
  // e non cfg.port: in test (listen(0) su porta random) o dopo fallback EADDRINUSE,
  // cfg.port non coincide con la porta reale e il proxy federation locale puntava
  // alla porta sbagliata (bug reale: 401/"unauthorized" dal servizio su cfg.port).
  let server = null;
  const previews = createPreviewSampler(cfg.tmuxBin);
  // MCP bridge (notify/ask/push): lo stato vive accanto al token (dirname del
  // tokenPath = ~/.nexuscrew di default) cosi' le istanze isolate via opts/env
  // nei test NON scrivono mai nella home reale. Tutto lazy: vapid.json/asks.json
  // nascono al primo uso, non allo startup.
  const notifyDir = cfg.notifyDir || path.dirname(cfg.tokenPath);
  // READONLY come floor anche dentro il push service (F3): niente generazione
  // VAPID ne' cleanup subscription quando il server e' readonly.
  const bridgeReadonly = () => (cfg.readonlyDefault === true || process.env.NEXUSCREW_READONLY === '1');
  const eventsHub = createEventsHub();
  const pushSvc = createPushService({
    dir: notifyDir, webpushImpl: cfg.webpushImpl,
    readonly: bridgeReadonly, maxSubs: cfg.pushMaxSubs, lookupImpl: cfg.pushLookupImpl,
  });
  const asksStore = createAsksStore({ dir: notifyDir });
  const notifier = createNotifier({ hub: eventsHub, push: pushSvc });
  const diagnostics = opts.diagnostics || createDiagnostics();
  const updater = opts.updateManager || createNpmUpdater({
    currentVersion: VERSION,
    home: cfg.home || os.homedir(),
    enabled: cfg.autoUpdate !== false,
    readonly: bridgeReadonly(),
    diagnostics,
    ...(cfg.updateSeams || {}),
  });
  const attachedWs = new Map(); // ws -> session (per il push dei frame files)
  const ensureTmuxProtection = () => requireSharedTmuxProtection(cfg.tmuxBin, {
    enabled: cfg.protectSharedTmuxServer !== false,
    home: cfg.home || os.homedir(),
  });
  // selectProvider sceglie UNA volta (startup) builtin|disabled e ritorna
  // {mode,reason,fleet}; routes consumano il .fleet,
  // quindi fleetP resta una Promise<Fleet> (createServer non diventa async).
  const fleetP = selectProvider({ ...cfg, ensureTmuxProtection }).then((p) => p.fleet);

  // Multi-node (B1): nodes.json e' la fonte dati (B0). Il proxy risolve <name>
  // -> {localPort, token} leggendo lo store ad ogni richiesta (fresh: rotazione
  // token / add-remove nodi visibili senza restart). token MAI redatto qui: e'
  // il valore che il proxy inietta upstream, non esce mai verso il browser.
  const nodesPath = cfg.nodesPath || nodesStore.defaultNodesPath(cfg.home || os.homedir());
  // fetch usata dai probe di salute federati (iniettabile nei test); default globale.
  const healthFetch = cfg.fetchImpl || fetch;
  const topologyCachePath = cfg.topologyCachePath || topologyCache.defaultPath(cfg.home || os.homedir());
  const decksPath = cfg.decksPath || decksStore.defaultDecksPath(cfg.home || os.homedir());
  const proxyReadonly = () => (cfg.readonlyDefault === true || process.env.NEXUSCREW_READONLY === '1');
  function resolveNode(name) {
    const st = nodesStore.loadStore(nodesPath);
    if (!st) return null;
    const node = nodesStore.getNode(st, name);
    if (!node) return null;
    return { localPort: node.localPort, token: node.token || null };
  }

  const runtimePort = () => (server && server.address() ? server.address().port : cfg.port);
  let tunnelsStarted = false;
  function startManagedTunnels() {
    if (tunnelsStarted) return;
    tunnelsStarted = true;
    const st = nodesStore.loadStore(nodesPath);
    const configured = ((st && st.nodes) || [])
      .filter((node) => node.direction !== 'inbound')
      .map((node) => node.name);
    const reconcile = cfg.reconcileTunnelSupervisorsImpl || nodesTunnel.reconcileTunnelSupervisors;
    const recovered = reconcile({ home: cfg.home || os.homedir(), configuredNames: configured });
    for (const failure of recovered.failed || []) {
      process.stderr.write(`[nexuscrew] orphan tunnel cleanup failed for ${failure.name}: ${failure.reason}\n`);
      diagnostics.record('warn', 'tunnel', 'TUNNEL_CLEANUP_FAILED', 'Tunnel cleanup failed', {
        node: failure.name, state: 'cleanup-failed',
      });
    }
    // Exactly one connection per configured hub. Legacy `roles.node` /
    // rendezvous data is migration-only and never starts a second hidden SSH
    // process. Publishing this device is the optional -R on its outbound link.
    for (const node of (st && st.nodes) || []) {
      if (node.direction !== 'inbound' && node.autostart === true) {
        const tr = nodesTunnel.startForward({
          home: cfg.home || os.homedir(), node, localAppPort: runtimePort(),
          spawnImpl: cfg.tunnelSpawnImpl, spawnSyncImpl: cfg.tunnelSpawnSyncImpl,
          sshBin: cfg.sshBin, logFd: cfg.tunnelLogFd,
        });
        if (!tr.started && tr.reason !== 'already running') {
          process.stderr.write(`[nexuscrew] peer ${node.name} autostart failed: ${tr.reason || 'unknown'}\n`);
          diagnostics.record('warn', 'tunnel', 'TUNNEL_AUTOSTART_FAILED', 'Tunnel autostart failed', {
            node: node.name, state: 'failed', transport: node.transport || 'auto',
          });
        } else {
          diagnostics.record('info', 'tunnel', 'TUNNEL_READY', 'Tunnel is ready', {
            node: node.name, state: tr.reason === 'already running' ? 'existing' : 'started', transport: node.transport || 'auto',
          });
          if (!(node.token && node.acceptToken && node.nodeId)) continue;
          // `shared` in nodes.json e' lo stato desiderato. Una riconciliazione
          // asincrona chiude la finestra di crash tra write locale e ACK hub
          // senza ritardare il listen del server.
          const reconcileShare = cfg.reconcilePeerShareImpl || federation.reconcilePeerShare;
          Promise.resolve(reconcileShare({
            node, shared: node.shared === true, fetchImpl: healthFetch,
            healthAttempts: 3, notifyAttempts: node.shared === true ? 3 : 1, delayMs: 200,
          })).catch((e) => {
            process.stderr.write(`[nexuscrew] peer ${node.name} Share reconcile pending: ${String(e && e.message || e).replace(/Bearer\s+\S+/gi, 'Bearer ***')}\n`);
          });
        }
      }
    }
  }

  const app = express();
  const distDir = path.join(__dirname, '..', 'frontend', 'dist');
  // no-store on everything (HTML+assets+API): this is a local, token-adjacent tool.
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/pair', publicPeeringRoutes({ cfg, nodesPath }));

  // Tutte le /api dietro Bearer: sul loopback il gate vero è il tunnel,
  // ma il token chiude anche altri processi locali della stessa macchina.
  const api = express.Router();
  api.use(requireToken(tokenStore));
  api.get('/sessions', async (_req, res) => {
    try {
      const sessions = await listSessions(cfg.tmuxBin);
      const sum = watcher.getSummary();
      const enriched = await Promise.all(sessions.map(async (s) => {
        const sample = await previews.getState(s.name);
        // Pi keeps a static "π - ..." terminal title, so only that client uses
        // the capture fallback. This prevents a quoted "• Working (...)" line
        // inside another agent's transcript from becoming a false positive.
        const piTitle = /^(?:π|pi)(?:\s+-|$)/iu.test(s.paneTitle);
        const working = s.working === true || (piTitle && sample?.working === true);
        return {
          ...s,
          working,
          status: working ? (s.status || sample?.status || '') : '',
          outbox: sum[s.name] || { count: 0, latest: 0 },
          preview: sample?.preview ?? null,
        };
      }));
      res.json({ sessions: enriched });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  api.post('/sessions', express.json({ limit: '4kb' }), async (req, res) => {
    if (proxyReadonly()) return res.status(403).json({ error: 'READONLY: creazione sessione bloccata' });
    try {
      const { name, cwd, preset } = req.body || {};
      await createSession(cfg.tmuxBin, { name, cwd, preset },
        { home: os.homedir(), presets: cfg.sessionPresets, ensureProtection: ensureTmuxProtection });
      res.status(201).json({ created: true, name });
    } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
  });
  api.delete('/sessions/:name', async (req, res) => {
    if (proxyReadonly()) return res.status(403).json({ error: 'READONLY: eliminazione sessione bloccata' });
    const name = String(req.params.name || '');
    try {
      const fleet = await fleetP;
      if (isProtectedSession(name, fleet.isCellSession)) {
        return res.status(409).json({ error: 'sessione di cella: usa fleet down' });
      }
      const killed = await killSession(cfg.tmuxBin, name, { ensureProtection: ensureTmuxProtection });
      if (!killed) return res.status(404).json({ error: 'sessione inesistente' });
      res.json({ killed: true });
    } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
  });
  api.patch('/sessions/:name/visibility', express.json({ limit: '1kb' }), async (req, res) => {
    if (proxyReadonly()) return res.status(403).json({ error: 'READONLY: classificazione sessione bloccata' });
    const name = String(req.params.name || '');
    try {
      const fleet = await fleetP;
      if (isProtectedSession(name, fleet.isCellSession)) {
        return res.status(409).json({ error: 'sessione di cella: la visibilità tecnica vale solo per sessioni tmux non gestite' });
      }
      res.json(await setSessionVisibility(cfg.tmuxBin, name, req.body?.technical === true));
    } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
  });
  api.get('/config', (_req, res) => res.json({
    readonlyDefault: cfg.readonlyDefault, version: VERSION, uiVersion: uiBuildVersion(distDir),
    bind: cfg.bind, port: cfg.port,
    protectSharedTmuxServer: cfg.protectSharedTmuxServer !== false,
    instanceId: (nodesStore.loadStore(nodesPath) || {}).nodeId || null,
    presets: ['shell', 'claude', 'codex-vl', 'pi', ...Object.keys(cfg.sessionPresets || {})],
  }));
  api.use('/files', filesRoutes({
    cfg,
    sessionExists: (name) => sessionExists(cfg.tmuxBin, name),
    paste: (session, text) => pasteToSession(cfg.tmuxBin, session, text),
    notifier,
    readonly: proxyReadonly,
  }));
  // MCP bridge (design §2): /notify, /push/*, /asks — dietro lo stesso Bearer
  // del router /api; gate READONLY sui mutanti dentro notifyRoutes.
  api.use(notifyRoutes({
    cfg,
    notifier,
    push: pushSvc,
    asks: asksStore,
    paste: (session, text) => pasteToSession(cfg.tmuxBin, session, text),
    sessionExists: (name) => sessionExists(cfg.tmuxBin, name),
  }));
  api.use('/fleet', fleetRoutes(fleetP, { ...cfg, diagnostics }));
  api.use('/cells', cellsRoutes({
    fleetP,
    instanceId: () => (nodesStore.loadStore(nodesPath) || {}).nodeId || null,
    submit: opts.cellSubmit || ((session, text, meta) => submitToSession(cfg.tmuxBin, session, text, {
      engine: meta && meta.engine,
    })),
    readonly: proxyReadonly,
  }));
  api.use('/decks', decksRoutes({ cfg, decksPath }));
  api.use('/fs', fsRoutes({ home: os.homedir() }));  // folder-picker del dialog new session
  // /nodes (read-only, per la settings UI B2): stesso formato di `nodes list --json`
  // (token SEMPRE redatti via redactStore) + health federato per-nodo. Il campo
  // `tunnel` resta per retro-compatibilita' col frontend (derivato dal health).
  //   health = { transport, auth, reachability, status, detail, managed, at }
  // inbound: non probeable -> health unknown (NON "up" fittizio). outbound: probe
  // reale /federation/health (cache TTL) -> distingue tcp down / 401 / 200.
  api.get('/nodes', async (_req, res) => {
    try {
      const st = nodesStore.loadStore(nodesPath);
      if (!st) return res.json({ nodeId: null, nodes: [] });
      const view = nodesStore.redactStore(st);
      const healths = await nodesHealth.nodesHealth({
        nodes: st.nodes, home: cfg.home || os.homedir(), fetchImpl: healthFetch, now: Date.now(),
      });
      const nodes = view.nodes.map((n, i) => {
        const h = healths[i] || null;
        return { ...n, tunnel: nodesHealth.tunnelFromHealth(h), health: h };
      });
      res.json({ nodeId: view.nodeId, nodes });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  // Canonical management inventory: direct hubs/clients plus routed peers.  The
  // latter are deliberately inspect-only because they have no local nodes.json
  // record to mutate.  UI and CLI consume the same action matrix.
  api.get('/peers', async (_req, res) => {
    try {
      const st = nodesStore.loadStore(nodesPath);
      if (!st) return res.json({ nodeId: null, peers: [] });
      const direct = nodesStore.redactStore(st).nodes;
      const healths = await nodesHealth.nodesHealth({
        nodes: st.nodes, home: cfg.home || os.homedir(), fetchImpl: healthFetch, now: Date.now(),
      });
      const extras = new Map(direct.map((node, index) => {
        const health = healths[index] || null;
        return [node.name, { health, tunnel: nodesHealth.tunnelFromHealth(health) }];
      }));
      const topology = await federation.collectLocalTopology({
        nodesPath, cachePath: topologyCachePath, fetchImpl: healthFetch,
      });
      const peers = nodesInventory.buildInventory({
        direct,
        topology: topology && Array.isArray(topology.nodes) ? topology.nodes : [],
        extras,
      });
      res.json({ nodeId: st.nodeId, peers });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  // Settings API B2 (design §4b(6)): read-only GET + mutanti lista chiusa per il
  // wizard/settings UI. Dietro lo stesso requireToken del router /api; il gate
  // READONLY route-level e la redazione token vivono dentro settingsRoutes.
  api.use('/settings', settingsRoutes({ cfg, nodesPath, tokenStore, closeSessions, updater, runtimePort }));
  api.use('/diagnostics', diagnosticsRoutes({ diagnostics, readonly: proxyReadonly }));
  api.get('/topology', async (_req, res) => {
    try { res.json(await federation.collectLocalTopology({ nodesPath, cachePath: topologyCachePath })); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  api.use('/route', federation.localRouter({
    nodesPath, localPort: () => (server && server.address() ? server.address().port : cfg.port), localCredential: () => tokenHolder.value, readonly: proxyReadonly,
  }));
  api.get('/voice/status', (_req, res) => res.json({ serverSttConfigured: !!cfg.voiceUrl }));
  api.post('/voice/transcribe',
    express.raw({ type: () => true, limit: '25mb' }),
    async (req, res) => {
      try {
        const out = await transcribe(cfg, req.body, { language: String(req.query.language || 'it') });
        res.json({ text: out.text || '' });
      } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
    });
  // SSE eventi UI (notify/ask, MCP bridge §2a): EventSource non puo' settare
  // header -> il token e' accettato anche in query, SOLO perche' il bind e'
  // loopback-only (stesso pattern dell'upgrade WS del proxy /node). Montata
  // PRIMA del router /api (che e' Bearer-only) e sempre sul token live.
  app.get('/api/events', (req, res) => {
    const given = bearerFrom(req) || String(req.query.token || '');
    if (!verify(tokenHolder.value, given)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    eventsHub.handle(req, res);
  });

  app.use('/api', api);
  app.use('/federation', federation.peerRouter({
    nodesPath, localPort: () => (server && server.address() ? server.address().port : cfg.port), localCredential: () => tokenHolder.value, readonly: proxyReadonly, version: VERSION,
    fetchImpl: healthFetch,
    roles: () => require('./cli/commands.js').readRoles(cfg.configPath || configJsonPath()),
  }));

  // Reverse-proxy single-origin /node/<name>/… (design §4b(2)). Auth locale PRIMA
  // di risolvere <name>: requireToken(token) davanti al router, nessuna route
  // proxy montata prima del middleware auth. Montato PRIMA dello static/catch-all.
  app.use('/node', requireToken(tokenStore), createNodeProxy({ resolveNode, readonly: proxyReadonly }));

  app.use(express.static(distDir));
  // Deck multi-finestra (§5b): /deck/<name> serve la STESSA SPA (stesso origin,
  // stesso token via fragment). <name> e' una chiave strict client-side, mai usata
  // per costruire path: validazione ^[a-z0-9-]{1,32}$, nome invalido → 404 secco
  // (niente traversal, niente fallback silenzioso alla SPA su nomi sporchi).
  const DECK_NAME_RE = /^[a-z0-9-]{1,32}$/;
  const DECK_OWNER_RE = /^[a-f0-9]{16,64}$/;
  // Cattura TUTTO cio' che sta sotto /deck/ (anche slash/segmenti extra o encoded)
  // e valida il remainder: qualunque cosa non sia un nome deck strict → 404,
  // senza mai cadere nel catch-all SPA con un nome sporco.
  app.get(/^\/deck\/(.*)$/, (req, res) => {
    // parita' col client: deckFromPath accetta UN trailing slash (/deck/main/),
    // il server deve fare lo stesso; piu' di uno resta 404 (regex strict).
    const value = req.params[0].replace(/\/$/, '');
    const parts = value.split('/');
    const valid = (parts.length === 1 && DECK_NAME_RE.test(parts[0]))
      || (parts.length === 2 && DECK_OWNER_RE.test(parts[0]) && DECK_NAME_RE.test(parts[1]));
    if (!valid) {
      return res.status(404).type('text/plain').send('invalid deck name');
    }
    return res.sendFile(path.join(distDir, 'index.html'));
  });
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));

  server = http.createServer(app);
  // Close the watcher when the HTTP server closes. Registered HERE (inside
  // createServer) — not in start() — so every createServer consumer is covered,
  // not only the start() path. watcher.close() is idempotent.
  server.on('listening', () => {
    diagnostics.record('info', 'server', 'SERVER_STARTED', 'NexusCrew server started', {
      port: runtimePort(), platform: cfg.platform || process.platform,
    });
    updater.start(); startManagedTunnels();
  });
  server.on('close', () => {
    diagnostics.record('info', 'server', 'SERVER_STOPPED', 'NexusCrew server stopped', { reason: 'close' });
    watcher.close(); previews.close(); eventsHub.closeAll(); updater.close();
  });
  // noServer: gestiamo l'upgrade a mano per instradare /ws (locale) e /node/*
  // (proxy). Il WS locale resta identico; il proxy WS applica gli STESSI check
  // dell'HTTP (auth locale -> name strict -> inject token) prima del piping.
  wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  // Browser/mobile/tunnel possono lasciare TCP half-open senza un close event.
  // Il ping applicativo fa emergere il guasto; terminate genera un close 1006
  // lato browser, che il client riconnette senza richiedere refresh pagina.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) { try { client.terminate(); } catch (_) {} continue; }
      client.isAlive = false;
      try { client.ping(); } catch (_) { try { client.terminate(); } catch (_e) {} }
    }
  }, opts.wsHeartbeatMs || 30000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; }
    catch (_) { try { socket.destroy(); } catch (_e) {} return; }
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return;
    }
    if (pathname.startsWith('/api/route/')) {
      let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return socket.destroy(); }
      const given = bearerFrom(req) || u.searchParams.get('token') || '';
      if (!verify(tokenHolder.value, given)) return socket.destroy();
      federation.forwardUpgrade({ req, socket, head, nodesPath, localPort: runtimePort, localCredential: () => tokenHolder.value, ingress: null, readonly: proxyReadonly, activeSockets: proxySockets });
      return;
    }
    if (pathname.startsWith('/federation/route/')) {
      const ingress = federation.peerFromToken(nodesPath, bearerFrom(req));
      if (!ingress) return socket.destroy();
      federation.forwardUpgrade({ req, socket, head, nodesPath, localPort: runtimePort, localCredential: () => tokenHolder.value, ingress, readonly: proxyReadonly, activeSockets: proxySockets });
      return;
    }
    if (pathname === '/node' || pathname.startsWith('/node/')) {
      handleNodeUpgrade({
        req, socket, head, resolveNode,
        verifyToken: (t) => verify(tokenHolder.value, t),
        readonly: proxyReadonly,
        activeSockets: proxySockets,
      });
      return;
    }
    try { socket.destroy(); } catch (_) {}
  });
  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Preauth via header (B2 attach remoto): quando l'upgrade arriva dal proxy
    // /node/<name> di un hub, il proxy ha gia' iniettato `Authorization: Bearer
    // <token di QUESTO nodo>` (§4b(2)#3) mentre il frame attach porta il token
    // del hub. Un Bearer valido sull'upgrade vale come auth: e' lo STESSO
    // verify dello stesso token locale, solo su un canale diverso. I browser
    // non possono settare header sui WS -> il flusso locale resta identico
    // (token nel frame attach, mai in URL).
    const preauth = req ? verify(tokenHolder.value, bearerFrom(req)) : false;
    bindWs(ws, {
      openAttach,
      verifyToken: (t) => preauth || verify(tokenHolder.value, t),
      isValidSession: (name) => sessionExists(cfg.tmuxBin, name),
      runAction: (sess, action) => runAction(cfg.tmuxBin, sess, action),
      countClients: (sess) => attachedClients(cfg.tmuxBin, sess),
      defaults: { readonlyDefault: cfg.readonlyDefault, tmuxBin: cfg.tmuxBin },
      onAttach: (sess) => attachedWs.set(ws, sess),
    });
    ws.on('close', () => attachedWs.delete(ws));
  });

  watcher.on('change', (session, files) => {
    for (const [client, sess] of attachedWs) {
      if (sess === session && client.readyState === 1) {
        try { client.send(JSON.stringify({ type: 'files', session, files })); } catch (_) {}
      }
    }
  });

  server.on('close', () => {
    fleetP.then((fleet) => (typeof fleet.close === 'function' ? fleet.close() : null)).catch(() => {});
  });

  return { app, server, wss, cfg, token: tokenHolder.value, tokenStore, watcher, fleetP, updater, diagnostics };
}

function start(opts = {}) {
  const { server, cfg } = createServer(opts);
  const log = opts.log || console.log;
  const requestedPort = cfg.port;
  const nodesPath = opts.nodesPath || nodesStore.defaultNodesPath(cfg.home || os.homedir());
  const pairedPeers = nodesStore.hasPairedPeers(nodesStore.loadStore(nodesPath));
  const listenError = (error) => {
    if (typeof opts.onListenError === 'function') return opts.onListenError(error);
    throw error;
  };
  const onListening = () => {
    cfg.port = server.address().port;
    // Il token NON si stampa allo startup: finirebbe nei log del servizio
    // (journalctl/logfile). L'apertura autenticata passa da `nexuscrew show`.
    log(`nexuscrew on http://${cfg.bind}:${cfg.port}  (open with \`nexuscrew show\`)`);
    log('localhost-only — reach it via a user-controlled SSH or VPN channel.');
  };
  const persistFallback = () => {
    const selected = server.address().port;
    const configPath = opts.configPath || configJsonPath();
    let current = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
    } catch (_) {}
    writeConfigAtomic(configPath, { ...current, port: selected });
    log(`preferred port ${requestedPort} busy; selected ${selected}`);
    onListening();
  };
  const tryFallback = (candidate, remaining) => {
    server.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE' && remaining > 1) {
        tryFallback(candidate >= 65535 ? 41820 : candidate + 1, remaining - 1);
        return;
      }
      throw error;
    });
    server.listen(candidate, cfg.bind, persistFallback);
  };
  server.once('error', (error) => {
    if (error && error.code === 'EADDRINUSE' && requestedPort !== 0 && opts.autoPort !== false) {
      if (pairedPeers) {
        const refused = new Error(`preferred port ${requestedPort} is busy; paired peers exist, refusing automatic port change`);
        refused.code = 'EADDRINUSE_PAIRED';
        refused.cause = error;
        listenError(refused);
        return;
      }
      tryFallback(requestedPort >= 65535 ? 41820 : requestedPort + 1, 200);
      return;
    }
    listenError(error);
  });
  server.listen(requestedPort, cfg.bind, onListening);
  return server;
}

module.exports = { createServer, start };
