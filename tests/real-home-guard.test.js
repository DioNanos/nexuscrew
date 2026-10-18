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
  assert.equal(sottoRadice('/home/dag/.nexuscrew/x.json', '/home/dag'), true);
  assert.equal(sottoRadice('/home/dag', '/home/dag'), true);
  assert.equal(sottoRadice('/home/dag-prova/x', '/home/dag'), false, 'prefisso non basta');
  assert.equal(sottoRadice('/tmp/x', '/home/dag'), false);
  assert.equal(sottoRadice('/home/dag/x', ''), false);
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
