'use strict';
// VL (vl.native + varianti remote) — runtime TUI Vivling (repository `vl`),
// binario `vl`. Auth propria del runtime in OGNI variante (auth 'none': nessuna
// credenziale NexusCrew; la chiave, dove serve, viaggia SOLO per nome via
// envPassthrough, D3). vl.native significa «usa la tua configurazione»: NESSUNA
// env provider/base_url, perche' i default interni del runtime sono gia'
// openai-compat + localhost:11434 e le VL_* ambientali li sovrascriverebbero in
// silenzio, buttando via il config.toml dell'operatore. Le varianti remote
// (vl.anthropic, vl.custom) compongono SEMPRE la coppia: la' la variante e' la
// scelta. Il modello scelto in UI viaggia via VL_MODEL (V-69), il prompt di
// cella via VL_SYSTEM_APPEND_FILE (gate 0.3.1); `vl --profile` esiste ma resta
// dell'operatore. Standard-only: lancia la TUI senza argomenti, nessun flag di
// approvazione da cablare.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CATALOG, normalizeManagedSpec, describeManaged, resolveManagedEngine, publicCatalog, findBinary } = require('../lib/fleet/managed.js');
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
    // TUI: nessun argomento, niente env/token. Lo stub `exit 0` non dichiara
    // versione: il gate V-69 degrada (dichiarato), quindi NESSUNA env append.
    const r0 = resolveManagedEngine(eng(), { id: 'vl.native' }, { home, platform: 'linux', env: {} });
    assert.equal(r0.ok, true);
    assert.deepEqual(r0.engine.args, [], 'vl lancia la TUI senza argomenti');
    assert.deepEqual(r0.engine.env, {}, 'runtime locale: nessun token/credenziale (e append degradata, non composta)');
    // anche con un prompt di cella, vl NON lo riceve su argv (TUI senza superficie prompt)
    const r1 = resolveManagedEngine(eng(), { id: 'vl.native', prompt: 'you are dev' }, { home, platform: 'linux', env: {} });
    assert.deepEqual(r1.engine.args, [], 'vl non accetta prompt su argv (TUI senza superficie prompt)');
    assert.equal(JSON.stringify(r1.engine).toLowerCase().includes('token'), false);
    // degrado DICHIARATO (lo stub non dice la versione), non silenzio
    assert.ok(r1.engine.vlPromptDegraded, 'versione non determinabile dallo stub -> degrado dichiarato');
    assert.equal(r1.engine.env.VL_SYSTEM_APPEND_FILE, undefined, 'degradato: la env append NON si compone');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- V-69: prompt per-cella via VL_SYSTEM_APPEND_FILE + modello dalla UI -----
// Il probe di versione e' iniettabile (cfg.vlVersionProbe) perche' i test non
// dipendano da un vl vero: torna l'output GREZZO di `vl --version`.
const PROBE_031 = () => 'vl 0.3.1\n';
const PROBE_010 = () => 'vl 0.1.0\n';

function vlResolve(home, cell, cfgExtra = {}) {
  const engine = { id: 'vl.native', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' } };
  return resolveManagedEngine(engine, cell, { home, platform: 'linux', env: {}, ...cfgExtra });
}

test('V-69 gate versione regge (0.3.1): file per-cella scritto + env composta, NESSUN degrado', () => {
  const home = homeWithVl();
  try {
    const r = vlResolve(home, { id: 'Dev', prompt: 'You are the Dev cell.' }, { vlVersionProbe: PROBE_031 });
    assert.equal(r.ok, true);
    assert.equal(r.engine.vlPromptDegraded, undefined, 'versione che regge: nessun degrado');
    const target = r.engine.env.VL_SYSTEM_APPEND_FILE;
    assert.ok(target, 'VL_SYSTEM_APPEND_FILE composta');
    assert.equal(target, path.join(home, '.nexuscrew', 'vl-prompts', 'Dev.md'), 'file per-cella sotto ~/.nexuscrew (forma del precedente pi)');
    assert.ok(fs.existsSync(target), 'il file esiste');
    const content = fs.readFileSync(target, 'utf8');
    assert.ok(content.startsWith('You are the Dev cell.'), 'il prompt della cella apre il file');
    assert.ok(content.includes('NexusCrew companions'), 'le istruzioni companion seguono il prompt (vl non ha client MCP)');
    assert.ok((fs.statSync(target).mode & 0o777) === 0o600, 'file 0600: non esposto ad altri utenti');
    assert.ok((fs.statSync(path.dirname(target)).mode & 0o777) === 0o700, 'directory 0700');
    assert.deepEqual(r.engine.args, [], 'il prompt resta FUORI da argv (visibile in ps)');
    assert.equal(JSON.stringify(r.engine).toLowerCase().includes('token'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('V-69 CONTROLLO NEGATIVO — versione vecchia (0.1.0): env append NON composta + degrado DICHIARATO (mai silenzio)', () => {
  const home = homeWithVl();
  try {
    const r = vlResolve(home, { id: 'Dev', prompt: 'You are the Dev cell.' }, { vlVersionProbe: PROBE_010 });
    assert.equal(r.ok, true, 'la cella PARTE lo stesso: degrado, non blocco');
    assert.equal(r.engine.env.VL_SYSTEM_APPEND_FILE, undefined, 'mai una env che il runtime ignorerebbe in silenzio');
    assert.ok(r.engine.vlPromptDegraded && r.engine.vlPromptDegraded.includes('0.1.0'), 'il degrado nomina la versione trovata');
    assert.ok(r.engine.vlPromptDegraded.includes('0.3.1'), 'il degrado nomina la versione minima');
    assert.ok(!fs.existsSync(path.join(home, '.nexuscrew')), 'degradato per versione: nessun file scritto');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('V-69 probe non risponde / output non riconosciuto: degrado fail-closed con motivo, cella parte', () => {
  const home = homeWithVl();
  try {
    const rNull = vlResolve(home, { id: 'Dev', prompt: 'p' }, { vlVersionProbe: () => null });
    assert.equal(rNull.ok, true);
    assert.equal(rNull.engine.env.VL_SYSTEM_APPEND_FILE, undefined);
    assert.ok(rNull.engine.vlPromptDegraded.includes('non determinabile'), 'probe muto: motivo non determinabile');
    const rJunk = vlResolve(home, { id: 'Dev', prompt: 'p' }, { vlVersionProbe: () => 'qualcosaltro' });
    assert.ok(rJunk.engine.vlPromptDegraded.includes('non riconosciuta'), 'output inatteso: motivo non riconosciuta');
    // 0.10.0 > 0.3.1 per CAMPI, non per stringa ('0.10.0' < '0.3.1' come testo)
    const r0100 = vlResolve(home, { id: 'Dev', prompt: 'p' }, { vlVersionProbe: () => 'vl 0.10.0\n' });
    assert.equal(r0100.engine.vlPromptDegraded, undefined, '0.10.0 regge: confronto per campi, non lessicale');
    assert.ok(r0100.engine.env.VL_SYSTEM_APPEND_FILE, '0.10.0: append composta');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('V-69 senza prompt di cella: il file porta comunque le istruzioni companion (superficie MCP di vl)', () => {
  const home = homeWithVl();
  try {
    const r = vlResolve(home, { id: 'Dev' }, { vlVersionProbe: PROBE_031 });
    const target = r.engine.env.VL_SYSTEM_APPEND_FILE;
    assert.ok(target, 'append composta anche senza prompt');
    const content = fs.readFileSync(target, 'utf8');
    assert.ok(content.includes('NexusCrew companions'), 'il companion raggiunge vl anche senza prompt di cella');
    assert.ok(!content.startsWith('\n'), 'nessun separatore orfano senza prompt');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('V-69 modello dalla UI: scelto -> SOLO VL_MODEL; vl.native non esporta MAI provider/base_url', () => {
  const home = homeWithVl();
  try {
    const r = vlResolve(home, { id: 'Dev', model: 'gemma4:31b' }, { vlVersionProbe: PROBE_031 });
    assert.equal(r.engine.env.VL_MODEL, 'gemma4:31b', 'la scelta UI ha effetto');
    assert.equal(r.engine.env.VL_PROVIDER, undefined, 'vl.native: la configurazione dell\'operatore comanda, nessun override silenzioso');
    assert.equal(r.engine.env.VL_BASE_URL, undefined, 'vl.native: i default interni del runtime sono gia\' openai-compat+localhost:11434');
    const r0 = vlResolve(home, { id: 'Dev' }, { vlVersionProbe: PROBE_031 });
    assert.equal(r0.engine.env.VL_MODEL, undefined, 'nessun modello scelto: il config.toml dell\'operatore comanda');
    assert.equal(r0.engine.env.VL_PROVIDER, undefined);
    assert.equal(r0.engine.env.VL_BASE_URL, undefined);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('V-69 difese del percorso per-cella: id traversal e symlink -> degrado, mai scrittura fuori posto', () => {
  const home = homeWithVl();
  try {
    // '..' passa CELL_ID_RE ma come filename e' traversal: rifiutato, degradato
    const rDot = vlResolve(home, { id: '..', prompt: 'p' }, { vlVersionProbe: PROBE_031 });
    assert.equal(rDot.ok, true, 'la cella parte');
    assert.equal(rDot.engine.env.VL_SYSTEM_APPEND_FILE, undefined, 'niente env su un file che non si puo\' scrivere in sicurezza');
    assert.ok(rDot.engine.vlPromptDegraded.includes('non scrivibile in sicurezza'), 'degrado con motivo');
    assert.ok(!fs.existsSync(path.join(home, '.nexuscrew', 'vl-prompts')), 'nessun file scritto');
    // symlink al posto della directory: stessa difesa del precedente pi
    fs.mkdirSync(path.join(home, 'evil'), { recursive: true });
    fs.symlinkSync(path.join(home, 'evil'), path.join(home, '.nexuscrew'));
    const rLink = vlResolve(home, { id: 'Dev', prompt: 'p' }, { vlVersionProbe: PROBE_031 });
    assert.ok(rLink.engine.vlPromptDegraded.includes('non scrivibile in sicurezza'), 'symlink dir: degrado');
    assert.equal(fs.readdirSync(path.join(home, 'evil')).length, 0, 'NULLA scritto attraverso il symlink');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('V-69 budget: companionInstructions sta in poche righe (<= 2048 caratteri) — oltre, la spesa va ridiscussa', () => {
  // Il testo companion entra nel system di OGNI turno di OGNI cella vl: su un
  // modello locale a 32k non e' gratis. La soglia codifica "poche righe": se il
  // catalogo companions cresce al punto da superarla, questo test cade e la
  // decisione se spenderlo torna a chi la decisione spetta, non al silenzio.
  const { companionInstructions } = require('../lib/mcp/server.js');
  const text = companionInstructions();
  assert.ok(text.length > 0 && text.length <= 2048, `companionInstructions: ${text.length} caratteri (soglia 2048)`);
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

// --- Varianti vl remote: la variante e' la scelta (vl.anthropic, vl.custom) --
// Il runtime vl parla SOLO tre provider (anthropic | anthropic-bearer |
// openai-compat/openai, vivling config/mod.rs) e due endpoint wire
// (/v1/messages, /v1/chat/completions, vl-llm client.rs): il catalogo non puo'
// offrire dialetti che il runtime non sa parlare. La chiave non si copia mai
// dal valore: viaggia per NOME (envPassthrough, D3) e un nome assente da ogni
// fonte non fa partire la cella in silenzio.

function vlRemote(provider, extra = {}) {
  return {
    id: `vl.${provider}`, label: 'VL',
    managed: { client: 'vl', provider, model: '', permissionPolicy: 'standard', ...extra },
  };
}

test('varianti vl: vl.anthropic compone SEMPRE provider e base_url (anche senza modello)', () => {
  const home = homeWithVl();
  try {
    const r0 = resolveManagedEngine(vlRemote('anthropic'), { id: 'Dev' }, { home, env: { VL_API_KEY: 'k' } });
    assert.equal(r0.ok, true);
    assert.equal(r0.engine.env.VL_PROVIDER, 'anthropic', 'la variante e\' la scelta: la coppia esce sempre');
    assert.equal(r0.engine.env.VL_BASE_URL, 'https://api.anthropic.com');
    assert.equal(r0.engine.env.VL_MODEL, undefined, 'senza modello scelto nessuna VL_MODEL');
    const r1 = resolveManagedEngine(vlRemote('anthropic', { model: 'claude-sonnet-5' }), { id: 'Dev' }, { home, env: { VL_API_KEY: 'k' } });
    assert.equal(r1.engine.env.VL_MODEL, 'claude-sonnet-5');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('varianti vl: vl.anthropic porta envPassthrough VL_API_KEY di default; assente ovunque -> fail a voce alta', () => {
  // default portato dal profilo del catalogo, senza che l'operatore dichiari nulla
  const s = normalizeManagedSpec({ client: 'vl', provider: 'anthropic', model: '' });
  assert.ok(s);
  assert.deepEqual(s.envPassthrough, ['VL_API_KEY'], 'il profilo dichiara il NOME, mai il valore');
  // la lista dell'operatore vince sul default del profilo
  const s2 = normalizeManagedSpec({ client: 'vl', provider: 'anthropic', model: '', envPassthrough: ['VL_API_KEY', 'VL_OTHER'] });
  assert.deepEqual(s2.envPassthrough, ['VL_API_KEY', 'VL_OTHER']);
  const home = homeWithVl();
  try {
    // nome assente da ogni fonte: la cella NON parte, e il reason nomina il nome
    const r = resolveManagedEngine(vlRemote('anthropic'), { id: 'Dev' }, { home, env: {} });
    assert.equal(r.ok, false);
    assert.match(r.reason, /VL_API_KEY/);
    assert.match(r.reason, /credential source/i);
    // presente a runtime: iniettata per nome nel child
    const r2 = resolveManagedEngine(vlRemote('anthropic'), { id: 'Dev' }, { home, env: { VL_API_KEY: 'secret' } });
    assert.equal(r2.ok, true);
    assert.equal(r2.engine.env.VL_API_KEY, 'secret');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('varianti vl: vl.custom richiede baseUrl e protocollo fra i tre reali; la coppia esce sempre', () => {
  const base = { client: 'vl', provider: 'custom', displayName: 'GW interno', baseUrl: 'https://gw.internal/anthropic', envKey: '' };
  const okBearer = normalizeManagedSpec({ ...base, protocol: 'anthropic-bearer', model: 'kimi-k2.7' });
  assert.ok(okBearer, 'bearer + endpoint dichiarato: valido');
  assert.equal(normalizeManagedSpec({ ...base, protocol: 'grok', model: 'x' }), null, 'protocollo che il runtime non parla: rifiutato');
  assert.equal(normalizeManagedSpec({ client: 'vl', provider: 'custom', displayName: 'X', protocol: 'openai-compat', model: 'x', envKey: '' }), null, 'senza baseUrl si rifiuta: endpoint obbligatorio, un default spedirebbe un bearer all\'API vera');
  assert.equal(normalizeManagedSpec({ ...base, protocol: 'openai-compat' }), null, 'custom senza modello: requiresModel');
  const okOpenAi = normalizeManagedSpec({ ...base, protocol: 'openai-compat', model: 'gpt-x' });
  assert.equal(Object.prototype.hasOwnProperty.call(okOpenAi, 'envKey'), false, 'envKey vuota ammessa per vl: la chiave, se serve, viaggia per nome');
  const home = homeWithVl();
  try {
    const r = resolveManagedEngine(vlRemote('custom', { displayName: 'GW interno', baseUrl: 'https://gw.internal/anthropic', envKey: '', protocol: 'anthropic-bearer', model: 'kimi-k2.7' }), { id: 'Dev' }, { home, env: {} });
    assert.equal(r.ok, true);
    assert.equal(r.engine.env.VL_PROVIDER, 'anthropic-bearer', 'il protocollo scelto E\' il provider wire');
    assert.equal(r.engine.env.VL_BASE_URL, 'https://gw.internal/anthropic');
    assert.equal(r.engine.env.VL_MODEL, 'kimi-k2.7');
    // la chiave del custom, se dichiarata, viaggia per nome (envPassthrough), mai come valore copiato dallo store
    const r2 = resolveManagedEngine(vlRemote('custom', { displayName: 'Ollama remoto', baseUrl: 'https://ollama.example', envKey: '', protocol: 'openai-compat', model: 'glm-5.2', envPassthrough: ['VL_API_KEY'] }), { id: 'Dev' }, { home, env: { VL_API_KEY: 'sk' } });
    assert.equal(r2.ok, true);
    assert.equal(r2.engine.env.VL_API_KEY, 'sk');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('varianti vl: catalogo onesto — endpoint visibile, protocolli limitati ai tre reali, niente credenziali gestite', () => {
  const vlVoices = publicCatalog().filter((p) => p.client === 'vl');
  assert.deepEqual(vlVoices.map((p) => p.id).sort(), ['vl.anthropic', 'vl.custom', 'vl.native']);
  const TRE = ['anthropic', 'anthropic-bearer', 'openai-compat'];
  for (const p of vlVoices) {
    assert.equal(p.supportsUnsafe, false, `${p.id}: vl resta standard-only`);
    assert.equal(p.mcpManaged, false, `${p.id}: MCP gestito solo per claude`);
    assert.equal(p.rc, false, `${p.id}: nessun remote-control`);
    for (const proto of (p.protocols || [p.protocol])) {
      assert.ok(proto === 'vl_native' || TRE.includes(proto), `${p.id}: protocollo ${proto} fra quelli che il runtime parla`);
    }
  }
  const anth = vlVoices.find((p) => p.id === 'vl.anthropic');
  assert.equal(anth.endpoint, 'https://api.anthropic.com', 'la UI dice dove vive la variante');
  assert.equal(anth.auth, 'none', 'NexusCrew non gestisce credenziali vl: la chiave viaggia per nome');
  const custom = vlVoices.find((p) => p.id === 'vl.custom');
  assert.equal(custom.auth, 'dynamic');
  // il catalogo vl e' un elenco chiuso: un provider mai catalogato si rifiuta (fail-closed)
  assert.equal(normalizeManagedSpec({ client: 'vl', provider: 'openrouter', model: '' }), null, 'provider non in catalogo: niente voce UI che porta a un runtime inesistente');
});

test('varianti vl: profilo remoto incompleto si RIFIUTA nominando il campo (mai ricadere su Ollama in silenzio)', () => {
  // Il catalogo e' codice nostro: una voce remota senza vlProvider o endpoint e'
  // uno stato impossibile che nasce solo da un difetto di scrittura. Il test lo
  // riproduce per mutazione (il freeze dell'array e' shallow: le voci restano
  // mutabili) perche' il difetto vero non e' la voce sbagliata ma la reazione
  // alla voce sbagliata: degradare compose la cella sui default interni
  // (Ollama locale) mentre la UI dice il contrario. Deve rifiutare, e il
  // reason deve NOMINARE il campo che manca — stessa forma del fail-closed
  // delle chiavi.
  const home = homeWithVl();
  const anth = CATALOG.find((p) => p.id === 'vl.anthropic');
  const saved = { vlProvider: anth.vlProvider, endpoint: anth.endpoint };
  try {
    delete anth.endpoint;
    const r1 = resolveManagedEngine(vlRemote('anthropic'), { id: 'Dev' }, { home, env: { VL_API_KEY: 'k' } });
    assert.equal(r1.ok, false, 'senza endpoint la variante remota non parte');
    assert.match(r1.reason, /endpoint/, 'il reason NOMINA il campo mancante');
    assert.match(r1.reason, /vl\.anthropic/, 'il reason nomina il profilo');
    anth.endpoint = saved.endpoint;
    delete anth.vlProvider;
    const r2 = resolveManagedEngine(vlRemote('anthropic'), { id: 'Dev' }, { home, env: { VL_API_KEY: 'k' } });
    assert.equal(r2.ok, false, 'senza vlProvider la variante remota non parte');
    assert.match(r2.reason, /vlProvider/, 'il reason NOMINA l\'altro campo mancante');
    anth.vlProvider = saved.vlProvider;
    // verso opposto: voce completa ripristinata, la coppia torna a comporsi
    const r3 = resolveManagedEngine(vlRemote('anthropic'), { id: 'Dev' }, { home, env: { VL_API_KEY: 'k' } });
    assert.equal(r3.ok, true, 'il rifiuto non stringe troppo: la voce completa riparte');
    assert.equal(r3.engine.env.VL_PROVIDER, 'anthropic');
    assert.equal(r3.engine.env.VL_BASE_URL, 'https://api.anthropic.com');
    // vl.native NON e' toccato: l'assenza delle due env e' la decisione
    // «usa la tua configurazione», non uno stato impossibile
    const rNat = resolveManagedEngine({ id: 'vl.native', label: 'VL', managed: { client: 'vl', provider: 'native', model: 'gemma4:31b', permissionPolicy: 'standard' } }, { id: 'Dev' }, { home, env: {} });
    assert.equal(rNat.ok, true, 'il controllo vale solo per provider !== native');
    assert.equal(rNat.engine.env.VL_MODEL, 'gemma4:31b');
    assert.equal(rNat.engine.env.VL_PROVIDER, undefined);
    assert.equal(rNat.engine.env.VL_BASE_URL, undefined);
  } finally {
    anth.vlProvider = saved.vlProvider;
    anth.endpoint = saved.endpoint;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
