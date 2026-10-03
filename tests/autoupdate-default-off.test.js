'use strict';
// tests/autoupdate-default-off.test.js — autoUpdate SPENTO di default (chiave
// assente = false). Si accende solo con un `true` esplicito (Impostazioni o
// `nexuscrew autoupdate on`). Nessun writer aggiunge la chiave se e' assente.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { baseDefaults, loadConfig } = require('../lib/config.js');
const { createServer } = require('../lib/server.js');
const { dispatch } = require('../lib/cli/commands.js');
const nodesStore = require('../lib/nodes/store.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

// L'harness isolato esporta NEXUSCREW_AUTO_UPDATE=0: l'env vince sul file, quindi
// va tolto per misurare il comportamento della CONFIGURAZIONE.
function withoutAutoUpdateEnv(fn) {
  const prev = process.env.NEXUSCREW_AUTO_UPDATE;
  delete process.env.NEXUSCREW_AUTO_UPDATE;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.NEXUSCREW_AUTO_UPDATE;
    else process.env.NEXUSCREW_AUTO_UPDATE = prev;
  }
}

function withConfigFile(content, fn) {
  const tmp = path.join(os.tmpdir(), `nc-au-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  if (content !== null) fs.writeFileSync(tmp, JSON.stringify(content));
  const prevFile = process.env.NEXUSCREW_CONFIG_FILE;
  process.env.NEXUSCREW_CONFIG_FILE = tmp;
  try { return withoutAutoUpdateEnv(() => fn(tmp)); } finally {
    if (prevFile === undefined) delete process.env.NEXUSCREW_CONFIG_FILE;
    else process.env.NEXUSCREW_CONFIG_FILE = prevFile;
    fs.rmSync(tmp, { force: true });
  }
}

async function boot(t, cfgOver = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncau-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 41999, wizardDone: true, ...cfgOver }));
  const nodesPath = path.join(configDir, 'nodes.json');
  nodesStore.initStore(nodesPath);
  const settingsSeams = {
    platform: 'linux', uid: 1000,
    execImpl: () => { throw new Error('exec disabled in test'); },
    keygen: (_kp, name) => `ssh-ed25519 AAAAC3FAKEKEY nexuscrew-tunnel-${name}`,
    spawnImpl: () => ({ pid: 4193999, unref() {} }),
    sshVersion: () => ({ major: 9, minor: 6 }),
  };
  const prevFile = process.env.NEXUSCREW_CONFIG_FILE;
  const prevAu = process.env.NEXUSCREW_AUTO_UPDATE;
  process.env.NEXUSCREW_CONFIG_FILE = configPath; // loadConfig() del server legge da qui
  delete process.env.NEXUSCREW_AUTO_UPDATE;
  const restore = () => {
    if (prevFile === undefined) delete process.env.NEXUSCREW_CONFIG_FILE; else process.env.NEXUSCREW_CONFIG_FILE = prevFile;
    if (prevAu === undefined) delete process.env.NEXUSCREW_AUTO_UPDATE; else process.env.NEXUSCREW_AUTO_UPDATE = prevAu;
  };
  const { server, token, watcher } = createServer({
    home: dir, configDir, configPath, nodesPath, tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(dir, 'files'), port: 41999, fleetEnabled: false, settingsSeams,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); restore(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, token, configPath });
  }));
}

test('autoUpdate: default spento (chiave assente = false), true esplicito = acceso', () => {
  assert.equal(baseDefaults().autoUpdate, false, 'default sorgente spento');
  withConfigFile({ port: 41820 }, () => assert.equal(loadConfig().autoUpdate, false, 'assente -> spento'));
  withConfigFile({ autoUpdate: true }, () => assert.equal(loadConfig().autoUpdate, true, 'true -> acceso'));
  withConfigFile({ autoUpdate: false }, () => assert.equal(loadConfig().autoUpdate, false, 'false -> spento'));
});

test('autoUpdate: GET Impostazioni spento con chiave assente, e nessun writer la aggiunge', async (t) => {
  const { base, token, configPath } = await boot(t); // config senza autoUpdate
  const s = await (await fetch(`${base}/api/settings`, { headers: H(token) })).json();
  assert.equal(s.autoUpdate, false, 'GET Impostazioni: assente -> spento');

  // Un writer che salva un'ALTRA chiave non deve iniettare autoUpdate.
  const r = await fetch(`${base}/api/settings/config`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ wizardDone: true }),
  });
  assert.equal(r.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'autoUpdate'), false, 'la chiave resta assente su disco');
});

test('autoUpdate: la CLI dice off con la chiave assente (servizio non attivo)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncau-cli-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ port: 41999 }));
  const logs = [];
  const prevFile = process.env.NEXUSCREW_CONFIG_FILE;
  delete process.env.NEXUSCREW_AUTO_UPDATE;
  try {
    dispatch(['autoupdate', 'status'], { home: dir, isServiceRunningImpl: () => false, log: (m) => logs.push(String(m)) });
  } finally {
    if (prevFile === undefined) delete process.env.NEXUSCREW_CONFIG_FILE;
    else process.env.NEXUSCREW_CONFIG_FILE = prevFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.match(logs.join('\n'), /autoupdate: off/, 'CLI: assente -> off');
});

test('autoUpdate: GET Impostazioni acceso solo con true esplicito nel file', async (t) => {
  const on = await boot(t, { autoUpdate: true });
  assert.equal((await (await fetch(`${on.base}/api/settings`, { headers: H(on.token) })).json()).autoUpdate, true);
  const off = await boot(t, { autoUpdate: false });
  assert.equal((await (await fetch(`${off.base}/api/settings`, { headers: H(off.token) })).json()).autoUpdate, false);
});
