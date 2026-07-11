'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('Fleet UI API routes reads and mutations through the selected Hydra path', async () => {
  const api = await import('../frontend/src/lib/api.js');
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ available: true }) };
  };
  try {
    await api.fleetStatus('local-token', ['relay', 'phone']);
    await api.fleetDefineCell('local-token', { id: 'dev', cwd: '/home/user', engine: 'claude.native' }, ['relay', 'phone']);
    await api.listDirs('local-token', '/home/user', ['relay', 'phone']);
  } finally { globalThis.fetch = original; }

  assert.equal(calls[0].url, '/api/route/relay/phone/_/fleet/status');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer local-token');
  assert.equal(calls[1].url, '/api/route/relay/phone/_/fleet/define-cell');
  assert.equal(calls[1].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].opts.body), { def: { id: 'dev', cwd: '/home/user', engine: 'claude.native' } });
  assert.equal(calls[2].url, '/api/route/relay/phone/_/fs/dirs?path=%2Fhome%2Fuser');
});

test('Fleet UI API keeps Local on the direct API', async () => {
  const api = await import('../frontend/src/lib/api.js');
  const original = globalThis.fetch;
  let url = '';
  globalThis.fetch = async (value) => { url = value; return { ok: true, status: 200, json: async () => ({}) }; };
  try { await api.fleetDefinitions('t', []); } finally { globalThis.fetch = original; }
  assert.equal(url, '/api/fleet/definitions');
});
