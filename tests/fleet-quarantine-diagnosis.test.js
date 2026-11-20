'use strict';
// 0.9.83 S4b (B10) — la quarantena dice PERCHE' rifiuta e si ripara solo per
// descriptor. Un `launch-targets/reconciled/` in 0775 (creato da una versione
// precedente o da un altro strumento) bloccava la chiusura con un rifiuto muto
// `dir-quarantena`. Ora: motivo bounded in ogni rifiuto, riparazione del SOLO
// difetto approvato (bit di gruppo/altri, proprietario completo, nessun bit
// speciale) con fchmod sul descriptor qualificato, e rifiuto diagnostico per
// tutto il resto (0500, bit speciali, link, uid estraneo, catena scrivibile).
// I test iniettano le sostituzioni col patching di `fs` nel processo: il
// modulo usa lo stesso oggetto, quindi la corsa e' reale, non simulata.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const launchTarget = require('../lib/fleet/launch-target.js');

const LID = 'ab'.repeat(8);
const BOOT_PRIMA = '22222222-2222-4222-8222-222222222222';
const NS = '4026531836';
const SESS = 'cloud-Cella';

function modo(p) {
  return (fs.lstatSync(p).mode & 0o7777).toString(8).padStart(4, '0');
}

function radice(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-quar-'));
  t.after(() => {
    // Le directory 0500/02775 si tolgono solo dopo aver ripristinato il modo.
    const q = path.join(root, 'launch-targets', 'reconciled');
    for (const p of [q, path.join(root, 'launch-targets')]) {
      try { fs.chmodSync(p, 0o700); } catch (_) { /* assente */ }
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  });
  return root;
}

function recordAttestato(root, launchId = LID) {
  const r = launchTarget.registraPrepared(root, SESS, {
    launchId, family: 'other', cellId: 'Cella', ownerInstanceId: null,
    tmuxSocket: '/tmp/nc-quarantine-test.sock', bootId: BOOT_PRIMA, pidNs: NS,
    daemonInc: 'inc-0', res: null,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const passi = [
    ['prepared', 'creating', {}],
    ['creating', 'created', { sessionId: '$5', windowId: '@7', paneId: '%9' }],
    ['created', 'attested', { panePid: 4242, paneStarttime: 1 }],
  ];
  for (const [da, a, campi] of passi) {
    const av = launchTarget.avanza(root, SESS, { launchId, da, a, campi });
    assert.equal(av.ok, true, JSON.stringify(av));
  }
  return launchId;
}

function dirQuarantena(root) {
  return path.join(root, 'launch-targets', 'reconciled');
}

function committa(root, launchId = LID) {
  const prima = launchTarget.leggiGrezzo(root, SESS);
  assert.equal(prima.stato, 'presente');
  return launchTarget.riconciliaRecord(root, SESS, { launchId, sha256: prima.sha256, fase: 'attested' });
}

// --- diagnosi: il rifiuto dice modo atteso e modo trovato ------------------

test('S4b: 0775 nostro con proprietario completo si ripara da solo e il commit riesce', (t) => {
  const root = radice(t);
  recordAttestato(root);
  const q = dirQuarantena(root);
  fs.mkdirSync(q, { recursive: true, mode: 0o700 });
  fs.chmodSync(q, 0o775);
  assert.equal(modo(q), '0775');
  const r = committa(root);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(modo(q), '0700', 'i bit di gruppo/altri sono tolti');
  assert.equal(launchTarget.leggiGrezzo(root, SESS).stato, 'assente', 'record spostato');
  const dest = launchTarget.percorsoQuarantena(root, SESS, LID);
  assert.equal(modo(dest), '0600', 'il backup resta privato');
});

test('S4b: 0500 (proprietario incompleto) NON si ripara: motivo 0500, nessun journal, record intatto', (t) => {
  const root = radice(t);
  recordAttestato(root);
  const q = dirQuarantena(root);
  fs.mkdirSync(q, { recursive: true, mode: 0o700 });
  fs.chmodSync(q, 0o500);
  const r = committa(root);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.codice, 'dir-quarantena');
  assert.notEqual(r.incompleto, true, 'il rifiuto arriva prima del journal: nessun commit incompleto');
  assert.equal(r.motivo.trovato, '0500');
  assert.equal(r.motivo.uidNostro, true);
  assert.equal(r.motivo.riparabile, undefined, 'nessuna riparazione promessa');
  assert.equal(modo(q), '0500', 'i bit del proprietario non si aggiungono mai');
  assert.equal(launchTarget.leggiGrezzo(root, SESS).stato, 'presente');
  assert.equal(fs.existsSync(launchTarget.percorsoJournal(root, SESS)), false,
    'nessun journal da completare');
});

test('S4b: bit speciali (setgid) si rifiutano esplicitamente, senza strip silenzioso', (t) => {
  const root = radice(t);
  recordAttestato(root);
  const q = dirQuarantena(root);
  fs.mkdirSync(q, { recursive: true, mode: 0o700 });
  fs.chmodSync(q, 0o2775);
  const r = committa(root);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.codice, 'dir-quarantena');
  assert.equal(r.motivo.speciali, true, JSON.stringify(r.motivo));
  assert.equal(r.motivo.trovato, '2775');
  assert.equal(modo(q), '2775', 'nessun bit toccato');
  assert.equal(launchTarget.leggiGrezzo(root, SESS).stato, 'presente');
});

test('S4b: il nome di quarantena che e\' un link si rifiuta e il bersaglio non si tocca', (t) => {
  const root = radice(t);
  recordAttestato(root);
  const q = dirQuarantena(root);
  const vero = path.join(root, 'veroSegreto');
  fs.mkdirSync(vero, { recursive: true, mode: 0o700 });
  fs.symlinkSync(vero, q);
  const r = committa(root);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.motivo.symlink, true, JSON.stringify(r.motivo));
  assert.equal(modo(vero), '0700', 'il bersaglio del link resta com\'e\'');
  assert.equal(launchTarget.leggiGrezzo(root, SESS).stato, 'presente');
});

test('S4b: una catena scrivibile da gruppo/altri non si qualifica', (t) => {
  const root = radice(t);
  recordAttestato(root);
  fs.chmodSync(path.join(root, 'launch-targets'), 0o730);
  const q = dirQuarantena(root);
  fs.mkdirSync(q, { recursive: true, mode: 0o700 });
  const r = committa(root);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.motivo.punto, 'catena', JSON.stringify(r.motivo));
  assert.equal(r.motivo.scrivibileDaAltri, true);
  assert.equal(r.motivo.trovato, '0730');
  assert.equal(launchTarget.leggiGrezzo(root, SESS).stato, 'presente');
});

// --- sostituzione del nome: prima dell'open e fra open e fchmod ------------

test('S4b: nome sostituito PRIMA dell\'open -> nessun fchmod sull\'inode sostitutivo', (t) => {
  const root = radice(t);
  recordAttestato(root);
  const q = dirQuarantena(root);
  fs.mkdirSync(q, { recursive: true, mode: 0o700 });
  fs.chmodSync(q, 0o775);
  const origOpen = fs.openSync;
  let scambiato = false;
  fs.openSync = function (p, ...a) {
    if (!scambiato && String(p) === q) {
      scambiato = true;
      fs.renameSync(q, `${q}-vecchia`);
      fs.mkdirSync(q, { recursive: true, mode: 0o700 });
      fs.chmodSync(q, 0o775);
    }
    return origOpen.call(fs, p, ...a);
  };
  t.after(() => { fs.openSync = origOpen; });
  const r = committa(root);
  fs.openSync = origOpen;
  assert.equal(scambiato, true, 'la corsa e\' avvenuta davvero');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.codice, 'dir-quarantena');
  assert.equal(r.motivo.errore, 'sostituita', JSON.stringify(r.motivo));
  assert.equal(modo(q), '0775', 'l\'inode sostitutivo non e\' stato mutato');
  assert.equal(modo(`${q}-vecchia`), '0775', 'nemmeno l\'originale, se non era lui');
  assert.equal(launchTarget.leggiGrezzo(root, SESS).stato, 'presente');
});

test('S4b: nome sostituito FRA open e fchmod -> il fd tocca solo l\'inode qualificato, poi rifiuto', (t) => {
  const root = radice(t);
  recordAttestato(root);
  const q = dirQuarantena(root);
  fs.mkdirSync(q, { recursive: true, mode: 0o700 });
  fs.chmodSync(q, 0o775);
  const origFchmod = fs.fchmodSync;
  let scambiato = false;
  fs.fchmodSync = function (fd, m) {
    // Solo il fchmod della RIPARAZIONE (0700 sulla cartella): il journal e il
    // backup usano 0600 e non devono far scattare la corsa.
    if (!scambiato && m === 0o700) {
      scambiato = true;
      fs.renameSync(q, `${q}-vecchia`);
      fs.mkdirSync(q, { recursive: true, mode: 0o700 });
      fs.chmodSync(q, 0o775);
    }
    return origFchmod.call(fs, fd, m);
  };
  t.after(() => { fs.fchmodSync = origFchmod; });
  const r = committa(root);
  fs.fchmodSync = origFchmod;
  assert.equal(scambiato, true, 'la corsa e\' avvenuta davvero');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.motivo.errore, 'rinominata', JSON.stringify(r.motivo));
  assert.equal(modo(q), '0775', 'il nome nuovo non e\' stato mutato');
  assert.equal(modo(`${q}-vecchia`), '0700', 'il fchmod ha toccato l\'inode a cui il fd punta');
  assert.equal(launchTarget.leggiGrezzo(root, SESS).stato, 'presente');
});

test('S4b: fsync fallito durante la riparazione -> nessun successo, niente journal, record intatto', (t) => {
  const root = radice(t);
  recordAttestato(root);
  const q = dirQuarantena(root);
  fs.mkdirSync(q, { recursive: true, mode: 0o700 });
  fs.chmodSync(q, 0o775);
  const origFsync = fs.fsyncSync;
  const bersaglio = fs.lstatSync(q);
  let colpito = false;
  fs.fsyncSync = function (fd) {
    // Solo il fsync della RIPARAZIONE: descriptor della cartella di quarantena
    // (stesso dev/ino). Il journal e i file di record sincronizzano altri
    // inode, e la sincronizzazione della directory padre non deve scattare.
    let nostro = false;
    try {
      const st = fs.fstatSync(fd);
      nostro = st.isDirectory() && st.dev === bersaglio.dev && st.ino === bersaglio.ino;
    } catch (_) { nostro = false; }
    if (!colpito && nostro) { colpito = true; const e = new Error('fsync iniettato'); e.code = 'EIO'; throw e; }
    return origFsync.call(fs, fd);
  };
  t.after(() => { fs.fsyncSync = origFsync; });
  const r = committa(root);
  fs.fsyncSync = origFsync;
  assert.equal(colpito, true);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.codice, 'dir-quarantena');
  assert.equal(r.motivo.errore, 'riparazione', JSON.stringify(r.motivo));
  assert.notEqual(r.incompleto, true, 'il preflight precede il journal');
  assert.equal(launchTarget.leggiGrezzo(root, SESS).stato, 'presente', 'nessun record tolto');
  assert.equal(fs.existsSync(launchTarget.percorsoJournal(root, SESS)), false,
    'il rifiuto preliminare non lascia il journal');
});

// Il preflight e' anticipato, ma la verifica alla scrittura resta: se la
// quarantena cambia DOPO il preflight il journal e' gia' pubblicato e il
// commit resta incompleto, da completare — non si cancella per ottenere l'up.
test('S4b: quarantena cambiata tra il preflight e la scrittura -> incompleto, journal presente', (t) => {
  const root = radice(t);
  recordAttestato(root);
  const q = dirQuarantena(root);
  fs.mkdirSync(q, { recursive: true, mode: 0o700 });
  const journal = launchTarget.percorsoJournal(root, SESS);
  const origRename = fs.renameSync;
  let scattato = false;
  fs.renameSync = function (a, b) {
    // Il rename del file temporaneo e' la pubblicazione del journal: qui siamo
    // dopo il preflight e prima della verifica che precede la scrittura.
    if (!scattato && String(b) === journal) {
      scattato = true;
      fs.chmodSync(q, 0o500);
    }
    return origRename.call(fs, a, b);
  };
  t.after(() => { fs.renameSync = origRename; try { fs.chmodSync(q, 0o700); } catch (_) { /* assente */ } });
  const r = committa(root);
  fs.renameSync = origRename;
  fs.chmodSync(q, 0o700);
  assert.equal(scattato, true, 'la corsa e\' avvenuta davvero');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.codice, 'dir-quarantena');
  assert.equal(r.incompleto, true, 'il journal e\' gia\' pubblicato: il commit va completato');
  assert.equal(fs.existsSync(journal), true, 'la barriera e\' sul disco');
  assert.equal(launchTarget.leggiGrezzo(root, SESS).stato, 'presente', 'record intatto');
  // Sistemata la quarantena, il commit si completa e il journal sparisce.
  assert.equal(launchTarget.completaCommit(root, SESS).stato, 'completato');
  assert.equal(fs.existsSync(journal), false, 'il journal si toglie solo a commit completato');
  assert.equal(launchTarget.leggiGrezzo(root, SESS).stato, 'assente');
});

// --- end-to-end: il caso B10 si chiude da solo, il non riparabile lo dice --

const W = require('./helpers/launch-world.js');
const { spawn } = require('node:child_process');
const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');

const BOOT_ORA = '11111111-1111-4111-8111-111111111111';

function figlioVivo(t) {
  const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000);'], { detached: true, stdio: 'ignore' });
  f.unref();
  t.after(() => { try { process.kill(f.pid, 'SIGKILL'); } catch (_) { /* gia' uscito */ } });
  return f;
}

async function morto(pid) {
  process.kill(pid, 'SIGKILL');
  const fine = Date.now() + 5000;
  while (Date.now() < fine) {
    try { process.kill(pid, 0); } catch (_) { return; }
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function mondoConRecordMorto(t) {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascita = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  // R1 richiede la prova POSITIVA che il server registrato sia uscito: il
  // record porta PID e nascita di un processo reale gia' morto (le sole
  // assenze sul listener corrente non riconciliano un record materializzato).
  const srv = figlioVivo(t);
  const nascitaSrv = leggiStarttimeProc(srv.pid);
  await morto(srv.pid);
  const r = launchTarget.registraPrepared(d.filesRoot, d.sessione, {
    launchId: LID, family: 'other', cellId: d.cella, ownerInstanceId: W.OWNER_INSTANCE_ID,
    tmuxSocket: sharedTmuxSocketPath(), bootId: BOOT_ORA, pidNs: NS, daemonInc: 'inc-0', res: null,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const [da, a, campi] of [
    ['prepared', 'creating', {}],
    ['creating', 'created', { sessionId: '$5', windowId: '@7', paneId: '%9', serverPid: srv.pid, serverStarttime: nascitaSrv }],
    ['created', 'attested', { panePid: sup.pid, paneStarttime: nascita }],
  ]) {
    const av = launchTarget.avanza(d.filesRoot, d.sessione, { launchId: LID, da, a, campi });
    assert.equal(av.ok, true, JSON.stringify(av));
  }
  const { runtime } = W.apriRuntime(d, {
    owner: true,
    cfg: { identitaNodoKernel: () => ({ bootId: BOOT_ORA, pidNamespaceInode: NS }) },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  return { d, runtime };
}

test('S4b end-to-end: reconciled 0775 -> il down chiude da solo e la cartella resta 0700', async (t) => {
  const { d, runtime } = await mondoConRecordMorto(t);
  const q = path.join(d.filesRoot, 'launch-targets', 'reconciled');
  fs.mkdirSync(q, { recursive: true, mode: 0o700 });
  fs.chmodSync(q, 0o775);
  const r = await runtime.down(d.cella);
  assert.equal(r.outcome, 'resolved-dead', JSON.stringify(r));
  assert.equal(modo(q), '0700');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
});

test('S4b end-to-end: reconciled 0500 -> down 409 che dice modo atteso e trovato, record intatto', async (t) => {
  const { d, runtime } = await mondoConRecordMorto(t);
  const q = path.join(d.filesRoot, 'launch-targets', 'reconciled');
  fs.mkdirSync(q, { recursive: true, mode: 0o700 });
  fs.chmodSync(q, 0o500);
  const errore = await runtime.down(d.cella).then(() => null, (e) => e);
  assert.ok(errore, 'il down rifiuta');
  assert.equal(errore.status, 409);
  assert.match(String(errore.message), /expected mode 0700, found 0500, our owner/);
  const motivo = errore.data && errore.data.riconciliazione && errore.data.riconciliazione.motivoQuarantena;
  assert.equal(motivo && motivo.trovato, '0500', JSON.stringify(errore.data));
  assert.equal(motivo.uidNostro, true);
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'presente');
  assert.equal(modo(q), '0500');
});
