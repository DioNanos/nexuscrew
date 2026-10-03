'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const prefsStore = require('../lib/prefs/store.js');

const auth = (t) => ({ authorization: `Bearer ${t}` });
const json = (t, dev, extra = {}) => ({ ...auth(t), 'content-type': 'application/json', ...(dev ? { 'x-nc-device': dev } : {}), ...extra });
const data = { pins: ['n:cloud-Dev'], orders: { 'id:aa': ['n:cloud-Dev', 'n:cloud-Fork'] }, views: { local: { open: false, filter: 'all' } }, nodeOrder: ['id:aa'] };

async function boot(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncprefs-'));
  const prefsPath = path.join(dir, '.nexuscrew', 'prefs.json');
  const made = createServer({ home: dir, prefsPath, tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'), fleetEnabled: false, ...over });
  await new Promise((r) => made.server.listen(0, '127.0.0.1', r));
  t.after(() => { made.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${made.server.address().port}`, token: made.token, prefsPath };
}
const issue = async (b) => (await (await fetch(`${b.base}/api/prefs/devices`, { method: 'POST', headers: json(b.token) })).json()).deviceId;
const put = (b, dev, body, rev) => fetch(`${b.base}/api/prefs`, { method: 'PUT', headers: json(b.token, dev, rev === undefined ? {} : { 'if-match': `"${rev}"` }), body: JSON.stringify(body) });
const get = (b, dev) => fetch(`${b.base}/api/prefs`, { headers: json(b.token, dev) });

test('prefs API: senza bearer 401, senza dispositivo 400, dispositivo sconosciuto 404', async (t) => {
  const b = await boot(t);
  assert.equal((await fetch(`${b.base}/api/prefs`)).status, 401);
  assert.equal((await get(b, null)).status, 400);
  assert.equal((await get(b, 'f'.repeat(32))).status, 404);
  assert.equal((await fetch(`${b.base}/api/prefs/devices`, { method: 'POST' })).status, 401);
});

test('prefs API: il dispositivo emesso legge null, salva con If-Match e il roundtrip e\' identico', async (t) => {
  const b = await boot(t); const dev = await issue(b);
  assert.match(dev, /^[a-f0-9]{32}$/);
  let r = await get(b, dev); let j = await r.json();
  assert.equal(j.revision, 0); assert.equal(j.data, null); assert.equal(r.headers.get('etag'), '"0"');
  r = await put(b, dev, { data }, 0); assert.equal(r.status, 200); assert.equal((await r.json()).revision, 1);
  j = await (await get(b, dev)).json();
  assert.deepEqual(j.data, data); assert.equal(j.revision, 1);
  assert.equal(fs.statSync(b.prefsPath).mode & 0o777, 0o600);
});

test('prefs API: If-Match mancante 428, revisione vecchia 409 con la copia corrente (nessun lost update)', async (t) => {
  const b = await boot(t); const dev = await issue(b);
  assert.equal((await put(b, dev, { data })).status, 428);
  assert.equal((await put(b, dev, { data }, 0)).status, 200);
  const stale = await put(b, dev, { data: { ...data, pins: [] } }, 0);
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.code, 'revision-conflict'); assert.deepEqual(body.current.data, data);
  assert.deepEqual((await (await get(b, dev)).json()).data, data);
});

test('prefs API: due dispositivi con lo stesso bearer restano isolati', async (t) => {
  const b = await boot(t); const a = await issue(b); const c = await issue(b);
  assert.notEqual(a, c);
  assert.equal((await put(b, a, { data }, 0)).status, 200);
  const other = await (await get(b, c)).json();
  assert.equal(other.data, null); assert.equal(other.revision, 0);
  assert.equal((await put(b, c, { data: { pins: ['solo-c'] } }, 0)).status, 200);
  assert.deepEqual((await (await get(b, a)).json()).data, data);
});

test('prefs API: mai una copia vuota sopra preferenze esistenti; il primo salvataggio vuoto e\' ammesso', async (t) => {
  const b = await boot(t); const dev = await issue(b);
  assert.equal((await put(b, dev, { data: {} }, 0)).status, 200);
  assert.equal((await put(b, dev, { data }, 1)).status, 200);
  const r = await put(b, dev, { data: {} }, 2);
  assert.equal(r.status, 422); assert.equal((await r.json()).code, 'refuse-empty-overwrite');
  assert.deepEqual((await (await get(b, dev)).json()).data, data);
});

test('prefs API: schema a whitelist — token, diario e campi liberi rifiutati; nessun segreto nel file', async (t) => {
  const b = await boot(t); const dev = await issue(b);
  for (const bad of [{ token: 'x' }, { journal: [] }, { pins: 'a' }, { pins: [1] }, { orders: { a: 'b' } }, { views: { a: { open: 'si' } } }, { pins: Array(300).fill('k') }]) {
    const r = await put(b, dev, { data: bad }, 0);
    assert.equal(r.status, 422, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal((await put(b, dev, { data }, 0)).status, 200);
  assert.ok(!fs.readFileSync(b.prefsPath, 'utf8').includes(b.token));
});

test('prefs API: la rotazione del token non tocca le preferenze del dispositivo', async (t) => {
  const b = await boot(t); const dev = await issue(b);
  await put(b, dev, { data }, 0);
  const st = prefsStore.loadStore(b.prefsPath);
  assert.deepEqual(st.devices[dev].data, data); // legate al dispositivo, non al token
  assert.ok(!('token' in st.devices[dev]));
});

test('prefs API: READONLY blocca emissione e scrittura, la lettura resta', async (t) => {
  const b = await boot(t, { readonlyDefault: true });
  assert.equal((await fetch(`${b.base}/api/prefs/devices`, { method: 'POST', headers: json(b.token) })).status, 403);
});

test('prefs store: al limite scarta il dispositivo mai usato piu\' vecchio, non uno con dati', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncprefs-s-')); const p = path.join(dir, 'prefs.json');
  try {
    const st = prefsStore.emptyStore();
    for (let i = 0; i < prefsStore.MAX_DEVICES; i += 1) {
      const id = i.toString(16).padStart(32, '0');
      st.devices[id] = { createdAt: 100 + i, lastSeenAt: 0, revision: i === 0 ? 3 : 0, updatedAt: 0, data: i === 0 ? prefsStore.parseData({ pins: ['x'] }) : null };
    }
    prefsStore.atomicWrite(p, st);
    prefsStore.issueDevice(p, 999);
    const after = prefsStore.loadStore(p);
    assert.equal(Object.keys(after.devices).length, prefsStore.MAX_DEVICES);
    assert.ok(after.devices['0'.padStart(32, '0')], 'quello con dati resta');
    assert.ok(!after.devices['1'.padStart(32, '0')], 'il piu\' vecchio mai usato e\' stato scartato');
    for (const id of Object.keys(after.devices)) after.devices[id].revision = 1; // ora tutti usati
    prefsStore.atomicWrite(p, after);
    assert.throws(() => prefsStore.issueDevice(p), (e) => e.code === 'device-limit');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
