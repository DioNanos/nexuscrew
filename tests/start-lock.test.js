'use strict';
// U2: lock di avvio condiviso boot/show/start/runner — esclusivo, senza deadlock, con scadenza e proprietario verificato.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const lock = require('../lib/update/start-lock.js');

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sl-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const LIB = path.resolve(__dirname, '../lib/update/start-lock.js');

// Un altro PROCESSO che tiene il lock per holdMs (il lock e' rientrante nello stesso processo, quindi serve un figlio).
function holder(t, home, holdMs, label = 'figlio') {
  const child = spawn(process.execPath, ['-e', `
    const l = require(${JSON.stringify(LIB)});
    const h = l.acquireStartLock({ home: ${JSON.stringify(home)}, label: ${JSON.stringify(label)} });
    process.stdout.write('held\\n');
    setTimeout(() => { h.release(); process.exit(0); }, ${holdMs});
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} });
  return new Promise((resolve) => child.stdout.once('data', () => resolve(child)));
}

test('esclusivo: un secondo avviatore attende e poi passa', async (t) => {
  const home = tmp(t);
  await holder(t, home, 500);
  const t0 = Date.now();
  const h = lock.acquireStartLock({ home, waitMs: 5000 });
  assert.ok(Date.now() - t0 >= 300, 'ha atteso il rilascio');
  h.release();
  assert.equal(fs.existsSync(lock.lockPath(home)), false);
});

test('attesa limitata: errore chiaro con chi tiene il lock, mai attesa infinita', async (t) => {
  const home = tmp(t);
  await holder(t, home, 3000, 'runner-update');
  assert.throws(() => lock.acquireStartLock({ home, waitMs: 250 }), (e) => e.code === 'start-lock-timeout' && e.holder.label === 'runner-update' && /gia' in corso/.test(e.message));
});

test('proprietario morto: lock orfano ripreso subito', async (t) => {
  const home = tmp(t);
  const dead = spawn(process.execPath, ['-e', '0']); await new Promise((r) => dead.on('exit', r));
  fs.mkdirSync(path.dirname(lock.lockPath(home)), { recursive: true });
  fs.writeFileSync(lock.lockPath(home), JSON.stringify({ pid: dead.pid, token: 'orfano', createdAt: Date.now() }));
  const t0 = Date.now();
  const h = lock.acquireStartLock({ home, waitMs: 2000 }); h.release();
  assert.ok(Date.now() - t0 < 1000);
});

test('scadenza: un lock vecchio oltre il TTL si riprende anche con il proprietario vivo', async (t) => {
  const home = tmp(t);
  await holder(t, home, 4000);
  const cur = lock.readLock(lock.lockPath(home));
  fs.writeFileSync(lock.lockPath(home), JSON.stringify({ ...cur, createdAt: Date.now() - 10 * 60 * 1000 }));
  const t0 = Date.now();
  const h = lock.acquireStartLock({ home, ttlMs: 60000, waitMs: 2000 }); h.release();
  assert.ok(Date.now() - t0 < 1000);
});

test('proprietario verificato: pid vivo ma nascita diversa (pid riassegnato) = lock orfano', async (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.dirname(lock.lockPath(home)), { recursive: true });
  fs.writeFileSync(lock.lockPath(home), JSON.stringify({ pid: process.pid + 0, token: 'x', createdAt: Date.now(), processStart: 'linux:1' }));
  // stesso pid del test ma nascita registrata falsa: la lettura dal vivo dice altro
  const meta = lock.readLock(lock.lockPath(home));
  assert.equal(lock.isStale(meta, Date.now(), 60000, { readProcessStartImpl: () => 'linux:999999' }), true);
  assert.equal(lock.isStale({ ...meta, processStart: 'linux:5' }, Date.now(), 60000, { readProcessStartImpl: () => 'linux:5' }), false);
});

test('rientrante nello stesso processo: nessun deadlock e il file sparisce solo all\'ultimo rilascio', (t) => {
  const home = tmp(t);
  const out = lock.withStartLock(() => lock.withStartLock(() => {
    assert.equal(fs.existsSync(lock.lockPath(home)), true);
    return 'dentro';
  }, { home, waitMs: 100 }), { home, waitMs: 100 });
  assert.equal(out, 'dentro');
  assert.equal(fs.existsSync(lock.lockPath(home)), false);
});

test('rilascia solo il proprio token: un lock ripreso da altri non viene cancellato dal vecchio proprietario', (t) => {
  const home = tmp(t);
  const h = lock.acquireStartLock({ home });
  fs.writeFileSync(lock.lockPath(home), JSON.stringify({ pid: process.pid, token: 'altro', createdAt: Date.now() }));
  h.release();
  assert.equal(lock.readLock(lock.lockPath(home)).token, 'altro');
});

test('lock corrotto o non regolare: ripreso, non blocca per sempre', (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.dirname(lock.lockPath(home)), { recursive: true });
  fs.writeFileSync(lock.lockPath(home), '{non json');
  const h = lock.acquireStartLock({ home, waitMs: 1000 }); h.release();
});
