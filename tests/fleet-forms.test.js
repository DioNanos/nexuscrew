'use strict';
// Pure fleet form transformations extracted from FleetTab.jsx into
// frontend/src/lib/fleet-forms.js. These lock the default/normalization
// behaviour (blank shapes, managed/custom build-engine, round-trips) so the
// FleetTab modularization cannot silently drift the editor semantics.

const { test } = require('node:test');
const assert = require('node:assert');

const mod = () => import('../frontend/src/lib/fleet-forms.js');

test('fleet-forms exports the full transformation surface', async () => {
  const f = await mod();
  for (const name of ['blankEngine', 'blankCell', 'defaultPermission', 'catalogEntry', 'managedLabel', 'engineForm', 'buildEngine']) {
    assert.equal(typeof f[name], 'function', `${name} must be exported`);
  }
});

test('blankEngine/blankCell: stable defaults for a fresh form', async () => {
  const { blankEngine, blankCell } = await mod();
  const e = blankEngine();
  assert.equal(e.kind, 'managed');
  assert.equal(e.id, 'claude.native');
  assert.equal(e.client, 'claude');
  assert.equal(e.provider, 'native');
  assert.equal(e.permissionPolicy, 'unsafe');
  assert.equal(e.rc, true);
  assert.equal(e.promptMode, 'send-keys');
  assert.deepEqual(e.envRows, []);
  assert.equal(blankCell().engine, '');
  assert.deepEqual(blankCell('claude.native'), { id: '', cwd: '', engine: 'claude.native', boot: false, model: '', prompt: '' });
});

test('defaultPermission: claude is unsafe, everything else standard', async () => {
  const { defaultPermission } = await mod();
  assert.equal(defaultPermission('claude'), 'unsafe');
  assert.equal(defaultPermission('codex'), 'standard');
  assert.equal(defaultPermission('pi'), 'standard');
});

test('catalogEntry/managedLabel match client+provider+credentialProfile and fall back', async () => {
  const { catalogEntry, managedLabel } = await mod();
  const catalog = [
    { id: 'a', client: 'claude', provider: 'native', label: 'Claude', credentialProfile: '' },
    { id: 'b', client: 'claude', provider: 'zai', label: 'Claude Z.AI', credentialProfile: 'a' },
    { id: 'c', client: 'pi', provider: 'openrouter', label: 'Pi' },
  ];
  assert.equal(catalogEntry(catalog, { client: 'claude', provider: 'native' }).id, 'a');
  assert.equal(catalogEntry(catalog, { client: 'claude', provider: 'zai', credentialProfile: 'a' }).id, 'b');
  assert.equal(catalogEntry(catalog, { client: 'pi', provider: 'openrouter' }).id, 'c');
  assert.equal(catalogEntry(catalog, { client: 'nope', provider: 'nope' }), undefined);
  assert.equal(managedLabel(catalog, { client: 'claude', provider: 'native' }), 'Claude');
  assert.equal(managedLabel(catalog, { client: 'x', provider: 'y' }), 'x · y');
});

test('engineForm maps a managed definition into editable form state', async () => {
  const { engineForm } = await mod();
  const form = engineForm({
    id: 'claude.native', label: 'Claude',
    managed: { client: 'claude', provider: 'native', model: 'sonnet', permissionPolicy: 'unsafe' },
    managedInfo: { models: ['sonnet', 'opus'] }, envKeys: ['ANTHROPIC_API_KEY'], rc: true,
  });
  assert.equal(form.kind, 'managed');
  assert.equal(form.id, 'claude.native');
  assert.equal(form.client, 'claude');
  assert.equal(form.managedModel, 'sonnet');
  assert.equal(form.permissionPolicy, 'unsafe');
  assert.deepEqual(form.modelOptions, ['sonnet', 'opus']);
  assert.deepEqual(form.envRows, [{ key: 'ANTHROPIC_API_KEY', value: '', configured: true, remove: false }]);
  assert.equal(form.rc, true);
});

test('engineForm maps a custom definition, joining args into editable text', async () => {
  const { engineForm } = await mod();
  const form = engineForm({
    id: 'custom', managed: null, command: '/usr/bin/x', args: ['--foo', '--bar'], rc: false,
    promptMode: 'flag', promptFlag: '-p', model: { flag: '-m', value: 'big' }, envKeys: [],
  });
  assert.equal(form.kind, 'custom');
  assert.equal(form.command, '/usr/bin/x');
  assert.equal(form.argsText, '--foo\n--bar');
  assert.equal(form.promptMode, 'flag');
  assert.equal(form.promptFlag, '-p');
  assert.equal(form.modelFlag, '-m');
  assert.equal(form.modelValue, 'big');
});

test('buildEngine managed (create): catalog label, model and inherited default policy', async () => {
  const { buildEngine } = await mod();
  const catalog = [{ id: 'a', client: 'claude', provider: 'native', label: 'Claude' }];
  const out = buildEngine({ kind: 'managed', id: 'claude.native', client: 'claude', provider: 'native', managedModel: 'sonnet', permissionPolicy: '', label: '', rc: true, envRows: [] }, true, catalog);
  assert.deepEqual(out, { id: 'claude.native', label: 'Claude', rc: true, managed: { client: 'claude', provider: 'native', model: 'sonnet', permissionPolicy: 'unsafe' } });
});

test('buildEngine managed: credentialProfile set; envKey only when the profile declares credentialEnv', async () => {
  const { buildEngine } = await mod();
  const catalog = [
    { id: 'b', client: 'claude', provider: 'zai', credentialProfile: 'a', label: 'Claude Z.AI', credentialEnv: 'ZAI_API_KEY' },
    { id: 'd', client: 'pi', provider: 'native', label: 'Pi' },
  ];
  const out = buildEngine({ kind: 'managed', client: 'claude', provider: 'zai', credentialProfile: 'a', managedModel: '', permissionPolicy: 'standard', label: '', rc: true, envKey: 'sk-x', envRows: [] }, false, catalog);
  assert.equal(out.id, undefined, 'no id on edit');
  assert.equal(out.managed.credentialProfile, 'a');
  assert.equal(out.managed.envKey, 'sk-x', 'envKey copied because profile declares credentialEnv');
  // a profile without credentialEnv never attaches envKey, even with a value present
  const out2 = buildEngine({ kind: 'managed', client: 'pi', provider: 'native', managedModel: '', permissionPolicy: 'standard', label: '', rc: true, envKey: 'sk-y', envRows: [] }, false, catalog);
  assert.equal(Object.hasOwn(out2.managed, 'envKey'), false, 'no envKey without a declared credentialEnv');
});

test('buildEngine managed custom provider spreads the connection fields', async () => {
  const { buildEngine } = await mod();
  const out = buildEngine({ kind: 'managed', client: 'claude', provider: 'custom', managedModel: '', permissionPolicy: 'standard', label: 'X', rc: true, displayName: 'Acme', protocol: 'anthropic_messages', baseUrl: 'https://acme/v1', envKey: 'ACME_KEY', providerId: 'acme', envRows: [] }, true, []);
  assert.equal(out.managed.provider, 'custom');
  assert.equal(out.managed.displayName, 'Acme');
  assert.equal(out.managed.protocol, 'anthropic_messages');
  assert.equal(out.managed.baseUrl, 'https://acme/v1');
  assert.equal(out.managed.envKey, 'ACME_KEY');
  assert.equal(out.managed.providerId, 'acme');
});

test('buildEngine custom (create): args split with blanks dropped, env map, model and flag', async () => {
  const { buildEngine } = await mod();
  const out = buildEngine({
    kind: 'custom', id: 'c', label: '', command: '/bin/x', argsText: '--a\n\n--b\n', rc: true,
    promptMode: 'flag', promptFlag: '-p', modelFlag: '-m', modelValue: 'big',
    envRows: [{ key: 'K', value: 'v', remove: false }, { key: 'GONE', value: 'w', remove: true }, { key: '', value: 'x', remove: false }],
  }, true, []);
  assert.deepEqual(out.args, ['--a', '--b'], 'blank arg lines removed');
  assert.equal(out.id, 'c');
  assert.equal(out.promptMode, 'flag');
  assert.equal(out.promptFlag, '-p');
  assert.deepEqual(out.model, { flag: '-m', value: 'big' });
  assert.deepEqual(out.env, { K: 'v' }, 'removed/blank env rows excluded');
});

test('buildEngine custom (edit): no id, no env, label falls back to id', async () => {
  const { buildEngine } = await mod();
  const out = buildEngine({ kind: 'custom', id: 'c', label: '', command: '/bin/x', argsText: '--a', rc: false, promptMode: 'send-keys', envRows: [{ key: 'K', value: 'v', remove: false }] }, false, []);
  assert.equal(out.id, undefined);
  assert.equal(out.label, 'c');
  assert.equal(Object.hasOwn(out, 'env'), false);
  assert.equal(Object.hasOwn(out, 'model'), false);
  assert.equal(Object.hasOwn(out, 'promptFlag'), false);
});

test('round-trip: custom args survive engineForm -> buildEngine', async () => {
  const { engineForm, buildEngine } = await mod();
  const def = { id: 'c', managed: null, command: '/bin/x', args: ['--a', '--b'], rc: true, promptMode: 'send-keys', envKeys: [] };
  const back = buildEngine(engineForm(def), true, []);
  assert.deepEqual(back.args, ['--a', '--b']);
  assert.equal(back.command, '/bin/x');
  assert.equal(back.promptMode, 'send-keys');
});
