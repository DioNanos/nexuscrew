'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-fleet.sh');

function boot(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncflr-'));
  const { server, token, watcher } = createServer({
    tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'), ...over,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, token });
  }));
}
const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('fleet unavailable: status {available:false}, comandi 404', async (t) => {
  const { base, token } = await boot(t, { fleetEnabled: false });
  const st = await (await fetch(`${base}/api/fleet/status`, { headers: H(token) })).json();
  assert.deepEqual(st, { available: false });
  const up = await fetch(`${base}/api/fleet/up`, { method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Dev' }) });
  assert.equal(up.status, 404);
});

test('fleet available: status celle, up ok, cella ignota 400, Bearer richiesto', async (t) => {
  const { base, token } = await boot(t, { fleetBin: FAKE });
  assert.equal((await fetch(`${base}/api/fleet/status`)).status, 401);
  const st = await (await fetch(`${base}/api/fleet/status`, { headers: H(token) })).json();
  assert.equal(st.available, true);
  assert.equal(st.cells.length, 3);
  const up = await fetch(`${base}/api/fleet/up`, { method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Dev', engine: 'glm-a', boot: true }) });
  assert.deepEqual(await up.json(), { ok: true });
  const bad = await fetch(`${base}/api/fleet/up`, { method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Nope' }) });
  assert.equal(bad.status, 400);
});
