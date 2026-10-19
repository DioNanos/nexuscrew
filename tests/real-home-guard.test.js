'use strict';

// La guardia della home reale: che sia INSTALLATA nei worker (il preload la
// mette in ogni processo di test) e che BITA davvero. Il caso positivo si prova
// su un fs iniettato: qui non si scrive niente, ne' in casa propria ne' altrui.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { creaGuardia, sottoRadice } = require('./real-home-guard.cjs');

test('la guardia e\' installata in questo processo di test', (t) => {
  const guardia = globalThis.__ncRealHomeGuard;
  if (!guardia) {
    // Senza il preload dei worker la home del processo E' quella vera: una
    // guardia installata adesso non proteggerebbe niente. Il caso si dichiara.
    t.skip('preload dei worker non installato: esegui dal gate (node tests/run-isolated.js)');
    return;
  }
  assert.equal(guardia.installata(), true, 'e attiva');
  assert.ok(guardia.homeReale, 'con la home reale di partenza');
  assert.notEqual(path.resolve(guardia.homeReale), path.resolve(os.homedir()),
    'e la home del processo e\' quella isolata, non quella registrata');
  assert.deepEqual(guardia.violazioni(), [], 'e finora nessuna scrittura fuori posto');
});

test('sottoRadice: solo dentro, non i fratelli con lo stesso prefisso', () => {
  assert.equal(sottoRadice('/home/operatore/.nexuscrew/x.json', '/home/operatore'), true);
  assert.equal(sottoRadice('/home/operatore', '/home/operatore'), true);
  assert.equal(sottoRadice('/home/operatore-prova/x', '/home/operatore'), false, 'prefisso non basta');
  assert.equal(sottoRadice('/tmp/x', '/home/operatore'), false);
  assert.equal(sottoRadice('/home/operatore/x', ''), false);
});

test('bita: una scrittura sotto la home reale viene RIFIUTATA (su un fs iniettato)', () => {
  const scritture = [];
  const fintoFs = { writeFileSync: (p, ...r) => { scritture.push(p); return r.length; } };
  const guardia = creaGuardia({ homeReale: '/home/operatore', fsImpl: fintoFs });
  guardia.installa();

  assert.throws(
    () => fintoFs.writeFileSync('/home/operatore/.nexuscrew/model-discovery/ollama-cloud.json', 'finto'),
    /scrittura rifiutata sotto la home reale: writeFileSync \/home\/operatore/,
  );
  // le altre due passano: l'isolata e' casa propria, e `operatore-prova` non e'
  // dentro `operatore` solo perche' ne condivide il prefisso.
  fintoFs.writeFileSync('/tmp/isolata/.nexuscrew/model-discovery/ollama-cloud.json', 'finto');
  fintoFs.writeFileSync('/home/operatore-prova/x.json', 'finto');

  assert.equal(scritture.length, 2, 'le scritture legittime avvengono');
  const violazioni = guardia.violazioni();
  assert.equal(violazioni.length, 1, `attesa una violazione, ottenute ${violazioni.length}`);
  assert.match(violazioni[0].path, /^\/home\/operatore\/\.nexuscrew\/model-discovery\//);
  assert.equal(violazioni[0].op, 'writeFileSync');
  assert.match(String(guardia.verifica()), /1 scrittura\/e sotto la home reale/);

  guardia.ripristina();
  assert.equal(guardia.installata(), false, 'ripristino');
});

test('silenziosa quando non c\'e\' niente da dire', () => {
  const fintoFs = { mkdirSync: () => {} };
  const guardia = creaGuardia({ homeReale: '/home/operatore', fsImpl: fintoFs });
  guardia.installa();
  fintoFs.mkdirSync('/tmp/altrove', { recursive: true });
  assert.equal(guardia.verifica(), null, 'nessuna violazione -> nessun messaggio');
});

test('copy/rename: a DESTINATION under the real home is refused (injected fs)', () => {
  // The copy INTO the real home is the sneakiest violation: the source is
  // legitimate, the damage is where the file LANDS. The guard used to check
  // only the first argument — the source — and let the destination through.
  const operazioni = [];
  const fintoFs = {
    existsSync: () => false,
    copyFileSync: (s, d) => { operazioni.push(['copyFileSync', s, d]); },
    renameSync: (s, d) => { operazioni.push(['renameSync', s, d]); },
  };
  const guardia = creaGuardia({ homeReale: '/home/operatore', fsImpl: fintoFs });
  guardia.installa();

  assert.throws(
    () => fintoFs.copyFileSync('/tmp/finta-sorgente', '/home/operatore/.nexuscrew/cache.json'),
    /scrittura rifiutata sotto la home reale: copyFileSync \/home\/operatore/,
  );
  assert.throws(
    () => fintoFs.renameSync('/tmp/finta-sorgente', '/home/operatore/x.json'),
    /scrittura rifiutata sotto la home reale: renameSync \/home\/operatore/,
  );
  // The source end stays guarded too: renaming something OUT of the real home
  // still modifies the real home.
  assert.throws(
    () => fintoFs.renameSync('/home/operatore/x.json', '/tmp/altrove'),
    /scrittura rifiutata sotto la home reale: renameSync \/home\/operatore/,
  );
  // Nothing reached the fake fs, and the recorded violation is the DESTINATION.
  assert.equal(operazioni.length, 0, 'nessuna operazione arriva al fs');
  const violazioni = guardia.violazioni();
  assert.equal(violazioni.length, 3);
  assert.equal(violazioni[0].op, 'copyFileSync');
  assert.equal(violazioni[0].path, '/home/operatore/.nexuscrew/cache.json', 'la destinazione, non la sorgente');

  // Legitimate copy/rename between two paths OUTSIDE the home pass through.
  fintoFs.copyFileSync('/tmp/a', '/tmp/b');
  fintoFs.renameSync('/tmp/c', '/tmp/d');
  assert.equal(operazioni.length, 2, 'le operazioni legittime passano');

  guardia.ripristina();
});

test('async callback and promises variants guard the same home (injected fs)', async () => {
  const chiamate = [];
  const fintoFs = {
    existsSync: () => false,
    writeFile: (p, dati, cb) => { chiamate.push(['writeFile', p]); if (typeof cb === 'function') cb(null); },
    appendFile: (p, dati, cb) => { chiamate.push(['appendFile', p]); if (typeof cb === 'function') cb(null); },
    mkdir: (p, o, cb) => { chiamate.push(['mkdir', p]); if (typeof o === 'function') o(null); else if (typeof cb === 'function') cb(null); },
    rm: (p, o, cb) => { chiamate.push(['rm', p]); if (typeof o === 'function') o(null); else if (typeof cb === 'function') cb(null); },
    rename: (s, d, cb) => { chiamate.push(['rename', s, d]); if (typeof cb === 'function') cb(null); },
    copyFile: (s, d, cb) => { chiamate.push(['copyFile', s, d]); if (typeof cb === 'function') cb(null); },
    promises: {
      writeFile: async (p) => { chiamate.push(['promises.writeFile', p]); },
      appendFile: async (p) => { chiamate.push(['promises.appendFile', p]); },
      mkdir: async (p) => { chiamate.push(['promises.mkdir', p]); },
      rm: async (p) => { chiamate.push(['promises.rm', p]); },
      rename: async (s, d) => { chiamate.push(['promises.rename', s, d]); },
      copyFile: async (s, d) => { chiamate.push(['promises.copyFile', s, d]); },
    },
  };
  const guardia = creaGuardia({ homeReale: '/home/operatore', fsImpl: fintoFs });
  guardia.installa();

  // Callback style: refused before the original is touched.
  assert.throws(() => fintoFs.writeFile('/home/operatore/x', 'dati', () => {}), /scrittura rifiutata/);
  assert.throws(() => fintoFs.appendFile('/home/operatore/x', 'dati', () => {}), /scrittura rifiutata/);
  assert.throws(() => fintoFs.mkdir('/home/operatore/dir', { recursive: true }, () => {}), /scrittura rifiutata/);
  assert.throws(() => fintoFs.rm('/home/operatore/y', { force: true }, () => {}), /scrittura rifiutata/);
  assert.throws(() => fintoFs.rename('/tmp/sorgente', '/home/operatore/dest', () => {}), /scrittura rifiutata.*rename \/home\/operatore/);
  assert.throws(() => fintoFs.copyFile('/tmp/sorgente', '/home/operatore/dest2', () => {}), /scrittura rifiutata.*copyFile \/home\/operatore/);
  // Promises style: the same refusal, raised at the call site.
  assert.throws(() => fintoFs.promises.writeFile('/home/operatore/z', 'dati'), /scrittura rifiutata/);
  assert.throws(() => fintoFs.promises.mkdir('/home/operatore/dir'), /scrittura rifiutata/);
  assert.throws(() => fintoFs.promises.rename('/tmp/sorgente', '/home/operatore/dest3'), /scrittura rifiutata/);
  assert.throws(() => fintoFs.promises.copyFile('/tmp/sorgente', '/home/operatore/dest4'), /scrittura rifiutata/);

  assert.equal(guardia.violazioni().length, 10, 'ogni rifiuto e\' registrato');
  assert.equal(chiamate.length, 0, 'nessuna operazione arriva al fs');

  // The legitimate calls pass through with their original contract intact:
  // callbacks still fire, promises still resolve.
  await fintoFs.promises.writeFile('/tmp/ok1', 'dati');
  await fintoFs.promises.mkdir('/tmp/ok2');
  await fintoFs.promises.rename('/tmp/ok3a', '/tmp/ok3b');
  await fintoFs.promises.copyFile('/tmp/ok4a', '/tmp/ok4b');
  await new Promise((res) => fintoFs.rm('/tmp/ok5', { force: true }, res));
  assert.equal(chiamate.length, 5);
  assert.equal(guardia.violazioni().length, 10, 'niente nuove violazioni da percorsi legittimi');

  // Ripristino: the original functions come back, wrapper-free.
  guardia.ripristina();
  await fintoFs.promises.writeFile('/tmp/ok6', 'dati');
  fintoFs.writeFile('/tmp/ok7', 'dati', () => {});
  assert.equal(chiamate.length, 7, 'dopo il ripristino le originali rispondono');
});
