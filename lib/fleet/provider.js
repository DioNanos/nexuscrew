'use strict';
// NexusCrew is the single Fleet authority.  The legacy external `fleet` binary
// is intentionally not discovered or executed: definitions, credentials,
// lifecycle and boot ownership all live in the builtin provider.
const { createBuiltinFleet } = require('./builtin.js');

const DISABLED_FLEET = Object.freeze({
  available: false, provider: 'disabled', isCellSession: () => false, capabilities: () => [],
});

function disabled(reason) {
  return { mode: 'disabled', reason, fleet: DISABLED_FLEET };
}

async function selectProvider(cfg = {}) {
  if (cfg.fleetEnabled === false) return disabled('fleet disabilitata (fleetEnabled=false)');
  if (cfg.builtinEnabled === false) return disabled('fleet builtin disabilitata (builtinEnabled=false)');
  const fleet = await createBuiltinFleet({ ...cfg, fleetProviderReason: 'NexusCrew builtin fleet' });
  if (!fleet.available) return disabled('fleet.json mancante o invalido (fail-closed)');
  return { mode: 'builtin', reason: 'NexusCrew builtin fleet', fleet };
}

module.exports = { selectProvider, DISABLED_FLEET };
