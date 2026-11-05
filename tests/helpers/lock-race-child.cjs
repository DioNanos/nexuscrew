'use strict';
// Figlio di test del lock di scrittore: esegue acquisisci() sulla radice data,
// ma prima della PRIMA pubblicazione esclusiva del file `bersaglio` si ferma su
// una barriera (file `via`), cosi' il test porta due processi esattamente allo
// stesso punto prima di lasciarli correre. Il wrapper e' dal lato del test:
// nessun faultPoint nel codice di produzione. Stampa l'esito su stdout e resta
// vivo (se `tieni`) finche' non lo ferma il test, per PID esatto.
const fs = require('node:fs');
const path = require('node:path');
const spec = JSON.parse(process.argv[2]);
const lock = require(path.join(__dirname, '..', '..', 'lib', 'fleet', 'launch-writer-lock.js'));

if (spec.barriera) {
  const originale = fs.linkSync;
  let fermato = false;
  fs.linkSync = function avvolta(...args) {
    if (!fermato && String(args[1]).endsWith(spec.barriera.bersaglio)) {
      fermato = true;
      fs.writeFileSync(path.join(spec.barriera.dir, `pronto.${process.pid}`), '');
      const buf = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(path.join(spec.barriera.dir, 'via'))) Atomics.wait(buf, 0, 0, 5);
    }
    return originale.apply(this, args);
  };
}
const r = lock.acquisisci(spec.root);
process.stdout.write(`${JSON.stringify({ ok: r.ok, codice: r.codice || null })}\n`);
if (spec.tieni) setInterval(() => {}, 1000000); else process.exit(0);
