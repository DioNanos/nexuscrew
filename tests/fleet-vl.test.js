'use strict';
// VL (vl.native) — runtime TUI Vivling (repository `vl`), binario `vl`.
// Runtime locale: auth propria del runtime (auth 'none', nessuna credenziale
// NexusCrew). Backfill idempotente pattern Kimi (NESSUN platform gate: musl-
// friendly ovunque). vl non ha flag prompt, --model, ne' di approvazione: lancia
// la TUI senza argomenti; e' standard-only (nessun flag unsafe da cablare).
// Verifica TUI: `vl --help` -> Usage `vl [OPTIONS]` (nessun argomento richiesto;
// absent config OK, fallback built-in local Ollama).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeManagedSpec, describeManaged, resolveManagedEngine, publicCatalog, findBinary } = require('../lib/fleet/managed.js');
const { classifyPane, vlPaneReadiness } = require('../lib/fleet/prompt-delivery.js');
const { backfillVlEngine } = require('../lib/fleet/builtin.js');
const { loadDefinitions, atomicWrite } = require('../lib/fleet/definitions.js');

const VL = { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' };

function homeWithVl() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvl-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return home;
}

test('vl: normalizeManagedSpec ammette solo standard; publicCatalog include vl.native', () => {
  assert.deepEqual(normalizeManagedSpec(VL), { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' });
  // vl e' standard-only: il CLI non ha flag di approvazione -> unsafe rifiutato (fail-closed)
  assert.equal(normalizeManagedSpec({ client: 'vl', provider: 'native', permissionPolicy: 'unsafe' }), null);
  assert.equal(normalizeManagedSpec({ client: 'vl', provider: 'native', permissionPolicy: 'bogus' }), null);
  const cat = publicCatalog().find((p) => p.id === 'vl.native');
  assert.ok(cat, 'vl.native nel catalogo');
  assert.equal(cat.auth, 'none', 'runtime locale: niente credenziali NexusCrew');
  assert.equal(cat.protocol, 'vl_native');
  assert.equal(cat.supportsUnsafe, false, 'vl non ha flag di approvazione');
  assert.equal(cat.permissionPolicyDefault, 'standard');
  assert.equal(cat.rc, false, 'nessun remote-control NexusCrew');
});

test('vl findBinary: risolve ~/.local/bin/vl (path standard)', () => {
  const home = homeWithVl();
  try {
    const bin = findBinary('vl', home);
    assert.ok(bin, 'vl risolto da ~/.local/bin');
    assert.equal(bin, fs.realpathSync(path.join(home, '.local', 'bin', 'vl')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('vl argv: lancia la TUI senza argomenti; nessun prompt su argv; niente token', () => {
  const home = homeWithVl();
  try {
    const eng = () => ({ id: 'vl.native', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' } });
    // TUI: nessun argomento, niente env/token
    const r0 = resolveManagedEngine(eng(), { id: 'vl.native' }, { home, platform: 'linux', env: {} });
    assert.equal(r0.ok, true);
    assert.deepEqual(r0.engine.args, [], 'vl lancia la TUI senza argomenti');
    assert.deepEqual(r0.engine.env, {}, 'runtime locale: nessun token/credenziale');
    // anche con un prompt di cella, vl NON lo riceve su argv (TUI senza superficie prompt)
    const r1 = resolveManagedEngine(eng(), { id: 'vl.native', prompt: 'you are dev' }, { home, platform: 'linux', env: {} });
    assert.deepEqual(r1.engine.args, [], 'vl non accetta prompt su argv (TUI senza superficie prompt)');
    assert.equal(JSON.stringify(r1.engine).toLowerCase().includes('token'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('vl describeManaged: binario assente -> non configurato (NESSUN gate di piattaforma)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlna-'));
  try {
    // nessun gate: su ogni piattaforma, binario assente -> non configurato (non "unsupported")
    for (const platform of ['linux', 'darwin', 'android', 'win32']) {
      const info = describeManaged(VL, { home, platform, env: {} });
      assert.equal(info.configured, false, `${platform}: binario assente -> non configurato`);
      assert.match(info.reason, /client vl not found/);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('vl backfill: idempotente, NESSUN platform gate, non distruttivo su collisione id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlbf-'));
  try {
    const dp = (engines) => {
      const p = path.join(root, `f-${Math.random().toString(36).slice(2)}.json`);
      atomicWrite(p, { schemaVersion: 1, engines, cells: [] });
      return p;
    };
    const base = [{ id: 'claude.native', label: 'Claude', rc: true, managed: { client: 'claude', provider: 'native', permissionPolicy: 'unsafe' } }];
    // NESSUN platform gate: aggiunge vl.native su tutte le piattaforme
    for (const platform of ['linux', 'darwin', 'android', 'win32']) {
      const p = dp(base);
      const v = backfillVlEngine(p, loadDefinitions(p), { platform });
      assert.ok(v.engines.some((e) => e.id === 'vl.native'), `${platform}: backfill aggiunge vl.native`);
    }
    // idempotente (non duplica)
    const p1 = dp(base);
    const v1 = backfillVlEngine(p1, loadDefinitions(p1), { platform: 'linux' });
    const v1b = backfillVlEngine(p1, v1, { platform: 'linux' });
    assert.equal(v1b.engines.filter((e) => e.id === 'vl.native').length, 1);
    // collisione id: engine custom con id vl.native ma command proprio -> preservato
    const p4 = dp([{ id: 'vl.native', label: 'Custom', rc: false, command: '/bin/x', args: [], env: {}, promptMode: 'flag', promptFlag: '-p' }]);
    const v4 = backfillVlEngine(p4, loadDefinitions(p4), { platform: 'linux' });
    assert.equal(v4.engines.length, 1);
    assert.equal(v4.engines[0].command, '/bin/x', 'collisione: custom vl.native preservato, mai sovrascritto');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Il clamp standard-only di vl vive in DUE copie: normalizeManagedSpec (sopra,
// unsafe->null) e resolveManagedEngine (override PER-CELL -> standard). Questa
// e' la copia resolveManagedEngine: l'unico modo in cui 'unsafe' raggiunge
// resolve e' via cell.permissionPolicies, e quel path va ancorato ai test.
test('vl policy per-cell: override unsafe viene clampato a standard (nessun flag, NESSUN bypass)', () => {
  const home = homeWithVl();
  try {
    const engine = { id: 'vl.native', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' } };
    // override PER-CELL unsafe -> vl e' standard-only, clamp a standard, nessun flag
    const r = resolveManagedEngine(engine, { id: 'Dev', permissionPolicies: { 'vl.native': 'unsafe' } }, { home, platform: 'linux', env: {} });
    assert.equal(r.ok, true);
    assert.equal(r.info.permissionPolicy, 'standard', "vl: l'override PER-CELL unsafe e' clampato a standard");
    assert.equal(r.engine.args.includes('--always-approve'), false, 'nessun --always-approve');
    assert.equal(r.engine.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(r.engine.args.includes('--yolo'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// D4-4a: classifyPane riconosce una cella vl PRONTA dalla riga di stato.
// Fatti misurati 2026-08-14 (documento di riferimento interno stato_cella_vl):
// il marcatore stabile di pronta e' il prefisso `vivling` + stato `[o]` insieme
// alla coda `esc quit · ^y yield`, a prescindere dal backend, dal writer-id
// (e<numero>) e dal contatore (↑<numero>). Tre trappole pagate sul campo:
//  (1) vl.bin NON contiene "tmux" -> nessuno spinner braille nel titolo ->
//      WORKING_TITLE_PREFIX (lib/tmux/list.js) NON scatta: il ready viene dalla
//      riga di stato del CONTENUTO, mai dal titolo.
//  (2) il contenuto del pane NON dice se vl lavora: su alcuni backend il
//      ragionamento non e' renderizzato e il pane resta identico mentre la cella
//      calcola. classifyPane vl dice solo "pronta" ([o]) o "non pronta"; MAI
//      'busy' dal contenuto (il busy si rileva con la sonda esterna).
//  (3) il `›` e' il composer vuoto, non un marcatore di pronta.

// Campioni misurati su due backend diversi (zai-a-coding, opencode-go).
const VL_READY_ZAI = '›\nvivling [o] writer e42 · zai-a-coding · ↑267     esc quit · ^y yield';
const VL_READY_OPENCODE = '›\nvivling [o] writer e186 · opencode-go · ↑267     esc quit · ^y yield';

test('D4-4a classifyPane vl: PRONTA riconosciuta dal marcatore stabile (entrambi i backend)', () => {
  assert.equal(classifyPane(VL_READY_ZAI, 'vl'), 'ready', 'zai-a-coding: pronta');
  assert.equal(classifyPane(VL_READY_OPENCODE, 'vl'), 'ready', 'opencode-go: marcatore stabile cross-backend');
});

test('D4-4a classifyPane vl: MAI busy dal contenuto (stati [?] e [<] sono unknown, non busy)', () => {
  // Trappola 2: il pane e' IDENTICO mentre vl lavora; gli stati [?] e [<]
  // esistono ma il busy non e' affidabile dal contenuto. classifyPane NON dice
  // 'busy': dice 'unknown' (non pronta), e il busy resta alla sonda esterna.
  const busyQ = VL_READY_ZAI.replace('[o]', '[?]');
  const busyLt = VL_READY_ZAI.replace('[o]', '[<]');
  assert.equal(classifyPane(busyQ, 'vl'), 'unknown', 'stato [?] -> unknown, NON busy');
  assert.equal(classifyPane(busyLt, 'vl'), 'unknown', 'stato [<] -> unknown, NON busy');
});

test('D4-4a classifyPane vl: composer solo / pane vuoto / marcatore parziale -> unknown', () => {
  assert.equal(classifyPane('›', 'vl'), 'unknown', 'solo composer `>` non e pronta');
  assert.equal(classifyPane('', 'vl'), 'unknown', 'pane vuoto');
  assert.equal(classifyPane('   \n  ', 'vl'), 'unknown', 'solo whitespace');
  // Marcatore parziale: manca la coda `esc quit · ^y yield` -> non basta.
  assert.equal(classifyPane('›\nvivling [o] writer e42 · zai-a-coding · ↑267', 'vl'), 'unknown', 'senza coda esc quit non basta');
  // Marcatore parziale: coda presente ma manca il prefisso `vivling [o]` -> non basta.
  assert.equal(classifyPane('›\nwriter e42 · zai-a-coding · ↑267     esc quit · ^y yield', 'vl'), 'unknown', 'senza prefisso vivling [o] non basta');
});

test('D4-4a classifyPane vl: client non-vl sullo stesso testo resta unknown (no cross-talk)', () => {
  // Il campione vl NON deve far scattare il branch kimi/claude: il marcatore vl
  // e' specifico. E vl non matcha i marker not-ready di claude/kimi.
  assert.equal(classifyPane(VL_READY_ZAI, 'kimi'), 'unknown');
  assert.equal(classifyPane(VL_READY_ZAI, 'claude'), 'unknown');
  assert.equal(classifyPane(VL_READY_ZAI, 'unknown-client'), 'unknown');
});

// --- DEC1: vlPaneReadiness (content-readiness vl con degrado) -----------------
// Punto di innesto della readiness vl: capture-pane + classifyPane('vl'). MAI
// fail-closed: a timeout degrada a {ready:true, degraded:true}. Il controllo
// controllo negativo: una riga di stato non riconosciuta NON deve bloccare l'avvio.
function clockTick() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('DEC1 vlPaneReadiness: marcatore [o] entro il timeout -> ready, non degradato', async () => {
  let calls = 0;
  const capture = async () => { calls += 1; return calls >= 2 ? VL_READY_ZAI : '>'; };
  const clk = clockTick();
  const r = await vlPaneReadiness('tmux', '%1', { captureImpl: capture, sleepImpl: clk.sleep, nowImpl: clk.now });
  assert.equal(r.ready, true);
  assert.equal(r.degraded, false, 'marcatore comparso: nessun degrado');
});

test('DEC1 CONTROLLO NEGATIVO: riga di stato NON riconosciuta NON blocca l\'avvio (degrada a ready)', async () => {
  // Capture che non produce MAI il marcatore vl (backend che cambia la status bar,
  // TUI non ancora stabile). Senza degrado resterebbe appesa: si prova che ritorna
  // {ready:true} e NON {ready:false}, con degraded:true. Una cella che parte oggi
  // deve partire anche domani: il peggio ammesso e' tornare a com'era, mai bloccare.
  const capture = async () => 'testo di un pane senza il marcatore vivling [o]';
  const clk = clockTick();
  const r = await vlPaneReadiness('tmux', '%1', { captureImpl: capture, timeoutMs: 1000, pollMs: 100, sleepImpl: clk.sleep, nowImpl: clk.now });
  assert.equal(r.ready, true, 'NON blocca: degrada a ready, mai fail-closed');
  assert.equal(r.degraded, true, 'segnala il degrado');
});

test('DEC1 vlPaneReadiness: capture null/irraggiungibile -> degrada a ready', async () => {
  const capture = async () => null;
  const clk = clockTick();
  const r = await vlPaneReadiness('tmux', '%1', { captureImpl: capture, timeoutMs: 500, pollMs: 50, sleepImpl: clk.sleep, nowImpl: clk.now });
  assert.equal(r.ready, true);
  assert.equal(r.degraded, true);
});
