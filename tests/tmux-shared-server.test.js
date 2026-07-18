'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  KILL_SERVER_ALIAS,
  protectionArgs,
  protectSharedTmuxServer,
} = require('../lib/tmux/shared-server.js');

test('protectionArgs contains only safe server setup, never a kill-server command', () => {
  const args = protectionArgs();
  assert.equal(args[0], 'start-server');
  assert.deepEqual(args.slice(1, 7), [';', 'set-option', '-s', 'exit-empty', 'off', ';']);
  assert.equal(args[7], 'set-option');
  assert.ok(args.includes(KILL_SERVER_ALIAS));
  assert.notEqual(args[0], 'kill-server');
});

test('protectSharedTmuxServer can be disabled explicitly without spawning tmux', async () => {
  let called = false;
  const result = await protectSharedTmuxServer('tmux', {
    enabled: false,
    execFileImpl: () => { called = true; },
  });
  assert.equal(called, false);
  assert.deepEqual(result, { ok: true, protected: false, reason: 'disabled' });
});

const HAVE_TMUX = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

test('real isolated server neutralizes kill-server while exact cell down/restart still works', {
  skip: !HAVE_TMUX,
  timeout: 15000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-tmux-guard-'));
  const socket = `nc-guard-${process.pid}-${Date.now()}`;
  assert.match(socket, /^[A-Za-z0-9_-]+$/, 'dedicated tmux -L socket must be safe');
  const tmuxArgs = (...args) => ['-L', socket, ...args];
  const wrapper = path.join(root, 'tmux-isolated');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec tmux -L '${socket}' "$@"\n`, { mode: 0o700 });
  fs.chmodSync(wrapper, 0o700);
  t.after(() => {
    try { execFileSync('tmux', tmuxArgs('set-option', '-s', '-u', 'command-alias[100]'), { stdio: 'ignore' }); } catch (_) {}
    try { execFileSync('tmux', tmuxArgs('kill-server'), { stdio: 'ignore' }); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const guarded = await protectSharedTmuxServer(wrapper);
  assert.equal(guarded.ok, true);
  const pidBefore = execFileSync(wrapper, ['display-message', '-p', '#{pid}'], { encoding: 'utf8' }).trim();
  assert.equal(execFileSync(wrapper, ['show-options', '-s', 'exit-empty'], { encoding: 'utf8' }).trim(), 'exit-empty off');
  assert.match(execFileSync(wrapper, ['show-options', '-s', 'command-alias[100]'], { encoding: 'utf8' }), /kill-server=display-message/);

  execFileSync('tmux', tmuxArgs('kill-server'));
  const pidAfterDeniedKill = execFileSync(wrapper, ['display-message', '-p', '#{pid}'], { encoding: 'utf8' }).trim();
  assert.equal(pidAfterDeniedKill, pidBefore, 'guarded kill-server must not replace or terminate the server');

  execFileSync(wrapper, ['new-session', '-d', '-s', 'cell-one']);
  execFileSync(wrapper, ['new-session', '-d', '-s', 'cell-two']);
  execFileSync(wrapper, ['kill-session', '-t', '=cell-one']);
  assert.deepEqual(execFileSync(wrapper, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).trim().split('\n'), ['cell-two']);

  execFileSync(wrapper, ['kill-session', '-t', '=cell-two']);
  assert.equal(execFileSync(wrapper, ['display-message', '-p', '#{pid}'], { encoding: 'utf8' }).trim(), pidBefore,
    'exit-empty off keeps the shared server alive after the last exact down');
  execFileSync(wrapper, ['new-session', '-d', '-s', 'cell-two']);
  assert.equal(execFileSync(wrapper, ['has-session', '-t', '=cell-two']).toString(), '', 'exact restart recreates only the requested cell');
});
