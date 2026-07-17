'use strict';
// Regressioni UI del pairing single-link (asserzioni statiche sui sorgenti,
// stesso pattern di ui-fleet-controls): card prominente in Settings e Wizard,
// scanner live con cleanup, campi avanzati chiusi di default, errori a stadi
// mai inghiottiti. La parte camera (getUserMedia) non è esercitabile in Node:
// qui si fissa il contratto del codice, il runtime browser resta da smoke.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'components', f), 'utf8');
const readLib = (f) => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'lib', f), 'utf8');

test('Settings -> Nodi: inventario prima del pairing; il vecchio form add-node e\' sparito', () => {
  const s = read('SettingsPanel.jsx');
  assert.match(s, /<PairingCard token=\{token\}/);
  const cardAt = s.indexOf('<PairingCard');
  const listAt = s.indexOf("t('peer-inventory-title')");
  assert.ok(cardAt > 0 && listAt > 0 && listAt < cardAt, 'inventario viene PRIMA della PairingCard');
  assert.doesNotMatch(s, /onAdd|nc-pair-scan|applyPairing/, 'form legacy e scan-input nascosto rimossi');
  // invite creator: istruzioni esplicite post-generazione + semantica del target SSH
  assert.match(s, /invite-next-steps/);
});

test('PairingCard: incolla (evento+bottone clipboard), QR, Enter, guard singolo submit, avanzate chiuse', () => {
  const c = read('PairingCard.jsx');
  assert.match(c, /navigator\.clipboard\.readText/, 'bottone Incolla via clipboard API');
  assert.match(c, /onPaste=\{/, 'paste deliberato nel campo auto-connette');
  assert.match(c, /pair-paste-ph/, 'placeholder "incolla qui il link"');
  assert.match(c, /createSubmitGuard\(\)/, 'guard anti doppio submit');
  assert.match(c, /resolvePairingInput/, 'anche Enter/bottone applicano i dati incorporati prima del submit');
  assert.match(c, /const \[advanced, setAdvanced\] = useState\(false\)/, 'campi avanzati CHIUSI di default');
  assert.match(c, /pair-missing-ssh/, 'link v1/incompleto: spiegazione precisa del campo mancante');
  assert.match(c, /describePairError/, 'errori dal contratto a stadi, non messaggi generici');
  assert.match(c, /pair-stage-\$\{fail\.stage\}/, 'stage localizzato mostrato');
  assert.match(c, /fail\.hint/, 'hint del server mostrato');
  assert.match(c, /fail\.retryable &&/, 'retry mostrato solo quando lo stage e\' realmente riprovabile');
  assert.match(c, /pair-retry/, 'retry esplicito con dati conservati');
  assert.match(c, /onKeyDown=.*Enter/, 'input manuale: Enter collega');
});

test('QrScanModal: scanner LIVE con cleanup e diagnosi; il risultato non viene mai navigato', () => {
  const q = read('QrScanModal.jsx');
  assert.match(q, /new QrScanner\(/, 'scanner live su <video>, non solo scanImage');
  assert.match(q, /preferredCamera: 'environment'/);
  assert.match(q, /Math\.min\(width, height\) \* 0\.92/, 'regione ampia: non taglia un QR che riempie il preview');
  assert.match(q, /playsInline/, 'video inline (iOS)');
  assert.match(q, /s\.stop\(\)/, 'cleanup stop');
  assert.match(q, /s\.destroy\(\)/, 'cleanup destroy');
  assert.match(q, /stream\.getTracks\(\)/, 'cleanup immediato dei MediaStreamTrack');
  assert.match(q, /const videoElement = videoRef\.current/, 'cleanup conserva il video anche dopo l\'azzeramento della ref React');
  assert.match(q, /NotAllowedError/, 'diagnosi permesso negato');
  assert.match(q, /qr-no-camera/, 'diagnosi nessuna camera');
  assert.match(q, /qr-unsupported/, 'diagnosi API non supportate');
  assert.match(q, /QrScanner\.scanImage\(f, \{ returnDetailedScanResult: true \}\)/, 'fallback foto normalizzato');
  assert.match(q, /normalizeScanResult/, 'string e {data} normalizzati');
  assert.doesNotMatch(q, /location\.href|window\.open|navigate/, 'mai navigare l\'URL scansionato');
});

test('Wizard e deep-link #pair: stesso ricevitore condiviso, consumo solo su successo/annulla', () => {
  const w = read('Wizard.jsx');
  assert.match(w, /<PairingCard token=\{token\} initial=\{initialPair/, 'wizard usa la card condivisa');
  assert.match(w, /autoStart=\{!!initialPair\}/, 'deep-link completo parte da solo');
  assert.match(w, /onBusyChange=\{setBusy\}/, 'durante il pairing il wizard non puo\' annullare lasciando la richiesta in corsa');
  assert.doesNotMatch(w, /pairNode/, 'nessun secondo flusso di pairing nel wizard');
  assert.match(w, /onSuccess=\{async \(\) => \{ if \(onPairDone\) onPairDone\(\);/, 'invite consumato SOLO a successo');
  assert.match(w, /onClick=\{\(\) => \{ if \(onPairDone\) onPairDone\(\); setStep\('welcome'\); \}\}/, 'o su annulla esplicito');
  const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /pairPending\) setWizardOpen\(true\)/, 'deep-link su installazione configurata apre il flusso di pairing');
});

test('pairing-flow: jsonFetch espone e.data e la card non inghiotte gli errori generici', () => {
  const api = readLib('api.js');
  assert.match(api, /e\.data = j/, 'jsonFetch attacca il payload strutturato');
  const flow = readLib('pairing-flow.js');
  assert.match(flow, /typeof d\.retryable === 'boolean'/);
  assert.match(flow, /String\(\(e && e\.message\) \|\| e\)/, 'fallback al message quando manca e.data');
});
