'use strict';
// U2: il restart dell'update dev'essere verificato sulla VERSIONE in esecuzione, non sul solo «la porta risponde».
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runner = require('../lib/update/runner.js');
const { restartRuntime } = runner;
const runUpdate = (o) => runner.runUpdate({ npmInvocationImpl: () => ({ kind: 'path-npm', bin: 'npm', argvPrefix: [], env: null, npmCli: null }), npmPreflightImpl: () => ({}), log: () => {}, ...o });
const core = require('../lib/update/core.js');

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-rv-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const liveMeta = { pid: process.pid };

function seams(dir, { commands: extraCommands = {}, ...over } = {}) {
  return {
    home: dir, platform: 'termux', port: 41820, token: 't', expectedVersion: '0.9.51',
    commands: {
      isServiceRunning: () => false,
      fermaTunnelPrimaDiRiavviare: () => {},
      stopPortableRuntime: () => ({ killed: true }),
      startPortable: () => ({ started: true }),
      portAvailable: async () => true,
      ...extraCommands,
    },
    pidfile: { defaultPidfilePath: () => path.join(dir, 'x.pid'), readPidfile: () => liveMeta, isAlive: () => true },
    waitForRuntimeImpl: async () => true,
    runtimeVersionImpl: async () => '0.9.51',
    ...over,
  };
}

test('U2 restart: startPortable «already running» con il processo ANCORA alla vecchia versione = errore, non successo', async (t) => {
  const dir = tmp(t);
  await assert.rejects(restartRuntime(seams(dir, {
    commands: { startPortable: () => ({ started: false, reason: 'already running' }) },
    runtimeVersionImpl: async () => '0.9.50',
  })), (e) => /already running/.test(e.message) && /0\.9\.50/.test(e.message));
});

test('U2 restart: startPortable {started:false} ma il processo e\' gia\' alla versione target = successo verificato', async (t) => {
  const dir = tmp(t);
  const mode = await restartRuntime(seams(dir, {
    commands: { startPortable: () => ({ started: false, reason: 'already running' }) },
    runtimeVersionImpl: async () => '0.9.51',
  }));
  assert.equal(mode, 'portable');
});

test('U2 restart: processo healthy ma alla versione sbagliata = errore (porta che risponde non basta)', async (t) => {
  const dir = tmp(t);
  await assert.rejects(restartRuntime(seams(dir, { runtimeVersionImpl: async () => '0.9.50' })), /0\.9\.50.*0\.9\.51|0\.9\.51.*0\.9\.50/);
});

test('U2 restart: versione non leggibile con expectedVersion = errore (non si presume)', async (t) => {
  const dir = tmp(t);
  await assert.rejects(restartRuntime(seams(dir, { runtimeVersionImpl: async () => null })), /versione/i);
});

test('U2 restart: senza expectedVersion il comportamento storico resta (nessuna verifica)', async (t) => {
  const dir = tmp(t);
  const mode = await restartRuntime(seams(dir, { expectedVersion: undefined, runtimeVersionImpl: async () => '0.0.1' }));
  assert.equal(mode, 'portable');
});

test('U2 runUpdate: il restart riceve la versione attesa (target in avanti, precedente nel rollback)', async (t) => {
  const dir = tmp(t); const seen = [];
  const statusPath = path.join(dir, '.nexuscrew', 'npm-update.json');
  let installed = '0.9.50';
  await assert.rejects(runUpdate({
    version: '0.9.51', home: dir, statusPath, cwd: dir,
    execImpl: (_c, a) => { installed = a.find((x) => x.startsWith('@mmmbuto/nexuscrew@')).split('@').pop(); },
    readInstalledVersion: () => installed, preflightImpl: async () => true, healBootImpl: () => ({}),
    restartImpl: async (o) => { seen.push(o.expectedVersion); if (seen.length === 1) throw new Error('versione errata'); return 'portable'; },
  }));
  assert.deepEqual(seen, ['0.9.51', '0.9.50']);
  assert.equal(core.readState(statusPath).blockedVersion, '0.9.51');
});
