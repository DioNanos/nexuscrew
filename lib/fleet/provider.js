'use strict';
// B4.2 — Provider selection. Sceglie UNA volta, a startup, quale fleet governa il
// runtime (design §4b/§9b/§9g). Ritorna { mode, reason, fleet }.
//
//   mode ∈ 'external' | 'builtin' | 'disabled'
//
// Regole (design §9g):
//  - forced (cfg.fleetProvider | NEXUSCREW_FLEET_PROVIDER): onorato e FAIL-CLOSED
//    se indisponibile. NIENTE auto-fallback silenzioso al built-in.
//  - auto: 'external' vince solo se fidato (binTrusted, riusato da index.js) E
//    risponde al contratto (createFleet → available). Altrimenti 'builtin' se
//    abilitato e fleet.json valido. Altrimenti 'disabled'.
//
// Il drift a runtime NON si risolve qui: e' una scelta one-shot. Se l'external
// diventa invalido DOPO lo startup, lo status risultante sara' degraded/unavailable
// (mai fall-through silenzioso al built-in) — gestito dal layer di status.
const { binTrusted, externalFleetCandidates, resolveExternalFleet } = require('./index.js');
const { createBuiltinFleet } = require('./builtin.js');

const DISABLED_FLEET = Object.freeze({
  available: false, provider: 'disabled', isCellSession: () => false, capabilities: () => [],
});

function failClosed(mode) {
  return {
    mode: 'disabled',
    reason: `fail-closed: provider forzato "${mode}" non disponibile (nessun auto-fallback, §9g)`,
    fleet: DISABLED_FLEET,
  };
}

// Costruisce (una volta) i candidati e ne valuta la disponibilita'.
async function selectProvider(cfg = {}) {
  if (cfg.fleetEnabled === false) {
    return { mode: 'disabled', reason: 'fleet disabilitato (fleetEnabled=false)', fleet: DISABLED_FLEET };
  }

  const forced = (cfg.fleetProvider || process.env.NEXUSCREW_FLEET_PROVIDER || '').toLowerCase() || null;

  // External: scopre il binario fleet legacy cross-platform (cfg.fleetBin,
  // $PREFIX/bin/fleet su Termux, ~/.local/bin/fleet) e accetta il primo fidato
  // (binTrusted) che risponde al contratto (status --json con schema valido).
  let extFleet = null;
  let extReason = null;
  const resolvedExternal = await resolveExternalFleet(cfg);
  if (resolvedExternal) {
    extFleet = resolvedExternal.fleet;
    extReason = resolvedExternal.reason;
  } else {
    // Diagnosi: perché nessun candidato external è valido (fidato + contratto).
    const cands = externalFleetCandidates(cfg);
    if (!cands.length) extReason = 'nessun fleetBin esterno configurato';
    else extReason = `nessun candidato external valido: ${cands.map((b) => (binTrusted(b) ? `${b} (non risponde al contratto)` : `${b} (non fidato)`)).join('; ')}`;
  }

  // Builtin: abilitato + fleet.json valido.
  let biFleet = null;
  let biReason = null;
  if (cfg.builtinEnabled !== false) {
    const f = await createBuiltinFleet({ ...cfg, fleetProviderReason: 'fleet.json definitions' });
    if (f.available) { biFleet = f; biReason = 'fleet.json valido'; }
    else biReason = 'fleet.json mancante o invalido (fail-closed)';
  } else {
    biReason = 'builtin disabilitato (builtinEnabled=false)';
  }

  // --- Mode FORZATO: fail-closed se il richiesto non e' disponibile ---
  if (forced === 'external') {
    return extFleet
      ? { mode: 'external', reason: `forced external (${extReason})`, fleet: extFleet }
      : failClosed('external');
  }
  if (forced === 'builtin') {
    return biFleet
      ? { mode: 'builtin', reason: `forced builtin (${biReason})`, fleet: biFleet }
      : failClosed('builtin');
  }
  if (forced === 'disabled') {
    return { mode: 'disabled', reason: 'forced disabled', fleet: DISABLED_FLEET };
  }
  if (forced) {
    return failClosed(forced); // valore forzato non riconosciuto
  }

  // --- AUTO: external fidato+contratto vince, poi builtin, poi disabled ---
  if (extFleet) {
    return { mode: 'external', reason: `auto: external ${extReason}`, fleet: extFleet };
  }
  if (biFleet) {
    return {
      mode: 'builtin',
      reason: `auto: external scartato (${extReason}) → builtin (${biReason})`,
      fleet: biFleet,
    };
  }
  return {
    mode: 'disabled',
    reason: `auto: nessun provider disponibile — external: ${extReason}; builtin: ${biReason}`,
    fleet: DISABLED_FLEET,
  };
}

module.exports = { selectProvider, DISABLED_FLEET };
