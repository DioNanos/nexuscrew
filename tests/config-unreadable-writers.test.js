'use strict';
// tests/config-unreadable-writers.test.js — i quattro scrittori di config.json
// che, con un file PRESENTE ma illeggibile, ripartivano da `{}` e perdevano le
// chiavi dell'operatore (autoUpdate compreso, che cosi' tornava a true da solo).
//
// Regola unica (la stessa di init, via `readConfigForWrite`):
//   - file assente  -> si parte da zero (legittimo);
//   - file leggibile -> merge come sempre;
//   - file illeggibile -> NESSUNA scrittura, errore esplicito col solo percorso
//     e un motivo categorico (`parse-error`, `not-object`, `read-error:<code>`).
// Mai il messaggio del parser: su Node recenti contiene un estratto del file,
// cioe' contenuto della config, e finirebbe in risposte HTTP e log.
//
// I quattro percorsi: Settings POST /config, POST /ai-desktop, CLI
// `autoupdate off`, provisioning dell'identity authority.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { dispatch } = require('../lib/cli/commands.js');
const { provisionIdentityAuthority, defaultAuthorityDir } = require('../lib/fleet/identity-provision.js');
const { readConfigForWrite } = require('../lib/config.js');

const SENTINELLA = 'S3CR3T';
// Config malformata che SUL CODICE PRECEDENTE faceva uscire il valore intero
// nell'errore del parser (valore senza virgolette, corto: l'estratto lo
// contiene tutto). E' la sentinella che non deve trapelare.
const CONFIG_ROTTA = `{"port":41820,"tok":${SENTINELLA}}`;
const CONFIG_VALIDA = '{\n  "port": 41820,\n  "autoUpdate": false,\n  "wizardDone": true\n}\n';
const MOTIVI = /^(parse-error|not-object|read-error(?::[A-Z]+)?)$/;
const PAROLE_DEL_PARSER = /Unexpected|Expected|position|column|is not valid JSON/i;

function configRotta(home) {
  const dir = path.join(home, '.nexuscrew');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, CONFIG_ROTTA, { mode: 0o600 });
  return p;
}

function configValida(home) {
  const dir = path.join(home, '.nexuscrew');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, CONFIG_VALIDA, { mode: 0o600 });
  return p;
}

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cfgw-')); }

// --- helper condiviso --------------------------------------------------------

test('readConfigForWrite: assente, valida, rotta, non-oggetto', () => {
  const home = tmpHome();
  const p = path.join(home, 'config.json');
  assert.deepEqual(readConfigForWrite(p), { ok: true, cfg: {} }, 'assente -> si parte da zero');
  fs.writeFileSync(p, CONFIG_VALIDA);
  const ok = readConfigForWrite(p);
  assert.equal(ok.ok, true);
  assert.equal(ok.cfg.autoUpdate, false);
  fs.writeFileSync(p, CONFIG_ROTTA);
  const rotta = readConfigForWrite(p);
  assert.equal(rotta.ok, false);
  assert.equal(rotta.motivo, 'parse-error');
  assert.equal(rotta.path, p, 'il motivo porta il percorso, non il contenuto');
  fs.writeFileSync(p, 'null');
  assert.equal(readConfigForWrite(p).motivo, 'not-object');
  fs.rmSync(home, { recursive: true, force: true });
});

// --- Settings: POST /config e POST /ai-desktop --------------------------------

function boot(t, home) {
  const configDir = path.join(home, '.nexuscrew');
  const paths = {
    home, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const settingsSeams = {
    platform: 'linux', uid: 1000,
    execImpl: () => { throw new Error('exec disabled in test'); },
    serviceInstallPath: path.join(home, 'systemd', 'nexuscrew.service'),
    keygen: () => 'ssh-ed25519 AAAAC3FAKEKEY',
    spawnImpl: () => ({ pid: 4193999, unref() {} }),
    sshVersion: () => ({ major: 9, minor: 6 }),
  };
  const { server, token, watcher } = createServer({
    ...paths, filesRoot: path.join(home, 'files'), port: 41999,
    fleetEnabled: false, settingsSeams,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); });
    res({ base: `http://127.0.0.1:${server.address().port}`, token });
  }));
}

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('Settings POST /config: config illeggibile -> 409, nessuna scrittura, sentinella mai in risposta', async (t) => {
  const home = tmpHome();
  const p = configRotta(home);
  const prima = fs.readFileSync(p);
  const { base, token } = await boot(t, home);

  const r = await fetch(`${base}/api/settings/config`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ autoUpdate: false }),
  });
  const testo = await r.text();

  assert.equal(r.status, 409, 'un 200 qui sarebbe un finto successo su chiavi cancellate');
  assert.equal(JSON.parse(testo).error, 'config-unreadable');
  assert.ok(MOTIVI.test(JSON.parse(testo).reason), `motivo categorico, visto: ${JSON.parse(testo).reason}`);
  assert.ok(!testo.includes(SENTINELLA), 'il contenuto non deve finire nella risposta');
  assert.ok(!PAROLE_DEL_PARSER.test(testo), `niente testo del parser: ${testo}`);
  assert.ok(fs.readFileSync(p).equals(prima), 'il file resta byte-identico');
  fs.rmSync(home, { recursive: true, force: true });
});

test('Settings POST /config: con config VALIDA il merge resta invariato', async (t) => {
  const home = tmpHome();
  const p = configValida(home);
  const { base, token } = await boot(t, home);
  const r = await fetch(`${base}/api/settings/config`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ autoUpdate: true }),
  });
  assert.equal(r.status, 200);
  const dopo = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(dopo.autoUpdate, true, 'la chiave richiesta si applica');
  assert.equal(dopo.wizardDone, true, 'e le altre restano');
  fs.rmSync(home, { recursive: true, force: true });
});

test('Settings POST /ai-desktop: config illeggibile -> 409, nessuna scrittura', async (t) => {
  const home = tmpHome();
  const p = configRotta(home);
  const prima = fs.readFileSync(p);
  const { base, token } = await boot(t, home);

  const r = await fetch(`${base}/api/settings/ai-desktop`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ enabled: true }),
  });
  const testo = await r.text();
  assert.equal(r.status, 409);
  assert.equal(JSON.parse(testo).error, 'config-unreadable');
  assert.ok(!testo.includes(SENTINELLA));
  assert.ok(fs.readFileSync(p).equals(prima));
  fs.rmSync(home, { recursive: true, force: true });
});

// --- CLI: autoupdate off ------------------------------------------------------

test('CLI autoupdate off: config illeggibile -> esce in errore e non scrive', async () => {
  const home = tmpHome();
  const p = configRotta(home);
  const prima = fs.readFileSync(p);
  const log = [];
  const r = await dispatch(['autoupdate', 'off'], {
    home, configPath: p, log: (m) => log.push(String(m)),
    isServiceRunningImpl: () => false,   // nessun systemd reale
  });
  const uscita = log.join('\n');
  assert.equal(r.code, 1, 'deve dichiarare il fallimento, non dire «scritto»');
  assert.ok(!uscita.includes(SENTINELLA), `il contenuto non deve finire nel log: ${uscita}`);
  assert.ok(PAROLE_DEL_PARSER.test(uscita) === false, `niente testo del parser: ${uscita}`);
  assert.ok(/illeggibile/.test(uscita) && uscita.includes(p), 'il messaggio nomina il file');
  assert.ok(fs.readFileSync(p).equals(prima), 'il file resta byte-identico');
  fs.rmSync(home, { recursive: true, force: true });
});

test('CLI autoupdate off: con config VALIDA scrive solo la sua chiave', async () => {
  const home = tmpHome();
  const p = configValida(home);
  const log = [];
  const r = await dispatch(['autoupdate', 'off'], {
    home, configPath: p, log: (m) => log.push(String(m)), isServiceRunningImpl: () => false,
  });
  assert.equal(r.code, 0);
  const dopo = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(dopo.autoUpdate, false);
  assert.equal(dopo.wizardDone, true, 'le altre chiavi restano');
  fs.rmSync(home, { recursive: true, force: true });
});

// --- identity provision -------------------------------------------------------

test('identity provision: config illeggibile -> rifiuta e non scrive NULLA', () => {
  const home = tmpHome();
  const p = configRotta(home);
  const prima = fs.readFileSync(p);
  const dir = defaultAuthorityDir(home);

  const r = provisionIdentityAuthority({ home, dir, configPath: p, writeConfig: true });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONFIG_UNREADABLE');
  assert.ok(!String(r.message).includes(SENTINELLA), 'il contenuto non deve finire nel messaggio');
  assert.ok(!PAROLE_DEL_PARSER.test(String(r.message)), `niente testo del parser: ${r.message}`);
  assert.ok(fs.readFileSync(p).equals(prima), 'il file resta byte-identico');
  assert.equal(fs.existsSync(dir), false, 'nessuna credenziale scritta prima del rifiuto');
  fs.rmSync(home, { recursive: true, force: true });
});

test('identity provision: con config VALIDA provvede come prima', () => {
  const home = tmpHome();
  const p = configValida(home);
  const r = provisionIdentityAuthority({ home, dir: defaultAuthorityDir(home), configPath: p, writeConfig: true });
  assert.equal(r.ok, true);
  const dopo = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(dopo.wizardDone, true, 'le chiavi restano');
  assert.equal(dopo.fleet.identity.mode, 'authority', 'e si aggiunge la sua');
  assert.ok(fs.existsSync(defaultAuthorityDir(home)));
  fs.rmSync(home, { recursive: true, force: true });
});
