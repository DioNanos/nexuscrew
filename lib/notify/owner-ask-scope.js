'use strict';
const { loadDefinitions, cellIdFromTmuxSession, defaultDefinitionsPath } = require('../fleet/definitions.js');

// The owner resolves local definitions, never a cell id supplied by a peer.
// Activity and tmux polling do not participate in ASK authorization.
function resolveOwnerSession(session, cells) {
  if (typeof session !== 'string' || !session) return null;
  const matches = cells.filter(cell => cell.tmuxSession === session);
  if (matches.length > 1) return null;
  if (matches.length === 1) return matches[0].id;
  return cellIdFromTmuxSession(session);
}

function createOwnerAskScope(cfg) {
  const enabled = cfg.fleetEnabled !== false && cfg.builtinEnabled !== false;
  const definitionsPath = enabled ? defaultDefinitionsPath(cfg) : null;
  function read() {
    if (!enabled) return { available: true, cells: [] };
    const definitions = loadDefinitions(definitionsPath);
    return definitions ? { available: true, cells: definitions.cells } : { available: false, cells: [] };
  }
  return {
    snapshotResolver: () => {
      const definitions = read();
      if (!definitions.available) throw new Error('owner ASK scope unavailable');
      return session => resolveOwnerSession(session, definitions.cells);
    },
    cellForSession: session => {
      const definitions = read();
      return definitions.available ? resolveOwnerSession(session, definitions.cells) : null;
    },
  };
}
module.exports = { createOwnerAskScope, resolveOwnerSession };
