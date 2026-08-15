'use strict';
// desktop.local: engine predefinito (non-managed) che entra in un container
// desktop via `docker exec` e precompila panelUrl al pannello noVNC/KasmVNC del
// container. Il valore precompilato resta sovrascrivibile per-cella (D8 backend,
// NexusCrew 0.8.53).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDefinitions } = require('../lib/fleet/definitions.js');
const { defaultDesktopEngine, backfillDesktopEngine } = require('../lib/fleet/builtin.js');
const { loadDefinitions, atomicWrite } = require('../lib/fleet/definitions.js');

test('defaultDesktopEngine: comando esatto che entra nel container, panelUrl precompilato', () => {
  const eng = defaultDesktopEngine();
  assert.equal(eng.id, 'desktop.local');
  assert.equal(eng.command, 'docker');
  assert.deepEqual(eng.args, ['exec', '-it', '-u', 'abc', 'ai-desktop', 'bash']);
  assert.equal(eng.promptMode, 'send-keys');
  assert.equal(eng.panelUrl, 'https://127.0.0.1:6901');
  // -u abc non e' un dettaglio: senza, si entra come root e Chromium nel
  // container rifiuta di partire.
  assert.ok(eng.args.includes('-u') && eng.args[eng.args.indexOf('-u') + 1] === 'abc');
});

test('desktop.local: il campo panelUrl arriva valorizzato attraverso parseDefinitions', () => {
  const def = { schemaVersion: 1, engines: [defaultDesktopEngine()], cells: [{ id: 'Desk', cwd: '/tmp', engine: 'desktop.local' }] };
  const parsed = parseDefinitions(def);
  assert.ok(parsed, 'definizione con desktop.local valida');
  assert.equal(parsed.engines[0].panelUrl, 'https://127.0.0.1:6901');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.cells[0], 'panelUrl'), false,
    'la cella non eredita automaticamente panelUrl in fase di parse: e\' un campo suo, opzionale');
});

test('desktop.local: una cella puo\' sovrascrivere il panelUrl precompilato con uno proprio', () => {
  const def = {
    schemaVersion: 1,
    engines: [defaultDesktopEngine()],
    cells: [{ id: 'Desk', cwd: '/tmp', engine: 'desktop.local', panelUrl: 'https://localhost:6901' }],
  };
  const parsed = parseDefinitions(def);
  assert.ok(parsed);
  assert.equal(parsed.engines[0].panelUrl, 'https://127.0.0.1:6901', 'default engine invariato');
  assert.equal(parsed.cells[0].panelUrl, 'https://localhost:6901', 'override per-cella preservato, distinto dal default');
});

test('backfillDesktopEngine: idempotente, non distruttivo su collisione id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdesktopbf-'));
  try {
    const dp = (engines) => {
      const p = path.join(root, `f-${Math.random().toString(36).slice(2)}.json`);
      atomicWrite(p, { schemaVersion: 1, engines, cells: [] });
      return p;
    };
    const base = [{ id: 'claude.native', label: 'Claude', rc: true, managed: { client: 'claude', provider: 'native', permissionPolicy: 'unsafe' } }];
    const p1 = dp(base);
    const a1 = backfillDesktopEngine(p1, loadDefinitions(p1));
    assert.ok(a1.engines.some((e) => e.id === 'desktop.local'));
    const desk = a1.engines.find((e) => e.id === 'desktop.local');
    assert.equal(desk.panelUrl, 'https://127.0.0.1:6901');
    assert.deepEqual(desk.args, ['exec', '-it', '-u', 'abc', 'ai-desktop', 'bash']);
    // idempotente
    const a1b = backfillDesktopEngine(p1, a1);
    assert.equal(a1b.engines.filter((e) => e.id === 'desktop.local').length, 1);
    // collisione id: engine custom con id desktop.local -> preservato, non sovrascritto
    const p2 = dp([{ id: 'desktop.local', label: 'Custom', command: '/bin/x', args: [], promptMode: 'flag', promptFlag: '-p' }]);
    const a2 = backfillDesktopEngine(p2, loadDefinitions(p2));
    assert.equal(a2.engines.length, 1);
    assert.equal(a2.engines[0].command, '/bin/x', 'collisione: custom desktop.local preservato');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
