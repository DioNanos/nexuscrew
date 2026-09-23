'use strict';
// Scrittore per il test di concorrenza di `lib/files/activity.js`.
// Non e' un test: e' un PROCESSO. Serve perche' la concorrenza vera fra hook
// non si riproduce con lo stesso thread — `scriviStato` e' sincrono, e cinque
// chiamate dentro `Promise.resolve().then(...)` girano in sequenza.
//
// Partenza a BARRIERA in due fasi, come nel caso peggiore misurato:
//   1. il figlio dichiara di essere pronto (`ready-<i>`);
//   2. aspetta che il padre apra la barriera, e solo allora scrive.
// Senza la fase 1 il ritardo di spawn scaglionerebbe le scritture da solo, e il
// test non proverebbe niente.
//
// Uso: node activity-concurrent-writer.js <dir> <evento> <ts> <barriera> <ready> <gen>
//
// La generazione c'e' perche' senza di essa l'evento non e' leggibile: e' il
// lancio che lega lo stato al client che l'ha prodotto.

const fs = require('node:fs');
const { scriviStato } = require('../../lib/files/activity.js');

const [dir, evento, ts, barriera, ready, generazione] = process.argv.slice(2);

fs.writeFileSync(ready, '');

// Attesa attiva sulla barriera: e' l'unico modo di avere partenze simultanee
// fra processi diversi senza portarsi dietro un IPC.
const scadenza = Date.now() + 15000;
while (!fs.existsSync(barriera)) {
  if (Date.now() > scadenza) { process.stdout.write('timeout'); process.exit(0); }
}

const ok = scriviStato(dir, { evento, ora: Number(ts), generazione });
process.stdout.write(ok ? 'ok' : 'persa');
