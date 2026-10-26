'use strict';
// Uno stop di gruppo non dimostrato resta sul record. Il down successivo
// non lo cancella e un up nuovo non parte finche' l'esito non e' verificato.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const launchTarget = require('../lib/fleet/launch-target.js');

const SESSIONE = 'nc-incerto';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-inc-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, 'Cella');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  const stato = path.join(root, 'sessioni');
  const killLog = path.join(root, 'kill.log');
  fs.writeFileSync(stato, '');
  fs.writeFileSync(killLog, '');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
const STATO = ${JSON.stringify(stato)};
const KILL = ${JSON.stringify(killLog)};
if (args[0] === '-C') {
  process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  let buf = '';
  let n = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!riga) continue;
      n += 1;
      if (riga.startsWith('kill-session')) fs.appendFileSync(KILL, riga + '\\n');
      const viva = fs.readFileSync(STATO, 'utf8').includes(${JSON.stringify(SESSIONE)});
      if (riga.startsWith('has-session') && !viva) {
        process.stdout.write('%begin 1 ' + n + ' 1\\n%error 1 ' + n + ' 1\\n');
      } else {
        process.stdout.write('%begin 1 ' + n + ' 1\\n%end 1 ' + n + ' 1\\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
if (args[0] === 'new-session') {
  fs.writeFileSync(STATO, ${JSON.stringify(SESSIONE)} + '\\n');
  process.stdout.write('$6\\t@6\\t%6\\n');
  process.exit(0);
}
if (args[0] === 'display-message') { process.stdout.write('0\\t0\\t%6\\n'); process.exit(0); }
if (args[0] === 'kill-session') { fs.appendFileSync(KILL, 'fresh\\n'); process.exit(0); }
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
    cells: [{ id: 'CellaInc', tmuxSession: SESSIONE, cwd, engine: 'ec', boot: false }],
  });
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false, log: () => {} },
    home, defsPath, tmuxBin, readonly: () => false,
    leaseManager: {
      track: async () => ({ launchEpoch: 'ab'.repeat(8), stablePath: path.join(root, 'lease') }),
      armControl: () => ({ hash: 'a'.repeat(64) }),
      revokeControl: () => {},
      controlArmato: () => true,
      controlLaunchId: () => null,
    },
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'e'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  const record = path.join(filesRoot, launchTarget.DIR, `${SESSIONE}.json`);
  t.after(() => { try { runtime.shutdown(); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); });
  return { runtime, record, stato, killLog };
}

test('stop non dimostrato: il record resta e un nuovo avvio e rifiutato', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaInc');
  await assert.rejects(() => w.runtime.down('CellaInc'), (e) => e.fleetCode === 'IDENTITY_LOST');
  const primo = JSON.parse(fs.readFileSync(w.record, 'utf8'));
  assert.equal(primo.incerto, true);
  assert.equal(fs.readFileSync(w.killLog, 'utf8'), '');
  assert.equal(fs.readFileSync(w.stato, 'utf8').includes(SESSIONE), true);
  await assert.rejects(() => w.runtime.down('CellaInc'), (e) => e.fleetCode === 'IDENTITY_LOST');
  assert.equal(JSON.parse(fs.readFileSync(w.record, 'utf8')).incerto, true);
  await assert.rejects(() => w.runtime.up('CellaInc'), (e) => e.fleetCode === 'STOP_UNKNOWN');
});
