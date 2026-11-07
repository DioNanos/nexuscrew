'use strict';
// Lato SUPERVISORE dello stop: il censimento di /proc non ha piu' un tetto al
// NUMERO di voci (che su un nodo carico non arriva mai in fondo e non dichiara
// mai il gruppo vuoto) ma un tetto al TEMPO, monotono e condiviso da
// enumerazione, letture, membri noti e yield. Una scansione parziale non da'
// mai «noti»; un errore di lettura non diventa zero.
//
// L'I/O e' asincrono e a concorrenza limitata: un `readFileSync` bloccato non
// e' reso bounded da un `setImmediate` ogni N letture, e il supervisore deve
// restare vivo (lease, cuore) mentre enumera. Il test del battito e' la prova
// che il ciclo cede davvero.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gruppo = require('../lib/fleet/group-stop.js');

const PGRP_BERSAGLIO = 515151;
const PGRP_ALTRI = 616161;

function errore(codice) {
  const e = new Error(`sintetico ${codice}`);
  e.code = codice;
  return e;
}

// /proc sintetica: `voci` e' una lista [pid, pgrp]. Nessun processo reale.
function procSintetica(t, voci) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-group-scan-'));
  fs.mkdirSync(path.join(root, 'self'));
  fs.writeFileSync(path.join(root, 'cpuinfo'), 'processor\t: 0\n');
  for (const [pid, pgrp] of voci) {
    fs.mkdirSync(path.join(root, String(pid)));
    fs.writeFileSync(path.join(root, String(pid), 'stat'),
      `${pid} (syn) S 1 ${pgrp} ${pgrp} 0 0 -1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0\n`);
  }
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

function vociEstranee(quanti, base = 4194000) {
  const voci = [];
  for (let i = 0; i < quanti; i += 1) voci.push([base + i, PGRP_ALTRI]);
  return voci;
}

// Ordine mescolato (deterministico): il difetto non deve dipendere dall'ordine
// di /proc ne' dal fatto che i membri stiano in coda.
function mescola(voci) {
  const copia = voci.slice();
  for (let i = copia.length - 1; i > 0; i -= 1) {
    const j = (i * 7919 + 13) % (i + 1);
    const t = copia[i]; copia[i] = copia[j]; copia[j] = t;
  }
  return copia;
}

const BUDGET = 5000;

test('scansione a tempo: oltre CAP_SCAN voci estranee, gruppo vuoto -> noti/0 (non almeno)', async (t) => {
  const voci = mescola(vociEstranee(340));
  const root = procSintetica(t, voci);
  const foto = await gruppo.osservaProduzioneLimitata({
    noti: [], pgrpTarget: PGRP_BERSAGLIO, procRoot: root,
    limite: BUDGET, monoNow: () => 0,
  });
  assert.equal(foto.qualita, 'noti');
  assert.equal(foto.inGruppo, 0);
});

test('scansione a tempo: limite esatto 255/256/257 e oltre 300, il tetto sulle voci non esiste piu\'', async (t) => {
  for (const quanti of [255, 256, 257, 301]) {
    const voci = vociEstranee(quanti);
    const root = procSintetica(t, voci);
    const foto = await gruppo.osservaProduzioneLimitata({
      noti: [], pgrpTarget: PGRP_BERSAGLIO, procRoot: root,
      limite: BUDGET, monoNow: () => 0,
    });
    assert.equal(foto.qualita, 'noti', `con ${quanti} voci`);
  }
});

test('scansione a tempo: i membri del gruppo si contano anche oltre il vecchio tetto', async (t) => {
  const voci = mescola(vociEstranee(320).concat([[4199001, PGRP_BERSAGLIO], [4199002, PGRP_BERSAGLIO]]));
  const root = procSintetica(t, voci);
  const foto = await gruppo.osservaProduzioneLimitata({
    noti: [], pgrpTarget: PGRP_BERSAGLIO, procRoot: root,
    limite: BUDGET, monoNow: () => 0,
  });
  assert.equal(foto.qualita, 'noti');
  assert.equal(foto.inGruppo, 2);
});

test('scansione a tempo: budget scaduto -> almeno, mai noti', async (t) => {
  const root = procSintetica(t, vociEstranee(300));
  let chiamate = 0;
  const foto = await gruppo.osservaProduzioneLimitata({
    noti: [], pgrpTarget: PGRP_BERSAGLIO, procRoot: root,
    limite: 300,
    // il tempo avanza a ogni lettura: il budget si consuma DURANTE il lavoro,
    // non solo all'ingresso
    monoNow: () => { chiamate += 1; return chiamate * 30; },
  });
  assert.equal(foto.qualita, 'almeno');
});

test('scansione a tempo: deadline gia\' scaduta -> ignoto, nessuna lettura', async (t) => {
  const root = procSintetica(t, vociEstranee(10));
  let letture = 0;
  const foto = await gruppo.osservaProduzioneLimitata({
    noti: [], pgrpTarget: PGRP_BERSAGLIO, procRoot: root,
    limite: 0, monoNow: () => 1,
    leggiStat: (p) => { letture += 1; return fs.promises.readFile(p, 'utf8'); },
  });
  assert.equal(foto.qualita, 'ignoti');
  assert.equal(letture, 0);
});

test('scansione a tempo: uno stat illeggibile degrada a ignoti, non a zero', async (t) => {
  const root = procSintetica(t, vociEstranee(40));
  const foto = await gruppo.osservaProduzioneLimitata({
    noti: [], pgrpTarget: PGRP_BERSAGLIO, procRoot: root,
    limite: BUDGET, monoNow: () => 0,
    leggiStat: (p) => (p.endsWith('/4194017/stat')
      ? Promise.reject(errore('EACCES'))
      : fs.promises.readFile(p, 'utf8')),
  });
  assert.equal(foto.qualita, 'ignoti');
});

test('scansione a tempo: enumerazione negata -> ignoti, nessun conteggio inventato', async (t) => {
  const root = procSintetica(t, vociEstranee(10));
  const foto = await gruppo.osservaProduzioneLimitata({
    noti: [], pgrpTarget: PGRP_BERSAGLIO, procRoot: root,
    limite: BUDGET, monoNow: () => 0,
    leggiDir: () => Promise.reject(errore('EACCES')),
  });
  assert.deepEqual(foto, { inGruppo: 0, fuoriGruppo: 0, qualita: 'ignoti' });
});

test('scansione a tempo: una lettura che non termina non blocca oltre il budget', async (t) => {
  const root = procSintetica(t, vociEstranee(40));
  const inizio = Date.now();
  const foto = await gruppo.osservaProduzioneLimitata({
    noti: [], pgrpTarget: PGRP_BERSAGLIO, procRoot: root,
    limite: Date.now() + 200, monoNow: () => Date.now(),
    leggiStat: (p) => (p.endsWith('/4194000/stat')
      ? new Promise(() => {})
      : fs.promises.readFile(p, 'utf8')),
  });
  assert.equal(foto.qualita, 'almeno');
  assert.ok(Date.now() - inizio < 2000, 'la scansione deve rientrare dal budget');
});

test('scansione a tempo: il ciclo cede l\'event loop mentre enumera (battito)', async (t) => {
  // Letture di PRODUZIONE (fs.promises) e seam non iniettati: il battito misura
  // il ciclo vero. Con letture sincrone e nessuno yield la scansione resta in
  // un solo task e il timer non puo' scattare prima della fine.
  const voci = vociEstranee(600);
  const root = procSintetica(t, voci);
  // L'enumerazione e' data dal seam in forma SINCRONA: l'unica sorgente di
  // turno che resta e' quella del ciclo di lettura. Altrimenti una singola
  // readdir asincrona basterebbe a far scattare il timer e il test misurerebbe
  // lei, non il ciclo.
  const nomi = voci.map(([pid]) => String(pid));
  let finito = false;
  let battitoDurante = false;
  const timer = setTimeout(() => { if (!finito) battitoDurante = true; }, 0);
  const foto = await gruppo.osservaProduzioneLimitata({
    noti: [], pgrpTarget: PGRP_BERSAGLIO, procRoot: root,
    limite: BUDGET, monoNow: () => 0,
    leggiDir: () => nomi,
  });
  finito = true;
  clearTimeout(timer);
  assert.equal(foto.qualita, 'noti');
  assert.equal(battitoDurante, true, 'un timer deve poter scattare durante la scansione');
});

test('cancellazione: il budget scaduto abortisce la lettura e nessun risultato tardivo', async (t) => {
  const root = procSintetica(t, vociEstranee(10));
  const segnali = [];
  let completate = 0;
  const inizio = Date.now();
  const foto = await gruppo.osservaProduzioneLimitata({
    noti: [], pgrpTarget: PGRP_BERSAGLIO, procRoot: root,
    limite: Date.now() + 25,
    monoNow: () => Date.now(),
    leggiStat: (percorso, opts) => new Promise((resolve, reject) => {
      segnali.push(opts && opts.signal);
      const timer = setTimeout(() => { completate += 1; resolve('1 (syn) S 1 1 1'); }, 100);
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        }, { once: true });
      }
    }),
  });
  assert.notEqual(foto.qualita, 'noti');
  assert.ok(Date.now() - inizio < 500, 'il chiamante deve rientrare dal budget');
  assert.ok(segnali.length > 0, 'il lettore deve ricevere un signal di cancellazione');
  assert.ok(segnali.some((sig) => sig && sig.aborted === true),
    'il signal deve essere abortito alla scadenza');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(completate, 0, 'nessuna lettura deve completarsi dopo il ritorno');
});

// --- i siti di osservazione nel coordinatore --------------------------------

function ctxStop({ osserva, deadlineMs = 400, monoNow = () => Date.now() }) {
  const inviati = [];
  return {
    inviati,
    frame: { payload: { deadlineMs }, requestId: 'r'.repeat(16), epoch: 1 },
    tokenHash: 'a'.repeat(64),
    launchId: 'l'.repeat(16),
    monoNow,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    killGruppo: () => {},
    osserva,
    invia: (f) => { inviati.push(f); return true; },
    svuota: async () => true,
    cancellaDelivery: async () => null,
    scriviLog: () => {},
  };
}

test('coordinatore: il ramo EPERM attende l\'osservazione, non serializza una Promise', async () => {
  const ctx = ctxStop({
    osserva: () => new Promise((resolve) => { setTimeout(() => resolve({ inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }), 20); }),
  });
  ctx.killGruppo = (s) => { if (s === 'SIGTERM') throw errore('EPERM'); };
  const esito = await gruppo.eseguiFaseStop(ctx);
  assert.equal(esito.outcome, 'eperm');
  assert.deepEqual(esito.conti, { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' });
  const report = ctx.inviati.find((f) => f.op === 'stop-report');
  assert.deepEqual(report.payload.conti, { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' });
});

test('coordinatore: deadline gia\' spesa, nessuna Promise serializzata nei conti', async () => {
  let ora = 0;
  const ctx = ctxStop({
    deadlineMs: 100,
    monoNow: () => ora,
    osserva: () => new Promise((resolve) => { setTimeout(() => resolve({ inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }), 20); }),
  });
  // Il tempo passa OLTRE la deadline mentre la delivery si chiude: il sito
  // della deadline non ha residuo da attendere, quindi non lancia l'osservazione
  // grezza (una Promise finirebbe nei conti) e dichiara `ignoti`.
  ctx.cancellaDelivery = async () => { ora = 1000; };
  const esito = await gruppo.eseguiFaseStop(ctx);
  assert.equal(esito.outcome, 'stop-unknown');
  assert.deepEqual(esito.conti, { inGruppo: 0, fuoriGruppo: 0, qualita: 'ignoti' });
});

test('coordinatore: un\'osservazione che non termina non tiene appesa la fase', async () => {
  const inizio = Date.now();
  const ctx = ctxStop({
    deadlineMs: 300,
    osserva: () => new Promise(() => {}),
  });
  const esito = await gruppo.eseguiFaseStop(ctx);
  assert.notEqual(esito.outcome, 'ready-to-exit');
  assert.ok(Date.now() - inizio < 3000, 'la fase deve rientrare dal budget');
});
