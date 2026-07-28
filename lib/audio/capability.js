'use strict';
// lib/audio/capability.js — descrizione della capability audio di UN nodo.
//
// Cosa dice e cosa non dice. Dice se esiste un adapter, se il binario e'
// installato, se il consenso locale e' attivo e quali limiti valgono su quella
// piattaforma. NON dice che il nodo e' udibile: nessun probe software puo'
// stabilirlo. `liveness: 'ready'` significa "un adapter e' pronto ad accettare
// un enunciato", non "qualcuno lo sentira'".
//
// Metadati bounded per costruzione: niente path di binari (rivelerebbero il
// layout del filesystem), niente enumerazione delle voci di sistema (sarebbe
// fingerprinting della macchina verso un peer), niente informazioni di
// configurazione. Un peer autorizzato deve poter decidere se ha senso provare a
// parlare, non ricostruire com'e' fatto il computer di qualcun altro.
const { describeAdapter } = require('./adapters.js');

const MAX_VOICES = 32;
const MAX_LANGS = 32;

// describeCapability(): vista pubblica. `consent:false` e' il default e resta
// separato dall'esistenza dell'adapter: un nodo puo' essere perfettamente in
// grado di parlare e avere comunque negato il permesso di farlo.
function describeCapability({ adapter = null, consent = false, nodeId = null } = {}) {
  const described = describeAdapter(adapter);
  return {
    ...(nodeId ? { nodeId } : {}),
    adapter: described.adapter,
    installed: described.installed,
    // Senza consenso la liveness effettiva e' `unavailable`: dichiarare 'ready'
    // un endpoint che rifiutera' comunque significherebbe invitare a un
    // tentativo che non puo' riuscire.
    liveness: consent === true ? described.liveness : 'unavailable',
    consent: consent === true,
    voices: described.voices.slice(0, MAX_VOICES),
    languages: described.languages.slice(0, MAX_LANGS),
    ...(described.limits ? { limits: described.limits } : {}),
  };
}

module.exports = { describeCapability, MAX_VOICES, MAX_LANGS };
