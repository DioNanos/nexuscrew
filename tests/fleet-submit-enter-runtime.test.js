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

function world({ markerFile = '', markerValue = null } = {}) {
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
  const marker = markerFile || path.join(root, 'delivery-marker');
  // markerValue: solo per i test "consumer-only", dove il valore e' scritto dal
  // TEST. Nel percorso produttore->consumer il file lo scrive il produttore.
  if (markerValue !== null) fs.writeFileSync(marker, `${markerValue}\n`);
  const log = path.join(root, 'tmux.log');
  fs.writeFileSync(log, '');
  const tmuxBin = path.join(root, 'fake-tmux.js');
  fs.writeFileSync(tmuxBin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  if (process.argv.includes('new-session')) {
    const { spawnSync: creaSync } = require('node:child_process');
    const rCrea = creaSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpoCrea = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : ''); if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
    process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  const { spawnSync } = require('node:child_process');
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
      if (riga === 'display-message -p nc-control-open') continue; // apertura: gia' risolta dal frame iniziale
      n += 1;
      const r = spawnSync(process.execPath, [__filename, '-S', 'sock'].concat(riga.split(/\\s+/)), { encoding: 'utf8' });
      if ((r.status || 0) === 0) process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stdout || '') + '%end 1 ' + n + ' 1\\n');
      else process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stderr || '') + '%error 1 ' + n + ' 1\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
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
  if (field === '#{@nc_delivery}') {
    let value = '';
    try { value = fs.readFileSync(${JSON.stringify(marker)}, 'utf8').trim(); } catch (_) {}
    process.stdout.write(value + '\\n');
    process.exit(0);
  }
  if (field === '#{@nc_mcp_list}') { process.stdout.write('\\n'); process.exit(0); }
  if ((typeof fmt === 'string' ? fmt : process.argv.join(' ')).includes('pane_pid')) { process.stdout.write('4242\\t2222\\n'); process.exit(0); }
  process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (args[0] === 'kill-session') { try { fs.unlinkSync(nato); } catch (_) {} process.exit(0); }
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  return {
    root, home, defsPath, tmuxBin, marker,
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function up(opts = {}) {
  // opts.markerFile = file da cui il fake tmux legge @nc_delivery; se assente
  // il fake legge un file che NESSUNO ha scritto: il report e' muto.
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

// R01: il rifiuto deve percorrere DAVVERO il percorso produttore -> opzione
// di pane -> consumer. Il fake tmux non ha nessun valore precaricato: legge il
// file che il PRODUTTORE vero (startGenerationPrompt) scrive, e se il
// produttore non scrive, l'up() arriva alla deadline e ripiega su
// report-timeout. E' la prova che il test precedente non faceva.
function publishFromProducer(markerFile) {
  const fsx = require('node:fs');
  const argv = [];
  const exec = async (_bin, args) => {
    argv.push(args.join(' '));
    if (args[0] === 'set-option') {
      fsx.writeFileSync(markerFile, `${args[5] === undefined ? '' : args[5]}\n`);
    }
    return { err: null, stdout: '', stderr: '', code: 0 };
  };
  const { startGenerationPrompt } = require('../lib/fleet/cell-exec.js');
  const ctl = startGenerationPrompt(
    { tmuxBin: 'tmux', tmuxSession: 'work-submit', prompt: 'hello\nworld', readyMs: 0, readyWaitMs: 0, submit: true },
    0,
    { exited: false },
    { setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {}, tmuxExec: exec },
  );
  return { ctl, argv };
}

test('R01: il rifiuto del produttore arriva al consumer come transport-unsupported', async () => {
  const w0 = world();
  const markerFile = w0.marker;
  const { ctl, argv } = publishFromProducer(markerFile);
  await ctl.settled;
  const delivered = require('node:fs').readFileSync(markerFile, 'utf8').trim();
  assert.equal(delivered, 'transport-unsupported', 'il produttore pubblica il proprio esito');
  assert.equal(argv.filter((a) => a.startsWith('send-keys')).length, 0, 'rifiuto = zero digitazione');

  const { w, result, calls } = await up({ markerFile });
  try {
    assert.ok(result && result.ok, 'il lancio riesce comunque');
    assert.equal(result.prompt.state, 'transport-unsupported',
      'up legge il report vero, non un report-timeout');
    assert.equal(result.prompt.delivered, false);
    assert.equal(calls.filter((args) => args[0] === 'paste-buffer').length, 0, 'zero paste');
    assert.equal(calls.filter((args) => args[0] === 'send-keys').length, 0, 'zero Enter, zero tasti');
  } finally { w.cleanup(); w0.cleanup(); }
});

// Consumer-only: qui il marker e' scritto dal TEST, non dal produttore (con il
// trasporto disabilitato il produttore non puo' emettere questi due stati).
// Serve a fissare che il runtime non RIFORMULA l'esito del supervisore.
test('consumer: il runtime riporta l\'esito del supervisore senza riformularlo', async () => {
  for (const [state, delivered] of [['submitted', true], ['delivery-unknown', false]]) {
    const { w, result, calls } = await up({ markerValue: state });
    try {
      assert.ok(result && result.ok);
      assert.equal(result.prompt.state, state);
      assert.equal(result.prompt.delivered, delivered, 'incerto non significa consegnato');
      assert.equal(calls.filter((args) => args[0] === 'paste-buffer').length, 0);
      assert.equal(calls.filter((args) => args[0] === 'send-keys').length, 0);
    } finally { w.cleanup(); }
  }
});
