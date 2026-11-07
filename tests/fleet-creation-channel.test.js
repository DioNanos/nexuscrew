'use strict';
// Il canale di controllo e' l'oggetto nato sul socket della new-session.
// Un set-option su un client nuovo non deve poter spostare respawn e kill
// su un server sostituto che risponde con gli stessi id.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-born-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, 'Cella');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  const genPath = path.join(root, 'gen');
  const logPath = path.join(root, 'log');
  fs.writeFileSync(genPath, 'A');
  fs.writeFileSync(logPath, '');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const GEN = ${JSON.stringify(genPath)};
const LOG = ${JSON.stringify(logPath)};
const nota = (r) => fs.appendFileSync(LOG, r + '\\n');
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  const nato = fs.readFileSync(GEN, 'utf8').trim();
  nota('open:' + nato + ':' + (argv[1] || ''));
  if (process.argv.includes('new-session')) {
    const { spawnSync: creaSync } = require('node:child_process');
    const rCrea = creaSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpoCrea = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : ''); if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
    process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
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
      if (riga === 'display-message -p nc-control-open') continue; // apertura: gia' risolta dal frame iniziale
      n += 1;
      if (riga.startsWith('kill-session')) {
        nota('owned-kill:' + nato);
        viva = false;
        process.stdout.write('%begin 1 ' + n + ' 1\\n' + (riga.startsWith('display-message') && riga.includes('pane_pid') ? '4242\\t2222\\n' : '') + '%end 1 ' + n + ' 1\\n');
        continue;
      }
      if (riga.startsWith('has-session')) {
        if (viva) process.stdout.write('%begin 1 ' + n + ' 1\\n' + (riga.startsWith('display-message') && riga.includes('pane_pid') ? '4242\\t2222\\n' : '') + '%end 1 ' + n + ' 1\\n');
        else process.stdout.write('%begin 1 ' + n + ' 1\\n%error 1 ' + n + ' 1\\n');
        continue;
      }
      process.stdout.write('%begin 1 ' + n + ' 1\\n' + (riga.startsWith('display-message') && riga.includes('pane_pid') ? '4242\\t2222\\n' : '') + '%end 1 ' + n + ' 1\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
if (args[0] === 'set-option') {
  fs.writeFileSync(GEN, 'B');
  nota('fresh-set-option');
  process.exit(0);
}
if (args[0] === 'new-session') {
  nota('new:' + (argv[1] || ''));
  process.stdout.write('$5\\t@5\\t%5\\n');
  process.exit(0);
}
if (args[0] === 'kill-session') {
  nota('fresh-kill:' + fs.readFileSync(GEN, 'utf8').trim());
  process.exit(0);
}
if (args[0] === 'display-message') {
  if (process.argv.join(' ').includes('pane_pid')) { process.stdout.write('4242\\t2222\\n'); process.exit(0); }
  process.stdout.write('0\\t0\\t%5\\n');
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
    cells: [{ id: 'CellaNata', tmuxSession: 'nc-nata', cwd, engine: 'ec', boot: false }],
  });
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false, log: () => {} },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'c'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); });
  return {
    runtime,
    righe: () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean),
  };
}

test('kill resta sul server della creazione anche se un client nuovo vedrebbe il sostituto', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaNata');
  await w.runtime.down('CellaNata');
  const righe = w.righe();
  const aperta = righe.find((r) => r.startsWith('open:'));
  const nata = righe.find((r) => r.startsWith('new:'));
  assert.ok(aperta && nata);
  assert.equal(aperta.split(':')[2], nata.split(':')[1], 'stesso socket della new-session');
  assert.equal(aperta.split(':')[1], 'A', 'il canale nasce prima del sostituto');
  assert.ok(righe.includes('owned-kill:A'));
  assert.equal(righe.some((r) => r.startsWith('fresh-kill')), false);
  assert.equal(righe.some((r) => r.startsWith('owned-kill:B')), false);
});
