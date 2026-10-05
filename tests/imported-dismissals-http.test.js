'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const { createAsksStore } = require('../lib/notify/asks.js');
const nodes = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const OWNER = 'b'.repeat(32), ID = '12345678';
async function boot(t, { readonly = false, malformed = false, symlink = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-owner-access-'));
  const configDir = path.join(home, '.nexuscrew'); fs.mkdirSync(configDir);
  const nodesPath = path.join(configDir, 'nodes.json'); nodes.initStore(nodesPath);
  const store = createAsksStore({ dir: configDir });
  const alias = store.create({ question: 'Review?', options: ['Yes'], session: tmuxSessionForCell('reviewer'), ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 100 }).ask;
  let st = nodes.addNode(nodes.loadStoreStrict(nodesPath), { name: 'owner', nodeId: OWNER, direction: 'inbound', token: 'fixture', shared: true, visibility: 'network', ssh: 'demo@example.invalid', localPort: 42001, remotePort: 42002 });
  st = nodes.setPeerAccessPreset(st, 'owner', 'admin'); nodes.atomicWriteStore(nodesPath, st);
  if (malformed) { const value = JSON.parse(fs.readFileSync(store.filePath)); value.importedDismissals = []; fs.writeFileSync(store.filePath, JSON.stringify(value)); }
  if (symlink) { fs.renameSync(store.filePath, store.filePath + '.target'); fs.symlinkSync(store.filePath + '.target', store.filePath); }
  const runtime = createServer({ home, configDir, nodesPath, configPath: path.join(configDir, 'config.json'), tokenPath: path.join(configDir, 'token'),
    readonlyDefault: readonly, filesRoot: path.join(home, 'files'), port: 0, fleetEnabled: false, sessionExistsSeam: () => true, pasteSeam: () => true,
    askSubmit: async () => ({ outcome: 'submitted', submitted: true }),
    settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { throw new Error('disabled'); }, serviceInstallPath: path.join(home, 'service'),
      keygen: () => 'ssh-ed25519 AAAAFIXTURE demo', spawnImpl: () => ({ pid: 4100000, unref() {} }), sshVersion: () => ({ major: 9, minor: 6 }) },
  });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); runtime.watcher.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { ...runtime, configDir, alias, nodesPath, port: runtime.server.address().port, id: nodes.loadStoreStrict(nodesPath).nodeId };
}

async function dismiss(runtime, extra = {}) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/asks-relay`, { method: 'POST', headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'dismiss-local', ownerId: OWNER, askId: ID, ...extra }) });
  return { code: response.status, body: await response.json() };
}
test('local dismissal acknowledges durable imported state without waiting for the owner', async t => {
  const runtime = await boot(t); const calls = [];
  const actual = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push(String(url)); return actual(url, options); });
  const result = await dismiss(runtime); assert.equal(result.code, 200); assert.deepEqual(result.body, { dismissed: true, scope: 'local', ownerSync: 'pending' });
  const store = createAsksStore({ dir: runtime.configDir }); const record = store.getImportedDismissal(OWNER, ID);
  assert.equal(record.dismissedReason, 'owner-unreachable'); assert.equal(store.get(runtime.alias.id).dismissed, true);
  assert.equal(calls.some(url => url.includes('/event-feed/asks/')), false);
});
for (const [name, options, extra, code] of [
  ['READONLY', { readonly: true }, {}, 403],
  ['malformed dismissal store', { malformed: true }, {}, 503],
  ['symlink dismissal store', { symlink: true }, {}, 503],
  ['spoofed fingerprint', {}, { fingerprint: 'forged' }, 400],
  ['unknown canonical pair', {}, { askId: '87654321' }, 404],
  ['local alias id passed as owner ask id', {}, { askId: 'alias' }, 400],
]) test(`local dismissal refuses ${name} without persisting intent`, async t => {
  const runtime = await boot(t, options); const result = await dismiss(runtime, extra); assert.equal(result.code, code);
  if (!options.malformed && !options.symlink) assert.equal(createAsksStore({ dir: runtime.configDir }).getImportedDismissal(OWNER, ID), null);
});
test('parallel local dismiss clicks preserve one durable timestamp and revision', async t => {
  const runtime = await boot(t); const results = await Promise.all([dismiss(runtime), dismiss(runtime)]); assert.deepEqual(results.map(r => r.code), [200, 200]);
  const store = createAsksStore({ dir: runtime.configDir }); assert.equal(store.listImportedDismissals().length, 1); assert.equal(store.get(runtime.alias.id).revision, 1);
});
