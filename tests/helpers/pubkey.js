'use strict';

// Una chiave pubblica OpenSSH VERA, per i test che ne hanno bisogno.
//
// Perche' esiste, e perche' la prima versione era sbagliata. I finti scritti a
// mano (`ssh-ed25519 AAAAC3Test prova`) erano piu' PERMISSIVI del vero: finche'
// la lettura non validava niente passavano, e i test erano verdi su un input
// che in produzione non esiste. Ho allora costruito il blob a mano — e l'ho
// costruito MALE: `stringaSsh(corpo.toString('binary'))` dichiarava lunghezza
// 32 e poi ricodificava in UTF-8, appendendo spesso piu' di 32 byte. Il
// risultato era rifiutato da `ssh-keygen -l` e accettato dal nostro parser,
// cioe' il test validava il parser con un input costruito sullo stesso
// sottoinsieme di formato che il parser controllava. Un oracolo che si guarda
// allo specchio.
//
// Ora la chiave la genera Node con la sua implementazione di ed25519, e la si
// serializza nel formato di rete SSH: `string` = uint32BE(len) + byte. Il test
// che accompagna questo helper la fa validare da `ssh-keygen -l`, cioe' da chi
// esegue davvero l'operazione, non da noi.
const crypto = require('node:crypto');

// Un campo SSH: la lunghezza in byte del VALORE, poi il valore. Prende un
// Buffer, mai una stringa: era li' che nasceva il difetto.
function campoSsh(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

/**
 * Chiave pubblica ed25519 valida, nel formato di `~/.ssh/id_ed25519.pub`.
 * @param {string} commento parte finale libera, puo' contenere spazi
 */
function pubValida(commento = 'prova@test') {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  // Il DER di una ed25519 finisce con i 32 byte grezzi della chiave.
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const grezza = der.subarray(der.length - 32);
  const algo = 'ssh-ed25519';
  const blob = Buffer.concat([campoSsh(Buffer.from(algo)), campoSsh(grezza)]).toString('base64');
  return `${algo} ${blob} ${commento}`;
}

module.exports = { pubValida, campoSsh };
