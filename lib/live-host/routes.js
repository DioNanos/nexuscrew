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
// Invariants (host-cell designation contract):
//   - hostCell unico per nodo, CAS su revision (due designazioni concorrenti non
//     lasciano due celle rosse).
//   - API-first: la route e' l'unica autorita'; il frontend riflette la risposta e
//     su errore resta sullo stato precedente (nessun ottimismo qui — la logica UI
//     sta nel modulo frontend host-designation.js).
//   - Cella inattiva PRESERVA la designazione: lo store non cancella mai hostCell per
//     inattivita; `eligible` e' derivato dal roster al momento del GET.
//   - readonly => 403 su designate/clear.
//
// Fuori dal perimetro del binding MCP: designate/clear/bridge sono superficie di
// gestione locale dell'operatore, non effetti richiesti da una cella tramite il
// bridge. Il token del nodo resta l'autorita'; il binding shared non e' richiesto.

const express = require('express');
const { CELL_ID_RE } = require('./store.js');
const { HOP_HEADER } = require('../proxy/hop-proof.js');

// Il ponte federato non nasce da una cella: nasce dal nodo che ospita la
// pagina/app-server. L'identita' che si puo' PROVARE e' quindi il nodo, e il
// budget si conta per nodo mittente; questa costante tiene il posto della cella
// nella chiave (v. lib/audio/rate-limit.js: originKey vuole {node, cell}) e vale
// anche come nome del target quando il nodo non ha una designazione da nominare.
const LIVE_HOST_BUCKET = 'live-host';

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

// --- Seam lease↔designazione (decisione presa in revisione: grace = false) -----
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
//   - FALLBACK FAIL-CLOSED: senza fleet.lease (installazione senza lease)
//     eligible resta false e host.lease='unavailable'. L'attach locale D resta
//     disponibile al suo percorso, ma il dispatch Live non può diventare
//     tmux-only senza la garanzia del lease.
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
  if (leaseState === 'unavailable') return false;
  return isActive(cell) && leaseState === 'live';
}

function liveHostRoutes({ fleetP, store, readonly = () => false, now = () => Date.now(), bridge = null,
  // Federazione della designazione remota. `federation` (client seam:
  // getOwnerState/bridgeForward/ownerRoute) e' presente solo sul nodo CLIENT;
  // `originResolver` + `federatedRate` attivano la via federata DEL PROPRIETARIO:
  // una richiesta con prova di hop puo' portare `{expect}` (unico campo) e deve
  // coincidere con la designazione locale, altrimenti 409 nominato. Assenti
  // (test parziali) le route restano esattamente quelle locali di prima.
  // Sul ramo federato l'origine NON e' un campo del body: e' il risultato di una
  // verifica (prova di hop + catena `visited` costruita dal server), e il budget
  // del ponte si applica per NODO mittente ATTESTATO — stessa regola e stessi
  // limiti dell'audio (lib/audio/rate-limit.js).
  federation = null, originResolver = null, federatedRate = null }) {
  const r = express.Router();

  // Una designazione con `ownerId` e' REMOTA: il puntamento vive qui,
  // la verita' (thread/eligible/lease) vive sul proprietario. Lo stato del
  // proprietario arriva via GET federata; irraggiungibile => threadStatus
  // 'unknown' con reason NOMINATO, mai un fallback su una cella locale.
  async function remoteOwnerState(snap) {
    if (!federation || typeof federation.getOwnerState !== 'function') {
      return { reason: 'live-host-federation-unavailable' };
    }
    const out = await federation.getOwnerState({ ownerId: snap.ownerId }).catch(() => ({ ok: false, reason: 'live-host-owner-unreachable' }));
    if (!out || out.ok !== true || !out.body) return { reason: 'live-host-owner-unreachable' };
    const b = out.body;
    return {
      state: {
        eligible: b.eligible === true,
        threadStatus: b.threadStatus || 'unknown',
        host: b.host || null,
      },
    };
  }

  // GET /api/live-host — { hostCell, revision, eligible, threadStatus,
  // host: {lease}, at }. threadStatus misura il runtime del thread ponte:
  // absent/present/active/unknown; non dichiara la presenza del client Live.
  // hostCell e revision vengono dallo store (preservato); eligible e' la verita'
  // COMPOSTA roster+lease (si veda hostLeaseState sopra); host.lease espone lo
  // stato del lease della cella designata, distinto, perche' chi legge distingue.
  r.get('/', async (_req, res) => {
    try {
      const snap = store.snapshot();
      if (snap.hostCell != null && snap.ownerId) {
        const remote = await remoteOwnerState(snap);
        return res.json({
          hostCell: snap.hostCell, revision: snap.revision, ownerId: snap.ownerId, remote: true,
          eligible: remote.state ? remote.state.eligible : false,
          threadStatus: remote.state ? remote.state.threadStatus : 'unknown',
          host: remote.state ? remote.state.host : null,
          ...(remote.reason ? { reason: remote.reason } : {}),
          at: now(),
        });
      }
      let eligible = false;
      let lease = null;
      let threadStatus = 'absent';
      if (snap.hostCell != null) {
        const fleet = await fleetP.catch(() => null);
        const cells = await localCells(fleetP).catch(() => []);
        const cell = Array.isArray(cells) ? cells.find((c) => c && c.cell === snap.hostCell) : null;
        lease = hostLeaseState(fleet, snap.hostCell);
        eligible = eligibleOf(fleet, cell, snap.hostCell);
        if (bridge && typeof bridge.threadStatus === 'function') {
          threadStatus = await Promise.resolve(bridge.threadStatus(snap.hostCell)).catch(() => 'unknown');
        } else {
          threadStatus = 'unknown';
        }
      }
      res.json({ hostCell: snap.hostCell, revision: snap.revision, eligible, threadStatus, host: { lease }, at: now() });
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
  // (fetta 3). La richiesta NON è parametrizzabile dal chiamante: la
  // designazione è la condizione, e nessun chiamante sceglie il target — ma la
  // designazione ora può puntare FUORI nodo, e in
  // quel caso questo nodo (client) INOLTRA la risoluzione al proprietario
  // (stessa richiesta, senza parametri di scelta; `expect` è l'attestazione di
  // cosa il client sta puntando, verificata dal proprietario). Il ponte
  // risponde sempre 200: i `none` con reason sono esiti legittimi e distinti
  // (nessuna designazione / cella non idonea / fallback), non errori.
  // Body opzionale e vuoto: un body con campi è un 400, non viene ignorato —
  // eccezione: sul PERCORSO FEDERATO (prova di hop) il proprietario accetta
  // `{expect:{hostCell,revision}}` e lo verifica contro la propria
  // designazione (mismatch = 409 nominato); il gate `liveHostAccess` del peer
  // è già stato applicato dall'ingresso federato (federation.js).
  r.post('/bridge', express.json({ limit: '1kb' }), async (req, res) => {
    const body = req.body || {};
    const federated = !!(originResolver && req.headers && req.headers[HOP_HEADER]);
    if (federated) {
      const keys = Object.keys(body);
      if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'expect')) {
        return res.status(400).json({ error: 'la risoluzione non accetta parametri' });
      }
      // Budget federato. L'origine la da' l'originResolver, che verifica la prova
      // di hop e la catena controllata dal server: la stringa `visited` letta a
      // mano non e' un'attribuzione, e un limiter interrogato con la forma
      // sbagliata (`allow` invece di `check`) non limita nulla — era il difetto.
      // Una richiesta la cui origine non e' verificabile viene rifiutata qui,
      // non servita senza budget: fail-closed, mai un limite saltato in silenzio.
      if (federatedRate) {
        const resolved = typeof originResolver.resolve === 'function'
          ? await originResolver.resolve(req, { requireCell: false })
          : { ok: false, reason: 'no-origin-resolver' };
        if (!resolved || resolved.ok !== true) {
          return res.status(403).json({
            error: 'origine federata non verificabile', reason: 'live-host-origin-unverified',
            detail: (resolved && resolved.reason) || 'unknown',
          });
        }
        const quota = federatedRate.check({
          origin: { node: resolved.origin.node, cell: LIVE_HOST_BUCKET },
          target: store.snapshot().hostCell || LIVE_HOST_BUCKET,
          urgency: 'normal',
        });
        if (!quota.allowed) {
          return res.status(429).json({
            error: 'troppo frequente', reason: 'rate-limited',
            bucket: quota.bucket, retryInMs: quota.retryInMs,
          });
        }
      }
      const snap = store.snapshot();
      if (keys.length === 1) {
        const expect = body.expect || {};
        const okExpect = expect && typeof expect.hostCell === 'string'
          && Number.isInteger(expect.revision)
          && expect.hostCell === snap.hostCell && expect.revision === snap.revision;
        if (!okExpect) {
          return res.status(409).json({
            error: 'la designazione del proprietario non coincide con quella dichiarata dal client',
            reason: 'live-host-expectation-mismatch',
            revision: snap.revision, hostCell: snap.hostCell, at: now(),
          });
        }
      }
      if (readonly()) return res.json({ mode: 'none', reason: 'readonly', at: now() });
      if (!bridge) return res.status(503).json({ error: 'ponte Live non configurato su questo nodo' });
      try {
        const result = await bridge.resolveForLive();
        res.json(result);
      } catch (e) {
        res.json({ mode: 'none', reason: 'bridge-error', detail: String(e && e.message || e), at: now() });
      }
      return;
    }
    const snap = store.snapshot();
    if (snap.hostCell != null && snap.ownerId) {
      // Nodo CLIENT con host remoto: inoltra al proprietario, mai un
      // fallback su una cella locale (il chiamante non sceglie il target: lo
      // sceglie la designazione, che punta fuori nodo).
      if (!federation || typeof federation.bridgeForward !== 'function') {
        return res.status(503).json({ mode: 'none', reason: 'live-host-federation-unavailable', at: now() });
      }
      const out = await federation.bridgeForward({
        ownerId: snap.ownerId,
        expect: { hostCell: snap.hostCell, revision: snap.revision },
      }).catch(() => ({ ok: false, reason: 'live-host-owner-unreachable' }));
      if (!out) {
        return res.status(502).json({ mode: 'none', reason: 'live-host-owner-unreachable', at: now() });
      }
      // The owner's DECIDABLE answers come first: a refusal and a moved
      // designation are decisions, not failures. Flattening them into
      // "unreachable" would hide exactly what the operator has to fix.
      if (out.status === 403 || out.reason === 'live-host-not-granted') {
        return res.status(403).json({ mode: 'none', reason: 'live-host-not-granted', at: now() });
      }
      if (out.status === 409 || out.reason === 'live-host-expectation-mismatch') {
        return res.status(409).json({
          error: 'la designazione del proprietario non coincide con quella dichiarata dal client',
          reason: 'live-host-expectation-mismatch', at: now(),
        });
      }
      if (out.ok !== true) {
        // Whatever else the owner answered: our own name plus the status we saw,
        // never a peer string we did not check — and never "unreachable" for a
        // node that did answer.
        const reason = out.reason === 'live-host-owner-unreachable' ? 'live-host-owner-unreachable' : 'live-host-owner-rejected';
        return res.status(502).json({
          mode: 'none', reason,
          ...(Number.isInteger(out.status) ? { ownerStatus: out.status } : {}), at: now(),
        });
      }
      const ownerBody = out.body || { mode: 'none', reason: 'bridge-error' };
      const route = federation.ownerRoute
        ? await federation.ownerRoute(snap.ownerId).catch(() => null) : null;
      return res.json({ ...ownerBody, owner: snap.ownerId, ...(Array.isArray(route) && route.length ? { route } : {}), at: now() });
    }
    if (Object.keys(body).length > 0) return res.status(400).json({ error: 'la risoluzione non accetta parametri' });
    if (readonly()) return res.json({ mode: 'none', reason: 'readonly', at: now() });
    if (!bridge) return res.status(503).json({ error: 'ponte Live non configurato su questo nodo' });
    try {
      const result = await bridge.resolveForLive();
      res.json(result);
    } catch (e) {
      // Il contratto vuole che un guasto del ponte non fermi la Live:
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
