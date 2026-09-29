'use strict';
// U2: freni contro il ciclo install -> restart -> reinstall. Registry finto, nessun npm/rete/kill, HOME temporanea.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNpmUpdater } = require('../lib/update/manager.js');
const core = require('../lib/update/core.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600 * 1000;
const mkhome = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-upg-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const statusOf = (home) => path.join(home, '.nexuscrew', 'npm-update.json');
const seedState = (home, state) => core.writeState(statusOf(home), state);

function updater(home, over = {}) {
  const spawned = [];
  const u = createNpmUpdater({
    currentVersion: '0.9.50', home, supported: true, useSystemdRun: false, enabled: true,
    initialDelayMs: 5, intervalMs: 6 * HOUR, lookupLatest: async () => '0.9.51',
    spawnImpl: (_bin, argv) => { spawned.push(argv); return { pid: process.pid, unref() {}, once() {} }; },
    ...over,
  });
  return { u, spawned };
}

test('U2 blocco: dopo un update «riuscito» la versione in esecuzione e\' diversa dal target -> versione bloccata, nessun nuovo install', async (t) => {
  const home = mkhome(t);
  seedState(home, { phase: 'installed', targetVersion: '0.9.51', current: '0.9.51', latest: '0.9.51', available: false });
  const { u, spawned } = updater(home); // il processo riavviato esegue ancora 0.9.50
  const st = u.status();
  assert.equal(st.blockedVersion, '0.9.51');
  assert.equal(st.phase, 'error');
  assert.match(st.lastError, /0\.9\.50.*0\.9\.51|0\.9\.51.*0\.9\.50/);
  await u.check({ autoApply: true });
  assert.equal(spawned.length, 0);
  u.close();
});

test('U2 blocco: se la versione in esecuzione E\' il target, nessun blocco (caso sano invariato)', (t) => {
  const home = mkhome(t);
  seedState(home, { phase: 'installed', targetVersion: '0.9.51', latest: '0.9.51' });
  const { u } = updater(home, { currentVersion: '0.9.51' });
  const st = u.status();
  assert.equal(st.blockedVersion, '');
  assert.equal(st.phase, 'idle');
  u.close();
});

test('U2 backoff: al massimo 2 install per versione ogni 24 h', async (t) => {
  const home = mkhome(t); const now = Date.now();
  seedState(home, { phase: 'idle', installs: { '0.9.51': [now - 30 * HOUR, now - 5 * HOUR, now - 2 * HOUR] } });
  const { u, spawned } = updater(home);
  await u.check({ autoApply: true });
  assert.equal(spawned.length, 0, 'due install nelle ultime 24 h: niente terzo');
  assert.match(u.status().lastError, /backoff/i);
  u.close();
});

test('U2 backoff: con un solo install recente l\'ultimo e\' vecchio abbastanza e si procede; il tentativo viene registrato', async (t) => {
  const home = mkhome(t); const now = Date.now();
  seedState(home, { phase: 'idle', installs: { '0.9.51': [now - 5 * HOUR] }, lastInstallAt: now - 5 * HOUR });
  const { u, spawned } = updater(home);
  await u.check({ autoApply: true });
  assert.equal(spawned.length, 1);
  const st = core.readState(statusOf(home));
  assert.equal(st.installs['0.9.51'].length, 2);
  assert.ok(Math.abs(st.lastInstallAt - Date.now()) < 5000);
  u.close();
});

test('U2 backoff: almeno 1 h fra due update, anche per versioni diverse', async (t) => {
  const home = mkhome(t); const now = Date.now();
  seedState(home, { phase: 'idle', installs: { '0.9.49': [now - 10 * 60 * 1000] }, lastInstallAt: now - 10 * 60 * 1000 });
  const { u, spawned } = updater(home);
  await u.check({ autoApply: true });
  assert.equal(spawned.length, 0);
  assert.match(u.status().lastError, /backoff/i);
  u.close();
});

test('U2 backoff: l\'apply manuale dell\'operatore non e\' frenato dal backoff (ma resta bloccato dal blocco versione)', async (t) => {
  const home = mkhome(t); const now = Date.now();
  seedState(home, { phase: 'idle', latest: '0.9.51', available: true, installs: { '0.9.51': [now - 1000, now - 2000] }, lastInstallAt: now - 1000 });
  const { u, spawned } = updater(home);
  await u.apply();
  assert.equal(spawned.length, 1);
  u.close();
});

test('U2 avvio: nessun check immediato a ogni avvio (ritardo = intervallo - eta\' di lastCheckedAt)', async (t) => {
  assert.equal(typeof core.initialCheckDelayMs, 'function');
  const now = 1_000_000_000_000;
  assert.equal(core.initialCheckDelayMs({ lastCheckedAt: new Date(now - 60_000).toISOString(), now, intervalMs: 6 * HOUR, initialDelayMs: 60_000 }), 6 * HOUR - 60_000);
  assert.equal(core.initialCheckDelayMs({ lastCheckedAt: new Date(now - 7 * HOUR).toISOString(), now, intervalMs: 6 * HOUR, initialDelayMs: 60_000 }), 60_000);
  assert.equal(core.initialCheckDelayMs({ lastCheckedAt: '', now, intervalMs: 6 * HOUR, initialDelayMs: 60_000 }), 60_000);
  assert.equal(core.initialCheckDelayMs({ lastCheckedAt: 'rotto', now, intervalMs: 6 * HOUR, initialDelayMs: 60_000 }), 60_000);
  assert.equal(core.initialCheckDelayMs({ lastCheckedAt: new Date(now + 3 * HOUR).toISOString(), now, intervalMs: 6 * HOUR, initialDelayMs: 60_000 }), 60_000, 'data nel futuro: non ci si fida');
  // integrazione: il «riavvio» un attimo dopo NON rifa il lookup
  const home = mkhome(t); let lookups = 0;
  const mk = () => updater(home, { intervalMs: 10_000, initialDelayMs: 5, lookupLatest: async () => { lookups += 1; return '0.9.50'; } }).u;
  const a = mk(); a.start(); await wait(150); a.close();
  assert.equal(lookups, 1);
  const b = mk(); b.start(); await wait(200); b.close();
  assert.equal(lookups, 1, 'il secondo avvio non ricontrolla subito');
});
