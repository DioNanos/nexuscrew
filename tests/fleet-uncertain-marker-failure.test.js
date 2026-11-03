'use strict';
// L'incertezza resta bloccante anche quando la SCRITTURA del marker non
// arriva su disco: la guardia non puo' essere il solo file appena mancato.
// Recovery durevole: il lancio risolto fuori banda (record assente) scioglie
// la guardia e il nuovo avvio riparte.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const launchTarget = require('../lib/fleet/launch-target.js');

const SESSIONE = 'nc-marker';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mrk-'));
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
  const nuovoLog = path.join(root, 'new-session.log');
  fs.writeFileSync(stato, '');
  fs.writeFileSync(killLog, '');
  fs.writeFileSync(nuovoLog, '');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
const STATO = ${JSON.stringify(stato)};
const KILL = ${JSON.stringify(killLog)};
const NUOVO = ${JSON.stringify(nuovoLog)};
const viva = () => fs.readFileSync(STATO, 'utf8').includes(${JSON.stringify(SESSIONE)});
if (args[0] === '-C') {
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
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!riga) continue;
      if (riga === 'display-message -p nc-control-open') continue;
      n += 1;
      if (riga.startsWith('kill-session')) fs.appendFileSync(KILL, 'channel\\n');
      if (riga.startsWith('has-session') && !viva()) {
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
  fs.appendFileSync(NUOVO, 'una\\n');
  process.stdout.write('$6\\t@6\\t%6\\n');
  process.exit(0);
}
if (args[0] === 'display-message') { process.stdout.write('0\\t0\\t%6\\n'); process.exit(0); }
if (args[0] === 'kill-session') { fs.appendFileSync(KILL, 'fresh\\n'); process.exit(0); }
if (args[0] === 'has-session') {
  if (viva()) process.exit(0);
  process.stderr.write('can\\'t find session: ' + (args[args.length - 1] || '') + '\\n');
  process.exit(1);
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
    cells: [{ id: 'CellaMrk', tmuxSession: SESSIONE, cwd, engine: 'ec', boot: false }],
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
  const record = () => path.join(filesRoot, launchTarget.DIR, `${SESSIONE}.json`);
  const dirRecord = () => path.join(filesRoot, launchTarget.DIR);
  t.after(() => {
    try { runtime.shutdown(); } catch (_) {}
    try { fs.chmodSync(dirRecord(), 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { runtime, record, dirRecord, stato, killLog, nuovoLog };
}

test('scrittura del marker fallita: il blocco resta e nessun nuovo lancio parte', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaMrk');
  const baseNuovo = fs.readFileSync(w.nuovoLog, 'utf8');
  // Il teardown finira' in esito non dimostrato E la persistenza del marker
  // non riuscira': la directory del record diventa di sola lettura.
  fs.chmodSync(w.dirRecord(), 0o500);
  await assert.rejects(() => w.runtime.down('CellaMrk'), (e) => e.fleetCode === 'IDENTITY_LOST');
  const suDisco = JSON.parse(fs.readFileSync(w.record(), 'utf8'));
  assert.notEqual(suDisco.incerto, true, 'il marker NON e\' arrivato su disco');
  // Il blocco non dipende dal file appena mancato: il nuovo avvio e' rifiutato
  // PRIMA di qualunque effetto di lancio.
  await assert.rejects(() => w.runtime.up('CellaMrk'), (e) => e.fleetCode === 'STOP_UNKNOWN');
  assert.equal(fs.readFileSync(w.nuovoLog, 'utf8'), baseNuovo, 'nessuna new-session tentata');
  assert.equal(fs.readFileSync(w.killLog, 'utf8'), '', 'nessun kill eseguito');
});

test('recovery durevole: lancio risolto fuori banda, la guardia si scioglie', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaMrk');
  fs.chmodSync(w.dirRecord(), 0o500);
  await assert.rejects(() => w.runtime.down('CellaMrk'), (e) => e.fleetCode === 'IDENTITY_LOST');
  await assert.rejects(() => w.runtime.up('CellaMrk'), (e) => e.fleetCode === 'STOP_UNKNOWN');
  // Fuori banda: permessi ripristinati, record rimosso a mano, sessione finita.
  fs.chmodSync(w.dirRecord(), 0o700);
  fs.unlinkSync(w.record());
  fs.writeFileSync(w.stato, '');
  const esito = await w.runtime.down('CellaMrk');
  assert.equal(esito.outcome, 'alreadyAbsent');
  const dopo = await w.runtime.up('CellaMrk');
  assert.ok(dopo && dopo.ok !== false, 'il nuovo avvio riparte a lancio risolto');
});
