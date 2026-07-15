'use strict';
// Focused contract/behavior tests for the runtime-lifecycle module boundary
// extracted in Phase 3. These pin the newly-direct functions (previously
// internal to commands.js) without going through the CLI facade, and avoid any
// dependency on optional runtime modules (express/qrcode-terminal).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodesStore = require('../lib/nodes/store.js');
const {
  start, stopManagedTunnels, refusePairedPortRelocation,
  managedRuntimeState, portableRuntimeState, resolveRuntimeOwner,
  waitForPidExit, stopPortableRuntime, stop, isServiceRunning,
  bootState, unlinkRegular,
} = require('../lib/cli/runtime-lifecycle.js');

test('runtime-lifecycle: exports the focused lifecycle contract', () => {
  // Every function the boundary promises must be a callable, stable name.
  for (const fn of [
    start, stopManagedTunnels, refusePairedPortRelocation,
    managedRuntimeState, portableRuntimeState, resolveRuntimeOwner,
    waitForPidExit, stopPortableRuntime, stop, isServiceRunning,
    bootState, unlinkRegular,
  ]) {
    assert.equal(typeof fn, 'function');
  }
});

test('managedRuntimeState: linux active/inactive via injected execImpl', () => {
  const active = managedRuntimeState({
    platform: 'linux',
    execImpl: () => 'active\n',
  });
  assert.deepEqual(active, { supported: true, running: true, service: 'active' });

  const throwing = managedRuntimeState({
    platform: 'linux',
    execImpl: () => { throw new Error('not-loaded'); },
  });
  assert.deepEqual(throwing, { supported: true, running: false, service: 'inactive' });
});

test('managedRuntimeState: mac print success/failure, unsupported -> portable-only', () => {
  const up = managedRuntimeState({
    platform: 'mac', uid: 501,
    execImpl: (_cmd, args) => { if (args[0] === 'print') return ''; throw new Error('x'); },
  });
  assert.equal(up.supported, true);
  assert.equal(up.running, true);
  assert.equal(up.service, 'gui/501/com.mmmbuto.nexuscrew');

  const down = managedRuntimeState({
    platform: 'mac', uid: 501,
    execImpl: () => { throw new Error('no service'); },
  });
  assert.equal(down.running, false);

  const unsup = managedRuntimeState({ platform: 'termux', execImpl: () => '' });
  assert.deepEqual(unsup, { supported: false, running: false, service: 'portable-only' });
});

test('refusePairedPortRelocation: no-op when port unchanged; pass when no peers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrl-'));
  const nodesPath = path.join(home, 'nodes.json');
  try {
    // same port -> immediate return, never touches the store
    assert.doesNotThrow(() => refusePairedPortRelocation({ home, nodesPath }, 41822, 41822));
    // different port, no nodes file on disk -> loadStore null -> no paired peers
    assert.doesNotThrow(() => refusePairedPortRelocation({ home, nodesPath }, 41822, 41823));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('refusePairedPortRelocation: throws when paired peers occupy the busy port', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrl-'));
  const nodesPath = path.join(home, 'nodes.json');
  try {
    let st = nodesStore.emptyStore('a'.repeat(32));
    st = nodesStore.addNode(st, {
      name: 'hub', ssh: 'user@hub', remotePort: 41820, localPort: 43001,
      direction: 'outbound', transport: 'auto', autostart: true,
      nodeId: 'b'.repeat(32), token: 'to-hub', acceptToken: 'from-hub',
    });
    nodesStore.atomicWriteStore(nodesPath, st);
    assert.throws(
      () => refusePairedPortRelocation({ home, nodesPath }, 41822, 41823),
      /paired peers exist/,
    );
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('unlinkRegular: ENOENT false, regular removed, symlink refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrl-'));
  try {
    // missing target -> false (idempotent)
    assert.equal(unlinkRegular(path.join(dir, 'nope')), false);

    // regular file -> unlinked, returns true
    const reg = path.join(dir, 'boot.sh');
    fs.writeFileSync(reg, '#!/bin/sh\n', { mode: 0o644 });
    assert.equal(unlinkRegular(reg), true);
    assert.equal(fs.existsSync(reg), false);

    // symlink (unsafe boot target) -> refused, not followed
    const target = path.join(dir, 'real');
    fs.writeFileSync(target, 'x');
    const link = path.join(dir, 'link');
    fs.symlinkSync(target, link);
    assert.throws(() => unlinkRegular(link), /refusing unsafe boot target/);
    assert.equal(fs.existsSync(link), true, 'symlink left intact on refusal');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
