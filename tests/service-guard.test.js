'use strict';
// Service liveness guard and pid file proof (Termux lifecycle).
//
// A stale pid file is proven with positive evidence only. The service holds a
// kernel lock for its whole life, taken before any pid file is cleaned or
// reserved, so a record written under that lock can be recognised as stale
// even when the pid has been reused and /proc is unreadable. Real child
// processes are used for the lock; every pid touched is a child of the test.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const pidf = require('../lib/cli/pidfile.js');

const FLOCK = '/usr/bin/flock';
const REPO = path.resolve(__dirname, '..');
const guardMod = () => require('../lib/cli/service-guard.js');

function tmp(t, prefisso = 'nc-sg-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefisso));
  t.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });
  return d;
}

function mondo(t) {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, '.nexuscrew'), { mode: 0o700 });
  return { home, pidPath: path.join(home, '.nexuscrew', 'nexuscrew.pid') };
}

const GUARD_IMPL = { flockPath: FLOCK, waitSec: '0.3' };

// Child that runs `serve` for real (guard, pid file, server seam).
function scriviFiglio(dir) {
  const file = path.join(dir, 'serve-child.js');
  fs.writeFileSync(file, `
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const commands = require(${JSON.stringify(path.join(REPO, 'lib/cli/commands.js'))});
const caso = JSON.parse(process.env.CASO);
const pidImpl = {};
if (caso.vivoSempre) pidImpl.killImpl = () => true;
if (caso.senzaProc) { pidImpl.readProcessStartImpl = () => null; pidImpl.readCmdlineImpl = () => ''; pidImpl.bootIdImpl = () => null; }
const opts = {
  home: caso.home, platform: 'termux', pidfile: caso.pidfile !== false, port: 41999,
  chdirImpl: () => {}, ensureFleetDefaultsImpl: () => ({}),
  guardImpl: { flockPath: ${JSON.stringify(FLOCK)}, waitSec: '0.3' },
  pidImpl,
  serverStart: () => {
    fs.writeFileSync(caso.marker, String(process.pid));
    if (caso.figlio) {
      const f = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
      f.unref();
      fs.writeFileSync(caso.figlio, String(f.pid));
    }
    process.stdout.write('STARTED\\n');
    setInterval(() => {}, 1000);
  },
};
try {
  commands.serve(opts);
} catch (e) {
  process.stdout.write('ERR ' + (e && e.code ? e.code : 'none') + ' ' + String(e && e.message).slice(0, 120) + '\\n');
  process.exit(3);
}
`);
  return file;
}

function avvia(t, script, caso, { attendi = 'line' } = {}) {
  const figlio = spawn(process.execPath, [script], {
    env: { ...process.env, CASO: JSON.stringify(caso), NEXUSCREW_PIDFILE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { figlio.kill('SIGKILL'); } catch (_) {} });
  let out = '';
  figlio.stdout.on('data', (d) => { out += d; });
  const prima = new Promise((resolve) => {
    const check = () => { if (out.includes('\n')) resolve(out.trim()); };
    figlio.stdout.on('data', check);
    figlio.on('exit', () => resolve(out.trim() || 'EXIT'));
  });
  return { figlio, esito: prima, out: () => out, attendi };
}

function uccidi(figlio) {
  return new Promise((resolve) => {
    if (figlio.exitCode !== null || figlio.signalCode) return resolve();
    figlio.once('exit', () => resolve());
    figlio.kill('SIGKILL');
  });
}

// --------------------------------------------------------------- the guard

test('guard: a held lock is busy for another process until the holder closes it or dies', async (t) => {
  const { pidPath } = mondo(t);
  const g = guardMod().acquireGuard(pidPath, GUARD_IMPL);
  assert.equal(g.ok, true, JSON.stringify(g));
  const dir = `${pidPath}.guard`;
  assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(path.join(dir, 'lock')).mode & 0o777, 0o600);
  const tenta = () => spawnSync(process.execPath, ['-e', `
    const g = require(${JSON.stringify(path.join(REPO, 'lib/cli/service-guard.js'))}).acquireGuard(${JSON.stringify(pidPath)}, ${JSON.stringify(GUARD_IMPL)});
    process.stdout.write(g.ok ? 'OK' : g.code);
  `], { encoding: 'utf8', timeout: 10000 });
  // The transient flock command has exited long ago: the lock lives in the
  // holder's descriptor.
  assert.equal(tenta().stdout, 'GUARD_BUSY');
  fs.closeSync(g.fd);
  assert.equal(tenta().stdout, 'OK');
});

test('guard: SIGKILL of the holder releases the lock without any cleanup', { timeout: 20000 }, async (t) => {
  const { pidPath } = mondo(t);
  const figlio = spawn(process.execPath, ['-e', `
    const g = require(${JSON.stringify(path.join(REPO, 'lib/cli/service-guard.js'))}).acquireGuard(${JSON.stringify(pidPath)}, ${JSON.stringify(GUARD_IMPL)});
    process.stdout.write(g.ok ? 'HELD\\n' : 'NO\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { figlio.kill('SIGKILL'); } catch (_) {} });
  await new Promise((resolve) => { figlio.stdout.once('data', resolve); figlio.once('exit', resolve); });
  const busy = guardMod().acquireGuard(pidPath, GUARD_IMPL);
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'GUARD_BUSY');
  await uccidi(figlio);
  const libero = guardMod().acquireGuard(pidPath, GUARD_IMPL);
  assert.equal(libero.ok, true, JSON.stringify(libero));
  fs.closeSync(libero.fd);
});

test('guard: missing, non-executable or failing flock refuses explicitly', (t) => {
  const { pidPath } = mondo(t);
  const d = tmp(t);
  const rotto = path.join(d, 'flock');
  fs.writeFileSync(rotto, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const nonEseguibile = path.join(d, 'flock-noexec');
  fs.writeFileSync(nonEseguibile, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  for (const flockPath of [path.join(d, 'absent'), rotto, nonEseguibile]) {
    const g = guardMod().acquireGuard(pidPath, { flockPath, waitSec: '0.3' });
    assert.equal(g.ok, false);
    assert.equal(g.code, 'GUARD_UNAVAILABLE');
  }
});

test('guard: a pre-existing unsafe guard directory or a symlinked lock is refused and not repaired', (t) => {
  const { pidPath } = mondo(t);
  const dir = `${pidPath}.guard`;
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  let g = guardMod().acquireGuard(pidPath, GUARD_IMPL);
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
  assert.equal(fs.lstatSync(dir).mode & 0o777, 0o755, 'no chmod of a pre-existing directory');
  fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'real'), '');
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'lock'));
  g = guardMod().acquireGuard(pidPath, GUARD_IMPL);
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
});

// -------------------------------------------------------- inspection matrix

function scrivi(p, meta) { fs.writeFileSync(p, `${JSON.stringify(meta)}\n`, { mode: 0o600 }); }
const kill = (esito) => () => {
  if (esito === true) return true;
  const e = new Error(esito); e.code = esito; throw e;
};

test('inspect: absent, invalid and oversize records are told apart from stale', (t) => {
  const { pidPath } = mondo(t);
  assert.equal(pidf.inspectPidfile(pidPath).state, 'absent');
  fs.writeFileSync(pidPath, '{"pid": 12');
  assert.equal(pidf.inspectPidfile(pidPath).state, 'invalid');
  fs.writeFileSync(pidPath, 'x'.repeat(70000));
  assert.equal(pidf.inspectPidfile(pidPath).state, 'invalid');
  fs.rmSync(pidPath);
  fs.mkdirSync(pidPath);
  assert.equal(pidf.inspectPidfile(pidPath).state, 'invalid');
  fs.rmdirSync(pidPath);
  fs.symlinkSync('/etc/hostname', pidPath);
  assert.equal(pidf.inspectPidfile(pidPath).state, 'invalid');
});

test('inspect: evidence matrix', (t) => {
  const { pidPath } = mondo(t);
  const base = { pid: 4242, cmd: 'node x serve', startTs: 1 };
  const ins = (meta, impl) => { scrivi(pidPath, meta); return pidf.inspectPidfile(pidPath, impl); };
  // ESRCH proves the pid is gone.
  assert.equal(ins({ ...base, processStart: 'linux:100' }, { killImpl: kill('ESRCH') }).state, 'stale');
  // Same birth: the very same process.
  assert.equal(ins({ ...base, processStart: 'linux:100' }, { killImpl: kill(true), readProcessStartImpl: () => 'linux:100' }).state, 'alive');
  // Different readable birth of the same kind: pid reuse.
  assert.equal(ins({ ...base, processStart: 'linux:100' }, { killImpl: kill(true), readProcessStartImpl: () => 'linux:999' }).state, 'stale');
  // Birth unreadable now: not a proof of death.
  assert.equal(ins({ ...base, processStart: 'linux:100' }, { killImpl: kill(true), readProcessStartImpl: () => null }).state, 'indeterminate');
  // Two probe formats are not comparable.
  assert.equal(ins({ ...base, processStart: 'linux:100' }, { killImpl: kill(true), readProcessStartImpl: () => 'ps:Mon Jan  1 00:00:00 2024' }).state, 'indeterminate');
  // EPERM and generic errors are never ESRCH.
  assert.equal(ins({ ...base, processStart: 'linux:100' }, { killImpl: kill('EPERM') }).state, 'indeterminate');
  assert.equal(ins({ ...base, processStart: 'linux:100' }, { killImpl: kill('EIO') }).state, 'indeterminate');
  // Legacy record without any attestation, pid alive, nothing readable.
  const noProc = { killImpl: kill(true), readProcessStartImpl: () => null, readCmdlineImpl: () => '', bootIdImpl: () => null };
  assert.equal(ins({ ...base, attestation: 'indeterminate' }, noProc).state, 'indeterminate');
  assert.equal(ins({ ...base }, noProc).state, 'indeterminate');
  // A cmd mismatch alone does not prove death, and a match does not prove identity.
  assert.equal(ins({ ...base }, { ...noProc, readCmdlineImpl: () => 'something else' }).state, 'indeterminate');
  assert.equal(ins({ ...base }, { ...noProc, readCmdlineImpl: () => 'node x serve' }).state, 'indeterminate');
  // A different kernel boot id recorded by the trusted writer proves a reboot.
  const boot = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const altro = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  assert.equal(ins({ ...base, bootId: boot }, { ...noProc, bootIdImpl: () => altro }).state, 'stale');
  assert.equal(ins({ ...base, bootId: boot }, { ...noProc, bootIdImpl: () => boot }).state, 'indeterminate', 'same boot does not prove the same birth');
  assert.equal(ins({ ...base, bootId: boot }, { ...noProc, bootIdImpl: () => null }).state, 'indeterminate');
  assert.equal(ins({ ...base, bootId: 'not-a-uuid' }, { ...noProc, bootIdImpl: () => altro }).state, 'indeterminate');
});

test('inspect: the guard proof needs a v1 record whose dev/ino equal the lock just acquired', (t) => {
  const { pidPath } = mondo(t);
  const g = guardMod().acquireGuard(pidPath, GUARD_IMPL);
  assert.equal(g.ok, true);
  t.after(() => { try { fs.closeSync(g.fd); } catch (_) {} });
  const noProc = { killImpl: kill(true), readProcessStartImpl: () => null, readCmdlineImpl: () => '', bootIdImpl: () => null, guard: { dev: g.dev, ino: g.ino } };
  const base = { pid: 4242, cmd: 'c', startTs: 1, attestation: 'indeterminate' };
  const ins = (meta) => { scrivi(pidPath, meta); return pidf.inspectPidfile(pidPath, noProc).state; };
  assert.equal(ins({ ...base, serviceGuard: { v: 1, dev: g.dev, ino: g.ino } }), 'stale');
  assert.equal(ins({ ...base, serviceGuard: { v: 1, dev: g.dev, ino: g.ino + 1 } }), 'indeterminate');
  assert.equal(ins({ ...base, serviceGuard: { v: 2, dev: g.dev, ino: g.ino } }), 'indeterminate');
  assert.equal(ins({ ...base }), 'indeterminate');
});

// ------------------------------------------------------------- the record

test('record: extra cannot set the reserved service fields, the trusted values win', (t) => {
  const { pidPath } = mondo(t);
  pidf.writePidfile(pidPath, process.pid, 'c', {
    bootId: 'forged', serviceRunId: 'forged', serviceGuard: { v: 1, dev: 1, ino: 1 }, port: 1234,
  });
  let meta = pidf.readPidfile(pidPath);
  assert.equal(meta.bootId, undefined);
  assert.equal(meta.serviceRunId, undefined);
  assert.equal(meta.serviceGuard, undefined);
  assert.equal(meta.port, 1234);
  fs.rmSync(pidPath);
  pidf.writePidfile(pidPath, process.pid, 'c', { serviceRunId: 'forged' }, {
    serviceRunId: 'a'.repeat(32), serviceGuard: { v: 1, dev: 5, ino: 6 },
  });
  meta = pidf.readPidfile(pidPath);
  assert.equal(meta.serviceRunId, 'a'.repeat(32));
  assert.deepEqual(meta.serviceGuard, { v: 1, dev: 5, ino: 6 });
});

test('record: a delayed cleanup of an older generation never removes its successor', (t) => {
  const { pidPath } = mondo(t);
  pidf.writePidfile(pidPath, process.pid, 'c', {}, { serviceRunId: 'b'.repeat(32), serviceGuard: { v: 1, dev: 1, ino: 1 } });
  const prima = fs.readFileSync(pidPath);
  assert.equal(pidf.removeOwnPidfile(pidPath, 'a'.repeat(32)), false);
  assert.deepEqual(fs.readFileSync(pidPath), prima);
  assert.equal(pidf.removeOwnPidfile(pidPath, 'b'.repeat(32)), true);
  assert.equal(fs.existsSync(pidPath), false);
  // A replaced file (new inode, same run id text) is not removed on a mismatch of the id.
  fs.writeFileSync(pidPath, '{"pid":1}\n');
  assert.equal(pidf.removeOwnPidfile(pidPath, 'b'.repeat(32)), false);
  assert.equal(fs.existsSync(pidPath), true);
});

test('claim: an unexpected EEXIST at the final create is a conflict and the competitor is left alone', (t) => {
  const { pidPath } = mondo(t);
  let errore = null;
  try {
    guardMod().claimService({
      pidPath, cmd: 'c', port: 1, guardImpl: GUARD_IMPL,
      hooks: { beforeCreate: () => fs.writeFileSync(pidPath, '{"pid":999999,"competitor":true}\n', { mode: 0o600 }) },
    });
  } catch (e) { errore = e; }
  assert.ok(errore, 'must throw');
  assert.equal(errore.code, 'PIDFILE_CONFLICT');
  assert.match(fs.readFileSync(pidPath, 'utf8'), /competitor/);
});

test('claim: an invalid record is PIDFILE_INVALID, not a raw EEXIST, and stays intact', (t) => {
  const { pidPath } = mondo(t);
  fs.writeFileSync(pidPath, '{"pid": 12');
  let errore = null;
  try { guardMod().claimService({ pidPath, cmd: 'c', port: 1, guardImpl: GUARD_IMPL }); } catch (e) { errore = e; }
  assert.ok(errore);
  assert.equal(errore.code, 'PIDFILE_INVALID');
  assert.equal(fs.readFileSync(pidPath, 'utf8'), '{"pid": 12');
});

// ----------------------------------------------------------- real `serve`

test('serve: two real servers on one home, one starts and the other is busy without starting anything', { timeout: 30000 }, async (t) => {
  const { home, pidPath } = mondo(t);
  const dir = tmp(t);
  const script = scriviFiglio(dir);
  const m1 = path.join(dir, 'm1');
  const m2 = path.join(dir, 'm2');
  const a = avvia(t, script, { home, marker: m1 });
  assert.equal(await a.esito, 'STARTED');
  const antes = fs.readFileSync(pidPath, 'utf8');
  const b = avvia(t, script, { home, marker: m2 });
  const esito = await b.esito;
  assert.match(esito, /^ERR GUARD_BUSY/);
  assert.equal(fs.existsSync(m2), false, 'the loser must not start a server');
  assert.equal(fs.readFileSync(pidPath, 'utf8'), antes, 'the winner record is untouched');
  const meta = JSON.parse(antes);
  assert.match(meta.serviceRunId, /^[0-9a-f]{32}$/);
  assert.equal(meta.serviceGuard.v, 1);
  await uccidi(a.figlio);
});

test('serve: without --pidfile the guard still applies on this platform', { timeout: 30000 }, async (t) => {
  const { home, pidPath } = mondo(t);
  const dir = tmp(t);
  const script = scriviFiglio(dir);
  const a = avvia(t, script, { home, marker: path.join(dir, 'm1'), pidfile: false });
  assert.equal(await a.esito, 'STARTED');
  assert.equal(fs.existsSync(pidPath), true, 'the service records its pid file anyway');
  const b = avvia(t, script, { home, marker: path.join(dir, 'm2'), pidfile: false });
  assert.match(await b.esito, /^ERR GUARD_BUSY/);
  await uccidi(a.figlio);
});

test('serve: a crashed new-format service is recognised stale through the guard even if the pid looks alive and /proc is unreadable', { timeout: 30000 }, async (t) => {
  const { home, pidPath } = mondo(t);
  const dir = tmp(t);
  const script = scriviFiglio(dir);
  const a = avvia(t, script, { home, marker: path.join(dir, 'm1') });
  assert.equal(await a.esito, 'STARTED');
  const vecchio = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
  await uccidi(a.figlio);
  assert.equal(fs.existsSync(pidPath), true, 'a crash leaves the record behind');
  const b = avvia(t, script, { home, marker: path.join(dir, 'm2'), vivoSempre: true, senzaProc: true });
  assert.equal(await b.esito, 'STARTED');
  const nuovo = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
  assert.notEqual(nuovo.serviceRunId, vecchio.serviceRunId);
  await uccidi(b.figlio);
});

test('serve: a legacy record with a live-looking pid and nothing readable is refused untouched, with no signal and no server', { timeout: 30000 }, async (t) => {
  const { home, pidPath } = mondo(t);
  const dir = tmp(t);
  const script = scriviFiglio(dir);
  const esca = spawn('sleep', ['300'], { stdio: 'ignore' });
  t.after(() => { try { esca.kill('SIGKILL'); } catch (_) {} });
  scrivi(pidPath, { pid: esca.pid, cmd: 'node nexuscrew serve', startTs: 1, attestation: 'indeterminate' });
  const prima = fs.readFileSync(pidPath);
  const m = path.join(dir, 'm');
  const b = avvia(t, script, { home, marker: m, senzaProc: true });
  assert.match(await b.esito, /^ERR PIDFILE_UNVERIFIABLE/);
  assert.equal(fs.existsSync(m), false);
  assert.deepEqual(fs.readFileSync(pidPath), prima);
  assert.equal(esca.exitCode, null);
  assert.equal(esca.signalCode, null);
  assert.doesNotThrow(() => process.kill(esca.pid, 0), 'the lure must still be alive');
});

test('serve: a record whose guard is missing, of another version or of another inode gives no proof', { timeout: 30000 }, async (t) => {
  const { home, pidPath } = mondo(t);
  const dir = tmp(t);
  const script = scriviFiglio(dir);
  const a = avvia(t, script, { home, marker: path.join(dir, 'm1') });
  assert.equal(await a.esito, 'STARTED');
  const vero = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
  await uccidi(a.figlio);
  const varianti = [
    (m) => { delete m.serviceGuard; return m; },
    (m) => ({ ...m, serviceGuard: { ...m.serviceGuard, v: 2 } }),
    (m) => ({ ...m, serviceGuard: { ...m.serviceGuard, ino: m.serviceGuard.ino + 7 } }),
  ];
  for (const [i, v] of varianti.entries()) {
    scrivi(pidPath, v({ ...vero }));
    const prima = fs.readFileSync(pidPath);
    const m = path.join(dir, `mv${i}`);
    const b = avvia(t, script, { home, marker: m, vivoSempre: true, senzaProc: true });
    assert.match(await b.esito, /^ERR PIDFILE_UNVERIFIABLE/, `variant ${i}`);
    assert.equal(fs.existsSync(m), false);
    assert.deepEqual(fs.readFileSync(pidPath), prima);
  }
});

test('serve: a child of the service never keeps the guard after the service exits', { timeout: 30000 }, async (t) => {
  const { home } = mondo(t);
  const dir = tmp(t);
  const script = scriviFiglio(dir);
  const figlioPid = path.join(dir, 'child.pid');
  const a = avvia(t, script, { home, marker: path.join(dir, 'm1'), figlio: figlioPid });
  assert.equal(await a.esito, 'STARTED');
  const nipote = Number(fs.readFileSync(figlioPid, 'utf8'));
  t.after(() => { try { process.kill(nipote, 'SIGKILL'); } catch (_) {} });
  await uccidi(a.figlio);
  assert.doesNotThrow(() => process.kill(nipote, 0), 'the service child must still be alive');
  const pidPath = path.join(home, '.nexuscrew', 'nexuscrew.pid');
  const g = guardMod().acquireGuard(pidPath, GUARD_IMPL);
  assert.equal(g.ok, true, 'a surviving child must not hold the lock');
  fs.closeSync(g.fd);
});

// ------------------------------------------------------------- lifecycle

test('state read: an unverifiable record is neither stopped nor cleaned, and start does not clean before launching', (t) => {
  const { home, pidPath } = mondo(t);
  const { portableRuntimeState, start } = require('../lib/cli/runtime-lifecycle.js');
  scrivi(pidPath, { pid: process.pid, cmd: 'node nexuscrew serve', startTs: 1, attestation: 'indeterminate' });
  const prima = fs.readFileSync(pidPath);
  const impl = { killImpl: () => true, readProcessStartImpl: () => null, readCmdlineImpl: () => '', bootIdImpl: () => null };
  const s = portableRuntimeState({ home, platform: 'termux', pidImpl: impl });
  assert.notEqual(s.running, false, 'indeterminate is not stopped');
  assert.deepEqual(fs.readFileSync(pidPath), prima, 'a state read never removes the record');
  // A provably dead record is reported as stopped, still without touching it.
  scrivi(pidPath, { pid: 4242, cmd: 'c', startTs: 1, attestation: 'indeterminate' });
  const morto = portableRuntimeState({ home, platform: 'termux', pidImpl: { ...impl, killImpl: () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; } } });
  assert.equal(morto.running, false);
  assert.equal(fs.existsSync(pidPath), true);
  // start launches the service entry and leaves the judgement to it.
  let lanciato = null;
  const spawnImpl = (cmd, args) => { lanciato = { cmd, args }; return { pid: 1, unref() {}, on() {} }; };
  scrivi(pidPath, { pid: process.pid, cmd: 'node nexuscrew serve', startTs: 1, attestation: 'indeterminate' });
  const scritto = fs.readFileSync(pidPath);
  const r = start({ home, platform: 'termux', spawnImpl, log: () => {}, pidImpl: impl });
  assert.ok(lanciato, 'the service entry must be launched');
  assert.equal(r.started, true);
  assert.deepEqual(fs.readFileSync(pidPath), scritto, 'start never cleans the record');
});
