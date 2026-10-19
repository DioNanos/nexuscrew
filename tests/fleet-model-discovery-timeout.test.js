'use strict';
// tests/fleet-model-discovery-timeout.test.js — the discovery deadline must
// cover the WHOLE read: headers AND body.
//
// httpJson used to clear its abort timer right after `await fetchImpl(...)`:
// a response that opened the headers and then stalled inside
// `response.json()` had no deadline left and the request hung forever. The
// timer must stay armed until the body is parsed, and an abort while reading
// the body is reported as `timeout after <ms>` — for every caller of
// httpJson: engine collectors and the public catalog alike.
//
// The HTTP layer is a fake fetch: no socket, no DNS, no loopback server. The
// held body promise only settles when the caller aborts (the honest case) or
// on a safety fallback well after the guard, so no promise is left dangling
// even in a red run.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModelDiscovery } = require('../lib/fleet/model-discovery.js');

const TIMEOUT_MS = 5;
// Generous bound (200x the deadline): a read closed by its own deadline
// settles far inside it; the defect never settles at all.
const SETTLE_GUARD_MS = 1000;
// Safety fallback for a red run: far after the guard, so it can never make a
// broken read look settled.
const BODY_RELEASE_MS = SETTLE_GUARD_MS + 1500;

function isolatedHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmd-timeout-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// A fetch that answers the headers immediately and then holds the body.
// `json()` settles only on the caller's abort signal (the honest case) or on
// the safety fallback timer, which cleans itself up on settle.
function heldBodyFetch() {
  return async (_url, opts = {}) => ({
    ok: true, status: 200,
    json: () => new Promise((resolve, reject) => {
      let settled = false;
      const safety = setTimeout(() => done(resolve, { data: [] }), BODY_RELEASE_MS);
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(safety);
        fn(arg);
      };
      const signal = opts.signal;
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener(
          'abort',
          () => done(reject, Object.assign(new Error('aborted while reading the body'), { name: 'AbortError' })),
          { once: true },
        );
      }
    }),
  });
}

// A fetch that stalls before the headers: only the abort signal can end it.
function stalledHeadersFetch() {
  return async (_url, opts = {}) => new Promise((_resolve, reject) => {
    const signal = opts.signal;
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted before the headers'), { name: 'AbortError' })),
        { once: true },
      );
    }
  });
}

// An unref'd sleep: it never keeps the process alive, so a red run cannot
// leave stray timers behind either.
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

async function settlesWithin(promise, ms) {
  let settled = false;
  await Promise.race([promise.then(() => { settled = true; }), sleep(ms)]);
  return settled;
}

test('engine discovery: the deadline closes a stalled body, not only the headers', async (t) => {
  const md = createModelDiscovery();
  const view = md.fetchEngineModels({
    engine: 'e1', collector: 'openai-compat', baseUrl: 'https://e1.example.test',
    home: isolatedHome(t), timeoutMs: TIMEOUT_MS, fetchImpl: heldBodyFetch(),
  });
  assert.equal(
    await settlesWithin(view, SETTLE_GUARD_MS),
    true,
    'the read must close by its own deadline, not hang after the headers',
  );
  const out = await view;
  assert.equal(out.status, 'backup', 'a timed-out fetch with no cache falls back to backup');
  assert.equal(out.error, `timeout after ${TIMEOUT_MS}ms`, 'the reason is the deadline, with the measured ms');
});

test('public catalog: the same deadline covers the catalog body read', async (t) => {
  const md = createModelDiscovery();
  const snapshot = md.fetchPublicCatalogSnapshot({
    home: isolatedHome(t), timeoutMs: TIMEOUT_MS, fetchImpl: heldBodyFetch(),
  });
  assert.equal(
    await settlesWithin(snapshot, SETTLE_GUARD_MS),
    true,
    'the catalog read must close by its own deadline, not hang after the headers',
  );
  const out = await snapshot;
  assert.equal(out.status, 'none', 'a timed-out catalog fetch with no snapshot is an honest none');
  assert.equal(out.error, `timeout after ${TIMEOUT_MS}ms`);
});

test('a fetch stalled before the headers still times out (regression)', async (t) => {
  const md = createModelDiscovery();
  const view = md.fetchEngineModels({
    engine: 'e2', collector: 'openai-compat', baseUrl: 'https://e2.example.test',
    home: isolatedHome(t), timeoutMs: TIMEOUT_MS, fetchImpl: stalledHeadersFetch(),
  });
  assert.equal(await settlesWithin(view, SETTLE_GUARD_MS), true, 'the deadline must close the fetch');
  const out = await view;
  assert.equal(out.status, 'backup');
  assert.equal(out.error, `timeout after ${TIMEOUT_MS}ms`);
});
