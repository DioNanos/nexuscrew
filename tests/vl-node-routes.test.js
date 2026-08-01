'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { commandOf, MAX_CANDIDATE_BYTES } = require('../lib/vl-nodes/routes.js');

test('VL command schema is an exact fail-closed allowlist', () => {
  assert.deepEqual(commandOf({ kind: 'restart' }), { kind: 'restart', args: {} });
  assert.equal(commandOf({ kind: 'restart', args: { shell: 'id' } }), null);
  assert.equal(commandOf({ kind: 'shell', args: { command: 'id' } }), null);
  assert.deepEqual(commandOf({ kind: 'logs', args: { limit: 25 } }), { kind: 'logs', args: { limit: 25 } });
  assert.equal(commandOf({ kind: 'logs', args: { limit: 1000 } }), null);
});

test('update candidate accepts only bounded credential-free HTTP metadata', () => {
  const valid = {
    kind: 'update_candidate',
    args: { url: 'https://example.test/vl', sha256: 'a'.repeat(64), size: MAX_CANDIDATE_BYTES, version: '0.2.0-rc.1' },
  };
  assert.equal(commandOf(valid).kind, 'update_candidate');
  assert.equal(commandOf({ ...valid, args: { ...valid.args, size: MAX_CANDIDATE_BYTES + 1 } }), null);
  assert.equal(commandOf({ ...valid, args: { ...valid.args, url: 'https://user:secret@example.test/vl' } }), null);
  assert.equal(commandOf({ ...valid, args: { ...valid.args, activate: true } }), null);
});

