'use strict';
// lib/notify/ask-cell.js — which cell an IMPORTED ask belongs to.
//
// The owner of an ask is the only node that knows its cell: it resolves the
// ask's tmux session through its own cell definitions (a cell may declare a
// custom tmux session, so the name is not always `cloud-<cell>`). Decoding the
// session name here is therefore only a FALLBACK for the canonical names; for
// any other name the cell has to come from the owner.
//
// Two authenticated sources carry what the owner resolved, and nothing else is
// trusted:
//   - `ownerCellId`: set by the event-feed client from the owner's authenticated
//     snapshot item or live envelope (never copied from a wire field of that name);
//   - `originCell`: the cell the origin resolver attested for an ask pushed by the
//     owner (written by the server when the alias is created).
// Never derived by stripping a prefix from a string, never from the local cell
// definitions (those describe THIS node, not the owner), never from a request body.
const { cellIdFromTmuxSession } = require('../fleet/definitions.js');

const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
function isCellId(value) { return typeof value === 'string' && CELL_ID_RE.test(value); }

// -> { cellId, source, conflict? }. `source` is 'owner-feed' | 'origin-attested' |
// 'canonical-session' | null. Two authenticated sources that disagree resolve to
// nothing (fail closed): there is no way to tell which one is stale.
function resolveAskCell(ask) {
  if (!ask || typeof ask !== 'object') return { cellId: null, source: null };
  const fromFeed = isCellId(ask.ownerCellId) ? ask.ownerCellId : null;
  const attested = isCellId(ask.originCell) ? ask.originCell : null;
  if (fromFeed && attested && fromFeed !== attested) return { cellId: null, source: null, conflict: true };
  if (fromFeed) return { cellId: fromFeed, source: 'owner-feed' };
  if (attested) return { cellId: attested, source: 'origin-attested' };
  const decoded = cellIdFromTmuxSession(ask.session);
  return decoded ? { cellId: decoded, source: 'canonical-session' } : { cellId: null, source: null };
}

// The same ask can be known from two places at once (the alias created when the
// owner pushed it, the card of the owner's feed). Call this with the candidates
// that are the SAME generation of the SAME ask. Authenticated sources outrank the
// session decode; two authenticated sources that disagree resolve to nothing; a
// source that knows the cell completes one that does not.
function resolveAskCellFrom(asks) {
  const results = asks.filter(Boolean).map(resolveAskCell);
  const authenticated = results.filter((r) => r.cellId && r.source !== 'canonical-session');
  const ids = new Set(authenticated.map((r) => r.cellId));
  if (results.some((r) => r.conflict) || ids.size > 1) return { cellId: null, source: null, conflict: true };
  if (ids.size === 1) return authenticated[0];
  const decoded = new Set(results.filter((r) => r.cellId).map((r) => r.cellId));
  if (decoded.size === 1) return results.find((r) => r.cellId);
  return decoded.size > 1 ? { cellId: null, source: null, conflict: true } : { cellId: null, source: null };
}

module.exports = { resolveAskCell, resolveAskCellFrom, isCellId, CELL_ID_RE };
