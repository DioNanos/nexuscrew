'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

test('version update state: aligned, browser stale, install mismatch', async () => {
  const m = await import('../frontend/src/lib/sw-update.js');
  m.reportServerVersions('0.8.0', '0.8.0', '0.8.0');
  assert.deepEqual(m.getUpdateState(), { needed: false, kind: null, version: '' });
  m.reportServerVersions('0.8.0', '0.8.0', '0.7.7');
  assert.deepEqual(m.getUpdateState(), { needed: true, kind: 'reload', version: '0.8.0' });
  m.reportServerVersions('0.8.0', '0.7.7', '0.7.7');
  assert.deepEqual(m.getUpdateState(), { needed: true, kind: 'install', version: '0.8.0' });
  m.reportServerVersions('0.8.0', '0.8.0', '0.8.0');
});
