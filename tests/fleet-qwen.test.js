'use strict';
// Qwen (qwen.native) managed client adapter — solo profilo nativo: catalogo e
// ordine, platform gate, probe di versione/flag, argv (approval-mode esplicito,
// append-system-prompt, prompt-interactive), seed e backfill idempotente.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeManagedSpec, describeManaged, resolveManagedEngine, publicCatalog,
  CLIENT_ORDER, CLIENT_LABELS, CATALOG,
} = require('../lib/fleet/managed.js');
const { backfillQwenEngine } = require('../lib/fleet/builtin.js');
const { loadDefinitions, atomicWrite } = require('../lib/fleet/definitions.js');

const QWEN = { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'standard' };
const QWEN_UNSAFE = { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'unsafe' };

// Fixture REALI (ridotte): estratti dell'output --version/--help misurato sui
// due CLI, 0.27.2 e 1.0.0-preview. La versione esce NUDA dal CLI (nessun
// prefisso) e lo stderr e' vuoto; i valori di policy stanno nel blocco della
// LORO opzione (descrizione yargs + [choices] per la 0.x, righe continuate per
// la 1.0). Le righe di opzione e descrizione sono riportate tal quali.
const PROBE_OK = { stdout: '0.27.2\n', stderr: '' };
const HELP_OK = [
  'Usage: qwen [options] [command]',
  'Options:',
  '  -m, --model                           Model  [string]',
  '  -i, --prompt-interactive              Execute the provided prompt and continue in interactive mode  [string]',
  '      --system-prompt                   Override the main session system prompt for this run. Can be combined with --append-system-prompt.  [string]',
  '      --append-system-prompt            Append instructions to the main session system prompt for this run. Can be combined with --system-prompt.  [string]',
  '  -y, --yolo                            Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?  [boolean] [default: false]',
  '      --approval-mode                   Set the approval mode: plan (Analyze only, do not modify files or execute commands), default (Require approval for file edits or shell commands), auto-edit (Automatically approve file edits), auto (LLM classifier auto-approves safe actions, blocks risky ones), yolo (Automatically approve all tools)  [string] [choices: "plan", "default", "auto-edit", "auto", "yolo"]',
].join('\n');
const PROBE_10 = { stdout: '1.0.0-preview\n', stderr: '' };
const HELP_10 = [
  'Usage: qwen [options] [command] [query...]',
  'Options:',
  '  -m, --model <model>                  Model for the current session. Default',
  '                                       and New Models use model name; Custom',
  '                                       uses modelID',
  '  -i, --prompt-interactive <text>      Execute prompt and continue in',
  '                                       interactive mode',
  '  --config-dir <dir>                   Use a custom user-level config root for',
  '                                       this run',
  '  --permission-mode <mode>             Set the permission mode (choices:',
  '                                       default, accept_edits,',
  '                                       bypass_permissions, dont_ask, auto)',
  '  --dangerously-skip-permissions       Bypass all permission checks',
  '  --append-system-prompt <text>        Append to the default system prompt',
].join('\n');

function homeWithQwen() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqwen-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'qwen');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return home;
}

function cfgConProbe(home, { version = PROBE_OK, help = HELP_OK, platform = 'linux' } = {}) {
  return {
    home, platform, env: {},
    qwenVersionProbe: () => version,
    qwenHelpProbe: () => help,
  };
}

test('qwen: catalogo con la SOLA voce nativa; ordine dopo pi, prima di opencode', () => {
  assert.equal(CLIENT_LABELS.qwen, 'qwen');
  assert.ok(CLIENT_ORDER.indexOf('qwen') === CLIENT_ORDER.indexOf('pi') + 1, 'qwen subito dopo pi');
  assert.ok(CLIENT_ORDER.indexOf('qwen') < CLIENT_ORDER.indexOf('opencode'), 'qwen prima di opencode');
  const voci = publicCatalog().filter((p) => p.client === 'qwen');
  assert.equal(voci.length, 1, 'una sola voce qwen (nessun profilo remoto)');
  const cat = voci[0];
  assert.equal(cat.id, 'qwen.native');
  assert.equal(cat.provider, 'native');
  assert.equal(cat.auth, 'login');
  assert.equal(cat.protocol, 'qwen_native');
  assert.equal(cat.default, true);
  assert.equal(cat.rc, false);
  assert.equal(cat.supportsUnsafe, true);
  assert.equal(cat.permissionPolicyDefault, 'standard');
  assert.equal(cat.mcpManaged, false, 'MCP resta nella configurazione utente/progetto di Qwen');
  assert.equal(CATALOG.find((e) => e.id === 'qwen.native').core, true, 'voce core nel catalogo interno');
});

test('qwen: normalizeManagedSpec ammette standard e unsafe', () => {
  assert.deepEqual(normalizeManagedSpec(QWEN), { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'standard' });
  assert.equal(normalizeManagedSpec(QWEN_UNSAFE).permissionPolicy, 'unsafe');
  assert.equal(normalizeManagedSpec({ client: 'qwen', provider: 'native', permissionPolicy: 'bogus' }), null);
});

test('qwen platform gate: linux/darwin non-Termux si; Termux/android/win32 no', () => {
  const home = homeWithQwen();
  try {
    const base = { home, platform: 'linux', env: {}, qwenVersionProbe: () => PROBE_OK, qwenHelpProbe: () => HELP_OK };
    assert.equal(describeManaged(QWEN, { ...base, env: { PREFIX: '/data/data/com.termux/files/usr' } }).configured, false);
    const t = describeManaged(QWEN, { ...base, platform: 'android' });
    assert.equal(t.configured, false);
    assert.match(t.reason, /non supportato su questa piattaforma/);
    assert.equal(describeManaged(QWEN, { ...base, platform: 'win32' }).configured, false);
    assert.equal(describeManaged(QWEN, { ...base }).configured, true, 'linux non-Termux con binario e versione qualificata');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen probe versione: assente, vecchia, help senza flag nativi -> configured false con motivo', () => {
  const home = homeWithQwen();
  try {
    const casi = [
      { version: null, match: /versione|version/i, etichetta: 'assente', nullVersion: true },
      { version: { stdout: 'qwen 0.26.0\n', stderr: '' }, match: /0\.27\.2|vecchia|minore/i, etichetta: 'vecchia' },
      { version: { stdout: 'qualcosa di incomprensibile\n', stderr: '' }, match: /versione|version/i, etichetta: 'incomprensibile' },
      { help: 'nessun flag qui', match: /flag|approval-mode/i, etichetta: 'help senza flag' },
    ];
    for (const caso of casi) {
      const cfg = cfgConProbe(home, {
        version: caso.nullVersion ? null : (caso.version || PROBE_OK),
        help: caso.help || HELP_OK,
      });
      const d = describeManaged(QWEN, cfg);
      assert.equal(d.configured, false, `${caso.etichetta}: non configurato`);
      assert.match(String(d.reason), caso.match, `${caso.etichetta}: motivo esplicito`);
    }
    // la versione si legge dal SOLO stdout: stderr con la versione di Node non conta
    const okStderrNodo = { stdout: '0.27.2\n', stderr: '(Node.js v18.0.0)\n' };
    assert.equal(describeManaged(QWEN, cfgConProbe(home, { version: okStderrNodo })).configured, true,
      'la versione Node nello stderr non viene interpretata come versione Qwen');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen probe: cache per identita del binario (una sola esecuzione per binario)', () => {
  const home = homeWithQwen();
  try {
    let chiamate = 0;
    const cfg = {
      home, platform: 'linux', env: {},
      qwenVersionProbe: () => { chiamate += 1; return PROBE_OK; },
      qwenHelpProbe: () => HELP_OK,
    };
    describeManaged(QWEN, cfg);
    describeManaged(QWEN, cfg);
    assert.equal(chiamate, 1, 'seconda valutazione servita dalla cache');
    // un binario diverso (path diverso) non riusa la cache
    const cfg2 = { ...cfg, home: homeWithQwen() };
    describeManaged(QWEN, cfg2);
    assert.equal(chiamate, 2, 'binario diverso: nuova esecuzione');
    fs.rmSync(cfg2.home, { recursive: true, force: true });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen argv: approval-mode esplicito SEMPRE; yolo solo per unsafe; model prima del prompt', () => {
  const home = homeWithQwen();
  try {
    const eng = (pp) => ({ id: 'qwen.native', managed: { client: 'qwen', provider: 'native', model: '', permissionPolicy: pp } });
    const cell = (extra = {}) => ({ id: 'qwen.native', ...extra });
    const cfg = cfgConProbe(home);
    // standard, no model, no prompt -> TUI con il solo approval-mode esplicito
    const r0 = resolveManagedEngine(eng('standard'), cell(), cfg);
    assert.equal(r0.ok, true);
    assert.deepEqual(r0.engine.args, ['--approval-mode', 'default']);
    // unsafe -> yolo, MAI --yolo aggiuntivo
    const r1 = resolveManagedEngine(eng('unsafe'), cell(), cfg);
    assert.deepEqual(r1.engine.args, ['--approval-mode', 'yolo']);
    assert.ok(!r1.engine.args.includes('--yolo'), 'il CLI rifiuta approval-mode+yolo insieme');
    // model + prompt: ordine approval-mode, model, append-system-prompt, prompt-interactive, <prompt>
    const r2 = resolveManagedEngine(eng('standard'), cell({ model: 'qwen3-max', prompt: 'sei la cella uno' }), cfg);
    assert.deepEqual(r2.engine.args, [
      '--approval-mode', 'default', '--model', 'qwen3-max',
      '--append-system-prompt', 'sei la cella uno',
      '--prompt-interactive', 'sei la cella uno',
    ]);
    // il prompt e' SEMPRE l'ultimo argomento: valore della SOLA coppia
    // --prompt-interactive (esattamente un turno di bootstrap; la stessa
    // istruzione compare anche nell'identita' --append-system-prompt)
    assert.equal(r2.engine.args[r2.engine.args.length - 1], 'sei la cella uno');
    assert.equal(r2.engine.args.filter((a) => a === '--prompt-interactive').length, 1, 'una sola coppia --prompt-interactive');
    const iPI = r2.engine.args.indexOf('--prompt-interactive');
    assert.equal(r2.engine.args[iPI + 1], 'sei la cella uno', 'il valore della coppia e il testo in coda coincidono');
    // niente headless: nessun -p e nessun posizionale
    assert.ok(!r2.engine.args.includes('-p'), '-p e il posizionale sono headless');
    assert.ok(!r2.engine.args.includes('--prompt'), '--prompt (headless) mai usato');
    // prompt multilinea con caratteri shell: resta UNA stringa unica
    const r3 = resolveManagedEngine(eng('standard'), cell({ prompt: 'riga uno\nriga "due" $HOME `x`' }), cfg);
    const i3 = r3.engine.args.indexOf('--prompt-interactive');
    assert.equal(r3.engine.args[i3 + 1], 'riga uno\nriga "due" $HOME `x`', 'prompt multilinea come stringa unica');
    // override per-cella vince sul default dell'engine
    const r4 = resolveManagedEngine(eng('standard'), { id: 'qwen.native', permissionPolicies: { 'qwen.native': 'unsafe' } }, cfg);
    assert.deepEqual(r4.engine.args, ['--approval-mode', 'yolo']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen argv: versione non qualificata rifiuta il lancio, fail-closed', () => {
  const home = homeWithQwen();
  try {
    const eng = { id: 'qwen.native', managed: { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'standard' } };
    const cfg = cfgConProbe(home, { version: { stdout: 'qwen 0.26.0\n', stderr: '' } });
    const r = resolveManagedEngine(eng, { id: 'qwen.native' }, cfg);
    assert.equal(r.ok, false, 'versione sotto soglia: nessun lancio');
    assert.match(String(r.reason), /0\.27\.2|versione|version/i);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen backfill: idempotente, platform-aware, non distruttivo su collisione id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqwenbf-'));
  try {
    const dp = (engines) => {
      const p = path.join(root, `f-${Math.random().toString(36).slice(2)}.json`);
      atomicWrite(p, { schemaVersion: 1, engines, cells: [] });
      return p;
    };
    const base = [{ id: 'claude.native', label: 'Claude', rc: true, managed: { client: 'claude', provider: 'native', permissionPolicy: 'unsafe' } }];
    // linux -> aggiunge qwen.native
    const p1 = dp(base);
    const a1 = backfillQwenEngine(p1, loadDefinitions(p1), { platform: 'linux' });
    assert.ok(a1.engines.some((e) => e.id === 'qwen.native'), 'aggiunto su linux');
    // idempotente: secondo giro senza diff
    const a1b = backfillQwenEngine(p1, a1, { platform: 'linux' });
    assert.equal(a1b.engines.filter((e) => e.id === 'qwen.native').length, 1);
    assert.equal(JSON.stringify(a1b.engines), JSON.stringify(a1.engines), 'secondo avvio senza diff');
    // un client qwen gia' presente (altro profilo) -> skip
    const pQ = dp([...base, { id: 'qwen.secondo', label: 'qwen', managed: { client: 'qwen', provider: 'native', model: '' } }]);
    const aQ = backfillQwenEngine(pQ, loadDefinitions(pQ), { platform: 'linux' });
    assert.equal(aQ.engines.some((e) => e.id === 'qwen.native'), false, 'client qwen esistente: skip');
    // collisione id: custom con id qwen.native -> preservato
    const p4 = dp([{ id: 'qwen.native', label: 'Custom', rc: false, command: '/bin/x', args: [], env: {}, promptMode: 'flag', promptFlag: '-p' }]);
    const a4 = backfillQwenEngine(p4, loadDefinitions(p4), { platform: 'linux' });
    assert.equal(a4.engines.length, 1);
    assert.equal(a4.engines[0].command, '/bin/x', 'collisione: custom preservato');
    // android -> no-op; darwin -> aggiunge
    const p2 = dp(base);
    assert.equal(backfillQwenEngine(p2, loadDefinitions(p2), { platform: 'android' }).engines.some((e) => e.id === 'qwen.native'), false);
    const p3 = dp(base);
    assert.ok(backfillQwenEngine(p3, loadDefinitions(p3), { platform: 'darwin' }).engines.some((e) => e.id === 'qwen.native'));
    // celle invariate e cap rispettato
    const pC = dp(base);
    atomicWrite(pC, {
      schemaVersion: 1,
      engines: [...base, { id: 'sh', command: '/bin/sh', promptMode: 'send-keys' }],
      cells: [{ id: 'C', cwd: '/tmp', engine: 'sh' }],
    });
    const cellePrima = JSON.stringify(loadDefinitions(pC).cells);
    const aC = backfillQwenEngine(pC, loadDefinitions(pC), { platform: 'linux' });
    assert.equal(JSON.stringify(aC.cells), cellePrima, 'nessuna cella toccata');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('qwen seed: qwen.native entra dopo pi; claude.native resta primo; nessuna cella cambia engine', async () => {
  const { defaultDefinitions } = require('../lib/fleet/managed.js');
  const defs = defaultDefinitions();
  const ids = defs.engines.filter((e) => e.managed && e.managed.client).map((e) => e.id);
  assert.equal(ids[0], 'claude.native', 'claude.native resta il primo default');
  assert.ok(ids.includes('qwen.native'), 'qwen.native nel seed');
  assert.ok(ids.indexOf('qwen.native') > ids.indexOf('pi.native'), 'dopo pi');
  assert.equal(ids.filter((id) => id.startsWith('qwen.')).length, 1, 'una sola voce qwen nel seed');
});

// --- Addendum 1.0: dialetti, probe isolato, qwenBinary/qwenConfigDir -------------

// CLI finto REALE: eseguito davvero dal probe isolato. Registra argv, cwd e le
// variabili di radice che riceve, poi risponde a --version/--help. Varianti:
// exit non zero, output enorme, riscrittura di sé (per il TOCTOU).
function scriviCliFinto(dir, { versione = 'qwen 0.27.2\n', help = HELP_OK, exitCode = 0, enorme = false, registra = true } = {}) {
  const bin = path.join(dir, 'qwen');
  const corpo = [
    '#!/usr/bin/env node',
    `"use strict";`,
    `const fs = require('node:fs');`,
    `const path = require('node:path');`,
    // il log vive ACCANTO al binario: il probe isolato non passa env extra
    `const log = path.join(__dirname, 'probe.log');`,
    registra ? `try { fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), QWEN_HOME: process.env.QWEN_HOME || null, QWEN_CONFIG_DIR: process.env.QWEN_CONFIG_DIR || null, HOME: process.env.HOME || null, SEGRETO: process.env.QWEN_FAKE_SEGRETO || null, PATHPresente: !!process.env.PATH }) + "\\n"); } catch (_) {} ` : `void fs; void log;`,
    `if (process.argv.includes('--version')) { process.stdout.write(${JSON.stringify(versione)}); ${enorme ? 'process.stdout.write("x".repeat(300*1024));' : ''} process.exit(${exitCode}); }`,
    `if (process.argv.includes('--help')) { process.stdout.write(${JSON.stringify(`${help}\n`)}); process.exit(${exitCode}); }`,
    `process.exit(1);`,
  ].join('\n');
  fs.writeFileSync(bin, corpo, { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return bin;
}

function homeConBinFinto(opzioni = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqwenfake-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  scriviCliFinto(path.join(home, '.local', 'bin'), { ...opzioni });
  return { home, log: path.join(home, '.local', 'bin', 'probe.log') };
}

test('qwen dialetti (0.9.83 solo 0.x): 0.x stabile >= 0.27.2 qualifica; prerelease 0.x rifiutata; OGNI 1.x, 1.1+ e major2+ rifiutate', () => {
  const home = homeWithQwen();
  try {
    const dialetto = (version, help = HELP_OK) => describeManaged(QWEN, cfgConProbe(home, { version: { stdout: `${version}\n`, stderr: '' }, help }));
    // 0.x stabile >= 0.27.2 -> unica famiglia supportata
    assert.equal(dialetto('qwen 0.27.2').configured, true);
    assert.equal(dialetto('qwen 0.29.1').configured, true);
    // prerelease 0.x NON qualificata -> rifiuto
    const pre0 = dialetto('qwen 0.28.0-beta.1');
    assert.equal(pre0.configured, false, 'prerelease 0.x rifiutata');
    assert.match(String(pre0.reason), /prerelease|preview|qualificat/i);
    // taglio «solo Qwen 0.x»: ogni 1.x (preview, suffissi, stabili) rifiutata
    // con motivo di FAMIGLIA — anche con l'help completo della 1.0, e anche
    // con un help 1.0 che esponesse i flag della 0.x (v. test R7 dedicato)
    for (const v of ['Qwen Code 1.0.0-preview', 'qwen 1.0.0-preview.3', 'qwen 1.0.4', 'qwen 1.1.0', 'qwen 2.0.0']) {
      const r = dialetto(v, HELP_10);
      assert.equal(r.configured, false, `${v}: rifiutata`);
      assert.match(String(r.reason), /1\.x family|stable 0\.x|not supported|qualif/i, `${v}: motivo di famiglia (${r.reason})`);
    }
    // 1.0 con help 0.x: rifiuta comunque (la famiglia si decide dalla versione)
    assert.equal(dialetto('qwen 1.0.4', HELP_OK).configured, false, '1.0 con help 0.x rifiuta');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen help: le opzioni si leggono dai blocchi Options; flag solo nella descrizione non vale; valori policy nel blocco', () => {
  const home = homeWithQwen();
  try {
    // il flag citato SOLO in una frase ("removed --approval-mode") non documenta l'opzione
    const helpFrase = [
      '  --model <id>  model id',
      '  --append-system-prompt <text>  removed --approval-mode in this release',
      '  --prompt-interactive <text>  first turn',
    ].join('\n');
    const r1 = describeManaged(QWEN, cfgConProbe(home, { help: helpFrase }));
    assert.equal(r1.configured, false, 'flag citato solo in descrizione: non qualifica');
    assert.match(String(r1.reason), /approval-mode|flag/i);
    // valori di policy fuori dal blocco dell'opzione non valgono: il blocco
    // reale di --approval-mode perde la sua descrizione (valori inclusi) e i
    // valori ricompaiono SOLO nella descrizione di un'altra opzione
    const helpValoriFuori = HELP_OK
      .replace(/^ {6}--approval-mode\s+Set the approval mode.*$/m, '      --approval-mode                   Set the approval mode  [string]')
      .replace('  -m, --model                           Model  [string]', '  -m, --model                           Model (modes: default yolo)  [string]');
    const r2 = describeManaged(QWEN, cfgConProbe(home, { help: helpValoriFuori }));
    assert.equal(r2.configured, false, 'valori policy fuori dal blocco: non qualificano');
    // il blocco dell opzione senza i valori attesi (niente yolo) rifiuta: il
    // flag SEPARATO -y/--yolo dell'help reale non sostituisce il valore
    const helpSenzaYolo = HELP_OK
      .replace(', yolo (Automatically approve all tools)', '')
      .replace(', "yolo"', '');
    const r3 = describeManaged(QWEN, cfgConProbe(home, { help: helpSenzaYolo }));
    assert.equal(r3.configured, false, 'yolo non documentato nel blocco: rifiuto');
    // 1.0: bypass_permissions dev stare nel blocco di --permission-mode
    const help10SenzaBypass = HELP_10.replace('bypass_permissions, dont_ask, auto)', 'dont_ask, auto)');
    const r4 = describeManaged(QWEN, cfgConProbe(home, { version: PROBE_10, help: help10SenzaBypass }));
    assert.equal(r4.configured, false, 'bypass_permissions non documentato: rifiuto');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen probe isolato: scratch con QWEN_HOME/QWEN_CONFIG_DIR, cwd scratch, nessuna credenziale; sentinel 0.x intatto', () => {
  const { home, log } = homeConBinFinto();
  try {
    // sentinel: la radice operativa 0.x dell'utente non va toccata dal probe
    const radice0x = path.join(home, '.qwen');
    fs.mkdirSync(radice0x, { recursive: true });
    const sentinel = path.join(radice0x, 'settings.json');
    fs.writeFileSync(sentinel, '{"sentinel":true}\n', { mode: 0o600 });
    const prima = fs.readFileSync(sentinel, 'utf8');
    process.env.QWEN_FAKE_SEGRETO = 'segreto-che-non-deve-passare';
    try {
      const d = describeManaged(QWEN, { home, platform: 'linux', env: { ...process.env, QWEN_FAKE_SEGRETO: 'segredo-che-non-deve-passare' } });
      assert.equal(d.configured, true, JSON.stringify(d.reason));
      const righe = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      for (const r of righe) {
        assert.ok(r.QWEN_HOME && r.QWEN_HOME !== home && r.QWEN_HOME !== radice0x, 'QWEN_HOME punta allo scratch, non alla home');
        assert.equal(r.QWEN_HOME, r.QWEN_CONFIG_DIR, 'QWEN_CONFIG_DIR uguale allo scratch del probe');
        assert.ok(r.cwd && r.cwd !== home && r.cwd.startsWith(os.tmpdir()), 'cwd scratch');
        assert.notEqual(r.HOME, home, 'HOME del probe non e la home operativa');
        assert.equal(r.HOME, null, 'il probe non eredita HOME: ambiente costruito da zero col solo PATH');
        assert.equal(r.SEGRETO, null, 'nessuna credenziale ereditata dal probe');
        assert.equal(r.PATHPresente, true, 'PATH minimo presente per eseguire');
      }
      assert.equal(fs.readFileSync(sentinel, 'utf8'), prima, 'sentinel 0.x byte-identico');
      assert.equal(fs.readdirSync(radice0x).length, 1, 'nessun nuovo file nella radice 0.x');
    } finally { delete process.env.QWEN_FAKE_SEGRETO; }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen probe: exit non zero e output oltre il cap rifiutano con motivo', () => {
  for (const caso of [{ exitCode: 3, etichetta: 'exit non zero' }, { enorme: true, etichetta: 'output oltre il cap' }]) {
    const { home } = homeConBinFinto(caso);
    try {
      const d = describeManaged(QWEN, { home, platform: 'linux', env: {} });
      assert.equal(d.configured, false, `${caso.etichetta}: rifiuto`);
      assert.match(String(d.reason), /risponde|version|output/i, `${caso.etichetta}: motivo`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test('qwen cache: identita dev/ino/size/mtime; replace riconfigura; stat fallita niente cache sul path', () => {
  const { home } = homeConBinFinto();
  try {
    let chiamate = 0;
    const c = { home, platform: 'linux', env: {}, qwenVersionProbe: () => { chiamate += 1; return PROBE_OK; }, qwenHelpProbe: () => HELP_OK };
    describeManaged(QWEN, c);
    describeManaged(QWEN, c);
    assert.equal(chiamate, 1, 'cache servita per identita identica');
    // replace del binario (ino/size/mtime cambiano): NUOVA qualifica
    fs.writeFileSync(path.join(home, '.local', 'bin', 'qwen'), '#!/bin/sh\nexit 0\n# piu lungo di prima\n', { mode: 0o755 });
    describeManaged(QWEN, c);
    assert.equal(chiamate, 2, 'replace del binario: cache invalidata');
    // stat che fallisce: NESSUNA lettura/scrittura di cache sul solo path
    const fsReale = require('node:fs');
    const statReale = fsReale.statSync;
    const bin = path.join(home, '.local', 'bin', 'qwen');
    fsReale.statSync = function (...a) { if (String(a[0]) === bin) { const e = new Error('stat boom'); e.code = 'EIO'; throw e; } return statReale.apply(this, a); };
    try {
      describeManaged(QWEN, c);
      assert.equal(chiamate, 3, 'stat fallita: il probe si riesegue, niente cache sul path');
    } finally { fsReale.statSync = statReale; }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen trust sul percorso automatico (0.9.83): candidato root-owned ammesso come findBinary; owner estraneo, non regolare, non eseguibile, world-writable rifiutati', () => {
  const home = homeWithQwen();
  const fsReale = require('node:fs');
  const bin = path.join(home, '.local', 'bin', 'qwen');
  const base = cfgConProbe(home, { version: PROBE_OK, help: HELP_OK });
  // findBinary esplora anche candidati FUORI dalla home di test (bin del nodo
  // che esegue, /usr/local/bin, ...): sul nodo possono esistere davvero e
  // diventerebbero un ripiego involontario. Il fake li rende ENOENT e tocca
  // SOLO il candidato della home, cosi' il verdetto descrive lui.
  const lstatReale = fsReale.lstatSync;
  const conLstatFinto = (uidOverride, corpo) => {
    fsReale.lstatSync = function (...a) {
      const p = path.resolve(String(a[0]));
      // ogni path FUORI dalla home di test e' un candidato esterno (anche via
      // symlink, v. il launcher nvm che risolve in lib/node_modules): assente
      const dentroHome = p === path.resolve(home) || p.startsWith(`${path.resolve(home)}${path.sep}`);
      if (!dentroHome) {
        const e = new Error('ENOENT: candidato esterno alla home di test');
        e.code = 'ENOENT';
        throw e;
      }
      const st = lstatReale.apply(this, a);
      if (p === path.resolve(bin) && uidOverride !== undefined) {
        return {
          ...st, uid: uidOverride,
          isFile: st.isFile.bind(st), isDirectory: st.isDirectory.bind(st), isSymbolicLink: st.isSymbolicLink.bind(st),
        };
      }
      return st;
    };
    try { return corpo(); } finally { fsReale.lstatSync = lstatReale; }
  };
  try {
    // (1) prova positiva del trust root-owned ADATTATA al percorso automatico
    // (il selettore esplicito e' ritirato): uid del servizio o root, MAI
    // eseguito davvero (i probe sono seam).
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const dRoot = conLstatFinto(0, () => describeManaged(QWEN, base));
      assert.equal(dRoot.configured, true, JSON.stringify(dRoot.reason));
      assert.equal(dRoot.binary, fs.realpathSync(bin), 'candidato root-owned del PATH qualificato');
    }

    // (2) owner estraneo (né del servizio né root): rifiuto, nessun ripiego.
    const dEstraneo = conLstatFinto(4242, () => describeManaged(QWEN, base));
    assert.equal(dEstraneo.configured, false, 'owner estraneo: rifiuto');
    assert.match(String(dEstraneo.reason), /trovato|binario|qwen/i);

    // (3) non regolare / non eseguibile / world-writable sul candidato del
    // percorso automatico: rifiuto (il candidato viene scavalcato, non eseguito)
    for (const [etichetta, prepara] of [
      ['non regolare', () => { fs.rmSync(bin, { recursive: true, force: true }); fs.mkdirSync(bin); }],
      ['non eseguibile', () => { fs.rmSync(bin, { recursive: true, force: true }); fs.writeFileSync(bin, 'x', { mode: 0o644 }); fs.chmodSync(bin, 0o644); }],
      ['world-writable', () => { fs.chmodSync(bin, 0o777); }],
    ]) {
      prepara();
      const d = conLstatFinto(undefined, () => describeManaged(QWEN, base));
      assert.equal(d.configured, false, `${etichetta}: rifiuto`);
      assert.match(String(d.reason), /trovato|binario|qwen/i, `${etichetta}: motivo (${d.reason})`);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen argv legacy-0: mai permission-mode né config-dir', () => {
  const home = homeWithQwen();
  try {
    const cfg = cfgConProbe(home);
    const r = resolveManagedEngine(
      { id: 'qwen.native', managed: { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'standard' } },
      { id: 'qwen.native' },
      cfg,
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.engine.args, ['--approval-mode', 'default']);
    assert.ok(!r.engine.args.includes('--permission-mode'), 'mai permission-mode sulla 0.x');
    assert.ok(!r.engine.args.includes('--config-dir'), 'mai config-dir sulla 0.x');
    assert.ok(!r.engine.args.includes('--strict-mcp-config') && !r.engine.args.includes('--mcp-config'), 'nessun flag MCP composto da qui');
    assert.ok(!('QWEN_CONFIG_DIR' in r.engine.env), 'nessuna QWEN_CONFIG_DIR sulla 0.x');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen passthrough 0.x: QWEN_CONFIG_DIR ambientale scartata, lo store nativo non viene ridiretto', () => {
  const home = homeWithQwen();
  try {
    // decisione dichiarata: sulla 0.x il nome NON e' rifiutato (il rifiuto
    // esplicito e' un contratto della sola 1.0), ma e' scartato dal
    // passthrough — una radice ambientale pensata per la 1.0 non deve
    // cambiare la configurazione nativa della 0.x.
    const cfg = { ...cfgConProbe(home), env: { QWEN_CONFIG_DIR: '/tmp/altra-radice' } };
    const r = resolveManagedEngine(
      { id: 'qwen.native', managed: { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'standard', envPassthrough: ['QWEN_CONFIG_DIR'] } },
      { id: 'qwen.native' },
      cfg,
    );
    assert.equal(r.ok, true, JSON.stringify(r.reason));
    assert.ok(!('QWEN_CONFIG_DIR' in r.engine.env), 'la 0.x non riceve QWEN_CONFIG_DIR dal passthrough');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen prompt che inizia con -: forma --prompt-interactive= e --append-system-prompt= (valore, mai opzione)', () => {
  const home = homeWithQwen();
  try {
    const cfg = cfgConProbe(home);
    const r = resolveManagedEngine(
      { id: 'qwen.native', managed: { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'standard' } },
      { id: 'qwen.native', prompt: '--print comandi per favore' },
      cfg,
    );
    assert.equal(r.ok, true);
    const a = r.engine.args;
    assert.ok(a.includes('--append-system-prompt=--print comandi per favore'), 'append in forma =');
    assert.ok(a.includes('--prompt-interactive=--print comandi per favore'), 'prompt-interactive in forma =');
    const idx = a.indexOf('--prompt-interactive=--print comandi per favore');
    assert.equal(a[idx + 1], undefined, 'nessun valore separato dopo la forma =');
    assert.ok(!a.includes('--print'), 'il testo non diventa mai un opzione separata');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});


test('qwen semver stretta (0.9.83): prerelease numerica senza zeri in testa, build con identificatori non vuoti', () => {
  const home = homeWithQwen();
  try {
    const caso = (version, help = HELP_OK) => describeManaged(QWEN, cfgConProbe(home, { version: { stdout: `${version}\n`, stderr: '' }, help }));
    // identificatore prerelease NUMERICO con zeri in testa: non e' semver valido
    // (la 0.28.0-beta.01 e' prerelease 0.x: rifiutata due volte, come semver
    // invalida e come prerelease — qui conta che NON qualifichi mai)
    assert.equal(caso('0.28.0-beta.01').configured, false, 'beta.01 rifiutata');
    // build metadata con identificatori vuoti: non e' semver valido
    assert.equal(caso('0.27.2+..').configured, false, 'build "+.." rifiutato');
    assert.equal(caso('0.27.2+abc..def').configured, false, 'identificatore build vuoto rifiutato');
    // positivi preservati sul ramo 0.x: zeri nel build metadata leciti
    assert.equal(caso('0.27.2+abc.01').configured, true, 'zeri nel build metadata leciti');
    assert.equal(caso('0.30.0+build.7').configured, true, 'build metadata valido qualifica');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen cache: il positivo e la cache attestano l\'identita DOPO l\'help, mai obsoleta', () => {
  const home = homeWithQwen();
  try {
    const bin = path.join(home, '.local', 'bin', 'qwen');
    let chiamate = 0;
    let riscritture = 0;
    // il probe --help modifica il binario SOLO alla prima chiamata e poi
    // restituisce un help valido: la finestra del riesame e' esattamente fra
    // la lettura di identita (pre-help) e la memorizzazione del positivo.
    const cfg = {
      home, platform: 'linux', env: {},
      qwenVersionProbe: () => { chiamate += 1; return PROBE_OK; },
      qwenHelpProbe: () => {
        if (riscritture === 0) {
          riscritture += 1;
          fs.writeFileSync(bin, `#!/bin/sh\n# sostituito dall'help\n${'#'.repeat(321)}\nexit 0\n`, { mode: 0o755 });
        }
        return HELP_OK;
      },
    };
    const d = describeManaged(QWEN, cfg);
    assert.equal(d.configured, true, JSON.stringify(d.reason));
    assert.equal(chiamate, 2, 'il cambio osservato dopo l\'help fa ripetere il ciclo UNA volta');
    const sizeReale = fs.statSync(bin).size;
    const verdetti = [...(cfg._qwenProbeCache || new Map()).values()];
    assert.ok(verdetti.length > 0, 'cache popolata');
    for (const v of verdetti) {
      if (v.ok) {
        assert.equal(v.identity.size, sizeReale, 'il positivo in cache attesta la size ATTUALE, non quella di prima dell\'help');
      }
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen qualifica severa (0.9.83): stdout univoco, semver valida, policy come token interi, Options con confini', () => {
  const home = homeWithQwen();
  try {
    const caso = (version, help = HELP_OK) => describeManaged(QWEN, cfgConProbe(home, { version, help }));
    // stdout con due righe riconoscibili: ambiguo, rifiuto (mai "la prima che torna")
    assert.equal(caso({ stdout: 'qwen 0.27.2\nQwen Code 0.29.0\n', stderr: '' }).configured, false, 'stdout ambiguo rifiutato');
    // semver invalida: zeri in testa
    assert.equal(caso({ stdout: 'qwen 00.027.002\n', stderr: '' }).configured, false, 'zeri in testa rifiutati');
    // numeri fuori scala (arrotondamenti/overflow non gestiti a caso)
    assert.equal(caso({ stdout: 'qwen 0.27.9999999999\n', stderr: '' }).configured, false, 'numeri fuori scala rifiutati');
    // prerelease 0.x: rifiutata dal contratto solo-stabili
    assert.equal(caso({ stdout: 'qwen 0.28.0-rc.1\n', stderr: '' }).configured, false, 'prerelease 0.x rifiutata');
    // valori di policy come SOTTOSTRINGE di altre parole non documentano nulla
    const helpSottostringa = HELP_OK.replace(/^ {6}--approval-mode.*$/m, '  --approval-mode <mode>  default_disabled, not_yolo  [string]');
    assert.equal(caso({ stdout: PROBE_OK.stdout, stderr: '' }, helpSottostringa).configured, false, 'policy come sottostringa rifiutata');
    // flag citati solo negli esempi: superficie non documentata come opzioni
    const helpExamples = [
      'Examples:',
      '  --approval-mode default',
      '  -m, --model id',
      '  --append-system-prompt text',
      '  -i, --prompt-interactive text',
    ].join('\n');
    assert.equal(caso({ stdout: PROBE_OK.stdout, stderr: '' }, helpExamples).configured, false, 'flag negli esempi non qualificano');
    // positivi 0.x: 0.27.2 (stderr Node irrilevante) e una 0.x successiva
    assert.equal(caso({ stdout: '0.27.2\n', stderr: '(Node.js v24.21.0)\n' }).configured, true, '0.27.2 con stderr Node qualifica');
    assert.equal(caso({ stdout: 'qwen 0.31.0\n', stderr: '' }).configured, true, '0.x successiva stabile qualifica');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen help: esempi con TUTTI i valori di policy fuori da Options non qualificano', () => {
  const home = homeWithQwen();
  try {
    const caso = (version, help) => describeManaged(QWEN, cfgConProbe(home, { version, help }));
    // Confine di Options: sotto `Examples:` compaiono TUTTI i flag richiesti e
    // TUTTI i valori della policy del dialetto. Se il parser non rispettasse i
    // confini (ogni sezione letta come opzioni), questo help QUALIFICHEREBBE:
    // il contratto invece e' che senza opzioni documentate nel blocco Options
    // si rifiuta, per quanto completi siano gli esempi.
    const esempiLegacy = [
      'Usage: qwen [options]',
      'Options:',
      'Examples:',
      '  --approval-mode default',
      '  --approval-mode yolo',
      '  -m, --model id',
      '  --append-system-prompt text',
      '  -i, --prompt-interactive text',
    ].join('\n');
    const rLegacy = caso({ stdout: '0.27.2\n', stderr: '' }, esempiLegacy);
    assert.equal(rLegacy.configured, false, 'esempi completi (default E yolo) fuori da Options: non qualificano');
    assert.match(String(rLegacy.reason), /is missing the required flags/, 'nessuna opzione documentata: il motivo nomina i flag mancanti');
    // 1.0 con TUTTI i flag (anche della 0.x) negli esempi: rifiutata dalla
    // famiglia PRIMA del gate dei flag (taglio «solo Qwen 0.x»)
    const esempi10 = [
      'Usage: qwen [options]',
      'Options:',
      'Examples:',
      '  --approval-mode default',
      '  --approval-mode yolo',
      '  -m, --model id',
      '  --append-system-prompt text',
      '  -i, --prompt-interactive text',
    ].join('\n');
    const r10 = caso({ stdout: '1.0.0-preview\n', stderr: '' }, esempi10);
    assert.equal(r10.configured, false, '1.0 con esempi completi fuori da Options: rifiutata');
    assert.match(String(r10.reason), /1\.x family|stable 0\.x|not supported/i, `motivo di famiglia (${r10.reason})`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen cache: cap con evizione del più vecchio', () => {
  const home = homeWithQwen();
  try {
    const bin = path.join(home, '.local', 'bin', 'qwen');
    let chiamate = 0;
    const c = {
      home, platform: 'linux', env: {},
      qwenVersionProbe: () => { chiamate += 1; return PROBE_OK; },
      qwenHelpProbe: () => HELP_OK,
    };
    // 70 identità distinte (contenuto, quindi size, diversi): ogni giro e' un
    // miss con una chiave nuova — la cache deve restare LIMITATA, buttando il
    // verdetto più vecchio, non crescere senza fine.
    for (let giro = 0; giro < 70; giro += 1) {
      fs.writeFileSync(bin, `#!/bin/sh\n# giro ${giro}\n${'#'.repeat(64 + giro)}\nexit 0\n`, { mode: 0o755 });
      assert.equal(describeManaged(QWEN, c).configured, true, `giro ${giro}`);
    }
    assert.equal(chiamate, 70, 'una qualifica per identità distinta');
    assert.ok(c._qwenProbeCache && c._qwenProbeCache.size <= 64, `cache limitata (size ${c._qwenProbeCache ? c._qwenProbeCache.size : 'n/d'})`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen TOCTOU: binario cambiato fra qualifica e lancio: una riconfigurazione, poi rifiuto', () => {
  const home = homeWithQwen();
  try {
    const bin = path.join(home, '.local', 'bin', 'qwen');
    let chiamate = 0;
    // il probe riscrive IL BINARIO a ogni chiamata: dopo la riconfigurazione
    // il file e di nuovo diverso -> rifiuto (mai lanciare qualificando A e eseguendo B)
    const cfg = {
      home, platform: 'linux', env: {},
      qwenVersionProbe: () => {
        chiamate += 1;
        // lunghezza DIVERSA per ogni chiamata: size e' parte dell'identita
        fs.writeFileSync(bin, `#!/bin/sh\n# corpo ${chiamate}\n${'#'.repeat(64 + chiamate * 17)}\nexit 0\n`, { mode: 0o755 });
        return PROBE_OK;
      },
      qwenHelpProbe: () => HELP_OK,
    };
    const r = resolveManagedEngine(
      { id: 'qwen.native', managed: { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'standard' } },
      { id: 'qwen.native' },
      cfg,
    );
    assert.equal(r.ok, false, 'binario che cambia sotto il probe: rifiuto');
    assert.match(String(r.reason), /changed|qualification|reconfiguration/i);
    assert.equal(chiamate, 2, 'UNA sola riconfigurazione prima del rifiuto: qualifica + riqualifica, mai un terzo probe');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen TOCTOU: binario cambiato UNA volta e poi stabile: la riqualifica riesce al secondo colpo', () => {
  const home = homeWithQwen();
  try {
    const bin = path.join(home, '.local', 'bin', 'qwen');
    let chiamate = 0;
    // il probe riscrive il binario SOLO alla prima chiamata: la riqualifica
    // osserva un file poi stabile e il lancio passa con esattamente 2 probe.
    const cfg = {
      home, platform: 'linux', env: {},
      qwenVersionProbe: () => {
        chiamate += 1;
        if (chiamate === 1) fs.writeFileSync(bin, `#!/bin/sh\n# corpo sostituito\n${'#'.repeat(222)}\nexit 0\n`, { mode: 0o755 });
        return PROBE_OK;
      },
      qwenHelpProbe: () => HELP_OK,
    };
    const r = resolveManagedEngine(
      { id: 'qwen.native', managed: { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'standard' } },
      { id: 'qwen.native' },
      cfg,
    );
    assert.equal(r.ok, true, JSON.stringify(r.reason));
    assert.equal(chiamate, 2, 'qualifica + UNA riqualifica, poi il file e\' stabile');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('qwen TOCTOU: cambiato DOPO la riqualifica: rifiuto senza un ulteriore probe', () => {
  const home = homeWithQwen();
  try {
    const bin = path.join(home, '.local', 'bin', 'qwen');
    let chiamate = 0;
    let letture = 0;
    // Identita' SINTETICHE schedulate per indice di lettura del binario (il
    // file non cambia davvero: e' la lettura a riportare metadata diversi, lo
    // stesso seam dichiarato del test uid 4242). Il gate legge
    // identity/pre/dopo/post-help (letture 1-4), la identity del gate del
    // lancio serve dalla cache (lettura 5, identica: hit), poi
    // qwenStillQualified osserva: il cambio compare alla SESTA lettura (B),
    // resta coerente durante l'UNICA riqualifica (letture 7-10: stessa B) e
    // cambia di nuovo all'UNDICESIMA (C): rifiuto immediato, senza un terzo
    // probe. Le soglie seguono il numero di letture del gate: se il gate
    // cambia quante identita' legge, questo test va ricalibrato.
    const statReale = fs.statSync;
    const sizeA = statReale.call(fs, bin).size;
    const sizeB = sizeA + 1111;
    const sizeC = sizeA + 2222;
    fs.statSync = function (...a) {
      if (path.resolve(String(a[0])) === path.resolve(bin)) {
        letture += 1;
        const st = statReale.apply(fs, a);
        if (letture >= 11) return { ...st, size: sizeC, mtimeMs: st.mtimeMs + 90 };
        if (letture >= 6) return { ...st, size: sizeB, mtimeMs: st.mtimeMs + 60 };
        return st;
      }
      return statReale.apply(fs, a);
    };
    let r = null;
    try {
      const cfg = {
        home, platform: 'linux', env: {},
        qwenVersionProbe: () => { chiamate += 1; return PROBE_OK; },
        qwenHelpProbe: () => HELP_OK,
      };
      r = resolveManagedEngine(
        { id: 'qwen.native', managed: { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'standard' } },
        { id: 'qwen.native' },
        cfg,
      );
    } finally { fs.statSync = statReale; }
    assert.equal(r.ok, false, 'cambiato di nuovo dopo la riqualifica: avvio rifiutato');
    assert.match(String(r.reason), /changed|reconfiguration|stable/i);
    assert.equal(chiamate, 2, 'una qualifica + UNA riqualifica; alla seconda osservazione si rifiuta SENZA un terzo probe');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});


test('R7 esclusione 1.x: ogni 1.x (preview e stabili), 1.1+ e major2+ rifiutate con motivo famiglia; help 1.0 con i flag 0.x non salva; 0.x resta positiva', () => {
  const home = homeWithQwen();
  try {
    const rifiuta = (v, help, etichetta) => {
      const d = describeManaged(QWEN, cfgConProbe(home, { version: { stdout: `${v}\n`, stderr: '' }, help }));
      assert.equal(d.configured, false, `${etichetta || v} deve rifiutare`);
      assert.match(String(d.reason), /1\.x family|stable 0\.x|not supported/i, `motivo di ${etichetta || v}: ${d.reason}`);
      return d;
    };
    rifiuta('1.0.0-preview', HELP_10);
    rifiuta('1.0.0-preview.3', HELP_10);
    rifiuta('1.0.0', HELP_10, '1.0.0 stabile');
    rifiuta('1.0.4', HELP_10, '1.0.4 stabile');
    rifiuta('1.1.0', HELP_10);
    rifiuta('2.0.0', HELP_10);
    // perfino con un help che espone TUTTI i flag 0.x in Options: il gate dei
    // flag non può salvare una famiglia rifiutata.
    const help10ConFlag0x = `${HELP_10}\n      --approval-mode <mode>       default, yolo  [string]\n`;
    rifiuta('1.0.0', help10ConFlag0x, '1.0.0 con help che espone i flag 0.x');
    // positivi 0.x conservati dal taglio
    assert.equal(describeManaged(QWEN, cfgConProbe(home)).configured, true, '0.27.2 resta positiva');
    assert.equal(describeManaged(QWEN, cfgConProbe(home, { version: { stdout: '0.31.0\n', stderr: '' } })).configured, true, '0.x successiva stabile resta positiva');
    assert.equal(describeManaged(QWEN, cfgConProbe(home, { version: { stdout: '0.27.2+build.01\n', stderr: '' } })).configured, true, 'build metadata valido resta positivo');
    // negativi 0.x conservati: sotto-minimo, prerelease 0.x
    assert.equal(describeManaged(QWEN, cfgConProbe(home, { version: { stdout: '0.27.1\n', stderr: '' } })).configured, false, 'sotto il minimo rifiuta');
    assert.equal(describeManaged(QWEN, cfgConProbe(home, { version: { stdout: '0.28.0-beta\n', stderr: '' } })).configured, false, 'prerelease 0.x rifiutata');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('R7 campi ritirati: qwenBinary/qwenConfigDir rifiutati da normalize (ogni forma, anche vuoto/null), describe con motivo che NOMINA il campo', () => {
  const home = homeWithQwen();
  try {
    const varianti = [
      ['qwenBinary valido', { ...QWEN, qwenBinary: '/opt/qwen/qwen-preview' }],
      ['qwenConfigDir valida', { ...QWEN, qwenConfigDir: path.join(home, '.config', 'qwen-preview') }],
      ['entrambi', { ...QWEN, qwenBinary: '/opt/qwen/qwen-preview', qwenConfigDir: path.join(home, '.config', 'p') }],
      ['qwenBinary vuoto', { ...QWEN, qwenBinary: '' }],
      ['qwenConfigDir null', { ...QWEN, qwenConfigDir: null }],
      ['su altro client', { client: 'claude', provider: 'native', permissionPolicy: 'unsafe', qwenBinary: '/opt/qwen/qwen-preview' }],
    ];
    for (const [nome, spec] of varianti) {
      assert.equal(normalizeManagedSpec(spec), null, `normalize rifiuta: ${nome}`);
    }
    // describe/resolver col vecchio payload: il motivo NOMINA il campo ritirato,
    // non «invalid managed profile» né «nessun Qwen trovato»
    for (const campo of ['qwenBinary', 'qwenConfigDir']) {
      const d = describeManaged({ ...QWEN, [campo]: '/opt/qwen/qwen-preview' }, cfgConProbe(home));
      assert.equal(d.configured, false, `${campo}: configured false`);
      assert.match(String(d.reason), new RegExp(campo), `il motivo nomina ${campo}: ${d.reason}`);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('R7 campi ritirati: resolver con oggetto in memoria rifiuta SENZA eseguire il binario dichiarato né il candidato del PATH, senza creare radici', () => {
  const home = homeWithQwen();
  try {
    // due sentinel distinti: chi è stato eseguito si vede
    const eseguitoDichiarato = path.join(home, 'eseguito-dichiarato');
    const eseguitoPath = path.join(home, 'eseguito-path');
    const dichiarato = path.join(home, 'qwen-preview');
    fs.writeFileSync(dichiarato, `#!/bin/sh\ntouch '${eseguitoDichiarato}'\ncase "$1" in --version) echo 1.0.0-preview ;; --help) cat <<'H'\n${HELP_10}\nH\n ;; esac\nexit 0\n`, { mode: 0o755 });
    fs.chmodSync(dichiarato, 0o755);
    // il candidato sul PATH risponde come una 0.x valida: dopo il rifiuto del
    // campo NON deve partire nemmeno lui (nessun ripiego silenzioso)
    const bin = path.join(home, '.local', 'bin', 'qwen');
    fs.writeFileSync(bin, `#!/bin/sh\ntouch '${eseguitoPath}'\ncase "$1" in --version) echo 0.27.2 ;; --help) cat <<'H'\n${HELP_OK}\nH\n ;; esac\nexit 0\n`, { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
    const engine = { id: 'qwen.native', managed: { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'standard', qwenBinary: dichiarato } };
    const r = resolveManagedEngine(engine, { id: 'qwen.native' }, { home, platform: 'linux', env: {} });
    assert.equal(r.ok, false, 'il lancio con il campo ritirato rifiuta');
    assert.match(String(r.reason), /qwenBinary/, `il motivo nomina il campo: ${r.reason}`);
    assert.ok(!fs.existsSync(eseguitoDichiarato), 'il binario dichiarato non è mai stato eseguito (zero probe)');
    assert.ok(!fs.existsSync(eseguitoPath), 'nessun ripiego: il candidato del PATH non è stato eseguito');
    assert.ok(!fs.existsSync(path.join(home, '.config')), 'nessuna radice preview creata o toccata');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('R7 campi ritirati: file fleet mixed (engine validi + uno sperimentale) rifiuta strict e diagnosticato, byte originali preservati', () => {
  const { parseDefinitions } = require('../lib/fleet/definitions.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqwenmixed-'));
  try {
    const doc = {
      schemaVersion: 1,
      engines: [
        { id: 'claude.native', label: 'claude', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } },
        { id: 'qwen.native', label: 'qwen', rc: false, managed: { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'standard', qwenBinary: '/opt/qwen/qwen-preview' } },
      ],
      cells: [],
    };
    const issues = [];
    const parsed = parseDefinitions(doc, { onIssue: (i) => issues.push(i) });
    assert.equal(parsed, null, 'il documento con il campo ritirato rifiuta (strict, tutto il file)');
    assert.ok(issues.some((i) => /qwenBinary/.test(String(i.field))), `l\'issue nomina il campo ritirato: ${JSON.stringify(issues)}`);
    // il file su disco resta BYTE-IDENTICO dopo il load fallito: nessun
    // backfill, nessun default, nessuna riscrittura sopra la definizione
    const file = path.join(home, 'fleet.json');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    const prima = fs.readFileSync(file, 'utf8');
    const out = {};
    assert.equal(loadDefinitions(file, out), null, 'loadDefinitions rifiuta il file mixed');
    assert.equal(fs.readFileSync(file, 'utf8'), prima, 'byte originali preservati');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('R7 R6-02: stat del binario illeggibile (EACCES/EIO) subito dopo l\'help non dà configured true né cache positiva', () => {
  for (const code of ['EACCES', 'EIO']) {
    const home = homeWithQwen();
    try {
      const bin = path.join(home, '.local', 'bin', 'qwen');
      // Identita' schedulata per indice di lettura del binario (stesso seam del
      // test TOCTOU): letture 1-3 reali (identity, pre, dopo), la QUARTA è la
      // post-help e fallisce col code dato. Versione 0.27.2 e help 0.x completi.
      const statReale = fs.statSync;
      let letture = 0;
      fs.statSync = function (...a) {
        if (path.resolve(String(a[0])) === path.resolve(bin)) {
          letture += 1;
          if (letture === 4) {
            const e = new Error(`${code}: synthetic`);
            e.code = code;
            throw e;
          }
        }
        return statReale.apply(fs, a);
      };
      let d = null;
      const cfg = {
        home, platform: 'linux', env: {},
        qwenVersionProbe: () => PROBE_OK,
        qwenHelpProbe: () => HELP_OK,
      };
      try {
        d = describeManaged(QWEN, cfg);
      } finally { fs.statSync = statReale; }
      assert.equal(d.configured, false, `${code}: mai configured true con identità non attestabile (${d.reason})`);
      assert.match(String(d.reason), /identit|verificabil|stabile/i, `${code}: il motivo parla di identità non verificabile (${d.reason})`);
      const positivi = [...(cfg._qwenProbeCache || new Map()).values()].filter((v) => v && v.ok);
      assert.equal(positivi.length, 0, `${code}: nessun positivo in cache con identità precedente`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test('R7 form e i18n: nessun campo qwen nel form; chiavi dei campi ASSENTI in IT/EN/ES; notice qwen solo 0.x', async () => {
  const forms = await import('../frontend/src/lib/fleet-forms.js');
  const i18n = await import('../frontend/src/lib/i18n.js');
  const { blankEngine, engineForm, buildEngine } = forms;
  // blankEngine non dichiara più i campi ritirati
  const blank = blankEngine();
  assert.ok(!('qwenBinary' in blank) && !('qwenConfigDir' in blank), 'blankEngine senza i campi ritirati');
  // un form che li portasse ancora (stato vecchio) non li fa viaggiare nel payload
  const riporto = buildEngine({ ...blankEngine(), client: 'qwen', provider: 'native', permissionPolicy: 'standard', qwenBinary: '/opt/qwen/qwen-preview' }, true);
  assert.ok(!('qwenBinary' in riporto.managed) && !('qwenConfigDir' in riporto.managed), 'buildEngine non emette mai i campi ritirati');
  // engineForm non li legge da un engine vecchio: non finiscono nello stato del form
  const form = engineForm({ id: 'qwen.native', label: 'qwen', rc: false, managed: { client: 'qwen', provider: 'native', model: '', permissionPolicy: 'standard', qwenBinary: '/opt/qwen/qwen-preview' } }, []);
  assert.ok(!('qwenBinary' in form) && !('qwenConfigDir' in form), 'engineForm ignora i campi ritirati');
  // i18n: le due chiavi dei campi NON esistono più; la notice parla solo 0.x
  const diz = i18n.DICTS || {};
  for (const l of ['it', 'en', 'es']) {
    for (const campo of ['fleet-engine-qwen-binary', 'fleet-engine-qwen-config-dir']) {
      assert.ok(!(diz[l] && diz[l][campo]), `${campo} rimossa in ${l}`);
    }
    const notice = diz[l] && diz[l]['fleet-provider-notice-qwen-native'];
    assert.ok(typeof notice === 'string' && notice.length > 10, `notice qwen presente in ${l}`);
    assert.match(notice, /0\.27\.2/, `notice qwen dichiara la versione minima in ${l}`);
    assert.ok(!/preview|1\.0|permission-mode|config-dir|bypass_permissions/i.test(notice), `notice qwen senza superficie 1.0 in ${l}: ${notice}`);
  }
});

// ---------------------------------------------------------------------------
// R8 — correzioni del riesame (canonicalizzazione fail-closed, presenza
// propria dei campi ritirati). Test scritti ROSSI sulla base 59f5e9a8.

test('R8 R7-01: realpath non risolvibile nella chiave della cache DOPO una prima risoluzione riuscita: rifiuto, nessun positivo, nessuna cache positiva', () => {
  for (const code of ['EACCES', 'EIO', 'ENOENT']) {
    const home = homeWithQwen();
    try {
      const bin = path.join(home, '.local', 'bin', 'qwen');
      // PRIMA risoluzione piena, senza patch: il percorso buono resta buono e
      // la qualifica riesce (il rifiuto nuovo riguarda SOLO la
      // canonicalizzazione non attestabile, non il candidato valido).
      const cfgBuono = cfgConProbe(home);
      assert.equal(describeManaged(QWEN, cfgBuono).configured, true, `${code}: prima risoluzione riuscita`);
      // SECONDA invocazione con cache PULITA: la prima chiamata realpath del
      // binario (scoperta del candidato) riesce, la SECONDA (costruzione della
      // chiave del gate) fallisce col code dato. Nessun ripiego sul path
      // dichiarato: atteso rifiuto strutturato, zero positivi in cache.
      const realReale = fs.realpathSync;
      let letture = 0;
      fs.realpathSync = function (...a) {
        if (path.resolve(String(a[0])) === path.resolve(bin)) {
          letture += 1;
          if (letture >= 2) {
            const e = new Error(`${code}: synthetic`);
            e.code = code;
            throw e;
          }
        }
        return realReale.apply(this, a);
      };
      let d = null;
      const cfg = cfgConProbe(home);
      try {
        d = describeManaged(QWEN, cfg);
      } finally { fs.realpathSync = realReale; }
      assert.equal(d.configured, false, `${code}: mai configured true con canonicalizzazione non attestabile (${d.reason})`);
      assert.match(String(d.reason), /canonicalization|verifiab/i, `${code}: il motivo e' strutturato sulla canonicalizzazione (${d.reason})`);
      const positivi = [...(cfg._qwenProbeCache || new Map()).values()].filter((v) => v && v.ok);
      assert.equal(positivi.length, 0, `${code}: nessuna cache positiva costruita sul path dichiarato`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test('R8 R7-01: realpath non risolvibile nella chiave FINALE dopo una riqualifica: rifiuto, nessun positivo, nessuna cache positiva', () => {
  for (const code of ['EACCES', 'EIO', 'ENOENT']) {
    const home = homeWithQwen();
    try {
      const bin = path.join(home, '.local', 'bin', 'qwen');
      let riscritture = 0;
      // L'help RISCRIVE il binario alla prima chiamata (identita' leggibile,
      // cambiamento OSSERVATO): il gate riqualifica con la singola
      // ritentativa e il positivo descrive il file NUOVO. La chiave finale
      // richiede un nuovo realpath del file qualificato — che qui fallisce.
      const cfg = {
        home, platform: 'linux', env: {},
        qwenVersionProbe: () => PROBE_OK,
        qwenHelpProbe: () => {
          if (riscritture === 0) {
            riscritture += 1;
            fs.writeFileSync(bin, `#!/bin/sh\n# sostituito dall'help\n${'#'.repeat(321)}\nexit 0\n`, { mode: 0o755 });
          }
          return HELP_OK;
        },
      };
      const realReale = fs.realpathSync;
      let letture = 0;
      fs.realpathSync = function (...a) {
        if (path.resolve(String(a[0])) === path.resolve(bin)) {
          letture += 1;
          if (letture >= 3) {
            const e = new Error(`${code}: synthetic`);
            e.code = code;
            throw e;
          }
        }
        return realReale.apply(this, a);
      };
      let d = null;
      try {
        d = describeManaged(QWEN, cfg);
      } finally { fs.realpathSync = realReale; }
      assert.equal(d.configured, false, `${code}: mai configured true con chiave finale non canonicalizzabile (${d.reason})`);
      assert.match(String(d.reason), /canonicalization|verifiab/i, `${code}: il motivo e' strutturato sulla canonicalizzazione (${d.reason})`);
      const positivi = [...(cfg._qwenProbeCache || new Map()).values()].filter((v) => v && v.ok);
      assert.equal(positivi.length, 0, `${code}: nessuna cache positiva dopo la riqualifica non canonicalizzabile`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test('R8 R7-02: presenza propria dei campi ritirati (non enumerabili, valore undefined) rifiutata con campo NOMINATO da normalize, describe e resolver', () => {
  const home = homeWithQwen();
  try {
    const casi = [];
    for (const campo of ['qwenBinary', 'qwenConfigDir']) {
      const spec = { ...QWEN };
      Object.defineProperty(spec, campo, { value: undefined, enumerable: false });
      casi.push([campo, spec]);
    }
    const entrambi = { ...QWEN };
    Object.defineProperty(entrambi, 'qwenBinary', { value: undefined, enumerable: false });
    Object.defineProperty(entrambi, 'qwenConfigDir', { value: undefined, enumerable: false });
    casi.push(['qwenBinary,qwenConfigDir', entrambi]);
    for (const [nome, spec] of casi) {
      // normalize: la presenza PROPRIA del campo rifiuta anche se il valore e'
      // undefined e la proprieta' non e' enumerabile (non representable in
      // JSON, ma il resolver accetta oggetti in memoria); l'issue NOMINA il campo.
      const issues = [];
      const n = normalizeManagedSpec(spec, { onIssue: (i) => issues.push(i) });
      assert.equal(n, null, `${nome}: normalize rifiuta la presenza propria, indipendente da valore ed enumerabilita'`);
      assert.ok(issues.some((i) => String(i.field).includes(nome.split(',')[0])), `${nome}: l'issue NOMINA il campo (${JSON.stringify(issues)})`);
      // describe: configured false con motivo che NOMINA il campo
      const d = describeManaged(spec, cfgConProbe(home));
      assert.equal(d.configured, false, `${nome}: describe configured false`);
      assert.ok(nome.split(',').some((c) => String(d.reason).includes(c)), `${nome}: il motivo di describe nomina il campo (${d.reason})`);
      // resolver diretto con l'oggetto in memoria: rifiuto NOMINATO, senza
      // eseguire nulla (i probe sarebbero validi: se partisse, qualificherebbe)
      const r = resolveManagedEngine(
        { id: 'qwen.native', managed: spec },
        { id: 'qwen.native' },
        cfgConProbe(home),
      );
      assert.equal(r.ok, false, `${nome}: resolver rifiuta l'oggetto in memoria`);
      assert.ok(nome.split(',').some((c) => String(r.reason).includes(c)), `${nome}: il motivo del resolver nomina il campo (${r.reason})`);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
