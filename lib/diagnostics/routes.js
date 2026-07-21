'use strict';
const express = require('express');

function diagnosticsRoutes({ diagnostics, readonly = () => false } = {}) {
  if (!diagnostics) throw new Error('diagnostics store required');
  const router = express.Router();
  router.use(express.json({ limit: '2kb' }));
  const mutGate = (_req, res, next) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: mutazione diagnostica bloccata' });
    next();
  };

  router.get('/status', (_req, res) => res.json(diagnostics.status()));
  router.get('/logs', (req, res) => {
    try {
      const keys = Object.keys(req.query || {});
      if (keys.some((key) => !['after', 'limit'].includes(key))) return res.status(400).json({ error: 'query non valida' });
      const after = req.query.after === undefined ? 0 : Number(req.query.after);
      const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
      res.json(diagnostics.logs({ after, limit }));
    } catch (error) { res.status(400).json({ error: String(error.message || error) }); }
  });
  router.patch('/verbose', mutGate, (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((key) => !['enabled', 'durationSeconds'].includes(key))) {
        return res.status(400).json({ error: 'body non valido' });
      }
      res.json(diagnostics.setVerbose(body.enabled, body.durationSeconds === undefined ? 900 : body.durationSeconds));
    } catch (error) { res.status(400).json({ error: String(error.message || error) }); }
  });
  router.delete('/logs', mutGate, (_req, res) => res.json(diagnostics.clear()));

  router.use((error, _req, res, _next) => {
    if (error && error.type === 'entity.too.large') return res.status(413).json({ error: 'body troppo grande' });
    if (error instanceof SyntaxError) return res.status(400).json({ error: 'JSON non valido' });
    return res.status(400).json({ error: String(error.message || error) });
  });
  return router;
}

module.exports = { diagnosticsRoutes };
