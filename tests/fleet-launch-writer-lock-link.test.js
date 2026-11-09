'use strict';
// Il gemello CON IL LINK VERO dei test sull'fsync ESTERNO della cartella del
// lock di scrittore (i T8/T9 di fleet-launch-writer-lock-nolink.test.js).
// Dove link(2) funziona, pubblicaEsclusivo non fsynca la cartella: l'UNICO
// fsync della cartella in tutta acquisisci e' quello che resta FUORI, dopo la
// pubblicazione riuscita (acquisizione iniziale e takeover del mutex). Se
// quello fallisce, il file pubblicato e' completo, con il NOSTRO pid e token,
// ma nessun possessore e' registrato: senza pulizia resta per sempre e il
// processo STESSO viene poi respinto come 'altro-scrittore' fino al riavvio.
// Il difetto e' piu' vecchio del ripiego senza link: qui si prova per strada.
//
// Stessa iniezione della probe: fd tracciati per percorso, EIO sull'fsync
// numero N della cartella (qui sempre 1). Tutto il resto del fs resta vero.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const lock = require('../lib/fleet/launch-writer-lock.js');
const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');

// --- mondo di prova --------------------------------------------------------

function radiceNuova() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-link-'));
}

function fileLock(root) {
  return path.join(root, 'launch-targets', lock.NOME);
}

function leggiFileLock(root) {
  const grezzo = fs.readFileSync(fileLock(root), 'utf8');
  return { grezzo, dato: JSON.parse(grezzo), st: fs.statSync(fileLock(root)) };
}

function figlioVivo(t) {
  const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000);'], { detached: true, stdio: 'ignore' });
  f.unref();
  t.after(() => { try { process.kill(f.pid, 'SIGKILL'); } catch (_) { /* gia' uscito */ } });
  return f;
}

// Ferma per PID esatto e ATTENDE la scomparsa senza bloccare l'event loop.
async function morto(pid) {
  process.kill(pid, 'SIGKILL');
  const fine = Date.now() + 5000;
  while (Date.now() < fine) {
    try { process.kill(pid, 0); } catch (_) { return; }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Scrive a mano il lock di un ALTRO processo, nei byte e nel modo che leggi()
// accetta (JSON completo, 0600).
function scriviLockDi(root, dato) {
  const dir = path.join(root, 'launch-targets');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, lock.NOME);
  fs.writeFileSync(file, `${JSON.stringify(dato)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// Lock di un processo DAVVERO morto: spawn, nascita letta mentre e' vivo,
// poi attesa della scomparsa (serve al percorso di takeover).
async function datoDiUnMorto(t) {
  const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000);'], { detached: true, stdio: 'ignore' });
  f.unref();
  const nascita = leggiStarttimeProc(f.pid);
  await morto(f.pid);
  return { v: 1, pid: f.pid, starttime: nascita, token: 'defunto' };
}

// --- seam -------------------------------------------------------------------

const openSyncVero = fs.openSync;
const fsyncSyncVero = fs.fsyncSync;
const writeFileSyncVero = fs.writeFileSync;

// EIO sull'fsync numero `numero` della cartella dei lanci: con il link vero
// e' sempre il primo, quello esterno dopo la pubblicazione riuscita.
// `primaDelGuasto` consente di far subentrare un altro scrittore nel punto
// esatto del guasto (T9).
function guastoSulFsyncDirNumero(t, root, numero, primaDelGuasto) {
  const dir = path.join(root, 'launch-targets');
  const fdAPercorso = new Map();
  let visti = 0;
  fs.openSync = function (p, ...a) {
    const fd = openSyncVero.call(fs, p, ...a);
    fdAPercorso.set(fd, String(p));
    return fd;
  };
  fs.fsyncSync = function (fd) {
    if (fdAPercorso.get(fd) === dir && (visti += 1) === numero) {
      if (primaDelGuasto) primaDelGuasto();
      const e = new Error(`seam: EIO sull'fsync esterno della cartella (n ${numero})`);
      e.code = 'EIO';
      throw e;
    }
    return fsyncSyncVero.call(fs, fd);
  };
  t.after(() => {
    fs.openSync = openSyncVero;
    fs.fsyncSync = fsyncSyncVero;
  });
}

// Nel punto del guasto un ALTRO scrittore prende il nome dest: dest passa a un
// file suo, con un token suo.
function scambiaDestConAltro(dest, datoAltro) {
  return () => {
    fs.unlinkSync(dest);
    writeFileSyncVero.call(fs, dest, `${JSON.stringify(datoAltro)}\n`, { mode: 0o600 });
    fs.chmodSync(dest, 0o600);
  };
}

// --- T8: dopo il guasto non resta lock nostro, e lo STESSO processo riprova -

test('T8 link acquisizione: EIO sull\'unico fsync della cartella, nessun lock nostro resta e lo STESSO processo riprova pulito', (t) => {
  const root = radiceNuova();
  guastoSulFsyncDirNumero(t, root, 1);
  const r1 = lock.acquisisci(root);
  assert.notEqual(r1.ok, true, 'il rifiuto al guasto resta sicuro');
  assert.equal(r1.codice, 'scrittura', JSON.stringify(r1));
  assert.equal(fs.existsSync(fileLock(root)), false, 'il lock pubblicato ma non registrato non deve restare a terra');
  assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')), [], 'la cartella torna vuota, senza temporanei');
  // il guasto e' passato: lo STESSO processo deve poter ripartire, non trovarsi
  // davanti il proprio lock come 'altro-scrittore'
  const r2 = lock.acquisisci(root);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const { dato } = leggiFileLock(root);
  assert.equal(dato.token, r2.token);
  assert.equal(dato.pid, process.pid);
  assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')), [lock.NOME]);
  assert.equal(lock.rilascia(root, r2.token), true);
});

test('T8 link takeover: EIO sull\'unico fsync della cartella, nessun lock nostro resta e lo STESSO processo riprova pulito', async (t) => {
  const root = radiceNuova();
  scriviLockDi(root, await datoDiUnMorto(t));
  guastoSulFsyncDirNumero(t, root, 1);
  const r1 = lock.acquisisci(root);
  assert.notEqual(r1.ok, true, 'il rifiuto al guasto resta sicuro');
  assert.equal(r1.codice, 'scrittura', JSON.stringify(r1));
  assert.equal(fs.existsSync(fileLock(root)), false, 'il lock pubblicato ma non registrato non deve restare a terra');
  assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')), [], 'neanche il mutex di takeover deve restare');
  const r2 = lock.acquisisci(root);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const { dato } = leggiFileLock(root);
  assert.equal(dato.token, r2.token);
  assert.equal(dato.pid, process.pid);
  assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')), [lock.NOME]);
  assert.equal(lock.rilascia(root, r2.token), true);
});

// --- T9: il lock di un ALTRO, con token diverso, non viene mai toccato ------

test('T9 link acquisizione: un lock altrui con token diverso non viene mai toccato', (t) => {
  const root = radiceNuova();
  const vivo = figlioVivo(t);
  const altrui = { v: 1, pid: vivo.pid, starttime: leggiStarttimeProc(vivo.pid), token: 'altrui' };
  guastoSulFsyncDirNumero(t, root, 1, scambiaDestConAltro(fileLock(root), altrui));
  const r1 = lock.acquisisci(root);
  assert.notEqual(r1.ok, true);
  assert.equal(r1.codice, 'scrittura', JSON.stringify(r1));
  // il lock dell'altro e' ancora li', intatto: stessi byte, modo 0600
  const { grezzo, st } = leggiFileLock(root);
  assert.deepEqual(JSON.parse(grezzo), altrui, 'il contenuto dell\'altro non va toccato');
  assert.equal(st.mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')), [lock.NOME]);
  // e un nuovo tentativo rifiuta SU DI LUI, senza levarlo di mezzo
  const r2 = lock.acquisisci(root);
  assert.equal(r2.ok, false, 'mai ok mentre un altro vivo tiene il lock');
  assert.equal(r2.codice, 'altro-scrittore', JSON.stringify(r2));
  assert.equal(r2.pid, vivo.pid);
  assert.deepEqual(JSON.parse(fs.readFileSync(fileLock(root), 'utf8')), altrui);
});

test('T9 link takeover: un lock altrui con token diverso non viene mai toccato', async (t) => {
  const root = radiceNuova();
  scriviLockDi(root, await datoDiUnMorto(t));
  const vivo = figlioVivo(t);
  const altrui = { v: 1, pid: vivo.pid, starttime: leggiStarttimeProc(vivo.pid), token: 'altrui' };
  guastoSulFsyncDirNumero(t, root, 1, scambiaDestConAltro(fileLock(root), altrui));
  const r1 = lock.acquisisci(root);
  assert.notEqual(r1.ok, true);
  assert.equal(r1.codice, 'scrittura', JSON.stringify(r1));
  // il lock dell'altro e' ancora li', intatto, e il mutex non resta in giro
  const { grezzo, st } = leggiFileLock(root);
  assert.deepEqual(JSON.parse(grezzo), altrui, 'il contenuto dell\'altro non va toccato');
  assert.equal(st.mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')), [lock.NOME]);
  const r2 = lock.acquisisci(root);
  assert.equal(r2.ok, false, 'mai ok mentre un altro vivo tiene il lock');
  assert.equal(r2.codice, 'altro-scrittore', JSON.stringify(r2));
  assert.equal(r2.pid, vivo.pid);
  assert.deepEqual(JSON.parse(fs.readFileSync(fileLock(root), 'utf8')), altrui);
});
