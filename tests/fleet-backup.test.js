'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const mod = () => import('../frontend/src/lib/fleet-backup.js');

test('fleet backup: export selettivo include prompt ma nessun segreto estraneo', async () => {
  const { createFleetBackup, parseFleetBackup } = await mod();
  const backup = createFleetBackup([{
    id: 'Dev', cwd: '/tmp', engine: 'claude', boot: true, prompt: 'senior dev',
    model: 'fable', models: { claude: 'fable' }, permissionPolicies: { claude: 'unsafe' },
    token: 'NO', env: { API_KEY: 'NO' }, tmuxSession: 'cloud-Dev',
  }], new Set(['Dev']), new Date('2026-07-12T00:00:00Z'));
  const serialized = JSON.stringify(backup);
  assert.equal(serialized.includes('NO'), false);
  assert.equal(serialized.includes('cloud-Dev'), false);
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
