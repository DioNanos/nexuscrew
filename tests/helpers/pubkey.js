'use strict';

// Una COPPIA di chiavi vera, generata da ssh-keygen.
//
// La storia di questo helper e' la storia del difetto che accompagna. Prima
// costruivo un finto a mano (`ssh-ed25519 AAAAC3Test prova`): piu' permissivo
// del vero, e i test erano verdi su un input che in produzione non esiste. Poi
// ho costruito il blob byte per byte — e l'ho costruito male, dichiarando 32 e
// scrivendone di piu': rifiutato da `ssh-keygen -l`, accettato dal nostro
// parser, cioe' un test che validava il parser con un input costruito sullo
// stesso sottoinsieme di formato che il parser controllava.
//
// Adesso non serve piu' costruire niente, perche' il prodotto non legge piu' il
// file `.pub`: DERIVA la pubblica dalla privata con `ssh-keygen -y`. Quindi il
// solo finto onesto e' una coppia vera, e i test che vogliono provare il
// legame fra le due meta' hanno bisogno di due coppie DIVERSE.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * Genera una coppia in `dir` e torna il path della chiave PRIVATA — che e'
 * quello che il prodotto usa (`identityFile`). Il `.pub` finisce accanto, come
 * fa ssh-keygen, ma il prodotto non lo legge: serve solo ai test che vogliono
 * metterlo in disaccordo con la privata.
 */
function generaCoppia(dir, nome = 'id_ed25519', commento = 'prova@test') {
  const key = path.join(dir, nome);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', commento, '-f', key], {
    stdio: 'ignore', timeout: 20000,
  });
  return key;
}

/** true se ssh-keygen c'e' su questa macchina. Un oracolo assente va DICHIARATO. */
function sshKeygenDisponibile() {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (e) {
    return !(e && e.code === 'ENOENT');
  }
}

module.exports = { generaCoppia, sshKeygenDisponibile };
