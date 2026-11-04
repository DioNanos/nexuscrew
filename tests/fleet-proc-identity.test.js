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
  // 28 zeri separati da spazio, nessuna parentesi: non e' nascita 0
  const zeri = Array(28).fill('0').join(' ');
  const daZeri = leggiIdentitaProc(4242, { leggiStat: () => zeri });
  assert.equal(daZeri.esito, 'indeterminata');
  assert.equal(daZeri.nascita, null);
  // stat reale con il solo token starttime svuotato: Number('') non e' 0
  const svuotato = '4242 (nome con spazio) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0  0 0\n';
  const daVuoto = leggiIdentitaProc(4242, { leggiStat: () => svuotato });
  assert.equal(daVuoto.esito, 'indeterminata');
  assert.equal(daVuoto.nascita, null);
  // spazio doppio dopo lo stato: la colonna vuota non fa leggere itrealvalue come nascita
  const dopoStato = '4242 (nome) S  1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 777 0 0\n';
  const daDopo = leggiIdentitaProc(4242, { leggiStat: () => dopoStato });
  assert.equal(daDopo.esito, 'indeterminata');
  assert.equal(daDopo.nascita, null);
  // spazio doppio prima di un'altra colonna numerica, ancora prima della nascita
  const prima = '4242 (nome) S 1  1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 777 0 0\n';
  const daPrima = leggiIdentitaProc(4242, { leggiStat: () => prima });
  assert.equal(daPrima.esito, 'indeterminata');
  assert.equal(daPrima.nascita, null);
  // starttime non numerico, decimale, esponente, segno, arrotondato
  const nonNumerico = '4242 (x) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 non-un-numero 0 0\n';
  assert.equal(
    leggiIdentitaProc(4242, { leggiStat: () => nonNumerico }).esito,
    'indeterminata',
  );
  for (const token of ['1.5', '1e2', '+10', '-1', '9007199254740993']) {
    const riga = `4242 (x) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 ${token} 0 0\n`;
    const id = leggiIdentitaProc(4242, { leggiStat: () => riga });
    assert.equal(id.esito, 'indeterminata', token);
    assert.equal(id.nascita, null, token);
  }
  // un valore non-stringa non e' uno stat
  assert.equal(
    leggiIdentitaProc(4242, { leggiStat: () => Buffer.from('x') }).esito,
    'indeterminata',
  );
  // lo zero vero, come token, resta una nascita valida: e' il vuoto a essere rifiutato
  const zeroVero = '4242 (x) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n';
  const daZero = leggiIdentitaProc(4242, { leggiStat: () => zeroVero });
  assert.equal(daZero.esito, 'presente');
  assert.equal(daZero.nascita, 0);
});
