'use strict';
// lib/fleet/lease-routes.js — route /api/lease, superficie child della fetta 2b
// (contratto rev1: B5 tre metodi distinti + D3 collegamento MCP↔leaseManager).
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

function leaseRoutes({ fleetP, readonly = () => false, log = () => {}, identityAuthority = null,
  identityAudience = 'nexuscrew-lease' }) {
  const r = express.Router();
  const smallJson = express.json({ limit: '8kb' });

  const guard = (fn) => async (req, res) => {
    try {
      const fleet = await fleetP;
      if (!fleet || fleet.available !== true) return res.status(404).json({ error: 'fleet non disponibile' });
      // D3: il collegamento vive sul provider — senza leaseManager (lease
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
    const proof = requireProof(req, res);
    if (!proof) return undefined;
    const authority = identityAuthority || fleet.identityAuthority;
    if (!authority || typeof authority.verifyChallengeProof !== 'function') {
      return res.status(501).json({ error: 'identity authority non disponibile' });
    }
    const checked = authority.verifyChallengeProof(proof, { audience: identityAudience });
    if (!checked.ok) return res.json({ status: 'denied', reason: checked.reason });
    const cell = cellFromProof(req, res);
    if (!cell) return undefined;
    const out = lease.childRegister(cell);
    log(`lease-route: register ${cell} -> ${out.status}`);
    return res.json(out);
  }));

  r.post('/refresh', smallJson, guard((lease, req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: lease child bloccato' });
    const proof = requireProof(req, res);
    if (!proof) return undefined;
    const cell = cellFromProof(req, res);
    if (!cell) return undefined;
    const out = lease.childRefresh(cell, proof);
    return res.json(out);
  }));

  r.post('/recovery', smallJson, guard((lease, req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: lease child bloccato' });
    const proof = requireProof(req, res);
    if (!proof) return undefined;
    const cell = cellFromProof(req, res);
    if (!cell) return undefined;
    const out = lease.childRecovery(cell, proof);
    log(`lease-route: recovery ${cell} -> ${out.status}`);
    return res.json(out);
  }));

  return r;
}

module.exports = { leaseRoutes };
