'use strict';
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const { defaults, loadConfig, assertLoopback } = require('./config.js');
const { listSessions, attachedClients } = require('./tmux/list.js');
const { runAction, pasteToSession } = require('./tmux/actions.js');
const { createSession, killSession, isProtectedSession } = require('./tmux/lifecycle.js');
const { createPreviewSampler } = require('./tmux/preview.js');
const { openAttach } = require('./pty/attach.js');
const { bindWs } = require('./ws/bridge.js');
const { loadOrCreateToken, verify } = require('./auth/token.js');
const { requireToken } = require('./auth/middleware.js');
const { filesRoutes } = require('./files/routes.js');
const { createOutboxWatcher } = require('./files/watcher.js');
const VERSION = require('../package.json').version;
const { transcribe } = require('./voice/transcribe.js');
const { createFleet } = require('./fleet/index.js');
const { fleetRoutes } = require('./fleet/routes.js');

function sessionExists(tmuxBin, name) {
  if (typeof name !== 'string' || !/^[\w.@%:+-]{1,128}$/.test(name)) return false;
  try { execFileSync(tmuxBin, ['has-session', '-t', `=${name}`], { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}

function createServer(opts = {}) {
  const cfg = loadConfig(opts);
  assertLoopback(cfg.bind);
  const token = loadOrCreateToken(cfg.tokenPath);
  const watcher = createOutboxWatcher({ root: cfg.filesRoot });
  const previews = createPreviewSampler(cfg.tmuxBin);
  const attachedWs = new Map(); // ws -> session (per il push dei frame files)
  const fleetP = createFleet(cfg);                  // async, non blocca il boot

  const app = express();
  const distDir = path.join(__dirname, '..', 'frontend', 'dist');
  // no-store on everything (HTML+assets+API): this is a local, token-adjacent tool.
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Tutte le /api dietro Bearer: sul loopback il gate vero è il tunnel,
  // ma il token chiude anche altri processi locali della stessa macchina.
  const api = express.Router();
  api.use(requireToken(token));
  api.get('/sessions', async (_req, res) => {
    try {
      const sessions = await listSessions(cfg.tmuxBin);
      const sum = watcher.getSummary();
      const enriched = await Promise.all(sessions.map(async (s) => ({
        ...s,
        outbox: sum[s.name] || { count: 0, latest: 0 },
        preview: await previews.get(s.name),
      })));
      res.json({ sessions: enriched });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  api.post('/sessions', express.json({ limit: '4kb' }), async (req, res) => {
    try {
      const { name, cwd, preset } = req.body || {};
      await createSession(cfg.tmuxBin, { name, cwd, preset },
        { home: os.homedir(), presets: cfg.sessionPresets });
      res.status(201).json({ created: true, name });
    } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
  });
  api.delete('/sessions/:name', async (req, res) => {
    const name = String(req.params.name || '');
    try {
      const fleet = await fleetP;
      if (isProtectedSession(name, fleet.isCellSession)) {
        return res.status(409).json({ error: 'sessione di cella: usa fleet down' });
      }
      const killed = await killSession(cfg.tmuxBin, name);
      if (!killed) return res.status(404).json({ error: 'sessione inesistente' });
      res.json({ killed: true });
    } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
  });
  api.get('/config', (_req, res) => res.json({
    readonlyDefault: cfg.readonlyDefault, version: VERSION,
    bind: cfg.bind, port: cfg.port,
    presets: ['shell', 'claude', 'codex-vl', 'pi', ...Object.keys(cfg.sessionPresets || {})],
  }));
  api.use('/files', filesRoutes({
    cfg,
    sessionExists: (name) => sessionExists(cfg.tmuxBin, name),
    paste: (session, text) => pasteToSession(cfg.tmuxBin, session, text),
  }));
  api.use('/fleet', fleetRoutes(fleetP));
  api.get('/voice/status', (_req, res) => res.json({ serverSttConfigured: !!cfg.voiceUrl }));
  api.post('/voice/transcribe',
    express.raw({ type: () => true, limit: '25mb' }),
    async (req, res) => {
      try {
        const out = await transcribe(cfg, req.body, { language: String(req.query.language || 'it') });
        res.json({ text: out.text || '' });
      } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
    });
  app.use('/api', api);

  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));

  const server = http.createServer(app);
  // Close the watcher when the HTTP server closes. Registered HERE (inside
  // createServer) — not in start() — so every createServer consumer is covered,
  // not only the start() path. watcher.close() is idempotent.
  server.on('close', () => { watcher.close(); previews.close(); });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });
  wss.on('connection', (ws) => {
    bindWs(ws, {
      openAttach,
      verifyToken: (t) => verify(token, t),
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

  return { app, server, wss, cfg, token, watcher, fleetP };
}

function start(opts = {}) {
  const { server, cfg, token } = createServer(opts);
  server.listen(cfg.port, cfg.bind, () => {
    console.log(`nexuscrew on http://${cfg.bind}:${cfg.port}  (token: ${token})`);
    console.log('localhost-only — reach it via SSH/autossh/VPN tunnel.');
  });
  return server;
}

module.exports = { createServer, start };
