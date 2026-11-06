'use strict';
// Sonda del gruppo a segnale ZERO (lato demone, dopo l'uscita provata).
//
// Il difetto D-582: `osservaProduzione` conta le VOCI lette, non i membri, e
// con piu' di CAP_SCAN voci estranee il censimento resta `almeno` per sempre.
// Su un nodo carico il down non puo' quindi mai dichiarare il gruppo vuoto.
// La sonda `kill(-pgrp, 0)` risponde alla domanda «il gruppo e' vuoto?» dal
// kernel, O(1), senza enumerare /proc e senza recapitarne nulla.
//
// Questi test usano un /proc sintetico per il gruppo PROPRIO (la guardia che
// impedisce di sondare il gruppo in cui gira il demone) e un seam per la
// chiamata: nessun processo reale viene segnalato. I due casi con processi
// veri creano gruppi propri del test e li spengono per pid esatto.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const gruppo = require('../lib/fleet/group-stop.js');

const PGRP_BERSAGLIO = 424242;
const PGRP_PROPRIO = 9001;
const NASCITA = 123456;

function errore(codice) {
  const e = new Error(`sintetico ${codice}`);
  e.code = codice;
  return e;
}

// /proc sintetica con il SOLO processo del test: serve a far leggere al helper
// un gruppo proprio noto in positivo, senza toccare /proc vera.
function procConProprio(t, gruppoProprio = PGRP_PROPRIO) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d582-proc-'));
  fs.mkdirSync(path.join(root, String(process.pid)));
  fs.writeFileSync(path.join(root, String(process.pid), 'stat'),
    `${process.pid} (probe) S 1 ${gruppoProprio} ${gruppoProprio} 0 0 -1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0\n`);
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

function identita(nascita = NASCITA) {
  return { esito: 'presente', nascita };
}

function sondaSpia(foto = { esito: 'assente', nascita: null }, chiamate = []) {
  return {
    chiamate,
    inviaSegnaleZero: (pgrp) => { chiamate.push(pgrp); return true; },
    leggiIdentita: () => foto,
  };
}

// --- la risposta del kernel -------------------------------------------------

test('sonda: ESRCH e\' gruppo vuoto (noti, zero membri)', (t) => {
  const root = procConProprio(t);
  const foto = gruppo.sondaGruppo({
    pgrp: PGRP_BERSAGLIO,
    identita: identita(),
    procRoot: root,
    inviaSegnaleZero: () => { throw errore('ESRCH'); },
    leggiIdentita: () => ({ esito: 'assente', nascita: null }),
  });
  assert.deepEqual(foto, { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' });
});

test('sonda: successo e\' almeno un membro, mai un pulito', (t) => {
  const root = procConProprio(t);
  const foto = gruppo.sondaGruppo({
    pgrp: PGRP_BERSAGLIO,
    identita: identita(),
    procRoot: root,
    inviaSegnaleZero: () => true,
    leggiIdentita: () => ({ esito: 'assente', nascita: null }),
  });
  assert.equal(foto.qualita, 'almeno', 'il successo non e\' un censimento esatto');
  assert.ok(foto.inGruppo >= 1);
});

test('sonda: EPERM non e\' mai pulito (un membro esiste e non lo possiamo segnalare)', (t) => {
  const root = procConProprio(t);
  const foto = gruppo.sondaGruppo({
    pgrp: PGRP_BERSAGLIO,
    identita: identita(),
    procRoot: root,
    inviaSegnaleZero: () => { throw errore('EPERM'); },
    leggiIdentita: () => ({ esito: 'assente', nascita: null }),
  });
  assert.equal(foto.qualita, 'almeno');
  assert.ok(foto.inGruppo >= 1);
});

test('sonda: errore diverso da ESRCH/EPERM e\' ignoto, senza messaggi nel record', (t) => {
  const root = procConProprio(t);
  const foto = gruppo.sondaGruppo({
    pgrp: PGRP_BERSAGLIO,
    identita: identita(),
    procRoot: root,
    inviaSegnaleZero: () => { throw errore('EINVAL'); },
    leggiIdentita: () => ({ esito: 'assente', nascita: null }),
  });
  assert.deepEqual(foto, { inGruppo: 0, fuoriGruppo: 0, qualita: 'ignoti' });
  assert.equal(JSON.stringify(foto).includes('sintetico'), false, 'nessun errore grezzo nel record');
});

// --- guardie: pgrp pericoloso o identita' non provata -----------------------

test('sonda: pgrp 0, 1, negativo, NaN, non intero o stringa non viene MAI sondato', (t) => {
  const root = procConProprio(t);
  for (const pgrp of [0, 1, -1, -424242, NaN, 12.5, '424242', null, undefined]) {
    const spia = sondaSpia();
    const foto = gruppo.sondaGruppo({
      pgrp, identita: identita(), procRoot: root,
      inviaSegnaleZero: spia.inviaSegnaleZero, leggiIdentita: spia.leggiIdentita,
    });
    assert.equal(foto.qualita, 'ignoti', `pgrp ${String(pgrp)} deve restare ignoto`);
    assert.deepEqual(spia.chiamate, [], `pgrp ${String(pgrp)} non deve arrivare al kernel`);
  }
});

test('sonda: gruppo proprio non leggibile -> nessuna sonda (non si indovina)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d582-vuota-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const spia = sondaSpia();
  const foto = gruppo.sondaGruppo({
    pgrp: PGRP_BERSAGLIO, identita: identita(), procRoot: root,
    inviaSegnaleZero: spia.inviaSegnaleZero, leggiIdentita: spia.leggiIdentita,
  });
  assert.equal(foto.qualita, 'ignoti');
  assert.deepEqual(spia.chiamate, []);
});

test('sonda: il gruppo proprio non si sonda mai', (t) => {
  const root = procConProprio(t, PGRP_BERSAGLIO);
  const spia = sondaSpia();
  const foto = gruppo.sondaGruppo({
    pgrp: PGRP_BERSAGLIO, identita: identita(), procRoot: root,
    inviaSegnaleZero: spia.inviaSegnaleZero, leggiIdentita: spia.leggiIdentita,
  });
  assert.equal(foto.qualita, 'ignoti');
  assert.deepEqual(spia.chiamate, []);
});

test('sonda: identita\' iniziale assente o indeterminata -> ignoto, nessuna sonda', (t) => {
  const root = procConProprio(t);
  for (const stato of [null, undefined, { esito: 'indeterminata', nascita: null }, { esito: 'assente', nascita: null }, { esito: 'presente', nascita: null }]) {
    const spia = sondaSpia();
    const foto = gruppo.sondaGruppo({
      pgrp: PGRP_BERSAGLIO, identita: stato, procRoot: root,
      inviaSegnaleZero: spia.inviaSegnaleZero, leggiIdentita: spia.leggiIdentita,
    });
    assert.equal(foto.qualita, 'ignoti', `identita ${JSON.stringify(stato)}`);
    assert.deepEqual(spia.chiamate, []);
  }
});

test('sonda: il capo ancora vivo con la stessa nascita e\' un residuo CERTO, senza sondare', (t) => {
  const root = procConProprio(t);
  const spia = sondaSpia({ esito: 'presente', nascita: NASCITA });
  const foto = gruppo.sondaGruppo({
    pgrp: PGRP_BERSAGLIO, identita: identita(NASCITA), procRoot: root,
    inviaSegnaleZero: spia.inviaSegnaleZero, leggiIdentita: spia.leggiIdentita,
  });
  assert.equal(foto.qualita, 'almeno');
  assert.ok(foto.inGruppo >= 1);
  assert.deepEqual(spia.chiamate, [], 'il capo vivo risponde da solo: niente sonda');
});

test('sonda: numero riusato (nascita diversa) -> ignoto, nessuna sonda', (t) => {
  const root = procConProprio(t);
  const spia = sondaSpia({ esito: 'presente', nascita: NASCITA + 7 });
  const foto = gruppo.sondaGruppo({
    pgrp: PGRP_BERSAGLIO, identita: identita(NASCITA), procRoot: root,
    inviaSegnaleZero: spia.inviaSegnaleZero, leggiIdentita: spia.leggiIdentita,
  });
  assert.equal(foto.qualita, 'ignoti');
  assert.deepEqual(spia.chiamate, [], 'su un riuso non si giudica');
});

test('sonda: la lettura negata del capo (EACCES) non e\' una prova di morte', (t) => {
  const root = procConProprio(t);
  const spia = sondaSpia({ esito: 'indeterminata', nascita: null });
  const foto = gruppo.sondaGruppo({
    pgrp: PGRP_BERSAGLIO, identita: identita(NASCITA), procRoot: root,
    inviaSegnaleZero: spia.inviaSegnaleZero, leggiIdentita: spia.leggiIdentita,
  });
  assert.equal(foto.qualita, 'ignoti');
  assert.deepEqual(spia.chiamate, []);
});

// --- il segnale: zero, e il bersaglio e' il GRUPPO --------------------------

test('sonda: una sola chiamata al kernel, con (-pgrp, 0): mai un pid, mai un altro segnale', (t) => {
  const root = procConProprio(t);
  const chiamate = [];
  const vero = process.kill;
  process.kill = (pid, segnale) => { chiamate.push([pid, segnale]); throw errore('ESRCH'); };
  t.after(() => { process.kill = vero; });
  const foto = gruppo.sondaGruppo({
    pgrp: PGRP_BERSAGLIO,
    identita: identita(),
    procRoot: root,
    leggiIdentita: () => ({ esito: 'assente', nascita: null }),
  });
  assert.deepEqual(chiamate, [[-PGRP_BERSAGLIO, 0]]);
  assert.equal(foto.qualita, 'noti');
});

// --- processi veri: gruppo proprio del test, spenti per pid esatto ---------

test('sonda reale: capo vivo -> almeno; dopo la morte del gruppo -> noti/0', async (t) => {
  const figlio = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'],
    { detached: true, stdio: 'ignore' });
  figlio.unref();
  t.after(() => { try { process.kill(figlio.pid, 'SIGKILL'); } catch (_) { /* gia' morto */ } });
  const pgrp = gruppo.leggiPgrp(figlio.pid);
  assert.equal(pgrp, figlio.pid, 'il figlio staccato apre un gruppo proprio');
  const id = gruppo.leggiIdentitaDa('/proc', pgrp);
  assert.equal(id.esito, 'presente');
  const vivo = gruppo.sondaGruppo({ pgrp, identita: id });
  assert.equal(vivo.qualita, 'almeno');
  assert.ok(vivo.inGruppo >= 1);
  figlio.kill('SIGKILL');
  await new Promise((resolve) => { figlio.once('exit', resolve); });
  const dopo = gruppo.sondaGruppo({ pgrp, identita: id });
  assert.deepEqual(dopo, { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' });
});

test('sonda reale: capo morto con un altro membro vivo -> almeno, non pulito', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d582-due-'));
  const pidFile = path.join(dir, 'figlio.pid');
  const capo = path.join(dir, 'capo.js');
  fs.writeFileSync(capo, `'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const figlio = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(figlio.pid));
setInterval(() => {}, 60000);
`);
  const leader = spawn(process.execPath, [capo], { detached: true, stdio: 'ignore' });
  leader.unref();
  t.after(() => {
    try { fs.unlinkSync(pidFile); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const pgrp = gruppo.leggiPgrp(leader.pid);
  assert.equal(pgrp, leader.pid);
  const id = gruppo.leggiIdentitaDa('/proc', pgrp);
  const figlioPid = await new Promise((resolve, reject) => {
    const fine = Date.now() + 5000;
    const tick = () => {
      if (fs.existsSync(pidFile)) { resolve(Number(fs.readFileSync(pidFile, 'utf8'))); return; }
      if (Date.now() > fine) { reject(new Error('figlio non nato')); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
  t.after(() => {
    try { process.kill(figlioPid, 'SIGKILL'); } catch (_) { /* gia' morto */ }
  });
  leader.kill('SIGKILL');
  await new Promise((resolve) => { leader.once('exit', resolve); });
  // Il capo e' sparito (ENOENT su /proc/<pgrp>), il figlio resta nel gruppo.
  const foto = gruppo.sondaGruppo({ pgrp, identita: id });
  assert.equal(foto.qualita, 'almeno');
  assert.ok(foto.inGruppo >= 1);
});

// --- coerenza con la classifica --------------------------------------------

// Lease minimo: registra la richiesta di stop e consegna i frame che il test
// decide, come farebbe il supervisore vero sul canale di controllo.
function finLease(comportamento) {
  let ascolta = null;
  let suChiusura = null;
  const inviati = [];
  const mgr = {
    controlConnesso: () => true,
    sendControl: (id, frame) => {
      inviati.push(frame);
      setTimeout(() => comportamento({ emetti: (f) => ascolta && ascolta('c', f), chiudi: () => suChiusura && suChiusura(), frame }), 0);
      return true;
    },
    ascoltaControl: (cb) => { ascolta = cb; return () => { ascolta = null; }; },
    suChiusuraControl: (id, cb) => { suChiusura = cb; return () => { suChiusura = null; }; },
    inviati,
  };
  return mgr;
}

test('classifica: un\'osservazione che esplode non diventa un residuo positivo inventato', async () => {
  const mgr = finLease(({ emetti, chiudi, frame }) => {
    emetti({ op: 'ready-to-exit', payload: { stopRequestId: frame.requestId, conti: { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' } } });
    chiudi();
  });
  const esito = await gruppo.attendiFermataGruppo({
    leaseManager: mgr,
    cellId: 'c',
    launchId: 'l',
    monoNow: () => 0,
    deadlineAt: 5000,
    graziaMs: 500,
    attendiUscita: async () => ({ provato: true }),
    osserva: () => { throw errore('EACCES'); },
  });
  assert.equal(esito.outcome, 'stop-unknown');
  assert.ok(!esito.conti || esito.conti.inGruppo === 0,
    'nessun residuo positivo inventato da un errore');
});

test('classifica: un\'osservazione che non termina resta ignota e non sblocca l\'esito', async () => {
  const mgr = finLease(({ emetti, chiudi, frame }) => {
    emetti({ op: 'commit', payload: { stopRequestId: frame.requestId, conti: { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' } } });
    emetti({ op: 'escalate-commit', payload: { stopRequestId: frame.requestId, conti: { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' } } });
    chiudi();
  });
  const esito = await gruppo.attendiFermataGruppo({
    leaseManager: mgr,
    cellId: 'c',
    launchId: 'l',
    monoNow: () => 0,
    deadlineAt: 300,
    graziaMs: 200,
    attendiUscita: async () => ({ provato: true }),
    osserva: () => new Promise(() => {}),
  });
  // Prima del fix il fallback convenzionale `{inGruppo:1, qualita:'ignoti'}`
  // finiva in `stop-incomplete`: un residuo mai osservato, dichiarato come
  // fatto. Il censimento del supervisore resta nel record, ma non decide.
  assert.equal(esito.outcome, 'stop-unknown');
});
