'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const decksStore = require('../lib/decks/store.js');

const H = (t) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
const layout = { columns: [{ width: 1, tiles: [{ session: 'dev', height: 1, fontSize: 11 }] }] };
async function boot(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdapi-'));
  const decksPath = path.join(dir, '.nexuscrew', 'decks.json');
  decksStore.initStore(decksPath);
  const made = createServer({ home: dir, decksPath, tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'), fleetEnabled: false, ...over });
  await new Promise((r) => made.server.listen(0, '127.0.0.1', r));
  t.after(() => { made.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${made.server.address().port}`, token: made.token, decksPath };
}

test('decks API: auth + create/save/conflict/rename/delete', async (t) => {
  const { base, token } = await boot(t); const h = H(token);
  assert.equal((await fetch(`${base}/api/decks`)).status, 401);
  let r = await fetch(`${base}/api/decks`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'work' }) });
  assert.equal(r.status, 201); let d = await r.json(); assert.equal(d.revision, 0);
  r = await fetch(`${base}/api/decks/work`, { method: 'PUT', headers: h, body: JSON.stringify({ layout, expectedRevision: 0 }) });
  assert.equal(r.status, 200); d = await r.json(); assert.equal(d.revision, 1);
  r = await fetch(`${base}/api/decks/work`, { method: 'PUT', headers: h, body: JSON.stringify({ layout, expectedRevision: 0 }) });
  assert.equal(r.status, 409); assert.equal((await r.json()).current.revision, 1);
  r = await fetch(`${base}/api/decks/work`, { method: 'PATCH', headers: h, body: JSON.stringify({ name: 'focus', expectedRevision: 1 }) });
  assert.equal(r.status, 200); d = await r.json(); assert.equal(d.name, 'focus');
  r = await fetch(`${base}/api/decks/focus`, { method: 'DELETE', headers: h, body: JSON.stringify({ expectedRevision: 2 }) });
  assert.equal(r.status, 200);
  const st = await (await fetch(`${base}/api/decks`, { headers: h })).json();
  assert.deepEqual(st.decks.map((x) => x.name), ['main']);
});

test('decks API: READONLY blocca mutazioni', async (t) => {
  const { base, token } = await boot(t, { readonlyDefault: true });
  const r = await fetch(`${base}/api/decks`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'x' }) });
  assert.equal(r.status, 403);
});

test('decks API round-trips multi-hop tiles with duplicate session names at distinct routes', async (t) => {
  const { base, token } = await boot(t); const h = H(token);
  const multi = { columns: [{ width: 1, tiles: [
    { session: 'work', node: 'relay/phone', height: 1, fontSize: 11 },
    { session: 'work', node: 'relay/mac', height: 1, fontSize: 11 },
  ] }] };
  const saved = await fetch(`${base}/api/decks/main`, { method: 'PUT', headers: h, body: JSON.stringify({ layout: multi, expectedRevision: 0 }) });
  assert.equal(saved.status, 200);
  const listed = await (await fetch(`${base}/api/decks`, { headers: h })).json();
  assert.deepEqual(listed.decks[0].layout, multi);
});

test('decks API: ENOENT runtime risponde 503 senza ricreare lo store', async (t) => {
  const { base, token, decksPath } = await boot(t);
  fs.unlinkSync(decksPath);
  const response = await fetch(`${base}/api/decks`, { headers: H(token) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.includes('nexuscrew init'), true);
  assert.equal(fs.existsSync(decksPath), false);
});
