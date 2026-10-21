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
