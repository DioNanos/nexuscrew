'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'components', name), 'utf8');

test('primary + creates a managed Fleet cell on mobile and desktop', () => {
  const app = read('../App.jsx');
  const mobile = read('SessionList.jsx');
  assert.match(app, /onNew=\{\(\) => openSettings\('fleet', true\)\}/);
  assert.match(mobile, /onClick=\{\(\) => onSettings\('fleet', true\)\}/);
  assert.doesNotMatch(app, /<NewSessionDialog/);
  assert.doesNotMatch(mobile, /<NewSessionDialog/);
});

// Launch editor CONDIVISO: "Avvia" dalla lista celle e dalla card inventory apre
// lo STESSO PowerSheet (non fleetUp diretto). fleetUp resta, ma nel confirm.
test('managed Fleet start opens the shared launch PowerSheet (no direct fleetUp on start)', () => {
  const fleet = read('FleetTab.jsx');
  assert.match(fleet, /onPower\(/);
  // il bottone Start della lista celle principali chiama onPower, non fleetUp diretto
  assert.match(fleet, /!isOn && caps\.includes\('up'\)[\s\S]*?onPower\(/);
  // fleetUp sopravvive (nel confirm del PowerSheet) e inoltra engine/model/policy
  assert.match(fleet, /fleetUp\(token, \{[\s\S]*cell: id[\s\S]*permissionPolicy/);
});

// PowerSheet è ora il launch editor: per cella OFF manda engine+modello+policy+boot
// ("Salva e avvia"); per cella ON spegni + rimuovi boot. Policy PER-CELL: mai si
// tocca engine.managed.permissionPolicy dallo sheet.
test('PowerSheet is the shared launch editor (engine/model/policy for OFF, stop for ON)', () => {
  const power = read('PowerSheet.jsx');
  assert.match(power, /action: 'up'/);
  assert.match(power, /engine/);
  assert.match(power, /permissionPolicy/);
  assert.match(power, /boot/);
  assert.match(power, /save-and-start/);
  assert.match(power, /action: 'down'/);
  // launch sheet sopra il pannello Impostazioni (z-index overlay)
  assert.match(power, /nc-launch-overlay/);
  // nessun radio button; engine è un <select>, non una fila di chip
  assert.doesNotMatch(power, /type="radio"/);
  // mai mutare il default globale dell'engine dallo sheet
  assert.doesNotMatch(power, /managed\.permissionPolicy\s*=/);
  assert.match(power, /fleetDefinitions\(token, routeKey \? routeKey\.split\('\/'\) : \[\]\)/,
    'la route locale deve essere [] e non [""]');
  // Se la card arriva dalle definitions (senza effective policy), non deve
  // inizializzare artificialmente "standard" e sovrascrivere il default Claude.
  assert.match(power, /const \[policy, setPolicy\] = useState\(initialPolicy\)/);
  assert.doesNotMatch(power, /useState\(cell\?\.permissionPolicy \|\| 'standard'\)/);
});

test('Fleet settings preserves the clicked Hydra route for power actions', () => {
  const fleet = read('FleetTab.jsx');
  assert.match(fleet, /Array\.isArray\(c\?\.route\) \? c\.route : route/);
  assert.match(fleet, /const actionRoute = Array\.isArray\(powerCell\.route\)/);
  assert.match(fleet, /fleetUp\(token,[\s\S]*?actionRoute\)/);
  assert.match(fleet, /fleetDown\(token,[\s\S]*?actionRoute\)/);
  assert.match(fleet, /<PowerSheet[\s\S]*?Array\.isArray\(powerCell\.route\)/);
});

test('Fleet inventory negotiates dedicated import/remove capabilities', () => {
  const fleet = read('FleetTab.jsx');
  assert.match(fleet, /can\(pos, 'import'\) && onImport/);
  assert.match(fleet, /can\(pos, 'remove'\)[\s\S]*?cellRemove/);
  assert.doesNotMatch(fleet, /can\(pos, 'edit'\)[\s\S]{0,160}cellRemove/);
  assert.match(fleet, /!readonly && !pos\.readonly/);
});

// Le card gestite espongono SOLO il power condiviso: engine/model/policy vivono
// nel PowerSheet di start/stop, non in un gear per-cella che riapre le Impostazioni
// globali. Delete/terminate restano nelle Impostazioni; le sessioni unmanaged
// mantengono il menu ⋯.
test('managed cards expose only power, never a per-cell settings icon or ⋯ menu', () => {
  const mobile = read('SessionList.jsx');
  const sidebar = read('Sidebar.jsx');
  assert.match(mobile, /sortedCells\.map\([\s\S]*?setPowerCell\(c\)/);
  assert.doesNotMatch(mobile, /onSettings\('fleet', false/);
  assert.doesNotMatch(sidebar, /onSettings && onSettings\('fleet', false/);
  assert.match(sidebar, /onPower && onPower\(c\)/);
  // il glifo ⋯ (nc-menu) appare nella mappa di `others` (unmanaged), non nelle celle
  const othersBlock = mobile.split('others.map')[1] || '';
  assert.match(othersBlock, /⋯/);
  const fleetBlock = mobile.split('sortedCells.map')[1].split('others.map')[0];
  assert.doesNotMatch(fleetBlock, /⋯/, 'la card di una cella gestita non ha il menu ⋯');
});

// Flusso "Importa come cella": le sessioni unmanaged nella inventory (Settings)
// hanno un'azione import che chiama fleetImportCell; l'engine è obbligatorio.
test('Fleet inventory exposes an explicit "Import as cell" flow for unmanaged sessions', () => {
  const fleet = read('FleetTab.jsx');
  assert.match(fleet, /fleetImportCell/);
  assert.match(fleet, /import-as-cell/);
  assert.match(fleet, /ImportEditor/);
  // l'import richiede engine dichiarato (niente invenzione)
  assert.match(fleet, /disabled=\{busy \|\| !f\.tmuxSession \|\| !f\.engine \|\| !engines\.length\}/);
  // Le definitions vanno lette dalla route della sessione, non dalla posizione
  // che era selezionata quando l'utente ha cliccato Importa.
  assert.match(fleet, /fleetDefinitions\(token, routeKey \? routeKey\.split\('\/'\) : \[\]\)/);
});

test('Fleet settings inventory keeps every node visible and routes remote settings', () => {
  const settings = read('SettingsPanel.jsx');
  const fleet = read('FleetTab.jsx');
  const mobile = read('SessionList.jsx');
  assert.match(settings, /targets=\{roster\.map\(/);
  assert.doesNotMatch(settings, /roster\.filter\(\(g\) => g\.status === 'up'\)/);
  assert.match(fleet, /disabled=\{x\.status && x\.status !== 'up'\}/);
  assert.doesNotMatch(mobile, /onSettings\('fleet', false/);
});

test('PWA-created pairing links reuse the rendezvous endpoint and keep SSH advanced', () => {
  const settings = read('SettingsPanel.jsx');
  assert.match(settings, /const name = toSlug\(inviteForm\.name \|\| devName \|\| deviceDefault/);
  assert.match(settings, /const automaticSsh = settings\?\.rendezvous\?\.ssh \|\| ''/);
  assert.match(settings, /validateNodeForm\(\{ name, ssh: inviteForm\.ssh \|\| automaticSsh, sshPort: inviteForm\.sshPort \}\)/);
  assert.match(settings, /disabled=\{readonly \|\| !!busy \|\| \(!configuredEndpoint && !inviteForm\.ssh\.trim\(\)\)\}/);
  assert.match(settings, /inviteForm\.ssh\.trim\(\) \? \{ ssh: checked\.value\.ssh \} : \{\}/);
  assert.doesNotMatch(settings, /publishedPort[^\n]*sshPort|sshPort[^\n]*publishedPort/);
});
