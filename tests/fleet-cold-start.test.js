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

test('builtin Fleet starts its first cell when no tmux server exists', {
  skip: !HAVE_TMUX,
  timeout: 15000,
}, async () => {
  // The official harness gives this file its own TMUX_TMPDIR. Killing this
  // server cannot touch the operator or another test worker.
  try { execFileSync('tmux', ['kill-server'], { stdio: 'ignore' }); } catch (_) {}
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cold-start-'));
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

  const fleet = await createBuiltinFleet({
    home, fleetDefsPath: defsPath, tmuxBin: 'tmux', launchReadyMs: 200,
  });
  try {
    assert.equal(fleet.available, true);
    const started = await fleet.up('ColdStart');
    assert.equal(started.ok, true);
    const status = await fleet.status();
    assert.equal(status.cells.find((cell) => cell.cell === 'ColdStart')?.active, true);
  } finally {
    try { await fleet.down('ColdStart'); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
