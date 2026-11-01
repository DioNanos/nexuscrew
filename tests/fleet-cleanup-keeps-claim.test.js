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
const { scriptVlFintoConHost } = require('./helpers/vl-attestato.js');

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
  // Binario finto QUALIFICATO peer/stop: il preflight dell'up interroga le
  // capacita' PRIMA dello spawn, quindi anche un lancio destinato a fallire
  // al respawn parte da un binario che sa attestare. L'host qui NON nasce
  // (il client non parte mai: il respawn perde la risposta), la
  // registrazione dell'identita' non arriva mai e la lease resta.
  const hostpid = path.join(root, 'hostpid');
  fs.writeFileSync(hostpid, '0\n');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(vlBin, scriptVlFintoConHost({ hostpid }), { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  // Catalogo del TEST, non dell'ambiente: la sorgente "dell'operatore" per
  // vl.native risolve XDG_CONFIG_HOME da cfg.env (o da process.env). Il test
  // scrive la fixture nella home isolata e passa env: {} qui sotto, cosi' la
  // sorgente e' sempre questa, mai il config del worker o dell'operatore.
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
      if (riga === 'display-message -p nc-control-open') continue; // apertura: gia' risolta dal frame iniziale
      n += 1;
      if (riga.startsWith('respawn-pane')) {
        process.stdout.write('%begin 1 ' + n + ' 1\\nrespawn lost\\n%error 1 ' + n + ' 1\\n');
      } else {
        process.stdout.write('%begin 1 ' + n + ' 1\\n%end 1 ' + n + ' 1\\n');
      }
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
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false, vlLaunchCooldownMs: 0, log: () => {}, env: {} }, // env: {} -> niente XDG_CONFIG_HOME dell'ambiente
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
