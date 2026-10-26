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
  // Marcatore di sessione NATA: il fake risponde a list-sessions con lo stato
  // vero del server (prima di new-session non c'e' nessuna sessione). Un fake
  // che risponde «vivo» sempre descriverebbe uno stato impossibile — sessione
  // esistente E new-session che la crea — e la guardia in testa a up() lo
  // fermerebbe prima dello stadio che questi test vogliono raggiungere.
  const natoFile = path.join(root, 'nato');
  const log = path.join(root, 'tmux.log');
  fs.writeFileSync(stageFile, '');
  fs.writeFileSync(idsFile, '$5\t@7\t%9\n');
  fs.writeFileSync(log, '');
  const tmuxBin = path.join(root, 'fake-tmux.js');
  fs.writeFileSync(tmuxBin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
const stage = fs.readFileSync(${JSON.stringify(stageFile)}, 'utf8').trim();
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const fail = (name) => { if (stage === name) { process.stderr.write('synthetic ' + name + ' failure\\n'); process.exit(1); } };
if (args[0] === '-C') {
  process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  let buf = '';
  let n = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!riga) continue;
      n += 1;
      const r = spawnSync(process.execPath, [__filename, '-S', 'sock'].concat(riga.split(/\\s+/)), { encoding: 'utf8' });
      if ((r.status || 0) === 0) process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stdout || '') + '%end 1 ' + n + ' 1\\n');
      else process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stderr || '') + '%error 1 ' + n + ' 1\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
if (args[0] === 'new-session') { fail('new-session'); fs.writeFileSync(${JSON.stringify(natoFile)}, '1'); process.stdout.write(fs.readFileSync(${JSON.stringify(idsFile)}, 'utf8')); process.exit(0); }
if (args[0] === 'set-option') { fail('set-option'); process.exit(0); }
if (args[0] === 'respawn-pane') { fail('respawn-pane'); process.exit(0); }
if (args[0] === 'display-message') {
  if (args[args.length - 1] === '#{session_id}') { process.stdout.write('$5\\n'); process.exit(0); }
  if (args[args.length - 1] === '#{pid}') { process.stdout.write('4242\\n'); process.exit(0); }
  fail('readiness'); process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (args[0] === 'list-sessions') { if (fs.existsSync(${JSON.stringify(natoFile)})) process.stdout.write('$5\\twork-build\\n'); process.exit(0); }
if (args[0] === 'kill-session') { try { fs.unlinkSync(${JSON.stringify(natoFile)}); } catch (_) {} process.exit(0); }
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
      else assert.deepEqual(kills, [['kill-session', '-t', '$5']], 'cleanup sul session ID stabile, dal canale');
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
    assert.equal(result.calls.some((args) => args.includes('#{session_id}')), false,
      'senza id di sessione non si apre un client per risalire');
    assert.equal(result.calls.some((args) => args[0] === 'kill-session'), false,
      'senza canale e senza id non parte un kill');
    assert.equal(result.calls.flat().includes('=work-build'), false);
  } finally { result.w.cleanup(); }
});
