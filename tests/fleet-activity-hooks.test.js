'use strict';
// tests/fleet-activity-hooks.test.js — D-340: gli hook di attivita' iniettati
// nella settings della cella.
//
// Il test che conta e' il primo: NESSUNA CELLA DEVE PARTIRE CON UNA SUPERFICIE
// MCP PIU' LARGA DI PRIMA. Si prova confrontando gli argomenti di lancio della
// stessa cella con e senza hook — stessa strada di codice, non una copia — e
// verificando che l'unica differenza sia la chiave `hooks`. Il deny, quando
// c'e', deve essere identico campo per campo.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDefinitions } = require('../lib/fleet/definitions.js');
const { resolveManagedEngine } = require('../lib/fleet/managed.js');

const ENGINE_CLAUDE = { id: 'ec', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } };

// Gli eventi registrati, quelli misurati su 2.1.280. `StopFailure` NON c'e':
// su quella versione non esiste.
const EVENTI = ['Notification', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit'];

function mondo(t, { utente = ['nexuscrew', 'webfetch', 'nextcloud'] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d340-hook-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const mcpServers = {};
  for (const nome of utente) mcpServers[nome] = { command: nome };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers }), { mode: 0o600 });
  const cwd = path.join(home, 'lavoro');
  fs.mkdirSync(cwd);
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, cwd, filesRoot };
}

function risolvi(m, cell, cfg = {}) {
  return resolveManagedEngine(ENGINE_CLAUDE, cell, {
    home: m.home, env: {}, filesRoot: m.filesRoot, activityGeneration: 'gen-1', ...cfg,
  });
}

function settingsDi(args) {
  const trovati = args.filter((a) => a.startsWith('--settings='));
  assert.ok(trovati.length <= 1, `un solo --settings, trovati ${trovati.length}`);
  return trovati.length ? JSON.parse(trovati[0].slice('--settings='.length)) : null;
}

// --- il confronto prima/dopo ----------------------------------------------

test('strict: stesso argv, deny identico, solo la chiave hooks in piu', (t) => {
  const m = mondo(t);
  const cell = { id: 'Dev', cwd: m.cwd, engine: 'ec', tmuxSession: 'cloud-Dev', capabilities: { mcp: ['nexuscrew', 'webfetch'] } };
  const prima = risolvi(m, cell, { activityHooks: false });
  const dopo = risolvi(m, cell);
  assert.equal(prima.ok, true, prima.reason);
  assert.equal(dopo.ok, true, dopo.reason);

  // Il ramo strict oggi NON emetteva alcun --settings: ne nasce uno che porta
  // SOLO gli hook, e nient'altro.
  assert.equal(settingsDi(prima.engine.args), null, 'prima: nessuna settings nel ramo strict');
  const con = settingsDi(dopo.engine.args);
  assert.deepEqual(Object.keys(con).sort(), ['hooks']);
  assert.equal(con.permissions, undefined, 'nessun permissions aggiunto dove non c\'era: la superficie la chiude --strict-mcp-config');
  assert.deepEqual(Object.keys(con.hooks).sort(), EVENTI);

  // Il resto dell'argv e' INVARIATO, e la superficie MCP pure.
  assert.deepEqual(dopo.engine.args.filter((a) => !a.startsWith('--settings=')), prima.engine.args.filter((a) => !a.startsWith('--settings=')),
    'a parita' + ' di hooks l\'argv e\' identico');
  assert.ok(dopo.engine.args.includes('--strict-mcp-config'), 'la strict resta');
});

test('legacy con mcp: deny identico, solo la chiave hooks in piu', (t) => {
  const m = mondo(t);
  const cell = { id: 'Dev', cwd: m.cwd, engine: 'ec', tmuxSession: 'cloud-Dev', mcp: ['nexuscrew'] };
  const prima = risolvi(m, cell, { activityHooks: false });
  const dopo = risolvi(m, cell);
  const senzaHook = settingsDi(prima.engine.args);
  const con = settingsDi(dopo.engine.args);
  assert.ok(senzaHook && senzaHook.permissions, 'prima: la settings del deny c\'e');
  assert.deepEqual(con.permissions, senzaHook.permissions, 'deny IDENTICO');
  const { hooks, ...resto } = con;
  assert.deepEqual(resto, senzaHook, 'nient\'altro che la chiave hooks');
  assert.deepEqual(Object.keys(hooks).sort(), EVENTI);
  assert.deepEqual(dopo.engine.args.filter((a) => !a.startsWith('--settings=')), prima.engine.args.filter((a) => !a.startsWith('--settings=')));
});

test('legacy senza mcp: dove non c\'era alcuna settings, nasce quella dei soli hook', (t) => {
  const m = mondo(t);
  const cell = { id: 'Dev', cwd: m.cwd, engine: 'ec', tmuxSession: 'cloud-Dev' };
  const prima = risolvi(m, cell, { activityHooks: false });
  const dopo = risolvi(m, cell);
  assert.equal(settingsDi(prima.engine.args), null, 'prima: nessuna settings (mcp assente)');
  const con = settingsDi(dopo.engine.args);
  assert.deepEqual(Object.keys(con).sort(), ['hooks']);
  assert.deepEqual(dopo.engine.args.filter((a) => !a.startsWith('--settings=')), prima.engine.args.filter((a) => !a.startsWith('--settings=')));
});

test('legacy con mcp vuoto: il jolly deny resta il jolly deny', (t) => {
  const m = mondo(t);
  const cell = { id: 'Dev', cwd: m.cwd, engine: 'ec', tmuxSession: 'cloud-Dev', mcp: [] };
  const prima = risolvi(m, cell, { activityHooks: false });
  const dopo = risolvi(m, cell);
  assert.deepEqual(settingsDi(prima.engine.args).permissions.deny, ['mcp__*']);
  assert.deepEqual(settingsDi(dopo.engine.args).permissions.deny, ['mcp__*'], 'il caso esatto non si allarga');
});

// --- dove gli hook NON vanno ----------------------------------------------

test('cella senza sessione tmux: nessun hook (non c\'e dove scrivere)', (t) => {
  const m = mondo(t);
  const r = risolvi(m, { id: 'Dev', cwd: m.cwd, engine: 'ec' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.activityDir, null);
  assert.equal(r.engine.args.some((a) => a.includes('nc-activity-hook')), false);
});

test('motori non-Claude: nessun hook, restano senza canale', (t) => {
  const m = mondo(t);
  // Il binario del client deve esistere, o la risoluzione si ferma prima
  // (fail-closed sul client assente) e il test non proverebbe nulla sugli hook.
  fs.writeFileSync(path.join(m.home, '.local', 'bin', 'codex-vl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const defs = parseDefinitions({
    schemaVersion: 1,
    engines: [{ id: 'ev', label: 'VL', managed: { client: 'codex-vl', provider: 'ollama-cloud', model: 'deepseek-v4.1-flash' } }],
    cells: [{ id: 'Dev', cwd: m.cwd, engine: 'ev', tmuxSession: 'cloud-Dev' }],
  });
  assert.ok(defs, 'documento valido');
  const r = resolveManagedEngine(defs.engines[0], defs.cells[0],
    { home: m.home, env: { OLLAMA_API_KEY: 'k' }, filesRoot: m.filesRoot, activityGeneration: 'gen-1' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.activityDir, null);
  assert.equal(r.engine.args.some((a) => a.includes('nc-activity-hook')), false);
});

// --- il comando degli hook ------------------------------------------------

test('ogni hook e un solo token, con evento, directory di sessione e generazione', (t) => {
  const m = mondo(t);
  const r = risolvi(m, { id: 'Dev', cwd: m.cwd, engine: 'ec', tmuxSession: 'cloud-Dev' });
  const con = settingsDi(r.engine.args);
  assert.equal(r.activityDir, path.join(m.filesRoot, 'cloud-Dev'));
  const stop = con.hooks.Stop[0].hooks[0];
  assert.equal(stop.type, 'command');
  assert.ok(stop.command.startsWith("'/"), 'il percorso dell\'interprete e quotato');
  assert.ok(stop.command.includes('nc-activity-hook.js'));
  assert.ok(stop.command.includes("--event 'Stop'"));
  assert.ok(stop.command.includes(`--dir '${path.join(m.filesRoot, 'cloud-Dev')}'`));
  assert.ok(stop.command.includes("--gen 'gen-1'"));
  // Il matcher e' la forma MISURATA, e solo dove e' stata misurata.
  assert.equal(con.hooks.PreToolUse[0].matcher, '*');
  assert.equal(con.hooks.PostToolUse[0].matcher, '*');
  for (const evento of ['Stop', 'SessionStart', 'Notification', 'PermissionRequest', 'SubagentStop', 'SessionEnd', 'UserPromptSubmit']) {
    assert.equal(con.hooks[evento][0].matcher, undefined, `${evento} senza matcher: non misurato`);
  }
  assert.equal(con.hooks.StopFailure, undefined, 'StopFailure non esiste su 2.1.280');
});

test('senza generazione il comando non porta --gen', (t) => {
  const m = mondo(t);
  const r = risolvi(m, { id: 'Dev', cwd: m.cwd, engine: 'ec', tmuxSession: 'cloud-Dev' }, { activityGeneration: null });
  assert.ok(r.ok, r.reason);
  assert.equal(settingsDi(r.engine.args).hooks.Stop[0].hooks[0].command.includes('--gen'), false);
});

test('un nome di sessione con apice o spazio non spezza il comando', (t) => {
  const m = mondo(t);
  const r = risolvi(m, { id: 'Dev', cwd: m.cwd, engine: 'ec', tmuxSession: "a b'c" });
  const cmd = settingsDi(r.engine.args).hooks.Stop[0].hooks[0].command;
  // La forma POSIX: chiudo, escape, riapro. Nessun apice nudo.
  assert.ok(cmd.includes(`--dir '${path.join(m.filesRoot, "a b")}'\\''c'`), `quoting errato: ${cmd}`);
});

// --- il fail-closed resta intatto -----------------------------------------

test('con gli hook attivi il ramo strict resta fail-closed su una capability sconosciuta', (t) => {
  const m = mondo(t);
  const cell = { id: 'Dev', cwd: m.cwd, engine: 'ec', tmuxSession: 'cloud-Dev', capabilities: { mcp: ['mai-dichiarato'] } };
  const r = risolvi(m, cell);
  assert.equal(r.ok, false, 'una capability che il client non definisce non deve partire');
  assert.ok(r.mcpCellRefused, 'il motivo e nominato');
  assert.equal(r.mcpCellRefusedCode, 'CAPABILITY_UNKNOWN_NAME');
});

test('la risoluzione non scrive nulla: la generazione la scrive il launcher', (t) => {
  const m = mondo(t);
  resolveManagedEngine(ENGINE_CLAUDE, { id: 'Dev', cwd: m.cwd, engine: 'ec', tmuxSession: 'cloud-Dev' },
    { home: m.home, env: {}, filesRoot: m.filesRoot, activityGeneration: 'gen-1' });
  assert.equal(fs.existsSync(path.join(m.filesRoot, 'cloud-Dev')), false,
    'resolve decide gli argomenti, non tocca il disco: la directory la crea il launcher');
});

// --- il documento parla di celle reali ------------------------------------

test('la cella di un documento reale porta gli hook nel proprio argv', (t) => {
  const m = mondo(t);
  const defs = parseDefinitions({
    schemaVersion: 1,
    engines: [{ id: 'ec', label: 'Claude', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } }],
    cells: [{ id: 'Dev', cwd: m.cwd, engine: 'ec', tmuxSession: 'cloud-Dev' }],
  });
  assert.ok(defs, 'documento valido');
  const r = resolveManagedEngine(defs.engines[0], defs.cells[0], { home: m.home, env: {}, filesRoot: m.filesRoot });
  assert.equal(r.ok, true, r.reason);
  assert.ok(settingsDi(r.engine.args).hooks, 'gli hook arrivano fino all\'argv della cella');
});
