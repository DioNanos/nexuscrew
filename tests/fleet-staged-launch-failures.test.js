'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncstaged-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'Dev');
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const client = path.join(binDir, 'client');
  fs.writeFileSync(client, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(client, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'client', label: 'Client', rc: false, command: client, args: [], env: {}, promptMode: 'flag', promptFlag: '--prompt' }],
    cells: [{ id: 'Dev', tmuxSession: 'work-build', cwd, engine: 'client', boot: false }],
  });
  const stageFile = path.join(root, 'stage');
  const idsFile = path.join(root, 'ids');
  const log = path.join(root, 'tmux.log');
  fs.writeFileSync(stageFile, '');
  fs.writeFileSync(idsFile, '$5\t@7\t%9\n');
  fs.writeFileSync(log, '');
  const tmuxBin = path.join(root, 'fake-tmux.js');
  fs.writeFileSync(tmuxBin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const stage = fs.readFileSync(${JSON.stringify(stageFile)}, 'utf8').trim();
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const fail = (name) => { if (stage === name) { process.stderr.write('synthetic ' + name + ' failure\\n'); process.exit(1); } };
if (args[0] === 'new-session') { fail('new-session'); process.stdout.write(fs.readFileSync(${JSON.stringify(idsFile)}, 'utf8')); process.exit(0); }
if (args[0] === 'set-option') { fail('set-option'); process.exit(0); }
if (args[0] === 'respawn-pane') { fail('respawn-pane'); process.exit(0); }
if (args[0] === 'display-message') {
  if (args[args.length - 1] === '#{session_id}') { process.stdout.write('$5\\n'); process.exit(0); }
  fail('readiness'); process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (args[0] === 'list-sessions') { process.stdout.write('$5\\twork-build\\n'); process.exit(0); }
if (args[0] === 'kill-session') { process.exit(0); }
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  return {
    root, home, defsPath, tmuxBin, stageFile, idsFile, log,
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function runFailure(stage, { ids } = {}) {
  const w = world();
  if (ids !== undefined) fs.writeFileSync(w.idsFile, ids);
  fs.writeFileSync(w.stageFile, stage);
  const revoked = [];
  const launchBroker = {
    issue: async () => ({ socketPath: path.join(w.root, 'broker.sock'), nonce: 'a'.repeat(64) }),
    revoke: async (nonce) => { revoked.push(nonce); },
    close: async () => {},
  };
  const fleet = await createBuiltinFleet({
    home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin,
    ensureTmuxProtection: async () => {}, launchBroker, platform: 'win32', env: {},
    launchReadyMs: 0,
  });
  let error;
  try { await fleet.up('Dev'); } catch (caught) { error = caught; }
  await fleet.close();
  return { w, error, revoked, calls: w.calls() };
}

for (const stage of ['new-session', 'set-option', 'respawn-pane', 'readiness']) {
  test(`staged launch failure ${stage}: ticket revocato e cleanup solo via $N`, async () => {
    const result = await runFailure(stage);
    try {
      assert.ok(result.error, 'errore osservabile');
      assert.equal(result.error.fleetCode,
        stage === 'readiness' ? 'CLIENT_EARLY_EXIT' : 'NEW_SESSION_FAILED');
      assert.deepEqual(result.revoked, ['a'.repeat(64)], 'ticket revocato senza attendere TTL');
      const kills = result.calls.filter((args) => args[0] === 'kill-session');
      if (stage === 'new-session') assert.deepEqual(kills, [], 'new-session fallita: nulla da pulire');
      else assert.deepEqual(kills, [['kill-session', '-t', '$5']], 'cleanup sul session ID stabile');
      assert.equal(result.calls.flat().includes('=work-build'), false,
        'nessun cleanup critico torna al nome richiesto');
    } finally { result.w.cleanup(); }
  });
}

test('output new-session parziale: risolve $N dal %N, pulisce e fallisce chiuso', async () => {
  const result = await runFailure('', { ids: 'invalid-session\t@7\t%9\n' });
  try {
    assert.ok(result.error);
    assert.equal(result.error.fleetCode, 'NEW_SESSION_FAILED');
    assert.deepEqual(result.revoked, ['a'.repeat(64)]);
    assert.ok(result.calls.some((args) => args[0] === 'display-message'
      && args.includes('%9') && args.includes('#{session_id}')),
    'session ID risolto dal pane stabile');
    assert.ok(result.calls.some((args) => args.join(' ') === 'kill-session -t $5'));
    assert.equal(result.calls.flat().includes('=work-build'), false);
  } finally { result.w.cleanup(); }
});
