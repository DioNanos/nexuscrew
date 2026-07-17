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

test('mobile Fleet keeps its header fixed and scrolls only the roster', () => {
  const mobile = read('SessionList.jsx');
  const css = read('SessionList.css');
  assert.match(mobile, /<header className="nc-home-head">[\s\S]*?<\/header>\s*<main className="nc-home-scroll">/);
  assert.match(css, /\.nc-home\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.nc-home-scroll\s*\{[^}]*overflow-y:\s*auto[^}]*-webkit-overflow-scrolling:\s*touch/s);
  assert.match(css, /\.nc-home-scroll\s*\{[^}]*padding:[^;}]*76px/s);
});

test('mobile Fleet footer aligns metadata and language controls without overlap', () => {
  const mobile = read('SessionList.jsx');
  const css = read('SessionList.css');
  assert.match(mobile, /<span className="nc-home-meta">[\s\S]*?nc-home-version[\s\S]*?nc-home-endpoint/);
  assert.match(mobile, /<span className="nc-lang"[\s\S]*?LANGUAGES\.map/);
  assert.match(css, /\.nc-home-foot\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(css, /\.nc-home-endpoint\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.nc-lang\s*\{[^}]*white-space:\s*nowrap/s);
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
  // FleetInventory now lives in components/fleet/FleetInventory.jsx.
  const inventory = read('fleet/FleetInventory.jsx');
  assert.match(inventory, /can\(pos, 'import'\) && onImport/);
  assert.match(inventory, /can\(pos, 'remove'\)[\s\S]*?cellRemove/);
  assert.doesNotMatch(inventory, /can\(pos, 'edit'\)[\s\S]{0,160}cellRemove/);
  assert.match(inventory, /!readonly && !pos\.readonly/);
});

// Le card gestite espongono SOLO il power condiviso: engine/model/policy vivono
// nel PowerSheet di start/stop, non in un gear per-cella che riapre le Impostazioni
// globali. Delete/terminate restano nelle Impostazioni; le sessioni unmanaged
// mantengono il menu ⋯.
test('managed cards expose only power, never a per-cell settings icon or ⋯ menu', () => {
  const mobile = read('SessionList.jsx');
  const sidebar = read('Sidebar.jsx');
  const roster = mobile.split('function renderRosterItem')[1] || '';
  const cellBlock = roster.split('const s = item.value')[0] || '';
  const unmanagedBlock = roster.split('const s = item.value')[1] || '';
  assert.match(cellBlock, /item\.type === 'cell'[\s\S]*?setPowerCell\(/);
  assert.doesNotMatch(mobile, /onSettings\('fleet', false/);
  assert.doesNotMatch(sidebar, /onSettings && onSettings\('fleet', false/);
  assert.match(sidebar, /onPower && onPower\(c\)/);
  // il glifo ⋯ (nc-menu) appare nel ramo unmanaged, non nel ramo cella.
  assert.match(unmanagedBlock, /⋯/);
  assert.doesNotMatch(cellBlock, /⋯/, 'la card di una cella gestita non ha il menu ⋯');
});

// Flusso "Importa come cella": le sessioni unmanaged nella inventory (Settings)
// hanno un'azione import che chiama fleetImportCell; l'engine è obbligatorio.
test('Fleet inventory exposes an explicit "Import as cell" flow for unmanaged sessions', () => {
  const fleet = read('FleetTab.jsx');
  assert.match(fleet, /fleetImportCell/);
  assert.match(fleet, /import-as-cell/);
  assert.match(fleet, /ImportEditor/);
  // l'import richiede engine dichiarato (niente invenzione) — il gate vive
  // nell'editor, ora in components/fleet/ImportEditor.jsx
  const importer = read('fleet/ImportEditor.jsx');
  assert.match(importer, /disabled=\{busy \|\| !f\.tmuxSession \|\| !f\.engine \|\| !engines\.length\}/);
  // Le definitions vanno lette dalla route della sessione, non dalla posizione
  // che era selezionata quando l'utente ha cliccato Importa.
  assert.match(importer, /fleetDefinitions\(token, routeKey \? routeKey\.split\('\/'\) : \[\]\)/);
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

test('Fleet settings separates location management from the all-node overview', () => {
  const fleet = read('FleetTab.jsx');
  assert.match(fleet, /fleetView === 'manage'/);
  assert.match(fleet, /fleetView === 'overview'/);
  assert.match(fleet, /fleet-manage-location/);
  assert.match(fleet, /fleet-network-overview/);
  const manage = fleet.indexOf("t('fleet-cells')");
  const engines = fleet.indexOf("t('fleet-engines')", manage);
  assert.ok(manage > -1 && engines > manage, 'cells and +add must precede engines in Manage location');
});

test('Fleet backup is a global engine + cell action, not a cells-only action', () => {
  const fleet = read('FleetTab.jsx');
  const globalBackup = fleet.indexOf('nc-fleet-backup-actions');
  const cells = fleet.indexOf("t('fleet-cells')", globalBackup);
  const engines = fleet.indexOf("t('fleet-engines')", cells);
  assert.ok(globalBackup > -1 && cells > globalBackup && engines > cells,
    'backup action must appear before both managed lists');
  // The shared backup dialog was extracted to components/fleet/FleetBackupDialog.jsx
  // but must still expose both engine and cell selection.
  const dialog = read('fleet/FleetBackupDialog.jsx');
  assert.ok(dialog.indexOf('function FleetBackupDialog') > -1, 'shared backup dialog must remain available');
  assert.match(dialog, /selectedEnginesOut/);
  assert.match(dialog, /selectedCellsOut/);
});

test('standalone hub invitations require one explicit reachable SSH endpoint', () => {
  const settings = read('SettingsPanel.jsx');
  assert.match(settings, /const name = toSlug\(inviteForm\.name \|\| devName \|\| deviceDefault/);
  assert.match(settings, /validateNodeForm\(\{ name, ssh: inviteForm\.ssh, sshPort: inviteForm\.sshPort \}\)/);
  assert.match(settings, /disabled=\{readonly \|\| !!busy \|\| \(!inviteHub && !inviteForm\.ssh\.trim\(\)\)\}/);
  assert.match(settings, /ssh: checked\.value\.ssh/);
  assert.doesNotMatch(settings, /settings\?\.rendezvous/, 'legacy rendezvous state cannot invent a connection route');
  assert.doesNotMatch(settings, /publishedPort[^\n]*sshPort|sshPort[^\n]*publishedPort/);
});

test('a connected client delegates new invitations to its outbound hub', () => {
  const settings = read('SettingsPanel.jsx');
  const api = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'lib', 'api.js'), 'utf8');
  assert.match(settings, /direction === 'outbound'/);
  assert.match(settings, /createPeerInvite\(token,[\s\S]*?\[inviteHub\.name\]\)/);
  assert.match(settings, /invite-network-route/);
  assert.match(api, /routeBase\(route\).*settings\/peering\/invite/s);
  assert.doesNotMatch(settings, /createPeerInvite\(token,[\s\S]{0,260}label:[\s\S]{0,260}\[inviteHub\.name\]/,
    'delegated invite must identify the hub, never the current client');
});

test('Share publishes the local device through the selected hub, not the remote target card', () => {
  const settings = read('SettingsPanel.jsx');
  assert.match(settings, /share-local-through/);
  assert.match(settings, /setNodeShare\(token, shareHub\.name, shared\)/);
  assert.match(settings, /shareHub\.label \|\| shareHub\.name/);
  assert.match(settings, /applyShare\(shareHub\.shared === true\)/,
    'un tunnel down deve offrire la riconciliazione dello stato corrente senza invertire Share');
  assert.match(settings, /share-local-pending/);
  assert.match(settings, /share-local-private-down/);
  assert.match(settings, /e\?\.data && typeof e\.data\.hint === 'string'/,
    'la remediation strutturata della PATCH Share deve essere visibile nella UI');
  assert.doesNotMatch(settings, /!shareTunnel\?\.up && !shareHub\.shared/,
    'il checkbox Share non deve restare bloccato quando il tunnel e giu');
  const nodeCards = settings.slice(settings.indexOf('peerGroups.map'));
  assert.doesNotMatch(nodeCards, /setNodeShare\(token, n\.name/);
  assert.match(nodeCards, /actions\.visibility && n\.shared/);
  assert.match(nodeCards, /setNodeVisibility\(token, n\.name/,
    'the hub keeps visibility ACL controls for shared inbound clients');
});
