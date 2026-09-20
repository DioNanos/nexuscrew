'use strict';
// tests/fleet-cell-capabilities.test.js — la superficie operativa di una cella,
// dichiarata per nome: schema, parse, vista.
//
// Due regole che i test fissano prima del codice:
//   LEGACY. Una cella senza `capabilities` e senza `capabilityProfile` e' la
//   cella di sempre: stesso argv, stessa vista, nessun campo nuovo se non
//   `legacy: true` a dirlo. La non-regressione si prova sugli argv, non sulla
//   fiducia.
//   SOSTITUZIONE. L'override della cella sostituisce il profilo PER CHIAVE
//   (`mcp`, `skills`, `ondemand`): unire non saprebbe togliere.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDefinitions, effectiveCapabilities } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { resolveManagedEngine } = require('../lib/fleet/managed.js');

const PROFILO_ENGINE = { id: 'e1', label: 'E1', command: '/bin/true', args: [], env: {}, promptMode: 'flag', promptFlag: '--sp' };

function documento({ profili, celle } = {}) {
  return {
    schemaVersion: 1,
    engines: [PROFILO_ENGINE],
    ...(profili !== undefined ? { capabilityProfiles: profili } : {}),
    cells: celle !== undefined ? celle : [{ id: 'Dev', cwd: '/tmp', engine: 'e1' }],
  };
}

const PROFILO_OK = { mcp: ['nexuscrew', 'webfetch'], skills: ['fleet'], ondemand: ['playwright'] };

// --- parse: profili di capability (top-level) ---

test('capabilityProfiles valido entra nel documento parsato', () => {
  const d = parseDefinitions(documento({ profili: { ricerca: PROFILO_OK } }));
  assert.ok(d, 'documento valido rifiutato');
  assert.deepEqual(d.capabilityProfiles.ricerca, PROFILO_OK);
});

test('un documento senza capabilityProfiles resta esattamente com era', () => {
  const d = parseDefinitions(documento());
  assert.ok(d);
  assert.equal('capabilityProfiles' in d, false, 'chiave assente, non vuota: il file non si riscrive');
});

test('capabilityProfiles non-oggetto, profilo con nome invalido o chiave sconosciuta -> rifiuto', () => {
  assert.equal(parseDefinitions(documento({ profili: [] })), null);
  assert.equal(parseDefinitions(documento({ profili: { 'nome/sbagliato': PROFILO_OK } })), null);
  assert.equal(parseDefinitions(documento({ profili: { ok: { tools: ['x'] } } })), null, 'chiave non ammessa');
  assert.equal(parseDefinitions(documento({ profili: { ok: { mcp: 'nexuscrew' } } })), null, 'i nomi viaggiano in array, non in stringa');
});

test('piu di 32 profili -> rifiuto che nomina il limite', () => {
  const profili = {};
  for (let i = 0; i < 33; i += 1) profili[`p${i}`] = { mcp: ['a'] };
  const viste = [];
  const d = parseDefinitions(documento({ profili }), { onIssue: (x) => viste.push(x) });
  assert.equal(d, null);
  assert.ok(viste.some((x) => /32/.test(x.rule)), 'il rifiuto nomina il cap');
});

// --- parse: cell.capabilities e cell.capabilityProfile ---

test('la cella puo riferire un profilo esistente; uno inesistente rifiuta la cella', () => {
  const ok = parseDefinitions(documento({ profili: { ricerca: PROFILO_OK }, celle: [{ id: 'Dev', cwd: '/tmp', engine: 'e1', capabilityProfile: 'ricerca' }] }));
  assert.ok(ok);
  assert.equal(ok.cells[0].capabilityProfile, 'ricerca');
  assert.equal(parseDefinitions(documento({ profili: { ricerca: PROFILO_OK }, celle: [{ id: 'Dev', cwd: '/tmp', engine: 'e1', capabilityProfile: 'inesistente' }] })), null);
  assert.equal(parseDefinitions(documento({ celle: [{ id: 'Dev', cwd: '/tmp', engine: 'e1', capabilityProfile: 'ricerca' }] })), null, 'nessun profilo dichiarato nel documento');
});

test('cell.capabilities valido entra nella cella; forme sbagliate rifiutano', () => {
  const base = { id: 'Dev', cwd: '/tmp', engine: 'e1' };
  const ok = parseDefinitions(documento({ celle: [{ ...base, capabilities: { mcp: ['nexuscrew'] } }] }));
  assert.ok(ok);
  assert.deepEqual(ok.cells[0].capabilities, { mcp: ['nexuscrew'] });
  assert.equal(parseDefinitions(documento({ celle: [{ ...base, capabilities: [] }] })), null, 'array non e un set');
  assert.equal(parseDefinitions(documento({ celle: [{ ...base, capabilities: { tool: ['x'] } }] })), null, 'chiave non ammessa');
  assert.equal(parseDefinitions(documento({ celle: [{ ...base, capabilities: { mcp: ['nome/sbagliato'] } }] })), null);
  assert.equal(parseDefinitions(documento({ celle: [{ ...base, capabilities: { mcp: ['a', 'a'] } }] })), null, 'duplicati rifiutati');
  assert.equal(parseDefinitions(documento({ celle: [{ ...base, capabilities: { skills: ['Skill Maiuscola'] } }] })), null);
});

test('cap 64 nomi per chiave: oltre -> rifiuto che nomina il limite', () => {
  const base = { id: 'Dev', cwd: '/tmp', engine: 'e1' };
  const nomi = Array.from({ length: 65 }, (_, i) => `s${i}`);
  const viste = [];
  const d = parseDefinitions(documento({ celle: [{ ...base, capabilities: { mcp: nomi } }] }), { onIssue: (x) => viste.push(x) });
  assert.equal(d, null);
  assert.ok(viste.some((x) => /64/.test(x.rule)));
});

// --- effectiveCapabilities: legacy, profilo, override sostitutivo ---

test('cella senza capabilities e senza profilo = legacy', () => {
  const d = parseDefinitions(documento());
  assert.deepEqual(effectiveCapabilities(d.cells[0], d), { legacy: true, declared: {} });
});

test('il profilo alimenta le chiavi che la cella non copre; l override sostituisce per chiave', () => {
  const d = parseDefinitions(documento({
    profili: { ricerca: PROFILO_OK },
    celle: [{ id: 'Dev', cwd: '/tmp', engine: 'e1', capabilityProfile: 'ricerca', capabilities: { mcp: ['nexuscrew'] } }],
  }));
  assert.deepEqual(effectiveCapabilities(d.cells[0], d), {
    legacy: false,
    declared: { mcp: ['nexuscrew'], skills: ['fleet'], ondemand: ['playwright'] },
  }, 'mcp sostituito dalla cella, skills/ondemand ereditate dal profilo');
});

test('chiave mcp assente in una cella dichiarata: l alias cell.mcp fa da filtro come sempre', (t) => {
  const w = mondoClaude(t);
  // La cella dichiara solo skills, ma la chiave mcp le viene dall'ALIAS
  // legacy `cell.mcp`: chiave assente nel set = comportamento di sempre per
  // quella chiave — argv identici a una cella legacy con lo stesso alias.
  const dichiarata = resolveClaude(w, { mcp: ['nexuscrew'], capabilities: { skills: ['fleet'] } }, {});
  const legacy = resolveClaude(w, { mcp: ['nexuscrew'] }, {});
  assert.equal(dichiarata.ok, true, dichiarata.reason);
  assert.equal(legacy.ok, true, legacy.reason);
  assert.deepEqual(dichiarata.engine.args, legacy.engine.args, 'argv identici alla legacy: stesso deny, nessuna flag nuova');
});

// --- fail-closed: se il file per cella non si scrive, il launch NON parte ---

test('dir cell-mcp non scrivibile: il launch rifiuta (fail-closed), mai parte senza la allowlist', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cellcap-ro-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'Dev');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { nexuscrew: { command: 'nexuscrew' } } }), { mode: 0o600 });
  // La directory esiste ma e' resa non scrivibile: il writer strettisce i
  // permessi, non li allarga — la scrittura deve fallire e il launch fermarsi.
  const cellMcpDir = path.join(home, '.nexuscrew', 'cell-mcp');
  fs.mkdirSync(cellMcpDir, { recursive: true });
  fs.chmodSync(cellMcpDir, 0o500);
  t.after(() => { fs.chmodSync(cellMcpDir, 0o700); fs.rmSync(root, { recursive: true, force: true }); });
  const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
  const { loadDefinitions } = require('../lib/fleet/definitions.js');
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [ENGINE_CLAUDE],
    cells: [{ id: 'Ric', tmuxSession: 'work-m', cwd, engine: 'ec', capabilities: { mcp: ['nexuscrew'] } }],
  }));
  const launchBroker = { issue: async () => { throw new Error('nessun processo deve arrivare al broker'); }, close: async () => {} };
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 40 }, home, defsPath, tmuxBin: '/bin/true',
    readonly: () => false, launchBroker, boot: loadDefinitions(defsPath),
  });
  await assert.rejects(() => runtime.up('Ric'), (e) => e.status === 500
    && e.fleetCode === 'MCP_CELL_FILE_UNWRITABLE'
    && /file MCP per cella non scrivibile/.test(e.message),
  'up deve rifiutare con il messaggio chiaro: niente cella con la superficie sbagliata');
});

test('nella vista una cella legacy dichiara legacy: true e non espone capabilities', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cellcap-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'Dev');
  fs.mkdirSync(cwd);
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [PROFILO_ENGINE],
    cells: [{ id: 'Dev', tmuxSession: 'work-x', cwd, engine: 'e1' }],
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fleet = await createBuiltinFleet({ home, fleetDefsPath: defsPath, tmuxBin: '/bin/true' });
  const vista = await fleet.definitions();
  const cella = vista.cells.find((c) => c.id === 'Dev');
  assert.equal(cella.legacy, true);
  assert.equal('capabilities' in cella, false);
});

test('una cella con profilo espone capabilities.declared fuso e legacy: false', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cellcap-cwd-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cellcap-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [PROFILO_ENGINE],
    capabilityProfiles: { ricerca: PROFILO_OK },
    cells: [{ id: 'Ric', tmuxSession: 'work-y', cwd, engine: 'e1', capabilityProfile: 'ricerca', capabilities: { mcp: ['nexuscrew'] } }],
  }));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });
  const fleet = await createBuiltinFleet({ home, fleetDefsPath: defsPath, tmuxBin: '/bin/true' });
  const vista = await fleet.definitions();
  const cella = vista.cells.find((c) => c.id === 'Ric');
  assert.equal(cella.legacy, false);
  // engine custom: nessun materializzatore MCP in questa fase, quindi la chiave
  // dichiarata esce anche come unsupported (con motivo), accanto alla fusione.
  assert.deepEqual(cella.capabilities.declared, { mcp: ['nexuscrew'], skills: ['fleet'], ondemand: ['playwright'] });
  assert.deepEqual((cella.capabilities.unsupported || []).map((u) => u.key), ['mcp', 'skills', 'ondemand']);
  assert.equal(cella.capabilityProfile, 'ricerca');
});

// --- non-regressione argv: la cella legacy e identica a prima ---

test('argv di una cella legacy: nessuna flag nuova, il filtro mcp di oggi resta', (t) => {
  const w = mondoArgv(t);
  const ENGINE = { id: 'e1', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } };
  const out = resolveManagedEngine(ENGINE, { id: 'Dev', cwd: w.cwd, mcp: ['nexuscrew'] }, { home: w.home, platform: 'linux', env: {} });
  assert.equal(out.ok, true, out.reason);
  const args = out.engine.args;
  assert.equal(args.includes('--strict-mcp-config'), false, 'nessuna flag nuova per la legacy: il builder resta quello di oggi');
  assert.equal(args.some((a) => a.startsWith('--mcp-config=')), false);
  const settings = args.find((a) => a.startsWith('--settings='));
  assert.ok(settings, 'il filtro mcp odierno resta per la legacy');
  assert.deepEqual(JSON.parse(settings.slice('--settings='.length)).permissions.deny, ['mcp__webfetch']);
});

function mondoArgv(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cellcap-argv-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { nexuscrew: { command: 'nexuscrew' }, webfetch: { command: 'webfetch' } } }), { mode: 0o600 });
  const cwd = path.join(home, 'lavoro');
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, cwd };
}

// --- schema ---

test('lo schema dichiara capabilities/capabilityProfile della cella e capabilityProfiles del documento', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cellcap-schema-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({ schemaVersion: 1, engines: [PROFILO_ENGINE], cells: [] }));
  try {
    const fleet = await createBuiltinFleet({ home, fleetDefsPath: defsPath, tmuxBin: '/bin/true' });
    const s = fleet.schema();
    assert.ok(s.cell.capabilities, 'schema cell.capabilities');
    assert.ok(s.cell.capabilityProfile, 'schema cell.capabilityProfile');
    assert.ok(s.capabilityProfiles, 'schema documento capabilityProfiles');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- materializzatore claude (MCP): strict + file per cella ---

const ENGINE_CLAUDE = { id: 'ec', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } };

function mondoClaude(t, { utente = ['nexuscrew', 'webfetch', 'nextcloud'] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cellcap-mat-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const mcpServers = {};
  for (const nome of utente) mcpServers[nome] = { command: nome };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers }), { mode: 0o600 });
  const cwd = path.join(home, 'lavoro');
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, cwd };
}

function resolveClaude(w, cell, capabilityProfiles) {
  return resolveManagedEngine(ENGINE_CLAUDE, { id: 'Ric', cwd: w.cwd, ...cell }, {
    home: w.home, platform: 'linux', env: {}, ...(capabilityProfiles ? { capabilityProfiles } : {}),
  });
}

test('una cella non-legacy con mcp dichiarato riceve strict + file per cella, non il deny enumerato', (t) => {
  const w = mondoClaude(t);
  const out = resolveClaude(w, { capabilities: { mcp: ['nexuscrew', 'webfetch'] } }, {});
  assert.equal(out.ok, true, out.reason);
  const args = out.engine.args;
  assert.ok(args.includes('--strict-mcp-config'), 'strict richiesto per le celle dichiarate');
  const flag = args.find((a) => a.startsWith('--mcp-config='));
  assert.ok(flag, 'file per cella passato con la forma con l uguale');
  const file = flag.slice('--mcp-config='.length);
  assert.ok(file.startsWith(path.join(w.home, '.nexuscrew', 'cell-mcp')), 'il file vive nel namespace privato');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ['nexuscrew', 'webfetch'], 'solo i concessi, niente nextcloud');
  const st = fs.statSync(file);
  assert.equal(st.mode & 0o077, 0, 'file 0600-like: nessun bit per gruppo/altri');
  assert.equal(args.some((a) => a.startsWith('--settings=')), false, 'il deny enumerato non e piu emesso per le dichiarate');
});

test('mcp vuoto dichiarato: il file porta solo il core, che e sempre incluso', (t) => {
  const w = mondoClaude(t, { utente: ['nexuscrew'] });
  const out = resolveClaude(w, { capabilities: { mcp: [] } }, {});
  assert.equal(out.ok, true, out.reason);
  const flag = out.engine.args.find((a) => a.startsWith('--mcp-config='));
  assert.ok(flag, 'strict anche per la cella vuota: e il caso esatto della cella non fidata');
  const parsed = JSON.parse(fs.readFileSync(flag.slice('--mcp-config='.length), 'utf8'));
  assert.deepEqual(Object.keys(parsed.mcpServers), ['nexuscrew'], 'il core resta, il resto no');
});

test('una cella che dichiara solo skills non riceve nessuna flag MCP nuova', (t) => {
  const w = mondoClaude(t);
  const out = resolveClaude(w, { capabilities: { skills: ['fleet'] } }, {});
  assert.equal(out.ok, true, out.reason);
  const args = out.engine.args;
  assert.equal(args.includes('--strict-mcp-config'), false);
  assert.equal(args.some((a) => a.startsWith('--mcp-config=')), false, 'le skill sono escluse da questa fase');
  assert.equal(args.some((a) => a.startsWith('--settings=')), false, 'una cella dichiarata non riceve il deny enumerato');
  assert.equal(fs.existsSync(path.join(w.home, '.nexuscrew', 'cell-mcp')), false, 'nessun file scritto senza mcp dichiarato');
});

test('la vista segnala non materializzate le chiavi che questa fase non copre', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cellcap-unsup-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'Dev');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.webfetch]\ncommand = "webfetch"\n', { mode: 0o600 });
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [
      { id: 'e-claude', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } },
      { id: 'e-codex', managed: { client: 'codex', provider: 'native', model: '' } },
      PROFILO_ENGINE,
    ],
    cells: [
      { id: 'Cla', tmuxSession: 'work-c', cwd, engine: 'e-claude', capabilities: { mcp: ['nexuscrew'], skills: ['fleet'] } },
      { id: 'Cdx', tmuxSession: 'work-e', cwd, engine: 'e-codex', capabilities: { mcp: ['nexuscrew'], ondemand: ['webfetch', 'inesistente'] } },
      { id: 'Alt', tmuxSession: 'work-d', cwd, engine: 'e1', capabilityProfile: 'p' },
    ],
    capabilityProfiles: { p: { mcp: ['nexuscrew'] } },
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fleet = await createBuiltinFleet({ home, fleetDefsPath: defsPath, tmuxBin: '/bin/true' });
  const vista = await fleet.definitions();
  const cla = vista.cells.find((c) => c.id === 'Cla');
  // mcp dichiarato e materializzato per claude: non compare in unsupported;
  // skills e ondemand dichiarati? skills si, ondemand no -> solo skills.
  const chiaviCla = (cla.capabilities.unsupported || []).map((u) => u.key);
  assert.deepEqual(chiaviCla, ['skills'], 'per claude il materializzatore copre mcp; skills resta dichiarata non coperta');
  const cdx = vista.cells.find((c) => c.id === 'Cdx');
  // webfetch esiste nella config utente del mondo? No: il mondo di QUESTO test
  // non scrive .codex/config.toml, quindi entrambi i nomi ondemand sono ignoti
  // e la vista li segnala; mcp e coperta dal materializzatore.
  const vociCdx = cdx.capabilities.unsupported || [];
  assert.deepEqual(vociCdx.filter((u) => u.key === 'ondemand').map((u) => u.name), ['inesistente'],
    'la vista nomina i server ondemand ignorati perche non in config utente (webfetch c e, non e segnalato)');
  assert.equal(vociCdx.some((u) => u.key === 'mcp'), false, 'mcp coperta per codex');
  const alt = vista.cells.find((c) => c.id === 'Alt');
  const chiaviAlt = (alt.capabilities.unsupported || []).map((u) => u.key);
  assert.deepEqual(chiaviAlt, ['mcp'], 'engine senza materializzatore: la chiave dichiarata esce non supportata, mai errore');
});

// --- materializzatore codex: profilo per cella (-p), config utente intatta ---

const ENGINE_CODEX = { id: 'ex', managed: { client: 'codex', provider: 'native', model: '' } };
const TOML_UTENTE = [
  'model = "gpt-5"',
  '',
  '[mcp_servers.nexuscrew]',
  'command = "nexuscrew"',
  '',
  '[mcp_servers.webfetch]',
  'command = "webfetch"',
  '',
  '[mcp_servers.nextcloud]',
  'command = "nextcloud"',
  '',
  '[[skills.config]]',
  'name = "fleet"',
  'enabled = true',
  '',
  '[[skills.config]]',
  'name = "cellforge"',
  'enabled = true',
  '',
].join('\n');

function mondoCodex(t, { toml = TOML_UTENTE } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cellcap-cdx-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'codex');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), toml, { mode: 0o600 });
  const cwd = path.join(home, 'lavoro');
  fs.mkdirSync(cwd);
  t.after(() => {
    // I test possono aver reso .codex non scrivibile (fail-closed): ripristina
    // prima di rimuovere l'albero.
    try { fs.chmodSync(path.join(home, '.codex'), 0o700); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, cwd, configToml: path.join(home, '.codex', 'config.toml') };
}

function resolveCodex(w, cell) {
  return resolveManagedEngine(ENGINE_CODEX, { id: 'Ric', cwd: w.cwd, ...cell }, {
    home: w.home, platform: 'linux', env: {}, capabilityProfiles: {},
  });
}

test('codex dichiarato con mcp: -p con profilo per cella che spegne i soli non concessi; config utente intatta', (t) => {
  const w = mondoCodex(t);
  const out = resolveCodex(w, { capabilities: { mcp: ['nexuscrew', 'webfetch'] } });
  assert.equal(out.ok, true, out.reason);
  const args = out.engine.args;
  const pi = args.indexOf('-p');
  assert.notEqual(pi, -1, '-p richiesto per le celle dichiarate');
  assert.equal(args[pi + 1], 'nexuscrew-Ric', 'nome profilo derivato dalla cella');
  const profilo = fs.readFileSync(path.join(w.home, '.codex', 'nexuscrew-Ric.config.toml'), 'utf8');
  assert.match(profilo, /\[mcp_servers\.nextcloud\]/, 'il non concesso viene spento');
  assert.match(profilo, /enabled\s*=\s*false/);
  assert.doesNotMatch(profilo, /\[mcp_servers\.webfetch\]/, 'il concesso non si ridichiara: eredita dal layer base');
  assert.doesNotMatch(profilo, /\[mcp_servers\.nexuscrew\]/);
  assert.equal(fs.readFileSync(w.configToml, 'utf8'), TOML_UTENTE, 'la config utente non e mai toccata');
});

test('codex ondemand: omit_tools_from nella TABELLA del server, mai a root (chiave che codex ignora)', (t) => {
  const w = mondoCodex(t);
  // webfetch e CONCESSO e differito: l'ondemand presuppone la concessione.
  const out = resolveCodex(w, { capabilities: { mcp: ['nexuscrew', 'webfetch'], ondemand: ['webfetch'] } });
  assert.equal(out.ok, true, out.reason);
  const profilo = fs.readFileSync(path.join(w.home, '.codex', 'nexuscrew-Ric.config.toml'), 'utf8');
  // La forma giusta: tabella del server con la chiave di differimento, senza
  // enabled (concesso ma differito, non spento).
  assert.match(profilo, /\[mcp_servers\.webfetch\]\s*\nomit_tools_from = \["direct"\]/,
    'omit_tools_from va nella tabella del server');
  assert.doesNotMatch(profilo.slice(0, profilo.indexOf('\n[')), /omit_tools_from/,
    'a root codex la ignora in silenzio: non deve comparire prima di ogni tabella');
  // webfetch e ondemand, non spento: la tabella non porta enabled = false.
  const tabella = profilo.split('[mcp_servers.webfetch]')[1] || '';
  assert.equal(tabella.includes('enabled = false'), false, 'il server ondemand resta concesso');
  // nextcloud resta il non concesso: enabled = false, senza chiavi di differimento.
  const tabellaOff = (profilo.split('[mcp_servers.nextcloud]')[1] || '').split('\n[')[0];
  assert.match(tabellaOff, /enabled = false/);
  assert.equal(tabellaOff.includes('omit_tools_from'), false, 'uno spento non prende il differimento');
});

test('codex ondemand sovrapposto a mcp: nessuna tabella duplicata per lo stesso server', (t) => {
  const w = mondoCodex(t);
  // Nomi tutti noti: un nome sconosciuto ora rifiuta il lancio prima di
  // scrivere il profilo (vedi i test CAPABILITY_UNKNOWN_NAME qui sotto).
  const out = resolveCodex(w, { capabilities: { mcp: ['nexuscrew'], ondemand: ['nextcloud', 'webfetch'] } });
  assert.equal(out.ok, true, out.reason);
  const profilo = fs.readFileSync(path.join(w.home, '.codex', 'nexuscrew-Ric.config.toml'), 'utf8');
  assert.equal((profilo.match(/\[mcp_servers\.nextcloud\]/g) || []).length, 1,
    'TOML vieta le tabelle duplicate: enabled = false vince (volere piu restrittivo)');
  assert.doesNotMatch(profilo, /omit_tools_from/,
    'un server spento (enabled = false) non prende anche la tabella ondemand');
});

// --- il consumatore VERO decide: il profilo generato parte con codex-vl ---

test('il profilo generato e accettato dal client codex-vl vero (errore atteso: auth, non parse)', { skip: !fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'codex-vl')) && 'binario codex-vl non presente sul nodo' }, (t) => {
  const w = mondoCodex(t);
  const { writeCellCodexProfile } = require('../lib/fleet/managed.js');
  const codexHome = path.join(w.home, '.codex');
  // Il profilo nella forma finale: mcp con un differito, uno spento, skill.
  writeCellCodexProfile('T', { mcp: ['nexuscrew', 'webfetch'], ondemand: ['webfetch'], skills: ['fleet'] }, codexHome);
  // CODEX_HOME isolato: solo config minimale senza auth + il profilo generato.
  const isolato = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cellcap-cdxhome-'));
  fs.mkdirSync(path.join(isolato, '.codex'));
  fs.writeFileSync(path.join(isolato, '.codex', 'config.toml'), TOML_UTENTE, { mode: 0o600 });
  fs.copyFileSync(path.join(codexHome, 'nexuscrew-T.config.toml'), path.join(isolato, '.codex', 'nexuscrew-T.config.toml'));
  t.after(() => fs.rmSync(isolato, { recursive: true, force: true }));
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(path.join(os.homedir(), '.local', 'bin', 'codex-vl'),
    ['-p', 'nexuscrew-T', 'exec', '--skip-git-repo-check', 'x'],
    { env: { ...process.env, CODEX_HOME: isolato }, input: '', timeout: 60000, encoding: 'utf8' });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const parseError = /unknown field|invalid type|expected one of|unknown variant|failed to parse|error parsing/i.test(out);
  assert.equal(parseError, false, `il profilo e stato RIFIUTATO dal client vero:\n${out.slice(0, 800)}`);
  // Errore atteso e letterale su questo nodo: il profilo e accettato e il
  // client arriva fino all'auth (config minimale senza credenziali).
  const authError = /401|unauthorized|not logged in|no credentials|login required|missing bearer/i.test(out);
  assert.ok(authError, `atteso un errore di auth (profilo accettato), trovato:\n${out.slice(0, 800)}`);
});

test('codex con solo skills: il profilo spegne le non concesse, tocca i server a mcp assente', (t) => {
  const w = mondoCodex(t);
  const out = resolveCodex(w, { capabilities: { skills: ['fleet'] } });
  assert.equal(out.ok, true, out.reason);
  const pi = out.engine.args.indexOf('-p');
  assert.notEqual(pi, -1, 'il profilo serve anche per le skill');
  const profilo = fs.readFileSync(path.join(w.home, '.codex', 'nexuscrew-Ric.config.toml'), 'utf8');
  assert.match(profilo, /\[\[skills\.config\]\]\s*\nname = "cellforge"\s*\nenabled = false/, 'la skill non concessa e spenta');
  assert.doesNotMatch(profilo, /name = "fleet"/, 'la skill concessa non si tocca');
  assert.doesNotMatch(profilo, /\[mcp_servers\./, 'mcp assente: nessuna riduzione per quella chiave');
});

test('codex legacy: nessun -p e nessun profilo scritto', (t) => {
  const w = mondoCodex(t);
  const legacy = resolveCodex(w, {});
  const ref = resolveManagedEngine(ENGINE_CODEX, { id: 'Ric', cwd: w.cwd }, { home: w.home, platform: 'linux', env: {} });
  assert.equal(legacy.ok && ref.ok, true);
  assert.equal(legacy.engine.args.join(' ').includes(' -p '), false, 'nessuna flag nuova per la legacy');
  assert.equal(fs.existsSync(path.join(w.home, '.codex', 'nexuscrew-Ric.config.toml')), false);
});

test('codex: scrittura profilo impossibile -> rifiuto del launch (fail-closed)', (t) => {
  const w = mondoCodex(t);
  const codexHome = path.join(w.home, '.codex');
  fs.chmodSync(codexHome, 0o500);
  t.after(() => { try { fs.chmodSync(codexHome, 0o700); } catch (_) {} });
  const out = resolveCodex(w, { capabilities: { mcp: ['nexuscrew'] } });
  assert.equal(out.ok, false, 'il launch non parte con la superficie sbagliata');
  assert.match(out.mcpCellRefused || '', /profilo per cella non scrivibile/);
});

// --- Nomi dangling: una capability dichiarata che il client non definisce
// RIFIUTA il lancio (fail-closed) invece di sparire in silenzio dal file. ---

test('claude: capability mcp con nome sconosciuto rifiuta il launch con CAPABILITY_UNKNOWN_NAME, nessun file scritto', (t) => {
  const w = mondoClaude(t, { utente: ['nexuscrew'] });
  const out = resolveClaude(w, { capabilities: { mcp: ['nexuscrew', 'inesistente'] } }, {});
  assert.equal(out.ok, false, 'il lancio deve essere rifiutato');
  assert.equal(out.mcpCellRefusedCode, 'CAPABILITY_UNKNOWN_NAME');
  assert.match(out.reason, /inesistente/);
  assert.match(out.reason, /capability mcp/);
  assert.equal(
    fs.existsSync(path.join(w.home, '.nexuscrew', 'cell-mcp', 'Ric.json')),
    false,
    'nessun file per cella scritto a metà',
  );
});

test('codex: nome mcp non in config.toml rifiuta con CAPABILITY_UNKNOWN_NAME', (t) => {
  const w = mondoCodex(t);
  const out = resolveCodex(w, { capabilities: { mcp: ['nexuscrew', 'b'] } });
  assert.equal(out.ok, false);
  assert.equal(out.mcpCellRefusedCode, 'CAPABILITY_UNKNOWN_NAME');
  assert.match(out.reason, /\bb\b/);
});

test('codex: nome ondemand non in config.toml rifiuta con CAPABILITY_UNKNOWN_NAME', (t) => {
  const w = mondoCodex(t);
  const out = resolveCodex(w, { capabilities: { ondemand: ['c'] } });
  assert.equal(out.ok, false);
  assert.equal(out.mcpCellRefusedCode, 'CAPABILITY_UNKNOWN_NAME');
  assert.match(out.reason, /\bc\b/);
});

test('codex: skill non in config.toml rifiuta con CAPABILITY_UNKNOWN_NAME', (t) => {
  const w = mondoCodex(t);
  const out = resolveCodex(w, { capabilities: { skills: ['s2'] } });
  assert.equal(out.ok, false);
  assert.equal(out.mcpCellRefusedCode, 'CAPABILITY_UNKNOWN_NAME');
  assert.match(out.reason, /s2/);
});

test('codex: nomi tutti definiti -> profilo scritto (caso positivo)', (t) => {
  const w = mondoCodex(t);
  const out = resolveCodex(w, { capabilities: { mcp: ['nexuscrew'], skills: ['fleet'] } });
  assert.equal(out.ok, true, out.reason);
  const pos = out.engine.args.indexOf('-p');
  assert.ok(pos !== -1, 'profilo passato con -p');
});

test('codex: config.toml vuota (catalogo assente) con nomi dichiarati rifiuta; mcp vuoto resta valido', (t) => {
  const w = mondoCodex(t, { toml: '' });
  const out1 = resolveCodex(w, { capabilities: { mcp: ['nexuscrew'] } });
  assert.equal(out1.ok, false);
  assert.equal(out1.mcpCellRefusedCode, 'CAPABILITY_UNKNOWN_NAME');
  assert.match(out1.reason, /nexuscrew/);
  const out2 = resolveCodex(w, { capabilities: { mcp: [] } });
  assert.equal(out2.ok, true, 'mcp: [] senza nomi deve restare valido');
});
