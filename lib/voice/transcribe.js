'use strict';
// Voice STT proxy (graceful). voiceUrl null => non configurato: 503 pulito, non 502.
// Web Speech nel browser resta indipendente da questo proxy (split model M5).
const fs = require('node:fs');

function loadVoiceToken(cfg) {
  if (cfg.voiceToken) return cfg.voiceToken;
  if (!cfg.voiceTokenFile) return null; // null = non configurato (no readFileSync)
  try {
    const t = fs.readFileSync(cfg.voiceTokenFile, 'utf8').trim();
    return t || null;
  } catch (_) { return null; }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Config-only: true se voiceUrl valorizzato (no reachability check nel primo giro).
function serverSttConfigured(cfg) {
  return !!cfg.voiceUrl;
}

async function transcribe(cfg, audioBuffer, { language = 'it', fetchImpl = fetch } = {}) {
  if (!audioBuffer || audioBuffer.length === 0) throw httpError(400, 'audio mancante');
  if (!cfg.voiceUrl) throw httpError(503, 'server STT not configured'); // graceful, non 502
  const token = loadVoiceToken(cfg);
  if (!token) throw httpError(502, 'STT non disponibile (token voice mancante)');
  let r;
  try {
    r = await fetchImpl(`${cfg.voiceUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ file: audioBuffer.toString('base64'), language }),
    });
  } catch (_) { throw httpError(502, 'STT non disponibile (mcp-voice giù)'); }
  if (!r.ok) throw httpError(502, `STT errore upstream (${r.status})`);
  return r.json();
}

module.exports = { loadVoiceToken, transcribe, serverSttConfigured };
