'use strict';
// B4.2 — test del fleet built-in (lib/fleet/builtin.js) + provider selection.
// Nessun tmux reale: un fake-tmux (script generato) registra le invocazioni.
// Vincoli rispettati: testa SOLO builtin/provider; non tocca index/definitions/server.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const {
  createBuiltinFleet, composeLaunchArgv, minimalEnv, promptCharsOk, redactSecrets,
} = require('../lib/fleet/builtin.js');
const { selectProvider } = require('../lib/fleet/provider.js');

const FAKE_FLEET = path.join(__dirname, 'fixtures', 'fake-fleet.sh'); // external fidato

// --- Fixture: una definizione valida (engine fidato + cella reale sotto home) ---
function makeWorld(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncbi-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const cwd = path.join(home, 'Dev'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, 'bin'));
  const command = path.join(home, 'bin', 'myclaude');
  fs.writeFileSync(command, '#!/bin/sh\necho hi\n'); fs.chmodSync(command, 0o755);

  const defsPath = path.join(root, 'fleet.json');
  const def = {
    schemaVersion: 1,
    engines: [{
      id: 'claude', label: 'Claude', rc: true,
      command,
      args: ['--dangerously-skip-permissions'],
      env: { ANTHROPIC_API_KEY: 'sk-x' },
      model: { flag: '--model', value: 'sonnet' },
      promptMode: over.promptMode || 'flag',
      ...(over.promptMode === 'send-keys' ? {} : { promptFlag: '--append-system-prompt' }),
    }],
    cells: [{
      id: 'Dev', tmuxSession: 'work-build', cwd, engine: 'claude', boot: true,
      ...(over.cellModel !== undefined ? { model: over.cellModel } : {}),
      ...(over.cellPrompt !== undefined ? { prompt: over.cellPrompt } : { prompt: 'you are a dev agent' }),
    }],
  };
  atomicWrite(defsPath, def);

  // fake-tmux: registra le chiamate; has-session/readiness via file di controllo.
  const log = path.join(root, 'tmux.log');
  const cap = path.join(root, 'cap'); fs.mkdirSync(cap);
  const alive = path.join(root, 'alive'); fs.writeFileSync(alive, '1');   // vivo di default
  const sessions = path.join(root, 'sessions'); fs.writeFileSync(sessions, '');
  // veleno: se non vuoto, new-session cat-ta il contenuto su STDERR ed esce 2
  // (simula un tmux fallito che ecoa i segreti del comando lanciato — test §9h).
  const poison = path.join(root, 'poison'); fs.writeFileSync(poison, '');
  const tmuxBin = path.join(root, 'fake-tmux.sh');
  const script = `#!/bin/sh
LOG=${shellQ(log)}
CAP=${shellQ(cap)}
ALIVE=${shellQ(alive)}
SESS=${shellQ(sessions)}
POISON=${shellQ(poison)}
cmd="\${1:-}"; [ $# -gt 0 ] && shift
case "$cmd" in
  has-session)
    [ -f "$ALIVE" ] && [ "\$(cat "$ALIVE" 2>/dev/null)" = "0" ] && exit 1
    exit 0 ;;
  list-sessions)
    [ -f "$SESS" ] && cat "$SESS"
    exit 0 ;;
  kill-session)
    echo "kill-session" >> "$LOG"; exit 0 ;;
  new-session)
    env > "$CAP/launch-env.txt" 2>/dev/null || true
    printf '%s\\t' "new-session" >> "$LOG"; printf '%s\\t' "$@" >> "$LOG"; printf '\\n' >> "$LOG"
    if [ -s "$POISON" ]; then cat "$POISON" >&2; exit 2; fi
    exit 0 ;;
  load-buffer)
    buf=""; file=""
    while [ $# -gt 0 ]; do
      case "$1" in -b) buf="$2"; shift 2 ;; *) file="$1"; shift ;; esac
    done
    echo "load-buffer buf=$buf" >> "$LOG"
    [ -n "$file" ] && [ -f "$file" ] && cp "$file" "$CAP/prompt.txt" 2>/dev/null || true
    exit 0 ;;
  paste-buffer)
    echo "paste-buffer $*" >> "$LOG"; exit 0 ;;
  delete-buffer)
    echo "delete-buffer $*" >> "$LOG"; exit 0 ;;
  *)
    echo "unknown:$cmd" >> "$LOG"; exit 0 ;;
esac
`;
  fs.writeFileSync(tmuxBin, script); fs.chmodSync(tmuxBin, 0o755);

  return {
    root, home, cwd, command, defsPath, tmuxBin, log, cap, alive, sessions, poison,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
function shellQ(p) { return `"${p.replace(/(["$`\\])/g, '\\$1')}"`; }

// Parsa il log tmux: ritorna array di righe; per 'new-session' anche l'argv (token tab-sep).
function readLog(w) {
  const raw = fs.existsSync(w.log) ? fs.readFileSync(w.log, 'utf8') : '';
  const lines = raw.split('\n').filter(Boolean);
  const nsArgv = [];
  for (const line of lines) {
    if (line.startsWith('new-session\t')) {
      const toks = line.split('\t').filter((t) => t !== '');
      // toks[0] === 'new-session'; gli altri sono gli argv reali (1° = 'new-session' word gia')
      nsArgv.push(toks.slice(1).filter((t) => t !== 'new-session'));
    }
  }
  return { lines, nsArgv };
}

// ---------------------------------------------------------------------------
// 1. composeLaunchArgv — argv preciso, puro
// ---------------------------------------------------------------------------
test('composeLaunchArgv flag: command+args+env(-e)+model+promptFlag, no shell', () => {
  const w = makeWorld();
  try {
    const engine = {
      command: w.command, args: ['--dangerously-skip-permissions'],
      env: { ANTHROPIC_API_KEY: 'sk-x' },
      model: { flag: '--model', value: 'sonnet' },
      promptMode: 'flag', promptFlag: '--append-system-prompt',
    };
    const argv = composeLaunchArgv({ tmuxSession: 'work-build', realCwd: w.cwd, engine, cell: { model: 'opus', prompt: 'p1' } });
    assert.equal(argv[0], 'new-session');
    assert.equal(argv[1], '-d');
    assert.deepEqual([argv[2], argv[3]], ['-s', 'work-build']);
    assert.deepEqual([argv[4], argv[5]], ['-c', w.cwd]);
    // engine.env via -e (chiave validata, NON in env del processo)
    const eIdx = argv.indexOf('-e');
    assert.deepEqual([argv[eIdx], argv[eIdx + 1]], ['-e', 'ANTHROPIC_API_KEY=sk-x']);
    // command + args come argv SEPARATI (tmux exec, no sh -c)
    assert.ok(argv.includes(w.command), 'command presente come token');
    assert.ok(argv.includes('--dangerously-skip-permissions'), 'arg separato (no shell-join)');
    // model: override cella 'opus' vince su engine 'sonnet'
    const mIdx = argv.indexOf('--model');
    assert.equal(argv[mIdx + 1], 'opus', 'model override cella');
    // prompt flag-mode
    const pIdx = argv.indexOf('--append-system-prompt');
    assert.equal(argv[pIdx + 1], 'p1');
  } finally { w.cleanup(); }
});

test('composeLaunchArgv: model con valore solo engine; senza prompt non aggiunge promptFlag', () => {
  const engine = {
    command: '/x', args: [], env: {},
    model: { flag: '--model', value: 'sonnet' },
    promptMode: 'flag', promptFlag: '--ps',
  };
  const a1 = composeLaunchArgv({ tmuxSession: 's', realCwd: '/c', engine, cell: { model: '', prompt: '' } });
  assert.ok(a1.includes('--model') && a1[a1.indexOf('--model') + 1] === 'sonnet', 'fallback al valore engine');
  assert.ok(!a1.includes('--ps'), 'nessun promptFlag senza prompt effettivo');
  // send-keys: il prompt NON finisce in argv (verra' iniettato dopo)
  const sk = { ...engine, promptMode: 'send-keys' };
  const a2 = composeLaunchArgv({ tmuxSession: 's', realCwd: '/c', engine: sk, cell: { prompt: 'hello' } });
  assert.ok(!a2.includes('--ps'), 'send-keys non mette prompt in argv');
});

// ---------------------------------------------------------------------------
// 2. up flag-mode: lancia in tmux, argv diretto, nessuna digitazione prompt
// ---------------------------------------------------------------------------
test('up flag-mode: new-session con argv diretto; engine.env via -e; nessun paste', async () => {
  process.env.NC_SENTINEL_SHOULD_NOT_LEAK = '1';
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    assert.equal(fleet.available, true);
    const res = await fleet.up('Dev');
    assert.equal(res.ok, true);
    assert.equal(res.prompt, null, 'flag mode non inietta via paste');

    const { lines, nsArgv } = readLog(w);
    assert.ok(lines.some((l) => l.startsWith('new-session\t')), 'new-session lanciato');
    const argv = nsArgv[0];
    assert.ok(argv.includes(w.command) && argv.includes('--dangerously-skip-permissions'), 'argv diretto (token separati)');
    assert.ok(argv.includes('-e') && argv.includes('ANTHROPIC_API_KEY=sk-x'), 'env via -e');
    assert.ok(!lines.some((l) => l.startsWith('paste-buffer')), 'nessun paste in flag mode');

    // env minimale: il sentinel del processo NON raggiunge il launcher
    const envTxt = fs.readFileSync(path.join(w.cap, 'launch-env.txt'), 'utf8');
    assert.ok(!/NC_SENTINEL_SHOULD_NOT_LEAK/.test(envTxt), 'env del processo non leakato (minimale)');
    assert.ok(/^PATH=/m.test(envTxt), 'PATH controllato dal service presente');
  } finally { w.cleanup(); delete process.env.NC_SENTINEL_SHOULD_NOT_LEAK; }
});

// ---------------------------------------------------------------------------
// 3. up send-keys + vivo: load-buffer poi paste-buffer -p; prompt catturato
// ---------------------------------------------------------------------------
test('up send-keys (vivo): bracketed paste load-buffer + paste-buffer -p', async () => {
  const w = makeWorld({ promptMode: 'send-keys', cellPrompt: 'ciao cella' });
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin, sendKeysReadyMs: 200 });
    const res = await fleet.up('Dev');
    assert.equal(res.ok, true);
    assert.equal(res.prompt.injected, true, 'prompt iniettato');
    assert.match(res.prompt.reason, /paste-buffer -p/);

    const { lines } = readLog(w);
    const lb = lines.findIndex((l) => l.startsWith('load-buffer'));
    const pb = lines.findIndex((l) => l.startsWith('paste-buffer'));
    assert.ok(lb >= 0 && pb >= 0 && lb < pb, 'load-buffer prima di paste-buffer');
    assert.match(lines[pb], /paste-buffer.*-p/, 'paste-buffer con -p (bracketed)');
    const promptTxt = fs.readFileSync(path.join(w.cap, 'prompt.txt'), 'utf8');
    assert.equal(promptTxt, 'ciao cella', 'prompt testo integro via load-buffer');
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------------------
// 4. up send-keys + command uscito (sessione morta): NON digita
// ---------------------------------------------------------------------------
test('up send-keys (command uscito): sessione morta -> nessun paste', async () => {
  const w = makeWorld({ promptMode: 'send-keys', cellPrompt: 'p' });
  try {
    fs.writeFileSync(w.alive, '0'); // has-session sempre 1 -> simula command uscito
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin, sendKeysReadyMs: 40 });
    const res = await fleet.up('Dev');
    assert.equal(res.ok, true);
    assert.equal(res.prompt.injected, false, 'nessuna digitazione');
    assert.match(res.prompt.reason, /non viva|uscito/);
    const { lines } = readLog(w);
    assert.ok(!lines.some((l) => l.startsWith('paste-buffer')), 'nessun paste-buffer');
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------------------
// 5. up: command non trusted -> 400, NON lancia
// ---------------------------------------------------------------------------
test('up: command non trusted (relativo) -> 400, nessun new-session', async () => {
  const w = makeWorld();
  try {
    // riscrivo fleet.json con command relativo (non assoluto)
    atomicWrite(w.defsPath, {
      schemaVersion: 1,
      engines: [{ id: 'claude', command: 'claude', promptMode: 'flag', promptFlag: '--ps' }],
      cells: [{ id: 'Dev', cwd: w.cwd, engine: 'claude' }],
    });
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await assert.rejects(() => fleet.up('Dev'), (e) => e.status === 400 && /trusted/.test(e.message));
    const { lines } = readLog(w);
    assert.ok(!lines.some((l) => l.startsWith('new-session\t')), 'non ha lanciato nulla');
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------------------
// 6. up: cwd fuori home -> 400
// ---------------------------------------------------------------------------
test('up: cwd fuori home -> 400', async () => {
  const w = makeWorld();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ncbi-out-'));
  try {
    atomicWrite(w.defsPath, {
      schemaVersion: 1,
      engines: [{ id: 'claude', command: w.command, promptMode: 'flag', promptFlag: '--ps' }],
      cells: [{ id: 'Dev', cwd: outside, engine: 'claude' }],
    });
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await assert.rejects(() => fleet.up('Dev'), (e) => e.status === 400 && /cwd/.test(e.message));
  } finally { w.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('up: cella/engine mancanti -> 400', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await assert.rejects(() => fleet.up('Nope'), (e) => e.status === 400);
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------------------
// 7. READONLY: blocca ogni mutazione + up (403); status/schema/capabilities passano
// ---------------------------------------------------------------------------
test('READONLY (cfg): up/mutazioni 403; status/schema/capabilities ok', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin, readonlyDefault: true });
    await assert.rejects(() => fleet.up('Dev'), (e) => e.status === 403);
    await assert.rejects(() => fleet.down('Dev'), (e) => e.status === 403);
    await assert.rejects(() => fleet.restart('Dev'), (e) => e.status === 403);
    await assert.rejects(() => fleet.engine('Dev', 'claude'), (e) => e.status === 403);
    await assert.rejects(() => fleet.boot('Dev', false), (e) => e.status === 403);
    await assert.rejects(() => fleet.defineEngine({ id: 'x', command: w.command, promptMode: 'flag', promptFlag: '--ps' }), (e) => e.status === 403);
    await assert.rejects(() => fleet.removeCell('Dev'), (e) => e.status === 403);
    const { lines } = readLog(w);
    assert.ok(!lines.some((l) => l.startsWith('new-session\t')), 'READONLY: nessun launch');

    // letture pure passano
    const st = await fleet.status();
    assert.equal(st.available, true);
    assert.equal(fleet.capabilities().length, 11);
    assert.ok(fleet.schema().engine.command);
  } finally { w.cleanup(); }
});

test('READONLY (env NEXUSCREW_READONLY=1): up 403', async () => {
  const w = makeWorld();
  process.env.NEXUSCREW_READONLY = '1';
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await assert.rejects(() => fleet.up('Dev'), (e) => e.status === 403);
  } finally { delete process.env.NEXUSCREW_READONLY; w.cleanup(); }
});

// ---------------------------------------------------------------------------
// 8. define / edit / remove — round-trip su fleet.json temporaneo
// ---------------------------------------------------------------------------
test('define/edit/remove engine+cell: round-trip su fleet.json', async () => {
  const w = makeWorld({ cellPrompt: undefined });
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });

    // define engine nuovo + cell nuova
    await fleet.defineEngine({ id: 'glm', command: w.command, promptMode: 'send-keys' });
    await fleet.defineCell({ id: 'Trading', cwd: w.cwd, engine: 'glm', boot: false });
    let st = await fleet.status();
    assert.ok(st.engines.some((e) => e.id === 'glm'));
    assert.ok(st.cells.some((c) => c.cell === 'Trading'));

    // duplicato -> 400
    await assert.rejects(() => fleet.defineEngine({ id: 'glm', command: w.command, promptMode: 'send-keys' }), (e) => e.status === 400);

    // edit engine (label) + edit cell (cwd reale)
    await fleet.editEngine('glm', { label: 'GLM 4' });
    await fleet.editCell('Trading', { boot: true });
    st = await fleet.status();
    assert.equal(st.engines.find((e) => e.id === 'glm').label, 'GLM 4');
    assert.equal(st.cells.find((c) => c.cell === 'Trading').boot, true);

    // remove engine in uso -> 400 (fail-closed)
    await assert.rejects(() => fleet.removeEngine('glm'), (e) => e.status === 400 && /uso/i.test(e.message));
    // remove cell (libera l'engine) poi remove engine
    await fleet.removeCell('Trading');
    await fleet.removeEngine('glm');
    st = await fleet.status();
    assert.ok(!st.engines.some((e) => e.id === 'glm'));

    // define invalido (engine senza promptMode) -> 400, MAI garbage scritto
    const before = fs.readFileSync(w.defsPath, 'utf8');
    await assert.rejects(() => fleet.defineEngine({ id: 'bad', command: w.command /* promptMode mancante */ }), (e) => e.status === 400);
    assert.equal(fs.readFileSync(w.defsPath, 'utf8'), before, 'file intatto su input invalido');

    // remove inesistenti -> 400
    await assert.rejects(() => fleet.removeEngine('nope'), (e) => e.status === 400);
    await assert.rejects(() => fleet.removeCell('nope'), (e) => e.status === 400);
  } finally { w.cleanup(); }
});

test('engine()/boot(): persistono su fleet.json', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await fleet.defineEngine({ id: 'glm', command: w.command, promptMode: 'send-keys' });
    await fleet.engine('Dev', 'glm', { model: 'model-one' });
    await fleet.engine('Dev', 'claude');
    assert.equal(fleet.definitions().cells[0].model, undefined, 'nessun modello glm trascinato su claude');
    await fleet.engine('Dev', 'glm');
    await fleet.boot('Dev', false);
    const st = await fleet.status();
    assert.equal(st.cells.find((c) => c.cell === 'Dev').engine, 'glm');
    assert.equal(st.cells.find((c) => c.cell === 'Dev').model, 'model-one', 'ultimo modello glm ripristinato');
    assert.equal(st.cells.find((c) => c.cell === 'Dev').models.glm, 'model-one');
    assert.equal(st.cells.find((c) => c.cell === 'Dev').boot, false);
    // engine non valido -> 400
    await assert.rejects(() => fleet.engine('Dev', 'zzz'), (e) => e.status === 400);
  } finally { w.cleanup(); }
});

test('managed codex-vl.native: launcher interno, login nativo, fake tmux', async () => {
  const w = makeWorld({ cellPrompt: 'bootstrap managed' });
  try {
    const bin = path.join(w.home, '.local', 'bin', 'codex-vl');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n'); fs.chmodSync(bin, 0o755);
    atomicWrite(w.defsPath, {
      schemaVersion: 1,
      engines: [{ id: 'codex-vl.native', label: 'Codex-VL · Native', managed: { client: 'codex-vl', provider: 'native', model: '' } }],
      cells: [{ id: 'Dev', cwd: w.cwd, engine: 'codex-vl.native', prompt: 'bootstrap managed' }],
    });
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin, sendKeysReadyMs: 0 });
    const view = fleet.definitions();
    assert.equal(view.engines[0].managedInfo.configured, true);
    assert.equal(view.engines[0].managedInfo.provider, 'native');
    assert.ok(view.managedCatalog.some((p) => p.id === 'claude.zai-a'));
    await fleet.up('Dev');
    const argv = readLog(w).nsArgv[0];
    assert.ok(argv.includes(bin));
    assert.equal(argv.includes('--dangerously-bypass-approvals-and-sandbox'), false, 'standard e il default sicuro');
    assert.ok(argv.includes('bootstrap managed'));
    assert.equal(argv.some((x) => /zai|ollama/i.test(x)), false);
    assert.equal(readLog(w).lines.some((x) => x.startsWith('load-buffer')), false);
  } finally { w.cleanup(); }
});

test('editCell engine ripristina il proprio modello e non trascina quello precedente', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await fleet.defineEngine({ id: 'glm', command: w.command, model: { flag: '--model', value: 'default' }, promptMode: 'send-keys' });
    await fleet.engine('Dev', 'glm', { model: 'glm-last' });
    await fleet.editCell('Dev', { engine: 'claude' });
    assert.equal(fleet.definitions().cells[0].model, undefined);
    await fleet.editCell('Dev', { engine: 'glm' });
    assert.equal(fleet.definitions().cells[0].model, 'glm-last');
  } finally { w.cleanup(); }
});

test('removeEngine elimina anche i modelli ricordati dalle celle', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await fleet.defineEngine({ id: 'glm', command: w.command, promptMode: 'send-keys' });
    await fleet.engine('Dev', 'glm', { model: 'remember-me' });
    await fleet.engine('Dev', 'claude');
    await fleet.removeEngine('glm');
    const cell = fleet.definitions().cells[0];
    assert.equal(cell.models, undefined);
    assert.ok(!fleet.definitions().engines.some((e) => e.id === 'glm'));
  } finally { w.cleanup(); }
});

test('definitions redatte + envChanges write-only', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    const view = fleet.definitions();
    assert.deepEqual(view.engines[0].envKeys, ['ANTHROPIC_API_KEY']);
    assert.equal(view.engines[0].env, undefined);
    await fleet.editEngine('claude', { label: 'Claude++' }, { set: { NEW_TOKEN: 'secret-2' }, remove: ['ANTHROPIC_API_KEY'] });
    const disk = require('../lib/fleet/definitions.js').loadDefinitions(w.defsPath);
    assert.deepEqual(disk.engines[0].env, { NEW_TOKEN: 'secret-2' });
    assert.equal(fleet.definitions().engines[0].env, undefined);
  } finally { w.cleanup(); }
});

test('removeCell attiva richiede stop esplicito', async () => {
  const w = makeWorld();
  try {
    fs.writeFileSync(w.sessions, 'work-build\n');
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await assert.rejects(() => fleet.removeCell('Dev'), (e) => e.status === 409);
    await fleet.removeCell('Dev', { stop: true });
    assert.equal(fleet.definitions().cells.length, 0);
    assert.ok(readLog(w).lines.some((x) => x.startsWith('kill-session')));
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------------------
// 9. capabilities + schema corretti; status + isCellSession
// ---------------------------------------------------------------------------
test('capabilities e schema: superficie estesa del built-in', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    assert.deepEqual(fleet.capabilities(),
      ['status', 'up', 'down', 'restart', 'engine', 'boot', 'define', 'edit', 'remove', 'schema', 'definitions']);
    const sch = fleet.schema();
    assert.equal(sch.schemaVersion, 1);
    for (const f of ['id', 'label', 'rc', 'command', 'args', 'env', 'model', 'promptMode', 'promptFlag']) {
      assert.ok(sch.engine[f], `campo engine.${f}`);
    }
    for (const f of ['id', 'cwd', 'engine', 'boot', 'model', 'prompt']) {
      assert.ok(sch.cell[f], `campo cell.${f}`);
    }
    assert.ok(sch.engine.env.denylist.includes('PATH'), 'denylist env esposta');
    assert.equal(sch.caps, require('../lib/fleet/definitions.js').CAPS);
  } finally { w.cleanup(); }
});

test('status: cells/engines da definitions; isCellSession; provider/reason', async () => {
  const w = makeWorld();
  try {
    fs.writeFileSync(w.sessions, 'work-build\n'); // cella attiva in tmux
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    const st = await fleet.status();
    assert.equal(st.provider, 'builtin');
    assert.equal(st.bootOwner, 'builtin');
    assert.ok(st.reason);
    const dev = st.cells.find((c) => c.cell === 'Dev');
    assert.equal(dev.active, true);
    assert.equal(dev.tmux, true);
    assert.equal(dev.degraded, false);
    assert.equal(dev.tmuxSession, 'work-build');
    assert.equal(st.engines[0].id, 'claude');
    assert.equal(fleet.isCellSession('work-build'), true);
    assert.equal(fleet.isCellSession('worker-1'), false);
  } finally { w.cleanup(); }
});

test('promptCharsOk: rifiuta ESC/null, ammette stampabili + newline', () => {
  assert.equal(promptCharsOk('hello\nworld'), true);
  assert.equal(promptCharsOk('tab\there'), true);
  assert.equal(promptCharsOk('esc\x1b[200~'), false, 'ESC/marker bracketed-paste rifiutato');
  assert.equal(promptCharsOk('null\x00'), false);
  assert.equal(promptCharsOk('del\x7f'), false);
});

// ---------------------------------------------------------------------------
// 10. bootstrap fail-closed: fleet.json garbage -> unavailable
// ---------------------------------------------------------------------------
test('fleet.json invalido/mancante -> unavailable (fail-closed)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncbi-'));
  try {
    const missing = await createBuiltinFleet({ home, fleetDefsPath: path.join(home, 'nope.json') });
    assert.equal(missing.available, false);
    const defsPath = path.join(home, 'fleet.json');
    fs.writeFileSync(defsPath, '{ not valid json'); // garbage
    assert.equal((await createBuiltinFleet({ home, fleetDefsPath: defsPath })).available, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 11. provider selection
// ---------------------------------------------------------------------------
test('selectProvider: external fidato vince; poi builtin; poi disabled', async () => {
  // external fidato + risponde al contratto (fake-fleet.sh)
  const ext = await selectProvider({ fleetBin: FAKE_FLEET, builtinEnabled: true, home: fs.mkdtempSync(path.join(os.tmpdir(), 'p-')) });
  assert.equal(ext.mode, 'external');

  // nessun external -> builtin (fleet.json valido)
  const w = makeWorld();
  try {
    const bi = await selectProvider({ fleetBin: undefined, builtinEnabled: true, home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    assert.equal(bi.mode, 'builtin');
    assert.equal(bi.fleet.available, true);

    // builtin disabilitato + nessun external -> disabled
    const dis = await selectProvider({ fleetBin: undefined, builtinEnabled: false, home: w.home, fleetDefsPath: w.defsPath });
    assert.equal(dis.mode, 'disabled');
    assert.equal(dis.fleet.available, false);

    // external presente ma SCADUTO (schema estraneo): binTrusted ok ma non risponde
    process.env.FAKE_FLEET_MODE = 'wrong-kind';
    const extBad = await selectProvider({ fleetBin: FAKE_FLEET, builtinEnabled: true, home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    assert.equal(extBad.mode, 'builtin', 'external non risponde -> builtin (auto, non fail-closed)');
    delete process.env.FAKE_FLEET_MODE;
  } finally { w.cleanup(); }
});

test('selectProvider: forced fail-closed (no auto-fallback silenzioso)', async () => {
  // forced external ma nessun external disponibile -> disabled (fail-closed)
  const forced = await selectProvider({ fleetProvider: 'external', fleetBin: undefined, home: fs.mkdtempSync(path.join(os.tmpdir(), 'p-')) });
  assert.equal(forced.mode, 'disabled');
  assert.match(forced.reason, /fail-closed/i);

  const w = makeWorld();
  try {
    // forced builtin con fleet.json valido -> builtin
    const fb = await selectProvider({ fleetProvider: 'builtin', fleetDefsPath: w.defsPath, home: w.home, tmuxBin: w.tmuxBin });
    assert.equal(fb.mode, 'builtin');

    // forced builtin ma fleet.json invalido -> disabled (fail-closed, NO fallback a external)
    const badPath = path.join(w.root, 'bad.json');
    fs.writeFileSync(badPath, 'garbage');
    const fbb = await selectProvider({ fleetProvider: 'builtin', fleetBin: FAKE_FLEET, fleetDefsPath: badPath, home: w.home });
    assert.equal(fbb.mode, 'disabled', 'forced builtin invalido -> disabled, non external');

    // forced disabled
    const fd = await selectProvider({ fleetProvider: 'disabled', fleetBin: FAKE_FLEET, fleetDefsPath: w.defsPath, home: w.home });
    assert.equal(fd.mode, 'disabled');
  } finally { w.cleanup(); }
});

test('selectProvider: fleetEnabled=false -> disabled', async () => {
  const r = await selectProvider({ fleetEnabled: false });
  assert.equal(r.mode, 'disabled');
});

// ---------------------------------------------------------------------------
// 12. restart (builtin) — down (kill-session) idempotente poi up (new-session)
// ---------------------------------------------------------------------------
test('restart (builtin): kill-session (down) prima di new-session (up)', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    const res = await fleet.restart('Dev');
    assert.equal(res.ok, true);
    const { lines } = readLog(w);
    const kill = lines.findIndex((l) => l.startsWith('kill-session'));
    const ns = lines.findIndex((l) => l.startsWith('new-session\t'));
    assert.ok(kill >= 0, 'kill-session lanciato (down)');
    assert.ok(ns >= 0, 'new-session lanciato (up)');
    assert.ok(kill < ns, 'kill-session prima di new-session');
  } finally { w.cleanup(); }
});

test('restart: cella sconosciuta -> 400 (come down/up)', async () => {
  const w = makeWorld();
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await assert.rejects(() => fleet.restart('Nope'), (e) => e.status === 400);
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------------------
// 13. redazione §9h — segreti (env value + prompt) mai nell'errore di up fallito
// ---------------------------------------------------------------------------
test('redactSecrets (unit): env values + prompt redatti, chiavi/envKey preservati', () => {
  const engine = { env: { ANTHROPIC_API_KEY: 'sk-x', OTHER: 'tok-9' }, prompt: 'ENG-PROMPT' };
  const cell = { prompt: 'CELL-PROMPT-9z' };
  const out = redactSecrets('boom ANTHROPIC_API_KEY=sk-x other=tok-9 eng=ENG-PROMPT cell=[CELL-PROMPT-9z]', engine, cell);
  assert.ok(!/sk-x|tok-9|ENG-PROMPT|CELL-PROMPT-9z/.test(out), 'nessun segreto in chiaro');
  assert.ok(/ANTHROPIC_API_KEY=/.test(out), 'le CHIAVI env restano (redatti solo i values)');
  assert.equal((out.match(/‹redacted›/g) || []).length, 4, 'un marcatore per segreto');
  // testo non-string -> pass-through
  assert.equal(redactSecrets(null, engine, cell), null);
  assert.equal(redactSecrets('', engine, cell), '');
});

test('redazione §9h: env value e prompt NON appaiono nell errore di up fallito (stderr avvelenato)', async () => {
  const w = makeWorld({ cellPrompt: 'TOPSECRET-PROMPT-9z' });
  try {
    // avveleno new-session: stderr ecoa i segreti del comando lanciato (env value + prompt)
    fs.writeFileSync(w.poison, 'boom: ANTHROPIC_API_KEY=sk-x :: prompt=[TOPSECRET-PROMPT-9z]');
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    await assert.rejects(() => fleet.up('Dev'), (e) => {
      assert.equal(e.status, 500, 'up fallito -> 500 (non duplicate)');
      assert.ok(!/sk-x/.test(e.message), 'valore env (sk-x) redatto');
      assert.ok(!/TOPSECRET-PROMPT-9z/.test(e.message), 'prompt cella redatto');
      assert.ok(/‹redacted›/.test(e.message), 'marcatore ‹redacted› presente');
      return true;
    });
  } finally { w.cleanup(); }
});

test('redazione §9h: stderr NON avvelenato -> up ok, nessun marcatore', async () => {
  // sanity: senza veleno l'up riesce e il risultato non contiene redaction marker
  const w = makeWorld({ promptMode: 'flag' });
  try {
    const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
    const res = await fleet.up('Dev');
    assert.equal(res.ok, true);
  } finally { w.cleanup(); }
});
