'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadDefinitions, tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const { migrateLegacyTmuxSessions } = require('../lib/fleet/launch.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { selectProvider } = require('../lib/fleet/provider.js');

function makeTmuxFixture(lines, {
  renameFailure = '',
  listFailure = '',
  requireCInventoryMessages = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmigrate-'));
  const sessions = path.join(root, 'sessions.txt');
  const log = path.join(root, 'tmux.log');
  const fail = path.join(root, 'rename-failure.txt');
  const listFail = path.join(root, 'list-failure.txt');
  const bin = path.join(root, 'fake-tmux.js');
  fs.writeFileSync(sessions, lines.join('\n') + (lines.length ? '\n' : ''));
  fs.writeFileSync(log, '');
  fs.writeFileSync(fail, renameFailure);
  fs.writeFileSync(listFail, listFailure);
  fs.writeFileSync(bin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const sessions = ${JSON.stringify(sessions)};
const log = ${JSON.stringify(log)};
const fail = ${JSON.stringify(fail)};
const listFail = ${JSON.stringify(listFail)};
const requireCInventoryMessages = ${JSON.stringify(requireCInventoryMessages)};
if (args[0] === 'list-sessions') {
  if (requireCInventoryMessages
    && (process.env.LANGUAGE !== 'C'
      || process.env.LC_MESSAGES !== 'C'
      || process.env.LC_ALL
      || !/utf-?8/i.test(process.env.LC_CTYPE || process.env.LANG || ''))) {
    process.stderr.write('erreur de connexion au socket tmux (fichier introuvable)\\n');
    process.exit(1);
  }
  const message = fs.readFileSync(listFail, 'utf8').trim();
  if (message) { process.stderr.write(message + '\\n'); process.exit(1); }
  process.stdout.write(fs.readFileSync(sessions, 'utf8'));
  process.exit(0);
}
if (args[0] === 'rename-session') {
  fs.appendFileSync(log, JSON.stringify(args) + '\\n');
  const message = fs.readFileSync(fail, 'utf8').trim();
  if (message) { process.stderr.write(message + '\\n'); process.exit(1); }
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return {
    root, bin, log,
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function engines() {
  return [
    { id: 'shell.local', label: 'Shell', rc: false, managed: { client: 'shell', provider: 'local', model: '', permissionPolicy: 'standard' } },
    { id: 'agy.native', label: 'Agy', rc: false, managed: { client: 'agy', provider: 'native', model: '', permissionPolicy: 'standard' } },
  ];
}

function writeLegacy(file, cells) {
  const raw = { schemaVersion: 1, engines: engines(), cells };
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return raw;
}

test('cold boot: socket tmux ancora assente non disabilita il provider Fleet', async () => {
  const fixture = makeTmuxFixture([], {
    listFailure: 'error connecting to /tmp/tmux-1000/default (No such file or directory)',
    requireCInventoryMessages: true,
  });
  const file = path.join(fixture.root, 'fleet.json');
  writeLegacy(file, [{
    id: 'agy.native', cwd: fixture.root, engine: 'agy.native', boot: false,
    tmuxSession: 'cloud-agy.native',
  }]);
  try {
    const migration = await migrateLegacyTmuxSessions(fixture.bin, loadDefinitions(file));
    assert.deepEqual(migration, {
      migrated: [], reason: 'no-tmux-server', needsPersistence: true,
    });

    const fleet = await createBuiltinFleet({
      home: fixture.root, fleetDefsPath: file, tmuxBin: fixture.bin,
      ensureTmuxProtection: async () => {}, platform: 'linux', env: {},
    });
    assert.equal(fleet.available, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cells[0].tmuxSession,
      tmuxSessionForCell('agy.native'));
    await fleet.close();
  } finally { fixture.cleanup(); }
});

test('errore tmux inatteso resta fail-closed con causa di migrazione', async () => {
  const fixture = makeTmuxFixture([], { listFailure: 'permission denied: synthetic tmux socket' });
  const file = path.join(fixture.root, 'fleet.json');
  writeLegacy(file, [{
    id: 'agy.native', cwd: fixture.root, engine: 'agy.native', boot: false,
    tmuxSession: 'cloud-agy.native',
  }]);
  try {
    await assert.rejects(
      () => migrateLegacyTmuxSessions(fixture.bin, loadDefinitions(file)),
      (error) => error.code === 'TMUX_MIGRATION_LIST_FAILED'
        && /permission denied/.test(error.message),
    );
  } finally { fixture.cleanup(); }
});

test('migrazione fail-closed: a.b non puo appropriarsi della sessione canonica di a_b', async () => {
  const fixture = makeTmuxFixture(['$7\tcloud-a_b']);
  const file = path.join(fixture.root, 'fleet.json');
  writeLegacy(file, [
    { id: 'a.b', cwd: fixture.root, engine: 'agy.native', boot: false },
    { id: 'a_b', cwd: fixture.root, engine: 'agy.native', boot: false },
  ]);
  try {
    const defs = loadDefinitions(file);
    await assert.rejects(
      () => migrateLegacyTmuxSessions(fixture.bin, defs),
      (error) => error.code === 'TMUX_MIGRATION_AMBIGUOUS' && /a_b/.test(error.message),
    );
    assert.deepEqual(fixture.calls(), [], 'preflight ambiguo: nessun rename parziale');
  } finally { fixture.cleanup(); }
});

test('migrazione fail-closed: legacy e target v2 coesistenti non vengono fusi', async () => {
  const safe = tmuxSessionForCell('agy.native');
  const fixture = makeTmuxFixture(['$1\tcloud-agy_native', `$2\t${safe}`]);
  const file = path.join(fixture.root, 'fleet.json');
  writeLegacy(file, [{ id: 'agy.native', cwd: fixture.root, engine: 'agy.native', boot: false, tmuxSession: 'cloud-agy.native' }]);
  try {
    await assert.rejects(
      () => migrateLegacyTmuxSessions(fixture.bin, loadDefinitions(file)),
      (error) => error.code === 'TMUX_MIGRATION_TARGET_EXISTS',
    );
    assert.deepEqual(fixture.calls(), []);
  } finally { fixture.cleanup(); }
});

test('migrazione custom legacy: match unico rinomina via $N al canonico safe', async () => {
  const fixture = makeTmuxFixture(['$9\tcustom_name']);
  const file = path.join(fixture.root, 'fleet.json');
  writeLegacy(file, [{ id: 'Agent', cwd: fixture.root, engine: 'agy.native', boot: false, tmuxSession: 'custom.name' }]);
  try {
    const defs = loadDefinitions(file);
    assert.equal(defs.legacyTmuxSessions.get('Agent'), 'custom.name');
    const result = await migrateLegacyTmuxSessions(fixture.bin, defs);
    assert.deepEqual(result.migrated, [{ id: 'Agent', from: 'custom_name', to: 'cloud-Agent' }]);
    assert.deepEqual(fixture.calls(), [['rename-session', '-t', '$9', 'cloud-Agent']]);
  } finally { fixture.cleanup(); }
});

test('errore rename e propagato e createBuiltinFleet non persiste prima della migrazione', async () => {
  const fixture = makeTmuxFixture(['$3\tcloud-agy_native'], { renameFailure: 'duplicate session: synthetic' });
  const file = path.join(fixture.root, 'fleet.json');
  writeLegacy(file, [{ id: 'agy.native', cwd: fixture.root, engine: 'agy.native', boot: false, tmuxSession: 'cloud-agy.native' }]);
  const before = fs.readFileSync(file, 'utf8');
  try {
    const fleet = await createBuiltinFleet({
      home: fixture.root, fleetDefsPath: file, tmuxBin: fixture.bin,
      ensureTmuxProtection: async () => {}, platform: 'linux', env: {},
    });
    assert.equal(fleet.available, false);
    assert.equal(fleet.migrationCode, 'TMUX_MIGRATION_RENAME_FAILED');
    assert.match(fleet.reason, /TMUX_MIGRATION_RENAME_FAILED/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'store legacy byte-invariato sul blocco');
    const selected = await selectProvider({
      home: fixture.root, fleetDefsPath: file, tmuxBin: fixture.bin,
      ensureTmuxProtection: async () => {}, platform: 'linux', env: {},
    });
    assert.equal(selected.mode, 'disabled');
    assert.match(selected.reason, /TMUX_MIGRATION_RENAME_FAILED/, 'causa bounded propagata dal provider');
  } finally { fixture.cleanup(); }
});

test('migrazione riuscita persiste safe dopo rename; READONLY non rinomina e non scrive', async () => {
  const fixture = makeTmuxFixture(['$4\tcloud-agy_native']);
  const file = path.join(fixture.root, 'fleet.json');
  writeLegacy(file, [{ id: 'agy.native', cwd: fixture.root, engine: 'agy.native', boot: false, tmuxSession: 'cloud-agy.native' }]);
  try {
    const fleet = await createBuiltinFleet({
      home: fixture.root, fleetDefsPath: file, tmuxBin: fixture.bin,
      ensureTmuxProtection: async () => {}, platform: 'linux', env: {},
    });
    assert.equal(fleet.available, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cells[0].tmuxSession,
      tmuxSessionForCell('agy.native'));
    assert.deepEqual(fixture.calls(), [['rename-session', '-t', '$4', tmuxSessionForCell('agy.native')]]);
    await fleet.close();

    const readonlyFile = path.join(fixture.root, 'readonly.json');
    writeLegacy(readonlyFile, [{ id: 'agy.native', cwd: fixture.root, engine: 'agy.native', boot: false, tmuxSession: 'cloud-agy.native' }]);
    const before = fs.readFileSync(readonlyFile, 'utf8');
    fs.writeFileSync(fixture.log, '');
    const readonlyFleet = await createBuiltinFleet({
      home: fixture.root, fleetDefsPath: readonlyFile, tmuxBin: fixture.bin,
      ensureTmuxProtection: async () => {}, readonlyDefault: true,
    });
    assert.equal(readonlyFleet.available, true);
    assert.equal(fs.readFileSync(readonlyFile, 'utf8'), before);
    assert.deepEqual(fixture.calls(), [], 'READONLY: nessuna enumerazione o rename');
    await readonlyFleet.close();
  } finally { fixture.cleanup(); }
});
