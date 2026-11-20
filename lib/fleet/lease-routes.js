'use strict';
// lib/fleet/lease-routes.js — route /api/lease, superficie child della fetta 2b
// (contract: three distinct methods + the MCP↔leaseManager link).
//
// Il bridge MCP di una cella (`nexuscrew mcp`) parla con l'HTTP API locale dietro
// Bearer (canale nativo del bridge): queste route sono quel collegamento.
// La CELLA si risolve sul catalogo fleet CORRENTE validato dal parser: la
// sessione EFFETTIVA dichiarata (override, altrimenti il default canonico)
// seleziona la cella nel percorso legacy; in authority il subject resta il
// proof verificato e la sessione del body è solo un confronto anti-confusione.
// La sessione nel body NON è una credenziale, e nessun prefisso o listing tmux
// decide la cella: il confronto è esatto sul nome effettivo dichiarato.

const express = require('express');
const { CELL_ID_RE, validTmuxName } = require('./definitions.js');
const { createIdentityBindingGuard } = require('../identity/binding-guard.js');

const LEASE_CATALOG_UNAVAILABLE = 'LEASE_CATALOG_UNAVAILABLE';
const LEASE_SESSION_INVALID = 'LEASE_SESSION_INVALID';
const LEASE_CELL_INVALID = 'LEASE_CELL_INVALID';
const LEASE_SESSION_MISMATCH = 'LEASE_SESSION_MISMATCH';

const MSG = {
  [LEASE_CATALOG_UNAVAILABLE]: 'fleet catalog not available for the lease',
  [LEASE_SESSION_INVALID]: 'missing, malformed or undeclared session',
  [LEASE_CELL_INVALID]: 'proof without a declared cell',
  [LEASE_SESSION_MISMATCH]: 'body session differs from the cell\'s effective session',
};

// --- Resolver stretto -------------------------------------------------------
// Il catalogo del lease è la fotografia {cells:[{id,tmuxSession}]} del provider
// (`fleet.leaseCellCatalog`): stessa sorgente delle definizioni, letta e
// validata ADESSO — non la vista cached delle UI, che conserva l'ultimo
// documento valido e non attesta che il catalogo corrente sia leggibile.
function snapshotValido(cells) {
  const ids = new Set();
  const sessions = new Set();
  for (const c of cells) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
    if (typeof c.id !== 'string' || !CELL_ID_RE.test(c.id) || ids.has(c.id)) return false;
    if (typeof c.tmuxSession !== 'string' || !validTmuxName(c.tmuxSession) || sessions.has(c.tmuxSession)) return false;
    ids.add(c.id);
    sessions.add(c.tmuxSession);
  }
  return true;
}

function catalogCells(fleet, res) {
  let out = null;
  try {
    out = fleet && typeof fleet.leaseCellCatalog === 'function' ? fleet.leaseCellCatalog() : null;
  } catch (_) { out = null; }
  if (!out || typeof out !== 'object' || out.ok !== true || !Array.isArray(out.cells)
    || !snapshotValido(out.cells)) {
    res.status(503).json({ error: MSG[LEASE_CATALOG_UNAVAILABLE], code: LEASE_CATALOG_UNAVAILABLE });
    return null;
  }
  return out.cells;
}

// Confronto ESATTO (===, senza trim/normalizzazione/decodifica): zero candidati
// è un rifiuto, più di una è un catalogo ambiguo (rifiuto, mai «la prima»).
function bySession(cells, session) {
  if (typeof session !== 'string' || !validTmuxName(session)) {
    return { error: LEASE_SESSION_INVALID };
  }
  const found = [];
  for (const c of cells) if (c.tmuxSession === session) found.push(c);
  if (found.length === 1) return { cell: found[0] };
  return { error: found.length > 1 ? LEASE_CATALOG_UNAVAILABLE : LEASE_SESSION_INVALID };
}

// L'id deve essere dichiarato e UNICO; anche la sua sessione effettiva deve
// appartenere a una sola candidata nello stesso snapshot.
function byCell(cells, id) {
  if (typeof id !== 'string' || !CELL_ID_RE.test(id)) return { error: LEASE_CELL_INVALID };
  let found = null;
  for (const c of cells) {
    if (c.id === id) {
      if (found) return { error: LEASE_CATALOG_UNAVAILABLE };
      found = c;
    }
  }
  if (!found) return { error: LEASE_CELL_INVALID };
  let perSession = 0;
  for (const c of cells) if (c.tmuxSession === found.tmuxSession) perSession += 1;
  if (perSession !== 1) return { error: LEASE_CATALOG_UNAVAILABLE };
  return { cell: found };
}

function reject(res, code) {
  return res.status(code === LEASE_CATALOG_UNAVAILABLE ? 503 : 400).json({ error: MSG[code], code });
}

// La sessione opzionale del body, quando presente, deve coincidere ESATTAMENTE
// con la sessione effettiva della cella: anche null, stringa vuota o un tipo
// errato sono un valore presente da rifiutare, mai da correggere.
function sessioneCorretta(req, cell, res) {
  const declared = req.body && req.body.session;
  if (declared === undefined || declared === cell.tmuxSession) return true;
  reject(res, LEASE_SESSION_MISMATCH);
  return false;
}

function leaseRoutes({
  fleetP, readonly = () => false, log = () => {}, identityAuthority = null,
  identityAudience = 'nexuscrew-lease', identityMode = 'legacy', instanceId = null,
}) {
  const bindingGuard = createIdentityBindingGuard({
    fleetP, instanceId, now: () => Date.now(),
    // refresh/recovery hanno gia il proof child come authorizer nel body. Il
    // binding MCP, quando presentato, viene verificato fail-closed; l'assenza
    // Preserva il canale nativo lease (D) che esisteva prima di .
    sharedRequired: false,
  });

  async function guardBinding(req, cell) {
    try {
      return await bindingGuard.verify(req, { expected: { cell }, localOnly: true });
    } catch (e) {
      return e;
    }
  }

  function bindingRejected(res, error) {
    return res.status(403).json({ error: error.message, code: error.code });
  }
  const r = express.Router();
  const smallJson = express.json({ limit: '8kb' });
  if (identityMode !== 'legacy' && identityMode !== 'authority') {
    throw new Error('fleet.identity.mode non valido');
  }
  const mode = identityMode;

  const guard = (fn) => async (req, res) => {
    try {
      const fleet = await fleetP;
      if (!fleet || fleet.available !== true) return res.status(404).json({ error: 'fleet not available' });
      // The link lives vive sul provider — senza leaseManager (lease
      // disattivato) e' 501, non 500: la capability manca, non e' un guasto.
      if (!fleet.lease || typeof fleet.lease.childRegister !== 'function') {
        return res.status(501).json({ error: 'lease non disponibile su questo nodo' });
      }
      return await fn(fleet.lease, req, res, fleet);
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  };

  const requireProof = (req, res) => {
    const proof = req.body && req.body.proof;
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
      res.status(400).json({ error: 'proof mancante o malformato' });
      return null;
    }
    return proof;
  };

  // Claim id del proof child: controllo SINTATTICO. Che la cella sia dichiarata
  // lo decide il catalogo, dopo; e la verifica crittografica resta al manager.
  const claimIdChecked = (req, res) => {
    const proof = req.body && req.body.proof;
    const claimId = proof && proof.cellId;
    if (typeof claimId !== 'string' || !CELL_ID_RE.test(claimId)) {
      reject(res, LEASE_CELL_INVALID);
      return null;
    }
    return claimId;
  };

  r.post('/register', smallJson, guard((lease, req, res, fleet) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: lease child bloccato' });
    let cell;
    if (mode === 'authority') {
      const proof = requireProof(req, res);
      if (!proof) return undefined;
      const authority = identityAuthority || fleet.identityAuthority;
      if (!authority || typeof authority.verifyChallengeProof !== 'function') {
        return res.status(501).json({ error: 'identity authority non disponibile' });
      }
      const checked = authority.verifyChallengeProof(proof, { audience: identityAudience });
      if (!checked.ok) return res.json({ status: 'denied', reason: checked.reason });
      // Il subject è il claim VERIFICATO: nessuna derivazione dal body.
      const subject = checked.claims.cellId;
      const cells = catalogCells(fleet, res);
      if (!cells) return undefined;
      const found = byCell(cells, subject);
      if (found.error) return reject(res, found.error);
      if (!sessioneCorretta(req, found.cell, res)) return undefined;
      cell = subject;
    } else {
      const cells = catalogCells(fleet, res);
      if (!cells) return undefined;
      const found = bySession(cells, req.body && req.body.session);
      if (found.error) return reject(res, found.error);
      cell = found.cell.id;
    }
    const out = lease.childRegister(cell, { authority: mode === 'authority' });
    log(`lease-route: register ${cell} -> ${out.status}`);
    return res.json(out);
  }));

  // Introspezione del proof child per il contesto shared del bridge MCP:
  // READ-ONLY (non consuma, non rinnova), attiva soltanto in authority mode.
  // In legacy risponde 501: nessun binding B+C puo nascere dal percorso D.
  r.post('/introspect', smallJson, guard((lease, req, res, fleet) => {
    if (mode !== 'authority') {
      return res.status(501).json({ error: 'identity introspection richiede fleet.identity.mode authority' });
    }
    const proof = requireProof(req, res);
    if (!proof) return undefined;
    const out = lease.childIntrospect(proof);
    if (out.status === 'live') {
      // Solo per un esito verificato vivo si risolve la sessione EFFETTIVA dal
      // catalogo corrente: cella rimossa o catalogo invalido non producono mai
      // un live con un nome ricostruito dal solo id.
      const cells = catalogCells(fleet, res);
      if (!cells) return undefined;
      const found = byCell(cells, out.cellId);
      if (found.error) return reject(res, found.error);
      if (!sessioneCorretta(req, found.cell, res)) return undefined;
      const node = typeof instanceId === 'function' ? instanceId() : instanceId;
      return res.json({
        ...out,
        tmuxSession: found.cell.tmuxSession,
        ...(typeof node === 'string' && node ? { instanceId: node } : {}),
      });
    }
    return res.json(out);
  }));

  const routeRinnovo = (managerMethod, conLog) => guard(async (lease, req, res, fleet) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: lease child bloccato' });
    const proof = requireProof(req, res);
    if (!proof) return undefined;
    const claimId = claimIdChecked(req, res);
    if (!claimId) return undefined;
    const binding = await guardBinding(req, claimId);
    if (binding instanceof Error) return bindingRejected(res, binding);
    // Da qui alla chiamata al manager nessuna sospensione: la fotografia del
    // catalogo è presa DOPO l'ultimo await e consumata nello stesso tratto.
    const cells = catalogCells(fleet, res);
    if (!cells) return undefined;
    const found = byCell(cells, claimId);
    if (found.error) return reject(res, found.error);
    if (!sessioneCorretta(req, found.cell, res)) return undefined;
    const out = lease[managerMethod](claimId, proof);
    if (conLog) log(`lease-route: ${managerMethod} ${claimId} -> ${out.status}`);
    return res.json(out);
  });

  r.post('/refresh', smallJson, routeRinnovo('childRefresh', false));
  r.post('/recovery', smallJson, routeRinnovo('childRecovery', true));

  return r;
}

module.exports = { leaseRoutes };
