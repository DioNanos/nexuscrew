'use strict';
// lib/live-host/routes.js — route /api/live-host (control plane della designazione).
//
// Montate dietro requireToken (come /api/cells, /api/fleet): solo il token del nodo
// passa. NON sono proxabili via /node/<name>: il blocklist local-only del proxy nega
// /api/live-host li' (v. lib/proxy/node-proxy.js). Sono pero' raggiungibili via
// /api/route (0.9.1), la via allowlistata della federazione, dietro un permesso
// per-peer negato di default (liveHostAccess, v. lib/proxy/federation.js) — sullo
// stesso modello del pannello: concesso dal nodo che POSSIEDE la cella, mai da chi
// chiede. Senza quel permesso il peer riceve un rifiuto che nomina la causa
// (`live-host-not-granted`), non un silenzio.
//
// Invarianti (contratto rev6 §2, §9):
//   - hostCell unico per nodo, CAS su revision (due designazioni concorrenti non
//     lasciano due celle rosse).
//   - API-first: la route e' l'unica autorita'; il frontend riflette la risposta e
//     su errore resta sullo stato precedente (nessun ottimismo qui — la logica UI
//     sta nel modulo frontend host-designation.js).
//   - Cella inattiva PRESERVA la designazione: lo store non cancella mai hostCell per
//     inattivita; `eligible` e' derivato dal roster al momento del GET.
//   - readonly => 403 su designate/clear.

const express = require('express');
const { CELL_ID_RE } = require('./store.js');

// Ricava l'elenco celle LOCALI dal fleet (definizioni, attive e non). Una cella
// federata non compare qui: e' il check che chiude "designa solo una cella di questo
// nodo". Ritorna null se il fleet non e' interrogabile (la route decide come gestirlo).
async function localCells(fleetP) {
  const fleet = await fleetP;
  if (!fleet || fleet.available !== true) return null;
  const statusFn = fleet && (typeof fleet.status === 'function' ? fleet.status : fleet.cellStatus);
  if (typeof statusFn !== 'function') return null;
  const st = await statusFn.call(fleet);
  return Array.isArray(st && st.cells) ? st.cells : [];
}

function isActive(cell) {
  return !!(cell && cell.active === true && cell.tmux !== false);
}

// --- Seam lease↔designazione (2026-08-15, decisione di Dev: grace = false) -----
//
// L'idoneita' dell'host designato non e' piu' solo «sessione tmux viva»: con
// remain-on-exit la sessione sopravvive alla morte del supervisore, e la
// garanzia «l'host designato e' vivo» la puo' dare SOLO il lease (fetta 2b: il
// leaseId e' FIRMATO nel proof, quindi lo stato del lease identifica senza
// ambiguita' chi lo detiene). Regole:
//   - eligible = attiva AND lease 'live'. In grace NON c'e' garanzia: eligible
//     false, ma host.lease='grace' dice «recupero in corso» — chi legge
//     distingue «non idonea perche' morta» da «non idonea perche' in recupero».
//   - I cinque stati (live|grace|expired|none|unavailable) restano DISTINCTI
//     fino a chi legge: collassarli e' rifare il difetto a un piano piu' su.
//   - FALLBACK FAIL-OPEN DICHIARATO: senza fleet.lease (installazione senza
//     lease) eligible torna tmux-only e host.lease='unavailable'. Non e' «va
//     bene lo stesso»: e' «la garanzia non e' disponibile qui», detto esplicito
//     perche' un eligible=true silenzioso verrebbe letto come confermata.
//   - hostCell resta PRESERVATO in ogni caso (invariante dello store): oscilla
//     l'idoneita', non la scelta dell'operatore.
function hostLeaseState(fleet, hostCell) {
  if (hostCell == null) return null;
  const lease = fleet && fleet.lease;
  if (!lease || typeof lease.status !== 'function') return 'unavailable';
  const st = lease.status(hostCell);
  return (st && typeof st.state === 'string') ? st.state : 'none';
}

function eligibleOf(fleet, cell, hostCell) {
  const leaseState = hostLeaseState(fleet, hostCell);
  if (leaseState === null) return false; // senza soggetto non c'e' idoneita'
  if (leaseState === 'unavailable') return isActive(cell); // fail-open dichiarato
  return isActive(cell) && leaseState === 'live';
}

function liveHostRoutes({ fleetP, store, readonly = () => false, now = () => Date.now(), bridge = null }) {
  const r = express.Router();

  // GET /api/live-host — { hostCell, revision, eligible, host: {lease}, at }.
  // hostCell e revision vengono dallo store (preservato); eligible e' la verita'
  // COMPOSTA roster+lease (si veda hostLeaseState sopra); host.lease espone lo
  // stato del lease della cella designata, distinto, perche' chi legge distingue.
  r.get('/', async (_req, res) => {
    try {
      const snap = store.snapshot();
      let eligible = false;
      let lease = null;
      if (snap.hostCell != null) {
        const fleet = await fleetP.catch(() => null);
        const cells = await localCells(fleetP).catch(() => []);
        const cell = Array.isArray(cells) ? cells.find((c) => c && c.cell === snap.hostCell) : null;
        lease = hostLeaseState(fleet, snap.hostCell);
        eligible = eligibleOf(fleet, cell, snap.hostCell);
      }
      res.json({ hostCell: snap.hostCell, revision: snap.revision, eligible, host: { lease }, at: now() });
    } catch (e) {
      res.status(500).json({ error: String(e && e.message || e) });
    }
  });

  // POST /api/live-host/designate { cellId, expectedRevision }.
  // expectedRevision e' OBBLIGATORIO e integer (>=0): nessun CAS permissivo, la UI
  // legge sempre la revision dal GET prima di scrivere (stato iniziale = 0).
  // cellId deve appartenere al roster LOCALE di questo nodo — chiamante locale
  // o peer federato con liveHostAccess, la cella designabile e' sempre e solo
  // una di QUESTO nodo, mai una del chiamante.
  r.post('/designate', express.json({ limit: '4kb' }), async (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: designazione cella ospite bloccata' });
    const body = req.body || {};
    if (Object.keys(body).some((k) => !['cellId', 'expectedRevision'].includes(k))
      || typeof body.cellId !== 'string' || !CELL_ID_RE.test(body.cellId)
      || !(Number.isInteger(body.expectedRevision) && body.expectedRevision >= 0)) {
      return res.status(400).json({ error: 'designazione non valida' });
    }
    try {
      const fleet = await fleetP.catch(() => null);
      const cells = await localCells(fleetP);
      if (cells === null) return res.status(503).json({ error: 'fleet non disponibile, riprova' });
      const cell = cells.find((c) => c && c.cell === body.cellId);
      if (!cell) return res.status(404).json({ error: 'cella non appartiene a questo nodo' });
      const result = await store.compareAndSet(body.expectedRevision, body.cellId);
      if (!result.ok) return res.status(409).json({
        error: 'revision superata: rileggi e riprova', revision: result.revision, hostCell: result.hostCell,
      });
      res.json({
        hostCell: result.hostCell, revision: result.revision,
        eligible: eligibleOf(fleet, cell, result.hostCell),
        host: { lease: hostLeaseState(fleet, result.hostCell) },
        at: now(),
      });
    } catch (e) {
      res.status(500).json({ error: String(e && e.message || e) });
    }
  });

  // POST /api/live-host/clear { expectedRevision } — rimuove la designazione (CAS).
  r.post('/clear', express.json({ limit: '4kb' }), async (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: rimozione cella ospite bloccata' });
    const body = req.body || {};
    if (Object.keys(body).some((k) => k !== 'expectedRevision')
      || !(Number.isInteger(body.expectedRevision) && body.expectedRevision >= 0)) {
      return res.status(400).json({ error: 'rimozione non valida' });
    }
    try {
      const result = await store.compareAndSet(body.expectedRevision, null);
      if (!result.ok) return res.status(409).json({
        error: 'revision superata: rileggi e riprova', revision: result.revision, hostCell: result.hostCell,
      });
      res.json({ hostCell: null, revision: result.revision, at: now() });
    } catch (e) {
      res.status(500).json({ error: String(e && e.message || e) });
    }
  });

  // POST /api/live-host/bridge — risolve il puntamento per l'avvio di una Live
  // (fetta 3). La richiesta NON è parametrizzabile: la designazione è la
  // condizione (LC3) e nessun chiamante può scegliere il target (MC3.4). Il
  // ponte risponde sempre 200: i `none` con reason sono esiti legittimi e
  // distinti (nessuna designazione / cella non idonea / fallback), non errori.
  // Body opzionale e vuoto: un body con campi è un 400, non viene ignorato.
  r.post('/bridge', express.json({ limit: '1kb' }), async (req, res) => {
    const body = req.body || {};
    if (Object.keys(body).length > 0) return res.status(400).json({ error: 'la risoluzione non accetta parametri' });
    if (readonly()) return res.json({ mode: 'none', reason: 'readonly', at: now() });
    if (!bridge) return res.status(503).json({ error: 'ponte Live non configurato su questo nodo' });
    try {
      const result = await bridge.resolveForLive();
      res.json(result);
    } catch (e) {
      // Il contratto (MC1.5) vuole che un guasto del ponte non fermi la Live:
      // anche l'inaspettato collassa in `none` dichiarato, mai un 500.
      // `bridge-error` e' l'ultima rete: un'eccezione che nessun ramo previsto ha
      // classificato. Va NOMINATA come le altre, non lasciata fuori dall'elenco
      // — una causa non dichiarata e' una causa che nessuno cerchera'.
      res.json({ mode: 'none', reason: 'bridge-error', detail: String(e && e.message || e), at: now() });
    }
  });

  // Stesso body-error handling di cellsRoutes: payload troppo grande / JSON invalido.
  r.use((err, _req, res, _next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(413).json({ error: 'body troppo grande' });
    }
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'JSON non valido' });
    return res.status(err.status || 400).json({ error: String(err.message || err) });
  });

  return r;
}

module.exports = { liveHostRoutes };
