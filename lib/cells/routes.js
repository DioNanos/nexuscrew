'use strict';

const express = require('express');
const { isValidSession } = require('../files/store.js');
const { submitTextOk } = require('../tmux/actions.js');

const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const NODE_ID_RE = /^[a-f0-9]{16,64}$/;
const MESSAGE_ID_RE = /^[a-f0-9-]{16,64}$/;

function publicCells(status, instanceId, now = Date.now()) {
  if (!NODE_ID_RE.test(String(instanceId || '')) || !status || status.available !== true
    || !Array.isArray(status.cells)) return [];
  const seen = new Set();
  const cells = [];
  for (const raw of status.cells) {
    if (!raw || !CELL_ID_RE.test(String(raw.cell || ''))
      || !isValidSession(raw.tmuxSession) || seen.has(raw.cell)) continue;
    seen.add(raw.cell);
    // Un `tmux:false` esplicito prevale su active:true: la directory globale non
    // deve dichiarare ricevibile una cella senza sessione viva.
    const active = raw.active === true && raw.tmux !== false;
    cells.push({
      id: `${instanceId}:${raw.cell}`,
      instanceId,
      cell: raw.cell,
      tmuxSession: raw.tmuxSession,
      engine: typeof raw.engine === 'string' ? raw.engine : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      active,
      canReceive: active,
      lastSeen: active ? now : null,
    });
  }
  return cells;
}

function parseVisited(req) {
  const raw = String(req.headers['x-nexuscrew-visited'] || '');
  if (!raw) return [];
  const ids = raw.split(',');
  if (!ids.length || ids.length > 5 || ids.some((id) => !NODE_ID_RE.test(id))
    || new Set(ids).size !== ids.length) return null;
  return ids;
}

function validIdentity(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && NODE_ID_RE.test(String(value.instanceId || ''))
    && CELL_ID_RE.test(String(value.cell || ''))
    && isValidSession(value.tmuxSession);
}

function cellsRoutes({ fleetP, instanceId, submit, readonly = () => false, now = () => Date.now() }) {
  const r = express.Router();

  async function status() {
    const fleet = await fleetP;
    if (!fleet || fleet.available !== true || typeof fleet.status !== 'function') {
      return { available: false, cells: [] };
    }
    return fleet.status();
  }

  r.get('/', async (_req, res) => {
    try {
      const nodeId = instanceId();
      const st = await status();
      res.json({
        instanceId: NODE_ID_RE.test(String(nodeId || '')) ? nodeId : null,
        available: st.available === true,
        at: now(),
        cells: publicCells(st, nodeId, now()),
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  r.post('/send', express.json({ limit: '16kb' }), async (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: invio cella bloccato' });
    const body = req.body || {};
    const keys = Object.keys(body);
    if (keys.some((key) => !['id', 'from', 'to', 'message'].includes(key))
      || !MESSAGE_ID_RE.test(String(body.id || ''))
      || !validIdentity(body.from) || !validIdentity(body.to)
      || !submitTextOk(body.message)) {
      return res.status(400).json({ error: 'messaggio cella non valido' });
    }
    const localId = instanceId();
    if (!NODE_ID_RE.test(String(localId || '')) || body.to.instanceId !== localId) {
      return res.status(409).json({ error: 'destinazione non appartiene a questo nodo' });
    }
    const visited = parseVisited(req);
    if (visited === null || (visited.length && (visited.at(-1) !== localId
      || body.from.instanceId !== visited[0]))) {
      return res.status(403).json({ error: 'identita mittente non verificata' });
    }
    if (!visited.length && body.from.instanceId !== localId) {
      return res.status(403).json({ error: 'mittente remoto senza route autenticata' });
    }
    try {
      const cells = publicCells(await status(), localId, now());
      const target = cells.find((cell) => cell.cell === body.to.cell
        && cell.tmuxSession === body.to.tmuxSession);
      if (!target) return res.status(404).json({ error: 'cella destinataria sconosciuta' });
      if (!target.canReceive) return res.status(409).json({ error: 'cella destinataria non attiva' });
      const label = `${body.from.cell}@${body.from.instanceId.slice(0, 8)}`;
      // End on printable text even when the source message ends in a newline:
      // Pi may auto-submit a bracketed paste that ends with LF. NexusCrew owns
      // the single explicit Enter used by the transport.
      const envelope = `[NexusCrew message ${body.id} from ${label}]\n${body.message}\n[End NexusCrew message]`;
      const outcome = await submit(target.tmuxSession, envelope, { engine: target.engine });
      if (!outcome || outcome.submitted !== true) {
        return res.status(409).json({ error: outcome?.reason || 'consegna non riuscita' });
      }
      const at = now();
      return res.json({
        id: body.id,
        status: 'submitted',
        at,
        to: { instanceId: localId, cell: target.cell, tmuxSession: target.tmuxSession },
        note: 'submitted conferma solo paste+Enter nel TUI, non elaborazione o completamento',
      });
    } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  });

  r.use((err, _req, res, _next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(413).json({ error: 'body troppo grande' });
    }
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'JSON non valido' });
    return res.status(err.status || 400).json({ error: String(err.message || err) });
  });

  return r;
}

module.exports = { cellsRoutes, publicCells, parseVisited, validIdentity };
