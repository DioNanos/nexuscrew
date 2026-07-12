'use strict';
const express = require('express');

// Capability minime del contratto storico per i fleet external/legacy che NON
// dichiarano capabilities() (design §9c): status/up/down/engine/boot.
// Il built-in B4 aggiunge define/edit/remove/schema.
const DEFAULT_CAPS = ['status', 'up', 'down', 'engine', 'boot'];

function capList(fleet) {
  return typeof fleet.capabilities === 'function' ? fleet.capabilities() : DEFAULT_CAPS;
}

// Design §9c: una route per un metodo non supportato dal provider ritorna 501
// (mai 404/502 ambigui). Gli errori nativi del builtin (400/403/409) passano
// invece nel guard con il loro status.
function requireCap(fleet, cap) {
  if (!capList(fleet).includes(cap)) {
    const e = new Error('not supported by this fleet provider');
    e.status = 501;
    throw e;
  }
}

// Router /api/fleet — fleetP è una Promise<Fleet> (createServer non diventa
// async): ogni handler attende la resolve; unavailable → 404 sui comandi.
function fleetRoutes(fleetP, cfg = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '4kb' }));

  const readonly = () => (cfg.readonlyDefault === true || process.env.NEXUSCREW_READONLY === '1');

  const guard = (fn, opts = {}) => async (req, res) => {
    try {
      // READONLY e' un gate di prodotto, non solo del provider built-in: deve
      // bloccare anche il fleet esterno legacy prima che tocchi systemd/tmux reali.
      if (opts.mutate && readonly()) return res.status(403).json({ error: 'READONLY: mutazione fleet bloccata' });
      const fleet = await fleetP;
      if (!fleet.available) return res.status(404).json({ error: 'fleet non disponibile' });
      res.json(await fn(fleet, req.body || {}));
    } catch (e) {
      res.status(e.status || 500).json({ error: String(e.message || e) });
    }
  };

  // /status espone anche `provider` e `capabilities` (design §9b/§9c), oltre ai
  // campi storici (available/cells/engines). Provider senza capabilities()
  // (external legacy) → DEFAULT_CAPS; external senza campo provider → 'external'.
  r.get('/status', async (_req, res) => {
    try {
      const fleet = await fleetP;
      if (!fleet.available) {
        return res.json({
          available: false,
          provider: fleet.provider || 'disabled',
          bootOwner: 'none', // §9b: provider non disponibile -> nessun boot owner
          capabilities: capList(fleet),
        });
      }
      const st = await fleet.status();
      const provider = st.provider || fleet.provider || 'external';
      // bootOwner (§9b): preferisce quello dichiarato dal provider (st.bootOwner);
      // altrimenti deriva dal mode: builtin -> 'builtin', disabled -> 'none',
      // external -> 'external'. Contratto valori: 'builtin' | 'external' | 'none'.
      const bootOwner = st.bootOwner || (provider === 'builtin' ? 'builtin' : provider === 'disabled' ? 'none' : 'external');
      res.json({
        ...st,
        provider,
        bootOwner,
        capabilities: capList(fleet),
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // /up: il built-in (capability 'edit') è definitions-driven — se il body porta
  // un engine lo persiste sulla cella (f.engine) PRIMA di up, perché l'engine
  // dichiarato vince sull'override runtime (ignored dal builtin.up).
  // External legacy: passthrough up(cell,{engine,boot}) invariato.
  r.post('/up', guard(async (f, b) => {
    const cell = String(b.cell || '');
    if (b.engine && capList(f).includes('edit')) {
      const opts = { model: typeof b.model === 'string' ? b.model : '' };
      if (typeof b.permissionPolicy === 'string') opts.permissionPolicy = b.permissionPolicy;
      await f.engine(cell, String(b.engine), opts);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'boot') && capList(f).includes('edit') && capList(f).includes('boot')) {
      await f.boot(cell, b.boot === true);
    }
    return f.up(cell, { engine: b.engine, boot: !!b.boot });
  }, { mutate: true }));
  r.post('/down', guard(async (f, b) => {
    const cell = String(b.cell || '');
    if (b.boot === true && capList(f).includes('edit') && capList(f).includes('boot')) await f.boot(cell, false);
    return f.down(cell, { boot: !!b.boot });
  }, { mutate: true }));
  r.post('/restart', guard((f, b) => { requireCap(f, 'restart'); return f.restart(String(b.cell || '')); }, { mutate: true }));
  r.post('/engine', guard((f, b) => {
    const opts = { model: typeof b.model === 'string' ? b.model : '' };
    if (typeof b.permissionPolicy === 'string') opts.permissionPolicy = b.permissionPolicy;
    return f.engine(String(b.cell || ''), String(b.engine || ''), opts);
  }, { mutate: true }));
  r.post('/boot', guard((f, b) => f.boot(String(b.cell || ''), b.enabled === true), { mutate: true }));

  // --- Estensione B4.2: schema + define/edit/remove (engine e cell) ---
  // Ogni route negozia la capability del provider: mancante → 501 (§9c).
  r.get('/schema', guard((f) => { requireCap(f, 'schema'); return f.schema(); }));
  r.get('/definitions', guard((f) => { requireCap(f, 'definitions'); return f.definitions(); }));
  r.post('/define-engine', guard((f, b) => { requireCap(f, 'define'); return f.defineEngine(b.def); }, { mutate: true }));
  r.post('/edit-engine', guard((f, b) => { requireCap(f, 'edit'); return f.editEngine(b.id, b.patch, b.envChanges); }, { mutate: true }));
  r.post('/remove-engine', guard((f, b) => { requireCap(f, 'remove'); return f.removeEngine(b.id); }, { mutate: true }));
  r.post('/define-cell', guard((f, b) => { requireCap(f, 'define'); return f.defineCell(b.def); }, { mutate: true }));
  r.post('/edit-cell', guard((f, b) => { requireCap(f, 'edit'); return f.editCell(b.id, b.patch); }, { mutate: true }));
  r.post('/remove-cell', guard((f, b) => { requireCap(f, 'remove'); return f.removeCell(b.id, { stop: b.stop === true }); }, { mutate: true }));
  // Riconciliazione sessione tmux esistente (cella Fleet legacy orfana) in cella
  // gestita fleet.json. Capability 'define' (solo builtin): external legacy -> 501.
  r.post('/import-cell', guard(async (f, b) => { requireCap(f, 'import'); return f.importCell(b || {}); }, { mutate: true }));

  return r;
}

module.exports = { fleetRoutes };
