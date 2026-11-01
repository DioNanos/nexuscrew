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
const { OWNER_INSTANCE_ID, scriptVlFintoConHost, preparaHostFinto } = require('./helpers/vl-attestato.js');

const SESSIONE = 'cloud-CellaFam';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fam-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaFam');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const logPath = path.join(root, 'vl.log');
  fs.writeFileSync(logPath, '');
  // Binario finto QUALIFICATO peer/stop con host VERO: l'up registra la
  // tuple del peer letta da /proc, quindi la sessione creata dal tmux finto
  // fa nascere un host reale (hook --respawn nel new-session qui sotto).
  const hostScript = preparaHostFinto(root);
  const hostpid = path.join(root, 'hostpid');
  fs.writeFileSync(hostpid, '0\n');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(vlBin, scriptVlFintoConHost({ hostpid, vllog: logPath }), { mode: 0o755 });
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
const HOSTSCRIPT = ${JSON.stringify(hostScript)};
const HOSTPID = ${JSON.stringify(hostpid)};
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
if (args[0] === 'new-session') {
  // La nascita dell'host accompagna la sessione: l'host nuovo nasce a ogni
  // new-session (il vecchio pid, se vivo, viene spento per pid esatto).
  { const { spawnSync: riavviaHost } = require('node:child_process');
    riavviaHost(process.execPath, [HOSTSCRIPT, '--respawn', HOSTPID]); }
  process.stdout.write('$8\\t@8\\t%8\\n'); process.exit(0);
}
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
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false, vlLaunchCooldownMs: 0, log: () => {}, env: {} }, // env: {} -> niente XDG_CONFIG_HOME dell'ambiente
    home, defsPath, tmuxBin, readonly: () => false,
    identityOwnerInstanceId: OWNER_INSTANCE_ID,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'd'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  t.after(() => {
    // Zero orfani: l'host finto si spegne per pid esatto prima della pulizia.
    try {
      const p = Number(fs.readFileSync(hostpid, 'utf8').trim()) || 0;
      if (p > 0) process.kill(p, 'SIGKILL');
    } catch (_) {}
    try { runtime.shutdown(); } catch (_) {} fs.rmSync(root, { recursive: true, force: true });
  });
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
