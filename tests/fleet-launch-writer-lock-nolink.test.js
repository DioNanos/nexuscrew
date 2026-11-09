'use strict';
// Il lock di scrittore dei lanci deve funzionare anche dove link(2) e' negato:
// nelle cartelle delle app di Android/Termux fs.linkSync fallisce con EPERM
// o EACCES (non con EEXIST), e senza un ripiego pubblicaEsclusivo risponde
// esiste:false e ogni up rifiuta con codice 'scrittura'.
// La seam sostituisce fs.linkSync con un lancio controllato, per ciascuno dei
// codici che un filesystem senza hard link puo' restituire. La guardia della
// home reale non impacchetta linkSync (limiti dichiarati in
// tests/real-home-guard.cjs), quindi il valore salvato e ripristinato e'
// quello vero del modulo.
//
// T5/T6/T7 iniettano anche un guasto EIO DOPO l'open esclusivo del ripiego
// (write, fsync del file, fsync della cartella) sul lock e sul mutex: il file
// che il ripiego ha creato con le proprie mani non deve sopravvivere al
// guasto, e un file che nel frattempo e' diventato di un altro non si tocca.
//
// T8/T9 iniettano lo stesso EIO sull'fsync della cartella che resta FUORI dal
// ripiego: quello che acquisisci fa DOPO la pubblicazione riuscita. Senza
// link e' il SECONDO fsync della cartella in acquisizione (il primo e' dentro
// pubblicaEsclusivo) e il TERZO nel takeover (mutex e seconda pubblicazione).
// Il percorso con il link vero, dove quell'fsync e' l'unico, sta nel gemello
// fleet-launch-writer-lock-link.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const lock = require('../lib/fleet/launch-writer-lock.js');
const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');

// --- seam -----------------------------------------------------------------

const linkSyncVero = fs.linkSync;

function negaLink(t, codice) {
  fs.linkSync = function linkNegato() {
    const e = new Error(`seam: link(2) negato (${codice})`);
    e.code = codice;
    throw e;
  };
  t.after(() => { fs.linkSync = linkSyncVero; });
}

// --- mondo di prova --------------------------------------------------------

function radiceNuova() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-nolink-'));
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

const CODICI = ['EPERM', 'EACCES', 'ENOSYS'];

// --- T1: acquisisci riesce lo stesso --------------------------------------

for (const codice of CODICI) {
  test(`T1 ${codice}: acquisisci riesce lo stesso, lock completo e modo 0600`, (t) => {
    const root = radiceNuova();
    negaLink(t, codice);
    const r = lock.acquisisci(root);
    assert.equal(r.ok, true, JSON.stringify(r));
    const { grezzo, dato, st } = leggiFileLock(root);
    assert.equal(grezzo, `${JSON.stringify({ v: 1, pid: process.pid, starttime: leggiStarttimeProc(process.pid), token: r.token })}\n`,
      'contenuto completo, con newline finale');
    assert.equal(dato.v, 1);
    assert.equal(dato.pid, process.pid);
    assert.equal(dato.token, r.token);
    assert.ok(Number.isFinite(dato.starttime));
    assert.equal(st.mode & 0o777, 0o600, 'modo 0600');
    // nessun temporaneo dimenticato nella cartella
    assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')), [lock.NOME]);
    assert.equal(lock.rilascia(root, r.token), true);
  });
}

// --- T2: l'esclusione resta -----------------------------------------------

for (const codice of CODICI) {
  test(`T2 ${codice}: un secondo acquirente riceve altro-scrittore, mai ok, lock altrui intatto`, (t) => {
    const root = radiceNuova();
    const vivo = figlioVivo(t);
    scriviLockDi(root, { v: 1, pid: vivo.pid, starttime: leggiStarttimeProc(vivo.pid), token: 'altrui' });
    negaLink(t, codice);
    const r = lock.acquisisci(root);
    assert.notEqual(r.ok, true, 'mai ok mentre un altro scrittore vivo tiene il lock');
    assert.equal(r.codice, 'altro-scrittore', JSON.stringify(r));
    assert.equal(r.pid, vivo.pid);
    // il lock dell'altro e' intatto: stessi byte, stesso modo, nessun temporaneo
    const { grezzo, st } = leggiFileLock(root);
    assert.equal(JSON.parse(grezzo).token, 'altrui');
    assert.equal(st.mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')), [lock.NOME]);
  });
}

// --- T3: takeover di un morto senza link -----------------------------------

for (const codice of CODICI) {
  test(`T3 ${codice}: il takeover di un lock di un processo morto riesce senza link`, async (t) => {
    const root = radiceNuova();
    const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000);'], { detached: true, stdio: 'ignore' });
    f.unref();
    const nascita = leggiStarttimeProc(f.pid);
    await morto(f.pid);
    scriviLockDi(root, { v: 1, pid: f.pid, starttime: nascita, token: 'defunto' });
    negaLink(t, codice);
    const r = lock.acquisisci(root);
    assert.equal(r.ok, true, JSON.stringify(r));
    const { dato } = leggiFileLock(root);
    assert.equal(dato.token, r.token);
    assert.equal(dato.pid, process.pid);
    // il mutex di takeover non resta in giro
    assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')), [lock.NOME]);
    assert.equal(lock.rilascia(root, r.token), true);
  });
}

// --- T4: con EEXIST vero il comportamento resta quello di oggi -------------

test('T4 EEXIST vero: link reale, secondo acquirente vivo rifiutato, takeover di morto riuscito', async (t) => {
  // prima acquisizione con il link vero: pubblicato, completo, 0600, pulito
  const root1 = radiceNuova();
  const r1 = lock.acquisisci(root1);
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const { grezzo: g1, dato: d1, st: s1 } = leggiFileLock(root1);
  assert.equal(g1, `${JSON.stringify({ v: 1, pid: process.pid, starttime: leggiStarttimeProc(process.pid), token: r1.token })}\n`);
  assert.equal(s1.mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(root1, 'launch-targets')), [lock.NOME]);
  assert.equal(lock.rilascia(root1, r1.token), true);

  // lock di un vivo: l'EEXIST vero del link risponde altro-scrittore, il file resta suo
  const root2 = radiceNuova();
  const vivo = figlioVivo(t);
  scriviLockDi(root2, { v: 1, pid: vivo.pid, starttime: leggiStarttimeProc(vivo.pid), token: 'altrui' });
  const r2 = lock.acquisisci(root2);
  assert.notEqual(r2.ok, true);
  assert.equal(r2.codice, 'altro-scrittore', JSON.stringify(r2));
  assert.equal(r2.pid, vivo.pid);
  assert.equal(JSON.parse(fs.readFileSync(fileLock(root2), 'utf8')).token, 'altrui');

  // takeover di un morto con il link vero: riuscito, come oggi
  const root3 = radiceNuova();
  const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000);'], { detached: true, stdio: 'ignore' });
  f.unref();
  const nascita = leggiStarttimeProc(f.pid);
  await morto(f.pid);
  scriviLockDi(root3, { v: 1, pid: f.pid, starttime: nascita, token: 'defunto' });
  const r3 = lock.acquisisci(root3);
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.equal(leggiFileLock(root3).dato.token, r3.token);
  assert.deepEqual(fs.readdirSync(path.join(root3, 'launch-targets')), [lock.NOME]);
  assert.equal(lock.rilascia(root3, r3.token), true);
});

// --- T5/T6/T7: guasto EIO nel ripiego senza link, dopo l'open della dest ----

// Stessa iniezione del probe che ha riprodotto il difetto sul campo: si
// tracciano gli fd aperti per percorso e si lancia EIO su write, fsync del
// file o fsync della cartella,
// SOLO sulla destinazione del ripiego (lock o mutex). Tutto il resto del fs
// resta vero. `primaDelGuasto` consente di far subentrare un altro scrittore
// nel punto esatto del guasto (T6).
const openSyncVero = fs.openSync;
const writeFileSyncVero = fs.writeFileSync;
const fsyncSyncVero = fs.fsyncSync;

function guastoDopoOpen(t, root, nomeDest, stadio, primaDelGuasto) {
  const dir = path.join(root, 'launch-targets');
  const dest = path.join(dir, nomeDest);
  const fdAPercorso = new Map();
  let armato = stadio;
  fs.openSync = function (p, ...a) {
    const fd = openSyncVero.call(fs, p, ...a);
    fdAPercorso.set(fd, String(p));
    return fd;
  };
  fs.writeFileSync = function (fd, dato, ...a) {
    if (armato === 'write' && fdAPercorso.get(fd) === dest) {
      armato = null;
      if (primaDelGuasto) primaDelGuasto();
      writeFileSyncVero.call(fs, fd, String(dato).slice(0, 5));
      const e = new Error(`seam: EIO su write del ripiego (${stadio})`);
      e.code = 'EIO';
      throw e;
    }
    return writeFileSyncVero.call(fs, fd, dato, ...a);
  };
  fs.fsyncSync = function (fd) {
    const atteso = armato === 'dir-fsync' ? dir : dest;
    if ((armato === 'file-fsync' || armato === 'dir-fsync') && fdAPercorso.get(fd) === atteso) {
      armato = null;
      if (primaDelGuasto) primaDelGuasto();
      const e = new Error(`seam: EIO su fsync del ripiego (${stadio})`);
      e.code = 'EIO';
      throw e;
    }
    return fsyncSyncVero.call(fs, fd);
  };
  t.after(() => {
    fs.openSync = openSyncVero;
    fs.writeFileSync = writeFileSyncVero;
    fs.fsyncSync = fsyncSyncVero;
  });
}

// Nel punto del guasto un ALTRO scrittore prende il nome dest: il nostro fd
// resta sull'inode vecchio (che diventa orfano), dest passa a un file con un
// ino diverso e contenuto suo.
function scambiaDestConAltro(dest, datoAltro) {
  return () => {
    fs.unlinkSync(dest);
    writeFileSyncVero.call(fs, dest, `${JSON.stringify(datoAltro)}\n`, { mode: 0o600 });
    fs.chmodSync(dest, 0o600);
  };
}

function fileMutex(root) {
  return path.join(root, 'launch-targets', lock.NOME_MUTEX);
}

// Lock di un processo DAVVERO morto: spawn, nascita letta mentre e' vivo,
// poi attesa della scomparsa (serve al percorso di takeover dei test sul mutex).
async function datoDiUnMorto(t) {
  const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000);'], { detached: true, stdio: 'ignore' });
  f.unref();
  const nascita = leggiStarttimeProc(f.pid);
  await morto(f.pid);
  return { v: 1, pid: f.pid, starttime: nascita, token: 'defunto' };
}

const PERCORSO_LOCK = path.resolve(__dirname, '../lib/fleet/launch-writer-lock.js');

// Un processo NUOVO, senza link, prova ad acquisire la stessa radice: e' il
// cliente che dopo il guasto deve poter ripartire invece di ricevere per
// sempre 'illeggibile' o 'takeover'.
function processoNuovoAcquisisce(root) {
  const src = `'use strict';
const fs = require('node:fs');
fs.linkSync = function () { const e = new Error('seam: link negato'); e.code = 'EPERM'; throw e; };
const lock = require(${JSON.stringify(PERCORSO_LOCK)});
const r = lock.acquisisci(${JSON.stringify(root)});
if (r.ok) lock.rilascia(${JSON.stringify(root)}, r.token);
console.log(JSON.stringify(r));`;
  const p = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8' });
  try {
    return JSON.parse(p.stdout.trim());
  } catch (_) {
    return { ok: false, nonParsato: true, stdout: p.stdout, stderr: p.stderr };
  }
}

const STADI = ['write', 'file-fsync', 'dir-fsync'];

// --- T5: dopo il guasto non resta file nostro, e il nuovo tentativo riesce --

for (const stadio of STADI) {
  test(`T5 lock ${stadio}: dopo l'EIO niente file nostro a terra e il nuovo tentativo riesce`, (t) => {
    const root = radiceNuova();
    negaLink(t, 'EPERM');
    guastoDopoOpen(t, root, lock.NOME, stadio);
    const r1 = lock.acquisisci(root);
    assert.notEqual(r1.ok, true, 'il rifiuto al guasto resta sicuro');
    assert.equal(r1.codice, 'scrittura', JSON.stringify(r1));
    assert.equal(fs.existsSync(fileLock(root)), false, 'il guasto non deve lasciare a terra il file nostro');
    assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')), [], 'nessun nostro file, nemmeno temporanei');
    // il guasto e' passato: un nuovo tentativo, senza guasto, riesce
    const r2 = lock.acquisisci(root);
    assert.equal(r2.ok, true, JSON.stringify(r2));
    const { dato } = leggiFileLock(root);
    assert.equal(dato.token, r2.token);
    assert.equal(dato.pid, process.pid);
    assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')), [lock.NOME]);
    assert.equal(lock.rilascia(root, r2.token), true);
  });
}

for (const stadio of STADI) {
  test(`T5 mutex ${stadio}: dopo l'EIO niente mutex nostro e il takeover al retry riesce`, async (t) => {
    const root = radiceNuova();
    scriviLockDi(root, await datoDiUnMorto(t));
    negaLink(t, 'EPERM');
    guastoDopoOpen(t, root, lock.NOME_MUTEX, stadio);
    const r1 = lock.acquisisci(root);
    assert.notEqual(r1.ok, true, 'il rifiuto al guasto resta sicuro');
    assert.equal(r1.codice, 'scrittura', JSON.stringify(r1));
    assert.equal(fs.existsSync(fileMutex(root)), false, 'il guasto non deve lasciare a terra il mutex nostro');
    assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')), [lock.NOME], 'resta solo il lock del defunto, che non e\' nostro');
    // il guasto e' passato: il takeover del morto riesce
    const r2 = lock.acquisisci(root);
    assert.equal(r2.ok, true, JSON.stringify(r2));
    const { dato } = leggiFileLock(root);
    assert.equal(dato.token, r2.token);
    assert.equal(dato.pid, process.pid);
    assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')), [lock.NOME]);
    assert.equal(lock.rilascia(root, r2.token), true);
  });
}

// --- T6: il file di un ALTRO scambiato nel punto del guasto resta intatto ---

for (const stadio of STADI) {
  test(`T6 lock ${stadio}: un lock altrui scambiato tra open e unlink resta intatto`, (t) => {
    const root = radiceNuova();
    const vivo = figlioVivo(t);
    const altrui = { v: 1, pid: vivo.pid, starttime: leggiStarttimeProc(vivo.pid), token: 'altrui' };
    negaLink(t, 'EPERM');
    guastoDopoOpen(t, root, lock.NOME, stadio, scambiaDestConAltro(fileLock(root), altrui));
    const r1 = lock.acquisisci(root);
    assert.notEqual(r1.ok, true);
    assert.equal(r1.codice, 'scrittura', JSON.stringify(r1));
    // il file dell'altro e' ancora li', intatto: stessi byte, modo 0600
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
}

for (const stadio of STADI) {
  test(`T6 mutex ${stadio}: un mutex altrui scambiato tra open e unlink resta intatto`, async (t) => {
    const root = radiceNuova();
    scriviLockDi(root, await datoDiUnMorto(t));
    const vivo = figlioVivo(t);
    const altrui = { v: 1, pid: vivo.pid, starttime: leggiStarttimeProc(vivo.pid), token: 'suo-mutex' };
    negaLink(t, 'EPERM');
    guastoDopoOpen(t, root, lock.NOME_MUTEX, stadio, scambiaDestConAltro(fileMutex(root), altrui));
    const r1 = lock.acquisisci(root);
    assert.notEqual(r1.ok, true);
    assert.equal(r1.codice, 'scrittura', JSON.stringify(r1));
    // il mutex dell'altro e' ancora li', intatto
    const grezzo = fs.readFileSync(fileMutex(root), 'utf8');
    assert.deepEqual(JSON.parse(grezzo), altrui, 'il contenuto dell\'altro non va toccato');
    assert.equal(fs.statSync(fileMutex(root)).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.join(root, 'launch-targets')).sort(), [lock.NOME, lock.NOME_MUTEX].sort());
    // un nuovo tentativo trova il mutex di un altro: takeover negato, file intatto
    const r2 = lock.acquisisci(root);
    assert.equal(r2.ok, false);
    assert.equal(r2.codice, 'takeover', JSON.stringify(r2));
    assert.deepEqual(JSON.parse(fs.readFileSync(fileMutex(root), 'utf8')), altrui);
  });
}

// --- T7: un processo nuovo dopo il guasto acquisisce ------------------------

for (const stadio of STADI) {
  test(`T7 lock ${stadio}: un processo nuovo dopo il guasto acquisisce`, (t) => {
    const root = radiceNuova();
    negaLink(t, 'EPERM');
    guastoDopoOpen(t, root, lock.NOME, stadio);
    const r1 = lock.acquisisci(root);
    assert.notEqual(r1.ok, true);
    const esito = processoNuovoAcquisisce(root);
    assert.equal(esito.ok, true, `il processo nuovo doveva acquisire, non ricevere per sempre ${JSON.stringify(esito)}`);
  });
}

for (const stadio of STADI) {
  test(`T7 mutex ${stadio}: un processo nuovo dopo il guasto acquisisce`, async (t) => {
    const root = radiceNuova();
    scriviLockDi(root, await datoDiUnMorto(t));
    negaLink(t, 'EPERM');
    guastoDopoOpen(t, root, lock.NOME_MUTEX, stadio);
    const r1 = lock.acquisisci(root);
    assert.notEqual(r1.ok, true);
    const esito = processoNuovoAcquisisce(root);
    assert.equal(esito.ok, true, `il processo nuovo doveva acquisire, non ricevere per sempre ${JSON.stringify(esito)}`);
  });
}

// --- T8/T9: EIO sull'fsync ESTERNO della cartella, dopo la pubblicazione ----
//
// Stessa iniezione della probe che ha riprodotto il caso sul campo: si
// tracciano gli fd per percorso e si conta solo l'fsync della CARTELLA; si
// lancia EIO sull'n-esimo. Senza link quello ESTERNO e' il secondo in
// acquisizione (il primo e' dentro il ripiego di pubblicaEsclusivo) e il
// terzo nel takeover (mutex e seconda pubblicazione). Il file pubblicato e'
// completo, con il NOSTRO pid e token: se il rifiuto non se lo porta via,
// resta per sempre e il processo STESSO viene poi respinto come
// 'altro-scrittore' fino al riavvio.

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

test('T8 nolink acquisizione: EIO sul secondo fsync della cartella, nessun lock nostro resta e lo STESSO processo riprova pulito', (t) => {
  const root = radiceNuova();
  negaLink(t, 'EPERM');
  guastoSulFsyncDirNumero(t, root, 2);
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

test('T8 nolink takeover: EIO sul terzo fsync della cartella, nessun lock nostro resta e lo STESSO processo riprova pulito', async (t) => {
  const root = radiceNuova();
  scriviLockDi(root, await datoDiUnMorto(t));
  negaLink(t, 'EPERM');
  guastoSulFsyncDirNumero(t, root, 3);
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

test('T9 nolink acquisizione: un lock altrui con token diverso non viene mai toccato', (t) => {
  const root = radiceNuova();
  const vivo = figlioVivo(t);
  const altrui = { v: 1, pid: vivo.pid, starttime: leggiStarttimeProc(vivo.pid), token: 'altrui' };
  negaLink(t, 'EPERM');
  guastoSulFsyncDirNumero(t, root, 2, scambiaDestConAltro(fileLock(root), altrui));
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

test('T9 nolink takeover: un lock altrui con token diverso non viene mai toccato', async (t) => {
  const root = radiceNuova();
  scriviLockDi(root, await datoDiUnMorto(t));
  const vivo = figlioVivo(t);
  const altrui = { v: 1, pid: vivo.pid, starttime: leggiStarttimeProc(vivo.pid), token: 'altrui' };
  negaLink(t, 'EPERM');
  guastoSulFsyncDirNumero(t, root, 3, scambiaDestConAltro(fileLock(root), altrui));
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
