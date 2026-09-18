'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// The root suite drives the same state machine the frontend test file pins, so a
// change to the shape of getUpdateState() shows up here too. Storage and the
// reload implementation are injected: without an explicit store the behaviour
// depends on whether the runtime happens to expose sessionStorage, and a test
// that changes meaning with the runtime is not a test.
function memoriaFinta() {
  const dati = new Map();
  return {
    getItem: (k) => (dati.has(k) ? dati.get(k) : null),
    setItem: (k, v) => dati.set(k, String(v)),
    removeItem: (k) => dati.delete(k),
  };
}

test('version update state: aligned, stale interface, install mismatch', async () => {
  const m = await import('../frontend/src/lib/sw-update.js');
  const store = memoriaFinta();
  const reloads = [];
  const opts = { storage: store, applyImpl: () => reloads.push(1) };

  m.reportServerVersions('0.8.0', '0.8.0', '0.8.0', opts);
  assert.deepEqual(m.getUpdateState(), { needed: false, kind: null, version: '', browserVersion: '' });

  // The served interface is newer than the running bundle: one silent anti-cache
  // reload, and no banner while it happens.
  m.reportServerVersions('0.8.0', '0.8.0', '0.7.7', opts);
  assert.deepEqual(m.getUpdateState(), { needed: false, kind: null, version: '', browserVersion: '' });
  assert.equal(reloads.length, 1);

  // The same mismatch again in the same session: the reload did not help, so
  // what is left is the diagnosis — never an announcement of 0.8.0 as new.
  m.reportServerVersions('0.8.0', '0.8.0', '0.7.7', opts);
  assert.deepEqual(m.getUpdateState(), {
    needed: true, kind: 'stale', version: '0.8.0', browserVersion: '0.7.7',
  });
  assert.equal(reloads.length, 1);

  // The package on disk is newer than both the served and the running interface:
  // a node restart applies it, and a reload is not offered because it cannot.
  m.reportServerVersions('0.8.0', '0.7.7', '0.7.7', opts);
  assert.deepEqual(m.getUpdateState(), {
    needed: true, kind: 'install', version: '0.8.0', browserVersion: '0.7.7',
  });
  assert.equal(reloads.length, 1);

  // Aligned again: no banner, and the attempt is forgotten.
  m.reportServerVersions('0.8.0', '0.8.0', '0.8.0', opts);
  assert.deepEqual(m.getUpdateState(), { needed: false, kind: null, version: '', browserVersion: '' });
});
