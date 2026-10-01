'use strict';
// tests/init-config-unreadable.test.js — una config.json PRESENTE ma illeggibile
// non deve essere riscritta da `init`.
//
// Regressione (hotfix 0.9.54, su segnalazione delle macchine): in lib/cli/init.js
// il parse di config.json falliva in un `catch (_) { current = {}; }` e, quando
// l'init riceveva una porta (percorso di `fleet up`, commands.js:735), il file
// veniva RISCRITTO con `{ port }`. Cosi' sparivano le chiavi dell'operatore —
// `autoUpdate` tornava a true da solo (il default e' true, lib/config.js:84, e
// tutti i lettori usano «diverso da false») e `wizardDone` faceva riaprire il
// wizard.
//
// La regola qui e' quella che il repo applica gia' a fleet.json (init.js:71-74):
// un file presente e invalido non si riscrive, si dichiara e si prosegue.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runInit } = require('../lib/cli/init.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-init-unreadable-'));
}

function configPathOf(home) {
  return path.join(home, '.nexuscrew', 'config.json');
}

function preparaHome(contenuto) {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true });
  fs.writeFileSync(configPathOf(home), contenuto, { mode: 0o600 });
  return home;
}

function eseguiInit(home, port) {
  return runInit({
    platform: 'linux', home, port, tmuxOk: true,
    installPath: path.join(home, '.config', 'systemd', 'user', 'nexuscrew.service'),
    execImpl: () => {}, log: () => {},
  });
}

test('config troncata: init non la riscrive, il file resta BYTE-IDENTICO', () => {
  const troncata = '{\n  "port": 41820,\n  "autoUpdate": false,\n  "wizardDone": true\n';
  const home = preparaHome(troncata);
  const prima = fs.readFileSync(configPathOf(home));

  const r = eseguiInit(home, 42002);

  const dopo = fs.readFileSync(configPathOf(home));
  assert.ok(prima.equals(dopo), 'il file illeggibile deve restare byte-identico');
  assert.equal(dopo.toString('utf8'), troncata, 'contenuto invariato, nemmeno riformattato');
  // Il messaggio NOMINA il file: senza, chi legge il referto non sa cosa riparare.
  assert.ok(r.actions.some((a) => a.includes(configPathOf(home)) && /illeggibile/.test(a)),
    `atteso un avviso che nomina la config illeggibile, viste: ${JSON.stringify(r.actions)}`);
  fs.rmSync(home, { recursive: true, force: true });
});

test('config troncata: la porta chiesta non viene applicata al file', () => {
  const home = preparaHome('{"port": 41820, "autoUpdate": false');
  const r = eseguiInit(home, 42999);
  // La porta viaggia comunque nel referto (serve al chiamante), ma NON nel file.
  assert.equal(r.port, 42999);
  assert.ok(!fs.readFileSync(configPathOf(home), 'utf8').includes('42999'),
    'la porta nuova non deve finire nel file illeggibile');
  fs.rmSync(home, { recursive: true, force: true });
});

test('config non-oggetto (null): come illeggibile, non un crash', () => {
  const home = preparaHome('null');
  const r = eseguiInit(home, 42003);
  assert.equal(fs.readFileSync(configPathOf(home), 'utf8'), 'null');
  assert.ok(r.actions.some((a) => /illeggibile/.test(a)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('controllo positivo: con config VALIDA la porta si aggiorna e le chiavi restano', () => {
  const home = preparaHome('{\n  "port": 41820,\n  "autoUpdate": false,\n  "wizardDone": true\n}\n');
  eseguiInit(home, 42004);
  const dopo = JSON.parse(fs.readFileSync(configPathOf(home), 'utf8'));
  assert.equal(dopo.port, 42004, 'la porta si aggiorna');
  assert.equal(dopo.autoUpdate, false, 'autoUpdate resta quello scelto dall\'operatore');
  assert.equal(dopo.wizardDone, true, 'wizardDone resta');
  fs.rmSync(home, { recursive: true, force: true });
});

test('config assente: resta il comportamento di prima (config minima con la porta)', () => {
  const home = tmpHome();
  eseguiInit(home, 41820);
  const dopo = JSON.parse(fs.readFileSync(configPathOf(home), 'utf8'));
  assert.deepEqual(dopo, { port: 41820 });
  fs.rmSync(home, { recursive: true, force: true });
});
