'use strict';

// Una chiave pubblica OpenSSH VALIDA, per i test che ne hanno bisogno.
//
// Perche' esiste: i finti scritti a mano (`ssh-ed25519 AAAAC3Test prova`) erano
// piu' PERMISSIVI del vero — un blob che ssh non accetterebbe mai. Finche' la
// lettura non validava niente passavano, e i test erano verdi su un input che
// in produzione non esiste. Appena la lettura ha iniziato a validare — perche'
// un `.pub` con due chiavi concatenate produceva un blocco copiabile la cui
// seconda riga era una chiave SENZA restrizioni — quei finti sono diventati
// rossi tutti insieme.
//
// Il nome dell'algoritmo e' scritto ANCHE dentro il blob, ed e' cio' che la
// lettura confronta: costruirlo qui tiene i test indipendenti da ssh-keygen e
// dalla macchina su cui girano.
const crypto = require('node:crypto');

function stringaSsh(s) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(s.length);
  return Buffer.concat([len, Buffer.from(s)]);
}

/**
 * @param {string} algo nome dell'algoritmo (deve stare anche dentro il blob)
 * @param {string} commento parte finale libera, puo' contenere spazi
 */
function pubValida(algo = 'ssh-ed25519', commento = 'prova@test') {
  const corpo = crypto.randomBytes(32);
  const blob = Buffer.concat([stringaSsh(algo), stringaSsh(corpo.toString('binary'))]).toString('base64');
  return `${algo} ${blob} ${commento}`;
}

module.exports = { pubValida };
