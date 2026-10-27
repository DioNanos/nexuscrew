'use strict';
// Test suite per newSessionEnv:
// Copre:
//  - nome fisso NEXUSCREW_VL_NEW, trasporto launcher-env, gen0 vs gen1, baseline ripulito,
//    managed solo argv, adapter solo env;
//  - verifica manifest di capacita statico (<command>.nc-caps.json) + hash sha256 del launcher;
//    preflight fail-closed (manifest assente/rotto/hash mismatch -> 400 LAUNCHER_UNSUPPORTED,
//    marcatore pending intatto, zero spawn, zero ticket); consumo dopo trust e cwd;
//  - predicato condiviso isVlNewSessionSupported su tutti i 5 punti (POST, GET state, status,
//    consumo in up, env gen0); round-trip schema/restore/edit; cooldown condiviso.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const {
  parseDefinitions, atomicWrite, loadDefinitions, isVlNewSessionSupported,
} = require('../lib/fleet/definitions.js');
const {
  verifyLauncherCaps, requestVlNewSession, consumeVlNewSession, vlNewSessionStatus,
} = require('../lib/fleet/vl-session.js');
const { validPayload, main: cellExecMain } = require('../lib/fleet/cell-exec.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

// --- 1. Manifest di capacita statico (verifyLauncherCaps) -------------------

test('verifyLauncherCaps: command non valido o non stringa -> LAUNCHER_PATH_INVALID', () => {
  assert.equal(verifyLauncherCaps(null).code, 'LAUNCHER_PATH_INVALID');
  assert.equal(verifyLauncherCaps('').code, 'LAUNCHER_PATH_INVALID');
  assert.equal(verifyLauncherCaps(123).code, 'LAUNCHER_PATH_INVALID');
});

test('verifyLauncherCaps: manifest assente o directory -> MANIFEST_MISSING / MANIFEST_NOT_REGULAR', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-caps-'));
  try {
    const launcher = path.join(tmp, 'launcher');
    fs.writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // Assente
    const r1 = verifyLauncherCaps(launcher);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'MANIFEST_MISSING');

    // Directory
    fs.mkdirSync(`${launcher}.nc-caps.json`);
    const r2 = verifyLauncherCaps(launcher);
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'MANIFEST_NOT_REGULAR');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('verifyLauncherCaps: manifest JSON non valido o malformato -> MANIFEST_INVALID_JSON / MANIFEST_MALFORMED', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-caps-'));
  try {
    const launcher = path.join(tmp, 'launcher');
    fs.writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    // Non valido JSON
    fs.writeFileSync(`${launcher}.nc-caps.json`, '{ bad json');
    const r1 = verifyLauncherCaps(launcher);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'MANIFEST_INVALID_JSON');

    // Array (non oggetto)
    fs.writeFileSync(`${launcher}.nc-caps.json`, '[]');
    const r2 = verifyLauncherCaps(launcher);
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'MANIFEST_MALFORMED');

    // Non parsabile con sentinella privata
    fs.writeFileSync(`${launcher}.nc-caps.json`, 'S4_PRIVATE_SENTINEL deliberately invalid');
    const r3 = verifyLauncherCaps(launcher);
    assert.equal(r3.ok, false);
    assert.equal(r3.code, 'MANIFEST_INVALID_JSON');
    assert.equal(r3.reason, 'manifest non parsabile');
    assert.ok(!r3.reason.includes('S4_PRIVATE'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('verifyLauncherCaps: campi manifest mancanti o invalidi (version, caps, hash)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-caps-'));
  try {
    const launcher = path.join(tmp, 'launcher');
    const content = '#!/bin/sh\nexit 0\n';
    fs.writeFileSync(launcher, content, { mode: 0o755 });
    const realSha256 = crypto.createHash('sha256').update(content).digest('hex');

    // version mancante
    fs.writeFileSync(`${launcher}.nc-caps.json`, JSON.stringify({ caps: { newSessionEnv: 1 }, launcherSha256: realSha256 }));
    assert.equal(verifyLauncherCaps(launcher).code, 'MANIFEST_VERSION_MISSING');

    // caps non dichiarato o newSessionEnv != 1
    fs.writeFileSync(`${launcher}.nc-caps.json`, JSON.stringify({ version: '1.0', caps: {}, launcherSha256: realSha256 }));
    assert.equal(verifyLauncherCaps(launcher).code, 'CAPS_NOT_DECLARED');
    fs.writeFileSync(`${launcher}.nc-caps.json`, JSON.stringify({ version: '1.0', caps: { newSessionEnv: true }, launcherSha256: realSha256 }));
    assert.equal(verifyLauncherCaps(launcher).code, 'CAPS_NOT_DECLARED');
    fs.writeFileSync(`${launcher}.nc-caps.json`, JSON.stringify({ version: '1.0', caps: { newSessionEnv: 0 }, launcherSha256: realSha256 }));
    assert.equal(verifyLauncherCaps(launcher).code, 'CAPS_NOT_DECLARED');

    // launcherSha256 non 64-hex
    fs.writeFileSync(`${launcher}.nc-caps.json`, JSON.stringify({ version: '1.0', caps: { newSessionEnv: 1 }, launcherSha256: 'abc' }));
    assert.equal(verifyLauncherCaps(launcher).code, 'MANIFEST_HASH_INVALID');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('verifyLauncherCaps: hash mismatch -> HASH_MISMATCH, hash corrispondente -> ok: true', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-caps-'));
  try {
    const launcher = path.join(tmp, 'launcher');
    const content = '#!/bin/sh\nexit 0\n';
    fs.writeFileSync(launcher, content, { mode: 0o755 });
    const realSha256 = crypto.createHash('sha256').update(content).digest('hex');
    const wrongSha256 = '0'.repeat(64);

    // Hash mismatch
    fs.writeFileSync(`${launcher}.nc-caps.json`, JSON.stringify({ version: '1.0', caps: { newSessionEnv: 1 }, launcherSha256: wrongSha256 }));
    const rMismatch = verifyLauncherCaps(launcher);
    assert.equal(rMismatch.ok, false);
    assert.equal(rMismatch.code, 'HASH_MISMATCH');

    // Hash ok
    fs.writeFileSync(`${launcher}.nc-caps.json`, JSON.stringify({ version: '1.0', caps: { newSessionEnv: 1 }, launcherSha256: realSha256 }));
    const rOk = verifyLauncherCaps(launcher);
    assert.equal(rOk.ok, true);
    assert.equal(rOk.manifest.caps.newSessionEnv, 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('verifyLauncherCaps: untrusted writable manifest must be refused (0777)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's4-manifest-'));
  try {
    const command = path.join(root, 'launch');
    fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(`${command}.nc-caps.json`, JSON.stringify({
      version: '1',
      caps: { newSessionEnv: 1 },
      launcherSha256: crypto.createHash('sha256').update(fs.readFileSync(command)).digest('hex'),
    }));
    fs.chmodSync(`${command}.nc-caps.json`, 0o777);
    const result = verifyLauncherCaps(command);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MANIFEST_PERMS_UNSAFE');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verifyLauncherCaps: manifest read is bounded (2 MiB rejected)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's4-bound-'));
  try {
    const command = path.join(root, 'launch');
    fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(`${command}.nc-caps.json`, JSON.stringify({
      version: 'v'.repeat(2 * 1024 * 1024),
      caps: { newSessionEnv: 1 },
      launcherSha256: crypto.createHash('sha256').update(fs.readFileSync(command)).digest('hex'),
    }));
    const result = verifyLauncherCaps(command);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MANIFEST_TOO_LARGE');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verifyLauncherCaps: symlink manifest is rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's4-sym-'));
  try {
    const command = path.join(root, 'launch');
    fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const realManifest = path.join(root, 'real-caps.json');
    fs.writeFileSync(realManifest, JSON.stringify({
      version: '1',
      caps: { newSessionEnv: 1 },
      launcherSha256: crypto.createHash('sha256').update(fs.readFileSync(command)).digest('hex'),
    }));
    fs.symlinkSync(realManifest, `${command}.nc-caps.json`);
    const result = verifyLauncherCaps(command);
    assert.equal(result.ok, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Un FIFO senza writer NON deve parcheggiare il preflight sincrono prima
// della qualifica di regolarita'. Il verificatore gira in un processo figlio
// CON TIMEOUT: se l'open torna a bloccare, il figlio viene terminato e la
// suite resta in piedi — l'asserzione diventa rossa, non appesa.
function childVerify(command, timeoutMs) {
  const cp = require('node:child_process');
  return cp.spawnSync(process.execPath, ['-e',
    `const v = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'fleet', 'vl-session.js'))});`
    + `console.log(JSON.stringify(v.verifyLauncherCaps(${JSON.stringify(command)})));`,
  ], { encoding: 'utf8', timeout: timeoutMs });
}

test('verifyLauncherCaps: manifest FIFO senza writer -> rifiuto immediato, nessun blocco (figlio con timeout)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's4-fifo-'));
  try {
    const command = path.join(root, 'launch');
    fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(require('node:child_process').spawnSync('/usr/bin/mkfifo', [`${command}.nc-caps.json`]).status, 0);
    const r = childVerify(command, 2500);
    assert.equal(r.error, undefined, 'il figlio non deve restare bloccato sull\'open del FIFO');
    assert.equal(r.status, 0, 'il figlio deve uscire da solo con il rifiuto');
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'MANIFEST_NOT_REGULAR');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verifyLauncherCaps: launcher FIFO senza writer -> rifiuto immediato, nessun blocco (figlio con timeout)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's4-fifo2-'));
  try {
    const command = path.join(root, 'launch');
    assert.equal(require('node:child_process').spawnSync('/usr/bin/mkfifo', [command]).status, 0);
    // Manifest regolare e coerente con un launcher che non si potra' mai leggere
    fs.writeFileSync(`${command}.nc-caps.json`, JSON.stringify({
      version: '1',
      caps: { newSessionEnv: 1 },
      launcherSha256: crypto.createHash('sha256').update('x').digest('hex'),
    }), { mode: 0o644 });
    const r = childVerify(command, 2500);
    assert.equal(r.error, undefined, 'il figlio non deve restare bloccato sull\'open del FIFO launcher');
    assert.equal(r.status, 0, 'il figlio deve uscire da solo con il rifiuto');
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'LAUNCHER_NOT_REGULAR');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- 2. validPayload: trasporto e denylist -----------------------------------

test('validPayload: newSessionTransport ammesso solo come launcher-env', () => {
  const base = { command: '/bin/x', args: [], env: {} };
  assert.equal(validPayload({ ...base, newSessionTransport: 'launcher-env' }), true);
  assert.equal(validPayload({ ...base, newSessionTransport: 'other' }), false, 'valore diverso da launcher-env rifiutato');
  assert.equal(validPayload({ ...base, newSessionTransport: true }), false, 'booleano rifiutato');
  assert.equal(validPayload({ ...base, newSessionTransport: 1 }), false, 'numero rifiutato');
  assert.equal(validPayload({ ...base, newSessionTransport: null }), false, 'null rifiutato');
});

test('validPayload: NEXUSCREW_VL_NEW rifiutato nel payload diretto env (denylist)', () => {
  const base = { command: '/bin/x', args: [], env: {} };
  assert.equal(validPayload({ ...base, env: { SAFE: '1' } }), true);
  assert.equal(validPayload({ ...base, env: { NEXUSCREW_VL_NEW: '1' } }), false, 'NEXUSCREW_VL_NEW nel payload diretto rifiutato');
});

// --- 3. cell-exec: applicazione per generazione e baseline ripulito -----------

test('cell-exec: trasporto launcher-env passa NEXUSCREW_VL_NEW=1 SOLO a gen0 e MAI --new in argv', async () => {
  const spawns = [];
  let clock = 1000;
  const seams = {
    now: () => clock,
    monoNow: () => clock,
    sleep: async () => {},
    spawn: (cmd, args, opts) => {
      spawns.push({ cmd, args, env: { ...opts.env } });
      const ee = new EventEmitter();
      ee.kill = () => {};
      queueMicrotask(() => {
        clock += 500; // avanza oltre initialReadyMs
        ee.emit('exit', 0, null);
      });
      return ee;
    },
    receivePayload: async () => ({
      command: '/bin/x',
      args: ['start'],
      env: { BASE: 'ok' },
      newSessionTransport: 'launcher-env',
      vlNewSession: true,
      supervise: { enabled: true, initialReadyMs: 50, restartDelayMs: 50, maxTotalRestarts: 1 },
    }),
  };
  await cellExecMain(['--socket', '/tmp/nc-sock', '--nonce', 'a'.repeat(64)], seams);
  assert.ok(spawns.length >= 2, 'almeno 2 generazioni simulate');

  // Gen 0: NEXUSCREW_VL_NEW = '1' presente, argv pulito (NO --new)
  assert.equal(spawns[0].env.NEXUSCREW_VL_NEW, '1', 'gen0 riceve la variabile');
  assert.deepEqual(spawns[0].args, ['start'], 'gen0 NON riceve --new in argv');

  // Gen 1: NEXUSCREW_VL_NEW ASSENTE, argv pulito
  assert.equal('NEXUSCREW_VL_NEW' in spawns[1].env, false, 'gen1 non eredita la variabile');
  assert.deepEqual(spawns[1].args, ['start'], 'gen1 non riceve --new');
});

test('cell-exec: managed-vl continua con --new a gen0 e MAI NEXUSCREW_VL_NEW in env', async () => {
  const spawns = [];
  let clock = 1000;
  const seams = {
    now: () => clock,
    monoNow: () => clock,
    sleep: async () => {},
    spawn: (cmd, args, opts) => {
      spawns.push({ cmd, args, env: { ...opts.env } });
      const ee = new EventEmitter();
      ee.kill = () => {};
      queueMicrotask(() => {
        clock += 500;
        ee.emit('exit', 0, null);
      });
      return ee;
    },
    receivePayload: async () => ({
      command: '/bin/vl',
      args: ['start'],
      env: { BASE: 'ok' },
      vlNewSession: true, // no newSessionTransport -> managed / default
      supervise: { enabled: true, initialReadyMs: 50, restartDelayMs: 50, maxTotalRestarts: 1 },
    }),
  };
  await cellExecMain(['--socket', '/tmp/nc-sock', '--nonce', 'a'.repeat(64)], seams);
  assert.ok(spawns.length >= 2);

  // Gen 0: --new in argv, nessun env
  assert.deepEqual(spawns[0].args, ['start', '--new'], 'managed gen0 riceve --new');
  assert.equal('NEXUSCREW_VL_NEW' in spawns[0].env, false, 'managed non riceve env');

  // Gen 1: no --new in argv, nessun env
  assert.deepEqual(spawns[1].args, ['start'], 'managed gen1 non riceve --new');
  assert.equal('NEXUSCREW_VL_NEW' in spawns[1].env, false);
});

test('cell-exec: baseline env inquinato viene ripulito', async () => {
  const spawns = [];
  let clock = 1000;
  const seams = {
    now: () => clock,
    monoNow: () => clock,
    sleep: async () => {},
    spawn: (cmd, args, opts) => {
      spawns.push({ cmd, args, env: { ...opts.env } });
      const ee = new EventEmitter();
      ee.kill = () => {};
      queueMicrotask(() => {
        clock += 500;
        ee.emit('exit', 0, null);
      });
      return ee;
    },
    receivePayload: async () => ({
      command: '/bin/x',
      args: ['start'],
      env: { BASE: 'ok', NEXUSCREW_VL_NEW: 'inquinato' },
      supervise: { enabled: false, initialReadyMs: 50 },
    }),
  };
  await cellExecMain(['--socket', '/tmp/nc-sock', '--nonce', 'a'.repeat(64)], seams);
  assert.equal('NEXUSCREW_VL_NEW' in spawns[0].env, false, 'baseline ripulito: start ordinario non eredita la chiave');
});

// --- 4. Integrazione Fleet: ciclo di vita su adattatore dichiarante ----------

function fakeAdapterMondo(t, { caps = { newSessionEnv: 1 }, launcherScript = '#!/bin/sh\nexit 0\n', modifyLauncher, cooldownMs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vlada-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaAdapter');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });

  const launcherBin = path.join(home, '.local', 'bin', 'vl-adapter');
  fs.writeFileSync(launcherBin, launcherScript, { mode: 0o755 });
  fs.chmodSync(launcherBin, 0o755);

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(launcherBin)).digest('hex');
  if (caps) {
    fs.writeFileSync(`${launcherBin}.nc-caps.json`, JSON.stringify({
      version: '1.0.0',
      caps,
      launcherSha256: sha256,
    }), { mode: 0o644 });
  }

  if (typeof modifyLauncher === 'function') {
    modifyLauncher(launcherBin);
  }

  const statoPath = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoPath, '');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const sessionName = 'cloud-CellaAdapter';
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  if (process.argv.includes('new-session')) {
    const { spawnSync: creaSync } = require('node:child_process');
    const rCrea = creaSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpoCrea = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : '');
    if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
    process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  const { spawnSync } = require('node:child_process');
  let n = 0; let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!riga) continue;
      if (riga === 'display-message -p nc-control-open') continue;
      n += 1;
      const r = spawnSync(process.execPath,
        [__filename, '-S', process.argv[3] || 'x'].concat(riga.split(/\\s+/)), { encoding: 'utf8' });
      if ((r.status || 0) === 0) {
        process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stdout || '') + '%end 1 ' + n + ' 1\\n');
      } else {
        process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stderr || '') + '%error 1 ' + n + ' 1\\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}

const STATO = ${JSON.stringify(statoPath)};
const cmd = args[0] || '';
const SESSIONE = ${JSON.stringify(sessionName)};
const vive = () => fs.readFileSync(STATO, 'utf8').split('\\n').filter(Boolean);
if (cmd === 'list-sessions') { for (const n of vive()) process.stdout.write(n + '\\t1\\n'); process.exit(0); }
if (cmd === 'new-session') {
  if (vive().includes(SESSIONE)) { process.stderr.write('duplicate session: ' + SESSIONE + '\\n'); process.exit(1); }
  fs.writeFileSync(STATO, vive().concat([SESSIONE]).join('\\n') + '\\n');
  process.stdout.write('$7\\t@1\\t%9\\n'); process.exit(0);
}
if (cmd === 'display-message') {
  const iF = args.indexOf('-F');
  const fmt = (iF >= 0 ? args[iF + 1] : args[args.length - 1]) || '';
  if (fmt.includes('socket_path')) { process.stdout.write('/tmp/nc-fake/socket\\t4242\\n'); process.exit(0); }
  process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (cmd === 'capture-pane') { process.stdout.write(''); process.exit(0); }
if (cmd === 'kill-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  const mia = bersaglio === SESSIONE || bersaglio === '$7';
  if (mia) fs.writeFileSync(STATO, vive().filter((n) => n !== SESSIONE).map((n) => n + '\\n').join(''));
  process.exit(0);
}
if (cmd === 'has-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  const mia = bersaglio === SESSIONE || bersaglio === '$7';
  process.exit(mia && vive().includes(SESSIONE) ? 0 : 1);
}
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'vl-custom',
      label: 'VL Custom Adapter',
      command: launcherBin,
      args: [],
      promptMode: 'send-keys',
      newSessionEnv: true,
    }],
    cells: [{
      id: 'CellaAdapter',
      tmuxSession: sessionName,
      cwd,
      engine: 'vl-custom',
      boot: false,
    }],
  });

  const tickets = [];
  let clockTime = 1000;
  const launchBroker = {
    issue: async (payload) => {
      tickets.push(payload);
      return { socketPath: path.join(root, 'broker.sock'), nonce: 'a'.repeat(64) };
    },
    revoke: async () => {},
    close: async () => {},
  };

  const cfgBase = {
    home, fleetDefsPath: defsPath, tmuxBin,
    ensureTmuxProtection: async () => {}, launchBroker, platform: 'linux', env: {},
    launchReadyMs: 0,
    now: () => clockTime,
    monotonicNow: () => clockTime,
    vlLaunchCooldownMs: cooldownMs !== undefined ? cooldownMs : 0,
  };
  const markerDir = path.join(home, '.nexuscrew', 'vl-new-session');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  return {
    root, home, launcherBin, defsPath, tickets, cfgBase, markerDir,
    advanceClock: (ms) => { clockTime += ms; },
    fleet: () => createBuiltinFleet(cfgBase),
  };
}

test('adattatore: up normale -> nessun env 1, nessun vlNewSession nel payload', async (t) => {
  const w = fakeAdapterMondo(t);
  const fleet = await w.fleet();
  const res = await fleet.up('CellaAdapter');
  assert.equal(res.ok, true);
  assert.equal(res.vlNewSession, undefined, 'nessuna rotazione richiesta');
  assert.equal(w.tickets.length, 1);
  assert.equal(w.tickets[0].newSessionTransport, 'launcher-env', 'capacita dichiarata presente');
  assert.equal('vlNewSession' in w.tickets[0], false, 'decisione assente (non consumata)');
});

test('adattatore: pending -> up consuma UNA volta, porta vlNewSession e launcher-env nel ticket', async (t) => {
  const w = fakeAdapterMondo(t);
  const fleet = await w.fleet();

  // 1. Richiesta sessione nuova
  const req = await fleet.vlNewSession('CellaAdapter');
  assert.equal(req.state, 'pending');

  // Diagnostic endpoints
  const st = fleet.vlNewSessionState('CellaAdapter');
  assert.equal(st.state, 'pending');
  const flStatus = await fleet.status();
  const cellStatus = flStatus.cells.find((c) => c.cell === 'CellaAdapter');
  assert.ok(cellStatus && cellStatus.newSession);
  assert.equal(cellStatus.newSession.state, 'pending');

  // 2. up() consuma atomicamente
  const res = await fleet.up('CellaAdapter');
  assert.equal(res.ok, true);
  assert.equal(res.vlNewSession, true, 'rotazione applicata');
  assert.equal(w.tickets[0].newSessionTransport, 'launcher-env');
  assert.equal(w.tickets[0].vlNewSession, true, 'decisione inviata al broker');

  // Marcatore spento
  const stAfter = fleet.vlNewSessionState('CellaAdapter');
  assert.equal(stAfter.state, 'consumed');

  // 3. Secondo up() senza nuova richiesta -> non ruota di nuovo
  await fleet.down('CellaAdapter');
  const res2 = await fleet.up('CellaAdapter');
  assert.equal(res2.ok, true);
  assert.equal(res2.vlNewSession, undefined, 'secondo lancio senza rotazione');
  assert.equal('vlNewSession' in w.tickets[1], false);
});

test('counterproof: launcher pathname swapped after verification must execute the pinned bytes', async (t) => {
  const w = fakeAdapterMondo(t);
  const out = path.join(w.root, 'execution.txt');
  const code = (tag) => `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(out)}, ${JSON.stringify(tag)});\n`;
  fs.writeFileSync(w.launcherBin, code('A'), { mode: 0o755 });
  fs.writeFileSync(`${w.launcherBin}.nc-caps.json`, JSON.stringify({
    version: '1',
    caps: { newSessionEnv: 1 },
    launcherSha256: crypto.createHash('sha256').update(fs.readFileSync(w.launcherBin)).digest('hex'),
  }));
  w.cfgBase.launchBroker.issue = async (payload) => {
    w.tickets.push(payload);
    fs.writeFileSync(w.launcherBin, code('B'));
    return { socketPath: path.join(w.root, 'broker.sock'), nonce: 'a'.repeat(64) };
  };
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaAdapter');
  await fleet.up('CellaAdapter');
  const payload = {
    ...w.tickets[0],
    identityChannel: false,
    supervise: { enabled: false, initialReadyMs: 50 },
  };
  delete payload.activity;
  delete payload.control;
  delete payload.lease;
  await cellExecMain(['--socket', '/synthetic', '--nonce', 'a'.repeat(64)], {
    receivePayload: async () => payload,
  });
  const result = fs.readFileSync(out, 'utf8');
  assert.equal(payload.command === w.launcherBin, false, 'payload.command is pinned path, not original launcherBin');
  assert.equal(result, 'A');
});

test('adattatore: launcher swapped between gen0 and gen1 still executes pinned bytes on restart', async (t) => {
  const w = fakeAdapterMondo(t);
  const out = path.join(w.root, 'execution-multigen.txt');
  const code = (tag) => `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(out)}, ${JSON.stringify(tag)});\nif (${JSON.stringify(tag)} === 'A') process.exit(1);\n`;
  fs.writeFileSync(w.launcherBin, code('A'), { mode: 0o755 });
  fs.writeFileSync(`${w.launcherBin}.nc-caps.json`, JSON.stringify({
    version: '1',
    caps: { newSessionEnv: 1 },
    launcherSha256: crypto.createHash('sha256').update(fs.readFileSync(w.launcherBin)).digest('hex'),
  }));
  w.cfgBase.launchBroker.issue = async (payload) => {
    w.tickets.push(payload);
    fs.writeFileSync(w.launcherBin, code('B'));
    return { socketPath: path.join(w.root, 'broker.sock'), nonce: 'a'.repeat(64) };
  };
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaAdapter');
  await fleet.up('CellaAdapter');

  const payload = {
    ...w.tickets[0],
    identityChannel: false,
    supervise: {
      enabled: true,
      initialReadyMs: 10,
      restartDelayMs: 10,
      maxTotalRestarts: 1,
    },
  };
  delete payload.activity;
  delete payload.control;
  delete payload.lease;

  await cellExecMain(['--socket', '/synthetic', '--nonce', 'a'.repeat(64)], {
    receivePayload: async () => payload,
  });

  const result = fs.readFileSync(out, 'utf8');
  assert.equal(result, 'AA', 'both gen0 and gen1 executed pinned bytes A, never swapped B');
});

// --- 4b. Riuso del pin in cache: stessa disciplina del pin nuovo ---------------

function pinPathFor(w, shaHex) {
  return path.join(w.home, '.nexuscrew', 'launcher-pins', 'CellaAdapter', String(shaHex).toLowerCase(), 'launcher');
}

test('pin in cache: cache vuota -> staging di un file regolare 0500 con i byte verificati, ticket sul pin', async (t) => {
  const w = fakeAdapterMondo(t);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(w.launcherBin)).digest('hex');
  const pin = pinPathFor(w, sha);
  assert.equal(fs.existsSync(pin), false, 'cache vuota prima del lancio');
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaAdapter');
  await fleet.up('CellaAdapter');
  const st = fs.lstatSync(pin);
  assert.equal(st.isSymbolicLink(), false, 'il pin non e un symlink');
  assert.equal(st.isFile(), true, 'il pin e un file regolare');
  assert.equal(st.mode & 0o777, 0o500, 'permessi del pin: solo il proprietario legge ed esegue');
  assert.deepEqual(fs.readFileSync(pin), fs.readFileSync(w.launcherBin), 'i byte pinnati sono quelli verificati');
  assert.equal(w.tickets[0].command, pin, 'il ticket porta il pathname del pin');
  const generazioni = fs.readdirSync(path.join(w.home, '.nexuscrew', 'launcher-pins', 'CellaAdapter'));
  assert.deepEqual(generazioni, [sha.toLowerCase()], 'solo la generazione corrente nel namespace');
});

test('pin in cache: riuso valido -> il pin esistente qualificato viene RIUSATO, non riscritto', async (t) => {
  const w = fakeAdapterMondo(t);
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaAdapter');
  await fleet.up('CellaAdapter');
  const pin = pinPathFor(w, crypto.createHash('sha256').update(fs.readFileSync(w.launcherBin)).digest('hex'));
  const before = fs.statSync(pin);
  await fleet.down('CellaAdapter');
  await fleet.vlNewSession('CellaAdapter');
  const res = await fleet.up('CellaAdapter');
  assert.equal(res.ok, true);
  assert.equal(res.vlNewSession, true);
  const after = fs.statSync(pin);
  assert.equal(after.ino, before.ino, 'riuso: stessa inode, il pin non e stato riscritto');
  assert.equal(after.mtimeMs, before.mtimeMs, 'riuso: mtime invariato');
  assert.equal(w.tickets[1].command, pin, 'il secondo ticket punta ancora al pin riusato');
});

test('pin in cache: symlink all\'operativo -> mai eseguito attraverso il link: esegue A, mai B', async (t) => {
  const w = fakeAdapterMondo(t);
  const out = path.join(w.root, 'execution-cached-symlink.txt');
  const code = (tag) => `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(out)}, ${JSON.stringify(tag)});\n`;
  fs.writeFileSync(w.launcherBin, code('A'), { mode: 0o755 });
  fs.writeFileSync(`${w.launcherBin}.nc-caps.json`, JSON.stringify({
    version: '1',
    caps: { newSessionEnv: 1 },
    launcherSha256: crypto.createHash('sha256').update(fs.readFileSync(w.launcherBin)).digest('hex'),
  }));
  const pin = pinPathFor(w, crypto.createHash('sha256').update(fs.readFileSync(w.launcherBin)).digest('hex'));
  fs.mkdirSync(path.dirname(pin), { recursive: true, mode: 0o700 });
  fs.symlinkSync(w.launcherBin, pin);
  w.cfgBase.launchBroker.issue = async (payload) => {
    w.tickets.push(payload);
    fs.writeFileSync(w.launcherBin, code('B'));
    return { socketPath: path.join(w.root, 'broker.sock'), nonce: 'a'.repeat(64) };
  };
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaAdapter');
  await fleet.up('CellaAdapter');
  const payload = {
    ...w.tickets[0],
    identityChannel: false,
    supervise: { enabled: false, initialReadyMs: 50 },
  };
  delete payload.activity;
  delete payload.control;
  delete payload.lease;
  await cellExecMain(['--socket', '/synthetic', '--nonce', 'a'.repeat(64)], {
    receivePayload: async () => payload,
  });
  assert.equal(payload.command, pin, 'il ticket porta il pathname del pin');
  assert.equal(fs.lstatSync(pin).isSymbolicLink(), false, 'dopo il lancio il pin in cache non e piu un symlink');
  assert.equal(fs.readFileSync(out, 'utf8'), 'A', 'eseguiti i byte verificati A, mai B attraverso il link');
});

test('pin in cache: barriera di sostituzione verde anche col ramo di riuso (pin valido preesistente)', async (t) => {
  const w = fakeAdapterMondo(t);
  const out = path.join(w.root, 'execution-cached-reuse.txt');
  const code = (tag) => `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(out)}, ${JSON.stringify(tag)});\n`;
  fs.writeFileSync(w.launcherBin, code('A'), { mode: 0o755 });
  fs.writeFileSync(`${w.launcherBin}.nc-caps.json`, JSON.stringify({
    version: '1',
    caps: { newSessionEnv: 1 },
    launcherSha256: crypto.createHash('sha256').update(fs.readFileSync(w.launcherBin)).digest('hex'),
  }));
  const pin = pinPathFor(w, crypto.createHash('sha256').update(fs.readFileSync(w.launcherBin)).digest('hex'));
  // Pin preesistente VALIDO: stessi byte, regolare, eseguibile -> ramo di riuso
  fs.mkdirSync(path.dirname(pin), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pin, code('A'), { mode: 0o500 });
  w.cfgBase.launchBroker.issue = async (payload) => {
    w.tickets.push(payload);
    fs.writeFileSync(w.launcherBin, code('B'));
    return { socketPath: path.join(w.root, 'broker.sock'), nonce: 'a'.repeat(64) };
  };
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaAdapter');
  await fleet.up('CellaAdapter');
  const payload = {
    ...w.tickets[0],
    identityChannel: false,
    supervise: { enabled: false, initialReadyMs: 50 },
  };
  delete payload.activity;
  delete payload.control;
  delete payload.lease;
  await cellExecMain(['--socket', '/synthetic', '--nonce', 'a'.repeat(64)], {
    receivePayload: async () => payload,
  });
  assert.equal(payload.command, pin, 'il ticket usa il pin riusato, non il pathname operativo');
  assert.equal(fs.readFileSync(out, 'utf8'), 'A', 'il ramo di riuso esegue i byte pinnati A, mai B');
});

test('pin in cache: file regolare non eseguibile (0600) -> rifiuto pre-consumo, 0 ticket, marcatore pending', async (t) => {
  const w = fakeAdapterMondo(t);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(w.launcherBin)).digest('hex');
  const pin = pinPathFor(w, sha);
  fs.mkdirSync(path.dirname(pin), { recursive: true, mode: 0o700 });
  fs.copyFileSync(w.launcherBin, pin);
  fs.chmodSync(pin, 0o600);
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaAdapter');
  let error;
  try { await fleet.up('CellaAdapter'); } catch (e) { error = e; }
  assert.ok(error, 'up() deve rifiutare');
  assert.equal(error.status, 400);
  assert.equal(error.fleetCode, 'LAUNCHER_UNSUPPORTED');
  assert.equal(w.tickets.length, 0, 'zero ticket');
  assert.equal(vlNewSessionStatus({ home: w.home, cellId: 'CellaAdapter' }).state, 'pending', 'marcatore pending');
  assert.equal(fs.statSync(pin).mode & 0o777, 0o600, 'il pin degradato non e stato auto-riparato ne sostituito');
});

test('pin namespace: symlink nella catena privata -> rifiuto senza alcuna scrittura attraverso di esso', async (t) => {
  const w = fakeAdapterMondo(t);
  const pinsDir = path.join(w.home, '.nexuscrew', 'launcher-pins');
  fs.mkdirSync(pinsDir, { recursive: true, mode: 0o700 });
  const alienRoot = path.join(w.root, 'alien-pins');
  fs.mkdirSync(alienRoot, { recursive: true, mode: 0o700 });
  fs.symlinkSync(alienRoot, path.join(pinsDir, 'CellaAdapter'));
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaAdapter');
  await assert.rejects(() => fleet.up('CellaAdapter'), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.fleetCode, 'LAUNCHER_UNSUPPORTED');
    assert.equal(e.fleetPhase, 'preflight');
    return true;
  });
  assert.equal(w.tickets.length, 0);
  assert.equal(vlNewSessionStatus({ home: w.home, cellId: 'CellaAdapter' }).state, 'pending');
  assert.deepEqual(fs.readdirSync(alienRoot), [], 'nessuna scrittura oltre il symlink');
  assert.equal(fs.lstatSync(path.join(pinsDir, 'CellaAdapter')).isSymbolicLink(), true, 'il symlink non e stato toccato');
});

test('adattatore: fallimento pinning preflight -> 400 LAUNCHER_UNSUPPORTED, marcatore resta pending, 0 ticket', async (t) => {
  const w = fakeAdapterMondo(t);
  const pinsDir = path.join(w.home, '.nexuscrew', 'launcher-pins');
  fs.mkdirSync(pinsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(pinsDir, 'CellaAdapter'), 'blocking file');

  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaAdapter');

  await assert.rejects(() => fleet.up('CellaAdapter'), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.fleetCode, 'LAUNCHER_UNSUPPORTED');
    assert.equal(e.fleetPhase, 'preflight');
    return true;
  });

  const st = fleet.vlNewSessionState('CellaAdapter');
  assert.equal(st.state, 'pending');
  assert.equal(w.tickets.length, 0);
});

test('adattatore: manifest mancante -> 400 LAUNCHER_UNSUPPORTED, marcatore resta pending, 0 ticket', async (t) => {
  const w = fakeAdapterMondo(t, { caps: null }); // nessun caps.json
  const fleet = await w.fleet();

  // Richiesta
  await fleet.vlNewSession('CellaAdapter');

  // up() rifiutato preflight
  await assert.rejects(() => fleet.up('CellaAdapter'), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.fleetCode, 'LAUNCHER_UNSUPPORTED');
    assert.equal(e.fleetPhase, 'preflight');
    assert.match(e.message, /manifest di capacita assente/);
    return true;
  });

  // Marcatore ANCORA pending, zero ticket emessi
  const st = fleet.vlNewSessionState('CellaAdapter');
  assert.equal(st.state, 'pending', 'marcatore intatto dopo rifiuto preflight');
  assert.equal(w.tickets.length, 0, 'zero ticket emessi');
});

test('adattatore: hash mismatch tra launcher e manifest -> 400 LAUNCHER_UNSUPPORTED, marcatore resta pending', async (t) => {
  const w = fakeAdapterMondo(t, {
    modifyLauncher: (bin) => {
      // Modifica il launcher DOPO che il manifest ha sigillato l'hash precedente
      fs.appendFileSync(bin, '# mutazione post-manifest\n');
    },
  });
  const fleet = await w.fleet();

  await fleet.vlNewSession('CellaAdapter');

  await assert.rejects(() => fleet.up('CellaAdapter'), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.fleetCode, 'LAUNCHER_UNSUPPORTED');
    assert.match(e.message, /non corrisponde/);
    return true;
  });

  const st = fleet.vlNewSessionState('CellaAdapter');
  assert.equal(st.state, 'pending');
  assert.equal(w.tickets.length, 0);
});

test('adattatore: runtime route error must not leak manifest excerpts or launcher pathname', async (t) => {
  const w = fakeAdapterMondo(t, {
    modifyLauncher: (bin) => {
      fs.writeFileSync(`${bin}.nc-caps.json`, 'S4_PRIVATE_SENTINEL deliberately invalid');
    },
  });
  const fleet = await w.fleet();

  await fleet.vlNewSession('CellaAdapter');

  await assert.rejects(() => fleet.up('CellaAdapter'), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.fleetCode, 'LAUNCHER_UNSUPPORTED');
    assert.equal(e.fleetPhase, 'preflight');
    assert.equal(e.message, 'launcher non compatibile con newSessionEnv: manifest non parsabile');
    assert.ok(!e.message.includes('S4_PRIVATE'));
    assert.ok(!e.message.includes(w.launcherBin));
    return true;
  });

  const st = fleet.vlNewSessionState('CellaAdapter');
  assert.equal(st.state, 'pending');
  assert.equal(w.tickets.length, 0);
});

// --- 4c. Eccezioni di I/O del verificatore -> rifiuti chiusi e bounded ---------

// Fault injection deterministica: fs.readSync fallisce con EIO SOLO sul fd
// del manifest sintetico, con un messaggio che porta sentinella E pathname.
// Se una qualunque parte di quel testo attraversa il rifiuto, l'asserzione
// diventa rossa.
function patchReadSyncEioOnManifest(w) {
  const original = fs.readSync;
  fs.readSync = function (fd, ...args) {
    let file;
    try { file = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch (_) {}
    if (file === `${w.launcherBin}.nc-caps.json`) {
      const e = new Error(`S4_PRIVATE_SENTINEL ${w.launcherBin}`);
      e.code = 'EIO';
      throw e;
    }
    return original.call(this, fd, ...args);
  };
  return () => { fs.readSync = original; };
}

test('fault EIO sulla lettura del manifest -> rifiuto preflight chiuso: mai sentinella né pathname (metodo)', async (t) => {
  const w = fakeAdapterMondo(t);
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaAdapter');
  const restore = patchReadSyncEioOnManifest(w);
  let error;
  try {
    await fleet.up('CellaAdapter');
  } catch (e) { error = e; } finally { restore(); }
  assert.ok(error, 'up() deve rifiutare');
  assert.equal(error.status, 400);
  assert.equal(error.fleetCode, 'LAUNCHER_UNSUPPORTED');
  assert.equal(error.fleetPhase, 'preflight');
  assert.ok(!error.message.includes('S4_PRIVATE_SENTINEL'), 'niente sentinella nel messaggio');
  assert.ok(!error.message.includes(w.launcherBin), 'niente pathname del launcher nel messaggio');
  assert.ok(!error.message.includes(w.home), 'niente pathname della home nel messaggio');
  assert.equal(w.tickets.length, 0, 'zero ticket');
  assert.equal(vlNewSessionStatus({ home: w.home, cellId: 'CellaAdapter' }).state, 'pending', 'marcatore pending');
});

test('fault EIO sulla lettura del manifest -> route vera POST /api/fleet/up: body chiuso, senza sentinella né pathname', async (t) => {
  const w = fakeAdapterMondo(t);
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaAdapter');
  const app = require('express')();
  app.use('/api/fleet', require('../lib/fleet/routes.js').fleetRoutes(Promise.resolve(fleet)));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const restore = patchReadSyncEioOnManifest(w);
  let status;
  let body;
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/fleet/up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cell: 'CellaAdapter' }),
      signal: AbortSignal.timeout(3000),
    });
    status = r.status;
    body = await r.json();
  } finally {
    restore();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  assert.equal(status, 400);
  assert.equal(body.code, 'LAUNCHER_UNSUPPORTED', 'codice strutturato chiuso nel body');
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('S4_PRIVATE_SENTINEL'), 'niente sentinella nel body HTTP');
  assert.ok(!serialized.includes(w.launcherBin), 'niente pathname del launcher nel body HTTP');
  assert.ok(!serialized.includes(w.home), 'niente pathname della home nel body HTTP');
  assert.equal(w.tickets.length, 0, 'zero ticket');
  assert.equal(vlNewSessionStatus({ home: w.home, cellId: 'CellaAdapter' }).state, 'pending', 'marcatore pending');
});

test('adattatore: fallimento validateCommandTrust prima del consumo -> marcatore resta pending', async (t) => {
  const w = fakeAdapterMondo(t, {
    modifyLauncher: (bin) => {
      // Rende il launcher world-writable: fa fallire validateCommandTrust
      fs.chmodSync(bin, 0o777);
    },
  });
  const fleet = await w.fleet();

  await fleet.vlNewSession('CellaAdapter');

  await assert.rejects(() => fleet.up('CellaAdapter'), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.fleetCode, 'COMMAND_UNTRUSTED');
    return true;
  });

  const st = fleet.vlNewSessionState('CellaAdapter');
  assert.equal(st.state, 'pending', 'fallimento trust -> marcatore resta pending');
  assert.equal(w.tickets.length, 0);
});

test('adattatore: fallimento resolveCwd prima del consumo -> marcatore resta pending', async (t) => {
  const w = fakeAdapterMondo(t);
  // Mutiamo cwd della cella fuori dalla home
  const defs = loadDefinitions(w.defsPath);
  defs.cells[0].cwd = '/tmp/outside-home-never-resolves';
  atomicWrite(w.defsPath, defs);

  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaAdapter');

  await assert.rejects(() => fleet.up('CellaAdapter'), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.fleetCode, 'CWD_INVALID');
    return true;
  });

  const st = fleet.vlNewSessionState('CellaAdapter');
  assert.equal(st.state, 'pending', 'fallimento cwd -> marcatore resta pending');
  assert.equal(w.tickets.length, 0);
});

test('engine non dichiarante newSessionEnv: vlNewSession 400 e nessun marcatore creato', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vlno-'));
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'sh-plain', command: '/bin/sh', promptMode: 'send-keys' }],
    cells: [{ id: 'CellaPlain', cwd: '/tmp', engine: 'sh-plain' }],
  });
  const fleet = await createBuiltinFleet({
    home: root, fleetDefsPath: defsPath, tmuxBin: '/bin/true',
    ensureTmuxProtection: async () => {}, launchBroker: { issue: async () => {}, revoke: async () => {}, close: async () => {} },
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(() => fleet.vlNewSession('CellaPlain'), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /non usa un engine vl/);
    return true;
  });

  assert.throws(() => fleet.vlNewSessionState('CellaPlain'), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /non usa un engine vl/);
    return true;
  });

  // status non include newSession
  const st = await fleet.status();
  const c = st.cells.find((x) => x.cell === 'CellaPlain');
  assert.equal('newSession' in c, false, 'celle non-vl non espongono newSession in status');
});

test('cooldown vl condiviso: adattatore dichiarante rispetta la pausa minima (429)', async (t) => {
  const w = fakeAdapterMondo(t, { cooldownMs: 10000 });
  const fleet = await w.fleet();

  // Primo up -> ok
  await fleet.up('CellaAdapter');
  await fleet.down('CellaAdapter');

  // Secondo up entro i 10 s -> 429 VL_LAUNCH_COOLDOWN
  w.advanceClock(5000);
  await assert.rejects(() => fleet.up('CellaAdapter'), (e) => {
    assert.equal(e.status, 429);
    assert.equal(e.fleetCode, 'VL_LAUNCH_COOLDOWN');
    return true;
  });

  // Oltre i 10 s -> ok
  w.advanceClock(6000);
  const r2 = await fleet.up('CellaAdapter');
  assert.equal(r2.ok, true);
});

test('mutazione engine tra richiesta e up (rimozione newSessionEnv) -> pending + 400 LAUNCHER_UNSUPPORTED', async (t) => {
  const w = fakeAdapterMondo(t);
  const fleet = await w.fleet();

  // Richiesta di sessione nuova quando l'engine e' dichiarante
  await fleet.vlNewSession('CellaAdapter');
  assert.equal(fleet.vlNewSessionState('CellaAdapter').state, 'pending');

  // Mutazione: l'engine perde newSessionEnv
  const defs = loadDefinitions(w.defsPath);
  delete defs.engines[0].newSessionEnv;
  atomicWrite(w.defsPath, defs);

  // up() rifiuta il lancio con 400 LAUNCHER_UNSUPPORTED
  await assert.rejects(() => fleet.up('CellaAdapter'), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.fleetCode, 'LAUNCHER_UNSUPPORTED');
    assert.equal(e.fleetPhase, 'preflight');
    return true;
  });

  // Marcatore resta pending
  assert.equal(vlNewSessionStatus({ home: w.home, cellId: 'CellaAdapter' }).state, 'pending');
  assert.equal(w.tickets.length, 0);
});

test('due up concorrenti su adattatore con pending -> uno vince e ruota, uno 409 SESSION_DUPLICATE', async (t) => {
  const w = fakeAdapterMondo(t);
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaAdapter');

  const [r1, r2] = await Promise.allSettled([
    fleet.up('CellaAdapter'),
    fleet.up('CellaAdapter'),
  ]);

  const vinto = r1.status === 'fulfilled' ? r1.value : (r2.status === 'fulfilled' ? r2.value : null);
  const perso = r1.status === 'rejected' ? r1.reason : (r2.status === 'rejected' ? r2.reason : null);

  assert.ok(vinto, 'un lancio vince');
  assert.equal(vinto.ok, true);
  assert.equal(vinto.vlNewSession, true, 'il vincitore ha consumato la rotazione');

  assert.ok(perso, 'un lancio viene rifiutato');
  assert.equal(perso.status, 409);
  assert.equal(perso.fleetCode, 'SESSION_DUPLICATE');

  assert.equal(w.tickets.length, 1, 'un solo ticket emesso');
  assert.equal(fleet.vlNewSessionState('CellaAdapter').state, 'consumed');
});

