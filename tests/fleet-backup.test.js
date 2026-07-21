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
