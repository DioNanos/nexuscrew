'use strict';
// tests/model-discovery-attempt.test.js — attempt metadata on the discovery
// HTTP layer. The listing request's fixed facts (numeric HTTP status, error
// category network/timeout/http/invalid-response, whether the request carried
// the credential) travel on DiscoveryError and ride the fallback results, so
// the caller can tell "the endpoint rejected the key" from "the endpoint is
// down" without parsing free-form messages. The public face stays the existing
// sanitized `reason`: no URL, no key, no exception text — a sentinel key must
// never appear in a result, an error string or the disk cache.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModelDiscovery, DiscoveryError } = require('../lib/fleet/model-discovery.js');

const KEY = 'sekret-attempt-sentinel-value';

function isolatedHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmd-attempt-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function jsonResponse({ status = 200, body = { data: [] }, jsonError = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jsonError ? async () => { throw jsonError; } : async () => body,
  };
}

function cacheFile(home, engine) {
  return path.join(home, '.nexuscrew', 'model-discovery', `${engine}.json`);
}

test('HTTP rejections carry numeric status, http category and whether the credential was sent', async (t) => {
  const home = isolatedHome(t);
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url: String(url), headers: opts.headers || {} });
    return jsonResponse({ status: 401, body: { error: `bad key ${KEY}` } });
  };
  const d = createModelDiscovery();
  const out = await d.fetchEngineModels({
    engine: 'e401', collector: 'openai-compat', baseUrl: 'http://endpoint.example/v1',
    apiKey: KEY, home, fetchImpl,
  });
  assert.equal(out.status, 'backup');
  assert.equal(out.error, 'HTTP 401');
  // The key was valued AND really applied to the request: the header capture
  // pins that "credential sent" means the header, not just a valued plan.
  assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(out.attempt, { status: 401, category: 'http', credentialSent: true });
  assert.ok(!JSON.stringify(out).includes(KEY), 'the key never appears in the result');
});

test('the same rejection without a key: credentialSent false, still http', async (t) => {
  const home = isolatedHome(t);
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ headers: opts.headers || {} });
    return jsonResponse({ status: 401 });
  };
  const out = await createModelDiscovery().fetchEngineModels({
    engine: 'e401anon', collector: 'openai-compat', baseUrl: 'http://endpoint.example/v1',
    apiKey: '', home, fetchImpl,
  });
  assert.equal(seen[0].headers.authorization, undefined, 'no credential header when no key');
  assert.deepEqual(out.attempt, { status: 401, category: 'http', credentialSent: false });
});

test('network failure and timeout are distinct categories, with fixed reasons', async (t) => {
  const home = isolatedHome(t);
  const netOut = await createModelDiscovery().fetchEngineModels({
    engine: 'enet', collector: 'openai-compat', baseUrl: 'http://endpoint.example/v1',
    home, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND endpoint.example'); },
  });
  assert.equal(netOut.error, 'network error');
  assert.ok(!netOut.error.includes('endpoint.example'), 'the reason never names the endpoint');
  assert.deepEqual(netOut.attempt, { category: 'network', credentialSent: false });

  const abortError = new Error('The operation was aborted');
  abortError.name = 'AbortError';
  const timeOut = await createModelDiscovery().fetchEngineModels({
    engine: 'etime', collector: 'openai-compat', baseUrl: 'http://endpoint.example/v1',
    home, fetchImpl: async () => { throw abortError; },
  });
  assert.equal(timeOut.error, 'timeout after 2500ms');
  assert.deepEqual(timeOut.attempt, { category: 'timeout', credentialSent: false });
});

test('invalid JSON and unexpected shape are invalid-response, never http', async (t) => {
  const home = isolatedHome(t);
  const badJson = await createModelDiscovery().fetchEngineModels({
    engine: 'ejson', collector: 'openai-compat', baseUrl: 'http://endpoint.example/v1',
    home, fetchImpl: async () => jsonResponse({ jsonError: new SyntaxError(`Unexpected token ${KEY}`) }),
  });
  assert.equal(badJson.error, 'invalid JSON response');
  assert.deepEqual(badJson.attempt, { category: 'invalid-response', credentialSent: false });
  assert.ok(!JSON.stringify(badJson).includes(KEY));

  const badShape = await createModelDiscovery().fetchEngineModels({
    engine: 'eshape', collector: 'openai-compat', baseUrl: 'http://endpoint.example/v1',
    home, fetchImpl: async () => jsonResponse({ body: ['not', 'an', 'object'] }),
  });
  assert.equal(badShape.error, 'unexpected response shape');
  assert.deepEqual(badShape.attempt, { category: 'invalid-response', credentialSent: false });
});

test('other HTTP statuses keep their number: 429 and 500 stay plain http facts', async (t) => {
  const home = isolatedHome(t);
  const d = createModelDiscovery();
  for (const status of [429, 500]) {
    const out = await d.fetchEngineModels({
      engine: `e${status}`, collector: 'openai-compat', baseUrl: 'http://endpoint.example/v1',
      apiKey: KEY, home, fetchImpl: async () => jsonResponse({ status }),
    });
    assert.equal(out.error, `HTTP ${status}`);
    assert.deepEqual(out.attempt, { status, category: 'http', credentialSent: true });
  }
});

test('a successful listing records only that the request carried the credential', async (t) => {
  const home = isolatedHome(t);
  const out = await createModelDiscovery().fetchEngineModels({
    engine: 'eok', collector: 'openai-compat', baseUrl: 'http://endpoint.example/v1',
    apiKey: KEY, home, fetchImpl: async () => jsonResponse({ body: { data: [{ id: 'm-1' }] } }),
  });
  assert.equal(out.status, 'api');
  assert.deepEqual(out.attempt, { credentialSent: true });
  // The disk cache holds the listing only: no key, no attempt metadata.
  const raw = fs.readFileSync(cacheFile(home, 'eok'), 'utf8');
  assert.ok(!raw.includes(KEY), 'no key in the cache file');
  const parsed = JSON.parse(raw);
  assert.ok(!('attempt' in parsed), 'attempt metadata is ephemeral, never cached');
});

test('the failed attempt rides the stale fallback: cache value, fresh diagnosis', async (t) => {
  const home = isolatedHome(t);
  let status = 200;
  const fetchImpl = async () => jsonResponse({
    status,
    body: status === 200 ? { data: [{ id: 'm-1' }] } : { error: 'nope' },
  });
  const d = createModelDiscovery();
  const first = await d.fetchEngineModels({
    engine: 'estale', collector: 'openai-compat', baseUrl: 'http://endpoint.example/v1',
    apiKey: KEY, home, fetchImpl, ttlMs: 10,
  });
  assert.equal(first.status, 'api');
  await new Promise((resolve) => setTimeout(resolve, 20));
  status = 403;
  const stale = await d.fetchEngineModels({
    engine: 'estale', collector: 'openai-compat', baseUrl: 'http://endpoint.example/v1',
    apiKey: KEY, home, fetchImpl, ttlMs: 10,
  });
  assert.equal(stale.status, 'cache');
  assert.equal(stale.stale, true);
  assert.equal(stale.error, 'HTTP 403');
  assert.deepEqual(stale.attempt, { status: 403, category: 'http', credentialSent: true });
  assert.ok(stale.apiModels.some((m) => m.id === 'm-1'), 'the last good listing still serves');
  assert.ok(!JSON.stringify(stale).includes(KEY));
});

test('a fresh cache answer carries no attempt: nothing happened on the network', async (t) => {
  const home = isolatedHome(t);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse({ body: { data: [{ id: 'm-1' }] } }); };
  const d = createModelDiscovery();
  const opts = {
    engine: 'efresh', collector: 'openai-compat', baseUrl: 'http://endpoint.example/v1',
    apiKey: KEY, home, fetchImpl,
  };
  await d.fetchEngineModels(opts);
  const cached = await d.fetchEngineModels(opts);
  assert.equal(calls, 1, 'the cache served: no new request');
  assert.equal(cached.status, 'cache');
  assert.equal(cached.stale, false);
  assert.ok(!('attempt' in cached), 'no attempt, so no fresh claim about the key');
});

test('DiscoveryError stays constructible with the plain reason and exposes the metadata read-only facts', () => {
  const plain = new DiscoveryError('network error');
  assert.equal(plain.reason, 'network error');
  assert.ok(!(('status' in plain) || ('category' in plain) || ('credentialSent' in plain)));
  const full = new DiscoveryError('HTTP 401', { status: 401, category: 'http', credentialSent: true });
  assert.equal(full.status, 401);
  assert.equal(full.category, 'http');
  assert.equal(full.credentialSent, true);
  assert.equal(full.message, 'model discovery: HTTP 401');
});
