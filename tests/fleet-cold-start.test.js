'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

const HAVE_TMUX = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const SAFE_SOCKET_RE = /^[A-Za-z0-9_-]+$/;

function dedicatedTmuxArgs(socket, ...args) {
  if (typeof socket !== 'string' || !SAFE_SOCKET_RE.test(socket)) {
    throw new Error('refusing tmux test without a safe dedicated -L socket');
  }
  return ['-L', socket, ...args];
}

test('cold-start cleanup fails closed and always targets an explicit -L socket', () => {
  assert.throws(() => dedicatedTmuxArgs('', 'kill-server'), /refusing tmux test/);
  assert.throws(() => dedicatedTmuxArgs('../default', 'kill-server'), /refusing tmux test/);
  assert.deepEqual(
    dedicatedTmuxArgs('nc-cold-start-safe', 'kill-server'),
    ['-L', 'nc-cold-start-safe', 'kill-server'],
  );
});

test('builtin Fleet starts its first cell when no tmux server exists', {
  skip: !HAVE_TMUX,
  timeout: 15000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cold-start-'));
  // This test must remain safe when invoked directly, outside run-isolated.js.
  // Every lifecycle command is pinned to one unique named socket. Never issue
  // kill-server against tmux's implicit/default socket.
  // Keep the -L name short: tmux appends it below TMUX_TMPDIR/tmux-<uid>, and
  // Unix-domain socket paths are commonly capped at 108 bytes.
  const socket = `nc${process.pid.toString(36)}${Date.now().toString(36)}`;
  // Validate before writing or executing the wrapper: failure is closed.
  dedicatedTmuxArgs(socket);
  const tmuxArgs = (...args) => dedicatedTmuxArgs(socket, ...args);
  const tmuxWrapper = path.join(root, 'tmux-dedicated');
  fs.writeFileSync(tmuxWrapper, `#!/bin/sh\nexec tmux -L '${socket}' "$@"\n`, { mode: 0o700 });
  fs.chmodSync(tmuxWrapper, 0o700);
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'work');
  const defsPath = path.join(home, '.nexuscrew', 'fleet.json');
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'node', label: 'Node', command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, promptMode: 'send-keys',
    }],
    cells: [{ id: 'ColdStart', cwd, engine: 'node', boot: false }],
  });

  let fleet;
  try {
    fleet = await createBuiltinFleet({
      home, fleetDefsPath: defsPath, tmuxBin: tmuxWrapper, launchReadyMs: 200,
    });
    assert.equal(fleet.available, true);
    const started = await fleet.up('ColdStart');
    assert.equal(started.ok, true);
    const status = await fleet.status();
    assert.equal(status.cells.find((cell) => cell.cell === 'ColdStart')?.active, true);
  } finally {
    try { if (fleet) await fleet.down('ColdStart'); } catch (_) {}
    // protectSharedTmuxServer intentionally leaves an empty server alive. Both
    // cleanup calls carry the same explicit -L socket, including kill-server.
    try { execFileSync('tmux', tmuxArgs('set-option', '-s', '-u', 'command-alias[100]'), { stdio: 'ignore' }); } catch (_) {}
    try { execFileSync('tmux', tmuxArgs('kill-server'), { stdio: 'ignore' }); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
