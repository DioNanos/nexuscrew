'use strict';
// T1 — cwd portabile fail-closed (design §4.3 / backup v3).
// Copre: helper puri (normalizeCwdRel, deriveCwdRel), resolveCellCwd (missing
// dir, symlink escape, mismatch cwd/cwdRel), define/edit/restore fail-closed,
// vista definitions (cwdRel derivato + needsRepair senza mutare fleet.json),
// backup v3 (cwdRel only, nessuna cwd assoluta), parsing legacy v1/v2, roundtrip
// cross-home, downgrade 0.8.27 simulato, export fail-closed (no silent omit).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeCwdRel, deriveCwdRel, atomicWrite,
} = require('../lib/fleet/definitions.js');
const { createBuiltinFleet, resolveCellCwd } = require('../lib/fleet/builtin.js');

const fb = () => import('../frontend/src/lib/fleet-backup.js');

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cwd-'));
const tmpOutside = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cwd-out-'));

// --- mondo minimale: home reale + engine trusted + cella reale sotto home ---
function makeWorld(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncbi-cwd-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, 'Dev'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, 'bin'));
  const command = path.join(home, 'bin', 'myclaude');
  fs.writeFileSync(command, '#!/bin/sh\necho hi\n'); fs.chmodSync(command, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'claude', label: 'Claude', rc: true, command,
      args: ['--dangerously-skip-permissions'], env: { ANTHROPIC_API_KEY: 'sk-x' },
      model: { flag: '--model', value: '' }, promptMode: 'flag', promptFlag: '--append-system-prompt',
    }],
    cells: [{
      id: 'Dev', tmuxSession: 'work-build', cwd, engine: 'claude', boot: true, prompt: 'p',
      ...(over.cellCwdRel !== undefined ? { cwdRel: over.cellCwdRel } : {}),
    }],
  });
  const tmuxBin = path.join(root, 'fake-tmux.sh');
  fs.writeFileSync(tmuxBin, '#!/bin/sh\ncase "$1" in\nhas-session) exit 0 ;;\nlist-sessions) exit 0 ;;\n*) exit 0 ;;\nesac\n');
  fs.chmodSync(tmuxBin, 0o755);
  return {
    root, home, cwd, command, defsPath, tmuxBin,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ===========================================================================
// 1. UNIT HELPER — normalizeCwdRel (pura, fail-closed)
// ===========================================================================
test('normalizeCwdRel: home, nested, normalizzazione', () => {
  assert.equal(normalizeCwdRel(''), '', 'stringa vuota == home');
  assert.equal(normalizeCwdRel('personal'), 'personal');
  assert.equal(normalizeCwdRel('a/b'), 'a/b', 'nested');
  assert.equal(normalizeCwdRel('a/./b'), 'a/b', 'collassa dot');
  assert.equal(normalizeCwdRel('a//b'), 'a/b', 'collassa segmenti vuoti');
  assert.equal(normalizeCwdRel('./a'), 'a', 'leading ./');
  assert.equal(normalizeCwdRel('a/'), 'a', 'trailing slash rimosso');
  assert.equal(normalizeCwdRel('.'), '', 'dot solo == home');
});

test('normalizeCwdRel: assoluto, traversal, control/backslash/drive, cap -> null', () => {
  assert.equal(normalizeCwdRel('/a'), null, 'assoluto (leading sep)');
  assert.equal(normalizeCwdRel('../a'), null, 'traversal leading');
  assert.equal(normalizeCwdRel('a/..'), null, 'traversal trailing');
  assert.equal(normalizeCwdRel('a/../b'), null, 'traversal mid');
  assert.equal(normalizeCwdRel('a\0b'), null, 'NUL');
  assert.equal(normalizeCwdRel('a\tb'), null, 'control (tab)');
  assert.equal(normalizeCwdRel('a\x7fb'), null, 'DEL');
  assert.equal(normalizeCwdRel('a\\b'), null, 'backslash');
  assert.equal(normalizeCwdRel('C:a'), null, 'drive letter');
  assert.equal(normalizeCwdRel('a'.repeat(4097)), null, 'oltre cap');
  assert.equal(normalizeCwdRel(123), null, 'non-string');
  assert.equal(normalizeCwdRel(null), null);
});

test('deriveCwdRel: uguale home, nested, fuori home', () => {
  const home = tmpRoot();
  const sub = path.join(home, 'sub'); fs.mkdirSync(sub);
  try {
    assert.equal(deriveCwdRel(home, home), '', 'cwd == home');
    assert.equal(deriveCwdRel(sub, home), 'sub', 'nested sotto home');
    const outside = tmpOutside();
    try {
      assert.equal(deriveCwdRel(outside, home), null, 'fuori home -> null');
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ===========================================================================
// 2. resolveCellCwd — casi fs-dipendenti
// ===========================================================================
test('resolveCellCwd: cwd assoluta valida deriva cwdRel; cwdRel calcola cwd', () => {
  const home = tmpRoot(); const sub = path.join(home, 'work'); fs.mkdirSync(sub);
  try {
    const a = resolveCellCwd({ cwd: sub }, home);
    assert.equal(a.ok, true); assert.equal(a.cwd, fs.realpathSync(sub)); assert.equal(a.cwdRel, 'work');
    const b = resolveCellCwd({ cwdRel: 'work' }, home);
    assert.equal(b.ok, true); assert.equal(b.cwd, fs.realpathSync(sub)); assert.equal(b.cwdRel, 'work');
    const c = resolveCellCwd({ cwdRel: '' }, home); // home stessa
    assert.equal(c.ok, true); assert.equal(c.cwd, fs.realpathSync(home)); assert.equal(c.cwdRel, '');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('resolveCellCwd: coppia coerente ok; mismatch rifiutato', () => {
  const home = tmpRoot(); const sub = path.join(home, 'work'); fs.mkdirSync(sub);
  const sub2 = path.join(home, 'other'); fs.mkdirSync(sub2);
  try {
    const ok = resolveCellCwd({ cwd: sub, cwdRel: 'work' }, home);
    assert.equal(ok.ok, true);
    const mismatch = resolveCellCwd({ cwd: sub, cwdRel: 'other' }, home);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.fail.reason, 'mismatch');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('resolveCellCwd: missing dir -> fail; fuori home -> fail; invalid format -> fail; neither -> fail', () => {
  const home = tmpRoot();
  try {
    const missing = resolveCellCwd({ cwd: path.join(home, 'nope') }, home);
    assert.equal(missing.ok, false);
    const outside = tmpOutside();
    try {
      const out = resolveCellCwd({ cwd: outside }, home);
      assert.equal(out.ok, false);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
    const bad = resolveCellCwd({ cwdRel: '../etc' }, home);
    assert.equal(bad.ok, false); assert.equal(bad.fail.reason, 'invalid-rel');
    const neither = resolveCellCwd({ id: 'X' }, home);
    assert.equal(neither.ok, false); assert.equal(neither.fail.reason, 'missing');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('resolveCellCwd: symlink escape da home -> fail (resolveCwd invariato)', () => {
  const home = tmpRoot();
  const outside = tmpOutside();
  const link = path.join(home, 'escape');
  try {
    fs.symlinkSync(outside, link);
    const r = resolveCellCwd({ cwd: link }, home);
    assert.equal(r.ok, false, 'symlink che punta fuori home rifiutato');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ===========================================================================
// 3. define/edit/restore — fail-closed, zero scritture parziali
// ===========================================================================
test('defineCell: cwd valida persiste coppia cwd+cwdRel coerente', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await fleet.defineCell({ id: 'Trading', cwd: w.cwd, engine: 'claude', boot: false });
    const cell = fleet.definitions().cells.find((c) => c.id === 'Trading');
    assert.equal(cell.cwd, fs.realpathSync(w.cwd));
    assert.equal(cell.cwdRel, 'Dev');
    assert.equal(cell.needsRepair, undefined);
  } finally { w.cleanup(); }
});

test('defineCell: cwdRel sola -> calcola cwd target; casa (cwdRel="") -> home', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await fleet.defineCell({ id: 'Rel', cwdRel: 'Dev', engine: 'claude' });
    const cell = fleet.definitions().cells.find((c) => c.id === 'Rel');
    assert.equal(cell.cwd, fs.realpathSync(w.cwd));
    assert.equal(cell.cwdRel, 'Dev');
    await fleet.defineCell({ id: 'Home', cwdRel: '', engine: 'claude' });
    const home = fleet.definitions().cells.find((c) => c.id === 'Home');
    assert.equal(home.cwd, fs.realpathSync(w.home));
    assert.equal(home.cwdRel, '');
  } finally { w.cleanup(); }
});

test('defineCell: cwd non portabile (fuori home) -> 400 code unportable-cwd, nessuna scrittura', async () => {
  const w = makeWorld(); const outside = tmpOutside();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    const before = fs.readFileSync(w.defsPath, 'utf8');
    await assert.rejects(() => fleet.defineCell({ id: 'Bad', cwd: outside, engine: 'claude' }), (e) => {
      assert.equal(e.status, 400);
      assert.equal(e.data?.code, 'unportable-cwd');
      assert.ok(e.data?.cells?.some((c) => c.id === 'Bad'));
      return true;
    });
    assert.equal(fs.readFileSync(w.defsPath, 'utf8'), before, 'file intatto');
  } finally { w.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('defineCell: cwd inesistente + cwdRel invalido -> 400 unportable-cwd', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await assert.rejects(
      () => fleet.defineCell({ id: 'Missing', cwd: path.join(w.home, 'nope'), engine: 'claude' }),
      (e) => e.status === 400 && e.data?.code === 'unportable-cwd',
    );
    await assert.rejects(
      () => fleet.defineCell({ id: 'BadRel', cwdRel: '../etc', engine: 'claude' }),
      (e) => e.status === 400 && e.data?.code === 'unportable-cwd',
    );
    await assert.rejects(
      () => fleet.defineCell({ id: 'Mismatch', cwd: w.cwd, cwdRel: 'bin', engine: 'claude' }),
      (e) => e.status === 400 && e.data?.code === 'unportable-cwd',
    );
  } finally { w.cleanup(); }
});

test('editCell: patch cwd ricalcola cwdRel; patch cwdRel ricalcola cwd', async () => {
  const w = makeWorld();
  try {
    const other = path.join(w.home, 'Other');
    fs.mkdirSync(other);
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await fleet.defineCell({ id: 'Trading', cwdRel: 'Dev', engine: 'claude' });
    await fleet.editCell('Trading', { cwd: other });
    let cell = fleet.definitions().cells.find((c) => c.id === 'Trading');
    assert.equal(cell.cwdRel, 'Other');
    assert.equal(cell.cwd, fs.realpathSync(other));
    await fleet.editCell('Trading', { cwdRel: 'Dev' });
    cell = fleet.definitions().cells.find((c) => c.id === 'Trading');
    assert.equal(cell.cwdRel, 'Dev');
    assert.equal(cell.cwd, fs.realpathSync(w.cwd));
    // cambia engine non tocca cwd/cwdRel
    await fleet.editCell('Trading', { boot: true });
    cell = fleet.definitions().cells.find((c) => c.id === 'Trading');
    assert.equal(cell.cwdRel, 'Dev');
    assert.equal(cell.cwd, fs.realpathSync(w.cwd));
  } finally { w.cleanup(); }
});

test('editCell: cwd non portabile -> 400 unportable-cwd, nessuna scrittura', async () => {
  const w = makeWorld(); const outside = tmpOutside();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    const before = fs.readFileSync(w.defsPath, 'utf8');
    await assert.rejects(
      () => fleet.editCell('Dev', { cwd: outside }),
      (e) => e.status === 400 && e.data?.code === 'unportable-cwd',
    );
    assert.equal(fs.readFileSync(w.defsPath, 'utf8'), before, 'file intatto');
  } finally { w.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('restoreCells: v3 cwdRel persiste coppia coerente; legacy cwd valida idem', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await fleet.restoreCells([{ id: 'New', cwdRel: 'Dev', engine: 'claude', boot: false }]);
    let cell = fleet.definitions().cells.find((c) => c.id === 'New');
    assert.equal(cell.cwd, fs.realpathSync(w.cwd));
    assert.equal(cell.cwdRel, 'Dev');
    await fleet.restoreCells([{ id: 'Legacy', cwd: w.cwd, engine: 'claude', boot: false }]);
    cell = fleet.definitions().cells.find((c) => c.id === 'Legacy');
    assert.equal(cell.cwdRel, 'Dev');
  } finally { w.cleanup(); }
});

test('restoreCells: cwd non portabile -> 400 strutturato, NESSUNA scrittura parziale', async () => {
  const w = makeWorld(); const outside = tmpOutside();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    const before = fs.readFileSync(w.defsPath, 'utf8');
    await assert.rejects(() => fleet.restoreCells([
      { id: 'Ok', cwd: w.cwd, engine: 'claude', boot: false },
      { id: 'Bad', cwd: outside, engine: 'claude', boot: false },
    ]), (e) => {
      assert.equal(e.status, 400);
      assert.equal(e.data?.code, 'unportable-cwd');
      assert.ok(e.data?.cells?.some((c) => c.id === 'Bad'));
      assert.ok(e.data?.hint);
      return true;
    });
    assert.equal(fs.readFileSync(w.defsPath, 'utf8'), before, 'nessuna scrittura parziale');
  } finally { w.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('restoreCells: cwdRel invalido (traversal) -> 400 unportable-cwd', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await assert.rejects(
      () => fleet.restoreCells([{ id: 'Bad', cwdRel: '../etc', engine: 'claude', boot: false }]),
      (e) => e.status === 400 && e.data?.code === 'unportable-cwd',
    );
  } finally { w.cleanup(); }
});

// ===========================================================================
// 4. definitions() view — cwdRel derivato + needsRepair SENZA mutare fleet.json
// ===========================================================================
test('definitions: cella legacy valida deriva cwdRel in vista; needsRepair assente', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    const before = fs.readFileSync(w.defsPath, 'utf8');
    const cell = fleet.definitions().cells.find((c) => c.id === 'Dev');
    assert.equal(cell.cwdRel, 'Dev');
    assert.equal(cell.needsRepair, undefined);
    assert.equal(fs.readFileSync(w.defsPath, 'utf8'), before, 'nessuna mutazione al disco');
  } finally { w.cleanup(); }
});

test('definitions: cella persistita non valida (fuori home) carica ma espone needsRepair, disco invariato', async () => {
  const outside = tmpOutside(); // esiste ma NON sotto home
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncbi-nr-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  const command = path.join(home, 'bin', 'c'); fs.mkdirSync(path.dirname(command));
  fs.writeFileSync(command, '#!/bin/sh\n'); fs.chmodSync(command, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'claude', command, promptMode: 'send-keys' }],
    cells: [{ id: 'Orphan', cwd: outside, engine: 'claude', boot: false }],
  });
  const tmuxBin = path.join(root, 'fake-tmux.sh');
  fs.writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n'); fs.chmodSync(tmuxBin, 0o755);
  try {
    const fleet = await createBuiltinFleet({ home, fleetDefsPath: defsPath, tmuxBin });
    assert.equal(fleet.available, true, 'la cella non valida carica comunque (fail-closed leggibile)');
    const before = fs.readFileSync(defsPath, 'utf8');
    const cell = fleet.definitions().cells.find((c) => c.id === 'Orphan');
    assert.equal(cell.needsRepair, true);
    assert.equal(cell.cwdRel, undefined, 'nessun cwdRel derivabile per cella non portabile');
    assert.equal(fs.readFileSync(defsPath, 'utf8'), before, 'nessuna riscrittura on-read');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ===========================================================================
// 5. BACKUP v3 — roundtrip cross-home, legacy v1/v2, downgrade 0.8.27, no-omit
// ===========================================================================
test('backup v3: export non include cwd assoluta; roundtrip cross-home simulato', async () => {
  const { createFleetBackup, parseFleetBackup, restoreCellDefinition, FLEET_BACKUP_VERSION } = await fb();
  // Home A: una cella con cwdRel gia' derivato (come lo produrrebbe definitions())
  const backup = createFleetBackup(
    [{ id: 'Dev', cwdRel: 'work', engine: 'claude', boot: false, prompt: 'p' }],
    new Set(['Dev']), [], new Set(), new Date('2026-07-21T00:00:00Z'),
  );
  assert.equal(backup.version, FLEET_BACKUP_VERSION);
  const serialized = JSON.stringify(backup);
  assert.equal(serialized.includes('"cwd":'), false, 'zero cwd assoluta nel JSON');
  assert.equal(backup.cells[0].cwdRel, 'work');
  // parse roundtrip
  const parsed = parseFleetBackup(serialized);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cells[0].cwdRel, 'work');
  // restore definition portatile (cwdRel, nessun cwd)
  const def = restoreCellDefinition(parsed.cells[0], 'claude', ['claude']);
  assert.equal(def.cwdRel, 'work');
  assert.equal(def.cwd, undefined);
});

test('backup v3: roundtrip cross-home reale (cwdRel -> home diversa, nessun path del device A)', async () => {
  const { createFleetBackup, parseFleetBackup, restoreCellDefinition } = await fb();
  const homeA = tmpRoot(); const workA = path.join(homeA, 'work'); fs.mkdirSync(workA);
  const homeB = tmpRoot(); const workB = path.join(homeB, 'work'); fs.mkdirSync(workB);
  try {
    // Device A: fleet con cella in homeA/work -> definitions() deriverebbe cwdRel='work'
    const backup = createFleetBackup(
      [{ id: 'Dev', cwdRel: 'work', engine: 'claude', boot: false, prompt: '' }],
      new Set(['Dev']), [], new Set(), new Date('2026-07-21T00:00:00Z'),
    );
    const serialized = JSON.stringify(backup);
    assert.equal(serialized.includes(homeA), false, 'il backup non trasporta alcun path del device A');
    const parsed = parseFleetBackup(serialized);
    assert.equal(parsed.ok, true);
    // Device B: restore su home diversa, stessa struttura relativa
    const def = restoreCellDefinition(parsed.cells[0], 'claude', ['claude']);
    const command = path.join(homeB, 'bin', 'c'); fs.mkdirSync(path.dirname(command));
    fs.writeFileSync(command, '#!/bin/sh\n'); fs.chmodSync(command, 0o755);
    const defsPath = path.join(homeB, 'fleet.json');
    atomicWrite(defsPath, { schemaVersion: 1, engines: [{ id: 'claude', command, promptMode: 'send-keys' }], cells: [] });
    const tmuxBin = path.join(homeB, 'fake-tmux.sh');
    fs.writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n'); fs.chmodSync(tmuxBin, 0o755);
    const fleet = await createBuiltinFleet({ home: homeB, fleetDefsPath: defsPath, tmuxBin });
    await fleet.restoreCells([def]);
    const cell = fleet.definitions().cells.find((c) => c.id === 'Dev');
    assert.equal(cell.cwd, fs.realpathSync(workB), 'cwd ripristinata SOTTO homeB (portabile)');
    assert.equal(cell.cwdRel, 'work');
    assert.ok(!cell.cwd.startsWith(homeA), 'nessun path del device A');
  } finally {
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
  }
});

test('backup: legacy v1 (nexuscrew.cells) e v2 (nexuscrew.fleet) ancora parsati', async () => {
  const { parseFleetBackup } = await fb();
  const v1 = parseFleetBackup(JSON.stringify({
    format: 'nexuscrew.cells', version: 1,
    cells: [{ id: 'Dev', cwd: '/home/x/dev', engine: 'claude', systemPrompt: '' }],
  }));
  assert.equal(v1.ok, true);
  assert.equal(v1.legacy, true);
  assert.equal(v1.cells[0].cwd, '/home/x/dev');
  const v2 = parseFleetBackup(JSON.stringify({
    format: 'nexuscrew.fleet', version: 2, cells: [],
    engines: [{ id: 'custom', label: 'C', rc: false, command: '/usr/bin/c', args: [], envKeys: [], promptMode: 'send-keys' }],
  }));
  assert.equal(v2.ok, true);
  assert.equal(v2.legacy, true);
  assert.equal(v2.engines[0].id, 'custom');
});

test('backup v3: cella senza cwdRel -> invalid-cell; cella con cwd -> invalid-cell', async () => {
  const { parseFleetBackup, FLEET_BACKUP_FORMAT, FLEET_BACKUP_VERSION } = await fb();
  const noRel = parseFleetBackup(JSON.stringify({
    format: FLEET_BACKUP_FORMAT, version: FLEET_BACKUP_VERSION,
    cells: [{ id: 'Dev', engine: 'claude', systemPrompt: '' }], engines: [],
  }));
  assert.equal(noRel.ok, false);
  assert.equal(noRel.error, 'invalid-cell');
  const withCwd = parseFleetBackup(JSON.stringify({
    format: FLEET_BACKUP_FORMAT, version: FLEET_BACKUP_VERSION,
    cells: [{ id: 'Dev', cwd: '/home/x/dev', cwdRel: 'dev', engine: 'claude', systemPrompt: '' }], engines: [],
  }));
  assert.equal(withCwd.ok, false);
  assert.equal(withCwd.error, 'invalid-cell', 'v3 con cwd assoluta -> invalid-cell');
});

test('backup v3: versione 3 rifiutata da parser 0.8.27 simulato come invalid-format', async () => {
  const { createFleetBackup, FLEET_BACKUP_FORMAT } = await fb();
  const backup = createFleetBackup(
    [{ id: 'Dev', cwdRel: 'dev', engine: 'claude', boot: false, prompt: '' }],
    new Set(['Dev']), [], new Set(), new Date('2026-07-21T00:00:00Z'),
  );
  assert.equal(backup.version, 3);
  // Parser 0.8.27: accetta solo nexuscrew.fleet version 2 (o legacy v1).
  // Un backup v3 (version 3) NON e' leggibile -> downgrade fail-closed visibile.
  const parseAsNexuscrew0827 = (text) => {
    let value; try { value = JSON.parse(text); } catch (_) { return { ok: false, error: 'invalid-json' }; }
    const legacy = value?.format === 'nexuscrew.cells' && value?.version === 1;
    if (!legacy && (value?.format !== 'nexuscrew.fleet' || value?.version !== 2)) {
      return { ok: false, error: 'invalid-format' };
    }
    return { ok: true };
  };
  const result = parseAsNexuscrew0827(JSON.stringify(backup));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid-format', '0.8.27 rifiuta il backup v3 come invalid-format');
  assert.equal(FLEET_BACKUP_FORMAT, 'nexuscrew.fleet');
});

test('backup export: cella selezionata non portabile (senza cwdRel) -> errore esplicito, no silent omit', async () => {
  const { createFleetBackup } = await fb();
  // needsRepair: nessun cwdRel -> non esportabile in v3
  const backup = createFleetBackup(
    [{ id: 'Broken', engine: 'claude', boot: false, prompt: '' }],
    new Set(['Broken']), [], new Set(), new Date('2026-07-21T00:00:00Z'),
  );
  assert.equal(backup.ok, false);
  assert.equal(backup.error, 'invalid-cell');
  assert.ok(backup.invalidCellIds.includes('Broken'));
  assert.ok(!backup.cells, 'nessun backup parziale prodotto');
});

test('backup export: mista portabile + non portabile -> fail-closed sull\'invalida', async () => {
  const { createFleetBackup } = await fb();
  const backup = createFleetBackup([
    { id: 'Ok', cwdRel: 'dev', engine: 'claude', boot: false, prompt: '' },
    { id: 'Broken', engine: 'claude', boot: false, prompt: '' },
  ], new Set(['Ok', 'Broken']), [], new Set(), new Date('2026-07-21T00:00:00Z'));
  assert.equal(backup.ok, false);
  assert.equal(backup.error, 'invalid-cell');
  assert.equal(backup.invalidCellIds[0], 'Broken');
});
