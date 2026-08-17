'use strict';
// Probe sotto PTY per il test P4 (permitopen-pannello.test.js).
//
// Il test che lo lancia lo fa girare DENTRO un PTY reale (node-pty, lo stesso
// provider dei terminali): il controlling terminal non e' un dettaglio, e'
// l'esperimento stesso. Senza controlling terminal `ssh-keygen` non apre
// /dev/tty per chiedere la passphrase, e il difetto non si tocca: il test
// resterebbe verde sul codice rotto — ed e' esattamente cosi' che il gate
// non-PTY non ha visto niente per tre giri.
//
// Per questo la probe MISURA il controlling terminal (open di /dev/tty) e lo
// riporta nell'esito: un verde che mente sul tty non vale niente, e chi legge
// il risultato lo vede.
//
// Uso: node pubkey-pty-probe.js <path-privata> [timeoutMs]
// Stampa UNA riga JSON: { esito, elapsedMs, tty } — il test la parsa.

const fs = require('node:fs');
const tunnel = require('../../lib/nodes/tunnel.js');

const [key, timeoutMsRaw] = process.argv.slice(2);
const timeoutMs = Number(timeoutMsRaw);

let tty = 'chiuso';
try {
  const fd = fs.openSync('/dev/tty', 'r');
  fs.closeSync(fd);
  tty = 'aperto';
} catch (_) { /* nessun controlling terminal: dichiarato nell'esito */ }

const t0 = Date.now();
const esito = tunnel.readPublicKey(key, Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {});
const elapsedMs = Date.now() - t0;

process.stdout.write(JSON.stringify({ esito, elapsedMs, tty }) + '\n');
