'use strict';
// The four deterministic proofs of the design (section 5) that were missing
// after the first pass. Real code paths, faults injected from the test side,
// temporary directories and test-owned children only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const pidf = require('../lib/cli/pidfile.js');
const { claimService } = require('../lib/cli/service-guard.js');
const { stopPortableRuntime } = require('../lib/cli/runtime-lifecycle.js');
const { restartRuntime } = require('../lib/update/runner.js');
const lt = require('../lib/fleet/launch-target.js');
const locale = require('../lib/fleet/vl-claim-pin-local.js');
const commands = require('../lib/cli/commands.js');

const REPO = path.resolve(__dirname, '..');
const FLOCK = '/usr/bin/flock';
const HELPER = 'a'.repeat(64);

function tmp(t, prefisso) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefisso));
  t.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });
  return d;
}

function uccidi(figlio) {
  return new Promise((resolve) => {
    if (figlio.exitCode !== null || figlio.signalCode) return resolve();
    figlio.once('exit', () => resolve());
    try { figlio.kill('SIGKILL'); } catch (_) { resolve(); }
  });
}

function errCode(e) {
  if (!e) return 'none';
  if (e.code) return e.code;
  const m = String(e.message || '').match(/^([A-Z_]+):/);
  return m ? m[1] : 'none';
}

// ---------------------------------------------------------------- (a)
// A stop that cannot prove the exit declares killed:false, keeps the record,
// and a second service entry is refused.
test('stop without proof of exit does not declare stopped and blocks a second service', async (t) => {
  const home = tmp(t, 'nc-stop-unproven-');
  fs.mkdirSync(path.join(home, '.nexuscrew'), { mode: 0o700 });
  const pidPath = pidf.defaultPidfilePath(home);
  // Test-owned child that ignores SIGTERM: the stop cannot prove its exit.
  const ostinato = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
  t.after(() => uccidi(ostinato));
  await new Promise((r) => setTimeout(r, 200));
  pidf.writePidfile(pidPath, ostinato.pid, `${process.execPath} -e`, {}, {
    serviceRunId: crypto.randomBytes(16).toString('hex'),
    serviceGuard: { v: 1, dev: 1, ino: 1 },
  });

  const esito = stopPortableRuntime({ home, platform: 'termux', log: () => {}, stopWaitMs: 200 });
  assert.equal(esito.killed, false, 'no proof of exit: never "stopped"');
  assert.match(esito.reason, /did not exit/);
  assert.ok(fs.existsSync(pidPath), 'the record survives the unproven stop');

  // A second service entry must be refused while the unproven owner lives.
  let rifiuto = null;
  try {
    claimService({ pidPath, cmd: 'node nexuscrew serve', guardImpl: { flockPath: FLOCK, waitSec: '0.3' } });
  } catch (e) { rifiuto = e; }
  assert.ok(rifiuto, 'the second service must be refused');
  assert.equal(errCode(rifiuto), 'PIDFILE_ALIVE');

  // Control: with the owner really gone the claim succeeds.
  await uccidi(ostinato);
  const claim = claimService({ pidPath, cmd: 'node nexuscrew serve', guardImpl: { flockPath: FLOCK, waitSec: '0.3' } });
  try { fs.closeSync(claim.guard.fd); } catch (_) {}
});

// ---------------------------------------------------------------- (b)
// A real update restart over a real serve process: everything real except the
// server start, which is the documented seam (no network in tests).
function scriviServeSeam(dir) {
  const file = path.join(dir, 'serve-seam.js');
  fs.writeFileSync(file, `
'use strict';
const fs = require('node:fs');
const commands = require(${JSON.stringify(path.join(REPO, 'lib/cli/commands.js'))});
const caso = JSON.parse(process.env.CASO);
try {
  commands.serve({
    home: caso.home, platform: 'termux', pidfile: true, port: 41999,
    chdirImpl: () => {}, ensureFleetDefaultsImpl: () => ({}),
    guardImpl: { flockPath: ${JSON.stringify(FLOCK)}, waitSec: '0.3' },
    serverStart: () => {
      fs.writeFileSync(caso.marker, String(process.pid));
      process.stdout.write('STARTED\\n');
      setInterval(() => {}, 1000);
    },
  });
  fs.writeFileSync(caso.marker + '.err', 'none');
} catch (e) {
  fs.writeFileSync(caso.marker + '.err', (e && e.code) + ' ' + String(e && e.message));
  process.exit(3);
}
`);
  return file;
}

test('real update restart: no pre-clean, the new serve claims the record through the guard', async (t) => {
  const dir = tmp(t, 'nc-restart-claim-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const pidPath = pidf.defaultPidfilePath(home);
  const markerA = path.join(dir, 'a.marker');
  const markerB = path.join(dir, 'b.marker');
  const script = scriviServeSeam(dir);
  const avviaServe = (marker) => {
    const figlio = spawn(process.execPath, [script], {
      env: { ...process.env, CASO: JSON.stringify({ home, marker }), NEXUSCREW_PIDFILE: '' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    t.after(() => uccidi(figlio));
    return figlio;
  };
  const a = avviaServe(markerA);
  await new Promise((resolve) => {
    const scadenza = setTimeout(resolve, 8000);
    const check = () => { if (fs.existsSync(markerA)) { clearTimeout(scadenza); resolve(); } };
    const timer = setInterval(() => { if (fs.existsSync(markerA)) { clearInterval(timer); check(); } }, 50);
    a.once('exit', () => { clearInterval(timer); clearTimeout(scadenza); resolve(); });
  });
  assert.ok(fs.existsSync(markerA), 'first serve started');
  const prima = pidf.readPidfile(pidPath);
  assert.ok(prima && prima.serviceRunId, 'first serve reserved the record');

  // The updater runs with the REAL commands module; only the server start is
  // the seam (the replacement startPortable spawns the same serve entry) and
  // the runtime probe is seeded with the expected version.
  const mode = await restartRuntime({
    home, platform: 'termux', port: 41999, token: 't', expectedVersion: '0.9.83', log: () => {},
    commands: {
      ...commands,
      isServiceRunning: () => false, // portable branch, as on the phone
      startPortable: () => { avviaServe(markerB); return { started: true, portable: true }; },
    },
    runtimeVersionImpl: async () => '0.9.83',
    waitForRuntimeImpl: async () => true,
  });
  assert.equal(mode, 'portable');
  await new Promise((resolve) => {
    const scadenza = setTimeout(resolve, 8000);
    const timer = setInterval(() => { if (fs.existsSync(markerB)) { clearInterval(timer); clearTimeout(scadenza); resolve(); } }, 50);
  });
  assert.ok(fs.existsSync(markerB), 'the replacement serve started');
  assert.equal(a.exitCode !== null || a.signalCode !== null, true, 'the old serve really exited');
  const dopo = pidf.readPidfile(pidPath);
  assert.ok(dopo && dopo.serviceRunId, 'the replacement reserved a new record');
  assert.notEqual(dopo.serviceRunId, prima.serviceRunId);
});

// ---------------------------------------------------------------- (c)
// A commit whose last-phase fsync is denied never authorizes the next step:
// the journal stays and the completion is blocked until the sync succeeds.
const SESSIONE = 'cloud-commit-barrier';
const LID = 'ab'.repeat(8);

function mondoCommit(t) {
  const root = tmp(t, 'nc-commit-barrier-');
  const r = lt.registraPrepared(root, SESSIONE, {
    launchId: LID, family: 'other', cellId: 'worker', tmuxSocket: '/tmp/nc-sock', daemonInc: 'inc-1',
  });
  assert.equal(r.ok, true);
  const file = path.join(root, 'launch-targets', `${SESSIONE}.json`);
  const bytes = fs.readFileSync(file);
  return {
    root, file, bytes,
    journal: lt.percorsoJournal(root, SESSIONE),
    quarantena: lt.percorsoQuarantena(root, SESSIONE, LID),
    atteso: { launchId: LID, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), fase: 'prepared' },
  };
}

test('complete act with a denied last-phase fsync does not authorize the next step', (t) => {
  const w = mondoCommit(t);
  const origFsync = fs.fsyncSync;
  // The last-phase sync: the record is already unlinked and the journal still
  // on disk — exactly the point whose failure must not authorize the next step.
  const negaFaseFinale = function guasta(fd) {
    if (!fs.existsSync(w.file) && fs.existsSync(w.journal)) {
      throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
    }
    return origFsync(fd);
  };
  fs.fsyncSync = negaFaseFinale;
  let r;
  try { r = lt.riconciliaRecord(w.root, SESSIONE, w.atteso); } finally { fs.fsyncSync = origFsync; }
  assert.equal(r.ok, false);
  assert.equal(r.codice, 'fsync-incerto');
  assert.ok(fs.existsSync(w.journal), 'the journal stays: the next step is not authorized');
  // With the journal on disk the completion is the barrier: still blocked
  // while the sync is denied, completed once it succeeds.
  let bloccato;
  fs.fsyncSync = negaFaseFinale;
  try { bloccato = lt.completaCommit(w.root, SESSIONE); } finally { fs.fsyncSync = origFsync; }
  assert.equal(bloccato.stato, 'bloccato');
  // The denial can hit the last sync or the quarantine qualification itself:
  // either way the completion stays blocked, never "completed".
  assert.ok(bloccato.codice === 'fsync-incerto' || bloccato.codice === 'dir-quarantena',
    `unexpected code ${bloccato.codice}`);
  const finito = lt.completaCommit(w.root, SESSIONE);
  assert.equal(finito.stato, 'completato');
  assert.equal(fs.existsSync(w.journal), false);
});

// ---------------------------------------------------------------- (d)
// The pin directory is swapped between the write and the cleanup: the
// temporary of the OLD generation is never removed by pathname alone and the
// substitute object in the new directory stays intact.
const depsAndroid = (p, extra = {}) => ({
  platform: 'android', arch: 'arm64', execPath: p.node,
  versioneQualificata: () => '2.39.3', ...extra,
});

test('pin: directory inode changed between write and cleanup leaves the substitute intact', (t) => {
  const dir = tmp(t, 'nc-pin-swap-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const node = path.join(bin, 'node');
  const flock = path.join(bin, 'flock');
  fs.writeFileSync(node, `#!/bin/sh\ncase "$1" in --version) echo "v${process.versions.node}";; esac\n`, { mode: 0o500 });
  fs.writeFileSync(flock, '#!/bin/sh\necho "flock from util-linux 2.39.3"\n', { mode: 0o500 });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { mode: 0o700 });
  const pinDir = path.join(home, '.nexuscrew');

  const origLink = fs.linkSync;
  const origUnlink = fs.unlinkSync;
  const origLstat = fs.lstatSync;
  const origRename = fs.renameSync;
  const origMkdir = fs.mkdirSync;
  fs.linkSync = function nega() {
    const e = new Error('EACCES: link denied');
    e.code = 'EACCES';
    throw e;
  };
  const dest = locale.percorso(home);
  let visteTmp = 0;
  let stTmpPrima = null;
  let scambiata = false;
  fs.lstatSync = function controllata(p, ...rest) {
    const st = origLstat(p, ...rest);
    // The temporary name is qualified twice: once when its identity is
    // captured before the publication, once by the cleanup before removing
    // it. Between the two, the object is complete — swap the directory under
    // the very same name and let the cleanup face the new generation.
    if (typeof p === 'string' && path.basename(p).startsWith('.vl-claim-pin.local.')
      && path.dirname(p) === pinDir) {
      visteTmp += 1;
      if (visteTmp === 1) stTmpPrima = st;
      if (visteTmp === 2 && !scambiata) {
        scambiata = true;
        const vecchia = `${pinDir}.vecchia`;
        origRename(pinDir, vecchia);
        origMkdir(pinDir, { mode: 0o700 });
        // Substitute object owned by someone else at the same temporary name.
        fs.writeFileSync(p, 'not ours\n', { flag: 'wx', mode: 0o600 });
        return stTmpPrima; // the cleanup still sees its own generation first
      }
    }
    return st;
  };
  let esito;
  try {
    esito = locale.provisiona({ home, flock, node, helperHash: HELPER, by: 'operator', deps: depsAndroid({ node }) });
  } finally {
    fs.linkSync = origLink;
    fs.unlinkSync = origUnlink;
    fs.lstatSync = origLstat;
  }
  assert.equal(esito.ok, false, 'a swapped directory is a refusal');
  assert.equal(esito.code, 'PIN_WRITE');
  // The substitute in the new directory is intact.
  const sostituto = fs.readdirSync(pinDir).find((n) => n.startsWith('.vl-claim-pin.local.'));
  assert.ok(sostituto, 'the substitute is still there');
  assert.equal(fs.readFileSync(path.join(pinDir, sostituto), 'utf8'), 'not ours\n');
  // Our published pin lives in the OLD generation directory, untouched.
  const vecchia = `${pinDir}.vecchia`;
  const pubblicato = fs.readdirSync(vecchia).find((n) => n.startsWith('vl-claim-pin'));
  assert.ok(pubblicato, 'the published object stays in its own generation');
});
