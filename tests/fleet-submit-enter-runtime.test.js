'use strict';
// E01 (audit submit Enter): la generazione iniziale di un engine custom con
// `submit: 'enter'` deve arrivare davvero alla consegna passando dal percorso
// reale `createBuiltinFleet().up`. I test dell'helper, da soli, non vedono un
// import sbagliato: qui il fake tmux registra OGNI argv, quindi una paste o un
// Enter mancante e' un'asserzione rossa, non un TypeError nascosto.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

function world({ delivery = 'submitted' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsubmit-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'Dev');
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const client = path.join(binDir, 'client');
  fs.writeFileSync(client, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  fs.chmodSync(client, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'client', label: 'Client', rc: false, command: client, args: [], env: {},
      promptMode: 'send-keys', submit: 'enter',
    }],
    cells: [{ id: 'Dev', tmuxSession: 'work-submit', cwd, engine: 'client', boot: false, prompt: 'hello\nworld' }],
  });
  const natoFile = path.join(root, 'nato');
  const log = path.join(root, 'tmux.log');
  fs.writeFileSync(log, '');
  const tmuxBin = path.join(root, 'fake-tmux.js');
  fs.writeFileSync(tmuxBin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const nato = ${JSON.stringify(natoFile)};
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const field = args[args.length - 1];
if (args[0] === 'list-sessions') { if (fs.existsSync(nato)) process.stdout.write('$5\\twork-submit\\n'); process.exit(0); }
if (args[0] === 'new-session') { fs.writeFileSync(nato, '1'); process.stdout.write('$5\\t@7\\t%9\\n'); process.exit(0); }
if (args[0] === 'display-message') {
  if (field === '#{session_id}') { process.stdout.write('$5\\n'); process.exit(0); }
  if (field === '#{pane_dead}\\t#{pane_dead_status}\\t#{pane_id}') { process.stdout.write('0\\t\\t%9\\n'); process.exit(0); }
  if (field === '#{session_name}\\t#{pane_dead}\\t#{pane_id}') { process.stdout.write('work-submit\\t0\\t%9\\n'); process.exit(0); }
  if (field === '#{@nc_delivery}') { process.stdout.write('${delivery}\\n'); process.exit(0); }
  if (field === '#{@nc_mcp_list}') { process.stdout.write('\\n'); process.exit(0); }
  process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (args[0] === 'kill-session') { try { fs.unlinkSync(nato); } catch (_) {} process.exit(0); }
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  return {
    root, home, defsPath, tmuxBin,
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function up(opts = {}) {
  const w = world(opts);
  const launchBroker = {
    issue: async () => ({ socketPath: path.join(w.root, 'broker.sock'), nonce: 'b'.repeat(64) }),
    revoke: async () => {},
    close: async () => {},
  };
  const fleet = await createBuiltinFleet({
    home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin,
    ensureTmuxProtection: async () => {}, launchBroker, platform: 'win32', env: {},
    launchReadyMs: 0,
    // Nessuna attesa cieca nella prova: il fake risponde subito.
    sendKeysReadyMs: 0, bootstrapReadyWaitMs: 0,
  });
  try {
    const result = await fleet.up('Dev');
    return { w, result, calls: w.calls() };
  } finally {
    await fleet.close();
  }
}

test('E01: la generazione iniziale di un engine opt-in consegna davvero il prompt', async () => {
  const { w, result, calls } = await up();
  try {
    assert.ok(result && result.ok, 'up deve riuscire');
    assert.ok(result.prompt, 'up deve riportare un esito di consegna');
    const pastes = calls.filter((args) => args[0] === 'paste-buffer');
    const enters = calls.filter((args) => args[0] === 'send-keys');
    assert.equal(pastes.length, 1, 'un solo paste, dal percorso reale di up');
    assert.equal(pastes[0].includes('-p'), true, 'paste delimitato');
    assert.equal(enters.length, 1, 'un solo Enter');
    assert.deepEqual(enters[0].slice(-2), ['%9', 'Enter'], 'Enter sul %N risolto');
    assert.equal(result.prompt.state, 'submitted');
    assert.ok(!calls.some((args) => args.includes('hello\nworld')), 'testo mai in argv');
  } finally { w.cleanup(); }
});
