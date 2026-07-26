'use strict';
// NexusCrew is the single Fleet authority.  The legacy external `fleet` binary
// is intentionally not discovered or executed: definitions, credentials,
// lifecycle and boot ownership all live in the builtin provider.
const { createBuiltinFleet } = require('./builtin.js');

const DISABLED_FLEET = Object.freeze({
  available: false, provider: 'disabled', isCellSession: () => false, capabilities: () => [],
});

function disabled(reason) {
  return { mode: 'disabled', reason, fleet: { ...DISABLED_FLEET, reason } };
}

async function selectProvider(cfg = {}) {
  // Seam esplicito per i test: permette di far girare il server REALE con uno
  // stato Fleet controllato, senza tmux ne' processi. Esiste perche' i confini
  // che dipendono dalle celle attive (l'origine di Audio Share) vanno provati
  // sul server vero: un test che inietta le dipendenze nel router non si
  // accorgerebbe mai di un cablaggio sbagliato.
  if (cfg.fleetSeam) return { mode: 'seam', reason: 'fleet iniettata (seam di test)', fleet: cfg.fleetSeam };
  if (cfg.fleetEnabled === false) return disabled('fleet disabilitata (fleetEnabled=false)');
  if (cfg.builtinEnabled === false) return disabled('fleet builtin disabilitata (builtinEnabled=false)');
  const fleet = await createBuiltinFleet({ ...cfg, fleetProviderReason: 'NexusCrew builtin fleet' });
  if (!fleet.available) return disabled(fleet.reason || 'fleet.json mancante o invalido (fail-closed)');
  return { mode: 'builtin', reason: 'NexusCrew builtin fleet', fleet };
}

module.exports = { selectProvider, DISABLED_FLEET };
