'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createServer } = require('../lib/server.js');
const { fleetRoutes } = require('../lib/fleet/routes.js');

const FAKE_TMUX = path.join(__dirname, 'fixtures', 'fake-tmux.sh');

// fleet.json valido minimale per i test del provider BUILTIN. NON serve che il
// command sia realmente lanciato per la maggior parte delle route. Il fixture
// è un path assoluto, regular file e owner-executable.
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

// Boot con un fleet.json temporaneo gestito dal provider interno NexusCrew.
async function bootBuiltin(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncflbi-'));
  const defsPath = path.join(dir, 'fleet.json');
  const defs = { ...BUILTIN_DEFS, cells: BUILTIN_DEFS.cells.map((cell) => ({ ...cell, cwd: dir })) };
  fs.writeFileSync(defsPath, JSON.stringify(defs), { mode: 0o600 });
  fs.chmodSync(defsPath, 0o600);
  const r = await boot(t, {
    home: dir,
    fleetDefsPath: defsPath,
    providerSecretsPath: path.join(dir, '.nexuscrew', 'providers.env'),
    providerShellPath: path.join(dir, '.config', 'ai-shell', 'providers.zsh'),
    providerKeysPath: path.join(dir, '.config', 'keys', 'ai.env'),
    providerSecurePath: path.join(dir, '.config', 'secure', '.env'),
    credentialsPath: path.join(dir, '.nexuscrew', 'credentials.json'),
    ...over,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ...r, dir, defsPath };
}
const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

function bootRouteOnly(t, fleet) {
  const app = express();
  app.use('/api/fleet', fleetRoutes(Promise.resolve(fleet)));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  return new Promise((resolve) => server.once('listening', () => {
    resolve(`http://127.0.0.1:${server.address().port}`);
  }));
}

test('fleet unavailable: status {available:false} + provider/caps, comandi 404', async (t) => {
  const { base, token } = await boot(t, { fleetEnabled: false });
  const st = await (await fetch(`${base}/api/fleet/status`, { headers: H(token) })).json();
  assert.equal(st.available, false);
  assert.equal(st.provider, 'disabled');
  assert.equal(st.bootOwner, 'none');
  assert.deepEqual(st.capabilities, []);
  assert.match(st.reason, /fleet disabilitata/);
  const up = await fetch(`${base}/api/fleet/up`, { method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Dev' }) });
  assert.equal(up.status, 404);
});

test('fleet builtin: Bearer richiesto, status e lifecycle disponibili', async (t) => {
  const { base, token } = await bootBuiltin(t);
  assert.equal((await fetch(`${base}/api/fleet/status`)).status, 401);
  const st = await (await fetch(`${base}/api/fleet/status`, { headers: H(token) })).json();
  assert.equal(st.available, true);
  assert.equal(st.cells.length, 1);
  assert.equal(st.provider, 'builtin');
  assert.equal(st.bootOwner, 'builtin');
  assert.equal(st.capabilities.includes('status'), true);
  assert.equal(st.capabilities.includes('schema'), true);
  const up = await fetch(`${base}/api/fleet/up`, { method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Dev', boot: true }) });
  assert.equal(up.status, 200);
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

test('builtin: credential API is write-only, local to the selected node and reports affected cells', async (t) => {
  const { base, token, dir } = await bootBuiltin(t);
  const binDir = path.join(dir, '.local', 'bin'); fs.mkdirSync(binDir, { recursive: true });
  const binary = path.join(binDir, 'codex-vl'); fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); fs.chmodSync(binary, 0o755);
  const post = (action, body) => fetch(`${base}/api/fleet/${action}`, { method: 'POST', headers: H(token), body: JSON.stringify(body) });
  const def = {
    id: 'codex-vl.ollama-cloud', label: 'Ollama Cloud',
    managed: { client: 'codex-vl', provider: 'ollama-cloud', model: 'glm-5.2', permissionPolicy: 'standard' },
  };
  assert.equal((await post('define-engine', { def })).status, 200);
  let status = await (await fetch(`${base}/api/fleet/credentials/status`, { headers: H(token) })).json();
  assert.deepEqual(status.credentials.map((entry) => ({ envKey: entry.envKey, configured: entry.configured, source: entry.source })), [
    { envKey: 'OLLAMA_API_KEY', configured: false, source: 'missing' },
  ]);
  const savedResponse = await post('credentials/set', { envKey: 'OLLAMA_API_KEY', value: 'route-secret' });
  assert.equal(savedResponse.status, 200);
  status = await savedResponse.json();
  assert.equal(status.credentials[0].source, 'local');
  assert.equal(JSON.stringify(status).includes('route-secret'), false, 'secret never leaves the API');
  const stored = path.join(dir, '.nexuscrew', 'credentials.json');
  assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
  assert.equal((await post('credentials/set', { envKey: 'UNUSED_KEY', value: 'x' })).status, 400);
  assert.equal((await post('credentials/remove', { envKey: 'OLLAMA_API_KEY' })).status, 200);
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

test('builtin: POST /boot cambia solo la preferenza e non invoca lifecycle', async (t) => {
  const { base, token, defsPath } = await bootBuiltin(t);
  const tmuxLog = process.env.FAKE_TMUX_LOG;
  const before = fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8') : '';
  const response = await fetch(`${base}/api/fleet/boot`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Dev', enabled: true }),
  });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.equal(JSON.parse(fs.readFileSync(defsPath, 'utf8')).cells[0].boot, true);
  const after = fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8') : '';
  assert.equal(after, before, 'boot preference endpoint must not call tmux up/down');
});

test('POST /boot returns 501 without the negotiated boot capability', async (t) => {
  let calls = 0;
  const base = await bootRouteOnly(t, {
    available: true,
    capabilities: () => ['status'],
    boot: async () => { calls += 1; return { ok: true }; },
  });
  const response = await fetch(`${base}/api/fleet/boot`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cell: 'Dev', enabled: true }),
  });
  assert.equal(response.status, 501);
  assert.equal(calls, 0);
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
