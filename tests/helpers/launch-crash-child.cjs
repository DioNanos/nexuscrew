'use strict';
// Figlio di test che esegue un up() sul mondo finto e MUORE a un confine
// preciso, con SIGKILL su se stesso (process.kill(process.pid)): nessun
// processo trovato per nome, nessun segnale ad altri. Il confine e' deciso dal
// test con un argomento JSON; l'iniezione avvolge funzioni del modulo del
// record dal LATO DEL TEST, non esiste alcun faultPoint nel codice di
// produzione. Se il confine non viene mai raggiunto il figlio esce 0 e stampa
// l'esito dell'up su stdout, cosi' il test che si aspettava una morte fallisce.
//
// spec = {
//   descr,                      // descrittore di scriviMondo()
//   protezioneFallisceDopo: n,  // ensureProtection lancia alla n-esima chiamata (opz.)
//   crash: { dove: 'issue' }    // muore quando il broker emette il ticket
//        | { dove: 'record', fn: 'registraPrepared'|'avanza', quando: 'prima'|'dopo', fase?: 'creating'|... }
// }

const path = require('node:path');
const spec = JSON.parse(process.argv[2]);
const launchTarget = require(path.join(__dirname, '..', '..', 'lib', 'fleet', 'launch-target.js'));
const { apriRuntime } = require('./launch-world.js');

function muori() {
  process.kill(process.pid, 'SIGKILL');
}

const opzioni = {};
if (spec.owner) opzioni.owner = true;
if (spec.nodo) opzioni.cfg = { identitaNodoKernel: () => spec.nodo };
if (Number.isInteger(spec.protezioneFallisceDopo)) {
  let n = 0;
  opzioni.ensureProtection = async () => {
    n += 1;
    if (n > spec.protezioneFallisceDopo) throw new Error('protezione non disponibile');
  };
}
if (spec.crash && spec.crash.dove === 'issue') {
  opzioni.issue = async () => { muori(); return null; };
}
if (spec.crash && spec.crash.dove === 'record') {
  const { fn, quando, fase } = spec.crash;
  const originale = launchTarget[fn];
  if (typeof originale !== 'function') {
    process.stdout.write(JSON.stringify({ nonEsiste: fn }));
    process.exit(3);
  }
  launchTarget[fn] = function avvolta(...args) {
    const o = args[2] || {};
    const corrisponde = !fase || (o && (o.a === fase || o.phase === fase));
    if (corrisponde && quando === 'prima') muori();
    const r = originale.apply(this, args);
    if (corrisponde && quando === 'dopo') muori();
    return r;
  };
}

// Morte a un confine del filesystem (commit della riconciliazione):
//   { dove: 'fs', fn: 'unlinkSync', suffisso: '/launch-targets/<sessione>.json', quando: 'prima'|'dopo' }
if (spec.crash && spec.crash.dove === 'fs') {
  const fs = require('node:fs');
  const { fn, suffisso, quando } = spec.crash;
  const originale = fs[fn];
  fs[fn] = function avvoltaFs(...args) {
    const bersaglio = typeof args[0] === 'string' && args[0].endsWith(suffisso);
    if (bersaglio && quando === 'prima') muori();
    const r = originale.apply(this, args);
    if (bersaglio && quando === 'dopo') muori();
    return r;
  };
}

// Il figlio che TIENE il lock di scrittore finche' vive (poi lo ferma il test, per PID esatto).
if (spec.azione === 'tieni-lock') {
  const lock = require(path.join(__dirname, '..', '..', 'lib', 'fleet', 'launch-writer-lock.js'));
  const r = lock.acquisisci(spec.descr.filesRoot);
  process.stdout.write(JSON.stringify({ lock: r.ok }) + '\n');
  setInterval(() => {}, 1000000);
} else {
(async () => {
  const { runtime } = apriRuntime(spec.descr, opzioni);
  try {
    const r = spec.azione === 'down' ? await runtime.down(spec.descr.cella) : await runtime.up(spec.descr.cella);
    process.stdout.write(JSON.stringify({ ok: true, r: { ok: r && r.ok, outcome: r && r.outcome } }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ errore: e && (e.fleetCode || e.message) }));
  }
  process.exit(0);
})();
}
