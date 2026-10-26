'use strict';

// Release protocol as a write-ahead log: every boundary keeps a barrier
// already persistent on disk (the reserve, and the lease name occupied by
// the tombstone while the removal commits). Faults are injected at each
// directory-sync boundary; crashes are real SIGKILLs on a child running the
// section under the real flock; two processes contend on the same root.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const radici = require('../lib/fleet/vl-roots.js');
const sezione = require('../lib/fleet/vl-claim-section.js');

function id() { return crypto.randomBytes(8).toString('hex'); }

function casa(nome) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), nome));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  return home;
}

function prepara(home) {
  const claims = path.join(path.dirname(home), 'claims');
  fs.mkdirSync(claims, { mode: 0o700 });
  return {
    claims,
    base: {
      v: 1, op: 'claim', requestId: id(), root: sezione.canonicaRadice(path.join(home, 'srv')),
      launchId: '22'.repeat(8), ownerInstanceId: 'own', cellId: 'cell',
      claimsDir: claims, sectionBudgetMs: 4000,
    },
  };
}

// Fault the Nth directory fsync of the RELEASE phase only (installed after
// the claim, like an auditor's probe would).
function faultDirSyncRelease(n, fn) {
  const sync = fs.fsyncSync;
  let dirs = 0;
  try {
    fs.fsyncSync = (fd) => {
      if (fs.fstatSync(fd).isDirectory() && ++dirs === n) {
        throw Object.assign(new Error('synthetic dir sync EIO'), { code: 'EIO' });
      }
      return sync(fd);
    };
    return fn();
  } finally {
    fs.fsyncSync = sync;
  }
}

function barrierFiles(claims) {
  return fs.readdirSync(claims).filter((f) => f.endsWith('.reserve') || f.endsWith('.lease'));
}

const CASES = [
  { n: 1, quando: 'reserve publish link sync' },
  { n: 2, quando: 'reserve tmp cleanup sync' },
  { n: 3, quando: 'lease removal commit' },
  { n: 4, quando: 'tombstone commit' },
  { n: 5, quando: 'tombstone removal commit' },
];

for (const { n, quando } of CASES) {
  test(`fault at release boundary ${n} (${quando}) keeps a barrier on disk`, () => {
    const home = casa(`nc-wal${n}-`);
    const { claims, base } = prepara(home);
    try {
      assert.equal(sezione.eseguiSezione(base).outcome, 'claimed');
      let release;
      faultDirSyncRelease(n, () => {
        release = sezione.eseguiSezione({ ...base, op: 'release' });
      });
      assert.equal(release.outcome, 'uncertain', `boundary ${n} must answer uncertain`);
      const next = sezione.eseguiSezione({ ...base, launchId: '33'.repeat(8) });
      assert.notEqual(next.outcome, 'claimed', `boundary ${n} must not free the root`);
      assert.ok(barrierFiles(claims).length > 0, `boundary ${n} must keep a barrier file`);
    } finally {
      fs.rmSync(path.dirname(home), { recursive: true, force: true });
    }
  });
}

test('fault after the commit point is cleanup only: released, root claimable', () => {
  const home = casa('nc-wal6-');
  const { claims, base } = prepara(home);
  try {
    assert.equal(sezione.eseguiSezione(base).outcome, 'claimed');
    let release;
    faultDirSyncRelease(6, () => {
      release = sezione.eseguiSezione({ ...base, op: 'release' });
    });
    // Boundary 6 commits the reserve removal: the lease absence was already
    // durable at boundary 5, so the release is definitive and the answer
    // must not promise an exclusion that no longer exists.
    assert.equal(release.outcome, 'released');
    assert.equal(release.code, 'RESERVE_CLEANUP');
    const next = sezione.eseguiSezione({ ...base, launchId: '33'.repeat(8) });
    assert.equal(next.outcome, 'claimed');
  } finally {
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('successful release leaves the root clean and claimable under the real lock', async () => {
  const home = casa('nc-walok-');
  const root = path.join(home, 'srv');
  const base = { home, root, ownerInstanceId: 'own', cellId: 'cell', budgetMs: 4000 };
  try {
    assert.equal((await radici.riserva({ ...base, launchId: '22'.repeat(8) })).outcome, 'claimed');
    const tolta = await radici.rilascia({ ...base, launchId: '22'.repeat(8) });
    assert.equal(tolta.outcome, 'released');
    assert.equal(tolta.code, null);
    const claims = radici.dirClaim(home);
    assert.equal(fs.readdirSync(claims).filter((f) => f.endsWith('.lease') || f.endsWith('.reserve')).length, 0);
    assert.equal((await radici.riserva({ ...base, launchId: '33'.repeat(8) })).outcome, 'claimed');
  } finally {
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

// Crash at a protocol boundary: a real child runs the section under the
// real flock and is SIGKILLed while parked on the hold point; a second
// process must then find a persistent barrier, never a free root.
function crashAt(holdAt) {
  return async () => {
    const home = casa(`nc-crash-${holdAt}-`);
    const root = path.join(home, 'srv');
    const hold = fs.mkdtempSync(path.join(os.tmpdir(), `nc-hold-${holdAt}-`));
    const base = { home, root, ownerInstanceId: 'own', cellId: 'cell', budgetMs: 8000 };
    try {
      assert.equal((await radici.riserva({ ...base, launchId: '22'.repeat(8) })).outcome, 'claimed');
      const runner = path.join(home, 'crash.cjs');
      fs.writeFileSync(runner, `'use strict';
const { eseguiSezione } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'fleet', 'vl-claim-section.js'))});
const req = JSON.parse(process.argv[2]);
req.op = 'release';
try { process.stdout.write(JSON.stringify(eseguiSezione(req))); } catch (e) { process.stdout.write(JSON.stringify({ ok: false, outcome: 'crashed', error: String(e && e.message) })); }
`);
      const claims = radici.dirClaim(home);
      const child = spawn(process.execPath, [runner, JSON.stringify({
        v: 1, op: 'release', requestId: id(), root,
        launchId: '22'.repeat(8), ownerInstanceId: 'own', cellId: 'cell',
        claimsDir: claims, sectionBudgetMs: 8000,
      })], { env: { ...process.env, VL_CLAIM_HOLD_DIR: hold, VL_CLAIM_HOLD_AT: holdAt } });
      const entrato = await new Promise((resolve, reject) => {
        const fine = Date.now() + 5000;
        const tick = () => {
          try {
            if (fs.readdirSync(hold).some((f) => f.startsWith('entered-'))) { resolve(true); return; }
          } catch (_) { /* dir rimossa? */ }
          if (Date.now() > fine) { reject(new Error('child never reached the hold point')); return; }
          setTimeout(tick, 20);
        };
        tick();
      });
      assert.ok(entrato);
      child.kill('SIGKILL');
      await new Promise((resolve) => {
        if (child.exitCode != null || child.signalCode != null) resolve();
        else child.on('exit', resolve);
      });
      const dopo = await radici.riserva({ ...base, launchId: '33'.repeat(8) });
      assert.notEqual(dopo.outcome, 'claimed', `crash at ${holdAt} left the root free`);
      assert.ok(barrierFiles(claims).length > 0, `crash at ${holdAt} left no barrier`);
    } finally {
      fs.rmSync(hold, { recursive: true, force: true });
      fs.rmSync(path.dirname(home), { recursive: true, force: true });
    }
  };
}

test('crash before the lease removal keeps the root blocked', crashAt('prima-unlink-lease'));
test('crash after the tombstone commit keeps the root blocked', crashAt('dopo-tomba'));

test('two processes on the same root serialize under the real lock', async () => {
  const home = casa('nc-contesa-');
  const root = path.join(home, 'srv');
  const hold = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hold-contesa-'));
  const base = { home, root, ownerInstanceId: 'own', cellId: 'cell' };
  try {
    assert.equal((await radici.riserva({ ...base, launchId: '22'.repeat(8), budgetMs: 4000 })).outcome, 'claimed');
    const inVolo = radici.rilascia({
      ...base, launchId: '22'.repeat(8), budgetMs: 8000,
      holdDir: hold, holdAt: 'dopo-lettura',
    });
    await new Promise((resolve, reject) => {
      const fine = Date.now() + 5000;
      const tick = () => {
        try {
          if (fs.readdirSync(hold).some((f) => f.startsWith('entered-'))) { resolve(); return; }
        } catch (_) { /* */ }
        if (Date.now() > fine) { reject(new Error('release never parked')); return; }
        setTimeout(tick, 20);
      };
      tick();
    });
    // A contender arrives while the release holds the lock: it must be
    // refused, not interleaved.
    const contendente = await radici.riserva({ ...base, launchId: '33'.repeat(8), budgetMs: 500 });
    assert.equal(contendente.outcome, 'refused');
    assert.equal(contendente.code, 'LOCK_TIMEOUT');
    fs.writeFileSync(path.join(hold, `go-${fs.readdirSync(hold).find((f) => f.startsWith('entered-')).slice('entered-'.length)}`), '1');
    const esito = await inVolo;
    assert.equal(esito.outcome, 'released');
    const dopo = await radici.riserva({ ...base, launchId: '33'.repeat(8), budgetMs: 4000 });
    assert.equal(dopo.outcome, 'claimed');
  } finally {
    fs.rmSync(hold, { recursive: true, force: true });
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  }
});
