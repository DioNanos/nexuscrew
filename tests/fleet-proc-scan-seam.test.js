'use strict';
// Seam `procRoot` di osservaProduzione: la produzione legge sempre /proc con
// CAP_SCAN; il seam permette di montare una /proc sintetica con piu' voci del
// tetto per forzare il regime «affollato» senza generare processi veri e senza
// monkey-patch dell'fs del processo. I default restano quelli di produzione:
// senza opzioni la lettura e' la /proc reale, con lo stesso tetto di sempre.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gruppo = require('../lib/fleet/group-stop.js');

const CAP_SCAN = 256;
const PGRP_BERSAGLIO = 424242;
const PGRP_ALTRI = 777777;

// Monta una /proc sintetica: `quanti` directory numeriche con uno stat
// plausibile (parser vero: lastIndexOf(')') + campi dopo il comm). I pid in
// `inGruppo` portano il pgrp del bersaglio, tutti gli altri un gruppo
// estraneo, come le centinaia di processi di un nodo carico. Le entry non
// numeriche (self, cpuinfo) non contano nel tetto, come in produzione.
function montaProc(t, { quanti = 320, inGruppo = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s4-proc-'));
  fs.mkdirSync(path.join(root, 'self'));
  fs.writeFileSync(path.join(root, 'cpuinfo'), 'processor\t: 0\n');
  const nelGruppo = new Set(inGruppo);
  const scriviStat = (pid, grp) => {
    fs.mkdirSync(path.join(root, String(pid)));
    fs.writeFileSync(path.join(root, String(pid), 'stat'),
      `${pid} (syn) S 1 ${grp} ${grp} 0 0 -1 0 -1 0 0 0 0 0 0 0 0 0 0 0\n`);
  };
  for (let i = 0; i < quanti; i += 1) {
    const pid = 4194000 + i;
    scriviStat(pid, nelGruppo.has(pid) ? PGRP_BERSAGLIO : PGRP_ALTRI);
  }
  for (const pid of nelGruppo) {
    if (pid >= 4194000 && pid < 4194000 + quanti) continue;
    scriviStat(pid, PGRP_BERSAGLIO);
  }
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('seam procRoot: piu\' di CAP_SCAN voci -> regime affollato (almeno), come sul nodo carico', (t) => {
  const root = montaProc(t, { quanti: CAP_SCAN + 50 });
  const foto = gruppo.osservaProduzione([], PGRP_BERSAGLIO, { procRoot: root });
  assert.equal(foto.qualita, 'almeno', 'oltre il tetto il censimento resta non completo');
  assert.equal(foto.inGruppo, 0);
  assert.equal(foto.fuoriGruppo, 0);
});

test('seam procRoot: sotto il tetto, stat tutti leggibili, il censimento resta completo (noti) e conta il gruppo', (t) => {
  const root = montaProc(t, { quanti: 10, inGruppo: [4194003, 4194007] });
  const foto = gruppo.osservaProduzione([], PGRP_BERSAGLIO, { procRoot: root });
  assert.equal(foto.qualita, 'noti');
  assert.equal(foto.inGruppo, 2, 'i pid sintetici nel gruppo del bersaglio vengono contati');
});

test('seam cap: un tetto piu\' basso produce lo stesso regime affollato con meno voci', (t) => {
  const root = montaProc(t, { quanti: 8 });
  assert.equal(gruppo.osservaProduzione([], PGRP_BERSAGLIO, { procRoot: root, cap: 4 }).qualita, 'almeno');
  // senza opzioni il tetto e' quello di prodotto: 8 voci sono censite tutte
  assert.equal(gruppo.osservaProduzione([], PGRP_BERSAGLIO, { procRoot: root }).qualita, 'noti');
});

test('seam procRoot: uno stat illeggibile su un pid nuovo degrada a ignoti, senza inventare conteggi', (t) => {
  const root = montaProc(t, { quanti: 5 });
  // non un pid morto (stat assente -> 0, scartato): uno stat CORROTTO, la cui
  // lettura non sa dire il gruppo -> ignoto
  fs.writeFileSync(path.join(root, '4194001', 'stat'), 'senza parentesi\n');
  const foto = gruppo.osservaProduzione([], PGRP_BERSAGLIO, { procRoot: root });
  assert.equal(foto.qualita, 'ignoti');
  assert.equal(foto.inGruppo, 0);
});

test('censimento affollato dal seam: senza attestazione il pulito non si dichiara, con l\'attestazione si\'', (t) => {
  const root = montaProc(t, { quanti: CAP_SCAN + 10 });
  const affollato = gruppo.osservaProduzione([], PGRP_BERSAGLIO, { procRoot: root });
  assert.equal(affollato.qualita, 'almeno');
  const pronto = { conti: { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' } };
  // senza attestazione il censimento affollato resta non dichiarabile
  assert.equal(gruppo.classificaEsito({ ready: pronto, uscito: true, dopo: affollato }).outcome, 'stop-unknown');
  // con l'attestazione (uscita provata + sessione assente DOPO la prova) il
  // censimento affollato non serve: le due prove non enumerano /proc
  const attestato = gruppo.classificaEsito({ ready: pronto, uscito: true, sessioneAssente: true, dopo: affollato });
  assert.equal(attestato.outcome, 'killed-clean');
  assert.equal(attestato.attestato, true);
});

test('default di produzione: senza opzioni osservaProduzione legge la /proc vera, forma invariata', (t) => {
  const mio = gruppo.leggiPgrp(process.pid);
  assert.ok(mio, 'il gruppo del processo del test deve essere leggibile in /proc');
  const foto = gruppo.osservaProduzione([], mio);
  assert.ok(['noti', 'almeno', 'ignoti'].includes(foto.qualita));
  assert.ok(Number.isSafeInteger(foto.inGruppo));
  assert.ok(Number.isSafeInteger(foto.fuoriGruppo));
});
