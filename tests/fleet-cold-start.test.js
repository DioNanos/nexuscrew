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

// Ogni invocazione tmux del test deve restare confinata nella root privata
// del test stesso: il wrapper pinna TMUX_TMPDIR alla root e il rifiuto e'
// chiuso (nessuna root relativa o che scavalchi la tmpdir). Non serve piu'
// un socket -L dedicato: il lancio vive sul server condiviso, che qui e'
// quello di default RISOLTO ATTRAVERSO la root privata.
function safeTmuxRoot(root) {
  if (typeof root !== 'string'
    || !path.isAbsolute(root)
    || root.includes('..')
    || !root.startsWith(os.tmpdir())) {
    throw new Error('refusing tmux test without a safe private root');
  }
  return root;
}

test('cold-start cleanup fails closed and always pins a private tmp root', () => {
  assert.throws(() => safeTmuxRoot('nc-relative-root'), /refusing tmux test/);
  assert.throws(() => safeTmuxRoot(path.join(os.tmpdir(), '..', 'etc')), /refusing tmux test/);
  const ok = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cold-start-guard-'));
  try {
    assert.equal(safeTmuxRoot(ok), ok);
  } finally {
    fs.rmSync(ok, { recursive: true, force: true });
  }
});

test('builtin Fleet starts its first cell by creating the shared tmux server when none exists', {
  skip: !HAVE_TMUX,
  timeout: 15000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cold-start-'));
  // This test must remain safe when invoked directly, outside run-isolated.js.
  // Every lifecycle command goes through the wrapper below, pinned to this
  // private root via TMUX_TMPDIR: the shared socket resolved by the runtime
  // and every -S-less surface both land on root/tmux-<uid>/default, a test
  // server — never on the live fleet server, even outside the isolated runner.
  // Validate before writing or executing the wrapper: failure is closed.
  safeTmuxRoot(root);
  const tmuxWrapper = path.join(root, 'tmux-shared');
  // -f /dev/null: il server di prova non carica ~/.tmux.conf (nessun alias
  // di macchina, nessuna opzione ereditata dall'operatore); fuori harness
  // l'UNICA guardia e' quella del repo, che e' cio' che questo test collauda.
  const tmuxEnv = { ...process.env, TMUX_TMPDIR: root, TMUX: '', TMUX_PANE: '' };
  fs.writeFileSync(tmuxWrapper, `#!/bin/sh\nTMUX_TMPDIR='${root}' exec tmux -f /dev/null "$@"\n`, { mode: 0o700 });
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
    // through list-sessions before the shared server exists, matching a
    // real first boot with agy.native already persisted.
    cells: [
      { id: 'ColdStart', cwd, engine: 'node', boot: false },
      { id: 'agy.native', cwd, engine: 'node', boot: false },
    ],
  });

  // Il runtime risolve il socket condiviso da process.env: la stessa root
  // privata del wrapper, cosi' il -S del lancio e il default delle superfici
  // coincidono per costruzione. Ripristinato nel finally.
  const prevTmuxTmpdir = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = root;

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
    // Il lancio ha CREATO il server condiviso: socket di default presente
    // nella root privata e sessione visibile a un client senza -S.
    const sharedSocket = path.join(root, `tmux-${process.getuid()}`, 'default');
    assert.ok(fs.existsSync(sharedSocket),
      `il socket condiviso deve esistere dopo il primo up: ${sharedSocket}`);
    const lsOut = spawnSync(tmuxWrapper, ['ls'], { encoding: 'utf8' });
    assert.equal(lsOut.status, 0, `tmux ls deve riuscire sul server condiviso: ${lsOut.stderr}`);
    assert.match(String(lsOut.stdout), /^cloud-ColdStart:/,
      `tmux ls senza -S deve vedere la sessione del lancio: "${lsOut.stdout}"`);
    // PID del server LETTO SUBITO, con una sessione ancora attiva: dopo il down
    // il server resta vivo ma VUOTO (exit-empty off per via della guardia, che
    // questo test lascia attiva di proposito), e la chiusura sara' per segnale.
    const pidOut = spawnSync(tmuxWrapper, ['display-message', '-p', '#{pid}'], { encoding: 'utf8' });
    const serverPid = Number(String(pidOut.stdout || '').trim());
    assert.ok(Number.isInteger(serverPid) && serverPid > 0, `PID del server tmux non letto: "${pidOut.stdout}" ${pidOut.stderr}`);
    const down = await fleet.down('ColdStart');
    assert.equal(down.ok, true, 'down riuscito dopo il cold start');
    // La chiusura per PID e' l'unica via su un server protetto: avviene nel
    // finally, cosi' vale anche se un'asserzione precedente fallisce.
  } finally {
    if (prevTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = prevTmuxTmpdir;
    try { if (fleet) await fleet.down('ColdStart'); } catch (_) {}
    // protectSharedTmuxServer intentionally leaves an empty server alive, and
    // kill-server on this guarded server would be denied (that is the guard
    // this test exercises). The only reliable shutdown is the signal by PID,
    // read from the shared socket even when the assertions above failed.
    let serverPid = 0;
    try {
      const pidOut = spawnSync(tmuxWrapper, ['display-message', '-p', '#{pid}'],
        { encoding: 'utf8', timeout: 3000, env: tmuxEnv });
      const n = Number(String(pidOut.stdout || '').trim());
      if (Number.isInteger(n) && n > 0) serverPid = n;
    } catch (_) {}
    try { await terminaPerPid(serverPid); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
