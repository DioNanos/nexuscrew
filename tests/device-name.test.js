'use strict';
// tests/device-name.test.js — nome di questo dispositivo.
// Contratto nuovo: deviceName è PERSISTITO in config.json (chiave ammessa da
// POST /api/settings/config, validazione label 1-64); senza valore salvato il
// nome viene dall'hostname SOLO se significativo; hostname vuoto/«localhost»
// (Termux/Android) NON retrocede più al generico «NexusCrew»: la GET espone
// deviceNameNeeded perché la UI chieda il nome, con eventuale suggerimento
// modello. I peer già appaiati non vengono toccati: solo nuovi valori.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

function boot(t, over = {}, seams = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdev-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir,
    configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    settingsSeams: {
      platform: 'linux',
      uid: 1000,
      execImpl: () => { throw new Error('exec disabled in test'); },
      serviceInstallPath: path.join(dir, 'systemd', 'nexuscrew.service'),
      ...seams,
    },
    ...over,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, token, ...paths });
  }));
}

async function getSettings(env) {
  return (await fetch(`${env.base}/api/settings`, { headers: H(env.token) })).json();
}

test('hostname significativo: usato come deviceName, nessuna domanda', async (t) => {
  const env = await boot(t, {}, { hostname: () => 'mynode' });
  const s = await getSettings(env);
  assert.equal(s.deviceName, 'mynode');
  assert.equal(s.deviceNameNeeded, false);
  assert.equal(s.deviceNameSuggestion, null);
});

test('hostname «localhost» (Termux): NESSUN «NexusCrew» generico, serve il nome', async (t) => {
  const env = await boot(t, {}, { hostname: () => 'localhost' });
  const s = await getSettings(env);
  assert.equal(s.deviceName, '');
  assert.equal(s.deviceNameNeeded, true);
  // il fallback silenzioso è vietato: da nessuna parte del payload
  assert.ok(!JSON.stringify(s).includes('NexusCrew'));
});

test('hostname vuoto: stesso contratto di localhost', async (t) => {
  const env = await boot(t, {}, { hostname: () => '' });
  const s = await getSettings(env);
  assert.equal(s.deviceName, '');
  assert.equal(s.deviceNameNeeded, true);
});

test('suggerimento modello dispositivo solo quando serve il nome', async (t) => {
  const model = 'Pixel 9 Pro';
  const needed = await boot(t, {}, { hostname: () => 'localhost', deviceModel: () => model });
  const sNeeded = await getSettings(needed);
  assert.equal(sNeeded.deviceNameSuggestion, model);
  assert.equal(sNeeded.deviceNameNeeded, true);

  const fine = await boot(t, {}, { hostname: () => 'mynode', deviceModel: () => model });
  const sFine = await getSettings(fine);
  assert.equal(sFine.deviceNameSuggestion, null);
});

test('deviceName salvato: accettato dalla POST, persiste su file e sopravvive al riavvio', async (t) => {
  const env = await boot(t, {}, { hostname: () => 'localhost' });
  nodesStore.atomicWriteStore(env.nodesPath, nodesStore.emptyStore('e'.repeat(32)));
  const r = await fetch(`${env.base}/api/settings/config`, {
    method: 'POST', headers: H(env.token), body: JSON.stringify({ deviceName: 'Pixel 9 Pro' }),
  });
  assert.equal(r.status, 200);
  // persistito davvero su config.json
  const onDisk = JSON.parse(fs.readFileSync(env.configPath, 'utf8'));
  assert.equal(onDisk.deviceName, 'Pixel 9 Pro');
  // e la GET sullo stesso processo lo usa, senza domanda
  const s = await getSettings(env);
  assert.equal(s.deviceName, 'Pixel 9 Pro');
  assert.equal(s.deviceNameNeeded, false);
  // «riavvio»: secondo server sulle STESSE paths rilegge il nome dal file
  const restarted = await boot(t, { ...envPaths(env) }, { hostname: () => 'localhost' });
  const s2 = await getSettings(restarted);
  assert.equal(s2.deviceName, 'Pixel 9 Pro');
  assert.equal(s2.deviceNameNeeded, false);
  // la route suggerita ai NUOVI pairing deriva dal nome (slug pixel-9-pro-eeee)
  assert.equal(s2.localName, 'pixel-9-pro-eeee');
});

test('deviceName salvato vince anche su hostname significativo', async (t) => {
  const env = await boot(t, {}, { hostname: () => 'mynode' });
  const r = await fetch(`${env.base}/api/settings/config`, {
    method: 'POST', headers: H(env.token), body: JSON.stringify({ deviceName: 'Il mio pixel' }),
  });
  assert.equal(r.status, 200);
  assert.equal((await getSettings(env)).deviceName, 'Il mio pixel');
});

test('validazione deviceName: vuoto, troppo lungo, control char, non stringa', async (t) => {
  const env = await boot(t, {}, { hostname: () => 'mynode' });
  for (const bad of ['', '   ', 'x'.repeat(65), 'riga\nnuova', 42]) {
    const r = await fetch(`${env.base}/api/settings/config`, {
      method: 'POST', headers: H(env.token), body: JSON.stringify({ deviceName: bad }),
    });
    assert.equal(r.status, 400, `atteso 400 per ${JSON.stringify(bad)}`);
  }
  // confine valido: 64 char passano
  const r = await fetch(`${env.base}/api/settings/config`, {
    method: 'POST', headers: H(env.token), body: JSON.stringify({ deviceName: 'y'.repeat(64) }),
  });
  assert.equal(r.status, 200);
});

test('peer esistenti invariati: la POST deviceName non tocca nodes.json', async (t) => {
  const env = await boot(t, {}, { hostname: () => 'mynode' });
  const before = fs.readFileSync(env.nodesPath, 'utf8');
  await fetch(`${env.base}/api/settings/config`, {
    method: 'POST', headers: H(env.token), body: JSON.stringify({ deviceName: 'Pixel 9 Pro' }),
  });
  assert.equal(fs.readFileSync(env.nodesPath, 'utf8'), before);
});

// riavvia un secondo server sulle stesse paths del primo (cleanup già registrato dal primo boot)
function envPaths(env) {
  return {
    home: env.home, configDir: env.configDir, configPath: env.configPath,
    nodesPath: env.nodesPath, tokenPath: env.tokenPath,
  };
}
