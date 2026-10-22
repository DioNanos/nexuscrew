'use strict';
// La generazione iniziale di un engine custom con
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

function world({ report = 'transport-unsupported' } = {}) {
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
  if (field === '#{@nc_delivery}') { process.stdout.write('${report}\\n'); process.exit(0); }
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
  // opts.report = stato pubblicato dal supervisore su @nc_delivery
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

// L'opt-in NON e' un'attestazione. Senza una prova del framing, il
// prodotto dichiara `transport-unsupported` prima di qualunque effetto.
test('senza attestazione l\'up di un engine opt-in non digita nulla', async () => {
  const { w, result, calls } = await up();
  try {
    assert.ok(result && result.ok, 'il lancio riesce comunque');
    assert.equal(result.prompt.state, 'transport-unsupported');
    assert.equal(result.prompt.delivered, false);
    assert.equal(calls.filter((args) => args[0] === 'paste-buffer').length, 0, 'zero paste');
    assert.equal(calls.filter((args) => args[0] === 'send-keys').length, 0, 'zero Enter, zero tasti');
  } finally { w.cleanup(); }
});

// L'attestazione vera oggi non esiste, ma il percorso paste+Enter deve restare
// nel codice e provato: qui l'attestazione e' finta e lo dice.
// La consegna della generazione 0 appartiene al supervisore. Il runtime
// non digita mai: legge l'esito bounded dal pane, come per il bootstrap
// classificato. Un solo proprietario per tutte le generazioni.
test('la generazione 0 di un opt-in e consegnata dal supervisore, non dal runtime', async () => {
  const { setBracketedPasteAttestor } = require('../lib/fleet/pane-attestation.js');
  setBracketedPasteAttestor(() => ({ attested: true }));
  try {
    const { w, result, calls } = await up({ report: 'submitted' });
    try {
      assert.ok(result && result.ok);
      assert.equal(result.prompt.state, 'submitted', 'esito letto dal report del supervisore');
      assert.equal(result.prompt.delivered, true);
      assert.equal(calls.filter((args) => args[0] === 'paste-buffer').length, 0,
        'nessun paste dal runtime: un solo proprietario');
      assert.equal(calls.filter((args) => args[0] === 'send-keys').length, 0,
        'nessun Enter dal runtime');
      assert.ok(calls.some((args) => args[0] === 'display-message' && args[args.length - 1] === '#{@nc_delivery}'),
        'il runtime legge @nc_delivery');
    } finally { w.cleanup(); }
  } finally { setBracketedPasteAttestor(null); }
});

// Il runtime non riformula l'esito del supervisore: uno stato incerto deve
// arrivare all'operatore come incerto, mai promosso a consegnato.
test('il runtime riporta l\'esito del supervisore senza riformularlo', async () => {
  const { w, result, calls } = await up({ report: 'delivery-unknown' });
  try {
    assert.ok(result && result.ok);
    assert.equal(result.prompt.state, 'delivery-unknown');
    assert.equal(result.prompt.delivered, false, 'incerto non significa consegnato');
    assert.equal(calls.filter((args) => args[0] === 'paste-buffer').length, 0);
    assert.equal(calls.filter((args) => args[0] === 'send-keys').length, 0);
  } finally { w.cleanup(); }
});

