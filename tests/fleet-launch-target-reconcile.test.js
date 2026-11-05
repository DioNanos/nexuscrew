'use strict';
// Il commit della riconciliazione (quarantena + journal) e il lock di scrittore,
// sul solo modulo del record: filesystem temporaneo, guasti iniettati dal lato
// del test, nessun runtime e nessun tmux.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const lt = require('../lib/fleet/launch-target.js');
const lock = require('../lib/fleet/launch-writer-lock.js');

const SESSIONE = 'cloud-Riconcilia';
const LID = 'ab'.repeat(8);
const ALTRO = 'cd'.repeat(8);

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lt-rec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = lt.registraPrepared(root, SESSIONE, {
    launchId: LID, family: 'other', cellId: 'Riconcilia', tmuxSocket: '/tmp/nc-sock', daemonInc: 'inc-1',
  });
  assert.equal(r.ok, true);
  const file = path.join(root, 'launch-targets', `${SESSIONE}.json`);
  const bytes = fs.readFileSync(file);
  return {
    root, file, bytes, sha: crypto.createHash('sha256').update(bytes).digest('hex'),
    quarantena: lt.percorsoQuarantena(root, SESSIONE, LID),
    journal: lt.percorsoJournal(root, SESSIONE),
    atteso: { launchId: LID, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), fase: 'prepared' },
  };
}

function conGuasto(fn, quando, eseguito) {
  const originale = fs[fn];
  let n = 0;
  fs[fn] = function guasta(...args) {
    n += 1;
    if (quando(n, args)) throw Object.assign(new Error(`guasto iniettato in ${fn}`), { code: 'EIO' });
    return originale.apply(this, args);
  };
  try { return eseguito(); } finally { fs[fn] = originale; }
}

test('commit: quarantena identica, record tolto, journal rimosso, permessi privati', (t) => {
  const w = mondo(t);
  const r = lt.riconciliaRecord(w.root, SESSIONE, w.atteso);
  assert.deepStrictEqual(r, { ok: true });
  assert.equal(fs.existsSync(w.file), false);
  assert.deepStrictEqual(fs.readFileSync(w.quarantena), w.bytes);
  assert.equal(fs.statSync(w.quarantena).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(w.quarantena)).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(w.journal), false);
  assert.equal(lt.completaCommit(w.root, SESSIONE).stato, 'nessuno');
});

test('commit: byte, launchId o fase cambiati prima del commit => nulla viene toccato', (t) => {
  for (const guasto of [
    (w) => ({ ...w.atteso, sha256: '0'.repeat(64) }),
    (w) => ({ ...w.atteso, launchId: ALTRO }),
    (w) => ({ ...w.atteso, fase: 'creating' }),
  ]) {
    const w = mondo(t);
    const r = lt.riconciliaRecord(w.root, SESSIONE, guasto(w));
    assert.equal(r.ok, false);
    assert.equal(r.codice, 'cambiato');
    assert.deepStrictEqual(fs.readFileSync(w.file), w.bytes);
    assert.equal(fs.existsSync(w.quarantena), false);
    assert.equal(fs.existsSync(w.journal), false);
  }
});

test('commit: il record riscritto fra lettura e commit (stessa sessione) non si cancella', (t) => {
  const w = mondo(t);
  // Un altro scrittore avanza il record dopo che i byte sono stati letti.
  assert.ok(lt.avanza(w.root, SESSIONE, { launchId: LID, da: 'prepared', a: 'creating' }).ok);
  const r = lt.riconciliaRecord(w.root, SESSIONE, w.atteso);
  assert.equal(r.ok, false);
  assert.equal(r.codice, 'cambiato');
  assert.equal(lt.leggi(w.root, SESSIONE).record.phase, 'creating');
});

test('quarantena gia\' esistente con byte IDENTICI: ripresa verificata', (t) => {
  const w = mondo(t);
  fs.mkdirSync(path.dirname(w.quarantena), { recursive: true, mode: 0o700 });
  fs.writeFileSync(w.quarantena, w.bytes, { mode: 0o600 });
  const r = lt.riconciliaRecord(w.root, SESSIONE, w.atteso);
  assert.deepStrictEqual(r, { ok: true });
  assert.equal(fs.existsSync(w.file), false);
});

test('quarantena gia\' esistente con byte DIVERSI: blocco, mai sovrascritta, record intatto', (t) => {
  const w = mondo(t);
  fs.mkdirSync(path.dirname(w.quarantena), { recursive: true, mode: 0o700 });
  fs.writeFileSync(w.quarantena, 'altro contenuto\n', { mode: 0o600 });
  const r = lt.riconciliaRecord(w.root, SESSIONE, w.atteso);
  assert.equal(r.ok, false);
  assert.equal(r.codice, 'quarantena-diversa');
  assert.equal(r.incompleto, true);
  assert.equal(fs.readFileSync(w.quarantena, 'utf8'), 'altro contenuto\n', 'nessuna sovrascrittura');
  assert.deepStrictEqual(fs.readFileSync(w.file), w.bytes, 'record intatto');
  // Il journal e' una barriera: finche' c'e' nessun lancio parte, e si sblocca solo togliendo l'estraneo.
  assert.equal(lt.completaCommit(w.root, SESSIONE).stato, 'bloccato');
  fs.unlinkSync(w.quarantena);
  assert.equal(lt.completaCommit(w.root, SESSIONE).stato, 'completato');
  assert.equal(fs.existsSync(w.file), false);
  assert.deepStrictEqual(fs.readFileSync(w.quarantena), w.bytes);
});

test('directory di quarantena con permessi larghi o non nostra: blocco', (t) => {
  const w = mondo(t);
  fs.mkdirSync(path.dirname(w.quarantena), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.dirname(w.quarantena), 0o755);
  const r = lt.riconciliaRecord(w.root, SESSIONE, w.atteso);
  assert.equal(r.ok, false);
  assert.equal(r.codice, 'dir-quarantena');
  assert.deepStrictEqual(fs.readFileSync(w.file), w.bytes);
});

// --- Guasti uno per punto -------------------------------------------------

test('guasto nel journal: il record non viene toccato', (t) => {
  const w = mondo(t);
  const r = conGuasto('renameSync', () => true, () => lt.riconciliaRecord(w.root, SESSIONE, w.atteso));
  assert.equal(r.ok, false);
  assert.equal(r.codice, 'journal');
  assert.deepStrictEqual(fs.readFileSync(w.file), w.bytes);
  assert.equal(fs.existsSync(w.quarantena), false);
});

test('guasto nel backup (fsync del file): record intatto, ripresa idempotente dopo', (t) => {
  const w = mondo(t);
  // fsync: 1 = tmp del journal, poi directory del journal ..., poi il file della quarantena.
  let visti = 0;
  const r = conGuasto('fsyncSync', () => {
    visti += 1;
    return visti >= 4; // dal quarto fsync (file di quarantena) in poi
  }, () => lt.riconciliaRecord(w.root, SESSIONE, w.atteso));
  assert.equal(r.ok, false);
  assert.equal(r.incompleto, true);
  assert.deepStrictEqual(fs.readFileSync(w.file), w.bytes, 'prima del backup completo il record non si tocca');
  assert.ok(fs.existsSync(w.journal), 'la barriera e\' sul disco');
  const ripresa = lt.completaCommit(w.root, SESSIONE);
  assert.equal(ripresa.stato, 'completato', JSON.stringify(ripresa));
  assert.equal(fs.existsSync(w.file), false);
  assert.deepStrictEqual(fs.readFileSync(w.quarantena), w.bytes);
});

test('unlink fallito: record presente, journal presente, ripresa dopo', (t) => {
  const w = mondo(t);
  const r = conGuasto('unlinkSync', (n, a) => String(a[0]).endsWith(`${SESSIONE}.json`), () => lt.riconciliaRecord(w.root, SESSIONE, w.atteso));
  assert.equal(r.ok, false);
  assert.equal(r.codice, 'unlink');
  assert.equal(r.incompleto, true);
  assert.ok(fs.existsSync(w.file));
  assert.ok(fs.existsSync(w.journal));
  assert.equal(lt.completaCommit(w.root, SESSIONE).stato, 'completato');
  assert.equal(fs.existsSync(w.file), false);
  assert.equal(fs.existsSync(w.journal), false);
});

test('unlink riuscito ma fsync della directory fallito: esito INCERTO, barriera durevole fino al completamento', (t) => {
  const w = mondo(t);
  const originale = fs.unlinkSync;
  let fatto = false;
  fs.unlinkSync = function osserva(...a) {
    const r = originale.apply(this, a);
    if (String(a[0]).endsWith(`${SESSIONE}.json`)) fatto = true;
    return r;
  };
  let r;
  try {
    r = conGuasto('fsyncSync', () => fatto, () => lt.riconciliaRecord(w.root, SESSIONE, w.atteso));
  } finally { fs.unlinkSync = originale; }
  assert.equal(r.ok, false);
  assert.equal(r.codice, 'fsync-incerto');
  assert.equal(r.incompleto, true, 'non «record sicuramente presente», non «sicuramente tolto»');
  assert.equal(fs.existsSync(w.file), false);
  assert.ok(fs.existsSync(w.journal), 'barriera durevole di commit incompleto');
  // finche' l'fsync guasta resta bloccato; poi si completa
  const ancora = conGuasto('fsyncSync', () => true, () => lt.completaCommit(w.root, SESSIONE));
  assert.equal(ancora.stato, 'bloccato');
  assert.equal(lt.completaCommit(w.root, SESSIONE).stato, 'completato');
  assert.equal(fs.existsSync(w.journal), false);
  assert.deepStrictEqual(fs.readFileSync(w.quarantena), w.bytes);
});

test('completaCommit: journal non valido, di altra sessione, con quarantena mancante o diversa => bloccato', (t) => {
  const w = mondo(t);
  const scrivi = (o) => fs.writeFileSync(w.journal, typeof o === 'string' ? o : JSON.stringify(o));
  const valido = { v: 1, sessione: SESSIONE, launchId: LID, sha256: w.sha, quarantena: path.relative(path.join(w.root, 'launch-targets'), w.quarantena) };
  scrivi('{ non json');
  assert.equal(lt.completaCommit(w.root, SESSIONE).stato, 'bloccato');
  scrivi({ ...valido, sessione: 'cloud-Altra' });
  assert.equal(lt.completaCommit(w.root, SESSIONE).stato, 'bloccato');
  scrivi({ ...valido, quarantena: '../fuori.json' });
  assert.equal(lt.completaCommit(w.root, SESSIONE).stato, 'bloccato', 'il percorso della quarantena e\' derivato, non fidato');
  scrivi({ ...valido, sha256: '0'.repeat(64) });
  assert.equal(lt.completaCommit(w.root, SESSIONE).stato, 'bloccato', 'il record sul disco non e\' piu\' quello del journal');
  fs.unlinkSync(w.file);
  scrivi(valido);
  assert.equal(lt.completaCommit(w.root, SESSIONE).stato, 'bloccato', 'record tolto e quarantena mancante');
  fs.mkdirSync(path.dirname(w.quarantena), { recursive: true, mode: 0o700 });
  fs.writeFileSync(w.quarantena, 'diverso', { mode: 0o600 });
  assert.equal(lt.completaCommit(w.root, SESSIONE).stato, 'bloccato', 'quarantena diversa');
});

test('leggiGrezzo: byte e sha256, assente e indeterminato distinti', (t) => {
  const w = mondo(t);
  const g = lt.leggiGrezzo(w.root, SESSIONE);
  assert.equal(g.stato, 'presente');
  assert.equal(g.sha256, w.sha);
  assert.equal(lt.leggiGrezzo(w.root, 'cloud-Nessuna').stato, 'assente');
  assert.equal(lt.leggiGrezzo(w.root, '../x').stato, 'indeterminato');
  assert.equal(lt.leggiGrezzo('', SESSIONE).stato, 'indeterminato');
});

test('il prefisso del nome della quarantena include launchId e sessione: due lanci non si sovrascrivono', (t) => {
  const w = mondo(t);
  assert.notEqual(lt.percorsoQuarantena(w.root, SESSIONE, LID), lt.percorsoQuarantena(w.root, SESSIONE, ALTRO));
  assert.notEqual(lt.percorsoQuarantena(w.root, SESSIONE, LID), lt.percorsoQuarantena(w.root, 'cloud-Altra', LID));
});

// --- lock di scrittore -------------------------------------------------------

test('lock di scrittore: acquisizione, rientro dello stesso processo, rilascio col token', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = lock.acquisisci(root);
  assert.equal(a.ok, true);
  const b = lock.acquisisci(root);
  assert.equal(b.ok, true, 'lo stesso processo puo\' tenere piu\' runtime sulla radice');
  assert.equal(lock.rilascia(root, 'token-sbagliato'), false);
  assert.equal(lock.rilascia(root, a.token), true);
  assert.equal(fs.existsSync(path.join(root, 'launch-targets', lock.NOME)), false);
});

test('lock di scrittore: file illeggibile o di un processo VIVO e diverso => conflitto; di un processo morto => ripreso', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'launch-targets', lock.NOME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ non json');
  assert.equal(lock.acquisisci(root).codice, 'illeggibile');
  // pid 1 (init) e' vivo e non e' il nostro processo
  fs.writeFileSync(file, JSON.stringify({ v: 1, pid: 1, starttime: null, token: 'x' }));
  const vivo = lock.acquisisci(root);
  assert.equal(vivo.ok, false);
  assert.equal(vivo.codice, 'altro-scrittore');
  // un pid inesistente: ripreso
  fs.writeFileSync(file, JSON.stringify({ v: 1, pid: 2 ** 22 - 3, starttime: 5, token: 'x' }));
  assert.equal(lock.acquisisci(root).ok, true);
});
