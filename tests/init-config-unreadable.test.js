'use strict';
// tests/init-config-unreadable.test.js — una config.json PRESENTE ma illeggibile
// non deve essere riscritta da `init`.
//
// Regressione (hotfix 0.9.54, su segnalazione delle macchine): in lib/cli/init.js
// il parse di config.json falliva in un `catch (_) { current = {}; }` e, quando
// l'init riceveva una porta (percorso di `fleet up`, commands.js:735), il file
// veniva RISCRITTO con `{ port }`. Cosi' sparivano le chiavi dell'operatore —
// `autoUpdate` tornava a acceso da solo (oggi il default e' false e tutti i
// lettori usano «=== true») e `wizardDone` faceva riaprire il wizard.
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

// --- anti-leak ---------------------------------------------------------------
// Il motivo dell'illeggibilita' e' una CATEGORIA, mai il messaggio del parser:
// su Node recenti `JSON.parse` include un estratto dell'input, e l'azione viene
// stampata dal comando — cosi' il contenuto della config finirebbe nei log.
const SENTINELLA = 'S3CR3T';
const MOTIVI_AMMESSI = /\((parse-error|not-object|read-error(?::[A-Z]+)?)\)/;
const PAROLE_DEL_PARSER = /Unexpected|Expected|position|column|is not valid JSON/i;

test('config malformata: il valore sentinella non compare nelle azioni', () => {
  // Un valore senza virgolette: forma che sul codice precedente faceva uscire il
  // valore INTERO nell'avviso (l'estratto del parser lo conteneva tutto).
  const home = preparaHome(`{"port":41820,"tok":${SENTINELLA}}`);
  const prima = fs.readFileSync(configPathOf(home));

  const r = eseguiInit(home, 42005);

  const azioni = r.actions.join('\n');
  assert.ok(!azioni.includes(SENTINELLA), `il valore non deve comparire nelle azioni: ${azioni}`);
  assert.ok(!PAROLE_DEL_PARSER.test(azioni), `niente testo del parser nelle azioni: ${azioni}`);
  assert.ok(r.actions.some((a) => MOTIVI_AMMESSI.test(a)),
    `il motivo deve essere una categoria fissa, viste: ${JSON.stringify(r.actions)}`);
  assert.ok(fs.readFileSync(configPathOf(home)).equals(prima), 'il file resta byte-identico');
  fs.rmSync(home, { recursive: true, force: true });
});

test('config malformata: il valore sentinella non compare nemmeno su stdout/stderr', () => {
  const home = preparaHome(`{"port":41820,"tok":${SENTINELLA}}`);
  const catturato = [];
  const outW = process.stdout.write;
  const errW = process.stderr.write;
  process.stdout.write = (c) => { catturato.push(String(c)); return true; };
  process.stderr.write = (c) => { catturato.push(String(c)); return true; };
  try {
    // Come fa il comando: le azioni finiscono su stdout. E' il percorso da cui
    // il valore trapelerebbe.
    runInit({
      platform: 'linux', home, port: 42006, tmuxOk: true,
      installPath: path.join(home, '.config', 'systemd', 'user', 'nexuscrew.service'),
      execImpl: () => {},
      log: (m) => process.stdout.write(`${m}\n`),
    });
  } finally {
    process.stdout.write = outW;
    process.stderr.write = errW;
  }
  assert.ok(!catturato.join('').includes(SENTINELLA), 'il valore non deve finire su stdout/stderr');
  fs.rmSync(home, { recursive: true, force: true });
});
