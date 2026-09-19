'use strict';
// tests/fleet-cell-capabilities.test.js — la superficie operativa di una cella,
// dichiarata per nome (F1a: schema, parse, vista).
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

// --- vista definitions() ---

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
  assert.deepEqual(cella.capabilities, { declared: { mcp: ['nexuscrew'], skills: ['fleet'], ondemand: ['playwright'] } });
  assert.equal(cella.capabilityProfile, 'ricerca');
});

// --- non-regressione argv: la cella legacy e identica a prima ---

test('argv di una cella legacy: nessuna flag nuova, il filtro mcp di oggi resta', (t) => {
  const w = mondoArgv(t);
  const ENGINE = { id: 'e1', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } };
  const out = resolveManagedEngine(ENGINE, { id: 'Dev', cwd: w.cwd, mcp: ['nexuscrew'] }, { home: w.home, platform: 'linux', env: {} });
  assert.equal(out.ok, true, out.reason);
  const args = out.engine.args;
  assert.equal(args.includes('--strict-mcp-config'), false, 'F1a non tocca il builder: legacy senza flag nuove');
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
