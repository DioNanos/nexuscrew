'use strict';
// Il provisioning del pin locale deve funzionare PERCORRENDO la strada vera
// della CLI: la versione di flock si legge sull'oggetto qualificato (copia in
// staging), con la callback di produzione — non con una callback iniettata che
// restituisce una versione costante e nasconde un collegamento rotto.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { dispatch } = require('../lib/cli/commands.js');
const cliPin = require('../lib/cli/vl-pin.js');
const pinLocale = require('../lib/fleet/vl-claim-pin-local.js');
const roots = require('../lib/fleet/vl-roots.js');

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function prefisso(t, { versione = 'flock from util-linux 2.39.3' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pin-cli-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const node = path.join(bin, 'node');
  const flock = path.join(bin, 'flock');
  fs.writeFileSync(node, '#!/bin/sh\nexit 0\n', { mode: 0o500 });
  fs.writeFileSync(flock, `#!/bin/sh\necho "${versione}"\n`, { mode: 0o500 });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  return { dir, home, node, flock };
}

test('R1: la callback di produzione legge la versione sull\'oggetto qualificato', (t) => {
  const p = prefisso(t);
  const buf = fs.readFileSync(p.flock);
  const v = cliPin.versioneQualificata({ source: p.flock, sha256: sha(buf) });
  assert.equal(v, '2.39.3', `versione letta: ${JSON.stringify(v)}`);
});

test('R1: una versione non util-linux non viene inventata', (t) => {
  const p = prefisso(t, { versione: 'not util-linux at all' });
  const buf = fs.readFileSync(p.flock);
  assert.equal(cliPin.versioneQualificata({ source: p.flock, sha256: sha(buf) }), '');
});

test('R1: il provisioning con la callback produttiva registra il pin (integrazione CLI)', (t) => {
  const p = prefisso(t);
  const r = pinLocale.provisiona({
    home: p.home,
    flock: p.flock,
    node: p.node,
    helperHash: roots.MANIFEST.helper.sha256,
    by: 'operatore',
    deps: {
      platform: 'android', arch: 'arm64', execPath: p.node,
      versioneQualificata: cliPin.versioneQualificata,
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.pin.components.flock.version, '2.39.3');
});

test('R1: la CLI espone il comando: provision di sistema su linux, PIN_PREFIX con un prefisso utente', async (t) => {
  const righe = [];
  const log = (r) => righe.push(String(r));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pin-cli-home-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });

  const show = await dispatch(['vl-pin', 'show'], { log, home });
  assert.equal(show.code, 1, 'nessun pin locale registrato');
  assert.match(righe.join('\n'), /local pin/);

  // Su Linux il candidato di default e' la flock DI SISTEMA (non quella
  // accanto al node): il provision riesce e la versione si legge sull'oggetto
  // qualificato con la callback di produzione, non inventata.
  const prov = await dispatch(['vl-pin', 'provision'], { log, home });
  assert.equal(prov.code, 0, JSON.stringify(prov));
  const pin = pinLocale.leggi(home).pin;
  assert.equal(pin.components.flock.source, '/usr/bin/flock');
  assert.match(pin.components.flock.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pin.helper.sha256, roots.MANIFEST.helper.sha256);
  assert.equal(`${pin.platform.platform}-${pin.platform.arch}`, 'linux-x64');

  const show2 = await dispatch(['vl-pin', 'show'], { log, home });
  assert.equal(show2.code, 0, JSON.stringify(show2));
  assert.match(righe.join('\n'), /"platform": "linux-x64"/);

  // Un prefisso utente non porta nell'insieme chiuso: rifiuto CLI PIN_PREFIX.
  const utente = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pin-cli-usr-'));
  t.after(() => { try { fs.rmSync(utente, { recursive: true, force: true }); } catch (_) {} });
  const neg = await dispatch(['vl-pin', 'provision', '--again', '--prefix', utente], { log, home });
  assert.equal(neg.code, 1, JSON.stringify(neg));
  assert.match(righe.join('\n'), /PIN_PREFIX/);
});
