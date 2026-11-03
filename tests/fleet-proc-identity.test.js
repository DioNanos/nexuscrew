'use strict';
// Lettura TERNARIA dell'identita' di un processo (leggiIdentitaProc), il
// confine del recupero a tre prove del down: «morto PROVATO» (assenza
// ACCERTATA del numero via ENOENT, oppure pid riusato con nascita valida
// divergente) deve restare distinto da «non lo so» (EACCES, EIO, stat
// malformato: la lettura fallita NON e' una prova di morte). Il helper
// binario leggiStarttimeProc resta com'era per gli altri chiamanti: copre
// entrambi i casi con null e non cambia semantica.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { leggiStarttimeProc, leggiIdentitaProc } = require('../lib/fleet/definitions.js');

const errConCodice = (code) => { const e = new Error(code); e.code = code; return e; };

// --- positivi: presente e assenza accertata -------------------------------

test('identita: processo vivo -> presente con nascita valida, coerente col helper binario', () => {
  const id = leggiIdentitaProc(process.pid);
  assert.equal(id.esito, 'presente');
  assert.ok(Number.isFinite(id.nascita));
  assert.equal(id.nascita, leggiStarttimeProc(process.pid));
});

test('identita: ENOENT reale -> assenza accertata del numero', async () => {
  // un pid vero che non c'e' piu': figlio del test, ucciso SOLO per PID esatto
  const figlio = spawn(process.execPath, ['-e', 'process.exit(0);'], { stdio: 'ignore' });
  const pid = figlio.pid;
  await new Promise((risolvi) => figlio.on('exit', risolvi));
  const id = leggiIdentitaProc(pid);
  assert.equal(id.esito, 'assente');
  assert.equal(id.nascita, null);
  // il helper binario resta compatibile per gli altri chiamanti
  assert.equal(leggiStarttimeProc(pid), null);
});

test('identita: stat sintetico ben formato -> presente con la nascita del campo 22', () => {
  const st = '4242 (nome con spazio) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 777 0 0\n';
  const id = leggiIdentitaProc(4242, { leggiStat: () => st });
  assert.equal(id.esito, 'presente');
  assert.equal(id.nascita, 777);
});

// --- negativi: la lettura fallita non e' una prova -------------------------

test('identita: EACCES ed EIO non sono prove -> indeterminata', () => {
  for (const code of ['EACCES', 'EIO']) {
    const id = leggiIdentitaProc(4242, { leggiStat: () => { throw errConCodice(code); } });
    assert.equal(id.esito, 'indeterminata', code);
    assert.equal(id.nascita, null);
  }
});

test('identita: errore senza codice non e\' una prova -> indeterminata', () => {
  const id = leggiIdentitaProc(4242, { leggiStat: () => { throw new Error('lettura esplosa'); } });
  assert.equal(id.esito, 'indeterminata');
  assert.equal(id.nascita, null);
});

test('identita: stat malformato non e\' una prova -> indeterminata', () => {
  // senza la parentesi del comm il campo 22 non e' individuabile
  assert.equal(
    leggiIdentitaProc(4242, { leggiStat: () => 'guasto senza campi' }).esito,
    'indeterminata',
  );
  // starttime non numerico
  const nonNumerico = '4242 (x) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 non-un-numero 0 0\n';
  assert.equal(
    leggiIdentitaProc(4242, { leggiStat: () => nonNumerico }).esito,
    'indeterminata',
  );
  // un valore non-stringa non e' uno stat
  assert.equal(
    leggiIdentitaProc(4242, { leggiStat: () => Buffer.from('x') }).esito,
    'indeterminata',
  );
});
