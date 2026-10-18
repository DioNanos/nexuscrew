'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { terminaPerPid } = require('./tmux-test-server.js');

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
  const tmuxWrapper = path.join(root, 'tmux-dedicated');
  // -f /dev/null: il server di prova non carica ~/.tmux.conf, quindi fuori
  // harness l'UNICA guardia e' quella del repo, che e' cio' che questo test
  // collauda. TMUX_TMPDIR=pinned alla root del test: socket e cleanup
  // restano confinati qui.
  const tmuxEnv = { ...process.env, TMUX_TMPDIR: root, TMUX: '', TMUX_PANE: '' };
  fs.writeFileSync(tmuxWrapper, `#!/bin/sh\nTMUX_TMPDIR='${root}' exec tmux -f /dev/null -L '${socket}' "$@"\n`, { mode: 0o700 });
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
    // The dotted inactive cell forces the tmux-identity migration preflight
    // through list-sessions before this dedicated server exists, matching a
    // real first boot with agy.native already persisted.
    cells: [
      { id: 'ColdStart', cwd, engine: 'node', boot: false },
      { id: 'agy.native', cwd, engine: 'node', boot: false },
    ],
  });

  let fleet;
  let serverPid = 0;
  try {
    fleet = await createBuiltinFleet({
      home, fleetDefsPath: defsPath, tmuxBin: tmuxWrapper, launchReadyMs: 200,
    });
    assert.equal(fleet.available, true);
    const started = await fleet.up('ColdStart');
    assert.equal(started.ok, true);
    const status = await fleet.status();
    assert.equal(status.cells.find((cell) => cell.cell === 'ColdStart')?.active, true);
    // PID del server LETO SUBITO, con una sessione ancora attiva: dopo il down
    // il server resta vivo ma VUOTO (exit-empty off per via della guardia, che
    // questo test lascia attiva di proposito), e la chiusura sara' per segnale.
    const pidOut = spawnSync(tmuxWrapper, ['display-message', '-p', '#{pid}'], { encoding: 'utf8' });
    serverPid = Number(String(pidOut.stdout || '').trim());
    assert.ok(Number.isInteger(serverPid) && serverPid > 0, `PID del server tmux non letto: "${pidOut.stdout}" ${pidOut.stderr}`);
  } finally {
    try { if (fleet) await fleet.down('ColdStart'); } catch (_) {}
    // protectSharedTmuxServer intentionally leaves an empty server alive, and
    // kill-server on this guarded server would be denied (that is the guard
    // this test exercises). The only reliable shutdown is the signal by PID.
    try { await terminaPerPid(serverPid); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
