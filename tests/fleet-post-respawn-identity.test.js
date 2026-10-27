'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const launchTarget = require('../lib/fleet/launch-target.js');

// Identita' del supervisore dopo il respawn: il record puo' dichiarare
// up:true solo se il panePid reale e' stato ricatturato sul canale posseduto
// e committato nel record durevole. Risposta persa, risposta senza pane_pid
// o commit rifiutato sono fallimenti espliciti: mai un successo che cavalca
// il pid del placeholder, mai un client nuovo per rileggere l'identita'.
function world(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrespawn-'));
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
    cells: [{ id: 'Dev', tmuxSession: 'work-ident', cwd, engine: 'client', boot: false }],
  });
  const stageDir = path.join(root, 'stage');
  const idsFile = path.join(root, 'ids');
  const natoFile = path.join(root, 'nato');
  const respawnFile = path.join(root, 'respawned');
  const log = path.join(root, 'tmux.log');
  fs.mkdirSync(stageDir);
  fs.writeFileSync(idsFile, '$5\t@7\t%9\n');
  fs.writeFileSync(log, '');
  const tmuxBin = path.join(root, 'fake-tmux.js');
  fs.writeFileSync(tmuxBin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
const mode = ${JSON.stringify(mode)};
const respawnFile = ${JSON.stringify(respawnFile)};
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
if (args[0] === '-C') {
  if (process.argv.includes('new-session')) {
    const { spawnSync: creaSync } = require('node:child_process');
    const rCrea = creaSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpoCrea = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : ''); if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
  process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
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
if (args[0] === 'new-session') { fs.writeFileSync(${JSON.stringify(natoFile)}, '1'); process.stdout.write(fs.readFileSync(${JSON.stringify(idsFile)}, 'utf8')); process.exit(0); }
if (args[0] === 'set-option') { process.exit(0); }
if (args[0] === 'respawn-pane') { fs.writeFileSync(respawnFile, '1'); process.exit(0); }
if (args[0] === 'display-message') {
  // Il canale posseduto quota l'argomento formato: il riconoscimento va
  // fatto sul contenuto, non sulla forma esatta dell'ultimo argomento.
  if (args.some((a) => typeof a === 'string' && a.includes('#{pane_pid}'))) {
    // identita' del supervisore: placeholder prima del respawn, processo
    // vero dopo. Il modo decide se la seconda lettura si perde, torna
    // incompleta o nomina il supervisore reale.
    if (fs.existsSync(respawnFile)) {
      if (mode === 'lost') { process.stderr.write('synthetic identity reply lost\\n'); process.exit(1); }
      if (mode === 'incomplete') { process.stdout.write('4242\\n'); process.exit(0); }
      process.stdout.write('4242\\t2222\\n'); process.exit(0);
    }
    process.stdout.write('4242\\t1111\\n'); process.exit(0);
  }
  process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (args[0] === 'kill-session') { try { fs.unlinkSync(${JSON.stringify(natoFile)}); } catch (_) {} process.exit(0); }
if (args[0] === 'list-sessions') { if (fs.existsSync(${JSON.stringify(natoFile)})) process.stdout.write('$5\\twork-ident\\n'); process.exit(0); }
if (args[0] === 'has-session') { process.exit(fs.existsSync(${JSON.stringify(natoFile)}) ? 0 : 1); }
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  return {
    root, defsPath, tmuxBin,
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function attempt(mode, { denyRecordUpdate = false } = {}) {
  const w = world(mode);
  const revoked = [];
  const launchBroker = {
    issue: async () => ({ socketPath: path.join(w.root, 'broker.sock'), nonce: 'a'.repeat(64) }),
    revoke: async (nonce) => { revoked.push(nonce); },
    close: async () => {},
  };
  const fleet = await createBuiltinFleet({
    home: w.root, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin,
    ensureTmuxProtection: async () => {}, launchBroker, platform: 'win32', env: {},
    launchReadyMs: 0, filesRoot: path.join(w.root, 'files'),
  });
  const writeSync = fs.writeFileSync;
  let result = null;
  let error = null;
  try {
    if (denyRecordUpdate) {
      // Il commit dell'identita' reale (panePid 2222) fallisce a livello di
      // scrittura: il modulo prodotto riporta false, come per un EIO reale.
      fs.writeFileSync = (target, contenuto, ...rest) => {
        if (typeof contenuto === 'string' && contenuto.includes('"panePid":2222')) {
          throw Object.assign(new Error('synthetic record EIO'), { code: 'EIO' });
        }
        return writeSync(target, contenuto, ...rest);
      };
    }
    try { result = await fleet.up('Dev'); } catch (caught) { error = caught; }
  } finally {
    fs.writeFileSync = writeSync;
    await fleet.close();
  }
  const record = launchTarget.leggi(path.join(w.root, 'files'), 'work-ident');
  return { w, result, error, revoked, record, calls: w.calls() };
}

test('lost post-respawn identity reply fails the launch, not rides the placeholder', async () => {
  const r = await attempt('lost');
  try {
    assert.ok(r.error, 'la risposta persa dopo il respawn deve fallire il lancio');
    assert.equal(r.error.fleetCode, 'POST_RESPAWN_IDENTITY_UNKNOWN');
    assert.ok(!r.result || r.result.ok !== true, 'mai up:true con il pid del placeholder');
    assert.equal(r.record.stato, 'assente', 'nessuna identita' + '\'' + ' superstite nel record dopo il cleanup');
    assert.ok(r.calls.some((args) => args[0] === 'kill-session'), 'fermata conservativa via canale posseduto');
  } finally { r.w.cleanup(); }
});

test('incomplete post-respawn identity reply fails the launch', async () => {
  const r = await attempt('incomplete');
  try {
    assert.ok(r.error, 'una risposta senza pane_pid deve fallire il lancio');
    assert.equal(r.error.fleetCode, 'POST_RESPAWN_IDENTITY_UNKNOWN');
    assert.ok(!r.result || r.result.ok !== true);
    assert.equal(r.record.stato, 'assente');
  } finally { r.w.cleanup(); }
});

test('refused durable identity update fails the launch', async () => {
  const r = await attempt('ok', { denyRecordUpdate: true });
  try {
    assert.ok(r.error, 'un commit rifiutato del panePid reale deve fallire il lancio');
    assert.equal(r.error.fleetCode, 'LAUNCH_TARGET_UNWRITABLE');
    assert.ok(!r.result || r.result.ok !== true);
    assert.equal(r.record.stato, 'assente');
  } finally { r.w.cleanup(); }
});

test('captured and committed identity completes the launch naming the real supervisor', async () => {
  const r = await attempt('ok');
  try {
    assert.ok(r.result, 'il caso positivo deve riuscire');
    assert.equal(r.result.ok, true);
    assert.equal(r.record.stato, 'presente');
    assert.equal(r.record.record.panePid, 2222, 'il record nomina il supervisore reale, non il placeholder');
    assert.notEqual(r.record.record.panePid, 1111);
    assert.ok(!r.calls.some((args) => args[0] === 'kill-session'), 'nessuna fermata nel caso positivo');
  } finally { r.w.cleanup(); }
});
