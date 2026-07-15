'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');

async function boot(t, updateManager, over = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-update-routes-'));
  const made = createServer({ home, configPath: path.join(home, 'config.json'), tokenPath: path.join(home, 'token'),
    filesRoot: path.join(home, 'files'), fleetEnabled: false, updateManager, ...over });
  await new Promise((resolve) => made.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { made.server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${made.server.address().port}`, token: made.token };
}

const manager = (over = {}) => ({
  start() {}, close() {}, status: () => ({ phase: 'idle' }), setEnabled() {},
  check: async () => ({ phase: 'available', latest: '0.8.9' }),
  apply: async () => ({ phase: 'installing', latest: '0.8.9' }),
  ...over,
});

test('updater routes: authenticated check/apply ignore client package/version', async (t) => {
  let applies = 0;
  const { base, token } = await boot(t, manager({ apply: async () => { applies += 1; return { phase: 'installing' }; } }));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const check = await fetch(`${base}/api/settings/update/check`, { method: 'POST', headers, body: JSON.stringify({ package: 'evil', version: '999' }) });
  assert.equal(check.status, 200); assert.equal((await check.json()).latest, '0.8.9');
  const apply = await fetch(`${base}/api/settings/update/apply`, { method: 'POST', headers, body: JSON.stringify({ version: '999' }) });
  assert.equal(apply.status, 202); assert.equal((await apply.json()).phase, 'installing'); assert.equal(applies, 1);
});

test('updater routes: busy is 409 redacted and READONLY blocks before manager', async (t) => {
  const busy = new Error('busy /home/example/private'); busy.status = 409; busy.code = 'update-busy';
  let calls = 0;
  const { base, token } = await boot(t, manager({ apply: async () => { calls += 1; throw busy; } }));
  const headers = { authorization: `Bearer ${token}` };
  const response = await fetch(`${base}/api/settings/update/apply`, { method: 'POST', headers });
  assert.equal(response.status, 409);
  const body = await response.json(); assert.equal(body.code, 'update-busy'); assert.equal(body.error.includes('/home/example'), false);
  assert.equal(calls, 1);

  const readonlyManager = manager({ apply: async () => { throw new Error('must not run'); } });
  const second = await boot(t, readonlyManager, { readonlyDefault: true });
  const blocked = await fetch(`${second.base}/api/settings/update/apply`, { method: 'POST', headers: { authorization: `Bearer ${second.token}` } });
  assert.equal(blocked.status, 403);
});
