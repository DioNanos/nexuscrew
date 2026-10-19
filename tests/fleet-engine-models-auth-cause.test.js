'use strict';
// tests/fleet-engine-models-auth-cause.test.js — curated authentication
// diagnosis of the model listing. What the route learns about WHY a listing
// asked for a key: a fixed cause composed from the credential state, the
// attempt facts (status/category/credential applied) and the cache status.
// Every endpoint answer comes from an injected fake fetch: no provider, no
// real network, not even the public catalog. Most cases answer an invalid
// snapshot for it, so the public layer skips cleanly; the cache-counting
// family below routes a VALID snapshot and counts the listing and the
// catalog requests separately, because the two caches keep separate TTLs.
// The credential VALUE is a sentinel: it must never surface in a response,
// an error or the cache.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { createServer } = require('../lib/server.js');
const { PUBLIC_CATALOG_URL } = require('../lib/fleet/model-discovery.js');

const FAKE_TMUX = path.join(__dirname, 'fixtures', 'fake-tmux.sh');
const KEY = 'sekret-auth-cause-sentinel';

function isolatedHome(t, prefix = 'ncauth-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFleet(dir) {
  const defsPath = path.join(dir, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [
      {
        id: 'myapi', label: 'My API', managed: {
          client: 'codex-vl', provider: 'custom', model: 'm-1', permissionPolicy: 'standard',
          displayName: 'My API', baseUrl: 'http://endpoint.example/v1', protocol: 'openai_responses',
          envKey: 'MY_API_KEY', providerId: 'my-api',
        },
      },
    ],
    models: [], cells: [],
  }), { mode: 0o600 });
  fs.chmodSync(defsPath, 0o600);
  return defsPath;
}

// `env: {}` pins the runtime credential source to nothing: the machine the
// suite runs on may legitimately carry provider keys in its environment, and
// the diagnosis must not depend on that.
async function bootFleet(t, dir) {
  const fleet = await createBuiltinFleet({
    home: dir, fleetDefsPath: writeFleet(dir), protectSharedTmuxServer: false, env: {},
    providerSecretsPath: path.join(dir, '.nexuscrew', 'providers.env'),
    providerShellPath: path.join(dir, '.config', 'ai-shell', 'providers.zsh'),
    providerKeysPath: path.join(dir, '.config', 'keys', 'ai.env'),
    providerSecurePath: path.join(dir, '.config', 'secure', '.env'),
    credentialsPath: path.join(dir, '.nexuscrew', 'credentials.json'),
  });
  t.after(() => fleet.close());
  return fleet;
}

const reply = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: opts.headers || {} });
    // Public catalog: an invalid snapshot so the public layer always skips.
    if (u.includes('models.dev')) return reply(200, { data: [] });
    return handler(u, opts);
  };
  fn.calls = calls;
  return fn;
}

const cacheFile = (dir, engine) => path.join(dir, '.nexuscrew', 'model-discovery', `${engine}.json`);
const publicCatalogFile = (dir) => path.join(dir, '.nexuscrew', 'model-discovery', 'public-catalog.json');

// A valid public catalog snapshot: one provider whose model map carries the
// engine's listing id. The engine host maps to no catalog namespace of its
// own, so the by-id fallback across the whole snapshot is what enriches it.
const snapshotWith = (context) => ({
  acme: { id: 'acme', name: 'Acme', models: { 'm-1': { limit: { context, output: 4096 } } } },
});

// URL-routed fake with SEPARATE counters. The listing endpoint and the public
// catalog answer different shapes and keep different caches with different
// TTLs: what the cache-counting cases pin is which of the two a discovery is
// allowed to re-read. `listing` and `snapshot` may be reassigned between
// discoveries to change what the endpoint says over time.
function routedFetch({ listing, snapshot }) {
  const calls = { listing: 0, snapshot: 0 };
  const fn = async (url, opts = {}) => {
    if (String(url) === PUBLIC_CATALOG_URL) {
      calls.snapshot += 1;
      return snapshot(opts);
    }
    calls.listing += 1;
    return listing(opts);
  };
  fn.calls = calls;
  return fn;
}

test('401 without any credential: missing-key with the env key, request anonymous', async (t) => {
  const fleet = await bootFleet(t, isolatedHome(t));
  // The sentinel hides in the provider BODY: the sanitized reason must not
  // carry it (nor anything else) out.
  const fetchImpl = fakeFetch(() => reply(401, { error: `bad key ${KEY}` }));
  const out = await fleet.discoverEngineModels('myapi', { fetchImpl });
  assert.equal(out.status, 'backup');
  assert.equal(out.error, 'HTTP 401');
  assert.deepEqual(out.auth, {
    credentialState: 'missing', envKey: 'MY_API_KEY', attempted: true, credentialSent: false, cause: 'missing-key',
  });
  assert.equal(fetchImpl.calls[0].headers.authorization, undefined, 'the request really went out anonymous');
  assert.ok(!JSON.stringify(out).includes(KEY), 'the key never appears in the response');
});

test('401 with the credential really applied: key-rejected, never a claim it is wrong or expired', async (t) => {
  const fleet = await bootFleet(t, isolatedHome(t));
  await fleet.setLocalCredential('MY_API_KEY', KEY);
  const fetchImpl = fakeFetch(() => reply(401));
  const out = await fleet.discoverEngineModels('myapi', { fetchImpl });
  assert.deepEqual(out.auth, {
    credentialState: 'configured', envKey: 'MY_API_KEY', attempted: true, credentialSent: true, cause: 'key-rejected',
  });
  // "credential sent" means the header, not just a valued plan.
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.ok(!JSON.stringify(out).includes(KEY));
});

test('403 stays access-denied with AND without the credential: no key shortcut', async (t) => {
  const withKey = await bootFleet(t, isolatedHome(t));
  await withKey.setLocalCredential('MY_API_KEY', KEY);
  const outWith = await withKey.discoverEngineModels('myapi', { fetchImpl: fakeFetch(() => reply(403)) });
  assert.deepEqual(outWith.auth, {
    credentialState: 'configured', envKey: 'MY_API_KEY', attempted: true, credentialSent: true, cause: 'access-denied',
  }, '403 with a key is NOT key-rejected');

  const noKey = await bootFleet(t, isolatedHome(t));
  const outWithout = await noKey.discoverEngineModels('myapi', { fetchImpl: fakeFetch(() => reply(403)) });
  assert.deepEqual(outWithout.auth, {
    credentialState: 'missing', envKey: 'MY_API_KEY', attempted: true, credentialSent: false, cause: 'access-denied',
  }, '403 without a key is NOT missing-key');
});

test('an unreadable credential file is credential-unavailable, distinct from missing', async (t) => {
  const dir = isolatedHome(t);
  const keysPath = path.join(dir, '.config', 'keys', 'ai.env');
  fs.mkdirSync(path.dirname(keysPath), { recursive: true });
  fs.writeFileSync(keysPath, `MY_API_KEY=${KEY}\n`, { mode: 0o600 });
  fs.chmodSync(keysPath, 0o000); // exists, but cannot be read: not "missing"
  const fleet = await bootFleet(t, dir);
  const out = await fleet.discoverEngineModels('myapi', { fetchImpl: fakeFetch(() => reply(401)) });
  assert.deepEqual(out.auth, {
    credentialState: 'unavailable', envKey: 'MY_API_KEY', attempted: true, credentialSent: false, cause: 'credential-unavailable',
  });
  assert.ok(!JSON.stringify(out).includes(KEY), 'the unreadable value never leaks either');
});

test('anonymous success: the listing came back without a key, said exactly that way', async (t) => {
  const fleet = await bootFleet(t, isolatedHome(t));
  const out = await fleet.discoverEngineModels('myapi', { fetchImpl: fakeFetch(() => reply(200, { data: [{ id: 'm-1' }] })) });
  assert.equal(out.status, 'api');
  assert.deepEqual(out.auth, {
    credentialState: 'missing', envKey: 'MY_API_KEY', attempted: true, credentialSent: false, cause: 'anonymous-success',
  });
});

test('engine declared auth none (local ollama): anonymous rejection names no invented key', async (t) => {
  const fleet = await bootFleet(t, isolatedHome(t));
  const fetchImpl = fakeFetch((url) => (url.includes('/api/tags') ? reply(401, {}) : reply(401, {})));
  const out = await fleet.discoverEngineModels('codex-vl.ollama', { fetchImpl });
  assert.deepEqual(out.auth, {
    credentialState: 'none', attempted: true, credentialSent: false, cause: 'missing-key',
  }, 'no envKey: auth none has no key name to show');
  // And a listing that answers anyway is an anonymous success, not a promise
  // that the endpoint never wants a key.
  const ok = await fleet.discoverEngineModels('codex-vl.ollama', {
    fetchImpl: fakeFetch((url) => (url.includes('/api/tags') ? reply(200, { models: [{ name: 'm-1' }] }) : reply(200, {}))),
  });
  assert.equal(ok.auth.cause, 'anonymous-success');
  assert.equal(ok.auth.credentialState, 'none');
});

test('a fixed-env catalog engine names its public key: OPENCODE_API_KEY, missing', async (t) => {
  const fleet = await bootFleet(t, isolatedHome(t));
  const out = await fleet.discoverEngineModels('claude.opencode-go', { fetchImpl: fakeFetch(() => reply(401)) });
  assert.deepEqual(out.auth, {
    credentialState: 'missing', envKey: 'OPENCODE_API_KEY', attempted: true, credentialSent: false, cause: 'missing-key',
  });
});

test('fresh cache: attempted=false, no cause, and no new listing request', async (t) => {
  const fleet = await bootFleet(t, isolatedHome(t));
  const fetchImpl = routedFetch({
    listing: () => reply(200, { data: [{ id: 'm-1' }] }),
    snapshot: () => reply(200, snapshotWith(8192)),
  });
  await fleet.discoverEngineModels('myapi', { fetchImpl });
  assert.equal(fetchImpl.calls.listing, 1, 'the first discovery read the listing once');
  assert.equal(fetchImpl.calls.snapshot, 1, 'and the catalog snapshot once');
  const cached = await fleet.discoverEngineModels('myapi', { fetchImpl });
  assert.equal(fetchImpl.calls.listing, 1, 'the listing cache served: no new listing request');
  assert.equal(fetchImpl.calls.snapshot, 1, 'the snapshot memo served too: no new catalog request');
  assert.equal(fetchImpl.calls.listing + fetchImpl.calls.snapshot, 2, 'nothing else went out');
  assert.equal(cached.status, 'cache');
  assert.deepEqual(cached.auth, {
    credentialState: 'missing', envKey: 'MY_API_KEY', attempted: false, credentialSent: false,
  }, 'no fresh claim about the key: no cause key at all');
});

test('an invalid public snapshot: the second read may retry the catalog alone, never the listing', async (t) => {
  const fleet = await bootFleet(t, isolatedHome(t));
  const fetchImpl = routedFetch({
    listing: () => reply(200, { data: [{ id: 'm-1' }] }),
    snapshot: () => reply(200, { data: [] }), // not a catalog: nothing memoized, nothing cached
  });
  await fleet.discoverEngineModels('myapi', { fetchImpl });
  const retried = await fleet.discoverEngineModels('myapi', { fetchImpl });
  assert.equal(fetchImpl.calls.listing, 1, 'the fresh listing cache served: still exactly one listing request');
  assert.equal(fetchImpl.calls.snapshot, 2, 'only the catalog was retried');
  assert.equal(retried.status, 'cache');
  assert.deepEqual(retried.auth, {
    credentialState: 'missing', envKey: 'MY_API_KEY', attempted: false, credentialSent: false,
  }, 'a catalog retry is not a listing attempt: no new diagnosis');
});

test('an expired catalog with a fresh listing: only the snapshot is refetched and the enriched default updates', async (t) => {
  const dir = isolatedHome(t);
  let context = 8192;
  const fetchImpl = routedFetch({
    listing: () => reply(200, { data: [{ id: 'm-1' }] }),
    snapshot: () => reply(200, snapshotWith(context)),
  });
  const firstFleet = await bootFleet(t, dir);
  const first = await firstFleet.discoverEngineModels('myapi', { fetchImpl });
  const before = first.models.find((m) => m.id === 'm-1');
  assert.equal(before.contextWindow, 8192, 'the snapshot enriched the listing id');
  assert.equal(before.fieldSources.contextWindow, 'public');
  // Expire the on-disk snapshot past its own TTL; the listing cache stays fresh.
  const file = publicCatalogFile(dir);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  parsed.fetchedAt -= 25 * 3600 * 1000;
  fs.writeFileSync(file, JSON.stringify(parsed));
  context = 16384; // the refreshed snapshot knows a bigger window
  // A new fleet on the same home: its in-process snapshot memo is empty, so
  // the expired disk snapshot is the only thing left to consult.
  const secondFleet = await bootFleet(t, dir);
  const second = await secondFleet.discoverEngineModels('myapi', { fetchImpl });
  assert.equal(fetchImpl.calls.listing, 1, 'the fresh listing cache served: no new listing request');
  assert.equal(fetchImpl.calls.snapshot, 2, 'only the snapshot was refetched');
  assert.equal(second.status, 'cache');
  const after = second.models.find((m) => m.id === 'm-1');
  assert.equal(after.contextWindow, 16384, 'the enriched default follows the refreshed snapshot');
  assert.equal(after.fieldSources.contextWindow, 'public');
  assert.deepEqual(second.auth, {
    credentialState: 'missing', envKey: 'MY_API_KEY', attempted: false, credentialSent: false,
  }, 'a catalog refresh is not a listing attempt: the diagnosis does not move');
});

test('a stale listing with a failed attempt keeps the diagnosis while the catalog stays silent', async (t) => {
  const dir = isolatedHome(t);
  let answer = () => reply(200, { data: [{ id: 'm-1' }] });
  const fetchImpl = routedFetch({
    listing: () => answer(),
    snapshot: () => reply(200, snapshotWith(8192)),
  });
  const fleet = await bootFleet(t, dir);
  await fleet.discoverEngineModels('myapi', { fetchImpl });
  // Expire the listing past its TTL; the snapshot memo is still fresh.
  const file = cacheFile(dir, 'myapi');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  parsed.fetchedAt -= 13 * 3600 * 1000;
  fs.writeFileSync(file, JSON.stringify(parsed));
  answer = () => reply(401, { error: 'unauthorized' });
  const out = await fleet.discoverEngineModels('myapi', { fetchImpl });
  assert.equal(fetchImpl.calls.listing, 2, 'the stale listing was attempted again');
  assert.equal(fetchImpl.calls.snapshot, 1, 'the fresh snapshot memo added no request');
  assert.equal(out.status, 'cache');
  assert.equal(out.stale, true);
  assert.deepEqual(out.auth, {
    credentialState: 'missing', envKey: 'MY_API_KEY', attempted: true, credentialSent: false, cause: 'missing-key',
  }, 'the failed attempt is diagnosed even with a live catalog layer');
});

test('rejection with stale data: the diagnosis stays visible and the listing still serves', async (t) => {
  const dir = isolatedHome(t);
  const fleet = await bootFleet(t, dir);
  const fetchImpl = fakeFetch(() => reply(200, { data: [{ id: 'm-1' }] }));
  await fleet.discoverEngineModels('myapi', { fetchImpl });
  // Expire the on-disk value, then let the endpoint reject.
  const file = cacheFile(dir, 'myapi');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  parsed.fetchedAt -= 13 * 3600 * 1000;
  fs.writeFileSync(file, JSON.stringify(parsed));
  const out = await fleet.discoverEngineModels('myapi', { fetchImpl: fakeFetch(() => reply(401)) });
  assert.equal(out.status, 'cache');
  assert.equal(out.stale, true);
  assert.ok(out.models.some((m) => m.id === 'm-1'), 'the last good listing still serves');
  assert.deepEqual(out.auth, {
    credentialState: 'missing', envKey: 'MY_API_KEY', attempted: true, credentialSent: false, cause: 'missing-key',
  }, 'the diagnosis describes the failed attempt, not the cached value');
  assert.ok(!JSON.stringify(out).includes(KEY));
  assert.ok(!fs.readFileSync(file, 'utf8').includes(KEY), 'no key in the cache file');
});

test('transport and provider failures map to their own causes, never to a key problem', async (t) => {
  const fleet = await bootFleet(t, isolatedHome(t));
  let answer = null;
  const fetchImpl = fakeFetch(() => answer());
  const run = async () => fleet.discoverEngineModels('myapi', { fetchImpl });

  const aborted = new Error('The operation was aborted');
  aborted.name = 'AbortError';
  answer = () => { throw aborted; };
  const timeout = await run();
  assert.equal(timeout.error, 'timeout after 2500ms');
  assert.deepEqual(timeout.auth, {
    credentialState: 'missing', envKey: 'MY_API_KEY', attempted: true, credentialSent: false, cause: 'endpoint-unreachable',
  });

  answer = () => reply(429, { error: 'rate limited' });
  const rate = await run();
  assert.deepEqual(rate.auth, {
    credentialState: 'missing', envKey: 'MY_API_KEY', attempted: true, credentialSent: false, cause: 'provider-error',
  }, '429 is not an unreachable endpoint and not a rejected key');

  answer = () => reply(500, { error: 'boom' });
  const server = await run();
  assert.equal(server.auth.cause, 'provider-error');

  answer = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(KEY); } });
  const bad = await run();
  assert.equal(bad.error, 'invalid JSON response');
  assert.equal(bad.auth.cause, 'invalid-response');
  assert.ok(!JSON.stringify(bad).includes(KEY), 'the parse error text stays inside');
});

test('the route answer carries the diagnosis and never the key, the endpoint or the plan', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncauthroute-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.FAKE_TMUX_LOG = path.join(dir, 'tmux.log');
  const requests = [];
  const endpoint = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => endpoint.closeAllConnections?.() ?? resolve(endpoint.close(resolve))));
  const baseUrl = `http://127.0.0.1:${endpoint.address().port}`;
  const defsPath = path.join(dir, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [{
      id: 'myapi', label: 'My API', managed: {
        client: 'codex-vl', provider: 'custom', model: 'm-1', permissionPolicy: 'standard',
        displayName: 'My API', baseUrl, protocol: 'openai_responses',
        envKey: 'MY_API_KEY', providerId: 'my-api',
      },
    }],
    models: [], cells: [{ id: 'Dev', cwd: dir, engine: 'myapi', boot: false }],
  }), { mode: 0o600 });
  const { server, token, watcher } = createServer({
    protectSharedTmuxServer: false,
    home: dir, tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'),
    tmuxBin: FAKE_TMUX, fleetDefsPath: defsPath,
    providerSecretsPath: path.join(dir, '.nexuscrew', 'providers.env'),
    providerShellPath: path.join(dir, '.config', 'ai-shell', 'providers.zsh'),
    providerKeysPath: path.join(dir, '.config', 'keys', 'ai.env'),
    providerSecurePath: path.join(dir, '.config', 'secure', '.env'),
    credentialsPath: path.join(dir, '.nexuscrew', 'credentials.json'),
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); if (watcher) watcher.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const set = await fetch(`${base}/api/fleet/credentials/set`, {
    method: 'POST', headers: H, body: JSON.stringify({ envKey: 'MY_API_KEY', value: KEY }),
  });
  assert.equal(set.status, 200, 'credential set must succeed');
  const out = await (await fetch(`${base}/api/fleet/engine-models?engine=myapi`, { headers: H })).json();
  assert.equal(requests[0].headers.authorization, `Bearer ${KEY}`, 'the engine key reached the endpoint');
  assert.deepEqual(out.auth, {
    credentialState: 'configured', envKey: 'MY_API_KEY', attempted: true, credentialSent: true, cause: 'key-rejected',
  });
  const raw = JSON.stringify(out);
  assert.ok(!raw.includes(KEY), 'never the key value');
  assert.ok(!raw.includes(baseUrl), 'never the endpoint URL');
  assert.ok(!('attempt' in out) && !('apiKey' in out) && !('plan' in out), 'no internal attempt or plan fields');
});
