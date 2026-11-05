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

test('lock di scrittore: acquisizione, rientro dello stesso processo contato, rilascio col token', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'launch-targets', lock.NOME);
  const a = lock.acquisisci(root);
  assert.equal(a.ok, true);
  const b = lock.acquisisci(root);
  assert.equal(b.ok, true, 'lo stesso processo puo\' tenere piu\' runtime sulla radice');
  assert.equal(lock.rilascia(root, 'token-sbagliato'), false);
  assert.equal(lock.rilascia(root, a.token), true);
  assert.equal(fs.existsSync(file), true, 'finche\' resta un possessore il file resta');
  assert.equal(lock.verifica(root, a.token), true);
  assert.equal(lock.rilascia(root, b.token), true);
  assert.equal(fs.existsSync(file), false);
});

test('lock di scrittore: file illeggibile o di un processo VIVO e diverso => conflitto; di un processo morto => ripreso', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'launch-targets', lock.NOME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ non json', { mode: 0o600 });
  assert.equal(lock.acquisisci(root).codice, 'illeggibile');
  // pid 1 (init) e' vivo e non e' il nostro processo
  fs.writeFileSync(file, JSON.stringify({ v: 1, pid: 1, starttime: null, token: 'x' }), { mode: 0o600 });
  const vivo = lock.acquisisci(root);
  assert.equal(vivo.ok, false);
  assert.equal(vivo.codice, 'altro-scrittore');
  // un pid inesistente: ripreso
  fs.writeFileSync(file, JSON.stringify({ v: 1, pid: 2 ** 22 - 3, starttime: 5, token: 'x' }), { mode: 0o600 });
  assert.equal(lock.acquisisci(root).ok, true);
});


// --- P1B-01: esclusione vera ------------------------------------------------

const { spawn } = require('node:child_process');
const CHILD_LOCK = path.join(__dirname, 'helpers', 'lock-race-child.cjs');

function avviaFiglioLock(spec) {
  const proc = spawn(process.execPath, [CHILD_LOCK, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  const esito = new Promise((resolve) => proc.on('close', () => resolve(out)));
  const primaRiga = () => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (out.includes('\n')) { clearInterval(iv); resolve(JSON.parse(out.split('\n')[0])); }
      else if (Date.now() - t0 > 20000) { clearInterval(iv); reject(new Error('figlio lock senza risposta')); }
    }, 10);
  });
  return { proc, esito, primaRiga };
}
async function aspetta(cond, ms = 20000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('attesa scaduta');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('lock di scrittore: due processi fermati PRIMA della pubblicazione sul primo avvio => uno solo ottiene ok', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-'));
  const bar = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-bar-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bar, { recursive: true, force: true }); });
  const spec = { root, tieni: true, barriera: { dir: bar, bersaglio: lock.NOME } };
  const f = [avviaFiglioLock(spec), avviaFiglioLock(spec)];
  try {
    await aspetta(() => fs.readdirSync(bar).filter((n) => n.startsWith('pronto.')).length === 2);
    fs.writeFileSync(path.join(bar, 'via'), '');
    const esiti = [await f[0].primaRiga(), await f[1].primaRiga()];
    assert.equal(esiti.filter((e) => e.ok).length, 1, JSON.stringify(esiti));
    assert.equal(esiti.filter((e) => !e.ok && e.codice === 'altro-scrittore').length, 1, JSON.stringify(esiti));
  } finally {
    for (const x of f) { try { process.kill(x.proc.pid, 'SIGKILL'); } catch (_) { /* gia' uscito */ } }
    await Promise.all(f.map((x) => x.esito));
  }
});

test('lock di scrittore: recupero SIMULTANEO di un lock morto => uno solo ottiene ok', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-'));
  const bar = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-bar-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bar, { recursive: true, force: true }); });
  const file = path.join(root, 'launch-targets', lock.NOME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, pid: 2 ** 22 - 3, starttime: 5, token: 'morto' }), { mode: 0o600 });
  const spec = { root, tieni: true, barriera: { dir: bar, bersaglio: lock.NOME_MUTEX } };
  const f = [avviaFiglioLock(spec), avviaFiglioLock(spec)];
  try {
    await aspetta(() => fs.readdirSync(bar).filter((n) => n.startsWith('pronto.')).length === 2);
    fs.writeFileSync(path.join(bar, 'via'), '');
    const esiti = [await f[0].primaRiga(), await f[1].primaRiga()];
    assert.equal(esiti.filter((e) => e.ok).length, 1, JSON.stringify(esiti));
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.notEqual(d.token, 'morto');
    assert.ok([f[0].proc.pid, f[1].proc.pid].includes(d.pid), 'il lock sul disco e\' del vincitore');
  } finally {
    for (const x of f) { try { process.kill(x.proc.pid, 'SIGKILL'); } catch (_) { /* gia' uscito */ } }
    await Promise.all(f.map((x) => x.esito));
  }
});

test('lock di scrittore: due possessori nello stesso processo, il primo rilascia => un terzo processo resta escluso', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = lock.acquisisci(root);
  const b = lock.acquisisci(root);
  assert.equal(a.ok && b.ok, true);
  assert.equal(lock.rilascia(root, a.token), true);
  const terzo = avviaFiglioLock({ root });
  const out1 = JSON.parse((await terzo.esito).split('\n')[0]);
  assert.equal(out1.ok, false, 'il secondo possessore non ha rilasciato: il lock tiene');
  assert.equal(out1.codice, 'altro-scrittore');
  assert.equal(lock.rilascia(root, b.token), true);
  const quarto = avviaFiglioLock({ root });
  assert.equal(JSON.parse((await quarto.esito).split('\n')[0]).ok, true);
});

test('lock di scrittore: file non regolare, link o di modo diverso da 0600 => illeggibile, mai ripreso', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'launch-targets', lock.NOME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const contenuto = JSON.stringify({ v: 1, pid: 2 ** 22 - 3, starttime: 5, token: 'x' });
  fs.writeFileSync(file, contenuto, { mode: 0o644 });
  assert.equal(lock.acquisisci(root).codice, 'illeggibile');
  fs.unlinkSync(file);
  const fuori = path.join(root, 'fuori.json');
  fs.writeFileSync(fuori, contenuto, { mode: 0o600 });
  fs.symlinkSync(fuori, file);
  assert.equal(lock.acquisisci(root).codice, 'illeggibile');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true, 'il link estraneo non si tocca');
});

test('lock di scrittore: il mutex di takeover rimasto di un processo morto non si scavalca (fallisce chiuso)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'launch-targets');
  fs.mkdirSync(dir, { recursive: true });
  const morto = JSON.stringify({ v: 1, pid: 2 ** 22 - 3, starttime: 5, token: 'x' });
  fs.writeFileSync(path.join(dir, lock.NOME), morto, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, lock.NOME_MUTEX), morto, { mode: 0o600 });
  const r = lock.acquisisci(root);
  assert.equal(r.ok, false);
  assert.equal(r.codice, 'takeover');
});

// --- P1B-04: quarantena qualificata e padre sincronizzato -------------------

test('EEXIST: backup identico ma 0644 => bloccato, record e backup intatti', (t) => {
  const w = mondo(t);
  fs.mkdirSync(path.dirname(w.quarantena), { recursive: true, mode: 0o700 });
  fs.writeFileSync(w.quarantena, w.bytes, { mode: 0o644 });
  fs.chmodSync(w.quarantena, 0o644);
  const r = lt.riconciliaRecord(w.root, SESSIONE, w.atteso);
  assert.equal(r.ok, false);
  assert.equal(r.codice, 'quarantena-non-qualificata');
  assert.deepStrictEqual(fs.readFileSync(w.file), w.bytes);
  assert.equal(fs.statSync(w.quarantena).mode & 0o777, 0o644, 'l\'estraneo non si modifica');
});

test('EEXIST: backup identico ma symlink => bloccato, record intatto, link intatto', (t) => {
  const w = mondo(t);
  fs.mkdirSync(path.dirname(w.quarantena), { recursive: true, mode: 0o700 });
  const fuori = path.join(w.root, 'esterno.json');
  fs.writeFileSync(fuori, w.bytes, { mode: 0o600 });
  fs.symlinkSync(fuori, w.quarantena);
  const r = lt.riconciliaRecord(w.root, SESSIONE, w.atteso);
  assert.equal(r.ok, false);
  assert.equal(r.codice, 'quarantena-non-qualificata');
  assert.deepStrictEqual(fs.readFileSync(w.file), w.bytes);
  assert.equal(fs.lstatSync(w.quarantena).isSymbolicLink(), true);
});

test('ripresa dopo l\'unlink con backup non qualificato (0644 o symlink) => bloccato', (t) => {
  for (const tipo of ['0644', 'symlink', 'hardlink']) {
    const w = mondo(t);
    fs.mkdirSync(path.dirname(w.quarantena), { recursive: true, mode: 0o700 });
    if (tipo === '0644') { fs.writeFileSync(w.quarantena, w.bytes); fs.chmodSync(w.quarantena, 0o644); }
    if (tipo === 'symlink') {
      const fuori = path.join(w.root, 'esterno.json');
      fs.writeFileSync(fuori, w.bytes, { mode: 0o600 });
      fs.symlinkSync(fuori, w.quarantena);
    }
    if (tipo === 'hardlink') {
      const fuori = path.join(w.root, 'esterno.json');
      fs.writeFileSync(fuori, w.bytes, { mode: 0o600 });
      fs.linkSync(fuori, w.quarantena);
    }
    const journal = { v: 1, sessione: SESSIONE, launchId: LID, sha256: w.sha, quarantena: path.relative(path.join(w.root, 'launch-targets'), w.quarantena) };
    fs.writeFileSync(w.journal, JSON.stringify(journal));
    fs.unlinkSync(w.file);
    const r = lt.completaCommit(w.root, SESSIONE);
    assert.equal(r.stato, 'bloccato', tipo);
    assert.equal(r.codice, 'quarantena-non-qualificata', tipo);
    assert.ok(fs.existsSync(w.journal), `${tipo}: la barriera resta`);
  }
});

test('ordine fs: il padre della directory di backup nuova e\' sincronizzato PRIMA dell\'unlink del record', (t) => {
  const w = mondo(t);
  const dirRecord = path.join(w.root, 'launch-targets');
  const eventi = [];
  const aperti = new Map();
  const oOpen = fs.openSync; const oFsync = fs.fsyncSync; const oUnlink = fs.unlinkSync; const oMkdir = fs.mkdirSync;
  fs.openSync = function (...a) { const fd = oOpen.apply(this, a); aperti.set(fd, String(a[0])); return fd; };
  fs.fsyncSync = function (fd) { eventi.push(`fsync:${aperti.get(fd)}`); return oFsync.call(this, fd); };
  fs.unlinkSync = function (...a) { eventi.push(`unlink:${a[0]}`); return oUnlink.apply(this, a); };
  fs.mkdirSync = function (...a) { eventi.push(`mkdir:${a[0]}`); return oMkdir.apply(this, a); };
  try {
    assert.equal(lt.riconciliaRecord(w.root, SESSIONE, w.atteso).ok, true);
  } finally { fs.openSync = oOpen; fs.fsyncSync = oFsync; fs.unlinkSync = oUnlink; fs.mkdirSync = oMkdir; }
  const iMk = eventi.indexOf(`mkdir:${path.dirname(w.quarantena)}`);
  const iUn = eventi.indexOf(`unlink:${w.file}`);
  assert.ok(iMk >= 0 && iUn > iMk, JSON.stringify(eventi));
  const fsyncPadre = eventi.slice(iMk, iUn).filter((e) => e === `fsync:${dirRecord}`);
  assert.ok(fsyncPadre.length >= 1, `nessun fsync del padre fra mkdir e unlink: ${JSON.stringify(eventi)}`);
});

test('fsync del padre della directory nuova fallito => il record resta, nessuna quarantena accettata', (t) => {
  const w = mondo(t);
  const dirRecord = path.join(w.root, 'launch-targets');
  const aperti = new Map();
  const oOpen = fs.openSync; const oFsync = fs.fsyncSync;
  let nelPadre = 0;
  fs.openSync = function (...a) { const fd = oOpen.apply(this, a); aperti.set(fd, String(a[0])); return fd; };
  fs.fsyncSync = function (fd) {
    if (aperti.get(fd) === dirRecord) {
      nelPadre += 1;
      if (nelPadre >= 2) throw Object.assign(new Error('guasto'), { code: 'EIO' }); // il 1o e' del journal
    }
    return oFsync.call(this, fd);
  };
  let r;
  try { r = lt.riconciliaRecord(w.root, SESSIONE, w.atteso); } finally { fs.openSync = oOpen; fs.fsyncSync = oFsync; }
  assert.equal(r.ok, false);
  assert.deepStrictEqual(fs.readFileSync(w.file), w.bytes, 'il record non si tocca');
});
