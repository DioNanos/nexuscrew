'use strict';
const express = require('express');

// Router /api/fleet — fleetP è una Promise<Fleet> (createServer non diventa
// async): ogni handler attende la resolve; unavailable → 404 sui comandi.
function fleetRoutes(fleetP) {
  const r = express.Router();
  r.use(express.json({ limit: '4kb' }));

  const guard = (fn) => async (req, res) => {
    try {
      const fleet = await fleetP;
      if (!fleet.available) return res.status(404).json({ error: 'fleet non disponibile' });
      res.json(await fn(fleet, req.body || {}));
    } catch (e) {
      res.status(e.status || 500).json({ error: String(e.message || e) });
    }
  };

  r.get('/status', async (_req, res) => {
    try {
      const fleet = await fleetP;
      if (!fleet.available) return res.json({ available: false });
      res.json(await fleet.status());
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  r.post('/up', guard((f, b) => f.up(String(b.cell || ''), { engine: b.engine, boot: !!b.boot })));
  r.post('/down', guard((f, b) => f.down(String(b.cell || ''), { boot: !!b.boot })));
  r.post('/engine', guard((f, b) => f.engine(String(b.cell || ''), String(b.engine || ''))));
  r.post('/boot', guard((f, b) => f.boot(String(b.cell || ''), b.enabled === true)));
  return r;
}

module.exports = { fleetRoutes };
