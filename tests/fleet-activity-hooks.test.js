'use strict';
// tests/fleet-activity-hooks.test.js — gli hook di attivita' iniettati
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
const { EVENTI_CODEX } = require('../lib/fleet/codex-hooks.js');
const { leggiAttivita, scriviStato, scriviGenerazione, NOME_GENERAZIONE } = require('../lib/files/activity.js');

const ENGINE_CLAUDE = { id: 'ec', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } };

// Gli eventi registrati, quelli misurati su 2.1.280. `StopFailure` NON c'e':
// su quella versione non esiste.
const EVENTI = ['Notification', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit'];

function mondo(t, { utente = ['nexuscrew', 'webfetch', 'nextcloud'] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cell-home-'));
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

test('motori senza canale: pi, shell e un codex non provato non prendono hook', (t) => {
  const m = mondo(t);
  // Il binario del client deve esistere, o la risoluzione si ferma prima
  // (fail-closed sul client assente) e il test non proverebbe nulla sugli hook.
  // `codex-vl` risponde con una versione NON provata: il gate non inietta.
  fs.writeFileSync(path.join(m.home, '.local', 'bin', 'codex-vl'), '#!/bin/sh\necho "codex-cli 9.9.9"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(m.home, '.local', 'bin', 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const defs = parseDefinitions({
    schemaVersion: 1,
    engines: [
      { id: 'ev', label: 'VL', managed: { client: 'codex-vl', provider: 'ollama-cloud', model: 'deepseek-v4.1-flash' } },
      { id: 'ep', label: 'Pi', managed: { client: 'pi', provider: 'openrouter', model: 'openai/gpt-5', permissionPolicy: 'standard' } },
      { id: 'es', label: 'Shell', managed: { client: 'shell', provider: 'local', model: '', permissionPolicy: 'standard' } },
    ],
    cells: [
      { id: 'Dev', cwd: m.cwd, engine: 'ev', tmuxSession: 'cloud-Dev' },
      { id: 'Pi', cwd: m.cwd, engine: 'ep', tmuxSession: 'cloud-Pi' },
      { id: 'Sh', cwd: m.cwd, engine: 'es', tmuxSession: 'cloud-Sh' },
    ],
  });
  assert.ok(defs, 'documento valido');
  const cfg = { home: m.home, env: { OLLAMA_API_KEY: 'k', OPENAI_API_KEY: 'k' }, filesRoot: m.filesRoot, activityGeneration: 'gen-1' };
  for (const [nome, indice] of [['codex-vl non provato', 0], ['pi', 1], ['shell', 2]]) {
    const r = resolveManagedEngine(defs.engines[indice], defs.cells[indice], cfg);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.engine.args.some((a) => a.includes('nc-activity-hook')), false, `${nome}: nessun canale`);
  }
});

// --- il gate di versione guarda il binario della CELLA, non il PATH --------
//
// Il gate esegue il binario RISOLTO per la cella — lo stesso che finisce in
// argv — non il nome del client cercato nel PATH del processo. Sono due
// eseguibili diversi appena la cella ne sceglie un altro, ed e' esattamente il
// caso che la guardia deve distinguere: la guardia esiste per non far fermare
// una cella su un dialogo di revisione, e una guardia che ne guarda un altro
// da' il via libera sbagliato.

function binarioFinto(m, client, corpo) {
  fs.writeFileSync(path.join(m.home, '.local', 'bin', client), corpo, { mode: 0o755 });
}

function risolviCodex(m, client, provider, extra = {}) {
  const defs = parseDefinitions({
    schemaVersion: 1,
    engines: [{ id: 'ex', label: 'X', managed: { client, provider, model: 'deepseek-v4.1-flash' } }],
    cells: [{ id: 'Dev', cwd: m.cwd, engine: 'ex', tmuxSession: 'cloud-Dev' }],
  });
  assert.ok(defs, 'documento valido');
  const r = resolveManagedEngine(defs.engines[0], defs.cells[0],
    { home: m.home, env: { OLLAMA_API_KEY: 'k', OPENAI_API_KEY: 'k' }, filesRoot: m.filesRoot, activityGeneration: 'gen-1', ...extra });
  assert.equal(r.ok, true, r.reason);
  return r;
}

const hookDi = (r) => r.engine.args.filter((a) => a.includes('nc-activity-hook'));

test('versione NON provata nel binario della cella: nessun hook', (t) => {
  const m = mondo(t);
  binarioFinto(m, 'codex', '#!/bin/sh\necho "codex-cli 9.9.9"\n');
  assert.equal(hookDi(risolviCodex(m, 'codex', 'openai-api')).length, 0);
});

test('versione provata nel binario della cella: un hook per evento', (t) => {
  const m = mondo(t);
  binarioFinto(m, 'codex', '#!/bin/sh\necho "codex-cli 0.156.1"\n');
  assert.equal(hookDi(risolviCodex(m, 'codex', 'openai-api')).length, EVENTI_CODEX.length);
});

test('codex-vl con la sua versione provata: hook presenti', (t) => {
  const m = mondo(t);
  binarioFinto(m, 'codex-vl', '#!/bin/sh\necho "codex-cli 0.155.1"\n');
  assert.equal(hookDi(risolviCodex(m, 'codex-vl', 'ollama-cloud')).length, EVENTI_CODEX.length);
});

test('binario che esce senza output: versione non determinabile, nessun hook', (t) => {
  const m = mondo(t);
  binarioFinto(m, 'codex', '#!/bin/sh\nexit 0\n');
  assert.equal(hookDi(risolviCodex(m, 'codex', 'openai-api')).length, 0);
});

// --- la generazione va pubblicata anche per codex -------------------------
//
// Il launcher scrive `activity.gen` solo se `activityDir` e' valorizzato. Se
// per codex restava null, sul disco rimaneva la generazione di un lancio
// precedente e il lettore scartava TUTTI gli eventi nuovi (generazioni
// diverse): la cella sarebbe rimasta «non verificata» per sempre, senza che
// niente lo dicesse.

test('cella codex provata: activityDir valorizzato, e la generazione nuova fa leggere gli eventi', (t) => {
  const m = mondo(t);
  binarioFinto(m, 'codex', '#!/bin/sh\necho "codex-cli 0.156.1"\n');
  const r = risolviCodex(m, 'codex', 'openai-api');
  assert.equal(hookDi(r).length, EVENTI_CODEX.length);
  assert.notEqual(r.activityDir, null, 'la generazione va pubblicata anche per codex');
  assert.equal(r.activityDir, path.join(m.filesRoot, 'cloud-Dev'));

  // Il launcher pubblica la generazione (runtime.js) e poi l'evento arriva.
  scriviGenerazione(r.activityDir, 'gen-1');
  scriviStato(r.activityDir, { evento: 'UserPromptSubmit', generazione: 'gen-1' });
  const letto = leggiAttivita(m.filesRoot, 'cloud-Dev');
  assert.ok(letto, 'l\'evento scritto con la generazione corrente si legge');
  assert.equal(letto.stato, 'lavora');

  // E la generazione conta: con quella di un lancio precedente l'evento e'
  // scartato. E' la barriera fra lanci, non un'ipotesi.
  scriviGenerazione(r.activityDir, 'gen-vecchia');
  assert.equal(leggiAttivita(m.filesRoot, 'cloud-Dev'), null, 'generazione diversa = evento di un altro lancio');
});

test('cella codex NON provata: nessun hook e nessuna generazione da pubblicare', (t) => {
  const m = mondo(t);
  binarioFinto(m, 'codex', '#!/bin/sh\necho "codex-cli 9.9.9"\n');
  const r = risolviCodex(m, 'codex', 'openai-api');
  assert.equal(hookDi(r).length, 0);
  assert.equal(r.activityDir, null, 'nel fail-closed non c\'e\' niente da pubblicare');
});

// --- portabilita': dove la chiave di fiducia non e' quella che generiamo --

test('su win32 e su termux nessun hook, anche con la versione provata', (t) => {
  const m = mondo(t);
  binarioFinto(m, 'codex', '#!/bin/sh\necho "codex-cli 0.156.1"\n');
  for (const [nome, extra] of [['win32', { platform: 'win32' }], ['termux', { platform: 'android' }]]) {
    const r = risolviCodex(m, 'codex', 'openai-api', extra);
    assert.equal(hookDi(r).length, 0, `${nome}: nessun hook`);
    assert.equal(r.activityDir, null, `${nome}: nessuna generazione pubblicata`);
  }
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

test('la risoluzione NON scrive la generazione: la mette negli argv e nel canale', (t) => {
  // La scrittura di `activity.gen` e' di `cell-exec`, che gira DENTRO la
  // sessione tmux creata — quindi solo per chi vince la new-session — e la fa
  // PRIMA di avviare il client. Qui si verifica l'altra meta': la risoluzione
  // non tocca il disco, e mette la generazione dove cell-exec la trovera'.
  const m = mondo(t);
  const cell = { id: 'Dev', cwd: m.cwd, engine: 'ec', tmuxSession: 'cloud-Dev' };
  const r = resolveManagedEngine(ENGINE_CLAUDE, cell, {
    home: m.home, env: {}, filesRoot: m.filesRoot, activityGeneration: 'gen-1',
  });
  assert.equal(fs.existsSync(path.join(m.filesRoot, 'cloud-Dev')), false,
    'la risoluzione NON crea nemmeno la directory della sessione');
  assert.equal(r.activityDir, path.join(m.filesRoot, 'cloud-Dev'),
    'il canale c\'e\': dice a cell-exec DOVE scrivere, e viaggia nel payload');
  const hooks = settingsDi(r.engine.args).hooks;
  assert.ok(hooks, 'gli hook ci sono');
  assert.match(JSON.stringify(hooks), /--gen 'gen-1'/,
    'la generazione viaggia negli argv: e\' quella che cell-exec scrivera\' su disco');

  // Il seam della vecchia pubblicazione non esiste piu'. Passarlo non deve
  // cambiare niente e — soprattutto — NON deve scrivere: una scrittura nascosta
  // qui rimetterebbe il difetto (la generazione del perdente sul disco).
  let chiamato = false;
  const conSeam = resolveManagedEngine(ENGINE_CLAUDE, cell, {
    home: m.home, env: {}, filesRoot: m.filesRoot, activityGeneration: 'gen-2',
    pubblicaGenerazione: () => { chiamato = true; return true; },
  });
  assert.equal(chiamato, false, 'il seam non viene piu\' chiamato');
  assert.equal(fs.existsSync(path.join(m.filesRoot, 'cloud-Dev')), false, 'e non si scrive');
  assert.ok(settingsDi(conSeam.engine.args).hooks);
});

test('gli hook si iniettano lo stesso: la scrittura non puo\' piu\' farli saltare', (t) => {
  // Prima la generazione si pubblicava qui, e se la scrittura falliva NON si
  // iniettavano gli hook: era il modo di non illudere nessuno. Il disegno nuovo
  // toglie quella scrittura dalla risoluzione, quindi non c'e' piu' un esito da
  // leggere: gli hook si iniettano sempre, e se la scrittura fallira' lo dira'
  // `cell-exec` (log + client avviato lo stesso, stato «non verificato» — vedi
  // tests/fleet-cell-exec.test.js).
  const m = mondo(t);
  const cell = { id: 'Dev', cwd: m.cwd, engine: 'ec', tmuxSession: 'cloud-Dev' };
  const r = resolveManagedEngine(ENGINE_CLAUDE, cell, {
    home: m.home, env: {}, filesRoot: m.filesRoot, activityGeneration: 'gen-1',
  });
  assert.ok(r.ok, 'la cella si risolve');
  assert.ok((settingsDi(r.engine.args) || {}).hooks, 'gli hook ci sono');
  assert.equal(r.activityDir, path.join(m.filesRoot, 'cloud-Dev'), 'e il canale pure');
});

test('vale anche per codex: hook e canale, nessuna scrittura dalla risoluzione', (t) => {
  const m = mondo(t);
  binarioFinto(m, 'codex', '#!/bin/sh\necho "codex-cli 0.156.1"\n');
  const r = risolviCodex(m, 'codex', 'openai-api');
  assert.ok(hookDi(r).length > 0, 'versione provata: gli hook ci sono');
  assert.equal(r.activityDir, path.join(m.filesRoot, 'cloud-Dev'));
  assert.equal(fs.existsSync(path.join(m.filesRoot, 'cloud-Dev', NOME_GENERAZIONE)), false,
    'e niente su disco');
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
