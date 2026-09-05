'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIdentityContext } = require('../lib/mcp/server.js');

function context(overrides = {}) {
  const now = Date.now();
  return {
    version: '1',
    kind: 'mcp-v1',
    verified: true,
    mode: 'shared',
    bindingId: 'binding-1',
    ownerInstanceId: 'a'.repeat(32),
    cellId: 'Dev',
    tmuxSession: 'cloud-Dev',
    connectionId: 'connection-1',
    threadId: 'thread-1',
    origin: 'local_tui',
    audience: 'nexuscrew-mcp',
    scopes: ['mcp:tools/call'],
    issuedAt: now - 1000,
    notBefore: now - 1000,
    expiresAt: now + 60_000,
    cwd: '/tmp/a-'.padEnd(512, 'x'),
    ...overrides,
  };
}

test('identity context schema: complete mcp binding normalizes and derives from', () => {
  const out = normalizeIdentityContext(context());
  assert.equal(out.version, '1');
  assert.equal(out.kind, 'mcp-v1');
  assert.equal(out.origin, 'local_tui');
  assert.deepEqual(out.from, {
    instanceId: 'a'.repeat(32), cell: 'Dev', tmuxSession: 'cloud-Dev',
  });
  assert.equal(out.cwd.length, 512, 'cwd non e limitato dal bound dei campi identita');
});

test('identity context schema: missing required fields are rejected', () => {
  for (const field of ['version', 'kind', 'origin', 'connectionId', 'threadId', 'scopes', 'expiresAt']) {
    const candidate = context();
    delete candidate[field];
    assert.throws(() => normalizeIdentityContext(candidate), /contesto identita online/,
      `campo mancante: ${field}`);
  }
});

test('identity context schema: malformed origin, kind, scopes and liveHost are rejected', () => {
  assert.throws(() => normalizeIdentityContext(context({ origin: 'forged' })), /contesto identita online/);
  assert.throws(() => normalizeIdentityContext(context({ kind: 'bogus-v1' })), /contesto identita online/);
  assert.throws(() => normalizeIdentityContext(context({ scopes: [] })), /contesto identita online/);
  assert.throws(() => normalizeIdentityContext(context({ origin: 'remote_live' })), /contesto identita online/);
});

test('identity context schema: expired and not-yet-valid timestamps are rejected', () => {
  const now = Date.now();
  assert.throws(() => normalizeIdentityContext(context({
    issuedAt: now - 20_000, notBefore: now - 20_000, expiresAt: now - 1,
  })), /scaduto/);
  assert.throws(() => normalizeIdentityContext(context({
    issuedAt: now + 10_000, notBefore: now + 10_000, expiresAt: now + 20_000,
  })), /non ancora valido/);
});
