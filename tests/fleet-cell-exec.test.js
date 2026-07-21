'use strict';

const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeSpawnError, main } = require('../lib/fleet/cell-exec.js');

// Fake child_process spawn result: an EventEmitter that understands the
// `.once(event, fn)` / `.kill(signal)` surface main() uses, plus an async
// `emitLater` to schedule the spawn 'error' from the next tick (mirrors how
// node delivers ENOENT/EACCES asynchronously after spawn() returns).
function fakeChild() {
  const ee = new EventEmitter();
  ee.kill = () => {};
  return ee;
}

test('sanitizeSpawnError: ENOENT yields stable code + basename, never the path', () => {
  const msg = sanitizeSpawnError({ code: 'ENOENT' }, '/home/secret/.local/bin/node');
  assert.equal(msg, 'nexuscrew cell spawn failed: ENOENT node');
  assert.ok(!msg.includes('/home/secret'));
  assert.ok(!msg.includes('.local'));
  assert.ok(!msg.includes('/'));
});

test('sanitizeSpawnError: EACCES keeps basename without leaking the install dir', () => {
  const msg = sanitizeSpawnError({ code: 'EACCES' }, '/home/tester/.local/codex.js');
  assert.equal(msg, 'nexuscrew cell spawn failed: EACCES codex.js');
  assert.ok(!msg.includes('/home/tester'));
  assert.ok(!msg.includes('.codex'));
});

test('sanitizeSpawnError: argv, env and tokens are never part of the message', () => {
  // Only the command is passed; argv/env are not. Even a command path that
  // contains a token-like substring only exposes its basename.
  const msg = sanitizeSpawnError({ code: 'ENOENT' }, '/home/u/bin/sk-1234567890abcdef');
  assert.equal(msg, 'nexuscrew cell spawn failed: ENOENT sk-1234567890abcdef');
  assert.ok(!msg.includes('/home/u'));
});

test('sanitizeSpawnError: missing code / empty / non-string degrade to SPAWN_ERROR client', () => {
  assert.equal(sanitizeSpawnError({}, ''), 'nexuscrew cell spawn failed: SPAWN_ERROR client');
  assert.equal(sanitizeSpawnError(null, null), 'nexuscrew cell spawn failed: SPAWN_ERROR client');
  assert.equal(sanitizeSpawnError({ code: 2 }, '/bin/node'), 'nexuscrew cell spawn failed: SPAWN_ERROR node');
  // basename('/') is empty -> neutral 'client' label, code still preserved.
  assert.equal(sanitizeSpawnError({ code: 'ENOENT' }, '/'), 'nexuscrew cell spawn failed: ENOENT client');
  assert.equal(
    sanitizeSpawnError({ code: 'ENOENT\nforged' }, '/bin/node'),
    'nexuscrew cell spawn failed: SPAWN_ERROR node',
  );
});

test('sanitizeSpawnError: basename is bounded before it reaches pane diagnostics', () => {
  const msg = sanitizeSpawnError({ code: 'ENOENT' }, `/bin/${'x'.repeat(400)}`);
  assert.equal(msg, `nexuscrew cell spawn failed: ENOENT ${'x'.repeat(128)}`);
});

test('sanitizeSpawnError: control characters in basename are stripped', () => {
  const msg = sanitizeSpawnError({ code: 'ENOENT' }, '/bin/x\x07y\nz');
  assert.ok(!msg.includes('\x07'));
  assert.ok(!msg.includes('\n'));
  assert.match(msg, /nexuscrew cell spawn failed: ENOENT xyz$/);
});

test('main: spawn ENOENT writes sanitized stderr and resolves 1 (never rejects)', async () => {
  let stderr = '';
  const child = fakeChild();
  const spawnStub = () => {
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  const code = await main(['--socket', '/tmp/nc-nope', '--nonce', 'a'.repeat(64)], {
    receivePayload: async () => ({
      command: '/home/secret/.local/bin/codex',
      args: ['--dangerously-skip-permissions', '--model', 'gpt-5'],
      env: { OPENAI_API_KEY: 'sk-leak' },
    }),
    spawn: spawnStub,
    stderrWrite: (s) => { stderr += s; },
  });
  assert.equal(code, 1);
  assert.match(stderr, /nexuscrew cell spawn failed: ENOENT codex$/m);
  // No secret/path/argv may reach the pane-captured stderr.
  assert.ok(!stderr.includes('/home/secret'));
  assert.ok(!stderr.includes('.local'));
  assert.ok(!stderr.includes('sk-leak'));
  assert.ok(!stderr.includes('OPENAI_API_KEY'));
  assert.ok(!stderr.includes('--dangerously-skip-permissions'));
});

test('main: spawn EACCES surfaces the stable code and basename only', async () => {
  let stderr = '';
  const child = fakeChild();
  const spawnStub = () => {
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
    return child;
  };
  const code = await main(['--socket', '/tmp/nc-nope', '--nonce', 'b'.repeat(64)], {
    receivePayload: async () => ({ command: '/data/data/com.termux/files/usr/bin/node', args: [], env: {} }),
    spawn: spawnStub,
    stderrWrite: (s) => { stderr += s; },
  });
  assert.equal(code, 1);
  assert.match(stderr, /nexuscrew cell spawn failed: EACCES node$/m);
  assert.ok(!stderr.includes('/data/data/com.termux'));
});

test('main: a child that exits normally still resolves its exit code', async () => {
  const child = fakeChild();
  const spawnStub = () => {
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  const code = await main(['--socket', '/tmp/nc-nope', '--nonce', 'c'.repeat(64)], {
    receivePayload: async () => ({ command: '/bin/true', args: [], env: {}, supervise: { enabled: false } }),
    spawn: spawnStub,
    stderrWrite: () => {},
  });
  assert.equal(code, 0);
});
