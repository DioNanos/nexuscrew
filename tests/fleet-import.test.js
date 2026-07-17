'use strict';
// Reconciliation di una sessione tmux non gestita (es. "jarvis") in una cella
// NexusCrew persistita in fleet.json.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { loadDefinitions } = require('../lib/fleet/definitions.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ncimp-')); }

// fleet.json con un engine gestito (nessuna invenzione al import).
async function makeBuiltin(dir, sessionNames = ['jarvis', 'other', 'cloud-Foo']) {
  const defsPath = path.join(dir, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [
      { id: 'claude.native', label: 'Claude', managed: { client: 'claude', provider: 'native', model: '' } },
      { id: 'pi.openrouter', label: 'Pi', managed: { client: 'pi', provider: 'openrouter', model: 'x' } },
    ],
    cells: [],
  }), { mode: 0o600 });
  fs.chmodSync(defsPath, 0o600);
  const sessionsPath = path.join(dir, 'tmux-sessions');
  fs.writeFileSync(sessionsPath, `${sessionNames.join('\n')}${sessionNames.length ? '\n' : ''}`);
  const tmuxBin = path.join(dir, 'fake-tmux.sh');
  const safeSessionsPath = sessionsPath.replace(/'/g, "'\\''");
  fs.writeFileSync(tmuxBin, `#!/bin/sh\nif [ "$1" = "list-sessions" ]; then cat '${safeSessionsPath}'; fi\nexit 0\n`, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  const fleet = await createBuiltinFleet({ home: dir, fleetDefsPath: defsPath, tmuxBin });
  return { fleet, defsPath, sessionsPath };
}

test('import-cell: jarvis (tmuxSession non canonica) diventa cella gestita, round-trip', async () => {
  const dir = tmp();
  try {
    const { fleet, defsPath } = await makeBuiltin(dir);
    const r = await fleet.importCell({ tmuxSession: 'jarvis', engine: 'claude.native' });
    assert.equal(r.imported, true);
    assert.equal(r.id, 'jarvis');
    const defs = loadDefinitions(defsPath);
    const cell = defs.cells.find((c) => c.id === 'jarvis');
    assert.ok(cell, 'cella jarvis persistita');
    assert.equal(cell.engine, 'claude.native');
    assert.equal(cell.tmuxSession, 'jarvis', 'tmuxSession non canonica ammessa e round-trip');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import-cell: idempotente (stessa tmuxSession -> no-op, nessun duplicato)', async () => {
  const dir = tmp();
  try {
    const { fleet, defsPath } = await makeBuiltin(dir);
    await fleet.importCell({ tmuxSession: 'jarvis', engine: 'claude.native' });
    const again = await fleet.importCell({ tmuxSession: 'jarvis', engine: 'claude.native' });
    assert.equal(again.idempotent, true);
    const defs = loadDefinitions(defsPath);
    assert.equal(defs.cells.filter((c) => c.tmuxSession === 'jarvis').length, 1, 'una sola cella per sessione');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import-cell: engine NON dichiarato -> rifiuto (nessuna invenzione)', async () => {
  const dir = tmp();
  try {
    const { fleet } = await makeBuiltin(dir);
    await assert.rejects(() => fleet.importCell({ tmuxSession: 'jarvis', engine: 'codex.something' }), (e) => {
      assert.equal(e.status, 400);
      return /non dichiarato/.test(e.message);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import-cell: rifiuta un nome valido che non corrisponde a una sessione tmux viva', async () => {
  const dir = tmp();
  try {
    const { fleet, defsPath } = await makeBuiltin(dir, ['jarvis']);
    await assert.rejects(() => fleet.importCell({ tmuxSession: 'phantom', engine: 'claude.native' }), (e) => {
      assert.equal(e.status, 404);
      return /non trovata/.test(e.message);
    });
    assert.equal(loadDefinitions(defsPath).cells.length, 0, 'nessuna definizione fantasma persistita');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('policy per-cell: il provider builtin non persiste unsafe su Pi', async () => {
  const dir = tmp();
  try {
    const { fleet, defsPath } = await makeBuiltin(dir, ['jarvis']);
    await fleet.importCell({ tmuxSession: 'jarvis', engine: 'claude.native' });
    await assert.rejects(
      () => fleet.engine('jarvis', 'pi.openrouter', { permissionPolicy: 'unsafe' }),
      (e) => e.status === 400 && /Pi/.test(e.message),
    );
    const cell = loadDefinitions(defsPath).cells[0];
    assert.equal(cell.engine, 'claude.native', 'la transizione rifiutata non altera la cella');
    assert.equal(cell.permissionPolicies?.['pi.openrouter'], undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import-cell: sessione legacy cloud-Foo viene adottata come cella Foo', async () => {
  const dir = tmp();
  try {
    const { fleet, defsPath } = await makeBuiltin(dir);
    const r = await fleet.importCell({ tmuxSession: 'cloud-Foo', engine: 'claude.native' });
    assert.equal(r.id, 'Foo');
    const cell = loadDefinitions(defsPath).cells.find((c) => c.id === 'Foo');
    assert.equal(cell.tmuxSession, 'cloud-Foo');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import-cell: cloud-Foo con id esplicito diverso resta un alias vietato', async () => {
  const dir = tmp();
  try {
    const { fleet } = await makeBuiltin(dir);
    await assert.rejects(
      () => fleet.importCell({ tmuxSession: 'cloud-Foo', id: 'Other', engine: 'claude.native' }),
      (e) => e.status === 400,
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import-cell: id esplicito duplicato -> 409 conflitto', async () => {
  const dir = tmp();
  try {
    const { fleet } = await makeBuiltin(dir);
    await fleet.importCell({ tmuxSession: 'jarvis', engine: 'claude.native' });
    await assert.rejects(() => fleet.importCell({ tmuxSession: 'other', id: 'jarvis', engine: 'claude.native' }), (e) => {
      assert.equal(e.status, 409);
      return true;
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
