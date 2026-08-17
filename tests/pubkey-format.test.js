'use strict';
// Job 5 — un solo formatter al confine UI/log: un test per ogni causa del
// resolver enumerato. Le frasi non si compongono piu' in basso, dove non si
// sa abbastanza per scriverle: qui il dato entra e il testo esce, e ogni
// causa ha la SUA frase e la SUA azione.
const test = require('node:test');
const assert = require('node:assert');
const tunnel = require('../lib/nodes/tunnel.js');
const supervisor = require('../lib/nodes/tunnel-supervisor.js');
const {
  pubkeyCauseText, pubkeyActionText, pubkeyPairingNote,
} = require('../lib/nodes/pubkey-format.js');

test('pubkeyCauseText: derived — nessuna causa da dichiarare', () => {
  assert.equal(pubkeyCauseText({ outcome: tunnel.PUBKEY_DERIVED, line: 'ssh-ed25519 AAA x' }), null,
    'se la riga c\'e\', non c\'e\' nessuna causa da dire');
});

test('pubkeyCauseText: no-identity — nomina il file che manca, non una lista di possibilita\'', () => {
  const t = pubkeyCauseText({ outcome: tunnel.PUBKEY_NO_IDENTITY, path: '/x/id_ed25519' },
    { identityFile: '/x/id_ed25519' });
  assert.ok(t.includes('id_ed25519'), 'nomina l\'oggetto giusto');
  assert.ok(t.includes('non esiste'), 'dice il fatto: il file manca');
  assert.ok(!t.includes('cifrata'), 'e non inventa cause diverse');
});

test('pubkeyCauseText: actual-key-unknown — la chiave di ssh non e\' sapibile', () => {
  const t = pubkeyCauseText({ outcome: tunnel.PUBKEY_ACTUAL_KEY_UNKNOWN });
  assert.ok(t.includes('default') && t.includes('agent') && t.includes('config'),
    'dice dove va a finire la scelta: default, agent, config');
});

test('pubkeyCauseText: tool-unavailable — ssh-keygen assente, DISTINCTO dalla chiave cifrata', () => {
  const t = pubkeyCauseText({ outcome: tunnel.PUBKEY_TOOL_UNAVAILABLE });
  assert.ok(t.includes('ssh-keygen'), 'nomina lo strumento che manca');
  const cifrata = pubkeyCauseText({ outcome: tunnel.PUBKEY_ENCRYPTED_OR_UNREADABLE },
    { identityFile: '/x/k' });
  assert.notEqual(t, cifrata, 'le due cause non condividono la frase: prima erano lo stesso silenzio');
});

test('pubkeyCauseText: encrypted-or-unreadable — cifrata o illeggibile, non «manca»', () => {
  const t = pubkeyCauseText({ outcome: tunnel.PUBKEY_ENCRYPTED_OR_UNREADABLE },
    { identityFile: '/x/id_ed25519' });
  assert.ok(t.includes('cifrata o illeggibile'), 'dice la causa vera');
  assert.ok(t.includes('id_ed25519'), 'nomina l\'oggetto');
  assert.ok(!t.includes('non esiste'), 'e non dice che manca: il file c\'e\'');
});

test('pubkeyCauseText: esito sconosciuto — si NOMINA, non si tace', () => {
  const t = pubkeyCauseText({ outcome: 'qualcosa-di-mai-visto' });
  assert.ok(t.includes('qualcosa-di-mai-visto'),
    'l\'ignosciuto al confine si dice sconosciuto: un silenzio qui riaprirebbe il difetto');
});

test('pubkeyActionText: ogni causa suggerisce la SUA azione', () => {
  const azioni = [
    tunnel.PUBKEY_DERIVED, tunnel.PUBKEY_NO_IDENTITY, tunnel.PUBKEY_ACTUAL_KEY_UNKNOWN,
    tunnel.PUBKEY_TOOL_UNAVAILABLE, tunnel.PUBKEY_ENCRYPTED_OR_UNREADABLE,
  ].map((outcome) => pubkeyActionText({ outcome }));
  assert.equal(new Set(azioni).size, 5, 'cinque cause, cinque azioni distinte');
  assert.ok(azioni[1].includes('verifica il path'), 'no-identity: verificare il path');
  assert.ok(azioni[3].includes('installa'), 'tool-unavailable: installare ssh-keygen');
});

test('pubkeyPairingNote: solo con derived, e nomina la porta pannello', () => {
  const nota = pubkeyPairingNote({ outcome: tunnel.PUBKEY_DERIVED }, { panelPort: 41821 });
  assert.ok(nota.includes('41821') && nota.includes('SOSTITUISCI'),
    'la nota dice quale porta e cosa fare della riga');
  assert.equal(pubkeyPairingNote({ outcome: tunnel.PUBKEY_NO_IDENTITY }, { panelPort: 41821 }), null,
    'senza riga nessuna nota: il dato (outcome) viaggia da solo');
});

test('refusalDetails: la causa ESATTA nel hint, non l\'enumerazione «a caso»', () => {
  // identityFile dichiarata ma assente: prima finiva nel calderone «privata
  // assente o illeggibile, protetta da passphrase, oppure ssh-keygen non
  // disponibile»; ora il hint nomina la causa vera.
  const mancante = supervisor.refusalDetails({
    remoteDestinations: ['127.0.0.1:41821'], identityFile: '/x/inesistente',
  });
  assert.equal(mancante.outcome, tunnel.PUBKEY_NO_IDENTITY, 'l\'esito enumerato viaggia col hint');
  assert.ok(mancante.hint.includes('non esiste'), 'il hint dice la causa esatta');
  assert.ok(!mancante.hint.includes('protetta da passphrase'),
    'e non elenca piu\' possibilita\' a caso');
  assert.equal(mancante.authorizedKeys, '', 'senza riga niente mezza istruzione');

  // Nessun -i: causa actual-key-unknown, distinta dalla precedente.
  const senzaI = supervisor.refusalDetails({ remoteDestinations: ['127.0.0.1:41821'] });
  assert.equal(senzaI.outcome, tunnel.PUBKEY_ACTUAL_KEY_UNKNOWN);
  assert.notEqual(senzaI.hint, mancante.hint, 'due cause, due hint');
});
