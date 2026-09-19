'use strict';
// tests/fleet-credential-provenance.test.js — da DOVE viene una credenziale, e
// quando due file dicono cose diverse.
//
// Il caso che ha aperto questo lavoro: `~/.config/keys/ai.env` e
// `~/.config/secure/.env` vengono letti in quest'ordine e l'ULTIMO vince, quindi
// un valore messo in `secure/.env` scavalca quello canonico — e nessuno poteva
// accorgersene, perche' tutte le sorgenti «compatibili» si presentavano con la
// stessa etichetta. Qui si verifica che:
//   1. la provenienza sia DETTA (sorgente, path, mtime, impronta del valore);
//   2. un conflitto sia DICHIARATO, con le impronte e mai i valori;
//   3. due file con lo STESSO valore non siano un conflitto;
//   4. nessun valore di credenziale compaia in un esito, in un JSON o nel doctor.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describeManaged } = require('../lib/fleet/managed.js');
const { checkEngineCredentials } = require('../lib/cli/doctor.js');

const CHIAVE = 'PROV_TEST_KEY';
const VALORE_CANONICO = 'valore-canonico-che-non-deve-uscire';
const VALORE_SECURE = 'valore-secure-diverso-che-non-deve-uscire';

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-prov-'));
  const h = path.join(root, 'home');
  fs.mkdirSync(h, { mode: 0o700 });
  fs.chmodSync(h, 0o700);
  fs.mkdirSync(path.join(h, '.local', 'bin'), { recursive: true });
  const bin = path.join(h, '.local', 'bin', 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return h;
}

// File di chiavi nella forma che il prodotto accetta: 0600, regolare, in una
// directory privata. Il contenuto e' finto: nessuna chiave reale entra qui.
function keyFile(h, rel, contenuto) {
  const file = path.join(h, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  fs.writeFileSync(file, contenuto, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function spec(extra = {}) {
  return {
    client: 'claude', provider: 'custom', displayName: 'Prova',
    protocol: 'anthropic_messages', baseUrl: 'http://127.0.0.1:1/v1',
    envKey: CHIAVE, providerId: 'prova', model: 'm',
    ...extra,
  };
}

const cfgCon = (h, over = {}) => ({
  home: h,
  env: {},
  providerKeysPath: path.join(h, '.config', 'keys', 'ai.env'),
  providerSecurePath: path.join(h, '.config', 'secure', '.env'),
  providerShellPath: path.join(h, '.config', 'ai-shell', 'providers.zsh'),
  providerSecretsPath: path.join(h, '.nexuscrew', 'providers.env'),
  ...over,
});

// --- (b) conflitto fra i due file di chiavi ---------------------------------

test('due file di chiavi con valori diversi: l\'engine e\' pronto MA l\'esito dichiara il conflitto', (t) => {
  const h = home(t);
  const canonico = keyFile(h, '.config/keys/ai.env', `${CHIAVE}=${VALORE_CANONICO}\n`);
  const secure = keyFile(h, '.config/secure/.env', `${CHIAVE}=${VALORE_SECURE}\n`);

  const info = describeManaged(spec(), cfgCon(h));
  assert.equal(info.configured, true, 'una chiave valida c\'e\': il client deve poter partire');
  assert.equal(info.authConfigured, true);
  // Vince l'ULTIMO dei due, ed e' il file di override.
  assert.equal(info.credentialSource, 'secure-file');
  assert.equal(info.credentialPath, secure);
  assert.match(info.reason, /^ready \(credential PROV_TEST_KEY also defined in /);
  assert.match(info.reason, new RegExp(canonico.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(info.reason, /with a different value\)$/);

  const c = info.credentialConflict;
  assert.ok(c, 'il conflitto e\' strutturato, non solo una frase');
  assert.equal(c.envKey, CHIAVE);
  assert.equal(c.winner.path, secure);
  assert.equal(c.others.length, 1);
  assert.equal(c.others[0].path, canonico);
  // Impronte presenti, e DIVERSE fra loro.
  assert.match(c.winner.hash8, /^[0-9a-f]{8}$/);
  assert.match(c.others[0].hash8, /^[0-9a-f]{8}$/);
  assert.notEqual(c.winner.hash8, c.others[0].hash8);
  assert.ok(c.winner.mtime > 0 && c.others[0].mtime > 0, 'mtime riportato');
});

test('due file con lo STESSO valore non sono un conflitto: silenzio', (t) => {
  const h = home(t);
  keyFile(h, '.config/keys/ai.env', `${CHIAVE}=${VALORE_CANONICO}\n`);
  keyFile(h, '.config/secure/.env', `${CHIAVE}=${VALORE_CANONICO}\n`);
  const info = describeManaged(spec(), cfgCon(h));
  assert.equal(info.configured, true);
  assert.equal(info.reason, 'ready', 'la stessa chiave in due posti non e\' un problema da dire');
  assert.equal(info.credentialConflict, null);
});

test('una variabile DIVERSa nei due file non produce un conflitto sulla nostra', (t) => {
  const h = home(t);
  keyFile(h, '.config/keys/ai.env', `${CHIAVE}=${VALORE_CANONICO}\nALTRA_KEY=aaa\n`);
  keyFile(h, '.config/secure/.env', 'ALTRA_KEY=bbb\n');
  const info = describeManaged(spec(), cfgCon(h));
  assert.equal(info.reason, 'ready');
  assert.equal(info.credentialConflict, null);
});

test('un solo file di chiavi: nessun conflitto, e la sorgente e\' il file canonico', (t) => {
  const h = home(t);
  const canonico = keyFile(h, '.config/keys/ai.env', `${CHIAVE}=${VALORE_CANONICO}\n`);
  const info = describeManaged(spec(), cfgCon(h));
  assert.equal(info.credentialSource, 'keys-file');
  assert.equal(info.credentialPath, canonico);
  assert.equal(info.reason, 'ready');
  assert.equal(info.credentialConflict, null);
});

// --- il symlink del nodo: keys/ai.env -> secrets/.env -------------------------

test('keys/ai.env come symlink verso secure/.env: una sola sorgente, nessun falso conflitto', (t) => {
  const h = home(t);
  const secure = keyFile(h, '.config/secure/.env', `${CHIAVE}=${VALORE_CANONICO}\n`);
  const keysDir = path.join(h, '.config', 'keys');
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(keysDir, 0o700);
  fs.symlinkSync(path.relative(keysDir, secure), path.join(keysDir, 'ai.env'));

  const info = describeManaged(spec(), cfgCon(h));
  assert.equal(info.configured, true, 'il symlink ammesso resta una sorgente valida');
  assert.equal(info.credentialConflict, null, 'e\' LO STESSO file: non due file in disaccordo');
});

// --- (a) la sorgente, per ciascuna delle origini ----------------------------

test('ogni origine si dichiara per quello che e\': le sei origini, una per una', (t) => {
  // Ogni origine si prova su una home PULITA: la precedenza e' una catena, e
  // accumulare le sorgenti nella stessa home misurerebbe l'ordine, non la
  // capacita' di dire da dove viene la chiave.
  const { credential, profileFor } = require('../lib/fleet/managed.js');

  // 1. ambiente
  let h = home(t);
  let info = describeManaged(spec(), { ...cfgCon(h), env: { [CHIAVE]: 'da-ambiente' } });
  assert.equal(info.credentialSource, 'environment');
  assert.equal(info.credentialPath, '', 'l\'ambiente non e\' un file');

  // 2. store NexusCrew
  h = home(t);
  const { setCredential } = require('../lib/fleet/credentials.js');
  setCredential(cfgCon(h), CHIAVE, 'da-store', h);
  info = describeManaged(spec(), cfgCon(h));
  assert.equal(info.credentialSource, 'local');
  assert.equal(info.credentialPath, '', 'lo store non e\' un file di chiavi');

  // 3. providers.zsh: e' un file anche lui, quindi porta la sua provenienza
  h = home(t);
  const shellPath = keyFile(h, '.config/ai-shell/providers.zsh', `export ${CHIAVE}=da-shell\n`);
  info = describeManaged(spec(), cfgCon(h));
  assert.equal(info.credentialSource, 'providers-shell');
  assert.equal(info.credentialPath, shellPath);
  assert.match(info.credentialHash8, /^[0-9a-f]{8}$/);

  // 4. file canonico delle chiavi
  h = home(t);
  const canonico = keyFile(h, '.config/keys/ai.env', `${CHIAVE}=da-keys-file\n`);
  info = describeManaged(spec(), cfgCon(h));
  assert.equal(info.credentialSource, 'keys-file');
  assert.equal(info.credentialPath, canonico);

  // 5. file secure (l\'ultimo dei due vince)
  h = home(t);
  keyFile(h, '.config/keys/ai.env', `${CHIAVE}=da-keys-file\n`);
  const secure = keyFile(h, '.config/secure/.env', `${CHIAVE}=da-secure-file\n`);
  info = describeManaged(spec(), cfgCon(h));
  assert.equal(info.credentialSource, 'secure-file');
  assert.equal(info.credentialPath, secure);

  // 6. legacy: solo per un profilo che lo dichiara e solo se i file di chiavi
  //    non hanno la variabile.
  h = home(t);
  keyFile(h, '.nexuscrew/providers.env', `${CHIAVE}=da-legacy\n`);
  const legacyProfile = profileFor('claude', 'custom', '');
  assert.ok(legacyProfile);
  const out = credential(
    { ...legacyProfile, auth: CHIAVE, legacySecrets: true },
    { client: 'claude', provider: 'custom', envKey: CHIAVE, credentialProfile: '' },
    cfgCon(h), h, { blocked: [] },
  );
  assert.equal(out.source, 'legacy');
  assert.equal(out.value, 'da-legacy');
});

// --- (e) la disciplina: MAI un valore ---------------------------------------

test('nessun valore di credenziale esce da un esito, nemmeno in JSON', (t) => {
  const h = home(t);
  keyFile(h, '.config/keys/ai.env', `${CHIAVE}=${VALORE_CANONICO}\n`);
  keyFile(h, '.config/secure/.env', `${CHIAVE}=${VALORE_SECURE}\n`);
  const info = describeManaged(spec(), cfgCon(h));

  const serializzato = JSON.stringify(info);
  assert.ok(!serializzato.includes(VALORE_CANONICO), 'il valore canonico non compare');
  assert.ok(!serializzato.includes(VALORE_SECURE), 'il valore di override non compare');
  assert.ok(!serializzato.includes('da-keys-file'), 'nessun valore di comodo');
  assert.ok(serializzato.includes(info.credentialHash8), 'l\'impronta invece c\'e\', ed e\' cio\' che rende il conflitto visibile');
});

test('l\'impronta e\' stabile e non e\' il valore', (t) => {
  const h = home(t);
  keyFile(h, '.config/keys/ai.env', `${CHIAVE}=${VALORE_CANONICO}\n`);
  const a = describeManaged(spec(), cfgCon(h));
  const b = describeManaged(spec(), cfgCon(h));
  assert.equal(a.credentialHash8, b.credentialHash8, 'stessa chiave, stessa impronta');
  assert.equal(a.credentialHash8.length, 8);
  assert.notEqual(a.credentialHash8, VALORE_CANONICO);
});

// --- il doctor: la sezione «engine credentials» -----------------------------

async function fleetConMotore(t, over = {}) {
  const h = home(t);
  const defsPath = path.join(h, 'fleet.json');
  const cmd = path.join(h, '.local', 'bin', 'claude');
  // Definizioni minime VALIDE, poi l'engine managed via CRUD: e' la forma che
  // il prodotto accetta davvero, e il doctor legge esattamente quel file.
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [{ id: 'e1', label: 'E1', rc: true, command: cmd, args: [], env: {}, promptMode: 'flag', promptFlag: '--sp' }],
    cells: [{ id: 'Dev', tmuxSession: 'work-prov', cwd: h, engine: 'e1', boot: false, prompt: 'p' }],
  }));
  const tmuxBin = path.join(h, 'bin', 'tmux-finto');
  fs.mkdirSync(path.dirname(tmuxBin), { recursive: true });
  fs.writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tmuxBin, 0o755);
  const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
  const fleet = await createBuiltinFleet({ home: h, fleetDefsPath: defsPath, tmuxBin });
  await fleet.defineEngine({
    id: 'prova.engine', label: 'Prova',
    managed: {
      client: 'claude', provider: 'custom', displayName: 'Prova',
      protocol: 'anthropic_messages', baseUrl: 'http://127.0.0.1:1/v1',
      envKey: CHIAVE, providerId: 'prova', model: 'm', permissionPolicy: 'standard',
      ...(over.managed || {}),
    },
  });
  // La cella gira su QUESTO engine: e' cio' che rende il conflitto un
  // fallimento invece di un avviso.
  if (over.inUso !== false) await fleet.editCell('Dev', { engine: 'prova.engine' });
  await fleet.close();
  return { h, defsPath };
}

test('doctor: la riga dice sorgente, path, mtime e impronta — e nessun valore', async (t) => {
  const { h, defsPath } = await fleetConMotore(t);
  const canonico = keyFile(h, '.config/keys/ai.env', `${CHIAVE}=${VALORE_CANONICO}\n`);
  const check = checkEngineCredentials(h, defsPath, true);
  assert.equal(check.name, 'engine credentials');
  assert.equal(check.ok, true);
  assert.match(check.detail, /prova\.engine: PROV_TEST_KEY from keys-file \(/);
  assert.match(check.detail, new RegExp(canonico.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(check.detail, /mtime \d{4}-\d{2}-\d{2}T/);
  assert.match(check.detail, /sha256 [0-9a-f]{8}/);
  assert.ok(!check.detail.includes(VALORE_CANONICO), 'il valore non entra nell\'output del doctor');
});

test('doctor: un conflitto su un engine IN USO e\' un fallimento, e nomina i due file', async (t) => {
  const { h, defsPath } = await fleetConMotore(t);
  const canonico = keyFile(h, '.config/keys/ai.env', `${CHIAVE}=${VALORE_CANONICO}\n`);
  const secure = keyFile(h, '.config/secure/.env', `${CHIAVE}=${VALORE_SECURE}\n`);
  const check = checkEngineCredentials(h, defsPath, true);
  assert.equal(check.ok, false, 'la cella parte con una chiave che qualcun altro ha scavalcato');
  assert.match(check.detail, /definita anche in /);
  assert.match(check.detail, new RegExp(canonico.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(check.detail, new RegExp(secure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(check.detail, /valore DIVERSO/);
  assert.ok(!check.detail.includes(VALORE_CANONICO));
  assert.ok(!check.detail.includes(VALORE_SECURE));
});

test('doctor: un conflitto su un engine che nessuna cella usa e\' un avviso, non un fallimento', async (t) => {
  const { h, defsPath } = await fleetConMotore(t, { inUso: false });
  keyFile(h, '.config/keys/ai.env', `${CHIAVE}=${VALORE_CANONICO}\n`);
  keyFile(h, '.config/secure/.env', `${CHIAVE}=${VALORE_SECURE}\n`);
  const check = checkEngineCredentials(h, defsPath, true);
  assert.equal(check.ok, true, 'nessuna cella usa la chiave: non c\'e\' ancora nulla che parta storto');
  assert.equal(check.warn, true, 'ma va detto');
  assert.match(check.detail, /valore DIVERSO/);
});

test('doctor: senza engine con credenziale risolta lo dice, e non finge', async (t) => {
  const { h, defsPath } = await fleetConMotore(t, { managed: { provider: 'native' } });
  const check = checkEngineCredentials(h, defsPath, true);
  assert.equal(check.ok, true);
  assert.match(check.detail, /nessun engine con credenziale risolta/);
});

test('doctor: fleet disabilitata non allarma', async (t) => {
  const { h, defsPath } = await fleetConMotore(t);
  const check = checkEngineCredentials(h, defsPath, false);
  assert.equal(check.ok, true);
  assert.equal(check.warn, true);
});

test('doctor: fleet.json illeggibile non dichiara un problema che non ha visto', async (t) => {
  const { h } = await fleetConMotore(t);
  const check = checkEngineCredentials(h, path.join(h, 'non-esiste.json'), true);
  assert.equal(check.ok, true);
  assert.equal(check.warn, true);
  assert.match(check.detail, /non verificabile/);
});

// --- il confronto si estende alla SHELL -------------------------------------
//
// `providers.zsh` sta PIU' IN ALTO dei file di chiavi nella precedenza reale:
// una shell stantia scavalca `ai.env` e produce lo stesso guasto del caso
// Pixel, a parti invertite. Il confronto d'impronta vale quindi anche fra la
// shell e i due file, con la stessa struttura.

test('shell e file di chiavi con valori diversi: vince la shell, e il conflitto lo dice', (t) => {
  const h = home(t);
  const shell = keyFile(h, '.config/ai-shell/providers.zsh', `export ${CHIAVE}=valore-shell-stantio\n`);
  const canonico = keyFile(h, '.config/keys/ai.env', `${CHIAVE}=valore-buono\n`);

  const info = describeManaged(spec(), cfgCon(h));
  assert.equal(info.configured, true);
  assert.equal(info.credentialSource, 'providers-shell', 'la shell sta sopra i file: e\' lei a vincere');
  assert.match(info.reason, /^ready \(credential PROV_TEST_KEY also defined in /);
  assert.match(info.reason, new RegExp(canonico.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(info.reason, /with a different value\)$/);

  const c = info.credentialConflict;
  assert.ok(c, 'il conflitto fra shell e file e\' dichiarato come quello fra i due file');
  assert.equal(c.winner.source, 'providers-shell');
  assert.equal(c.winner.path, shell);
  assert.equal(c.others.length, 1);
  assert.equal(c.others[0].source, 'keys-file');
  assert.equal(c.others[0].path, canonico);
  assert.notEqual(c.winner.hash8, c.others[0].hash8);
  assert.ok(!JSON.stringify(c).includes('valore-shell-stantio'));
  assert.ok(!JSON.stringify(c).includes('valore-buono'));
});

test('shell e file di chiavi con lo STESSO valore: silenzio', (t) => {
  const h = home(t);
  keyFile(h, '.config/ai-shell/providers.zsh', `export ${CHIAVE}=valore-uguale\n`);
  keyFile(h, '.config/keys/ai.env', `${CHIAVE}=valore-uguale\n`);
  const info = describeManaged(spec(), cfgCon(h));
  assert.equal(info.credentialSource, 'providers-shell');
  assert.equal(info.reason, 'ready', 'la stessa chiave in due posti non e\' un problema da dire');
  assert.equal(info.credentialConflict, null);
});

test('solo la shell: nessun conflitto, e la sorgente e\' providers-shell', (t) => {
  const h = home(t);
  const shell = keyFile(h, '.config/ai-shell/providers.zsh', `export ${CHIAVE}=solo-shell\n`);
  const info = describeManaged(spec(), cfgCon(h));
  assert.equal(info.credentialSource, 'providers-shell');
  assert.equal(info.reason, 'ready');
  assert.equal(info.credentialConflict, null);
  assert.ok(shell);
});

test('un conflitto in TRE: shell, ai.env e secure/.env tutti diversi', (t) => {
  const h = home(t);
  const shell = keyFile(h, '.config/ai-shell/providers.zsh', `export ${CHIAVE}=tre-uno\n`);
  const canonico = keyFile(h, '.config/keys/ai.env', `${CHIAVE}=tre-due\n`);
  const secure = keyFile(h, '.config/secure/.env', `${CHIAVE}=tre-tre\n`);
  const info = describeManaged(spec(), cfgCon(h));
  assert.equal(info.credentialSource, 'providers-shell');
  const c = info.credentialConflict;
  assert.ok(c);
  assert.equal(c.winner.path, shell);
  assert.deepStrictEqual(c.others.map((o) => o.path).sort(), [canonico, secure].sort(),
    'tutte le sorgenti in disaccordo sono nominate, non solo la prima');
  for (const o of c.others) assert.match(o.hash8, /^[0-9a-f]{8}$/);
  for (const v of ['tre-uno', 'tre-due', 'tre-tre']) {
    assert.ok(!JSON.stringify(c).includes(v), 'nessun valore nel conflitto');
  }
});

test('doctor: il conflitto con la shell finisce nella stessa sezione', async (t) => {
  const { h, defsPath } = await fleetConMotore(t);
  keyFile(h, '.config/ai-shell/providers.zsh', `export ${CHIAVE}=valore-shell-stantio\n`);
  keyFile(h, '.config/keys/ai.env', `${CHIAVE}=valore-buono\n`);
  const check = checkEngineCredentials(h, defsPath, true);
  assert.equal(check.ok, false, 'la cella parte con la chiave della shell, che e\' quella stantia');
  assert.match(check.detail, /from providers-shell \(/);
  assert.match(check.detail, /valore DIVERSO/);
  assert.match(check.detail, /ai\.env/);
  assert.ok(!check.detail.includes('valore-shell-stantio'));
  assert.ok(!check.detail.includes('valore-buono'));
});
