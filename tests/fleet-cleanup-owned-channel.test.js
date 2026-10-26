'use strict';
// Un lancio fallito senza canale posseduto non apre un client tmux nuovo
// per kill-session, neanche quando l'id $N della creazione e' noto.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');

const SESSIONE = 'nc-own-cleanup';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-own-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'Cella');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  const logPath = path.join(root, 'argv.log');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + '\\n');
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  process.stdout.write('%begin 1 0 1\\n%error 1 0 1\\n');
  process.exit(1);
}
const cmd = args[0] || '';
if (cmd === 'new-session') {
  process.stdout.write('$5\\t@5\\t%5\\n');
  process.exit(0);
}
if (cmd === 'set-option' && args.includes('remain-on-exit')) {
  process.stderr.write('arm fail\\n');
  process.exit(1);
}
if (cmd === 'display-message') {
  process.stdout.write('/tmp/nc-fake/socket\\t4242\\n');
  process.exit(0);
}
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'ec', label: 'C', managed: {
        client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe',
      },
    }],
    cells: [{ id: 'CellaOwn', tmuxSession: SESSIONE, cwd, engine: 'ec', boot: false }],
  });
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false, log: () => {} },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'n'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); });
  return {
    runtime,
    argv: () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

test('cleanup senza canale: nessun kill-session su un client nuovo', async (t) => {
  const w = mondo(t);
  await assert.rejects(() => w.runtime.up('CellaOwn'), (e) => e.fleetCode === 'NEW_SESSION_FAILED');
  const kill = w.argv().filter((a) => a.includes('kill-session'));
  assert.deepEqual(kill, [], 'senza canale posseduto il cleanup non apre tmux');
});
