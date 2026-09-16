'use strict';
// lib/fleet/lease-routes.js — route /api/lease, superficie child della fetta 2b
// (contract: three distinct methods + the MCP↔leaseManager link).
//
// Il bridge MCP di una cella (`nexuscrew mcp`) parla con l'HTTP API locale dietro
// Bearer (canale nativo del bridge): queste route sono quel collegamento.
// La CELLA di register e' derivata dal proof identity verificato dall'authority;
// refresh/recovery la derivano dal proof child firmato dal lease manager. La
// sessione tmux del body non e' mai un authorizer.
//
// Semantica degli status (tutti 200 salvo errori di protocollo):
//   registered | live | pending | no-registration | expired | denied
// Il client MCP legge lo status e agisce; un 4xx/5xxx qui significa solo che la
// richiesta era malformata o il servizio non c'e' — non e' un esito di lease.

const express = require('express');
const { cellIdFromTmuxSession, tmuxSessionForCell } = require('./definitions.js');
const { createIdentityBindingGuard } = require('../identity/binding-guard.js');

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
      if (!fleet || fleet.available !== true) return res.status(404).json({ error: 'fleet non disponibile' });
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

  // La sessione nel body NON è una credenziale. Per register il subject viene
  // dal proof identity emesso dall'authority; per refresh/recovery dal proof
  // child già firmato dal lease manager. Se un client legacy invia session la
  // confrontiamo solo come guardia anti-confusione, mai per scegliere la cella.
  const cellFromProof = (req, res) => {
    const cell = req.body && req.body.proof && req.body.proof.cellId;
    if (!tmuxSessionForCell(cell)) {
      res.status(400).json({ error: 'proof senza cella valida' });
      return null;
    }
    const declared = req.body && req.body.session;
    if (declared !== undefined && cellIdFromTmuxSession(declared) !== cell) {
      res.status(400).json({ error: 'sessione body discordante dal proof' });
      return null;
    }
    return cell;
  };
  const requireProof = (req, res) => {
    const proof = req.body && req.body.proof;
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
      res.status(400).json({ error: 'proof mancante o malformato' });
      return null;
    }
    return proof;
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
      cell = cellFromProof(req, res);
      if (!cell) return undefined;
    } else {
      const declared = req.body && req.body.session;
      cell = cellIdFromTmuxSession(declared);
      if (!cell) return res.status(400).json({ error: 'sessione mancante o non valida' });
    }
    const out = lease.childRegister(cell, { authority: mode === 'authority' });
    log(`lease-route: register ${cell} -> ${out.status}`);
    return res.json(out);
  }));

  // Introspezione del proof child per il contesto shared del bridge MCP:
  // READ-ONLY (non consuma, non rinnova), attiva soltanto in authority mode.
  // In legacy risponde 501: nessun binding B+C puo nascere dal percorso D.
  r.post('/introspect', smallJson, guard((lease, req, res) => {
    if (mode !== 'authority') {
      return res.status(501).json({ error: 'identity introspection richiede fleet.identity.mode authority' });
    }
    const proof = requireProof(req, res);
    if (!proof) return undefined;
    const out = lease.childIntrospect(proof);
    if (out.status === 'live') {
      const node = typeof instanceId === 'function' ? instanceId() : instanceId;
      return res.json({
        ...out,
        tmuxSession: tmuxSessionForCell(out.cellId),
        ...(typeof node === 'string' && node ? { instanceId: node } : {}),
      });
    }
    return res.json(out);
  }));

  r.post('/refresh', smallJson, guard(async (lease, req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: lease child bloccato' });
    const proof = requireProof(req, res);
    if (!proof) return undefined;
    const cell = cellFromProof(req, res);
    if (!cell) return undefined;
    const binding = await guardBinding(req, cell);
    if (binding instanceof Error) return bindingRejected(res, binding);
    const out = lease.childRefresh(cell, proof);
    return res.json(out);
  }));

  r.post('/recovery', smallJson, guard(async (lease, req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: lease child bloccato' });
    const proof = requireProof(req, res);
    if (!proof) return undefined;
    const cell = cellFromProof(req, res);
    if (!cell) return undefined;
    const binding = await guardBinding(req, cell);
    if (binding instanceof Error) return bindingRejected(res, binding);
    const out = lease.childRecovery(cell, proof);
    log(`lease-route: recovery ${cell} -> ${out.status}`);
    return res.json(out);
  }));

  return r;
}

module.exports = { leaseRoutes };
