'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-fleet.sh');
const FAKE_TMUX = path.join(__dirname, 'fixtures', 'fake-tmux.sh');

// fleet.json valido minimale per i test del provider BUILTIN. NON serve che il
// command sia realmente lanciato: i test delle route define/edit/schema/501 non
// fanno up. Il fixture è un path assoluto, regular file e owner-executable.
const BUILTIN_DEFS = {
  schemaVersion: 1,
  engines: [
    { id: 'sh', label: 'Shell', command: FAKE_TMUX, args: ['-i'], promptMode: 'send-keys' },
  ],
  cells: [
    { id: 'Dev', cwd: os.homedir(), engine: 'sh', boot: false },
  ],
};

function boot(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncflr-'));
  process.env.FAKE_TMUX_LOG = path.join(dir, 'tmux.log');
  const { server, token, watcher } = createServer({
    home: dir, tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'), tmuxBin: FAKE_TMUX, ...over,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, token });
  }));
}

// Boot alternativo che forza il provider BUILTIN su un fleet.json temporaneo.
// fleetProvider:'builtin' vincola selectProvider (evita che il default real-device
// fleetBin vinca in auto-mode).
async function bootBuiltin(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncflbi-'));
  const defsPath = path.join(dir, 'fleet.json');
  const defs = { ...BUILTIN_DEFS, cells: BUILTIN_DEFS.cells.map((cell) => ({ ...cell, cwd: dir })) };
  fs.writeFileSync(defsPath, JSON.stringify(defs), { mode: 0o600 });
  fs.chmodSync(defsPath, 0o600);
  const r = await boot(t, { home: dir, fleetProvider: 'builtin', fleetDefsPath: defsPath, ...over });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return r;
}
const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('fleet unavailable: status {available:false} + provider/caps, comandi 404', async (t) => {
  const { base, token } = await boot(t, { fleetEnabled: false });
  const st = await (await fetch(`${base}/api/fleet/status`, { headers: H(token) })).json();
  assert.equal(st.available, false);
  assert.equal(st.provider, 'disabled');
  assert.equal(st.bootOwner, 'none');
  assert.deepEqual(st.capabilities, []);
  const up = await fetch(`${base}/api/fleet/up`, { method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Dev' }) });
  assert.equal(up.status, 404);
});

test('fleet available: status celle, up ok, cella ignota 400, Bearer richiesto', async (t) => {
  const { base, token } = await boot(t, { fleetBin: FAKE, fleetProvider: 'external' });
  assert.equal((await fetch(`${base}/api/fleet/status`)).status, 401);
  const st = await (await fetch(`${base}/api/fleet/status`, { headers: H(token) })).json();
  assert.equal(st.available, true);
  assert.equal(st.cells.length, 3);
  // external legacy: provider derivato + DEFAULT_CAPS (niente define/schema)
  assert.equal(st.provider, 'external');
  assert.equal(st.bootOwner, 'external');
  assert.equal(st.capabilities.includes('status'), true);
  assert.equal(st.capabilities.includes('schema'), false);
  const up = await fetch(`${base}/api/fleet/up`, { method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Build', engine: 'glm-a', boot: true }) });
  assert.deepEqual(await up.json(), { ok: true });
  const bad = await fetch(`${base}/api/fleet/up`, { method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Nope' }) });
  assert.equal(bad.status, 400);
});

// --- Provider BUILTIN (B4.2) ---

test('builtin: /status espone provider="builtin" e capabilities con define/import', async (t) => {
  const { base, token } = await bootBuiltin(t);
  const st = await (await fetch(`${base}/api/fleet/status`, { headers: H(token) })).json();
  assert.equal(st.available, true);
  assert.equal(st.provider, 'builtin');
  assert.equal(st.bootOwner, 'builtin');
  assert.equal(st.capabilities.includes('define'), true);
  assert.equal(st.capabilities.includes('import'), true);
  assert.equal(st.capabilities.includes('schema'), true);
  assert.equal(st.engines.some((e) => e.id === 'sh'), true);
});

test('builtin: /schema 200 con caps', async (t) => {
  const { base, token } = await bootBuiltin(t);
  const r = await fetch(`${base}/api/fleet/schema`, { headers: H(token) });
  assert.equal(r.status, 200);
  const sc = await r.json();
  assert.equal(sc.schemaVersion, 1);
  assert.ok(sc.caps && typeof sc.caps === 'object');
  assert.ok(sc.engine && sc.cell);
});

test('builtin: /definitions espone campi editabili ma non env values', async (t) => {
  const { base, token } = await bootBuiltin(t);
  const r = await fetch(`${base}/api/fleet/definitions`, { headers: H(token) });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.engines[0].command, FAKE_TMUX);
  assert.deepEqual(d.engines[0].envKeys, []);
  assert.equal(d.engines[0].env, undefined);
  assert.equal(d.cells[0].id, 'Dev');
});

test('builtin: restore-cells usa body cap dedicato e missing engines strutturati', async (t) => {
  const { base, token } = await bootBuiltin(t);
  const cells = Array.from({ length: 32 }, (_, index) => ({
    id: index === 0 ? 'Dev' : `C${index}`, cwd: '/tmp', engine: 'sh', boot: false,
    prompt: 'x'.repeat(7000),
  }));
  const restored = await fetch(`${base}/api/fleet/restore-cells`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ cells }),
  });
  assert.equal(restored.status, 200, 'payload >4kb ma <256kb accettato');
  assert.equal((await restored.json()).count, 32);

  const missing = await fetch(`${base}/api/fleet/restore-cells`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ cells: [{ id: 'X', cwd: '/tmp', engine: 'missing' }] }),
  });
  assert.equal(missing.status, 400);
  const detail = await missing.json();
  assert.equal(detail.code, 'missing-engines');
  assert.deepEqual(detail.missingEngines, ['missing']);
});

test('fleet JSON parser errors are JSON, including restore payload too large', async (t) => {
  const { base, token } = await bootBuiltin(t);
  const response = await fetch(`${base}/api/fleet/restore-cells`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ cells: [], padding: 'x'.repeat(270 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'body-too-large');
});

test('builtin: /define-engine valido 200 e persiste (rileggo /status engines)', async (t) => {
  const { base, token } = await bootBuiltin(t);
  const def = { id: 'codex', label: 'Codex', command: '/bin/sh', promptMode: 'send-keys' };
  const r = await fetch(`${base}/api/fleet/define-engine`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ def }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, id: 'codex' });
  const st = await (await fetch(`${base}/api/fleet/status`, { headers: H(token) })).json();
  assert.equal(st.engines.some((e) => e.id === 'codex'), true);
});

test('builtin: /define-engine invalido (env PATH) -> 400', async (t) => {
  const { base, token } = await bootBuiltin(t);
  const def = { id: 'bad', command: '/bin/sh', promptMode: 'send-keys', env: { PATH: 'x' } };
  const r = await fetch(`${base}/api/fleet/define-engine`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ def }),
  });
  assert.equal(r.status, 400);
});

test('builtin: define/edit/remove cell+engine funzionano (copertura nuove route)', async (t) => {
  const { base, token } = await bootBuiltin(t);
  const post = (route, body) => fetch(`${base}/api/fleet/${route}`, { method: 'POST', headers: H(token), body: JSON.stringify(body) });

  // define-cell referenzia l'engine 'sh' esistente
  assert.equal((await post('define-cell', { def: { id: 'Trading', cwd: os.homedir(), engine: 'sh' } })).status, 200);
  // edit-engine: cambio la label di 'sh'
  assert.equal((await post('edit-engine', { id: 'sh', patch: { label: 'Shell++' } })).status, 200);
  // edit-cell: cambio boot della cella Dev
  assert.equal((await post('edit-cell', { id: 'Dev', patch: { boot: true } })).status, 200);
  // remove-cell (libera l'eventuale uso), poi remove-engine di un engine nuovo non usato
  await post('define-engine', { def: { id: 'extra', command: '/bin/sh', promptMode: 'send-keys' } });
  assert.equal((await post('remove-engine', { id: 'extra' })).status, 200);
  // remove-engine su engine IN USO (sh) -> 400 (coerenza builtin)
  assert.equal((await post('remove-engine', { id: 'sh' })).status, 400);
});

test('builtin lifecycle: up preserva boot se omesso; PowerSheet puo abilitarlo o rimuoverlo', async (t) => {
  const { base, token } = await bootBuiltin(t);
  const post = (route, body) => fetch(`${base}/api/fleet/${route}`, {
    method: 'POST', headers: H(token), body: JSON.stringify(body),
  });
  const definitions = async () => (await fetch(`${base}/api/fleet/definitions`, { headers: H(token) })).json();

  assert.equal((await post('edit-cell', { id: 'Dev', patch: { boot: true } })).status, 200);
  const firstUp = await post('up', { cell: 'Dev' });
  assert.equal(firstUp.status, 200, JSON.stringify(await firstUp.json()));
  assert.equal((await definitions()).cells[0].boot, true, 'start rapido non modifica il boot esistente');
  assert.equal((await post('down', { cell: 'Dev', boot: true })).status, 200);
  assert.equal((await definitions()).cells[0].boot, false, 'togli anche dal boot persiste lo stato');
  const secondUp = await post('up', { cell: 'Dev', boot: true });
  assert.equal(secondUp.status, 200, JSON.stringify(await secondUp.json()));
  assert.equal((await definitions()).cells[0].boot, true, 'avvia al boot persiste lo stato');
});

test('external legacy: /schema -> 501 (capability mancante, design 9c)', async (t) => {
  const { base, token } = await boot(t, { fleetBin: FAKE, fleetProvider: 'external' });
  const r = await fetch(`${base}/api/fleet/schema`, { headers: H(token) });
  assert.equal(r.status, 501);
  assert.match((await r.json()).error, /not supported/);
});

test('external legacy: /import-cell -> 501 (capability dedicata mancante)', async (t) => {
  const { base, token } = await boot(t, { fleetBin: FAKE, fleetProvider: 'external' });
  const r = await fetch(`${base}/api/fleet/import-cell`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ tmuxSession: 'legacy', engine: 'sh' }),
  });
  assert.equal(r.status, 501);
  assert.match((await r.json()).error, /not supported/);
});

test('restart: provider legacy senza capability restart -> 501', async (t) => {
  // DEFAULT_CAPS non include 'restart' (solo il built-in lo espone): route -> 501.
  const { base, token } = await boot(t, { fleetBin: FAKE, fleetProvider: 'external' });
  const r = await fetch(`${base}/api/fleet/restart`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Dev' }),
  });
  assert.equal(r.status, 501);
  assert.match((await r.json()).error, /not supported/);
});

test('builtin: /status capabilities include restart (capability del built-in)', async (t) => {
  // verifica indiretta che il builtin espone 'restart': non viene lanciato davvero
  // (manca il mock tmux a livello route) — si controlla solo la capability negoziata.
  const { base, token } = await bootBuiltin(t);
  const st = await (await fetch(`${base}/api/fleet/status`, { headers: H(token) })).json();
  assert.equal(st.capabilities.includes('restart'), true);
});

test('READONLY: restart bloccato -> 403 (gate di mutazione, prima della capability)', async (t) => {
  const { base, token } = await bootBuiltin(t, { readonlyDefault: true });
  const r = await fetch(`${base}/api/fleet/restart`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Dev' }),
  });
  assert.equal(r.status, 403);
});

test('READONLY: builtin blocca mutazioni (403) ma lascia passare letture', async (t) => {
  // NEXUSCREW_READONLY=1 in produzione → loadConfig/envOverrides → cfg.readonlyDefault=true
  // → createBuiltinFleet(readonly). Lo si replica qui via cfg (NON via process.env
  // globale: il test runner parallelo leggerebbe l'env da altri file e diventerebbe
  // flaky). readonlyDefault true attiva lo STESSO gate readonly() del builtin.
  const { base, token } = await bootBuiltin(t, { readonlyDefault: true });
  const post = (route, body) => fetch(`${base}/api/fleet/${route}`, { method: 'POST', headers: H(token), body: JSON.stringify(body) });

  // letture pure passano
  assert.equal((await fetch(`${base}/api/fleet/status`, { headers: H(token) })).status, 200);
  assert.equal((await fetch(`${base}/api/fleet/schema`, { headers: H(token) })).status, 200);

  // mutazioni fleet + up bloccate (§9d)
  const def = { id: 'codex', command: '/bin/sh', promptMode: 'send-keys' };
  assert.equal((await post('define-engine', { def })).status, 403);
  assert.equal((await post('up', { cell: 'Dev' })).status, 403);
});

test('READONLY a livello route: blocca le mutazioni anche sul provider EXTERNAL legacy', async (t) => {
  // Audit impl finding #3 (MAJOR): il gate readonly del builtin non copre
  // l'external (createFleet legacy non lo controlla) — l'enforcement vive
  // nel router, PRIMA del dispatch, per QUALUNQUE provider.
  const { base, token } = await boot(t, { readonlyDefault: true });
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  // status resta leggibile
  assert.equal((await fetch(`${base}/api/fleet/status`, { headers: H })).status, 200);
  // ogni mutazione → 403, senza raggiungere il fleet esterno
  for (const [route, body] of [
    ['up', { cell: 'Dev' }], ['down', { cell: 'Dev' }],
    ['engine', { cell: 'Dev', engine: 'native' }], ['boot', { cell: 'Dev', enabled: true }],
    ['define-engine', { def: {} }], ['edit-cell', { id: 'x', patch: {} }],
  ]) {
    const r = await fetch(`${base}/api/fleet/${route}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    assert.equal(r.status, 403, `${route} deve dare 403 in READONLY (external)`);
  }
});
