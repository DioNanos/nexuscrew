'use strict';
// Un SOLO formatter al confine UI/log per gli esiti del resolver della
// pubblica (job 5, strutturale). Prima le frasi si componevano in basso —
// nel supervisor e nella route — dove non si sa abbastanza per scriverle:
// meta' della 0.9.5 e' nata cosi' (promesse false, cause enumerate «a caso»,
// silenzi). Ora il resolver produce DATI enumerati (resolvePublicKey in
// tunnel.js) e QUESTO punto unico li trasforma in frasi. Un test per ogni
// causa.

const path = require('node:path');
const {
  PUBKEY_DERIVED, PUBKEY_NO_IDENTITY, PUBKEY_ACTUAL_KEY_UNKNOWN,
  PUBKEY_TOOL_UNAVAILABLE, PUBKEY_ENCRYPTED_OR_UNREADABLE,
} = require('./tunnel.js');

// La frase della CAUSA per ogni esito — il «perche'» che chi guarda deve
// leggere. `resolution` e' il dato del risolutore; `identityFile` il path
// dichiarato, per nominare l'oggetto giusto. Non inventare mai una causa che
// il dato non porta: l'ignosciuto si dice sconosciuto, non si indovina.
function pubkeyCauseText(resolution, { identityFile } = {}) {
  const nome = identityFile ? path.basename(identityFile) : null;
  switch (resolution && resolution.outcome) {
    case PUBKEY_DERIVED:
      // Nessuna causa da dichiarare: la riga c'e'.
      return null;
    case PUBKEY_NO_IDENTITY:
      return `la chiave dichiarata${nome ? ` (${nome})` : ''} non esiste dove dovrebbe`;
    case PUBKEY_ACTUAL_KEY_UNKNOWN:
      return 'nessun -i: ssh usa le chiavi di default, un agent o la config, e da qui non si sa quale';
    case PUBKEY_TOOL_UNAVAILABLE:
      return 'ssh-keygen non e\' disponibile su questa macchina: la pubblica non si puo\' derivare';
    case PUBKEY_ENCRYPTED_OR_UNREADABLE:
      return `non riesco a derivare la pubblica da ${nome || 'quella chiave'}: e' cifrata o illeggibile`;
    default:
      // Al confine, l'ignosciuto si NOMINA: un silenzio qui sarebbe lo stesso
      // difetto che questo modulo chiude.
      return `esito non riconosciuto: ${resolution && resolution.outcome}`;
  }
}

// L'AZIONE suggerita per ogni esito — il «cosa fare» accanto al perche'.
// Aspettare non serve dove bisogna concedere; riprovare non serve dove la
// condizione dipende da una decisione altrove.
function pubkeyActionText(resolution) {
  switch (resolution && resolution.outcome) {
    case PUBKEY_DERIVED:
      return 'sostituisci la riga in ~/.ssh/authorized_keys del nodo con questa';
    case PUBKEY_NO_IDENTITY:
      return 'verifica il path della chiave dichiarata per questo nodo';
    case PUBKEY_ACTUAL_KEY_UNKNOWN:
      return 'individua la chiave che ssh usa davvero e modifica A MANO la sua riga';
    case PUBKEY_TOOL_UNAVAILABLE:
      return 'installa ssh-keygen (openssh-client), poi riprova';
    case PUBKEY_ENCRYPTED_OR_UNREADABLE:
      return 'usa una chiave dedicata non cifrata per questo nodo, o modifica A MANO la riga';
    default:
      return 'verifica la configurazione del nodo';
  }
}

// La nota del pairing quando la riga c'e': il testo che accompagnava la
// risposta, ora composto qui (l'unico punto) e non nella route.
function pubkeyPairingNote(resolution, { panelPort } = {}) {
  if (!resolution || resolution.outcome !== PUBKEY_DERIVED) return null;
  return 'il peer ha un pannello sulla propria porta ' + panelPort
    + ': SOSTITUISCI la riga già installata in ~/.ssh/authorized_keys del NODO con questa (due destinazioni), altrimenti il canale del pannello sarà rifiutato. È la riga della chiave DICHIARATA per questo nodo (-i), non un\'eventuale chiave "jump" dello stesso nodo. Se ssh sceglie un\'altra identità (agent o config), la riga giusta è quella della chiave che usa davvero.';
}

module.exports = { pubkeyCauseText, pubkeyActionText, pubkeyPairingNote };
