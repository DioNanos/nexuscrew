'use strict';
// La famiglia dello stop host e' quella del lancio registrato. Un cambio
// dell'engine nella definizione vale dal lancio successivo.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');

const SESSIONE = 'cloud-CellaFam';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fam-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaFam');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const logPath = path.join(root, 'vl.log');
  fs.writeFileSync(logPath, '');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(vlBin, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'vl 0.3.1\\n'; exit 0; fi
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [ "$1" = "host" ]; then printf '%s\\n' '{"state":"none"}'; exit 0; fi
if [ "$1" = "shutdown" ]; then printf '%s\\n' '{"ok":true}'; exit 0; fi
exit 0
`, { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  const catalogo = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogo, { recursive: true });
  fs.writeFileSync(path.join(catalogo, 'config.toml'), '[profiles.work]\nmodel = "m"\n');
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  let buf = '';
  let n = 0;
  let viva = true;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!riga) continue;
      n += 1;
      if (riga.startsWith('kill-session')) viva = false;
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
if (args[0] === 'new-session') { process.stdout.write('$8\\t@8\\t%8\\n'); process.exit(0); }
if (args[0] === 'display-message') { process.stdout.write('0\\t0\\t%8\\n'); process.exit(0); }
if (args[0] === 'list-sessions') process.exit(0);
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  const cella = { id: 'CellaFam', tmuxSession: SESSIONE, cwd, engine: 'motore', boot: false };
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'motore', label: 'VL',
      managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }],
    cells: [cella],
  });
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false, vlLaunchCooldownMs: 0, log: () => {}, env: {} },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'd'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); });
  return { runtime, defsPath, cella, logPath };
}

test('engine cambiato dopo il lancio: lo stop host usa ancora il contesto registrato', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaFam');
  atomicWrite(w.defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'motore', label: 'C',
      managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' },
    }],
    cells: [w.cella],
  });
  const esito = await w.runtime.down('CellaFam');
  const log = fs.readFileSync(w.logPath, 'utf8');
  assert.match(log, /host status/);
  assert.notEqual(esito.host, 'not-vl');
});
