'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const mod = () => import('../frontend/src/lib/fleet-backup.js');

test('fleet backup: export v3 portatile — cwdRel, nessun segreto, nessuna cwd assoluta', async () => {
  const { createFleetBackup, parseFleetBackup, FLEET_BACKUP_VERSION } = await mod();
  const backup = createFleetBackup([{
    id: 'Dev', cwd: '/home/other/device/dev', cwdRel: 'dev', engine: 'claude', boot: true, prompt: 'senior dev',
    model: 'fable', models: { claude: 'fable' }, permissionPolicies: { claude: 'unsafe' },
    token: 'NO', env: { API_KEY: 'NO' }, tmuxSession: 'cloud-Dev',
  }], new Set(['Dev']), new Date('2026-07-12T00:00:00Z'));
  const serialized = JSON.stringify(backup);
  assert.equal(backup.version, FLEET_BACKUP_VERSION);
  assert.equal(serialized.includes('NO'), false);
  assert.equal(serialized.includes('cloud-Dev'), false);
  assert.equal(serialized.includes('"cwd":'), false, 'nessuna cwd assoluta nel backup v3');
  assert.equal(backup.cells[0].cwdRel, 'dev');
  assert.equal(backup.cells[0].systemPrompt, 'senior dev');
  assert.equal(parseFleetBackup(serialized).ok, true);
});

test('fleet backup: schema chiuso e limite 32 celle', async () => {
  const { parseFleetBackup } = await mod();
  const base = { format: 'nexuscrew.cells', version: 1, cells: [{ id: 'Dev', cwd: '/tmp', engine: 'claude', systemPrompt: '' }] };
  assert.equal(parseFleetBackup(JSON.stringify({ ...base, token: 'secret' })).ok, false);
  assert.equal(parseFleetBackup(JSON.stringify({ ...base, cells: [{ ...base.cells[0], apiKey: 'secret' }] })).ok, false);
  assert.equal(parseFleetBackup(JSON.stringify({ ...base, cells: Array.from({ length: 33 }, (_, i) => ({ id: `C${i}`, cwd: '/tmp', engine: 'claude', systemPrompt: '' })) })).ok, false);
});

test('fleet backup: mapping engine non trascina il modello sorgente', async () => {
  const { restoreCellDefinition } = await mod();
  const cell = {
    id: 'Dev', cwd: '/tmp', engine: 'claude', boot: false, model: 'fable',
    models: { claude: 'fable', codex: 'gpt-5' }, systemPrompt: 'p',
  };
  assert.equal(restoreCellDefinition(cell, 'claude', ['claude', 'codex']).model, 'fable');
  assert.equal(restoreCellDefinition(cell, 'codex', ['claude', 'codex']).model, 'gpt-5');
  assert.equal(restoreCellDefinition(cell, 'pi', ['claude', 'pi']).model, undefined);
});

test('fleet backup: engine managed/custom round-trip keeps env names but never values', async () => {
  const { createFleetBackup, parseFleetBackup, portableEngineDefinition } = await mod();
  const engines = [
    { id: 'claude.zai-a', label: 'Claude Z.AI A', rc: true, envKeys: [],
      managedInfo: { configured: true, reason: 'runtime-only' }, managed: {
      client: 'claude', provider: 'zai', credentialProfile: 'a', model: 'glm-5', permissionPolicy: 'unsafe',
    } },
    { id: 'custom', label: 'Custom', rc: false, command: '/usr/bin/custom', args: ['--safe'],
      envKeys: ['API_TOKEN', 'PROFILE'], promptMode: 'send-keys' },
  ];
  const backup = createFleetBackup([], new Set(), engines, new Set(engines.map((engine) => engine.id)), new Date('2026-07-14T00:00:00Z'));
  const parsed = parseFleetBackup(JSON.stringify(backup));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.engines[0].managed.client, 'claude');
  assert.equal(Object.hasOwn(parsed.engines[0], 'managedInfo'), false);
  assert.equal(Object.hasOwn(parsed.engines[0], 'envKeys'), false);
  assert.deepEqual(parsed.engines[1].envKeys, ['API_TOKEN', 'PROFILE']);
  assert.deepEqual(portableEngineDefinition(parsed.engines[1]).envKeys, ['API_TOKEN', 'PROFILE']);
  assert.equal(JSON.stringify(backup).includes('secret-value'), false);
});

test('fleet backup: custom engine rejects secret-looking argv and invalid env names', async () => {
  const { parseFleetBackup } = await mod();
  const base = { format: 'nexuscrew.fleet', version: 2, cells: [], engines: [] };
  const custom = { id: 'custom', label: 'Custom', rc: false, command: '/usr/bin/custom', args: [], envKeys: [], promptMode: 'send-keys' };
  assert.equal(parseFleetBackup(JSON.stringify({ ...base, engines: [{ ...custom, args: ['--api-key=secret-value'] }] })).ok, false);
  assert.equal(parseFleetBackup(JSON.stringify({ ...base, engines: [{ ...custom, args: ['--api-key', 'opaque-value'] }] })).ok, false);
  assert.equal(parseFleetBackup(JSON.stringify({ ...base, engines: [{ ...custom, args: ['sk-exampleCredentialValue123'] }] })).ok, false);
  assert.equal(parseFleetBackup(JSON.stringify({ ...base, engines: [{ ...custom, envKeys: ['BAD-NAME'] }] })).ok, false);
});

// --- panelUrl nel backup (rilievo 1 audit D8) -------------------------------
// Prima dell'allowlist il campo spariva in silenzio nel round-trip per ENTRRAMBI
// i rami (managed e custom): export pulito, restore senza pannello, nessun
// errore. Ora viaggia, e un valore invalido rifiuta l'engine (fail-closed).
test('fleet backup: panelUrl di engine managed E custom sopravvive a export -> parse', async () => {
  const { createFleetBackup, parseFleetBackup, portableEngineDefinition } = await mod();
  const engines = [
    { id: 'x.managed', label: 'X', rc: true, envKeys: [], managedInfo: { configured: true, reason: 'runtime-only' },
      managed: { client: 'claude', provider: 'zai', credentialProfile: 'a', model: 'glm-5', permissionPolicy: 'unsafe' },
      panelUrl: 'https://127.0.0.1:6901' },
    { id: 'custom', label: 'Custom', rc: false, command: '/usr/bin/custom', args: ['--safe'],
      envKeys: ['API_TOKEN'], promptMode: 'send-keys', panelUrl: 'https://localhost:6901' },
  ];
  const backup = createFleetBackup([], new Set(), engines, new Set(engines.map((e) => e.id)), new Date('2026-08-15T00:00:00Z'));
  const parsed = parseFleetBackup(JSON.stringify(backup));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.engines[0].panelUrl, 'https://127.0.0.1:6901', 'panelUrl managed nel backup');
  assert.equal(parsed.engines[1].panelUrl, 'https://localhost:6901', 'panelUrl custom nel backup');
  // la definizione portable che il restore consegna conserva il campo
  assert.equal(portableEngineDefinition(parsed.engines[0]).panelUrl, 'https://127.0.0.1:6901');
  assert.equal(portableEngineDefinition(parsed.engines[1]).panelUrl, 'https://localhost:6901');
});

test('fleet backup: panelUrl engine INVALIDO rifiuta l\'engine, non viene scartato in silenzio', async () => {
  const { parseFleetBackup } = await mod();
  const base = { format: 'nexuscrew.fleet', version: 3, cells: [], engines: [] };
  const managed = { id: 'x.managed', label: 'X', rc: false,
    managed: { client: 'claude', provider: 'zai', model: 'glm-5', permissionPolicy: 'unsafe' } };
  const custom = { id: 'custom', label: 'Custom', rc: false, command: '/usr/bin/custom', args: [], promptMode: 'send-keys' };
  assert.equal(parseFleetBackup(JSON.stringify({ ...base, engines: [{ ...managed, panelUrl: 'not a url' }] })).ok, false,
    'managed con panelUrl invalido: backup rifiutato');
  assert.equal(parseFleetBackup(JSON.stringify({ ...base, engines: [{ ...custom, panelUrl: 'not a url' }] })).ok, false,
    'custom con panelUrl invalido: backup rifiutato');
});

// --- NC-D: il nome deve sopravvivere al round-trip COMPLETO della PWA -------
// Non basta che lo schema accetti `label` in ingresso: il backup lo perde se
// l'export non lo scrive o se il restore non lo rimette nella definizione. Il
// giro qui sotto e' quello vero della PWA — export, serializzazione, parse,
// restore — e fallisce su entrambe quelle omissioni.
test('fleet backup: il nome di una cella sopravvive a export -> parse -> restore', async () => {
  const { createFleetBackup, parseFleetBackup, restoreCellDefinition } = await mod();
  const backup = createFleetBackup([{
    id: 'Dev', cwd: '/home/other/device/dev', cwdRel: 'dev', engine: 'claude', boot: false,
    label: 'Cella di sviluppo', prompt: '',
  }], new Set(['Dev']), new Date('2026-08-04T00:00:00Z'));
  assert.equal(backup.cells[0].label, 'Cella di sviluppo', "l'export deve contenere il nome");

  const parsed = parseFleetBackup(JSON.stringify(backup));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cells[0].label, 'Cella di sviluppo', 'il parse deve conservarlo');

  const restored = restoreCellDefinition(parsed.cells[0], 'claude', ['claude']);
  assert.equal(restored.label, 'Cella di sviluppo', 'il restore deve rimetterlo nella definizione');
});

test('fleet backup: una cella senza nome non ne inventa uno vuoto', async () => {
  const { createFleetBackup, parseFleetBackup, restoreCellDefinition } = await mod();
  const backup = createFleetBackup([{ id: 'Dev', cwdRel: 'dev', engine: 'claude', boot: false, prompt: '' }],
    new Set(['Dev']), new Date('2026-08-04T00:00:00Z'));
  assert.equal(Object.hasOwn(backup.cells[0], 'label'), false);
  const parsed = parseFleetBackup(JSON.stringify(backup));
  assert.equal(Object.hasOwn(restoreCellDefinition(parsed.cells[0], 'claude', ['claude']), 'label'), false);
});

test('fleet backup: un nome non stampabile o troppo lungo invalida il backup', async () => {
  const { parseFleetBackup } = await mod();
  const base = { format: 'nexuscrew.fleet', version: 3, exportedAt: '2026-08-04T00:00:00Z', engines: [] };
  const cell = { id: 'Dev', cwdRel: 'dev', engine: 'claude', boot: false, systemPrompt: '' };
  assert.equal(parseFleetBackup(JSON.stringify({ ...base, cells: [{ ...cell, label: 'a'.repeat(65) }] })).ok, false);
  assert.equal(parseFleetBackup(JSON.stringify({ ...base, cells: [{ ...cell, label: '   ' }] })).ok, false);
  assert.equal(parseFleetBackup(JSON.stringify({ ...base, cells: [{ ...cell, label: 42 }] })).ok, false);
});
