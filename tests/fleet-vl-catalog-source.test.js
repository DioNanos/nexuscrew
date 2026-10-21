'use strict';
// Sorgente del catalogo vl.
//
// Due fatti che devono stare insieme:
//  * la configurazione dell'OPERATORE non si perde al primo avvio di un
//    engine native senza vlConfigFile dichiarato — la promessa "usa la tua
//    configurazione" non può diventare un avvio sui default del runtime;
//  * il catalogo di un engine precedente non sopravvive a un cambio di engine
//    o alla rimozione del campo che lo dichiarava — nessuna eredità
//    invisibile.
//
// L'overlay generato (XDG_CONFIG_HOME privata della cella / vl/config.toml)
// viene sempre rigenerato dalla sorgente corrente; la preferenza privata
// della cella (selected.toml) non viene mai toccata, e i segreti e la
// preferenza dell'operatore non vengono mai importati.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { resolveManagedEngine, vlCellBaseDir } = require('../lib/fleet/managed.js');

const CATALOGO_OPERATORE = '[profiles."lavoro"]\nmodel = "mine"\ndefault_profile = "lavoro"\n';
const CATALOGO_VECCHIO = '[profiles.vecchio]\nmodel = "old-model"\ndefault_profile = "vecchio"\n';

function homeConBinario() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlsrc-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return home;
}

function scriviCatalogo(dirBase, testo, nome = 'config.toml') {
  const vlDir = path.join(dirBase, 'vl');
  fs.mkdirSync(vlDir, { recursive: true });
  const p = path.join(vlDir, nome);
  fs.writeFileSync(p, testo);
  return p;
}

const vlNative = (extra = {}) => ({ client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard', ...extra });
// Un engine vl NON nativo: il provider e' esplicito nelle credenziali, quindi
// non ha una sorgente di catalogo da ereditare.
const vlRemoto = (extra = {}) => ({ client: 'vl', provider: 'anthropic', model: '', permissionPolicy: 'standard', ...extra });

function risolvi(home, managed, cfgExtra = {}, cell = { id: 'CellaProva' }) {
  return resolveManagedEngine({ id: 'engine.vl', managed }, cell, { home, platform: 'linux', env: {}, ...cfgExtra });
}

const overlayDi = (res) => path.join(res.engine.env.XDG_CONFIG_HOME, 'vl', 'config.toml');
// L'overlay della cella, calcolato come fa il prodotto: la directory identita'
// esiste anche quando il lancio viene rifiutato (le directory per cella sono
// create prima del catalogo), quindi l'assenza da provare e' il FILE.
const overlayPrevisto = (home) => path.join(vlCellBaseDir(home, null, 'CellaProva'), 'config', 'vl', 'config.toml');

// Il resolver del prodotto, eseguito in un PROCESSO SEPARATO: una lettura
// bloccante (una FIFO) bloccherebbe anche il test, e il test deve poter
// dire "il resolver ha risposto" invece di "il test e' scaduto".
const MODULO_PRODOTTO = require.resolve('../lib/fleet/managed.js');

function risolviInProcessoSeparato(home, vlConfigFile, timeoutMs = 5000) {
  const script = [
    `const { resolveManagedEngine } = require(${JSON.stringify(MODULO_PRODOTTO)});`,
    'const res = resolveManagedEngine(',
    "  { id: 'engine.vl', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard', vlConfigFile: process.argv[1] } },",
    "  { id: 'CellaProva' },",
    "  { home: process.argv[2], platform: 'linux', env: {} },",
    ');',
    'process.stdout.write(JSON.stringify({ ok: res.ok === true, reason: res.reason || null }));',
  ].join('\n');
  const esito = spawnSync(process.execPath, ['-e', script, vlConfigFile, home], {
    encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
  });
  if (esito.error && esito.error.code === 'ETIMEDOUT') {
    return { scaduto: true, ok: null, reason: null };
  }
  if (esito.status !== 0) {
    return { scaduto: false, ok: null, reason: `il resolver e' uscito con codice ${esito.status}: ${esito.stderr || ''}` };
  }
  try {
    const reso = JSON.parse(esito.stdout);
    return { scaduto: false, ok: reso.ok === true, reason: reso.reason };
  } catch (_) {
    return { scaduto: false, ok: null, reason: `output non leggibile: ${esito.stdout}` };
  }
}

test('vl.native senza vlConfigFile: il catalogo dell\'operatore diventa l\'overlay della cella', () => {
  const home = homeConBinario();
  const configOperatore = path.join(home, 'config-operatore');
  scriviCatalogo(configOperatore, CATALOGO_OPERATORE);
  const res = risolvi(home, vlNative(), { env: { XDG_CONFIG_HOME: configOperatore } });
  assert.equal(res.ok, true, res.reason);
  const overlay = overlayDi(res);
  assert.equal(fs.readFileSync(overlay, 'utf8'), CATALOGO_OPERATORE, 'l\'overlay deve essere il catalogo dell\'operatore');
  assert.equal(fs.statSync(overlay).mode & 0o777, 0o600, 'l\'overlay e\' privato');
});

test('senza XDG_CONFIG_HOME del servizio, la sorgente e\' HOME/.config/vl/config.toml', () => {
  const home = homeConBinario();
  scriviCatalogo(path.join(home, '.config'), CATALOGO_OPERATORE);
  const res = risolvi(home, vlNative(), { env: {} });
  assert.equal(res.ok, true, res.reason);
  assert.equal(fs.readFileSync(overlayDi(res), 'utf8'), CATALOGO_OPERATORE);
});

test('sorgente assente: il lancio e\' rifiutato, dichiarato, e non resta un catalogo', () => {
  const home = homeConBinario();
  const res = risolvi(home, vlNative(), { env: {} });
  assert.equal(res.ok, false, 'senza catalogo l\'engine native non deve partire sui default del runtime');
  assert.match(String(res.reason), /catalogo vl .*non leggibile/i, res.reason);
  assert.match(String(res.reason), /config\.toml/, 'il rifiuto nomina il percorso della sorgente mancante');
  assert.equal(fs.existsSync(overlayPrevisto(home)), false, 'nessun overlay scritto');
});

test('catalogo non valido: il lancio e\' rifiutato e l\'overlay non viene scritto', () => {
  const home = homeConBinario();
  const configOperatore = path.join(home, 'config-operatore');
  scriviCatalogo(configOperatore, '[profiles.lavoro\nmodel = "mine"\n');
  const res = risolvi(home, vlNative(), { env: { XDG_CONFIG_HOME: configOperatore } });
  assert.equal(res.ok, false, 'un catalogo rotto non deve passare');
  assert.match(String(res.reason), /non valido/i, res.reason);
  assert.equal(fs.existsSync(overlayPrevisto(home)), false, 'nessun overlay scritto');
});

test('vlConfigFile dichiarato: la fonte esplicita vince sul catalogo dell\'operatore', () => {
  const home = homeConBinario();
  const configOperatore = path.join(home, 'config-operatore');
  scriviCatalogo(configOperatore, CATALOGO_OPERATORE);
  const dichiarato = scriviCatalogo(path.join(home, 'dichiarato'), CATALOGO_VECCHIO);
  const res = risolvi(home, vlNative({ vlConfigFile: dichiarato }), { env: { XDG_CONFIG_HOME: configOperatore } });
  assert.equal(res.ok, true, res.reason);
  assert.equal(fs.readFileSync(overlayDi(res), 'utf8'), CATALOGO_VECCHIO);
});

test('campo rimosso: l\'overlay segue la sorgente corrente, non il catalogo precedente', () => {
  const home = homeConBinario();
  const configOperatore = path.join(home, 'config-operatore');
  scriviCatalogo(configOperatore, CATALOGO_OPERATORE);
  const dichiarato = scriviCatalogo(path.join(home, 'dichiarato'), CATALOGO_VECCHIO);
  const primo = risolvi(home, vlNative({ vlConfigFile: dichiarato }), { env: { XDG_CONFIG_HOME: configOperatore } });
  assert.equal(primo.ok, true, primo.reason);
  assert.equal(fs.readFileSync(overlayDi(primo), 'utf8'), CATALOGO_VECCHIO);
  // Stessa cella, stesso engine native, campo rimosso: la sorgente torna a
  // essere il catalogo dell'operatore e l'overlay deve seguirla.
  const secondo = risolvi(home, vlNative(), { env: { XDG_CONFIG_HOME: configOperatore } });
  assert.equal(secondo.ok, true, secondo.reason);
  assert.equal(fs.readFileSync(overlayDi(secondo), 'utf8'), CATALOGO_OPERATORE, 'il catalogo vecchio non deve sopravvivere');
});

test('cambio di engine: senza sorgente l\'overlay sparisce e selected.toml resta intatto', () => {
  const home = homeConBinario();
  const dichiarato = scriviCatalogo(path.join(home, 'dichiarato'), CATALOGO_VECCHIO);
  const primo = risolvi(home, vlNative({ vlConfigFile: dichiarato }), { env: {} });
  assert.equal(primo.ok, true, primo.reason);
  const overlay = overlayDi(primo);
  const selected = path.join(path.dirname(overlay), 'selected.toml');
  fs.writeFileSync(selected, 'profile = "mia"\n');
  // Cambio di engine: il nuovo engine non ha una sorgente di catalogo.
  const secondo = risolvi(home, vlRemoto(), { env: { VL_API_KEY: 'chiave-di-prova' } });
  assert.equal(secondo.ok, true, secondo.reason);
  assert.equal(fs.existsSync(overlay), false, 'l\'overlay del engine precedente non deve sopravvivere');
  assert.equal(fs.readFileSync(selected, 'utf8'), 'profile = "mia"\n', 'la preferenza privata della cella non viene toccata');
});

test('i segreti e la preferenza dell\'operatore non vengono importati', () => {
  const home = homeConBinario();
  const configOperatore = path.join(home, 'config-operatore');
  scriviCatalogo(configOperatore, CATALOGO_OPERATORE);
  fs.writeFileSync(path.join(configOperatore, 'vl', 'selected.toml'), 'profile = "mia"\n');
  fs.writeFileSync(path.join(configOperatore, 'vl', 'secrets.env'), 'VL_API_KEY=non-copiare\n');
  const res = risolvi(home, vlNative(), { env: { XDG_CONFIG_HOME: configOperatore } });
  assert.equal(res.ok, true, res.reason);
  const vlDir = path.dirname(overlayDi(res));
  assert.deepEqual(fs.readdirSync(vlDir).sort(), ['config.toml'], 'nella cella finisce solo il catalogo');
  const contenuto = fs.readFileSync(path.join(vlDir, 'config.toml'), 'utf8');
  assert.equal(contenuto.includes('non-copiare'), false, 'i segreti dell\'operatore non vengono copiati');
});

// --------------------------------------------------------------------------
// La sorgente deve essere un file REGOLARE e stare FUORI dall'overlay
// generato della cella.
//
//  * una FIFO non e' un catalogo: leggerla bloccherebbe il thread Node fino
//    all'arrivo di uno scrittore, quindi il rifiuto deve arrivare PRIMA di
//    qualsiasi lettura;
//  * l'overlay generato non puo' essere la sua stessa sorgente, ne' tramite
//    un symlink o un hard link: copiare l'overlay su se stesso non produce
//    un catalogo, produce un autoriferimento.
// --------------------------------------------------------------------------

test('sorgente non regolare (FIFO): il lancio e\' rifiutato e la lettura non blocca', () => {
  const home = homeConBinario();
  const fifo = path.join(home, 'catalogo.fifo');
  execFileSync('mkfifo', [fifo]);
  const esito = risolviInProcessoSeparato(home, fifo);
  assert.equal(esito.scaduto, false, 'il resolver non deve bloccare su una FIFO');
  assert.equal(esito.ok, false, 'una FIFO non e\' un catalogo');
  assert.match(String(esito.reason), /non regolare/i, esito.reason);
  assert.match(String(esito.reason), /FIFO/i, esito.reason);
  assert.equal(fs.existsSync(overlayPrevisto(home)), false, 'nessun overlay scritto');
});

test('sorgente non regolare (directory): il lancio e\' rifiutato, dichiarato', () => {
  const home = homeConBinario();
  const dir = path.join(home, 'catalogo.directory');
  fs.mkdirSync(dir);
  const res = risolvi(home, vlNative({ vlConfigFile: dir }), { env: {} });
  assert.equal(res.ok, false, 'una directory non e\' un catalogo');
  assert.match(String(res.reason), /non regolare/i, res.reason);
  assert.match(String(res.reason), /directory/i, res.reason);
  assert.equal(fs.existsSync(overlayPrevisto(home)), false, 'nessun overlay scritto');
});

test('l\'overlay generato non puo\' essere la sorgente: il lancio e\' rifiutato', () => {
  const home = homeConBinario();
  const esterno = scriviCatalogo(path.join(home, 'esterno'), CATALOGO_OPERATORE);
  const primo = risolvi(home, vlNative({ vlConfigFile: esterno }), { env: {} });
  assert.equal(primo.ok, true, primo.reason);
  const overlay = overlayDi(primo);
  assert.equal(fs.existsSync(overlay), true, 'il primo lancio ha generato l\'overlay');
  const selected = path.join(path.dirname(overlay), 'selected.toml');
  fs.writeFileSync(selected, 'profile = "mia"\n');
  // Secondo lancio: la sorgente dichiarata e' l'overlay generato.
  const secondo = risolvi(home, vlNative({ vlConfigFile: overlay }), { env: {} });
  assert.equal(secondo.ok, false, 'l\'overlay non puo\' essere la sua stessa sorgente');
  assert.match(String(secondo.reason), /overlay/i, secondo.reason);
  assert.equal(fs.readFileSync(selected, 'utf8'), 'profile = "mia"\n', 'la preferenza privata della cella non viene toccata');
});

test('un symlink all\'overlay non puo\' essere la sorgente: il lancio e\' rifiutato', () => {
  const home = homeConBinario();
  const esterno = scriviCatalogo(path.join(home, 'esterno'), CATALOGO_OPERATORE);
  const primo = risolvi(home, vlNative({ vlConfigFile: esterno }), { env: {} });
  assert.equal(primo.ok, true, primo.reason);
  const overlay = overlayDi(primo);
  const alias = path.join(home, 'alias-overlay.toml');
  fs.symlinkSync(overlay, alias);
  const secondo = risolvi(home, vlNative({ vlConfigFile: alias }), { env: {} });
  assert.equal(secondo.ok, false, 'un alias dell\'overlay non e\' una sorgente');
  assert.match(String(secondo.reason), /overlay/i, secondo.reason);
});

test('un hard link all\'overlay non puo\' essere la sorgente: il lancio e\' rifiutato', () => {
  const home = homeConBinario();
  const esterno = scriviCatalogo(path.join(home, 'esterno'), CATALOGO_OPERATORE);
  const primo = risolvi(home, vlNative({ vlConfigFile: esterno }), { env: {} });
  assert.equal(primo.ok, true, primo.reason);
  const overlay = overlayDi(primo);
  const alias = path.join(home, 'hardlink-overlay.toml');
  fs.linkSync(overlay, alias);
  const secondo = risolvi(home, vlNative({ vlConfigFile: alias }), { env: {} });
  assert.equal(secondo.ok, false, 'un hard link all\'overlay non e\' una sorgente');
  assert.match(String(secondo.reason), /overlay/i, secondo.reason);
});

test('un symlink verso un catalogo esterno legittimo resta una sorgente valida', () => {
  const home = homeConBinario();
  const esterno = scriviCatalogo(path.join(home, 'esterno'), CATALOGO_OPERATORE);
  const alias = path.join(home, 'alias-esterno.toml');
  fs.symlinkSync(esterno, alias);
  const res = risolvi(home, vlNative({ vlConfigFile: alias }), { env: {} });
  assert.equal(res.ok, true, res.reason);
  assert.equal(fs.readFileSync(overlayDi(res), 'utf8'), CATALOGO_OPERATORE, 'l\'overlay e\' il catalogo della sorgente');
});
