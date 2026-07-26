'use strict';
// lib/audio/capability.js — WP2: node audio capability metadata (bounded,
// redacted) + admission honesty. The adapter is WP3: this layer never
// synthesizes/plays audio, never uses browser TTS / mcp-voice / cloud, and
// never claims accepted/spoken without a test fake. With no adapter it honestly
// reports unavailable/refused.
const MAX_VOICES = 32;
const MAX_LANGS = 32;

// describeCapability(): bounded redacted metadata. Only {adapter, installed,
// liveness, voices, languages}; voices/languages are capped and contain no
// credential/path. adapter is an id string or null (never a handle/secret).
function describeCapability({ adapter = null, installed = false, liveness = 'unavailable', voices = [], languages = [] } = {}) {
  const v = Array.isArray(voices) ? voices.filter((x) => typeof x === 'string' && x).slice(0, MAX_VOICES) : [];
  const l = Array.isArray(languages) ? languages.filter((x) => typeof x === 'string' && x).slice(0, MAX_LANGS) : [];
  const adapterId = adapter && typeof adapter === 'object' && typeof adapter.id === 'string' ? adapter.id
    : (typeof adapter === 'string' && adapter ? adapter : null);
  return {
    adapter: adapterId,
    installed: !!installed,
    liveness: typeof liveness === 'string' ? liveness : 'unavailable',
    voices: v,
    languages: l,
  };
}

// admitAudio(): honest admission. No adapter => unavailable. A test-fake adapter
// (WP3 pluggable) is detected but WP2 still does NOT claim accepted/spoken: it
// returns adapterDetected so WP3 can later drive synthesis. This never plays.
function admitAudio({ adapter = null } = {}) {
  if (adapter && (typeof adapter === 'object' && typeof adapter.speak === 'function')) {
    return { status: 'unavailable', adapterDetected: true, reason: 'adapter-present-but-synthesis-is-wp3' };
  }
  return { status: 'unavailable', adapterDetected: false, reason: 'no-adapter' };
}

module.exports = { describeCapability, admitAudio, MAX_VOICES, MAX_LANGS };