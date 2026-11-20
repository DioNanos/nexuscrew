'use strict';
// Wiring of the incarnation cleanup to the ordered shutdown of the CLI
// serve process (the real dispatch branch, the owned binding, the census
// fence, the adapter proof and the outcome interpretation).
//
// Every scenario that owns the process authority runs in a FRESH child
// process: the census admission fence, the process owner and the cleanup
// terminal are per process and permanent, so children are the only honest
// stage. Everything runs on throwaway directories and fake tmux worlds:
// never the installed instance, never a signal to a process that is not a
// child of these tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const PERCORSO_HOOK = require.resolve('../lib/cli/vl-node-cleanup-hook.js');
const PERCORSO_CENSUS = require.resolve('../lib/fleet/vl-node-census.js');
const PERCORSO_V = require.resolve('../lib/fleet/vl-node-runtime.js');
const PERCORSO_COMMANDS = require.resolve('../lib/cli/commands.js');
const PERCORSO_SERVER = require.resolve('../lib/server.js');
const PERCORSO_BUILTIN = require.resolve('../lib/fleet/builtin.js');

const shellQ = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function radice(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });
  return root;
}

function figlio(codice, { env = {}, timeout = 60000 } = {}) {
  const r = spawnSync(process.execPath, ['-e', codice], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
  });
  return r;
}

function esitoFiglio(r) {
  assert.equal(r.status, 0, `child failed: ${r.stderr}\n--- stdout:\n${r.stdout}`);
  const riga = r.stdout.trim().split('\n').filter((l) => l.startsWith('WIRE|')).pop();
  assert.ok(riga, `no WIRE| line in child output: ${r.stdout}\n${r.stderr}`);
  return JSON.parse(riga.slice('WIRE|'.length));
}

// ---------------------------------------------------------------------------
// Pure validator of the closed cleanup record.
// ---------------------------------------------------------------------------

test('wiring: the cleanup outcome validator accepts only the closed contract', () => {
  const { validateCleanupOutcome } = require('../lib/cli/vl-node-cleanup-hook.js');
  const conti = (o) => ({
    candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0, ...o,
  });
  const valido = (o) => ({ schema: 1, outcome: 'done', reason: null, counts: conti({}), replayed: false, ...o });
  assert.equal(validateCleanupOutcome(valido({})).valid, true);
  assert.equal(validateCleanupOutcome(valido({
    outcome: 'incomplete', reason: 'residues', counts: conti({ candidates: 4, removed: 2, skipped: 2, residues: 2 }),
  })).valid, true);
  assert.equal(validateCleanupOutcome(valido({
    outcome: 'refused', reason: 'not-quiescent',
  })).valid, true);
  assert.equal(validateCleanupOutcome(valido({
    outcome: 'done', counts: conti({ candidates: 7, removed: 7 }), replayed: true,
  })).valid, true);
  const rifiuti = [
    undefined, null, 'done', 7, [],
    ['missing counts', valido({ outcome: 'done', counts: null })],
    ['symbol key', (() => { const v = valido({}); v[Symbol('x')] = 1; return v; })()],
    ['extra field', valido({ extra: 1 })],
    ['schema 2', valido({ schema: 2 })],
    ['string schema', valido({ schema: '1' })],
    ['unknown outcome', valido({ outcome: 'partial' })],
    ['done with reason', valido({ reason: 'residues' })],
    ['done with residues', valido({ counts: conti({ residues: 1, skipped: 1 }) })],
    ['done with skipped', valido({ counts: conti({ skipped: 1 }) })],
    ['done with unattested durability', valido({ counts: conti({ removed: 1, candidates: 1, durabilityUnattested: 1 }) })],
    ['done with candidates mismatch', valido({ counts: conti({ candidates: 2, removed: 1 }) })],
    ['refused with counts', valido({ outcome: 'refused', reason: 'not-quiescent', counts: conti({ candidates: 1 }) })],
    ['refused bad reason', valido({ outcome: 'refused', reason: 'whatever' })],
    ['refused reason null', valido({ outcome: 'refused', reason: null })],
    ['incomplete bad reason', valido({ outcome: 'incomplete', reason: 'whatever' })],
    ['incomplete reason null', valido({ outcome: 'incomplete', reason: null })],
    ['count over 256', valido({ counts: conti({ candidates: 257, removed: 257 }) })],
    ['negative count', valido({ counts: conti({ removed: -1 }) })],
    ['non-integer count', valido({ counts: conti({ removed: 1.5 }) })],
    ['string count', valido({ counts: conti({ removed: '1' }) })],
    ['skipped differs from residues', valido({
      outcome: 'incomplete', reason: 'residues', counts: conti({ candidates: 4, removed: 1, skipped: 3, residues: 2 }),
    })],
    ['removed beyond candidates', valido({
      outcome: 'incomplete', reason: 'residues', counts: conti({ candidates: 2, removed: 3 }),
    })],
    ['durability beyond removed', valido({
      outcome: 'incomplete', reason: 'residues',
      counts: conti({ candidates: 2, removed: 1, skipped: 1, residues: 1, durabilityUnattested: 2 }),
    })],
    ['replayed string', valido({ replayed: 'false' })],
    ['non-object counts', valido({ outcome: 'done', counts: [0, 0, 0, 0, 0, 0] })],
  ];
  for (const caso of rifiuti) {
    const [nome, valore] = Array.isArray(caso) ? caso : [JSON.stringify(String(caso)), caso];
    assert.equal(validateCleanupOutcome(valore).valid, false, `must refuse: ${nome}`);
  }
});

test('wiring: the outcome validator refuses accessor and class records without reading them', () => {
  const { validateCleanupOutcome } = require('../lib/cli/vl-node-cleanup-hook.js');
  const contiZero = {
    candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
  };
  class RecordoVerde {
    constructor() {
      this.schema = 1;
      this.outcome = 'done';
      this.reason = null;
      this.counts = { ...contiZero };
      this.replayed = false;
    }
  }
  // A class instance with green own fields is not a plain data record.
  assert.equal(validateCleanupOutcome(new RecordoVerde()).valid, false, 'a class record is malformed');
  // An accessor record is malformed WITHOUT any getter being executed.
  let letture = 0;
  const conAccessor = {};
  for (const [nome, valore] of [
    ['schema', 1], ['outcome', 'done'], ['reason', null], ['counts', { ...contiZero }], ['replayed', false],
  ]) {
    Object.defineProperty(conAccessor, nome, {
      enumerable: true,
      configurable: true,
      get() { letture += 1; return valore; },
    });
  }
  assert.equal(validateCleanupOutcome(conAccessor).valid, false, 'an accessor record is malformed');
  assert.equal(letture, 0, 'no accessor may be read to reach the judgement');
  // The counts sub-record is held to the same plain-data rule.
  const countsAccessor = Object.defineProperty(
    { schema: 1, outcome: 'done', reason: null, replayed: false },
    'counts',
    { enumerable: true, configurable: true, get() { letture += 1; return { ...contiZero }; } },
  );
  assert.equal(validateCleanupOutcome(countsAccessor).valid, false, 'an accessor counts record is malformed');
  assert.equal(letture, 0);
  const countsDiClasse = { schema: 1, outcome: 'done', reason: null, replayed: false, counts: new RecordoVerde() };
  assert.equal(validateCleanupOutcome(countsDiClasse).valid, false, 'a class counts record is malformed');
  assert.equal(letture, 0);
  // Plain data records keep passing: an ordinary frozen record and a
  // null-prototype record of own data only.
  assert.equal(validateCleanupOutcome(Object.freeze({
    schema: 1, outcome: 'done', reason: null, counts: Object.freeze({ ...contiZero }), replayed: false,
  })).valid, true);
  const senzaProto = Object.assign(Object.create(null), {
    schema: 1, outcome: 'done', reason: null, counts: Object.assign(Object.create(null), { ...contiZero }), replayed: false,
  });
  assert.equal(validateCleanupOutcome(senzaProto).valid, true, 'a null-prototype data record is plain data');
});

// ---------------------------------------------------------------------------
// Child scenarios through the real CLI dispatch branch.
// ---------------------------------------------------------------------------

// Fake tmux binary, kept free of every '$ {' sequence so it can travel
// through the child sources below without template escaping.
const SCRIPT_TMUX = [
  '#!/bin/sh',
  'if [ "$1" = "-S" ] && [ "$3" = "-C" ]; then',
  '  if [ "$4" = "new-session" ]; then',
  '    outc=$( ( shift 3; "$0" "$@" ) 2>&1 )',
  "    printf '%begin 1 0 1\\n'",
  '    [ -n "$outc" ] && printf \'%s\\n\' "$outc"',
  "    printf '%end 1 0 1\\n'",
  '    exit 0',
  '  fi',
  "  printf '%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n'",
  '  exit 0',
  'fi',
  'if [ "$1" = "-S" ]; then shift 2; fi',
  'cmd="$1"; [ $# -gt 0 ] && shift',
  'case "$cmd" in',
  '  has-session) exit 0 ;;',
  '  list-sessions) exit 0 ;;',
  '  kill-session) exit 0 ;;',
  '  new-session) found_P=0; for a in "$@"; do [ "$a" = "-P" ] && found_P=1; done; [ "$found_P" = "1" ] && printf \'x\\t@1\\t%%42\\n\'; exit 0 ;;',
  '  display-message) last=""; for a in "$@"; do last="$a"; done; case "$last" in *socket_path*) printf \'/tmp/nc-fake/socket\\t4242\\n\'; exit 0 ;; esac; printf \'0\\t\\t%%42\\n\'; exit 0 ;;',
  '  capture-pane) exit 0 ;;',
  '  *) exit 0 ;;',
  'esac',
].join('\n');

// Fake tmux world + fake claim broker: enough for a real builtin fleet with
// a vl cell whose claim runs the real qualified Node runtime path.
const MONDO = `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SCRIPT_TMUX = ${JSON.stringify(SCRIPT_TMUX)};
const PERCORSO_BUILTIN = ${JSON.stringify(PERCORSO_BUILTIN)};
const PERCORSO_DEFS = ${JSON.stringify(path.join(REPO_ROOT, 'lib', 'fleet', 'definitions.js'))};
function mondo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-f-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot, { mode: 0o700 });
  const cwd = path.join(home, 'Dev');
  fs.mkdirSync(cwd, { mode: 0o700 });
  fs.mkdirSync(path.join(home, 'bin'), { mode: 0o700 });
  const command = path.join(home, 'bin', 'myagent');
  fs.writeFileSync(command, '#!/bin/sh\\necho ok\\n', { mode: 0o755 });
  const defsPath = path.join(root, 'fleet.json');
  const { backfillVlEngine } = require(PERCORSO_BUILTIN);
  const { atomicWrite, loadDefinitions } = require(PERCORSO_DEFS);
  const base = {
    schemaVersion: 1,
    engines: [{ id: 'claude', label: 'C', rc: true, command, args: [], env: {}, promptMode: 'flag', promptFlag: '--prompt' }],
    cells: [],
  };
  atomicWrite(defsPath, base);
  const conVl = backfillVlEngine(defsPath, loadDefinitions(defsPath));
  atomicWrite(defsPath, { ...conVl, cells: [...conVl.cells, { id: 'VlCell', tmuxSession: 'work-vl', cwd, engine: 'vl.native', boot: false }] });
  const tmuxBin = path.join(root, 'fake-tmux.sh');
  fs.writeFileSync(tmuxBin, SCRIPT_TMUX, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  return { root, home, filesRoot, defsPath, tmuxBin };
}
function broker() {
  let n = 0;
  return {
    async issue() { n += 1; return { ticket: 'tk-' + n, nonce: 'nonce-' + n, socketPath: '/tmp/fake-broker.sock' }; },
    async revoke() {},
    async close() {},
  };
}
`;

test('wiring: positive end-to-end through the CLI dispatch removes the real registry names', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
${MONDO}
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const { createBuiltinFleet } = require(${JSON.stringify(PERCORSO_BUILTIN)});
const census = require(${JSON.stringify(PERCORSO_CENSUS)});
const v = require(${JSON.stringify(PERCORSO_V)});
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const w = mondo();
const records = [];
const diagnostics = { record: (...a) => records.push(a) };
(async () => {
  const fleet = await createBuiltinFleet({
    home: w.home, filesRoot: w.filesRoot, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin,
    protectSharedTmuxServer: false, ensureTmuxProtection: () => {}, launchBroker: broker(),
    sendKeysReadyMs: 1, identityOwnerInstanceId: "ab".repeat(16),
  });
  // A real vl claim through the censused runtime->roots->V graph: the
  // qualified Node runtime creates and censuses its own real names.
  let up = null;
  try { up = await fleet.up('VlCell'); } catch (e) { up = { ok: false, code: (e && e.fleetCode) || null }; }
  const reg = v.getCreationRegistry();
  const nomi = reg.entries.filter((e) => e.unlinked === false).map((e) => e.path);
  const fakeProc = new EventEmitter();
  const exits = [];
  const r = dispatch(['serve', '--pidfile'], {
    home: w.home, port: 0, panelPort: 0, protectSharedTmuxServer: false, liveBridgeEnabled: false,
    autoUpdate: false, proc: fakeProc, log: () => {},
    exitImpl: (c) => { exits.push(c); },
    fleetP: Promise.resolve(fleet),
    diagnostics,
  });
  await new Promise((res) => { if (r.server.listening) res(); else r.server.once('listening', res); });
  const presente = nomi.map((p) => fs.existsSync(p));
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const so = r.server.shutdownController.state().outcome;
  const regDopo = v.getCreationRegistry();
  const after = nomi.map((p) => fs.existsSync(p));
  const percorsi = nomi.map((p) => [String(p).slice(-90), fs.existsSync(p)]);
  const hook = hookMod.readOwnedHook(r.server.shutdownController);
  const replay = hook ? hook.hook({}) : null;
  const secondo = r.server.shutdownController.closeOrdered({ reason: 'signal' });
  const esito2 = await secondo;
  console.log('WIRE|' + JSON.stringify({
    upCode: up && up.code, nomi: nomi.length, presente: presente.every(Boolean), percorsi,
    dopo: after.every((x) => x === false),
    coordState: coord.state, coordQuiescent: coord.quiescent, coordCodes: coord.outcome.codes,
    pidfileRemoved: coord.pidfileRemoved, pidfileStatus: coord.pidfileStatus, exits,
    serverCleanup: so.cleanup, serverOk: so.ok, serverQuiescent: so.quiescent, serverCodes: so.codes,
    censusAfter: census.snapshot(),
    unlinkedAll: regDopo.entries.length > 0 && regDopo.entries.every((e) => e.unlinked === true),
    moduleDisarmed: v.qualifica({ execPath: process.execPath }).ok === false,
    replayReplayed: replay && replay.replayed, replayOutcome: replay && replay.outcome,
    secondoStesso: JSON.stringify(esito2.cleanup) === JSON.stringify(so.cleanup),
    storeCleanup: records.filter((x) => x[2] === 'SERVER_SHUTDOWN_ORDERED').map((x) => x[4]),
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  // The world's vl cell has no client binary: the up stops at the engine
  // gate AFTER the real claim ran. What matters here is the names.
  assert.equal(esito.upCode, 'ENGINE_UNCONFIGURED', `the real claim path must run: ${JSON.stringify(esito)}`);
  assert.ok(esito.nomi >= 2, `the qualified Node runtime must own real names, got ${esito.nomi}`);
  assert.equal(esito.presente, true, 'the names must exist before the shutdown');
  assert.equal(esito.dopo, true, `the own names must really disappear from disk: ${JSON.stringify(esito)}`);
  assert.equal(esito.serverCleanup.outcome, 'done', JSON.stringify(esito));
  assert.equal(esito.serverCleanup.reason, null);
  assert.ok(esito.serverCleanup.counts.removed >= 2, JSON.stringify(esito.serverCleanup));
  assert.equal(esito.serverCleanup.counts.residues, 0);
  assert.equal(esito.serverOk, true);
  assert.equal(esito.serverQuiescent, true);
  assert.equal(esito.coordState, 'completed');
  assert.equal(esito.coordQuiescent, true);
  assert.equal(esito.pidfileRemoved, true);
  assert.deepEqual(esito.exits, [0]);
  assert.equal(esito.censusAfter.admissionClosed, true);
  assert.equal(esito.censusAfter.producers, 0, 'the attested fleet close must retire the producer');
  assert.equal(esito.unlinkedAll, true, 'every registry entry must be marked removed');
  assert.equal(esito.moduleDisarmed, true, 'the module must be disarmed after the admitted round');
  assert.equal(esito.replayReplayed, true, 'a second hook invocation replays the terminal');
  assert.equal(esito.replayOutcome, 'done');
  assert.equal(esito.secondoStesso, true, 'a second closeOrdered returns the same terminal');
  const store = esito.storeCleanup[0] || {};
  assert.equal(store.cleanupOutcome, 'done');
  assert.equal(store.cleanupReason, null);
  assert.equal(store.cleanupRemoved, esito.serverCleanup.counts.removed);
});

test('wiring: a truly disabled fleet with an empty module concludes done without filesystem', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const census = require(${JSON.stringify(PERCORSO_CENSUS)});
const v = require(${JSON.stringify(PERCORSO_V)});
const w = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-d-'));
const fakeProc = new EventEmitter();
const exits = [];
const records = [];
const r = dispatch(['serve', '--pidfile'], {
  home: w, port: 0, panelPort: 0, fleetEnabled: false, protectSharedTmuxServer: false,
  liveBridgeEnabled: false, autoUpdate: false, proc: fakeProc, log: () => {},
  exitImpl: (c) => { exits.push(c); },
  diagnostics: { record: (...a) => records.push(a) },
});
(async () => {
  await new Promise((res) => { if (r.server.listening) res(); else r.server.once('listening', res); });
  const uid = process.getuid();
  const dirV = path.join(os.tmpdir(), 'nc-vl-node-' + uid);
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const so = r.server.shutdownController.state().outcome;
  console.log('WIRE|' + JSON.stringify({
    coordState: coord.state, coordQuiescent: coord.quiescent,
    pidfileRemoved: coord.pidfileRemoved, exits,
    cleanup: so.cleanup, ok: so.ok, quiescent: so.quiescent, codes: so.codes,
    fleetSummary: so.fleet, census: census.snapshot(),
    dirVExists: fs.existsSync(dirV),
    storeCleanup: records.filter((x) => x[2] === 'SERVER_SHUTDOWN_ORDERED').map((x) => x[4]),
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.cleanup.outcome, 'done', JSON.stringify(esito));
  assert.equal(esito.cleanup.reason, null);
  assert.deepEqual(esito.cleanup.counts, {
    candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
  });
  assert.equal(esito.ok, true);
  assert.equal(esito.quiescent, true);
  assert.equal(esito.fleetSummary.status, 'skipped');
  assert.equal(esito.dirVExists, false, 'done without any filesystem object of the module');
  assert.equal(esito.coordState, 'completed');
  assert.equal(esito.pidfileRemoved, true);
  assert.deepEqual(esito.exits, [0]);
  assert.equal(esito.census.admissionClosed, true);
  const store = esito.storeCleanup[0] || {};
  assert.equal(store.cleanupOutcome, 'done');
});

test('wiring: a second live fleet in the process keeps every own name in place', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
${MONDO}
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const { createBuiltinFleet } = require(${JSON.stringify(PERCORSO_BUILTIN)});
const census = require(${JSON.stringify(PERCORSO_CENSUS)});
const v = require(${JSON.stringify(PERCORSO_V)});
const w = mondo();
(async () => {
  const fl1 = await createBuiltinFleet({
    home: w.home, filesRoot: w.filesRoot, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin,
    protectSharedTmuxServer: false, ensureTmuxProtection: () => {}, launchBroker: broker(), sendKeysReadyMs: 1, identityOwnerInstanceId: "ab".repeat(16),
  });
  let up = null;
  try { up = await fl1.up('VlCell'); } catch (e) { up = { ok: false, code: (e && e.fleetCode) || null }; }
  const nomi = v.getCreationRegistry().entries.filter((e) => e.unlinked === false).map((e) => e.path);
  // A SECOND fleet that never closes: its producer stays censused and alive.
  const fl2 = await createBuiltinFleet({
    home: w.home, filesRoot: w.filesRoot, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin,
    protectSharedTmuxServer: false, ensureTmuxProtection: () => {}, launchBroker: broker(), sendKeysReadyMs: 1, identityOwnerInstanceId: "ab".repeat(16),
  });
  const fakeProc = new EventEmitter();
  const exits = [];
  const r = dispatch(['serve', '--pidfile'], {
    home: w.home, port: 0, panelPort: 0, protectSharedTmuxServer: false, liveBridgeEnabled: false,
    autoUpdate: false, proc: fakeProc, log: () => {}, exitImpl: (c) => { exits.push(c); },
    fleetP: Promise.resolve(fl1),
  });
  await new Promise((res) => { if (r.server.listening) res(); else r.server.once('listening', res); });
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const so = r.server.shutdownController.state().outcome;
  const dopo = nomi.map((p) => fs.existsSync(p));
  const regDopo = v.getCreationRegistry();
  console.log('WIRE|' + JSON.stringify({
    upCode: up && up.code, nomi: nomi.length, dopo: dopo.every(Boolean),
    cleanup: so.cleanup, ok: so.ok, quiescent: so.quiescent, codes: so.codes,
    coordState: coord.state, coordQuiescent: coord.quiescent,
    pidfileStatus: coord.pidfileStatus, pidfileRemoved: coord.pidfileRemoved,
    census: census.snapshot(), exits,
    unlinkedCatturati: regDopo.entries.filter((e) => nomi.includes(e.path)).map((e) => e.unlinked),
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.upCode, 'ENGINE_UNCONFIGURED');
  assert.ok(esito.nomi >= 2);
  assert.equal(esito.cleanup.outcome, 'refused', JSON.stringify(esito));
  assert.equal(esito.cleanup.reason, 'not-quiescent');
  assert.deepEqual(esito.cleanup.counts, {
    candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
  });
  assert.equal(esito.ok, false);
  assert.equal(esito.quiescent, false);
  assert.ok(esito.codes.includes('CLEANUP_REFUSED'));
  assert.equal(esito.dopo, true, 'a live producer must keep every name on disk');
  assert.equal(esito.unlinkedCatturati.length, esito.nomi, 'the captured names must still be censused');
  assert.ok(esito.unlinkedCatturati.every((u) => u === false), 'no captured registry entry may be removed');
  assert.equal(esito.pidfileStatus, 'skipped', 'the pidfile must stay conserved');
  assert.equal(esito.pidfileRemoved, false);
  assert.equal(esito.census.producers, 1, 'the unclosed fleet keeps its producer censused');
});

test('wiring: a claim consumer that errors without closing keeps the cleanup refused', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
${MONDO}
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const { createBuiltinFleet } = require(${JSON.stringify(PERCORSO_BUILTIN)});
const w = mondo();
(async () => {
  const fl = await createBuiltinFleet({
    home: w.home, filesRoot: w.filesRoot, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin,
    protectSharedTmuxServer: false, ensureTmuxProtection: () => {}, launchBroker: broker(), sendKeysReadyMs: 1, identityOwnerInstanceId: "ab".repeat(16),
  });
  // A consumer that only errors, never closes: the tracker keeps it live,
  // the fleet close cannot be green and the cleanup must refuse.
  const ammesso = fl.claimTracker.beginAdmitted();
  const childErr = new EventEmitter();
  childErr.stdin = { write() {}, end() {} };
  childErr.stdout = new EventEmitter();
  childErr.stderr = new EventEmitter();
  childErr.kill = () => {};
  fl.claimTracker.attachChild(ammesso.token, childErr);
  childErr.emit('error', new Error('boom without close'));
  const fakeProc = new EventEmitter();
  const records = [];
  const r = dispatch(['serve', '--pidfile'], {
    home: w.home, port: 0, panelPort: 0, protectSharedTmuxServer: false, liveBridgeEnabled: false,
    autoUpdate: false, proc: fakeProc, log: () => {}, exitImpl: () => {},
    fleetP: Promise.resolve(fl),
    diagnostics: { record: (...a) => records.push(a) },
  });
  await new Promise((res) => { if (r.server.listening) res(); else r.server.once('listening', res); });
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const so = r.server.shutdownController.state().outcome;
  console.log('WIRE|' + JSON.stringify({
    cleanup: so.cleanup, ok: so.ok, quiescent: so.quiescent, codes: so.codes,
    fleetStatus: so.fleet && so.fleet.status, coordQuiescent: coord.quiescent,
    pidfileStatus: coord.pidfileStatus,
    storeCleanup: records.filter((x) => x[2] === 'SERVER_SHUTDOWN_ORDERED').map((x) => x[4]),
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.cleanup.outcome, 'refused', JSON.stringify(esito));
  assert.equal(esito.cleanup.reason, 'not-quiescent');
  assert.equal(esito.ok, false);
  assert.equal(esito.quiescent, false);
  assert.ok(esito.codes.includes('CLEANUP_REFUSED'));
  assert.equal(esito.pidfileStatus, 'skipped');
  // The refused outcome propagates through the bounded store record too.
  const store = esito.storeCleanup[0] || {};
  assert.equal(store.cleanupOutcome, 'refused', JSON.stringify(esito.storeCleanup));
  assert.equal(store.cleanupReason, 'not-quiescent');
});

test('wiring: a fake available:false fleet and a malformed raw never turn into an attested absence', (t) => {
  const root = radice(t);
  const fabbrica = (fleet, extra = '') => `
'use strict';
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const w = (require('node:fs')).mkdtempSync((require('node:path')).join((require('node:os')).tmpdir(), 'nc-wire-x-'));
(async () => {
  const fakeProc = new EventEmitter();
  const r = dispatch(['serve', '--pidfile'], {
    home: w, port: 0, panelPort: 0, protectSharedTmuxServer: false, liveBridgeEnabled: false,
    autoUpdate: false, proc: fakeProc, log: () => {}, exitImpl: () => {},
    fleetP: Promise.resolve(${fleet}),
  });
  await new Promise((res) => { if (r.server.listening) res(); else r.server.once('listening', res); });
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const so = r.server.shutdownController.state().outcome;
  console.log('WIRE|' + JSON.stringify({
    cleanup: so.cleanup, ok: so.ok, quiescent: so.quiescent, codes: so.codes,
    fleetStatus: so.fleet && so.fleet.status, fleetQuiescent: so.fleet && so.fleet.quiescent,
    pidfileStatus: coord.pidfileStatus,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  // 1) A bare available:false fleet object injected from outside: the
  // public summary stays skipped/quiescent, the cleanup refuses.
  const finto = esitoFiglio(figlio(fabbrica('({ available: false, provider: "disabled", isCellSession: () => false, capabilities: () => [] })'), { env: { TMPDIR: root } }));
  assert.equal(finto.fleetStatus, 'skipped', JSON.stringify(finto));
  assert.equal(finto.fleetQuiescent, true);
  assert.equal(finto.cleanup.outcome, 'refused');
  assert.equal(finto.cleanup.reason, 'not-quiescent');
  assert.equal(finto.ok, false);
  assert.ok(finto.codes.includes('CLEANUP_REFUSED'));
  assert.equal(finto.pidfileStatus, 'skipped');
  // 2) A present fleet whose close resolves an incomplete raw (missing
  // disarmed and the claim attestations): the raw form is missing and the
  // cleanup refuses with proof-invalid.
  const grezzo = `
    (function () {
      const chiuso = [];
      return {
        available: true, provider: 'x',
        isCellSession: () => false, capabilities: () => [],
        disarm() {},
        close: async () => { chiuso.push(1); return { ok: true, status: 'completed', quiescent: true }; },
      };
    }())
  `;
  const malformato = esitoFiglio(figlio(fabbrica(grezzo), { env: { TMPDIR: root } }));
  assert.equal(malformato.fleetStatus, 'completed', JSON.stringify(malformato));
  assert.equal(malformato.cleanup.outcome, 'refused');
  assert.equal(malformato.cleanup.reason, 'proof-invalid');
  assert.equal(malformato.pidfileStatus, 'skipped');
});

test('wiring: a raw record mutated after the capture cannot change the original attestation', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const w = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-alias-'));
// A green raw whose disarmed and claims.drainExpired CHANGE value after
// their first read: whoever reads the original object again sees the
// mutated values. The server's private capture reads each field exactly
// once; only an aliased attest could be changed by the late mutation.
let lettureDisarmed = 0;
let lettureDrain = 0;
const claims = { idle: true, timedOut: false, activeCount: 0, attestedActive: 0, unattestedCount: 0 };
Object.defineProperty(claims, 'drainExpired', {
  enumerable: true,
  get() { lettureDrain += 1; return lettureDrain === 1 ? false : true; },
});
const raw = {
  disarmedBeforeWait: true, quiescent: true, timedOut: false, budgetExhausted: false,
  activeOpsRemaining: 0, canCleanupOwnedResources: true, codes: [], claims,
};
Object.defineProperty(raw, 'disarmed', {
  enumerable: true,
  get() { lettureDisarmed += 1; return lettureDisarmed === 1 ? true : false; },
});
(async () => {
  const fakeProc = new EventEmitter();
  const r = dispatch(['serve', '--pidfile'], {
    home: w, port: 0, panelPort: 0, protectSharedTmuxServer: false, liveBridgeEnabled: false,
    autoUpdate: false, proc: fakeProc, log: () => {}, exitImpl: () => {},
    fleetP: Promise.resolve({
      available: true, provider: 'x', isCellSession: () => false, capabilities: () => [],
      disarm() {}, close: async () => raw,
    }),
  });
  await new Promise((res) => { if (r.server.listening) res(); else r.server.once('listening', res); });
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const so = r.server.shutdownController.state().outcome;
  console.log('WIRE|' + JSON.stringify({
    cleanup: so.cleanup, ok: so.ok, quiescent: so.quiescent, codes: so.codes,
    coordQuiescent: coord.quiescent, pidfileStatus: coord.pidfileStatus,
    lettureDisarmed, lettureDrain,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.cleanup.outcome, 'done', JSON.stringify(esito));
  assert.equal(esito.cleanup.reason, null);
  assert.equal(esito.ok, true, 'the mutated original must not change the captured attestation');
  assert.equal(esito.quiescent, true);
  assert.equal(esito.coordQuiescent, true);
  assert.equal(esito.pidfileStatus, 'removed');
  assert.equal(esito.lettureDisarmed, 1, 'the original disarmed must be read exactly once, at the capture');
  assert.equal(esito.lettureDrain, 1, 'the original drainExpired must be read exactly once, at the capture');
});

test('wiring: the owned adapter refuses on attest, freshness and deadline guards without touching the registry', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const v = require(${JSON.stringify(PERCORSO_V)});
const risultati = [];
function prova(nome, attest, ctxExtra) {
  const owner = hookMod.createProcessOwner();
  const hook = hookMod.createCleanupHook(owner);
  const ctx = Object.assign({
    reason: 'signal', deadlineMono: 5000, quiescent: true, timedOut: false,
    codes: [], counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
  }, ctxExtra || {});
  if (attest !== null) ctx.attest = attest;
  const out = hook(ctx);
  risultati.push({ nome, outcome: out.outcome, reason: out.reason });
}
const attestBase = () => ({
  localAdmissionClosed: true,
  localDisarmErrors: 0,
  fleetRaw: { present: false, provenance: 'disabled' },
  updaterQuiescent: true,
  updaterHandoff: false,
  nowMono: () => 100,
  serverFinalized: () => false,
});
prova('no attest', null);
prova('attest not object', 'x');
prova('attest with extra field', Object.assign(attestBase(), { extra: 1 }));
prova('attest with symbol field', (() => { const a = attestBase(); a[Symbol('x')] = 1; return a; })());
prova('attest wrong typed flag', Object.assign(attestBase(), { localAdmissionClosed: 1 }));
prova('attest negative disarm errors', Object.assign(attestBase(), { localDisarmErrors: -1 }));
prova('attest nowMono not function', Object.assign(attestBase(), { nowMono: 100 }));
prova('server finalized not a live probe', Object.assign(attestBase(), { serverFinalized: false }));
prova('server finalized', Object.assign(attestBase(), { serverFinalized: () => true }));
prova('server finalized probe throws', Object.assign(attestBase(), {
  serverFinalized: () => { throw new Error('boom'); },
}));
prova('server finalized probe non-boolean', Object.assign(attestBase(), { serverFinalized: () => undefined }));
prova('deadline not finite', attestBase(), { deadlineMono: Number.NaN });
prova('ctx counts not zero', attestBase(), { counts: { activeOps: 1, activeClaims: 0, forcedConnections: 0, residues: 0 } });
prova('ctx codes non empty', attestBase(), { codes: ['X'] });
prova('ctx quiescent false', attestBase(), { quiescent: false });
prova('updater handoff', Object.assign(attestBase(), { updaterHandoff: true }));
prova('updater not quiescent', Object.assign(attestBase(), { updaterQuiescent: false }));
prova('fleet raw unknown', Object.assign(attestBase(), { fleetRaw: { present: null } }));
prova('fleet raw present but malformed', Object.assign(attestBase(), { fleetRaw: { present: true, raw: { quiescent: true } } }));
prova('fleet raw present negative', Object.assign(attestBase(), { fleetRaw: { present: true, raw: {
  disarmed: false, disarmedBeforeWait: true, quiescent: true, timedOut: false, budgetExhausted: false,
  activeOpsRemaining: 0, canCleanupOwnedResources: true, codes: [],
  claims: { idle: true, timedOut: false, activeCount: 0, attestedActive: 0, unattestedCount: 0, drainExpired: false },
} } }));
const reg = v.getCreationRegistry();
const ancoraArmed = v.qualifica({ execPath: process.execPath });
console.log('WIRE|' + JSON.stringify({ risultati, armed: ancoraArmed.ok, nonce: reg.nonce, voci: reg.entries.length }));
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  const mappa = new Map(esito.risultati.map((x) => [x.nome, x]));
  for (const nome of ['no attest', 'attest not object', 'attest with extra field', 'attest with symbol field',
    'attest wrong typed flag', 'attest negative disarm errors', 'attest nowMono not function',
    'server finalized not a live probe', 'server finalized', 'server finalized probe throws',
    'server finalized probe non-boolean', 'deadline not finite']) {
    assert.equal(mappa.get(nome).outcome, 'refused', `${nome}: ${JSON.stringify(mappa.get(nome))}`);
    assert.equal(mappa.get(nome).reason, 'proof-invalid', nome);
  }
  // The seal never happened in this child: every check past the attest and
  // deadline guards refuses with not-quiescent (the form is complete, the
  // fence requirement is negative), whatever the deeper reason would be.
  for (const nome of ['ctx counts not zero', 'ctx codes non empty', 'ctx quiescent false',
    'updater handoff', 'updater not quiescent', 'fleet raw unknown',
    'fleet raw present but malformed', 'fleet raw present negative']) {
    assert.equal(mappa.get(nome).outcome, 'refused', nome);
    assert.equal(mappa.get(nome).reason, 'not-quiescent', nome);
  }
  assert.equal(esito.armed, true, 'no V disarm may have happened');
  assert.equal(esito.nonce, null, 'no V round may have started');
  assert.equal(esito.voci, 0, 'the registry must stay untouched');
});

test('wiring: a sealed owner whose clock already passed the deadline concludes incomplete without any operation', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const census = require(${JSON.stringify(PERCORSO_CENSUS)});
const v = require(${JSON.stringify(PERCORSO_V)});
const owner = hookMod.createProcessOwner();
const seal = hookMod.sealAdmissionFor(owner);
const hook = hookMod.createCleanupHook(owner);
const out = hook({
  reason: 'signal', deadlineMono: 5000, quiescent: true, timedOut: false, codes: [],
  counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
  attest: {
    localAdmissionClosed: true, localDisarmErrors: 0,
    fleetRaw: { present: false, provenance: 'disabled' },
    updaterQuiescent: true, updaterHandoff: false,
    nowMono: () => 6000, serverFinalized: () => false,
  },
});
const ancoraArmed = v.qualifica({ execPath: process.execPath });
console.log('WIRE|' + JSON.stringify({
  sealOk: seal.ok, outcome: out.outcome, reason: out.reason, counts: out.counts, replayed: out.replayed,
  census: census.snapshot(), armed: ancoraArmed.ok, code: ancoraArmed.code,
}));
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.sealOk, true);
  assert.equal(esito.outcome, 'incomplete');
  assert.equal(esito.reason, 'deadline-exhausted');
  assert.deepEqual(esito.counts, {
    candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
  });
  assert.equal(esito.armed, true, 'the expired entry must not disarm the module: zero operations');
  assert.equal(esito.census.admissionClosed, true);
});

test('wiring: a sealed owner with a malformed fleet raw refuses proof-invalid', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const v = require(${JSON.stringify(PERCORSO_V)});
const owner = hookMod.createProcessOwner();
hookMod.sealAdmissionFor(owner);
const hook = hookMod.createCleanupHook(owner);
const out = hook({
  reason: 'signal', deadlineMono: 5000, quiescent: true, timedOut: false, codes: [],
  counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
  attest: {
    localAdmissionClosed: true, localDisarmErrors: 0,
    fleetRaw: { present: true, raw: { quiescent: true } },
    updaterQuiescent: true, updaterHandoff: false,
    nowMono: () => 100, serverFinalized: () => false,
  },
});
// Capture the registry BEFORE the qualification probe.
const reg = v.getCreationRegistry();
const ancoraArmed = v.qualifica({ execPath: process.execPath });
console.log('WIRE|' + JSON.stringify({
  outcome: out.outcome, reason: out.reason,
  armed: ancoraArmed.ok, voci: reg.entries.length, nonce: reg.nonce,
}));
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.outcome, 'refused');
  assert.equal(esito.reason, 'proof-invalid');
  assert.equal(esito.armed, true, 'a missing raw form must leave V armed');
  assert.equal(esito.voci, 0, 'a missing raw form never starts a round');
  assert.equal(esito.nonce, null);
});

test('wiring: server-first close with the binding installed keeps one deadline, one hook and one terminal', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const w = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-sf-'));
const fakeProc = new EventEmitter();
const exits = [];
const r = dispatch(['serve', '--pidfile'], {
  home: w, port: 0, panelPort: 0, fleetEnabled: false, protectSharedTmuxServer: false,
  liveBridgeEnabled: false, autoUpdate: false, proc: fakeProc, log: () => {},
  exitImpl: (c) => { exits.push(c); },
});
(async () => {
  await new Promise((res) => { if (r.server.listening) res(); else r.server.once('listening', res); });
  const binding = hookMod.readOwnedHook(r.server.shutdownController);
  const serverClosedP = new Promise((res) => r.server.once('close', res));
  r.server.close();
  await serverClosedP;
  const serverDl = r.server.shutdownController.state().deadlineMono;
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const so = r.server.shutdownController.state().outcome;
  const replay = binding ? binding.hook({ deadlineMono: 1e9, attest: null, quiescent: false }) : null;
  console.log('WIRE|' + JSON.stringify({
    bindingBeforeClose: Boolean(binding),
    coordDlEqualsServerDl: coord.deadlineMono === serverDl,
    coordReason: coord.outcome.reason, coordState: coord.state, coordQuiescent: coord.quiescent,
    pidfileRemoved: coord.pidfileRemoved, exits,
    cleanup: so.cleanup, codes: so.codes,
    replayReplayed: replay && replay.replayed, replayOutcome: replay && replay.outcome,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.bindingBeforeClose, true, 'the binding must be installed before any closeOrdered');
  assert.equal(esito.coordDlEqualsServerDl, true, 'the first deadline must be preserved');
  assert.equal(esito.coordReason, 'server-close');
  assert.equal(esito.coordState, 'completed');
  assert.equal(esito.coordQuiescent, true);
  assert.equal(esito.cleanup.outcome, 'done');
  assert.equal(esito.pidfileRemoved, true);
  assert.deepEqual(esito.exits, [0]);
  assert.equal(esito.replayReplayed, true, 'the second hook invocation replays the one terminal');
  assert.equal(esito.replayOutcome, 'done');
});

test('wiring: a different explicit hook colliding with the owned binding is a conservative malformed', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const w = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-coll-'));
const fakeProc = new EventEmitter();
const r = dispatch(['serve', '--pidfile'], {
  home: w, port: 0, panelPort: 0, fleetEnabled: false, protectSharedTmuxServer: false,
  liveBridgeEnabled: false, autoUpdate: false, proc: fakeProc, log: () => {}, exitImpl: () => {},
});
(async () => {
  await new Promise((res) => { if (r.server.listening) res(); else r.server.once('listening', res); });
  // A different hook parameter on the close of an owned server: collision,
  // zero cleanup, conservative malformed result.
  const out = await r.server.shutdownController.closeOrdered({
    reason: 'programmatic',
    afterDrainHook: async () => ({ schema: 1, outcome: 'done', reason: null, counts: { candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0 }, replayed: false }),
  });
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  console.log('WIRE|' + JSON.stringify({
    ok: out.ok, quiescent: out.quiescent, codes: out.codes, cleanup: out.cleanup,
    coordQuiescent: coord.quiescent, pidfileStatus: coord.pidfileStatus, pidfileRemoved: coord.pidfileRemoved,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.ok, false, JSON.stringify(esito));
  assert.equal(esito.quiescent, false);
  assert.ok(esito.codes.includes('CLEANUP_MALFORMED'));
  assert.equal(esito.cleanup, null, 'a collided cleanup is never a validated result');
  assert.equal(esito.coordQuiescent, false);
  assert.equal(esito.pidfileStatus, 'skipped');
  assert.equal(esito.pidfileRemoved, false);
});

test('wiring: a substituted own name makes the cleanup incomplete and the shutdown conservative', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
${MONDO}
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const { createBuiltinFleet } = require(${JSON.stringify(PERCORSO_BUILTIN)});
const v = require(${JSON.stringify(PERCORSO_V)});
const w = mondo();
(async () => {
  const fleet = await createBuiltinFleet({
    home: w.home, filesRoot: w.filesRoot, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin,
    protectSharedTmuxServer: false, ensureTmuxProtection: () => {}, launchBroker: broker(), sendKeysReadyMs: 1,
    identityOwnerInstanceId: "ab".repeat(16),
  });
  try { await fleet.up('VlCell'); } catch (e) { /* engine gate: the claim already ran */ }
  const reg = v.getCreationRegistry();
  const finale = reg.entries.find((e) => e.kind === 'home-final' && e.unlinked === false);
  const nomi = reg.entries.filter((e) => e.unlinked === false).map((e) => e.path);
  // A foreign object under an own name: the re-verification refuses the
  // removal and the round concludes incomplete with real residues.
  try { fs.unlinkSync(finale.path); } catch (_) {}
  fs.writeFileSync(finale.path, 'foreign bytes');
  const fakeProc = new EventEmitter();
  const r = dispatch(['serve', '--pidfile'], {
    home: w.home, port: 0, panelPort: 0, protectSharedTmuxServer: false, liveBridgeEnabled: false,
    autoUpdate: false, proc: fakeProc, log: () => {}, exitImpl: () => {},
    fleetP: Promise.resolve(fleet),
  });
  await new Promise((res) => { if (r.server.listening) res(); else r.server.once('listening', res); });
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const so = r.server.shutdownController.state().outcome;
  const sostituito = fs.existsSync(finale.path);
  const regDopo = v.getCreationRegistry();
  const nonRimossi = regDopo.entries.filter((e) => nomi.includes(e.path) && e.unlinked === false).length;
  console.log('WIRE|' + JSON.stringify({
    nomi: nomi.length, sostituito,
    cleanup: so.cleanup, ok: so.ok, quiescent: so.quiescent, codes: so.codes,
    coordQuiescent: coord.quiescent, pidfileStatus: coord.pidfileStatus, pidfileRemoved: coord.pidfileRemoved,
    nonRimossi,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.ok(esito.nomi >= 2);
  assert.equal(esito.cleanup.outcome, 'incomplete', JSON.stringify(esito));
  assert.equal(esito.cleanup.reason, 'residues');
  assert.ok(esito.cleanup.counts.residues >= 1, JSON.stringify(esito.cleanup));
  assert.equal(esito.ok, false, 'an incomplete cleanup must worsen ok');
  assert.equal(esito.quiescent, false, 'an incomplete cleanup must worsen quiescence');
  assert.ok(esito.codes.includes('CLEANUP_INCOMPLETE'));
  assert.equal(esito.pidfileStatus, 'skipped', 'the pidfile must stay conserved');
  assert.equal(esito.pidfileRemoved, false);
  assert.equal(esito.sostituito, true, 'the substituted object must be preserved');
  assert.ok(esito.nonRimossi >= 1, 'the refusing name must stay censused as not removed');
});

test('wiring: a programmatic server without owner never closes the census and never runs a cleanup', async (t) => {
  const { createServer } = require('../lib/server.js');
  const census = require('../lib/fleet/vl-node-census.js');
  const root = radice(t);
  const visti = [];
  const { server, closeOrdered } = createServer({
    port: 0,
    panelPort: 0,
    fleetEnabled: false,
    protectSharedTmuxServer: false,
    liveBridgeEnabled: false,
    autoUpdate: false,
    nowMono: () => 1000,
    home: root,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => { try { server.close(); } catch (_) {} });
  const esito = await closeOrdered({
    reason: 'programmatic',
    afterDrainHook: (ctx) => {
      visti.push(Object.keys(ctx).sort().join(','));
    },
  });
  await new Promise((resolve) => { try { server.close(resolve); } catch (_) { resolve(); } });
  assert.equal(esito.ok, true);
  assert.equal(esito.quiescent, true);
  assert.equal(esito.cleanup, null, 'the legacy programmatic hook gets no cleanup result');
  assert.equal(census.snapshot().admissionClosed, false, 'no owner: the census is never sealed');
  assert.equal(visti.length, 1);
  assert.equal(
    visti[0],
    'codes,counts,deadlineMono,fleet,quiescent,reason,timedOut',
    'the legacy context must gain no attest capability',
  );
});

test('wiring: an owned shutdown over a handle with an invalid controller is conservative', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const v = require(${JSON.stringify(PERCORSO_V)});
const w = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-ci-'));
const fakeProc = new EventEmitter();
// Present but invalid: a controller with no closeOrdered identity at all
// can never receive the owned binding.
const controller = {};
const r = dispatch(['serve', '--pidfile'], {
  home: w, fleetEnabled: false, proc: fakeProc, log: () => {}, exitImpl: () => {},
  serverStart: () => ({
    disarm() {},
    async closeOrdered() {
      return {
        ok: true, quiescent: true, timedOut: false,
        counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
        codes: [],
      };
    },
    shutdownController: controller,
  }),
});
(async () => {
  const binding = hookMod.readOwnedHook(controller);
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const reg = v.getCreationRegistry();
  const ancoraArmed = v.qualifica({ execPath: process.execPath });
  console.log('WIRE|' + JSON.stringify({
    bindingNull: binding === null,
    coordQuiescent: coord.quiescent,
    coordCodes: coord.outcome.codes,
    pidfileStatus: coord.pidfileStatus,
    pidfileExists: fs.existsSync(path.join(w, '.nexuscrew', 'nexuscrew.pid')),
    armed: ancoraArmed.ok,
    regEntries: reg.entries.length,
    regNonce: reg.nonce,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.bindingNull, true, 'the invalid controller must never receive a binding');
  assert.equal(esito.coordQuiescent, false, JSON.stringify(esito));
  assert.ok(esito.coordCodes.includes('CLEANUP_REFUSED'), `codes must carry CLEANUP_REFUSED: ${JSON.stringify(esito.coordCodes)}`);
  assert.equal(esito.pidfileStatus, 'skipped');
  assert.equal(esito.pidfileExists, true, 'the pidfile must stay conserved');
  assert.equal(esito.armed, true, 'no V disarm may happen: no cleanup round may start');
  assert.equal(esito.regEntries, 0, 'no cleanup round may start');
  assert.equal(esito.regNonce, null);
});

test('wiring: an owned binding the server ignores never yields a quiescent shutdown', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const v = require(${JSON.stringify(PERCORSO_V)});
const w = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-ig-'));
const fakeProc = new EventEmitter();
// The controller formally accepts the binding (real closeOrdered identity)
// but its result ignores the bound hook and returns the old green shape
// with no cleanup attestation.
const controller = {
  disarm() {},
  state: () => ({ disarmed: false, closing: false, closed: false }),
  onCloseStart: () => () => {},
  async closeOrdered() {
    return {
      ok: true, quiescent: true, timedOut: false,
      counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
      codes: [],
    };
  },
};
const r = dispatch(['serve', '--pidfile'], {
  home: w, fleetEnabled: false, proc: fakeProc, log: () => {}, exitImpl: () => {},
  serverStart: () => ({
    shutdownController: controller,
    disarm: controller.disarm,
    closeOrdered: controller.closeOrdered,
  }),
});
(async () => {
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const binding = hookMod.readOwnedHook(controller);
  const reg = v.getCreationRegistry();
  const ancoraArmed = v.qualifica({ execPath: process.execPath });
  console.log('WIRE|' + JSON.stringify({
    bindingInstalled: binding !== null,
    coordQuiescent: coord.quiescent,
    coordCodes: coord.outcome.codes,
    pidfileStatus: coord.pidfileStatus,
    pidfileExists: fs.existsSync(path.join(w, '.nexuscrew', 'nexuscrew.pid')),
    armed: ancoraArmed.ok,
    regEntries: reg.entries.length,
    regNonce: reg.nonce,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.bindingInstalled, true, 'the binding itself succeeds: the refusal comes from the unattested result');
  assert.equal(esito.coordQuiescent, false, JSON.stringify(esito));
  assert.ok(esito.coordCodes.includes('CLEANUP_REFUSED'), `codes must carry CLEANUP_REFUSED: ${JSON.stringify(esito.coordCodes)}`);
  assert.equal(esito.pidfileStatus, 'skipped');
  assert.equal(esito.pidfileExists, true, 'the pidfile must stay conserved');
  assert.equal(esito.armed, true, 'the ignored hook never disarms V or starts a round');
  assert.equal(esito.regEntries, 0, 'the ignored hook never starts a round');
  assert.equal(esito.regNonce, null);
});

test('wiring: a refused seal is a conservative failure of the coordinator even against a green attested-looking result', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const census = require(${JSON.stringify(PERCORSO_CENSUS)});
const v = require(${JSON.stringify(PERCORSO_V)});
const w = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-sr-'));
// The admission fence is already closed by ANOTHER owner: the CLI
// coordinator's own seal at disarm must refuse, and its judgement must not
// lean on a server result that merely LOOKS attested.
const altro = hookMod.createProcessOwner();
const seal = hookMod.sealAdmissionFor(altro);
const fakeProc = new EventEmitter();
const controller = {
  disarm() {},
  state: () => ({ disarmed: false, closing: false, closed: false }),
  onCloseStart: () => () => {},
  async closeOrdered() {
    return {
      ok: true, quiescent: true, timedOut: false,
      counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
      codes: [],
      // A hand-made done field is not an attestation this coordinator may
      // trust when its own seal failed.
      cleanup: {
        outcome: 'done', reason: null,
        counts: { candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0 },
      },
    };
  },
};
const r = dispatch(['serve', '--pidfile'], {
  home: w, fleetEnabled: false, proc: fakeProc, log: () => {}, exitImpl: () => {},
  serverStart: () => ({
    shutdownController: controller,
    disarm: controller.disarm,
    closeOrdered: controller.closeOrdered,
  }),
});
(async () => {
  const censusClosedBefore = census.snapshot().admissionClosed;
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const reg = v.getCreationRegistry();
  const ancoraArmed = v.qualifica({ execPath: process.execPath });
  console.log('WIRE|' + JSON.stringify({
    otherSealOk: seal.ok,
    censusClosedBefore,
    coordQuiescent: coord.quiescent,
    coordCodes: coord.outcome.codes,
    pidfileStatus: coord.pidfileStatus,
    pidfileExists: fs.existsSync(path.join(w, '.nexuscrew', 'nexuscrew.pid')),
    armed: ancoraArmed.ok,
    regEntries: reg.entries.length,
    regNonce: reg.nonce,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.otherSealOk, true);
  assert.equal(esito.censusClosedBefore, true, 'the fence must already be closed by the other owner');
  assert.equal(esito.coordQuiescent, false, 'a failed seal can never be quiescent, whatever the server says');
  assert.ok(esito.coordCodes.includes('CLEANUP_REFUSED'), `codes must carry CLEANUP_REFUSED: ${JSON.stringify(esito.coordCodes)}`);
  assert.equal(esito.pidfileStatus, 'skipped');
  assert.equal(esito.pidfileExists, true, 'the pidfile must stay conserved');
  assert.equal(esito.armed, true, 'no V disarm may happen when the seal is refused');
  assert.equal(esito.regEntries, 0);
  assert.equal(esito.regNonce, null);
});

test('wiring: a callback delayed past the server finalization refuses without any new operation', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const census = require(${JSON.stringify(PERCORSO_CENSUS)});
const v = require(${JSON.stringify(PERCORSO_V)});
const owner = hookMod.createProcessOwner();
hookMod.sealAdmissionFor(owner);
const hook = hookMod.createCleanupHook(owner);
// The context is built while the server has NOT finalized its own result;
// the state flips to finalized BEFORE the callback actually runs, while the
// clock stays far before the deadline. The live verification read at the
// entry must catch exactly this race; a boolean photographed earlier
// could not.
let serverFinalizzato = false;
const ctx = {
  reason: 'signal', deadlineMono: 5000, quiescent: true, timedOut: false, codes: [],
  counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
  attest: {
    localAdmissionClosed: true, localDisarmErrors: 0,
    fleetRaw: { present: false, provenance: 'disabled' },
    updaterQuiescent: true, updaterHandoff: false,
    nowMono: () => 100,
    serverFinalized: () => serverFinalizzato,
  },
};
serverFinalizzato = true;
const out = hook(ctx);
// Read the registry BEFORE the qualification probe: a qualification round
// creates its own entries.
const reg = v.getCreationRegistry();
const ancoraArmed = v.qualifica({ execPath: process.execPath });
console.log('WIRE|' + JSON.stringify({
  outcome: out.outcome, reason: out.reason,
  armed: ancoraArmed.ok, voci: reg.entries.length, nonce: reg.nonce,
  census: census.snapshot(),
}));
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.outcome, 'refused');
  assert.equal(esito.reason, 'proof-invalid', 'an entry past the server finalization is proof-invalid');
  assert.equal(esito.armed, true, 'no V disarm may happen: zero operations');
  assert.equal(esito.voci, 0, 'the registry must stay untouched');
  assert.equal(esito.nonce, null);
  assert.equal(esito.census.admissionClosed, true);
});

test('wiring: a callback that runs after the coordinator finalized refuses without a new round', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const v = require(${JSON.stringify(PERCORSO_V)});
const w = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-cf-'));
const fakeProc = new EventEmitter();
const controller = {
  disarm() {},
  state: () => ({ disarmed: false, closing: false, closed: false }),
  onCloseStart: () => () => {},
  // Never settles: the coordinator terminates through its own timeout path
  // while the synthetic clock of the delayed callback stays before D.
  async closeOrdered() { await new Promise(() => {}); },
};
const r = dispatch(['serve', '--pidfile'], {
  home: w, fleetEnabled: false, shutdownBudgetMs: 120, proc: fakeProc, log: () => {},
  exitImpl: () => {},
  serverStart: () => ({
    shutdownController: controller, disarm: controller.disarm, closeOrdered: controller.closeOrdered,
  }),
});
(async () => {
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 400 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const binding = hookMod.readOwnedHook(controller);
  // The delayed entry: every precondition green, the live server probe
  // still false and the clock still far before the original deadline.
  const out = binding ? binding.hook({
    reason: 'signal', deadlineMono: 5000, quiescent: true, timedOut: false, codes: [],
    counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
    attest: {
      localAdmissionClosed: true, localDisarmErrors: 0,
      fleetRaw: { present: false, provenance: 'disabled' },
      updaterQuiescent: true, updaterHandoff: false,
      nowMono: () => 100, serverFinalized: () => false,
    },
  }) : null;
  // Read the registry BEFORE the qualification probe: a qualification
  // round creates its own entries.
  const reg = v.getCreationRegistry();
  const ancoraArmed = v.qualifica({ execPath: process.execPath });
  console.log('WIRE|' + JSON.stringify({
    coordCompleted: coord.completed, coordQuiescent: coord.quiescent,
    coordCodes: coord.outcome.codes,
    bindingInstalled: binding !== null,
    outcome: out && out.outcome, reason: out && out.reason,
    armed: ancoraArmed.ok, voci: reg.entries.length, nonce: reg.nonce,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.coordCompleted, true, 'the coordinator must have finalized through its timeout path');
  assert.equal(esito.coordQuiescent, false);
  assert.ok(esito.coordCodes.includes('SERVER_CLOSE_TIMEOUT'), JSON.stringify(esito.coordCodes));
  assert.equal(esito.bindingInstalled, true);
  assert.equal(esito.armed, true, 'no V disarm may happen after the finalization');
  assert.equal(esito.voci, 0, 'no new round may start after the finalization');
  assert.equal(esito.nonce, null);
  assert.equal(esito.outcome, 'refused', JSON.stringify(esito));
  assert.equal(esito.reason, 'proof-invalid', 'an entry past the coordinator finalization is proof-invalid');
});

test('wiring: a re-entrant warning callback observing completed=true before finalOutcome delivery refuses without a new round', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const v = require(${JSON.stringify(PERCORSO_V)});
const w = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-warn-re-'));
const fakeProc = new EventEmitter();
const sharedNowMono = () => 100;
const controller = {
  disarm() {},
  state: () => ({ disarmed: false, closing: false, closed: false }),
  onCloseStart: () => () => {},
  async closeOrdered() { await new Promise(() => {}); },
};
let warns = 0;
let hookResult = null;
let completedInWarn = null;
let stateInWarn = null;
let outcomeNullInWarn = null;
let clockBeforeDeadlineInWarn = null;
let bindingInstalled = false;
const exits = [];
const r = dispatch(['serve', '--pidfile'], {
  home: w,
  fleetEnabled: false,
  shutdownBudgetMs: 120,
  nowMono: sharedNowMono,
  proc: fakeProc,
  log: () => {},
  exitImpl: (code) => { exits.push(code); },
  writeShutdownLine: () => {
    warns += 1;
    const st = r.controller.getState();
    completedInWarn = st.completed;
    stateInWarn = st.state;
    outcomeNullInWarn = st.outcome === null;
    clockBeforeDeadlineInWarn = sharedNowMono() < st.deadlineMono;
    const binding = hookMod.readOwnedHook(controller);
    bindingInstalled = binding !== null;
    // First ever entry of the hook, synchronously inside writeLine while
    // completed is already observable and the shared clock is still < D.
    if (binding && hookResult === null) {
      hookResult = binding.hook({
        reason: 'signal',
        deadlineMono: st.deadlineMono,
        quiescent: true,
        timedOut: false,
        codes: [],
        counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
        attest: {
          localAdmissionClosed: true,
          localDisarmErrors: 0,
          fleetRaw: { present: false, provenance: 'disabled' },
          updaterQuiescent: true,
          updaterHandoff: false,
          nowMono: sharedNowMono,
          serverFinalized: () => false,
        },
      });
    }
    // A re-entrant shutdown call must not trigger a second finalization.
    void r.controller.shutdown({ reason: 'signal', exitOnFinish: true });
  },
  serverStart: () => ({
    shutdownController: controller,
    disarm: controller.disarm,
    closeOrdered: controller.closeOrdered,
  }),
});
(async () => {
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 400 && exits.length === 0; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  // Capture the registry BEFORE the qualification probe.
  const reg = v.getCreationRegistry();
  const ancoraArmed = v.qualifica({ execPath: process.execPath });
  console.log('WIRE|' + JSON.stringify({
    coordCompleted: coord.completed,
    coordQuiescent: coord.quiescent,
    coordCodes: coord.outcome ? coord.outcome.codes : null,
    completedInWarn,
    stateInWarn,
    outcomeNullInWarn,
    clockBeforeDeadlineInWarn,
    bindingInstalled,
    outcome: hookResult && hookResult.outcome,
    reason: hookResult && hookResult.reason,
    armed: ancoraArmed.ok,
    voci: reg.entries.length,
    nonce: reg.nonce,
    warns,
    exits,
    pidfileExists: fs.existsSync(path.join(w, '.nexuscrew', 'nexuscrew.pid')),
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.armed, true, 'no V disarm may happen inside the warning callback');
  assert.equal(esito.voci, 0, 'no cleanup round may start inside the warning callback');
  assert.equal(esito.nonce, null);
  assert.equal(esito.completedInWarn, true, 'completed is already observable when writeLine runs');
  assert.equal(esito.stateInWarn, 'completed_with_residues');
  assert.equal(esito.outcomeNullInWarn, true);
  assert.equal(esito.clockBeforeDeadlineInWarn, true, 'shared clock stayed before coordinator deadline');
  assert.equal(esito.bindingInstalled, true);
  assert.equal(esito.coordCompleted, true);
  assert.equal(esito.coordQuiescent, false);
  assert.ok(esito.coordCodes.includes('SERVER_CLOSE_TIMEOUT'), JSON.stringify(esito.coordCodes));
  assert.equal(esito.outcome, 'refused', JSON.stringify(esito));
  assert.equal(esito.reason, 'proof-invalid');
  assert.equal(esito.warns, 1, 'no second warning emission or finalization');
  assert.deepEqual(esito.exits, [0], 'single finalization and exit');
  assert.equal(esito.pidfileExists, true);
});

test('wiring: the sealed adapter table mutates one positive precondition at a time', (t) => {
  const root = radice(t);
  // Every case runs in its own FRESH child with a SEALED owner: the
  // terminal of an owner is consumed by its first invocation and the
  // census fence closes once per process, so one child per case is the
  // only honest stage. The base is ALL positive; each case mutates exactly
  // ONE datum, so its refusal exercises that datum and nothing else — and
  // removing that field's check would flip exactly this case.
  const casi = [
    ['control: all positive', '', '', 'done', null],
    ['ctx quiescent false', '', 'ctx.quiescent = false;', 'refused', 'not-quiescent'],
    ['ctx timedOut true', '', 'ctx.timedOut = true;', 'refused', 'not-quiescent'],
    ['ctx counts activeOps 1', '', 'ctx.counts.activeOps = 1;', 'refused', 'not-quiescent'],
    ['ctx codes non empty', '', "ctx.codes = ['X'];", 'refused', 'not-quiescent'],
    ['updater handoff', '', 'ctx.attest.updaterHandoff = true;', 'refused', 'not-quiescent'],
    ['updater not quiescent', '', 'ctx.attest.updaterQuiescent = false;', 'refused', 'not-quiescent'],
    ['fleet raw unknown', '', 'ctx.attest.fleetRaw = { present: null };', 'refused', 'not-quiescent'],
    ['fleet raw present malformed', '', 'ctx.attest.fleetRaw = { present: true, raw: { quiescent: true } };', 'refused', 'proof-invalid'],
    ['fleet raw present negative', '', 'ctx.attest.fleetRaw = { present: true, raw: {'
      + ' disarmed: false, disarmedBeforeWait: true, quiescent: true, timedOut: false, budgetExhausted: false,'
      + ' activeOpsRemaining: 0, canCleanupOwnedResources: true, codes: [],'
      + ' claims: { idle: true, timedOut: false, activeCount: 0, attestedActive: 0, unattestedCount: 0, drainExpired: false } } };',
    'refused', 'not-quiescent'],
    ['server finalized at entry', '', 'ctx.attest.serverFinalized = () => true;', 'refused', 'proof-invalid'],
    ['census producer alive', 'census.registerProducer(() => ({ activeCount: 0, attestedActive: 0, unattestedCount: 0 }));', '', 'refused', 'not-quiescent'],
  ];
  for (const [nome, pre, muta, outcomeAtteso, reasonAtteso] of casi) {
    const codice = `
'use strict';
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const census = require(${JSON.stringify(PERCORSO_CENSUS)});
const v = require(${JSON.stringify(PERCORSO_V)});
${pre}
const owner = hookMod.createProcessOwner();
hookMod.sealAdmissionFor(owner);
const hook = hookMod.createCleanupHook(owner);
const ctx = {
  reason: 'signal', deadlineMono: 5000, quiescent: true, timedOut: false, codes: [],
  counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
  attest: {
    localAdmissionClosed: true, localDisarmErrors: 0,
    fleetRaw: { present: false, provenance: 'disabled' },
    updaterQuiescent: true, updaterHandoff: false,
    nowMono: () => 100, serverFinalized: () => false,
  },
};
${muta}
const out = hook(ctx);
const reg = v.getCreationRegistry();
const ancoraArmed = v.qualifica({ execPath: process.execPath });
console.log('WIRE|' + JSON.stringify({
  outcome: out.outcome, reason: out.reason,
  armed: ancoraArmed.ok, voci: reg.entries.length, nonce: reg.nonce,
}));
`;
    const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
    assert.equal(esito.outcome, outcomeAtteso, `${nome}: ${JSON.stringify(esito)}`);
    assert.equal(esito.reason, reasonAtteso, nome);
    assert.equal(esito.armed, outcomeAtteso !== 'done', `${nome}: V must stay armed on every negative`);
    assert.equal(esito.voci, 0, `${nome}: no round may start`);
    assert.equal(esito.nonce, null, nome);
  }
});

test('wiring: a binding attempted on an already closing controller is a conservative refusal', (t) => {
  const root = radice(t);
  const codice = `
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const v = require(${JSON.stringify(PERCORSO_V)});
const w = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-cl-'));
const fakeProc = new EventEmitter();
// A controller that is ALREADY closing offers no retroactive promotion:
// the binding must refuse and the coordinator must keep its conservative
// own judgement even if the drain then returns a green old-shape result.
const controller = {
  disarm() {},
  state: () => ({ disarmed: false, closing: true, closed: false }),
  onCloseStart: () => () => {},
  async closeOrdered() {
    return {
      ok: true, quiescent: true, timedOut: false,
      counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
      codes: [],
    };
  },
};
const r = dispatch(['serve', '--pidfile'], {
  home: w, fleetEnabled: false, proc: fakeProc, log: () => {}, exitImpl: () => {},
  serverStart: () => ({
    shutdownController: controller, disarm: controller.disarm, closeOrdered: controller.closeOrdered,
  }),
});
(async () => {
  const binding = hookMod.readOwnedHook(controller);
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const reg = v.getCreationRegistry();
  const ancoraArmed = v.qualifica({ execPath: process.execPath });
  console.log('WIRE|' + JSON.stringify({
    bindingNull: binding === null,
    coordQuiescent: coord.quiescent,
    coordCodes: coord.outcome.codes,
    pidfileStatus: coord.pidfileStatus,
    pidfileExists: fs.existsSync(path.join(w, '.nexuscrew', 'nexuscrew.pid')),
    armed: ancoraArmed.ok,
    regEntries: reg.entries.length,
    regNonce: reg.nonce,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
  const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
  assert.equal(esito.bindingNull, true, 'an already closing controller never receives a binding');
  assert.equal(esito.coordQuiescent, false, JSON.stringify(esito));
  assert.ok(esito.coordCodes.includes('CLEANUP_REFUSED'), `codes must carry CLEANUP_REFUSED: ${JSON.stringify(esito.coordCodes)}`);
  assert.equal(esito.pidfileStatus, 'skipped');
  assert.equal(esito.pidfileExists, true, 'the pidfile must stay conserved');
  assert.equal(esito.armed, true, 'no V disarm may happen: no cleanup round may start');
  assert.equal(esito.regEntries, 0, 'no cleanup round may start');
  assert.equal(esito.regNonce, null);
});

test('wiring: an owned shutdown with formal binding and own seal refuses unattested or malformed done summaries', (t) => {
  const root = radice(t);
  const casi = [
    [
      'only outcome done',
      '() => ({ outcome: "done" })',
      'CLEANUP_MALFORMED',
      false,
    ],
    [
      'done with non-null reason',
      '() => ({ outcome: "done", reason: "not-quiescent", counts: { candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0 } })',
      'CLEANUP_MALFORMED',
      false,
    ],
    [
      'done with incompatible counts',
      '() => ({ outcome: "done", reason: null, counts: { candidates: 2, removed: 1, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0 } })',
      'CLEANUP_MALFORMED',
      false,
    ],
    [
      'done with accessor on summary',
      '() => { const o = {}; Object.defineProperty(o, "outcome", { enumerable: true, get() { getterReads += 1; return "done"; } }); Object.defineProperty(o, "reason", { enumerable: true, get() { getterReads += 1; return null; } }); Object.defineProperty(o, "counts", { enumerable: true, get() { getterReads += 1; return { candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0 }; } }); return o; }',
      'CLEANUP_MALFORMED',
      true,
    ],
    [
      'done with accessor on counts',
      '() => { const counts = {}; for (const [k, v] of [["candidates", 0], ["removed", 0], ["alreadyAbsent", 0], ["skipped", 0], ["residues", 0], ["durabilityUnattested", 0]]) { Object.defineProperty(counts, k, { enumerable: true, get() { getterReads += 1; return v; } }); } return { outcome: "done", reason: null, counts }; }',
      'CLEANUP_MALFORMED',
      true,
    ],
    [
      'coherent done summary but hook never executed',
      '() => ({ outcome: "done", reason: null, counts: { candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0 } })',
      'CLEANUP_REFUSED',
      false,
    ],
  ];
  for (const [nome, buildCleanupExpr, expectedCode, isAccessor] of casi) {
    const codice = `
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const census = require(${JSON.stringify(PERCORSO_CENSUS)});
const v = require(${JSON.stringify(PERCORSO_V)});
const w = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-res-'));
const fakeProc = new EventEmitter();
let getterReads = 0;
const cleanupVal = (${buildCleanupExpr})();
const deliveredOutcome = {
  ok: true,
  quiescent: true,
  timedOut: false,
  counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
  codes: [],
  cleanup: cleanupVal,
};
const beforeJson = ${isAccessor ? 'null' : 'JSON.stringify(deliveredOutcome)'};
// Controller formally accepts the owned binding and the process's OWN owner
// seals the census at disarm, yet closeOrdered never executes the bound hook.
const controller = {
  disarm() {},
  state: () => ({ disarmed: false, closing: false, closed: false }),
  onCloseStart: () => () => {},
  async closeOrdered() { return deliveredOutcome; },
};
const r = dispatch(['serve', '--pidfile'], {
  home: w,
  fleetEnabled: false,
  proc: fakeProc,
  log: () => {},
  exitImpl: () => {},
  serverStart: () => ({
    shutdownController: controller,
    disarm: controller.disarm,
    closeOrdered: controller.closeOrdered,
  }),
});
(async () => {
  const pidPath = path.join(w, '.nexuscrew', 'nexuscrew.pid');
  const bindingInstalled = hookMod.readOwnedHook(controller) !== null;
  const beforeStat = fs.statSync(pidPath);
  const beforeContent = fs.readFileSync(pidPath, 'utf8');
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 200 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const coord = r.controller.getState();
  const censusSealed = census.snapshot().admissionClosed === true;
  const pidfileExists = fs.existsSync(pidPath);
  const afterStat = pidfileExists ? fs.statSync(pidPath) : null;
  const afterContent = pidfileExists ? fs.readFileSync(pidPath, 'utf8') : null;
  const serverOutcomeUnchanged = ${isAccessor
    ? 'deliveredOutcome.ok === true && deliveredOutcome.quiescent === true && deliveredOutcome.cleanup === cleanupVal && deliveredOutcome.counts.residues === 0 && deliveredOutcome.codes.length === 0'
    : 'JSON.stringify(deliveredOutcome) === beforeJson'};
  // Capture the registry BEFORE the qualification probe.
  const reg = v.getCreationRegistry();
  const ancoraArmed = v.qualifica({ execPath: process.execPath });
  console.log('WIRE|' + JSON.stringify({
    coordQuiescent: coord.quiescent,
    pidfileRemoved: coord.pidfileRemoved,
    pidfileStatus: coord.pidfileStatus,
    pidfileExists,
    sameDev: Boolean(afterStat && afterStat.dev === beforeStat.dev),
    sameIno: Boolean(afterStat && afterStat.ino === beforeStat.ino),
    sameContent: afterContent === beforeContent,
    coordResidues: coord.outcome ? coord.outcome.counts.residues : null,
    armed: ancoraArmed.ok,
    regEntries: reg.entries.length,
    regNonce: reg.nonce,
    bindingInstalled,
    censusSealed,
    serverOutcomeUnchanged,
    coordCodes: coord.outcome ? coord.outcome.codes : null,
    getterReads,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
    const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
    // Assert the effect first: non-quiescence and pidfile conservation.
    assert.equal(esito.coordQuiescent, false, `${nome}: ${JSON.stringify(esito)}`);
    assert.equal(esito.pidfileRemoved, false, `${nome}: ${JSON.stringify(esito)}`);
    assert.equal(esito.pidfileStatus, 'skipped', `${nome}: ${JSON.stringify(esito)}`);
    assert.equal(esito.pidfileExists, true, `${nome}: pidfile must stay conserved`);
    assert.equal(esito.sameDev, true, `${nome}: pidfile dev must stay unchanged`);
    assert.equal(esito.sameIno, true, `${nome}: pidfile ino must stay unchanged`);
    assert.equal(esito.sameContent, true, `${nome}: pidfile content must stay unchanged`);
    assert.ok(esito.coordResidues >= 1, `${nome}: ${JSON.stringify(esito)}`);
    assert.equal(esito.armed, true, `${nome}: V must stay armed`);
    assert.equal(esito.regEntries, 0, `${nome}: no cleanup round may start`);
    assert.equal(esito.regNonce, null, nome);
    assert.equal(esito.bindingInstalled, true, nome);
    assert.equal(esito.censusSealed, true, nome);
    assert.equal(esito.serverOutcomeUnchanged, true, nome);
    assert.ok(esito.coordCodes.includes(expectedCode), `${nome}: expected ${expectedCode} in ${JSON.stringify(esito.coordCodes)}`);
    if (isAccessor) {
      assert.equal(esito.getterReads, 0, `${nome}: no accessor may be read`);
    }
  }
});

test('wiring: the six non-done or failing owned hook outcomes propagate conservatively through server, diagnostics, coordinator and pidfile', (t) => {
  const root = radice(t);
  const casi = [
    [
      'undefined',
      '() => undefined',
      1000,
      'malformed',
      false,
      ['CLEANUP_MALFORMED'],
      ['CLEANUP_MALFORMED', 'PIDFILE_CLEANUP_SKIPPED'],
    ],
    [
      'null',
      '() => null',
      1000,
      'malformed',
      false,
      ['CLEANUP_MALFORMED'],
      ['CLEANUP_MALFORMED', 'PIDFILE_CLEANUP_SKIPPED'],
    ],
    [
      'malformed with zero counts',
      '() => ({ schema: 1, outcome: "done", reason: "contradictory-reason", counts: { candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0 }, replayed: false })',
      1000,
      'malformed',
      false,
      ['CLEANUP_MALFORMED'],
      ['CLEANUP_MALFORMED', 'PIDFILE_CLEANUP_SKIPPED'],
    ],
    [
      'synchronous throw',
      '() => { throw new Error("owned-hook-sync-boom"); }',
      1000,
      'incomplete',
      false,
      ['AFTER_DRAIN_HOOK_ERROR', 'CLEANUP_INCOMPLETE'],
      ['AFTER_DRAIN_HOOK_ERROR', 'CLEANUP_INCOMPLETE', 'PIDFILE_CLEANUP_SKIPPED'],
    ],
    [
      'async rejection',
      'async () => { await Promise.resolve(); throw new Error("owned-hook-async-reject"); }',
      1000,
      'incomplete',
      false,
      ['AFTER_DRAIN_HOOK_ERROR', 'CLEANUP_INCOMPLETE'],
      ['AFTER_DRAIN_HOOK_ERROR', 'CLEANUP_INCOMPLETE', 'PIDFILE_CLEANUP_SKIPPED'],
    ],
    [
      'timeout',
      '() => new Promise(() => {})',
      180,
      'incomplete',
      true,
      ['AFTER_DRAIN_HOOK_TIMEOUT', 'CLEANUP_INCOMPLETE'],
      ['PIDFILE_CLEANUP_SKIPPED'],
    ],
  ];
  for (const [nome, hookExpr, budgetMs, expectedDiagOutcome, expectedTimedOut, expectedServerCodes, expectedCoordCodes] of casi) {
    const codice = `
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { dispatch } = require(${JSON.stringify(PERCORSO_COMMANDS)});
const hookMod = require(${JSON.stringify(PERCORSO_HOOK)});
const v = require(${JSON.stringify(PERCORSO_V)});
const w = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wire-m6-'));
const fakeProc = new EventEmitter();
const records = [];
const diagnostics = { record: (...args) => records.push(args) };
const ownedOutcomeHook = (${hookExpr});
const r = dispatch(['serve', '--pidfile'], {
  home: w,
  port: 0,
  panelPort: 0,
  fleetEnabled: false,
  protectSharedTmuxServer: false,
  liveBridgeEnabled: false,
  autoUpdate: false,
  shutdownBudgetMs: ${budgetMs},
  proc: fakeProc,
  log: () => {},
  exitImpl: () => {},
  diagnostics,
});
(async () => {
  await new Promise((res) => { if (r.server.listening) res(); else r.server.once('listening', res); });
  const pidPath = path.join(w, '.nexuscrew', 'nexuscrew.pid');
  const beforeStat = fs.statSync(pidPath);
  const beforeContent = fs.readFileSync(pidPath, 'utf8');
  const realBinding = hookMod.readOwnedHook(r.server.shutdownController);
  const origReadOwnedHook = hookMod.readOwnedHook;
  let hookCalls = 0;
  hookMod.readOwnedHook = (ctrl) => {
    const b = origReadOwnedHook(ctrl);
    if (b && ctrl === r.server.shutdownController) {
      return {
        owner: b.owner,
        hook: (ctx) => {
          hookCalls += 1;
          return ownedOutcomeHook(ctx);
        },
      };
    }
    return b;
  };
  fakeProc.emit('SIGTERM');
  for (let i = 0; i < 400 && !r.controller.getState().completed; i++) await new Promise((res) => setTimeout(res, 25));
  const so = await r.server.shutdownController.closeOrdered({ reason: 'signal' });
  hookMod.readOwnedHook = origReadOwnedHook;
  const coord = r.controller.getState();
  const shutdownDiags = records.filter((rec) => rec[2] === 'SERVER_SHUTDOWN_ORDERED');
  const diag = shutdownDiags.length === 1 ? shutdownDiags[0] : null;
  const pidfileExists = fs.existsSync(pidPath);
  const afterStat = pidfileExists ? fs.statSync(pidPath) : null;
  const afterContent = pidfileExists ? fs.readFileSync(pidPath, 'utf8') : null;
  // Capture the registry BEFORE the qualification probe.
  const reg = v.getCreationRegistry();
  const ancoraArmed = v.qualifica({ execPath: process.execPath });
  console.log('WIRE|' + JSON.stringify({
    realBindingPresent: realBinding !== null,
    hookCalls,
    serverOk: so.ok,
    serverQuiescent: so.quiescent,
    serverTimedOut: so.timedOut,
    serverCleanup: so.cleanup,
    serverResidues: so.counts ? so.counts.residues : null,
    serverCodes: so.codes,
    diagCount: shutdownDiags.length,
    diagLevel: diag ? diag[0] : null,
    diagCategory: diag ? diag[1] : null,
    diagCode: diag ? diag[2] : null,
    diagMeta: diag ? diag[4] : null,
    diagSerialized: diag ? JSON.stringify(diag) : '',
    coordQuiescent: coord.quiescent,
    coordTimedOut: coord.outcome ? coord.outcome.timedOut : null,
    coordResidues: coord.outcome ? coord.outcome.counts.residues : null,
    coordCodes: coord.outcome ? coord.outcome.codes : null,
    pidfileStatus: coord.pidfileStatus,
    pidfileRemoved: coord.pidfileRemoved,
    pidfileExists,
    sameDev: Boolean(afterStat && afterStat.dev === beforeStat.dev),
    sameIno: Boolean(afterStat && afterStat.ino === beforeStat.ino),
    sameContent: afterContent === beforeContent,
    armed: ancoraArmed.ok,
    regEntries: reg.entries.length,
    regNonce: reg.nonce,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
`;
    const esito = esitoFiglio(figlio(codice, { env: { TMPDIR: root } }));
    assert.equal(esito.realBindingPresent, true, nome);
    assert.equal(esito.hookCalls, 1, `${nome}: owned hook must run once`);
    assert.equal(esito.serverOk, false, `${nome}: server ok must be false`);
    assert.equal(esito.serverQuiescent, false, `${nome}: server quiescent must be false`);
    assert.equal(esito.serverTimedOut, expectedTimedOut, `${nome}: server timedOut`);
    assert.equal(esito.serverCleanup, null, `${nome}: server cleanup must stay null`);
    assert.ok(esito.serverResidues >= 1, `${nome}: server residues must be >= 1`);
    for (const c of expectedServerCodes) {
      assert.ok(esito.serverCodes.includes(c), `${nome}: missing server code ${c} in ${JSON.stringify(esito.serverCodes)}`);
    }
    assert.equal(esito.diagCount, 1, `${nome}: one SERVER_SHUTDOWN_ORDERED diagnostic record`);
    assert.equal(esito.diagLevel, 'warn', nome);
    assert.equal(esito.diagCategory, 'server', nome);
    assert.equal(esito.diagCode, 'SERVER_SHUTDOWN_ORDERED', nome);
    assert.equal(esito.diagMeta.quiescent, false, nome);
    assert.equal(esito.diagMeta.timedOut, expectedTimedOut, nome);
    assert.ok(esito.diagMeta.residues >= 1, nome);
    assert.equal(esito.diagMeta.cleanupOutcome, expectedDiagOutcome, nome);
    for (const k of ['cleanupReason', 'cleanupCandidates', 'cleanupRemoved', 'cleanupAlreadyAbsent', 'cleanupSkipped', 'cleanupResidues', 'cleanupDurabilityUnattested']) {
      assert.equal(Object.prototype.hasOwnProperty.call(esito.diagMeta, k), false, `${nome}: diagnostic must not deduce ${k}`);
    }
    assert.equal(esito.diagSerialized.includes('owned-hook-'), false, `${nome}: raw error message must not leak into diagnostics`);
    assert.equal(esito.coordQuiescent, false, `${nome}: coordinator must not be quiescent`);
    assert.equal(esito.coordTimedOut, expectedTimedOut, `${nome}: coordinator timedOut`);
    assert.ok(esito.coordResidues >= 1, `${nome}: coordinator residues must be >= 1`);
    for (const c of expectedCoordCodes) {
      assert.ok(esito.coordCodes.includes(c), `${nome}: missing coordinator code ${c} in ${JSON.stringify(esito.coordCodes)}`);
    }
    if (expectedTimedOut) {
      assert.ok(
        esito.coordCodes.includes('AFTER_DRAIN_HOOK_TIMEOUT') || esito.coordCodes.includes('SERVER_CLOSE_TIMEOUT'),
        `${nome}: expected timeout code in ${JSON.stringify(esito.coordCodes)}`,
      );
    }
    assert.equal(esito.pidfileStatus, 'skipped', nome);
    assert.equal(esito.pidfileRemoved, false, nome);
    assert.equal(esito.pidfileExists, true, `${nome}: pidfile must stay conserved`);
    assert.equal(esito.sameDev, true, `${nome}: pidfile dev unchanged`);
    assert.equal(esito.sameIno, true, `${nome}: pidfile ino unchanged`);
    assert.equal(esito.sameContent, true, `${nome}: pidfile content unchanged`);
    assert.equal(esito.armed, true, `${nome}: V must stay armed`);
    assert.equal(esito.regEntries, 0, `${nome}: no cleanup round may start`);
    assert.equal(esito.regNonce, null, nome);
  }
});
