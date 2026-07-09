'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { transcribe, loadVoiceToken, serverSttConfigured } = require('../lib/voice/transcribe.js');

function cfgWithToken() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvoice-'));
  const file = path.join(dir, 'http.token');
  fs.writeFileSync(file, 'voice_test\n');
  return { voiceUrl: 'http://127.0.0.1:9', voiceToken: '', voiceTokenFile: file };
}

test('loadVoiceToken: env vince, poi file, poi null', () => {
  const cfg = cfgWithToken();
  assert.equal(loadVoiceToken(cfg), 'voice_test');
  assert.equal(loadVoiceToken({ ...cfg, voiceToken: 'dalla-env' }), 'dalla-env');
  assert.equal(loadVoiceToken({ voiceToken: '', voiceTokenFile: '/manca' }), null);
});

test('loadVoiceToken: voiceTokenFile null -> null esplicito (no readFileSync)', () => {
  // prima voiceTokenFile era /opt/mcp-voice/... hardcoded; ora null e' il default portatile
  assert.equal(loadVoiceToken({ voiceToken: '', voiceTokenFile: null }), null);
  assert.equal(loadVoiceToken({ voiceUrl: 'http://x', voiceToken: '', voiceTokenFile: null }), null);
});

test('serverSttConfigured: true solo se voiceUrl valorizzato (config-only)', () => {
  assert.equal(serverSttConfigured({ voiceUrl: null }), false);
  assert.equal(serverSttConfigured({ voiceUrl: 'http://127.0.0.1:3105' }), true);
  assert.equal(serverSttConfigured({}), false);
});

test('transcribe: successo con upstream mock', async () => {
  const cfg = cfgWithToken();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ text: 'ciao mondo', provider: 'whisper-local' }) };
  };
  const out = await transcribe(cfg, Buffer.from('AUDIO'), { language: 'it', fetchImpl });
  assert.equal(out.text, 'ciao mondo');
  assert.ok(calls[0].url.endsWith('/v1/audio/transcriptions'));
  assert.equal(calls[0].opts.headers.authorization, 'Bearer voice_test');
  assert.equal(JSON.parse(calls[0].opts.body).file, Buffer.from('AUDIO').toString('base64'));
});

test('transcribe: errori con status', async () => {
  const cfg = cfgWithToken();
  await assert.rejects(() => transcribe(cfg, Buffer.alloc(0)), (e) => e.status === 400);
  await assert.rejects(
    () => transcribe(cfg, Buffer.from('x'), { fetchImpl: async () => { throw new Error('conn'); } }),
    (e) => e.status === 502,
  );
  await assert.rejects(
    () => transcribe(cfg, Buffer.from('x'), { fetchImpl: async () => ({ ok: false, status: 500 }) }),
    (e) => e.status === 502,
  );
  // token mancante CON voiceUrl -> 502 (config incompleta, non "not configured")
  await assert.rejects(
    () => transcribe({ voiceUrl: 'http://x', voiceToken: '', voiceTokenFile: '/manca' }, Buffer.from('x')),
    (e) => e.status === 502,
  );
});

test('transcribe: voiceUrl null -> 503 graceful (non 502)', async () => {
  // portatile senza mcp-voice: 503 "not configured", non 502 con stack
  await assert.rejects(
    () => transcribe({ voiceUrl: null, voiceToken: '', voiceTokenFile: null }, Buffer.from('x')),
    (e) => e.status === 503 && /not configured/.test(e.message),
  );
  // anche se voiceUrl undefined (cfg senza campo)
  await assert.rejects(
    () => transcribe({ voiceToken: '', voiceTokenFile: null }, Buffer.from('x')),
    (e) => e.status === 503,
  );
});
