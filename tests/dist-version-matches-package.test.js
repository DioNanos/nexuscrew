'use strict';
// La versione che il frontend DICHIARA e quella che il server ESPONE devono
// essere la stessa, o l'installazione si rifiuta di partire: `lib/server.js`
// legge `frontend/dist/version.json` e confronta.
//
// Perche' esiste questa guardia. Il 22/08/2026 la 0.9.11 e' stata pubblicata
// con `version.json` a `0.9.10`: il bundle era stato costruito PRIMA del bump,
// e `vite.config.js` scrive quel file da `pkg.version` **al momento della
// build**. Il pacchetto era coerente in tutto il resto — package.json,
// package-lock, processo server — e l'unico byte sbagliato bastava a far
// dire alla UI «incomplete installation: frontend and server do not match».
//
// Il controllo esisteva gia', ma **solo dentro una lista di verifiche fatte a
// mano** (si legge nei referti di prerilascio dalla 0.8.2 in poi). Una verifica
// che vive solo in una checklist non e' una guardia: salta il giorno in cui
// qualcuno ha fretta. Questa invece fallisce da sola.
//
// L'ordine giusto e' UNO: si alza la versione, POI si costruisce.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('frontend/dist/version.json dichiara la stessa versione di package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const distFile = path.join(root, 'frontend', 'dist', 'version.json');

  // Il file DEVE esserci: se manca, il server non ha nulla da confrontare e la
  // guardia non deve passare in silenzio per assenza di prova.
  assert.ok(fs.existsSync(distFile), `manca ${distFile}: il bundle non e' stato costruito`);

  const dist = JSON.parse(fs.readFileSync(distFile, 'utf8'));
  assert.strictEqual(
    dist.version,
    pkg.version,
    `il bundle dichiara ${dist.version} e il pacchetto ${pkg.version}: ` +
      'ricostruisci il frontend DOPO aver alzato la versione'
  );
});
