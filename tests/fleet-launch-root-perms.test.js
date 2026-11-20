'use strict';
// I permessi della RADICE dei file nella catena della quarantena.
// La radice e' la cartella utente condivisa con le cartelle di cella: su
// installazioni con umask di gruppo (0002) nasce 0775 con uid e gid del
// servizio. La tolleranza decisa in sede di disegno e' SOLO lo schema
// user-private-group: g+w accettato se l'uid e' nostro e il gid e' il gruppo
// effettivo del servizio; o+w resta rifiutato, gid estraneo con g+w resta
// rifiutato, uid estraneo resta rifiutato, e `launch-targets/` resta stretta
// (nemmeno il gruppo scrive, nemmeno con il nostro gid). Il rifiuto arriva
// PRIMA del journal: un problema di permessi non lascia un commit incompleto
// che blocca ogni lancio successivo con STOP_UNKNOWN. Un journal gia'
// pubblicato che fallisce davvero resta incompleto e riprendibile: qui non si
// cancella mai nulla.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const launchTarget = require('../lib/fleet/launch-target.js');
const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
const W = require('./helpers/launch-world.js');

const { OWNER_INSTANCE_ID } = W;
const SESS = W.SESSIONE;
const LID = 'ab'.repeat(8);
const BOOT_ORA = '11111111-1111-4111-8111-111111111111';
const BOOT_PRIMA = '22222222-2222-4222-8222-222222222222';
const NS = '4026531836';
const SOCKET_MORTO = '/tmp/nc-root-perms-socket-del-boot-precedente.sock';

const UID = typeof process.getuid === 'function' ? process.getuid() : null;
const GID = typeof process.getegid === 'function' ? process.getegid() : null;

function modo(p) {
  return (fs.lstatSync(p).mode & 0o7777).toString(8).padStart(4, '0');
}

function gidDiversoDisponibile() {
  try {
    return (process.getgroups ? process.getgroups() : []).find((g) => g !== GID) ?? null;
  } catch (_) {
    return null;
  }
}

// Mondo del solo modulo: radice vera in tmp, record v2 in fase prepared.
function mondoRecord(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-root-perms-'));
  t.after(() => {
    // La radice puo' restare senza bit di scrittura: si ripristina prima di pulire.
    try { fs.chmodSync(root, 0o700); } catch (_) { /* assente */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  });
  const r = launchTarget.registraPrepared(root, SESS, {
    launchId: LID, family: 'other', cellId: 'Cella', ownerInstanceId: null,
    tmuxSocket: SOCKET_MORTO, daemonInc: 'inc-0',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const g = launchTarget.leggiGrezzo(root, SESS);
  assert.equal(g.stato, 'presente');
  return {
    root,
    file: path.join(root, 'launch-targets', `${SESS}.json`),
    atteso: { launchId: LID, sha256: g.sha256, fase: 'prepared' },
  };
}

// L'uid e il gid della radice si presentano diversi da quelli effettivi del
// processo: iniezione lato test su lstatSync, solo per il percorso richiesto
// (lo stesso schema delle corse di sostituzione: tutto il resto e' reale).
function conIdentitaDiversa(root, { uid = null, gid = null } = {}) {
  const origLstat = fs.lstatSync;
  let letture = 0;
  fs.lstatSync = function identificata(p, ...a) {
    const st = origLstat.call(fs, p, ...a);
    if (String(p) === String(root)) {
      letture += 1;
      const sostituto = {};
      if (uid !== null) sostituto.uid = uid;
      if (gid !== null) sostituto.gid = gid;
      return Object.assign(Object.create(st), sostituto);
    }
    return st;
  };
  return {
    ripristina() { fs.lstatSync = origLstat; },
    letture() { return letture; },
  };
}

// ---------------------------------------------------------------------------
// La radice: matrice dei modi accettati e rifiutati
// ---------------------------------------------------------------------------

test('radice 0775 di uid e gid effettivi: catena qualificata, commit completato', (t) => {
  const w = mondoRecord(t);
  assert.ok(UID !== null && GID !== null, 'serve un processo con uid e gid effettivi');
  fs.chmodSync(w.root, 0o775);
  assert.equal(modo(w.root), '0775');
  assert.equal(fs.lstatSync(w.root).gid, GID, 'precondizione: gid effettivo');
  const r = launchTarget.riconciliaRecord(w.root, SESS, w.atteso);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(launchTarget.leggiGrezzo(w.root, SESS).stato, 'assente', 'record spostato');
  const dest = launchTarget.percorsoQuarantena(w.root, SESS, LID);
  assert.equal(modo(dest), '0600', 'il backup resta privato');
  assert.equal(fs.existsSync(launchTarget.percorsoJournal(w.root, SESS)), false);
});

test('radice scrivibile da altri (0777, 0757): rifiutata, senza journal e senza incompleto', (t) => {
  for (const m of [0o777, 0o757]) {
    const w = mondoRecord(t);
    fs.chmodSync(w.root, m);
    const r = launchTarget.riconciliaRecord(w.root, SESS, w.atteso);
    assert.equal(r.ok, false, modo(w.root));
    assert.equal(r.codice, 'dir-quarantena');
    assert.equal(r.motivo && r.motivo.punto, 'catena');
    assert.equal(r.motivo && r.motivo.scrivibileDaAltri, true);
    assert.equal(r.motivo && r.motivo.trovato, modo(w.root));
    assert.notEqual(r.incompleto, true, 'nessun journal pubblicato: niente falso incompleto');
    assert.equal(fs.existsSync(launchTarget.percorsoJournal(w.root, SESS)), false,
      `modo ${modo(w.root)}: il rifiuto non lascia journal`);
    assert.equal(launchTarget.leggiGrezzo(w.root, SESS).stato, 'presente', 'record intatto');
    assert.equal(fs.existsSync(launchTarget.percorsoQuarantena(w.root, SESS, LID)), false,
      'nessun backup senza commit');
  }
});

test('launch-targets/ a 0775: resta rifiutata anche col nostro gid (la tolleranza e\' solo della radice)', (t) => {
  // La radice puo' essere 0775 nel perimetro fidato; la cartella dei record no:
  // chi scrive la' puo' sostituire un record, quindi la stretta resta 0o022.
  const w = mondoRecord(t);
  const dir = path.join(w.root, 'launch-targets');
  fs.chmodSync(w.root, 0o775);
  fs.chmodSync(dir, 0o775);
  t.after(() => { try { fs.chmodSync(dir, 0o700); } catch (_) { /* best-effort */ } });
  assert.equal(modo(dir), '0775');
  const r = launchTarget.riconciliaRecord(w.root, SESS, w.atteso);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.codice, 'dir-quarantena');
  assert.equal(r.motivo && r.motivo.punto, 'catena');
  assert.equal(r.motivo && r.motivo.scrivibileDaAltri, true, 'g+w su launch-targets non e\' ammesso');
  assert.equal(r.motivo && r.motivo.trovato, '0775');
  assert.notEqual(r.incompleto, true, 'nessun journal pubblicato');
  assert.equal(fs.existsSync(launchTarget.percorsoJournal(w.root, SESS)), false);
  assert.equal(launchTarget.leggiGrezzo(w.root, SESS).stato, 'presente', 'record intatto');
});

test('radice symlink: rifiutata sulla catena, senza journal', (t) => {
  const reale = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-root-perms-real-'));
  const link = `${reale}-link`;
  t.after(() => {
    try { fs.rmSync(link, { force: true }); } catch (_) { /* assente */ }
    try { fs.chmodSync(reale, 0o700); } catch (_) { /* assente */ }
    try { fs.rmSync(reale, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  });
  const r0 = launchTarget.registraPrepared(reale, SESS, {
    launchId: LID, family: 'other', cellId: 'Cella', ownerInstanceId: null,
    tmuxSocket: SOCKET_MORTO, daemonInc: 'inc-0',
  });
  assert.equal(r0.ok, true, JSON.stringify(r0));
  fs.symlinkSync(reale, link);
  const g = launchTarget.leggiGrezzo(link, SESS);
  assert.equal(g.stato, 'presente');
  const r = launchTarget.riconciliaRecord(link, SESS, { launchId: LID, sha256: g.sha256, fase: 'prepared' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.codice, 'dir-quarantena');
  assert.equal(r.motivo && r.motivo.punto, 'catena');
  assert.equal(r.motivo && r.motivo.symlink, true);
  assert.notEqual(r.incompleto, true, 'nessun journal pubblicato');
  assert.equal(fs.existsSync(launchTarget.percorsoJournal(link, SESS)), false);
});

test('radice 0775 con gid DIVERSO dal gruppo effettivo: rifiutata anche lei, senza journal', (t) => {
  assert.ok(UID !== null && GID !== null, 'serve un processo con uid e gid effettivi');
  const altro = gidDiversoDisponibile();
  const w = mondoRecord(t);
  fs.chmodSync(w.root, 0o775);
  let iniettata = null;
  if (altro !== null) {
    // chgrp REALE a un gruppo supplementare del processo: il gid sul disco e'
    // davvero diverso dal gruppo effettivo.
    fs.chownSync(w.root, -1, altro);
    t.after(() => { try { fs.chownSync(w.root, -1, GID); } catch (_) { /* best-effort */ } });
    assert.equal(fs.lstatSync(w.root).gid, altro, 'precondizione: gid davvero diverso');
  } else {
    // Nessun gruppo supplementare: il gid della radice si presenta diverso via
    // lstat (iniezione lato test, dichiarata).
    iniettata = conIdentitaDiversa(w.root, { gid: GID + 1 });
    t.after(() => iniettata.ripristina());
  }
  const r = launchTarget.riconciliaRecord(w.root, SESS, w.atteso);
  if (iniettata) iniettata.ripristina();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.codice, 'dir-quarantena');
  assert.equal(r.motivo && r.motivo.scrivibileDaAltri, true, 'g+w di un gruppo non nostro');
  assert.equal(r.motivo && r.motivo.trovato, '0775');
  assert.notEqual(r.incompleto, true, 'nessun journal pubblicato');
  assert.equal(fs.existsSync(launchTarget.percorsoJournal(w.root, SESS)), false);
  assert.equal(launchTarget.leggiGrezzo(w.root, SESS).stato, 'presente', 'record intatto');
});

test('radice con uid DIVERSO dal nostro: rifiutata, senza journal', (t) => {
  assert.ok(UID !== null, 'serve un processo con uid effettivo');
  const w = mondoRecord(t);
  const modoPrima = modo(w.root);
  const iniettata = conIdentitaDiversa(w.root, { uid: UID + 4242 });
  t.after(() => iniettata.ripristina());
  const r = launchTarget.riconciliaRecord(w.root, SESS, w.atteso);
  iniettata.ripristina();
  assert.ok(iniettata.letture() > 0, 'la corsa e\' avvenuta davvero');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.codice, 'dir-quarantena');
  assert.equal(r.motivo && r.motivo.uidNostro, false);
  assert.notEqual(r.incompleto, true, 'nessun journal pubblicato');
  assert.equal(fs.existsSync(launchTarget.percorsoJournal(w.root, SESS)), false);
  assert.equal(launchTarget.leggiGrezzo(w.root, SESS).stato, 'presente', 'record intatto');
  assert.equal(modo(w.root), modoPrima, 'nessuna mutazione della radice');
});

// ---------------------------------------------------------------------------
// Runtime: il rifiuto non lascia un journal che blocca
// ---------------------------------------------------------------------------

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

// Mondo dead-boot del test end-to-end: record v2 attested di un boot
// precedente, supervisore e server morti per PID esatto, sonda che prova il
// socket corrente servito e nessuna omonima.
async function mondoDeadBoot(t) {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  const srv = figlioVivo(t);
  const nascitaSrv = leggiStarttimeProc(srv.pid);
  await morto(sup.pid);
  await morto(srv.pid);
  const r = launchTarget.registraPrepared(d.filesRoot, d.sessione, {
    launchId: LID, family: 'other', cellId: d.cella, ownerInstanceId: OWNER_INSTANCE_ID,
    tmuxSocket: SOCKET_MORTO, bootId: BOOT_PRIMA, pidNs: NS, daemonInc: 'inc-0',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const [da, a, campi] of [
    ['prepared', 'creating', {}],
    ['creating', 'created', { sessionId: '$5', windowId: '@7', paneId: '%9', serverPid: srv.pid, serverStarttime: nascitaSrv }],
    ['created', 'attested', { panePid: sup.pid, paneStarttime: nascitaSup }],
  ]) {
    const av = launchTarget.avanza(d.filesRoot, d.sessione, { launchId: LID, da, a, campi });
    assert.equal(av.ok, true, JSON.stringify(av));
  }
  const { runtime } = W.apriRuntime(d, {
    owner: true,
    sondaSocket: async () => ({ esito: 'econnrefused' }),
    cfg: { identitaNodoKernel: () => ({ bootId: BOOT_ORA, pidNamespaceInode: NS }) },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  return { d, runtime };
}

test('runtime: rifiuto di permessi della radice senza journal; sistemata la radice, l\'up riparte', async (t) => {
  const { d, runtime } = await mondoDeadBoot(t);
  fs.chmodSync(d.filesRoot, 0o777);
  const errore = await runtime.up(d.cella).then(() => null, (e) => e);
  assert.ok(errore, 'l\'up rifiuta con la radice scrivibile da altri');
  assert.equal(errore.status, 409);
  // R1: senza identita' di server il blocco non dimostra un duplicato.
  assert.equal(errore.fleetCode, 'STOP_UNKNOWN');
  const dati = errore.data || {};
  assert.notEqual(dati.incompleto, true, 'il rifiuto preliminare non e\' un commit incompleto');
  assert.equal(fs.existsSync(launchTarget.percorsoJournal(d.filesRoot, d.sessione)), false,
    'il rifiuto non lascia il journal che blocca ogni up successivo');
  // Permessi sistemati: il tentativo successivo procede, senza recuperi a mano.
  fs.chmodSync(d.filesRoot, 0o755);
  const su = await runtime.up(d.cella);
  assert.equal(su.ok, true, JSON.stringify(su));
  assert.ok(fs.existsSync(launchTarget.percorsoQuarantena(d.filesRoot, d.sessione, LID)), 'vecchio record in quarantena');
  const dopo = launchTarget.leggi(d.filesRoot, d.sessione);
  assert.equal(dopo.stato, 'presente');
  assert.notEqual(dopo.record.launchId, LID, 'record nuovo');
  assert.equal(fs.existsSync(launchTarget.percorsoJournal(d.filesRoot, d.sessione)), false);
});

test('runtime: radice 0775 nata con umask di gruppo (0002): up riconcilia e riparte', async (t) => {
  // La corsia umask del difetto: la radice nasce 0775 proprio come sulle
  // installazioni con umask effettiva 0002, senza toccare l'umask globale.
  assert.ok(GID !== null, 'serve un processo con gid effettivo');
  const prima = process.umask();
  process.umask(0o0002);
  let mondo;
  try {
    mondo = await mondoDeadBoot(t);
  } finally {
    process.umask(prima);
  }
  const { d, runtime } = mondo;
  assert.equal(modo(d.filesRoot), '0775', 'la radice e\' nata 0775');
  assert.equal(fs.lstatSync(d.filesRoot).gid, GID, 'con il gruppo effettivo del servizio');
  const su = await runtime.up(d.cella);
  assert.equal(su.ok, true, `up rifiutato su radice 0775: ${JSON.stringify(su)}`);
  assert.ok(fs.existsSync(launchTarget.percorsoQuarantena(d.filesRoot, d.sessione, LID)), 'vecchio record in quarantena');
  const dopo = launchTarget.leggi(d.filesRoot, d.sessione);
  assert.equal(dopo.stato, 'presente');
  assert.notEqual(dopo.record.launchId, LID, 'record nuovo');
  assert.equal(fs.existsSync(launchTarget.percorsoJournal(d.filesRoot, d.sessione)), false);
  assert.equal(modo(d.filesRoot), '0775', 'nessun chmod della radice condivisa');
});
