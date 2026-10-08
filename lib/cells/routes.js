'use strict';

const express = require('express');
const { isValidSession } = require('../files/store.js');
const { submitTextOk } = require('../tmux/actions.js');
const { createIdentityBindingGuard } = require('../identity/binding-guard.js');
const { isReservedLiveName } = require('../live-host/reserved.js');

const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const CELL_LABEL_MAX = 64;

// Una label che esce da questo nodo, o che arriva da un altro, e' testo
// AUTO-DICHIARATO: la definizione locale e' gia' validata dal parser, ma il
// payload che si espone e quello che si riceve vanno delimitati comunque.
// Senza questo un peer puo' far attraversare la directory a una stringa lunga
// e con a capo, che ogni consumatore poi renderizza.
function safeCellLabel(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > CELL_LABEL_MAX) return '';
  return /[\x00-\x1f\x7f]/.test(trimmed) ? '' : trimmed;
}
const NODE_ID_RE = /^[a-f0-9]{16,64}$/;
const MESSAGE_ID_RE = /^[a-f0-9-]{16,64}$/;

function publicCells(status, instanceId, now = Date.now()) {
  if (!NODE_ID_RE.test(String(instanceId || '')) || !status || status.available !== true
    || !Array.isArray(status.cells)) return [];
  const seen = new Set();
  const cells = [];
  for (const raw of status.cells) {
    if (!raw || !CELL_ID_RE.test(String(raw.cell || ''))
      || isReservedLiveName(raw.cell)
      || !isValidSession(raw.tmuxSession) || seen.has(raw.cell)) continue;
    seen.add(raw.cell);
    // Un `tmux:false` esplicito prevale su active:true: la directory globale non
    // deve dichiarare ricevibile una cella senza sessione viva.
    const active = raw.active === true && raw.tmux !== false;
    cells.push({
      id: `${instanceId}:${raw.cell}`,
      instanceId,
      cell: raw.cell,
      // Il nome leggibile viaggia accanto all'id, mai al suo posto: chi riceve
      // questa voce deve poter capire che ruolo occupa la cella senza dover
      // interpretare un identificatore scelto da un altro nodo.
      label: safeCellLabel(raw.label),
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

const LIVE_HEADER = 'x-nexuscrew-live-thread';

// `liveEntry({ instanceId, now })` -> the Live directory entry or null, and
// `liveAttest.verify({ ref, fromCell })` -> { ok, hostCell } are optional seams:
// without them the routes behave as before.
function cellsRoutes({
  fleetP, instanceId, submit, readonly = () => false, now = () => Date.now(), diagnostics = null,
  identityMode = 'legacy', liveEntry = null, liveAttest = null,
}) {
  const bindingGuard = createIdentityBindingGuard({
    fleetP, instanceId, now,
    sharedRequired: identityMode === 'authority',
  });

  async function guardBinding(req, expected) {
    try {
      return await bindingGuard.verify(req, { expected, localOnly: false });
    } catch (e) {
      return e;
    }
  }

  const r = express.Router();

  async function status() {
    const fleet = await fleetP;
    const statusFn = fleet && (typeof fleet.cellStatus === 'function' ? fleet.cellStatus : fleet.status);
    if (!fleet || fleet.available !== true || typeof statusFn !== 'function') {
      return { available: false, cells: [] };
    }
    return statusFn.call(fleet);
  }

  r.get('/', async (_req, res) => {
    try {
      const nodeId = instanceId();
      const st = await status();
      // The Live is its own entry, never a cell: a failure here must not take
      // the directory down, it only means the Live is not shown.
      const live = liveEntry && NODE_ID_RE.test(String(nodeId || ''))
        ? await Promise.resolve(liveEntry({ instanceId: nodeId, now })).catch(() => null) : null;
      const cells = publicCells(st, nodeId, now());
      res.json({
        instanceId: NODE_ID_RE.test(String(nodeId || '')) ? nodeId : null,
        available: st.available === true,
        at: now(),
        cells: live ? [...cells, live] : cells,
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  r.post('/send', express.json({ limit: '16kb' }), async (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: invio cella bloccato' });
    const body = req.body || {};
    // Observability (2026-08-28): chi manda, a chi, con quale id e come finisce.
    // SOLO metadati: il testo del messaggio non tocca mai la diagnostica.
    const logSend = (level, event, reason) => {
      if (!diagnostics) return;
      try {
        diagnostics.record(level, 'cell-msg', event, reason
          ? `Invio cella: ${reason}`
          : 'Invio cella consegnato alla sessione target', {
          fromCell: body.from && body.from.cell,
          toCell: body.to && body.to.cell,
          msgId: typeof body.id === 'string' ? body.id : undefined,
          reason: reason ? String(reason).slice(0, 48) : undefined,
        });
      } catch (_) {}
    };
    const reject = (code, reason, extra = null) => { logSend('warn', 'CELL_MESSAGE_REJECTED', reason); return res.status(code).json({ error: reason, ...(extra || {}) }); };
    const keys = Object.keys(body);
    if (keys.some((key) => !['id', 'from', 'to', 'message'].includes(key))
      || !MESSAGE_ID_RE.test(String(body.id || ''))
      || !validIdentity(body.from) || !validIdentity(body.to)
      || !submitTextOk(body.message)) {
      return reject(400, 'messaggio cella non valido');
    }
    // `Live` names the Live, which has no tmux session to paste into: never
    // fall back to a cell of the same name or to its host.
    if (isReservedLiveName(body.to.cell)) {
      return reject(409, 'live-not-addressable: la Live non riceve messaggi da qui; nessuna consegna');
    }
    const localId = instanceId();
    if (!NODE_ID_RE.test(String(localId || '')) || body.to.instanceId !== localId) {
      return reject(409, 'destinazione non appartiene a questo nodo');
    }
    const visited = parseVisited(req);
    if (visited === null || (visited.length && (visited.at(-1) !== localId
      || body.from.instanceId !== visited[0]))) {
      return reject(403, 'identita mittente non verificata');
    }
    if (!visited.length && body.from.instanceId !== localId) {
      return reject(403, 'mittente remoto senza route autenticata');
    }
    // Mittente locale: la tupla dichiarata deve corrispondere a una cella della
    // directory attiva. Il nome di sessione non è una verifica: la fa lo stato vivo.
    if (body.from.instanceId === localId) {
      const directory = publicCells(await status(), localId, now());
      const sender = directory.find((cell) => cell.cell === body.from.cell
        && cell.tmuxSession === body.from.tmuxSession && cell.active === true);
      if (!sender) return reject(403, 'mittente locale non verificato');
    }
    // Binding identity shared: presentato -> verificato server-side completo,
    // mai accettato per sola coerenza formale né degradato a percorso legacy.
    const binding = await guardBinding(req, body.from);
    if (binding instanceof Error) {
      return reject(403, binding.message, { code: binding.code });
    }
    try {
      const cells = publicCells(await status(), localId, now());
      const target = cells.find((cell) => cell.cell === body.to.cell
        && cell.tmuxSession === body.to.tmuxSession);
      if (!target) return reject(404, 'cella destinataria sconosciuta');
      if (!target.canReceive) return reject(409, 'cella destinataria non attiva');
      let label = `${body.from.cell}@${body.from.instanceId.slice(0, 8)}`;
      // The Live label is earned, not declared: only a local sender whose
      // declared reference is registered, belongs to this host cell and has a
      // live thread. Anything else travels as a plain cell message.
      if (liveAttest && !visited.length) {
        const rawRef = req.headers[LIVE_HEADER];
        if (rawRef !== undefined) {
          const verdict = await Promise.resolve(liveAttest.verify({
            ref: Array.isArray(rawRef) ? rawRef[0] : rawRef, fromCell: body.from.cell,
          })).catch(() => ({ ok: false }));
          if (verdict && verdict.ok === true) {
            label = `Live(via ${body.from.cell})@${body.from.instanceId.slice(0, 8)}`;
          }
        }
      }
      // End on printable text even when the source message ends in a newline:
      // Pi may auto-submit a bracketed paste that ends with LF. NexusCrew owns
      // the single explicit Enter used by the transport.
      const envelope = `[NexusCrew message ${body.id} from ${label}]\n${body.message}\n[End NexusCrew message]`;
      const outcome = await submit(target.tmuxSession, envelope, { engine: target.engine });
      if (!outcome || outcome.submitted !== true) {
        return reject(409, outcome?.reason || 'consegna non riuscita');
      }
      logSend('notice', 'CELL_MESSAGE_SENT');
      const at = now();
      return res.json({
        id: body.id,
        status: 'submitted',
        at,
        to: { instanceId: localId, cell: target.cell, tmuxSession: target.tmuxSession },
        note: 'submitted conferma solo paste+Enter nel TUI, non elaborazione o completamento',
      });
    } catch (e) { return reject(500, String(e.message || e).slice(0, 96)); }
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

module.exports = { cellsRoutes, publicCells, parseVisited, validIdentity, safeCellLabel };
