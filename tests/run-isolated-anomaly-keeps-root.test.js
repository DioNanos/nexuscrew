'use strict';

// Il gate dei pidfile CONSERVA il pidfile quando trova un'anomalia
// (tests/pidfile-containment.js) — ma l'evidenza serve DOPO la run, e il runner
// cancellava la root prima di uscire: il pidfile spariva con lei e restava solo
// una riga di stderr su una run gia' finita. Qui si collauda il RUNNER VERO —
// una copia di tests/run-isolated.js con i suoi helper e UN solo test — non il
// modulo: il difetto stava nel runner, e solo il runner lo incontra.
//
// La fixture e' l'anomalia del riaudit: la HOME della sentinella sta FUORI dalla
// root della run e il suo pidfile (valido: pid vivo, nascita, cmdline che nomina
// tunnel-supervisor.js) viene COPIATO sotto la root. Il gate non manda segnali —
// non appartiene alla run — e la suite esce 1.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TESTS_DIR = __dirname;
// The harness travels WITH the runner: every file the copied runner (or its
// bootstrap) requires must be listed here, or the fixture dies on its first
// require. real-home-guard.cjs joined the set when isolated-home.cjs started
// to install the guard (model discovery): without it the copied bootstrap
// cannot even load.
const HARNESS_FILES = Object.freeze([
  'run-isolated.js', 'isolated-home.cjs', 'real-home-guard.cjs', 'stall-watchdog.js',
  'tmux-containment.js', 'tunnel-supervisor-containment.js', 'pidfile-containment.js',
]);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

// Il test-sentinella dentro la copia del runner. `anomaly` pianta il pidfile
// dell'estraneo e LASCIA la sentinella viva (la chiude questo test, per PID);
// `clean` non pianta niente.
function sentinella(mode) {
  return `'use strict';
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pidf = require('../lib/cli/pidfile.js');

const MODE = ${JSON.stringify(mode)};

test('sentinella del runner', async () => {
  const root = process.env.NEXUSCREW_TEST_HOME_ROOT;
  fs.writeFileSync(path.join(__dirname, 'root.txt'), root + '\\n');
  if (MODE !== 'anomaly') return;
  const altrove = fs.mkdtempSync(path.join(__dirname, 'sentinella-home-'));
  const script = path.join(altrove, 'tunnel-supervisor.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\\n');
  // DETACHED e unref: la sentinella deve SOPRAVVIVERE al processo di test — e'
  // l'evidenza che il runner trova dopo — e un figlio non unref'd terrebbe in
  // vita il worker di node --test per sempre.
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, HOME: altrove, TMPDIR: altrove }, stdio: 'ignore', detached: true,
  });
  child.unref();
  // La forma che il runner raccoglie: un file .pid DIRETTAMENTE dentro una
  // cartella 'tunnels' (tests/pidfile-containment.js:21-30).
  const pidPath = path.join(root, 'tunnels', 'sup.pid');
  pidf.writePidfile(pidPath, child.pid, process.execPath + ' ' + script);
  fs.writeFileSync(path.join(__dirname, 'sentinel.pid'), String(child.pid) + '\\n');
});
`;
}

// Copia il runner e i suoi helper in una cartella sua, con UN solo test. La
// forma e' quella del repo (tests/ + lib/) perche' il runner risolve i suoi
// require come `../lib/...` dalla propria directory: una cartella piatta non
// riprodurrebbe il runner, lo romperebbe.
function harness(mode) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-runner-anomaly-'));
  const dir = path.join(fixture, 'tests');
  fs.mkdirSync(path.join(fixture, 'lib', 'cli'), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(fixture, 'tmp'), { recursive: true });
  for (const f of HARNESS_FILES) fs.copyFileSync(path.join(TESTS_DIR, f), path.join(dir, f));
  fs.copyFileSync(path.join(TESTS_DIR, '..', 'lib', 'cli', 'pidfile.js'), path.join(fixture, 'lib', 'cli', 'pidfile.js'));
  fs.writeFileSync(path.join(dir, 'solo.test.js'), sentinella(mode));
  return { fixture, dir, tmp: path.join(fixture, 'tmp') };
}

// Esegue il runner copiato e torna { code, stdout, stderr }. Il TMPDIR e' suo:
// la root della run nasce dentro la fixture e non tocca niente d'altro.
function eseguiRunner({ dir, tmp }) {
  // NODE_TEST_CONTEXT va tolto: lo imposta `node --test` per il processo di
  // test, e il runner annidato lo erediterebbe — node rifiuterebbe di eseguire
  // i file ("run() is being called recursively") e la fixture non proverebbe
  // niente. Un runner lanciato a mano non lo ha.
  const env = { ...process.env, TMPDIR: tmp, NEXUSCREW_AUTO_UPDATE: '0', NEXUSCREW_TEST_STALL_MS: '120000' };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'run-isolated.js')], {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 120000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

function leggi(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return ''; } }

function pulisci(fixture, sentinelPid) {
  if (sentinelPid && vivo(sentinelPid)) { try { process.kill(sentinelPid, 'SIGKILL'); } catch (_) {} }
  fs.rmSync(fixture, { recursive: true, force: true });
}

test('con un\'anomalia la root resta come evidenza e il suo path viene stampato', async (t) => {
  const h = harness('anomaly');
  const sentinelPid = () => Number(leggi(path.join(h.dir, 'sentinel.pid')));
  t.after(async () => {
    await delay(50);
    pulisci(h.fixture, sentinelPid());
  });

  const esito = await eseguiRunner(h);
  const root = leggi(path.join(h.dir, 'root.txt'));

  assert.equal(esito.code, 1, `atteso exit 1 dal runner, ottenuto ${esito.code}\n${esito.stderr}`);
  assert.ok(root, 'la sentinella deve aver scritto la root della run');
  assert.match(esito.stderr, /anomal/i, esito.stderr);
  assert.ok(esito.stderr.includes(root),
    `stderr deve stampare il path della root conservata (${root}):\n${esito.stderr}`);
  assert.equal(fs.existsSync(root), true, 'la root della run deve essere ancora presente dopo la run');
  assert.equal(fs.existsSync(path.join(root, 'tunnels', 'sup.pid')), true,
    'il pidfile conservato dal modulo deve sopravvivere alla run');
  assert.equal(vivo(sentinelPid()), true, 'la sentinella estranea non deve ricevere segnali');
});

test('senza anomalie la root della run viene rimossa come sempre', async (t) => {
  const h = harness('clean');
  t.after(async () => { pulisci(h.fixture, null); });

  const esito = await eseguiRunner(h);
  const root = leggi(path.join(h.dir, 'root.txt'));

  assert.equal(esito.code, 0, `attesa run verde, ottenuto ${esito.code}\n${esito.stderr}`);
  assert.ok(root, 'la sentinella deve aver scritto la root della run');
  assert.equal(fs.existsSync(root), false, 'senza anomalie la root non deve restare');
  assert.doesNotMatch(esito.stderr, /anomal/i, esito.stderr);
});
