'use strict';
// Le uscite «sessione gia' assente» e «canale morto dopo il kill accettato»
// chiudono PRIMA la barriera host e SOLO POI tolgono record e canale: un host
// non fermo lascia il lancio al suo posto invece di dichiarare la chiusura
// con il record gia' cancellato.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const { OWNER_INSTANCE_ID, scriptVlFintoConHost, preparaHostFinto } = require('./helpers/vl-attestato.js');

const SESSIONE = 'cloud-CellaOrd';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ord-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaOrd');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const logPath = path.join(root, 'vl.log');
  const killPath = path.join(root, 'kill.log');
  const muoriSuKill = path.join(root, 'MUORI_SU_KILL');
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(killPath, '');
  // Binario finto QUALIFICATO peer/stop con host VERO: all'up la tuple del
  // peer viene letta da /proc del pid vivo nel pidfile e registrata nel
  // contesto (hook --respawn nel new-session del tmux finto). «Host non
  // fermo» al down, ora, è un processo REALE che non e' piu' quello
  // registrato: i test sostituiscono l'host dopo l'up e la tuple osservata
  // non coincide — isolamento «ignoto», la barriera rifiuta senza toccare
  // nessun pid.
  const hostScript = preparaHostFinto(root);
  const hostpid = path.join(root, 'hostpid');
  fs.writeFileSync(hostpid, '0\n');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(vlBin, scriptVlFintoConHost({ hostpid, vllog: logPath }), { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  const catalogo = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogo, { recursive: true });
  fs.writeFileSync(path.join(catalogo, 'config.toml'), '[profiles.work]\nmodel = "m"\n');
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  const stato = path.join(root, 'sessione-viva');
  fs.writeFileSync(stato, '1\n');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
const HOSTSCRIPT = ${JSON.stringify(hostScript)};
const HOSTPID = ${JSON.stringify(hostpid)};
const STATO = ${JSON.stringify(stato)};
const KILL = ${JSON.stringify(killPath)};
const MUORI_SU_KILL = ${JSON.stringify(muoriSuKill)};
const viva = () => fs.readFileSync(STATO, 'utf8').trim() === '1';
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
      if (riga.startsWith('kill-session')) {
        fs.appendFileSync(KILL, 'kill\\n');
        fs.writeFileSync(STATO, '0\\n');
        process.stdout.write('%begin 1 ' + n + ' 1\\n%end 1 ' + n + ' 1\\n');
        if (fs.existsSync(MUORI_SU_KILL)) {
          // La morte del canale porta con se' un host NUOVO sulla root (qui
          // lo fa nascere il tmux finto, come farebbe un altro lancio): la
          // chiusura che segue il kill dovra' rigiudicarlo, e la tuple in
          // /proc non sara' quella registrata.
          { const { spawnSync: riavviaHost } = require('node:child_process');
            riavviaHost(process.execPath, [HOSTSCRIPT, '--respawn', HOSTPID]); }
          process.exit(0);
        }
        continue;
      }
      if (riga.startsWith('has-session') && !viva()) {
        // il verdetto VERO di tmux per la sessione inesistente: e' l'unico
        // %error che attesta l'assenza del target sul canale di controllo
        const id = riga.split(/\\s+/).pop();
        process.stdout.write('%begin 1 ' + n + ' 1\\ncan\\'t find session: ' + id + '\\n%error 1 ' + n + ' 1\\n');
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
  // new-session (il vecchio pid, se vivo, viene spento per pid esatto),
  // cosi' all'up la tuple registrata e' osservabile in /proc.
  { const { spawnSync: riavviaHost } = require('node:child_process');
    riavviaHost(process.execPath, [HOSTSCRIPT, '--respawn', HOSTPID]); }
  process.stdout.write('$3\\t@3\\t%3\\n'); process.exit(0);
}
if (args[0] === 'display-message') process.stdout.write('0\\t0\\t%3\\n');
if (args[0] === 'kill-session') { fs.appendFileSync(KILL, 'fresh\\n'); process.exit(0); }
if (args[0] === 'has-session') process.exit(viva() ? 0 : 1);
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
    cells: [{ id: 'CellaOrd', tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false }],
  });
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false, vlLaunchCooldownMs: 0, log: () => {}, env: {} },
    home, defsPath, tmuxBin, readonly: () => false,
    identityOwnerInstanceId: OWNER_INSTANCE_ID,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'f'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  const record = () => path.join(filesRoot, launchTarget.DIR, `${SESSIONE}.json`);
  t.after(() => {
    // Zero orfani: l'host finto si spegne per pid esatto prima della pulizia.
    try {
      const p = Number(fs.readFileSync(hostpid, 'utf8').trim()) || 0;
      if (p > 0) process.kill(p, 'SIGKILL');
    } catch (_) {}
    try { runtime.shutdown(); } catch (_) {} fs.rmSync(root, { recursive: true, force: true });
  });
  return { runtime, record, stato, killPath, logPath, muoriSuKill, hostScript, hostpid };
}

test('sessione gia assente con host non fermo: record e canale restano', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaOrd');
  // La sessione finisce fuori banda; il record del lancio resta. Fra la
  // registrazione all'up e il down l'host viene SOSTITUITO (helper
  // --respawn: il vecchio pid muore per pid esatto, il pidfile nomina un
  // processo vivo nato DOPO): la tuple osservata in /proc non e' piu'
  // quella registrata, l'isolamento resta «ignoto» e la barriera host
  // rifiuta senza toccare nessun pid — in questo ramo e' l'unica che gira.
  const { spawnSync } = require('node:child_process');
  spawnSync(process.execPath, [w.hostScript, '--respawn', w.hostpid]);
  fs.writeFileSync(w.stato, '0\n');
  await assert.rejects(() => w.runtime.down('CellaOrd'), (e) => e.fleetCode === 'HOST_STOP_FAILED');
  assert.ok(fs.existsSync(w.record()), 'il record del lancio NON e\' stato rimosso prima della barriera host');
  assert.equal(JSON.parse(fs.readFileSync(w.record(), 'utf8')).incerto, true);
  assert.equal(fs.readFileSync(w.killPath, 'utf8'), '', 'nessun kill: la sessione era gia\' assente');
  await assert.rejects(() => w.runtime.up('CellaOrd'), (e) => e.fleetCode === 'STOP_UNKNOWN');
});

test('kill accettato e canale morto: la chiusura host precede la rimozione', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaOrd');
  // Il canale muore RICEVUTO il kill-session: la morte del client attaccato
  // e' la conferma osservata della fine della sessione. La prima barriera
  // (pre-kill) passa perche' l'host registrato viene fermato pulito; ma con
  // la morte del canale nasce un host NUOVO sulla root, la tuple in /proc
  // non e' piu' quella registrata e la chiusura post-kill rifiuta: il
  // record del lancio NON viene rimosso.
  fs.writeFileSync(w.muoriSuKill, '1\n');
  await assert.rejects(() => w.runtime.down('CellaOrd'), (e) => e.fleetCode === 'HOST_STOP_FAILED');
  assert.equal(fs.readFileSync(w.killPath, 'utf8'), 'kill\n', 'il kill accettato e\' avvenuto');
  assert.ok(fs.existsSync(w.record()), 'il record del lancio NON e\' stato rimosso prima della barriera host');
  assert.equal(JSON.parse(fs.readFileSync(w.record(), 'utf8')).incerto, true);
  await assert.rejects(() => w.runtime.up('CellaOrd'), (e) => e.fleetCode === 'STOP_UNKNOWN');
});
