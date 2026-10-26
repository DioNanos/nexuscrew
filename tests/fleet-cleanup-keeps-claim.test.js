'use strict';
// Dopo che la sessione esiste, un lancio fallito non scioglie la lease:
// la risposta al respawn puo' perdersi dopo lo spawn. Il rilascio aspetta
// la prova completa, non il nome della funzione di cleanup.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');

const SESSIONE = 'cloud-CellaLease';

function trova(dir, nome) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, voce.name);
    if (voce.isDirectory()) out.push(...trova(p, nome));
    else if (voce.name === nome || voce.name.endsWith(nome)) out.push(p);
  }
  return out;
}

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-keep-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaLease');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(vlBin, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf \'vl 0.3.1\\n\'; exit 0; fi\nexit 0\n', { mode: 0o755 });
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
  if (args.includes('nc-control-open')) process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
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
      process.stdout.write('%begin 1 ' + n + ' 1\\n%end 1 ' + n + ' 1\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
const cmd = args[0] || '';
if (cmd === 'new-session') { process.stdout.write('$5\\t@5\\t%5\\n'); process.exit(0); }
if (cmd === 'respawn-pane') { process.stderr.write('respawn lost\\n'); process.exit(1); }
if (cmd === 'display-message') { process.stdout.write('/tmp/nc-fake/socket\\t4242\\n'); process.exit(0); }
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'vl.native', label: 'VL',
      managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }],
    cells: [{ id: 'CellaLease', tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false }],
  });
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false, vlLaunchCooldownMs: 0, log: () => {} },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'b'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); });
  return { runtime, home };
}

test('respawn senza risposta: la lease e il contesto restano', async (t) => {
  const w = mondo(t);
  await assert.rejects(() => w.runtime.up('CellaLease'), (e) => e.fleetCode === 'NEW_SESSION_FAILED');
  const lease = trova(path.join(w.home, '.nexuscrew', 'vl-root-claims'), '.lease');
  assert.ok(lease.length >= 1, 'la lease del lancio non e\' stata sciolta');
  const ctx = trova(path.join(w.home, '.nexuscrew'), 'host-context.json');
  assert.ok(ctx.length >= 1, 'il contesto del lancio resta');
});
