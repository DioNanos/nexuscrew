'use strict';
// tests/service-worker-push.test.js — the service worker surface of imported
// alerts. The worker script is evaluated in a sandbox with a fake
// registration, a fake window list and a tiny IndexedDB: what is proved here is
// exactly the untrusted-input handling (local link only, sane identity), the
// one-alert-per-event rule across a worker restart, and the legacy payload.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_PATH = path.join(__dirname, '..', 'frontend', 'public', 'sw.js');

// Minimal IndexedDB: one Map per store, request/transaction callbacks on the
// next macrotask. Enough for open/get/put, nothing more.
function fakeIndexedDB() {
  const stores = new Map();
  return {
    open() {
      const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      const db = {
        createObjectStore: (name) => { if (!stores.has(name)) stores.set(name, new Map()); },
        transaction: (name) => {
          const store = stores.get(name) || new Map();
          const tx = { oncomplete: null, onerror: null, onabort: null };
          const os = {
            get: (key) => {
              const out = { result: store.get(key) };
              setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
              return out;
            },
            put: (value, key) => {
              store.set(key, value);
              const out = { result: key };
              setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
              return out;
            },
          };
          // The transaction IS the object the caller sets oncomplete on: the
          // timers above close over it, so it must be the same one returned.
          tx.objectStore = () => os;
          return tx;
        },
        close: () => {},
      };
      setTimeout(() => {
        req.result = db; // the upgrade callback reads req.result
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };
}

function loadWorker(indexedDB) {
  const handlers = new Map();
  const shown = [];
  const navigated = [];
  const self = {
    addEventListener: (type, fn) => { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
    skipWaiting: () => {},
    indexedDB,
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    clients: {
      claim: () => {},
      matchAll: async () => [{
        focus: async () => {}, navigate: async (url) => { navigated.push(url); },
      }],
      openWindow: async (url) => { navigated.push(url); },
    },
  };
  const sandbox = { self, console, setTimeout, clearTimeout, Date, Promise, JSON, encodeURIComponent };
  vm.runInNewContext(fs.readFileSync(SW_PATH, 'utf8'), sandbox, { filename: 'sw.js' });
  // A worker handler that never settles must fail the test, not hang it.
  const withTimeout = (p, ms = 2000) => Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('the worker handler never settled')), ms)),
  ]);
  const fire = async (type, event) => {
    for (const fn of handlers.get(type) || []) fn(event);
    if (event.waitUntilPromise) await withTimeout(Promise.resolve(event.waitUntilPromise));
  };
  const push = async (payload) => {
    const event = {
      data: { json: () => payload },
      waitUntil: (p) => { event.waitUntilPromise = p; },
    };
    await fire('push', event);
  };
  const click = async (data) => {
    const event = {
      notification: { close: () => {}, data },
      waitUntil: (p) => { event.waitUntilPromise = p; },
    };
    await fire('notificationclick', event);
  };
  return { push, click, shown, navigated };
}

const NOTIFY = {
  title: 'from A', body: 'hello', lang: 'en',
  tag: `nc:${'a'.repeat(32)}:ev-1`, url: `/#owner=${'a'.repeat(32)}`,
  ownerId: 'a'.repeat(32), eventId: 'ev-1', askId: 'ask-1',
};

test('one alert per event, also after the worker restarts', async () => {
  const idb = fakeIndexedDB();
  const first = loadWorker(idb);
  await first.push({ ...NOTIFY });
  assert.equal(first.shown.length, 1, 'the first delivery rings');
  await first.push({ ...NOTIFY });
  assert.equal(first.shown.length, 1, 'a re-push of the same event stays silent');

  // Restart: a fresh evaluation of the same worker over the same registry.
  const restarted = loadWorker(idb);
  await restarted.push({ ...NOTIFY });
  assert.equal(restarted.shown.length, 0, 'the registry survives the worker restart');
  await restarted.push({ ...NOTIFY, eventId: 'ev-2', tag: `nc:${'a'.repeat(32)}:ev-2` });
  assert.equal(restarted.shown.length, 1, 'a new event still rings');
});

test('a legacy payload without an id still alerts once, with the fixed tag', async () => {
  const w = loadWorker(fakeIndexedDB());
  await w.push({ title: 'old', body: 'b' });
  await w.push({ title: 'old', body: 'b' });
  assert.equal(w.shown.length, 2, 'a legacy payload has no identity to dedup on');
  assert.equal(w.shown[0].options.tag, 'nexuscrew', 'the legacy tag stays the single fixed one');
});

test('a link that is not a local path is ignored, never opened', async () => {
  const w = loadWorker(fakeIndexedDB());
  const evil = [
    'https://evil.example/steal',
    '//evil.example/steal',
    '/\\evil.example',
    'javascript:alert(1)',
    '/ok\nhttps://evil.example',
  ];
  for (const url of evil) {
    await w.push({ ...NOTIFY, eventId: `ev-${url.length}-${evil.indexOf(url)}`, url });
  }
  assert.equal(w.shown.length, evil.length, 'the alerts still fire');
  for (const s of w.shown) {
    assert.equal(s.options.data.url, '/', 'a non-local link falls back to the app root');
  }
  await w.click({ url: 'https://evil.example/steal' });
  assert.deepEqual(w.navigated, ['/'], 'the click cannot leave the app');
});

test('an unusable identity never dedups, and an out-of-shape tag falls back', async () => {
  const w = loadWorker(fakeIndexedDB());
  // Identity unusable: no registry key, but the alert still fires.
  await w.push({ ...NOTIFY, ownerId: 'not an id', eventId: 'ev-9' });
  assert.equal(w.shown.length, 1, 'an unusable identity still alerts');
  // A tag that is not the expected shape never reaches the OS as-is.
  await w.push({ ...NOTIFY, eventId: 'ev-10', tag: 'x'.repeat(200) });
  assert.equal(w.shown[1].options.tag, 'nexuscrew', 'an out-of-shape tag falls back to the fixed one');
  // The click still only opens a local route.
  await w.click({ url: `/#owner=${'a'.repeat(32)}&ask=ask-1` });
  assert.deepEqual(w.navigated, [`/#owner=${'a'.repeat(32)}&ask=ask-1`], 'a local route is opened as-is');
  await w.click({ url: 'https://evil.example/steal' });
  assert.equal(w.navigated[1], '/', 'a remote link still falls back to the app root');
});
