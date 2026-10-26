'use strict';
// 0.8.47 — Bootstrap prompt delivery per kimi.native + claude.kimi-code:
// classifier pane enum-only (readiness reale, mai UNKNOWN->READY a timeout),
// consegna AT-MOST-ONCE (un solo paste+Enter per generazione; retry solo
// pre-paste), actionRequired bounded con recovery da catalogo (mai /login
// Anthropic per kimi-code), boundary env names-only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  classifyPane, deliverBootstrapPrompt, actionRequiredFor,
  PANE_STATES, DELIVERY_STATES, ACTION_CODES, RECOVERY_SLUGS,
} = require('../lib/fleet/prompt-delivery.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { resolveManagedEngine } = require('../lib/fleet/managed.js');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { main: cellExecMain, startGenerationPrompt } = require('../lib/fleet/cell-exec.js');
const { EventEmitter } = require('node:events');

// --- Schermate TUI reali (probe tmux, 2026-07-31): claude 2.1.220, kimi 0.31.1
const CLAUDE_CONSENT = [
  '  Detected a custom API key in your environment',
  '',
  '  ANTHROPIC_API_KEY: sk-ant-...xxxx',
  '',
  '  Do you want to use this API key?',
  '',
  '    1. Yes',
  '  ❯ 2. No (recommended)',
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n');
const CLAUDE_TRUST = [
  ' Quick safety check: Is this a project you created or one you trust?',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
].join('\n');
const CLAUDE_NOT_LOGGED_IN = [
  '│             Welcome back!          │',
  '',
  '────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────',
  '  ⏸ manual mode on · ? for shortcuts · ← for agents                     Not logged in · Run /login',
].join('\n');
const CLAUDE_READY = [
  '│             Welcome back!          │',
  '',
  '────────────────────────────────────',
  '❯ Try "create a util logging.py that..."',
  '────────────────────────────────────',
  '  ⏸ manual mode on · ? for shortcuts · ← for agents                               ● high · /effort',
].join('\n');
const KIMI_LOGGED_OUT = [
  '│  ▐█▛█▛█▌  Welcome to Kimi Code!     │',
  '│  ▐█████▌  Run /login or /provider to get started. │',
  '│  Model:     not set, run /login or /provider      │',
  '',
  ' ╭──────────────────────────────────────────╮',
  ' │ >                                        │',
  ' ╰──────────────────────────────────────────╯',
  ' /tmp/x                       /goal for multi-step work with a clear finish line',
].join('\n');
const KIMI_READY = [
  '│  Model:     K3                          │',
  '│  MCP:       18 connected, 5 disabled    │',
  '',
  ' ╭──────────────────────────────────────────╮',
  ' │ >                                        │',
  ' ╰──────────────────────────────────────────╯',
  ' K3 thinking: high  /tmp/x                             ! to run a shell command',
  '                                                   context: 0% (0/1M)',
].join('\n');

// ===========================================================================
// 1. Classifier: enum-only, marker modali/full-screen vs coda, mai falso ready
// ===========================================================================
test('classifier: stati bounded e copertura dei pattern live-verificati', () => {
  for (const s of ['ready', 'busy', 'not-ready-auth', 'not-ready-consent', 'not-ready-onboarding', 'unknown']) {
    assert.ok(PANE_STATES.includes(s));
  }
  assert.equal(classifyPane(CLAUDE_CONSENT, 'claude'), 'not-ready-consent');
  assert.equal(classifyPane(CLAUDE_TRUST, 'claude'), 'not-ready-onboarding');
  assert.equal(classifyPane(CLAUDE_NOT_LOGGED_IN, 'claude'), 'not-ready-auth');
  assert.equal(classifyPane(CLAUDE_READY, 'claude'), 'ready');
  assert.equal(classifyPane(KIMI_LOGGED_OUT, 'kimi'), 'not-ready-auth');
  assert.equal(classifyPane(KIMI_READY, 'kimi'), 'ready');
  // il cursore ❯ dei dialoghi NON e' un prompt pronto (marker modali vincono)
  assert.equal(classifyPane(`${CLAUDE_READY}\n${CLAUDE_CONSENT}`, 'claude'), 'not-ready-consent');
  // kimi: input box da sola non basta (presente anche logged-out)
  assert.equal(classifyPane(' ╭───╮\n │ > │\n ╰───╯\n /tmp/x /goal for multi-step work\n', 'kimi'), 'unknown');
  // kimi: modello configurato senza box input non basta (G2)
  assert.equal(classifyPane('Model:     K3\ncontext: 0% (0/1M)\n', 'kimi'), 'unknown');
  // vuoto / client ignoto / busy
  assert.equal(classifyPane('', 'claude'), 'unknown');
  assert.equal(classifyPane('   \n  ', 'kimi'), 'unknown');
  assert.equal(classifyPane(CLAUDE_READY, 'codex'), 'unknown');
  assert.equal(classifyPane(`${CLAUDE_READY}\nesc to interrupt`, 'claude'), 'busy');
  // marker auth in CODA: testo identico altrove non classifica come auth
  // (Not logged in va in status bar; qui simuliamo posizione non-coda lunga)
  const padded = `${Array(40).fill('x'.repeat(30)).join('\n')}\n❯ \nstatus ok\n`;
  assert.equal(classifyPane(padded, 'claude'), 'ready');
});

// ===========================================================================
// 2. deliverBootstrapPrompt: at-most-once, retry solo pre-paste, zero duplicati
// ===========================================================================
// tmuxExecImpl scripted: registra le chiamate e applica failure injection.
function fakeTmux(script = {}) {
  const calls = [];
  const exec = async (bin, args) => {
    const cmd = args[0];
    calls.push(args.join(' '));
    if (cmd === 'display-message') {
      if (script.resolveFails) return { err: new Error('x'), stdout: '', stderr: '', code: 1 };
      const pane = script.paneAfterResolve || '%42';
      // formato esatto resolveSessionPane: session_name, pane_dead, pane_id
      return { err: null, stdout: `${script.sessionName || 'cloud-T'}\t0\t${pane}\n`, stderr: '', code: 0 };
    }
    if (cmd === 'load-buffer' && script.loadFailsFirst && !script._loadFailed) {
      script._loadFailed = true;
      return { err: new Error('load'), stdout: '', stderr: 'load fail', code: 1 };
    }
    if (cmd === 'load-buffer' && script.loadFails) return { err: new Error('load'), stdout: '', stderr: '', code: 1 };
    if (cmd === 'paste-buffer' && script.pasteFails) return { err: new Error('paste'), stdout: '', stderr: 'paste fail', code: 1 };
    if (cmd === 'send-keys' && script.enterFails) return { err: new Error('enter'), stdout: '', stderr: '', code: 1 };
    return { err: null, stdout: '', stderr: '', code: 0 };
  };
  return { calls, exec };
}

const READY_CAPTURE = () => async () => CLAUDE_READY;
const BASE = { tmuxBin: 'tmux', session: 'cloud-T', prompt: 'boot prompt', client: 'claude', readyWaitMs: 0 };

test('delivery: ready -> submitted con UN paste e UN Enter; tmp 0600 wx', async () => {
  const { calls, exec } = fakeTmux();
  const r = await deliverBootstrapPrompt({
    ...BASE, tmuxExecImpl: exec, captureImpl: READY_CAPTURE(),
  });
  assert.equal(r.delivered, true);
  assert.equal(r.state, 'submitted');
  assert.equal(r.reason, 'submitted', 'reason = state (closed enum, G5)');
  assert.equal(r.attempts, 1);
  assert.equal(calls.filter((c) => c.startsWith('paste-buffer')).length, 1, 'un solo paste');
  assert.equal(calls.filter((c) => c.startsWith('send-keys -t %42 Enter')).length, 1, 'un solo Enter sul %N');
  assert.equal(calls.filter((c) => c.startsWith('load-buffer')).length, 1);
  const lb = calls.find((c) => c.startsWith('load-buffer'));
  assert.match(lb, /-b ncstage-[a-f0-9]{16}/, 'buffer random per invio (mai ncsend condiviso)');
  assert.ok(!calls.some((c) => c.includes('boot prompt')), 'prompt mai in argv tmux');
});

test('delivery: consent/auth/onboarding -> skipped-not-ready, ZERO paste e ZERO Enter, TUI vivo', async () => {
  for (const [screen, kind] of [
    [CLAUDE_CONSENT, 'not-ready-consent'],
    [CLAUDE_TRUST, 'not-ready-onboarding'],
    [CLAUDE_NOT_LOGGED_IN, 'not-ready-auth'],
    [KIMI_LOGGED_OUT, 'not-ready-auth'],
  ]) {
    const { calls, exec } = fakeTmux();
    const r = await deliverBootstrapPrompt({
      ...BASE, client: kind === 'not-ready-auth' && screen === KIMI_LOGGED_OUT ? 'kimi' : 'claude',
      tmuxExecImpl: exec, captureImpl: async () => screen,
    });
    assert.equal(r.delivered, false);
    assert.equal(r.state, 'skipped-not-ready');
    assert.equal(r.notReady, kind);
    assert.equal(r.attempts, 0);
    assert.equal(calls.filter((c) => c.startsWith('paste-buffer')).length, 0, `zero paste su ${kind}`);
    assert.equal(calls.filter((c) => c.startsWith('send-keys')).length, 0, `zero Enter su ${kind}`);
    assert.equal(calls.filter((c) => c.startsWith('kill-session')).length, 0, 'sessione mai uccisa');
  }
});

test('delivery: UNKNOWN persistente -> skipped-unknown, MAI ready a timeout', async () => {
  let clock = 0;
  const { calls, exec } = fakeTmux();
  const r = await deliverBootstrapPrompt({
    ...BASE, readyWaitMs: 1000, pollMs: 300,
    tmuxExecImpl: exec, captureImpl: async () => 'loading…\n',
    nowImpl: () => clock, sleepImpl: async (ms) => { clock += ms; },
  });
  assert.equal(r.state, 'skipped-unknown');
  assert.equal(r.notReady, '');
  assert.equal(calls.filter((c) => c.startsWith('paste-buffer')).length, 0);
  assert.ok(clock >= 1000, 'attesa bounded rispettata');
});

test('delivery: busy -> attesa poi ready -> submitted (transizione)', async () => {
  let clock = 0; const screens = [`${CLAUDE_READY}\nesc to interrupt`, CLAUDE_READY];
  const { exec } = fakeTmux();
  const r = await deliverBootstrapPrompt({
    ...BASE, readyWaitMs: 1000, pollMs: 200,
    tmuxExecImpl: exec, captureImpl: async () => screens.shift() || CLAUDE_READY,
    nowImpl: () => clock, sleepImpl: async (ms) => { clock += ms; },
  });
  assert.equal(r.state, 'submitted');
});

test('delivery: fallimento certo PRE-paste (load) -> UN retry, poi submitted', async () => {
  const { calls, exec } = fakeTmux({ loadFailsFirst: true });
  const r = await deliverBootstrapPrompt({
    ...BASE, tmuxExecImpl: exec, captureImpl: READY_CAPTURE(),
  });
  assert.equal(r.state, 'submitted');
  assert.equal(r.attempts, 2);
  assert.equal(calls.filter((c) => c.startsWith('load-buffer')).length, 2);
  assert.equal(calls.filter((c) => c.startsWith('paste-buffer')).length, 1, 'un solo paste (G1)');
  assert.equal(calls.filter((c) => c.startsWith('send-keys')).length, 1, 'un solo Enter');
});

test('delivery: load sempre fallito -> failed-pre-paste dopo 1 retry, zero paste', async () => {
  const { calls, exec } = fakeTmux({ loadFails: true });
  const r = await deliverBootstrapPrompt({
    ...BASE, tmuxExecImpl: exec, captureImpl: READY_CAPTURE(),
  });
  assert.equal(r.state, 'failed-pre-paste');
  assert.equal(r.attempts, 2);
  assert.equal(calls.filter((c) => c.startsWith('paste-buffer')).length, 0);
  assert.equal(calls.filter((c) => c.startsWith('send-keys')).length, 0);
});

test('delivery: paste-buffer fallito -> delivery-unknown, MAI retry post-paste (G1)', async () => {
  const { calls, exec } = fakeTmux({ pasteFails: true });
  const r = await deliverBootstrapPrompt({
    ...BASE, tmuxExecImpl: exec, captureImpl: READY_CAPTURE(),
  });
  assert.equal(r.state, 'delivery-unknown');
  assert.equal(r.attempts, 1);
  assert.equal(calls.filter((c) => c.startsWith('paste-buffer')).length, 1, 'nessun secondo paste');
  assert.equal(calls.filter((c) => c.startsWith('send-keys')).length, 0);
});

test('delivery: Enter fallito dopo paste ok -> staged-not-submitted, zero replay', async () => {
  const { calls, exec } = fakeTmux({ enterFails: true });
  const r = await deliverBootstrapPrompt({
    ...BASE, tmuxExecImpl: exec, captureImpl: READY_CAPTURE(),
  });
  assert.equal(r.state, 'staged-not-submitted');
  assert.equal(calls.filter((c) => c.startsWith('paste-buffer')).length, 1);
  assert.equal(calls.filter((c) => c.startsWith('send-keys')).length, 1, 'un solo tentativo di Enter');
});

test('delivery: pane cambiato dopo il paste -> delivery-unknown prima di Enter', async () => {
  const script = { };
  const { calls, exec } = fakeTmux(script);
  let displayCount = 0;
  const exec2 = async (bin, args) => {
    if (args[0] === 'display-message') {
      displayCount += 1;
      return { err: null, stdout: `cloud-T\t0\t%${displayCount === 1 ? 42 : 99}\n`, stderr: '', code: 0 };
    }
    return exec(bin, args);
  };
  const r = await deliverBootstrapPrompt({
    ...BASE, tmuxExecImpl: exec2, captureImpl: READY_CAPTURE(),
  });
  assert.equal(r.state, 'delivery-unknown');
  assert.equal(calls.filter((c) => c.startsWith('send-keys')).length + 1, 1, 'mai Enter su pane diverso');
});

test('delivery R5: resolveSessionPane rifiuta sessione diversa o output malformato', async () => {
  const { resolveSessionPane } = require('../lib/fleet/launch.js');
  const mk = (stdout, err = null) => async () => ({ err, stdout, stderr: '', code: err ? 1 : 0 });
  // sessione diversa: mai paste
  assert.equal(await resolveSessionPane('tmux', 'cloud-T', { exec: mk('altra-sessione\t0\t%42\n') }), null);
  // dead=1: pane morto
  assert.equal(await resolveSessionPane('tmux', 'cloud-T', { exec: mk('cloud-T\t1\t%42\n') }), null);
  // campi mancanti / formato legacy a 2 campi
  assert.equal(await resolveSessionPane('tmux', 'cloud-T', { exec: mk('0\t%42\n') }), null);
  // %N atteso diverso
  assert.equal(await resolveSessionPane('tmux', 'cloud-T', { exec: mk('cloud-T\t0\t%99\n'), target: '%42' }), null);
  // errore tmux
  assert.equal(await resolveSessionPane('tmux', 'cloud-T', { exec: mk('', new Error('x')) }), null);
  // happy path: sessione esatta + pane vivo
  assert.equal(await resolveSessionPane('tmux', 'cloud-T', { exec: mk('cloud-T\t0\t%42\n') }), '%42');
});

test('delivery R4: throw durante paste-buffer -> delivery-unknown, MAI retry (un solo paste)', async () => {
  const calls = [];
  const exec = async (bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'display-message') return { err: null, stdout: 'cloud-T\t0\t%42\n', stderr: '', code: 0 };
    if (args[0] === 'paste-buffer') throw new Error('executor exploded mid-paste');
    return { err: null, stdout: '', stderr: '', code: 0 };
  };
  const r = await deliverBootstrapPrompt({
    ...BASE, tmuxExecImpl: exec, captureImpl: READY_CAPTURE(),
  });
  assert.equal(r.state, 'delivery-unknown');
  assert.equal(r.attempts, 1, 'nessun retry dopo throw post-paste');
  assert.equal(calls.filter((c) => c.startsWith('paste-buffer')).length, 1);
  assert.equal(calls.filter((c) => c.startsWith('send-keys')).length, 0);
});

test('delivery R3: cancel durante il polling -> cancelled, zero paste/Enter', async () => {
  let cancelled = false;
  const { calls, exec } = fakeTmux();
  const r = await deliverBootstrapPrompt({
    ...BASE, readyWaitMs: 5000, pollMs: 100,
    tmuxExecImpl: exec,
    captureImpl: async () => { cancelled = true; return KIMI_LOGGED_OUT; },
    isCancelled: () => cancelled,
    client: 'kimi',
  });
  assert.equal(r.state, 'cancelled');
  assert.equal(calls.filter((c) => c.startsWith('paste-buffer')).length, 0);
  assert.equal(calls.filter((c) => c.startsWith('send-keys')).length, 0);
});

test('delivery R3: cancel dopo il paste -> delivery-unknown, MAI Enter, MAI secondo paste', async () => {
  let cancelled = false;
  const calls = [];
  const exec = async (bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'display-message') return { err: null, stdout: 'cloud-T\t0\t%42\n', stderr: '', code: 0 };
    if (args[0] === 'paste-buffer') { cancelled = true; return { err: null, stdout: '', stderr: '', code: 0 }; }
    return { err: null, stdout: '', stderr: '', code: 0 };
  };
  const r = await deliverBootstrapPrompt({
    ...BASE, tmuxExecImpl: exec, captureImpl: READY_CAPTURE(), isCancelled: () => cancelled,
  });
  assert.equal(r.state, 'delivery-unknown');
  assert.equal(calls.filter((c) => c.startsWith('paste-buffer')).length, 1);
  assert.equal(calls.filter((c) => c.startsWith('send-keys')).length, 0, 'mai Enter dopo cancel');
});

test('classifier R7: "Not logged in" nel corpo conversazione NON classifica auth', () => {
  const conversation = [
    'user: come mai vedo Not logged in nel log?',
    'assistant: il token nella status bar indica...',
    '',
    '❯ ',
    '  ⏸ manual mode on · ? for shortcuts · ← for agents                               ● high · /effort',
  ].join('\n');
  assert.equal(classifyPane(conversation, 'claude'), 'ready');
  // la forma di status bar esatta resta auth
  assert.equal(classifyPane(CLAUDE_NOT_LOGGED_IN, 'claude'), 'not-ready-auth');
  assert.equal(classifyPane('❯ \nNot logged in · Please run /login\n', 'claude'), 'not-ready-auth');
});

test('delivery: prompt con byte di controllo -> prompt-rejected, zero I/O', async () => {
  const { calls, exec } = fakeTmux();
  const r = await deliverBootstrapPrompt({
    ...BASE, prompt: 'bad\x1bprompt', tmuxExecImpl: exec, captureImpl: READY_CAPTURE(),
  });
  assert.equal(r.state, 'prompt-rejected');
  assert.equal(calls.length, 0);
});

// ===========================================================================
// 3. actionRequired: bounded, recovery da catalogo, MAI /login per kimi-code
// ===========================================================================
test('actionRequired: mapping bounded consent/auth per kimi-code e kimi.native (R10: solo code+slug)', () => {
  for (const c of ACTION_CODES) assert.match(c, /^[A-Z][A-Z0-9_]*$/);
  const consent = actionRequiredFor('claude', 'kimi-code', { delivered: false, state: 'skipped-not-ready', notReady: 'not-ready-consent' });
  assert.deepEqual(Object.keys(consent).sort(), ['code', 'recovery'], 'R10: API bounded, nessun testo server');
  assert.equal(consent.code, 'KIMI_AUTH_ACTION_REQUIRED');
  assert.equal(consent.recovery, 'kimi-code-consent-yes');
  assert.equal(consent.recoveryText, undefined);

  const auth = actionRequiredFor('claude', 'kimi-code', { delivered: false, state: 'skipped-not-ready', notReady: 'not-ready-auth' });
  assert.equal(auth.code, 'KIMI_AUTH_ACTION_REQUIRED');
  assert.equal(auth.recovery, 'kimi-code-config-custom-api-key');
  assert.equal(auth.recoveryText, undefined);

  const kimiAuth = actionRequiredFor('kimi', 'native', { delivered: false, state: 'skipped-not-ready', notReady: 'not-ready-auth' });
  assert.equal(kimiAuth.code, 'KIMI_AUTH_ACTION_REQUIRED');
  assert.equal(kimiAuth.recovery, 'kimi-cli-login', 'kimi.native: /login e\' il login Kimi CLI (device-code)');

  const unknown = actionRequiredFor('claude', 'kimi-code', { delivered: false, state: 'skipped-unknown', notReady: '' });
  assert.equal(unknown.code, 'CLIENT_INTERACTION_REQUIRED');
  assert.equal(unknown.recovery, 'client-terminal-dialog');

  assert.equal(actionRequiredFor('claude', 'kimi-code', { delivered: true, state: 'submitted' }), null);
  assert.equal(actionRequiredFor('claude', 'kimi-code', { delivered: false, state: 'delivery-unknown', notReady: '' }), null,
    'fallimenti di trasporto non producono actionRequired');
  // slug sempre nell'insieme chiuso
  for (const slug of RECOVERY_SLUGS) assert.match(slug, /^[a-z][a-z0-9-]*$/);
  for (const s of DELIVERY_STATES) assert.match(s, /^[a-z][a-z0-9-]*$/);
});

// ===========================================================================
// 4. Integrazione runtime up(): managed kimi.native + claude.kimi-code
//    (R2: il runtime NON paste-a mai — legge solo @nc_delivery dal supervisore)
// ===========================================================================
function writeFakeTmux(dir, cfg) {
  const p = path.join(dir, 'fake-tmux.cjs');
  const body = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = ${JSON.stringify(cfg)};
const stateDir = ${JSON.stringify(path.join(dir, '.sessions'))};
try { fs.mkdirSync(stateDir, { recursive: true }); } catch (_) {}
const log = (s) => fs.appendFileSync(${JSON.stringify(path.join(dir, 'tmux.log'))}, s + '\\n');
let argv = process.argv.slice(2);
let socketArg = '';
if (argv[0] === '-S') { socketArg = argv[1]; argv = argv.slice(2); }
if (argv[0] === '-C') {
  if (process.argv.includes('new-session')) {
    const { spawnSync: creaSync } = require('node:child_process');
    const rCrea = creaSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpoCrea = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : ''); if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
  process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  const { spawnSync } = require('node:child_process');
  let buf = '';
  let n = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!riga) continue;
      if (riga === 'display-message -p nc-control-open') continue; // apertura: gia' risolta dal frame iniziale
      n += 1;
      const r = spawnSync(process.execPath, [__filename, '-S', socketArg || 'sock'].concat(riga.split(/\\s+/)), { encoding: 'utf8' });
      if ((r.status || 0) === 0) process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stdout || '') + '%end 1 ' + n + ' 1\\n');
      else process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stderr || '') + '%error 1 ' + n + ' 1\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
const cmd = argv[0] || '';
const out = (s) => process.stdout.write(s);
const fmt = argv[argv.length - 1] || '';
const tgt = (() => { const i = argv.indexOf('-t'); return i >= 0 ? argv[i + 1] : ''; })();
const cleanTgt = tgt.replace(/^=/, '').replace(/:.*$/, '');
const sIdx = argv.indexOf('-s');
const sessName = sIdx >= 0 ? argv[sIdx + 1] : '';
const sess = (() => { const m = /^=([^:]+):?$/.exec(tgt); return m ? m[1] : (sessName || cleanTgt || 'work-kimi'); })();
const fileFor = (s) => path.join(stateDir, encodeURIComponent(s || 'work-kimi'));

switch (cmd) {
  case 'new-session':
    log('new-session');
    try { fs.writeFileSync(fileFor(sess), '1'); } catch (_) {}
    if (sessName) { try { fs.writeFileSync(fileFor(sessName), '1'); } catch (_) {} }
    if (argv.includes('-P')) {
      try { fs.writeFileSync(fileFor('$1'), '1'); } catch (_) {}
      out('$1\\t@1\\t%42\\n');
    }
    process.exit(0);
  case 'has-session':
    log('has-session ' + argv.join(' '));
    const targetToCheck = cleanTgt || sess;
    if (fs.existsSync(fileFor(targetToCheck))) {
      process.exit(0);
    }
    process.exit(1);
  case 'display-message':
    log('display-message ' + fmt);
    if (fmt.includes('@nc_delivery')) { out((cfg.delivery || '') + '\\n'); process.exit(0); }
    if (fmt.includes('session_name')) { out(sess + '\\t0\\t%42\\n'); process.exit(0); }
    out('0\\t\\t%42\\n');
    process.exit(0);
  case 'capture-pane':
    out(cfg.capture || '');
    process.exit(0);
  case 'load-buffer': case 'paste-buffer': case 'delete-buffer': case 'send-keys':
  case 'set-option': case 'set-hook': case 'respawn-pane':
    log(argv.join(' '));
    process.exit(0);
  case 'kill-session':
    log('kill-session');
    const targetToRemove = cleanTgt || sess;
    try { fs.unlinkSync(fileFor(targetToRemove)); } catch (_) {}
    try { fs.unlinkSync(fileFor(sess)); } catch (_) {}
    try { fs.unlinkSync(fileFor('$1')); } catch (_) {}
    process.exit(0);
  default:
    process.exit(0);
}
`;
  fs.writeFileSync(p, body, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

function makeManagedWorld({ client, provider, delivery, env = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncpd-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'Dev'); fs.mkdirSync(cwd);
  const binDir = path.join(home, '.local', 'bin'); fs.mkdirSync(binDir, { recursive: true });
  const binName = client === 'kimi' ? 'kimi' : 'claude';
  const bin = path.join(binDir, binName);
  fs.writeFileSync(bin, '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.160.0" ;; --help) echo "Usage: codex --no-daemon" ;; esac\n', { mode: 0o755 }); fs.chmodSync(bin, 0o755);
  const engineId = client === 'kimi' ? 'kimi.native' : 'claude.kimi-code';
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: engineId, label: 'K', rc: false,
      managed: client === 'kimi'
        ? { client, provider, model: '', permissionPolicy: 'standard' }
        : { client, provider, permissionPolicy: 'standard' },
    }],
    cells: [{
      id: 'Dev', tmuxSession: 'work-kimi', cwd, engine: engineId, boot: false,
      prompt: 'bootstrap segreto di sistema',
    }],
  });
  const tmuxBin = writeFakeTmux(root, { delivery });
  let ticket = null;
  const launchBroker = {
    issue: async (payload) => { ticket = payload; return { socketPath: '/x', nonce: 'n'.repeat(64) }; },
    close: async () => {},
  };
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 40, bootstrapReadyWaitMs: 30, sendKeysReadyMs: 10, env },
    home, defsPath, tmuxBin, readonly: () => false, launchBroker,
    boot: loadDefinitions(defsPath),
  });
  const log = () => (fs.existsSync(path.join(root, 'tmux.log'))
    ? fs.readFileSync(path.join(root, 'tmux.log'), 'utf8').split('\n') : []);
  return { runtime, root, home, ticket: () => ticket, log, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('up kimi.native report submitted: prompt consegnato dal supervisore; runtime MAI paste/Enter', async () => {
  const w = makeManagedWorld({ client: 'kimi', provider: 'native', delivery: 'submitted' });
  try {
    const res = await w.runtime.up('Dev');
    assert.equal(res.ok, true);
    assert.equal(res.prompt.delivered, true);
    assert.equal(res.prompt.state, 'submitted');
    assert.equal(res.actionRequired, undefined);
    const lines = w.log();
    assert.equal(lines.filter((l) => l.startsWith('paste-buffer')).length, 0, 'runtime non paste-a (owner = cell-exec)');
    assert.equal(lines.filter((l) => l.startsWith('send-keys')).length, 0, 'runtime non manda Enter');
    assert.equal(lines.filter((l) => l.startsWith('kill-session')).length, 0);
    assert.ok(lines.some((l) => l.includes('@nc_delivery')), 'lettura report bounded dal pane');
    const t = w.ticket();
    assert.ok(t, 'ticket broker emesso');
    assert.ok(!t.args.includes('bootstrap segreto di sistema'), 'prompt mai in argv del child');
    assert.equal(t.restartPrompt.client, 'kimi', 'restart classificato per kimi.native');
    assert.deepEqual(t.env.NEXUSCREW_MCP_SESSION, 'work-kimi');
  } finally { w.cleanup(); }
});

test('up kimi.native report logged-out: NOT_READY bounded, sessione VIVA, recovery login Kimi', async () => {
  const w = makeManagedWorld({ client: 'kimi', provider: 'native', delivery: 'skipped-not-ready:not-ready-auth' });
  try {
    const res = await w.runtime.up('Dev');
    assert.equal(res.ok, true, 'up non fallisce: la cella resta utilizzabile');
    assert.equal(res.prompt.delivered, false);
    assert.equal(res.prompt.state, 'skipped-not-ready');
    assert.equal(res.actionRequired.code, 'KIMI_AUTH_ACTION_REQUIRED');
    assert.equal(res.actionRequired.recovery, 'kimi-cli-login');
    const lines = w.log();
    assert.equal(lines.filter((l) => l.startsWith('paste-buffer')).length, 0);
    assert.equal(lines.filter((l) => l.startsWith('kill-session')).length, 0, 'sessione mai uccisa (G3)');
    const body = JSON.stringify(res);
    assert.ok(!body.includes('bootstrap segreto'), 'nessun prompt nella risposta');
  } finally { w.cleanup(); }
});

test('up claude.kimi-code report consenso pendente: recovery consenso (mai /login), TUI vivo', async () => {
  const w = makeManagedWorld({
    client: 'claude', provider: 'kimi-code', delivery: 'skipped-not-ready:not-ready-consent',
    env: { KIMI_API_KEY: 'sk-test-fixture-only' },
  });
  try {
    const res = await w.runtime.up('Dev');
    assert.equal(res.ok, true);
    assert.equal(res.prompt.delivered, false);
    assert.equal(res.prompt.state, 'skipped-not-ready');
    assert.equal(res.actionRequired.code, 'KIMI_AUTH_ACTION_REQUIRED');
    assert.equal(res.actionRequired.recovery, 'kimi-code-consent-yes');
    assert.deepEqual(Object.keys(res.actionRequired).sort(), ['code', 'recovery'], 'R10: solo slug bounded in API');
    const lines = w.log();
    assert.equal(lines.filter((l) => l.startsWith('paste-buffer')).length, 0);
    assert.equal(lines.filter((l) => l.startsWith('kill-session')).length, 0);
  } finally { w.cleanup(); }
});

test('up claude.kimi-code report Not logged in: recovery /config; env child names-only', async () => {
  const w = makeManagedWorld({
    client: 'claude', provider: 'kimi-code', delivery: 'skipped-not-ready:not-ready-auth',
    env: { KIMI_API_KEY: 'sk-test-fixture-only', SENTINEL_LEAK_FINTO: 'no' },
  });
  try {
    const res = await w.runtime.up('Dev');
    assert.equal(res.prompt.state, 'skipped-not-ready');
    assert.equal(res.actionRequired.code, 'KIMI_AUTH_ACTION_REQUIRED');
    assert.equal(res.actionRequired.recovery, 'kimi-code-config-custom-api-key');
    assert.deepEqual(Object.keys(res.actionRequired).sort(), ['code', 'recovery'], 'R10: solo slug bounded in API');
    const t = w.ticket();
    // Asse D names-only: i NOMI env del child sono l'allowlist minimal +
    // il set del provider kimi-code; la chiave serve al child Claude (auth),
    // nessuna chiave runtime spuria (SENTINEL_LEAK_FINTO) passa.
    const names = Object.keys(t.env).sort();
    for (const required of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CONFIG_DIR', 'NEXUSCREW_MCP_SESSION', 'PATH', 'HOME']) {
      assert.ok(names.includes(required), `env name richiesto presente: ${required}`);
    }
    assert.ok(!names.includes('SENTINEL_LEAK_FINTO'), 'env runtime non allowlisted mai ereditato');
    assert.ok(!names.includes('KIMI_API_KEY'), 'la variabile sorgente non passa: il child vede solo ANTHROPIC_*');
    const allowed = /^(PATH|HOME|SHELL|TERM|COLORTERM|LANG|LANGUAGE|LC_ALL|LC_CTYPE|USER|LOGNAME|TMUX|TMUX_TMPDIR|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|PREFIX|TMPDIR|TERMUX_VERSION|ANDROID_DATA|ANDROID_ROOT|ANTHROPIC_[A-Z_]+|CLAUDE_CODE_[A-Z_]+|CLAUDE_CONFIG_DIR|API_TIMEOUT_MS|MCP_DEVICE|NEXUSCREW_MCP_SESSION)$/;
    for (const n of names) assert.match(n, allowed, `env name inatteso nel child: ${n}`);
    assert.ok(!t.args.includes('bootstrap segreto di sistema'), 'prompt mai in argv');
    assert.equal(t.restartPrompt.client, 'claude', 'restart classificato per claude.kimi-code');
  } finally { w.cleanup(); }
});

test('up kimi.native senza report entro il bound: report-timeout onesto, sessione viva', async () => {
  const w = makeManagedWorld({ client: 'kimi', provider: 'native', delivery: '' });
  try {
    const res = await w.runtime.up('Dev');
    assert.equal(res.ok, true);
    assert.equal(res.prompt.delivered, false);
    assert.equal(res.prompt.state, 'report-timeout');
    assert.equal(res.prompt.reason, 'report-timeout');
    assert.equal(res.actionRequired, undefined, 'nessuna azione utente provata');
    assert.equal(w.log().filter((l) => l.startsWith('kill-session')).length, 0);
  } finally { w.cleanup(); }
});

test('waitDeliveryReport: valore non bounded -> null; parse state:notReady', async () => {
  const { waitDeliveryReport } = require('../lib/fleet/prompt-delivery.js');
  const mk = (out) => async () => ({ err: null, stdout: out, stderr: '', code: 0 });
  const ok = await waitDeliveryReport('tmux', '%1', { exec: mk('skipped-not-ready:not-ready-consent\n'), timeoutMs: 50 });
  assert.equal(ok.state, 'skipped-not-ready');
  assert.equal(ok.notReady, 'not-ready-consent');
  assert.equal(ok.delivered, false);
  const evil = await waitDeliveryReport('tmux', '%1', { exec: mk('DROP TABLE; rm -rf\n'), timeoutMs: 50 });
  assert.equal(evil, null, 'valore fuori enum mai accettato');
  let clock = 0;
  const timeout = await waitDeliveryReport('tmux', '%1', {
    exec: mk(''), timeoutMs: 100, pollMs: 40,
    nowImpl: () => clock, sleepImpl: async (ms) => { clock += ms; },
  });
  assert.equal(timeout, null);
});

// ===========================================================================
// 5. Restart supervisionato (R2/R3): cell-exec = UNICO owner per i kimi
//    (gen0 compresa), cancel+settled prima dello spawn successivo, marker
//    @nc_delivery; legacy per custom invariato; failure injection non uccide
//    il keepalive
// ===========================================================================
test('cell-exec kimi: delivery owner per OGNI generazione + marker @nc_delivery bounded', async () => {
  let clock = 0; let launches = 0; const deliveries = []; const marks = [];
  const proc = new EventEmitter();
  const payload = {
    command: '/bin/fake', args: [], env: {},
    supervise: {
      enabled: true, initialReadyMs: 50, restartDelayMs: 50,
      maxRestartDelayMs: 100, resetAfterMs: 1000, rapidWindowMs: 1000, maxRapidRestarts: 1,
    },
    restartPrompt: {
      tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'resume', readyMs: 0,
      client: 'kimi', readyWaitMs: 1000,
    },
  };
  const code = await cellExecMain(['--socket', '/tmp/x', '--nonce', 'b'.repeat(64)], {
    receivePayload: async () => payload,
    spawn: () => {
      launches += 1; clock += 100;
      const child = new EventEmitter(); child.kill = () => {};
      // exit reale differito: la delivery (microtask) completa PRIMA dell'exit
      setTimeout(() => { child.emit('exit', 1, null); }, 20);
      return child;
    },
    now: () => clock,
    monoNow: () => clock,
    sleep: async () => {},
    process: proc,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    tmuxExec: async (_bin, args) => { marks.push(args.join(' ')); return { err: null, stdout: '', stderr: '', code: 0 }; },
    deliverBootstrapPrompt: async (opts) => { deliveries.push(opts); return { delivered: true, state: 'submitted', notReady: '' }; },
    injectPrompt: async () => { throw new Error('legacy path non atteso per kimi'); },
    writeError: () => {},
  });
  assert.equal(code, 1, 'circuit aperto dopo maxRapidRestarts');
  assert.equal(launches, 2);
  assert.equal(deliveries.length, 2, 'gen0 E gen1: una delivery per generazione, owner unico');
  assert.equal(deliveries[0].client, 'kimi');
  assert.equal(typeof deliveries[0].isCancelled, 'function', 'isCancelled passato (R3)');
  assert.equal(deliveries[0].session, 'cloud-T');
  const setMarks = marks.filter((m) => m.startsWith('set-option -p') && m.includes('@nc_delivery submitted'));
  assert.equal(setMarks.length, 2, 'esito bounded marcato per generazione');
});

test('cell-exec R2: gen0 exit durante attesa -> delivery gen0 CANCELLATA, gen1 esattamente una', async () => {
  const deliveries = []; const marks = [];
  const proc = new EventEmitter();
  let cancelObserved = 0;
  const payload = {
    command: '/bin/fake', args: [], env: {},
    supervise: {
      enabled: true, initialReadyMs: 5, restartDelayMs: 5,
      maxRestartDelayMs: 20, resetAfterMs: 100000, rapidWindowMs: 100000, maxRapidRestarts: 10,
    },
    restartPrompt: {
      tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'resume', readyMs: 1,
      client: 'claude', readyWaitMs: 60000,
    },
  };
  let generation = -1;
  const code = await cellExecMain(['--socket', '/tmp/x', '--nonce', 'd'.repeat(64)], {
    receivePayload: async () => payload,
    process: proc,
    spawn: () => {
      generation += 1;
      const child = new EventEmitter();
      child.kill = () => { setTimeout(() => child.emit('exit', 0, null), 2); };
      const gen = generation;
      // gen0 muore mentre la sua delivery sta ancora attendendo (poll lungo);
      // gen1 completa la delivery e viene fermato via SIGTERM (kill -> exit).
      if (gen === 0) setTimeout(() => { child.emit('exit', 0, null); }, 30);
      if (gen === 1) setTimeout(() => { proc.emit('SIGTERM'); }, 100);
      return child;
    },
    tmuxExec: async (_bin, args) => { marks.push(args.join(' ')); return { err: null, stdout: '', stderr: '', code: 0 }; },
    deliverBootstrapPrompt: (opts) => {
      const my = deliveries.length;
      deliveries.push(opts);
      return new Promise((resolve) => {
        const tick = () => {
          if (opts.isCancelled()) {
            if (my === 0) cancelObserved += 1;
            resolve({ delivered: false, state: 'cancelled', notReady: '' });
            return;
          }
          if (my > 0) { resolve({ delivered: true, state: 'submitted', notReady: '' }); return; }
          setTimeout(tick, 5);   // gen0: polling lungo (TUI mai ready)
        };
        setTimeout(tick, 5);
      });
    },
    injectPrompt: async () => { throw new Error('legacy path non atteso'); },
    writeError: () => {},
  });
  assert.equal(code, 0, 'stop pulito via SIGTERM');
  assert.equal(generation, 1, 'due generazioni');
  assert.equal(deliveries.length, 2, 'una delivery avviata per generazione');
  assert.equal(cancelObserved, 1, 'delivery gen0 cancellata durante il polling (R3)');
  const submittedMarks = marks.filter((m) => m.includes('@nc_delivery submitted'));
  assert.equal(submittedMarks.length, 1, 'gen1: esattamente un esito submitted');
  assert.equal(marks.filter((m) => m.includes('@nc_delivery cancelled')).length, 0,
    'la generazione cancellata non marca mai il pane');
});

test('delivery R3: cancel dopo Enter in volo -> delivery-unknown (R9), mai submitted', async () => {
  let cancelled = false;
  const calls = [];
  const exec = async (bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'display-message') return { err: null, stdout: 'cloud-T\t0\t%42\n', stderr: '', code: 0 };
    if (args[0] === 'send-keys') { cancelled = true; return { err: null, stdout: '', stderr: '', code: 0 }; }
    return { err: null, stdout: '', stderr: '', code: 0 };
  };
  const r = await deliverBootstrapPrompt({
    ...BASE, tmuxExecImpl: exec, captureImpl: READY_CAPTURE(), isCancelled: () => cancelled,
  });
  assert.equal(r.state, 'delivery-unknown', 'Enter partito + generazione morta = incerto, non submitted');
  assert.equal(r.delivered, false);
  assert.equal(calls.filter((c) => c.startsWith('send-keys')).length, 1);
});

test('cell-exec R8/R11: cancel PRIMA dello scatto del timer -> settled risolve subito, mai hang', async () => {
  const ctl = startGenerationPrompt(
    { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 60000, client: 'kimi', readyWaitMs: 1000 },
    0, { exited: false },
    { deliverBootstrapPrompt: async () => { throw new Error('non deve partire'); }, tmuxExec: async () => ({ err: null, stdout: '', stderr: '', code: 0 }) },
  );
  ctl.cancel();   // timer ancora pendente: DEVE risolvere settled (R8)
  const winner = await Promise.race([
    ctl.settled.then((v) => ({ kind: 'settled', value: v })),
    new Promise((r) => setTimeout(() => r({ kind: 'timeout' }), 200)),
  ]);
  assert.equal(winner.kind, 'settled', 'nessun deadlock su cancel-before-timer');
  assert.equal(winner.value, null, 'nessun paste tentato: esito pulito');
});

test('cell-exec R8: child early-exit prima di readyMs -> main termina, nessun hang, nessuna delivery', async () => {
  let launches = 0; let deliverCalls = 0;
  const proc = new EventEmitter();
  const payload = {
    command: '/bin/fake', args: [], env: {},
    supervise: {
      enabled: true, initialReadyMs: 50, restartDelayMs: 50,
      maxRestartDelayMs: 100, resetAfterMs: 1000, rapidWindowMs: 1000, maxRapidRestarts: 8,
    },
    restartPrompt: {
      tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'resume', readyMs: 60000,
      client: 'kimi', readyWaitMs: 1000,
    },
  };
  const code = await Promise.race([
    cellExecMain(['--socket', '/tmp/x', '--nonce', 'e'.repeat(64)], {
      receivePayload: async () => payload,
      process: proc,
      spawn: () => {
        launches += 1;
        const child = new EventEmitter(); child.kill = () => {};
        // Early exit prima della ready gate: consegna l'exit al microtask
        // successivo, non a un timer. La soglia da battere e' runtimeMs <
        // initialReadyMs (50ms), misurata col cronometro dentro il supervisor
        // (cell-exec.js:401): un setTimeout(10) contro 50ms e' una corsa di
        // scheduling che un event loop saturo perdeva nel gate. Il microtask
        // parte DOPO la registrazione sincrona dei listener di waitChild e
        // PRIMA di qualunque timer: runtimeMs ~ 0 per costruzione, ogni load.
        queueMicrotask(() => child.emit('exit', 1, null));
        return child;
      },
      deliverBootstrapPrompt: async () => { deliverCalls += 1; return { delivered: false, state: 'cancelled', notReady: '' }; },
      tmuxExec: async () => ({ err: null, stdout: '', stderr: '', code: 0 }),
      injectPrompt: async () => {},
      writeError: () => {},
    }),
    new Promise((r) => setTimeout(() => r('HANG'), 3000)),
  ]);
  assert.notEqual(code, 'HANG', 'main non resta appeso (R8)');
  assert.equal(code, 1, 'gen0 early-exit -> errore bounded');
  assert.equal(launches, 1);
  assert.equal(deliverCalls, 0, 'timer mai scattato: nessuna delivery');
});

test('cell-exec R9: exit durante paste (delivery-unknown) -> STOP bounded, nessuna gen1, un solo paste', async () => {
  let launches = 0; const errs = [];
  const proc = new EventEmitter();
  const payload = {
    command: '/bin/fake', args: [], env: {},
    supervise: {
      enabled: true, initialReadyMs: 5, restartDelayMs: 5,
      maxRestartDelayMs: 20, resetAfterMs: 100000, rapidWindowMs: 100000, maxRapidRestarts: 10,
    },
    restartPrompt: {
      tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'resume', readyMs: 1,
      client: 'kimi', readyWaitMs: 60000,
    },
  };
  const code = await cellExecMain(['--socket', '/tmp/x', '--nonce', 'f'.repeat(64)], {
    receivePayload: async () => payload,
    process: proc,
    spawn: () => {
      launches += 1;
      const child = new EventEmitter(); child.kill = () => {};
      setTimeout(() => child.emit('exit', 1, null), 30);   // muore mentre il paste e' in volo
      return child;
    },
    tmuxExec: async () => ({ err: null, stdout: '', stderr: '', code: 0 }),
    deliverBootstrapPrompt: (opts) => new Promise((resolve) => {
      const tick = () => {
        if (opts.isCancelled()) { resolve({ delivered: false, state: 'delivery-unknown', notReady: '' }); return; }
        setTimeout(tick, 5);
      };
      setTimeout(tick, 5);
    }),
    injectPrompt: async () => { throw new Error('legacy non atteso'); },
    writeError: (m) => { errs.push(m); },
  });
  assert.equal(code, 1, 'supervisor fermo con errore bounded');
  assert.equal(launches, 1, 'NESSUN auto-restart dopo post-paste incerto (R9)');
  assert.ok(errs.some((m) => /uncertain prompt delivery/.test(m)), 'messaggio bounded operatore');
});

test('cell-exec R9: exit durante Enter (staged-not-submitted) -> STOP bounded, nessuna gen1', async () => {  let launches = 0; const errs = [];
  const proc = new EventEmitter();
  const payload = {
    command: '/bin/fake', args: [], env: {},
    supervise: {
      enabled: true, initialReadyMs: 5, restartDelayMs: 5,
      maxRestartDelayMs: 20, resetAfterMs: 100000, rapidWindowMs: 100000, maxRapidRestarts: 10,
    },
    restartPrompt: {
      tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'resume', readyMs: 1,
      client: 'claude', readyWaitMs: 60000,
    },
  };
  const code = await cellExecMain(['--socket', '/tmp/x', '--nonce', 'a'.repeat(64)], {
    receivePayload: async () => payload,
    process: proc,
    spawn: () => {
      launches += 1;
      const child = new EventEmitter(); child.kill = () => {};
      setTimeout(() => child.emit('exit', 0, null), 30);
      return child;
    },
    tmuxExec: async () => ({ err: null, stdout: '', stderr: '', code: 0 }),
    deliverBootstrapPrompt: (opts) => new Promise((resolve) => {
      const tick = () => {
        if (opts.isCancelled()) { resolve({ delivered: false, state: 'staged-not-submitted', notReady: '' }); return; }
        setTimeout(tick, 5);
      };
      setTimeout(tick, 5);
    }),
    injectPrompt: async () => { throw new Error('legacy non atteso'); },
    writeError: (m) => { errs.push(m); },
  });
  assert.equal(code, 1);
  assert.equal(launches, 1, 'nessuna gen1 dopo staged-not-submitted a generazione morta');
  assert.ok(errs.some((m) => /uncertain prompt delivery/.test(m)));
});

test('cell-exec R12: esito incerto chiuso PRIMA dell\'exit -> stop al primo exit, mai dimenticato (entrambi gli stati)', async () => {
  for (const uncertain of ['staged-not-submitted', 'delivery-unknown']) {
    let launches = 0; const errs = []; const marks = [];
    const proc = new EventEmitter();
    const payload = {
      command: '/bin/fake', args: [], env: {},
      supervise: {
        enabled: true, initialReadyMs: 5, restartDelayMs: 5,
        maxRestartDelayMs: 20, resetAfterMs: 100000, rapidWindowMs: 100000, maxRapidRestarts: 10,
      },
      restartPrompt: {
        tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'resume', readyMs: 1,
        client: 'kimi', readyWaitMs: 60000,
      },
    };
    // deliver si chiude SUBITO con esito incerto mentre il child resta vivo;
    // l'exit arriva 30ms dopo: il supervisor deve fermarsi SENZA gen1 (R12).
    const code = await cellExecMain(['--socket', '/tmp/x', '--nonce', 'a1b2c3d4'.repeat(8)], {
      receivePayload: async () => payload,
      process: proc,
      spawn: () => {
        launches += 1;
        const child = new EventEmitter(); child.kill = () => {};
        setTimeout(() => child.emit('exit', 1, null), 30);
        return child;
      },
      tmuxExec: async (_bin, args) => { marks.push(args.join(' ')); return { err: null, stdout: '', stderr: '', code: 0 }; },
      deliverBootstrapPrompt: async () => ({ delivered: false, state: uncertain, notReady: '' }),
      injectPrompt: async () => { throw new Error('legacy non atteso'); },
      writeError: (m) => { errs.push(m); },
    });
    assert.equal(code, 1, `${uncertain}: supervisor fermo`);
    assert.equal(launches, 1, `${uncertain}: nessuna gen1 dopo esito incerto pre-exit`);
    assert.ok(errs.some((m) => /uncertain prompt delivery/.test(m)), `${uncertain}: errore bounded`);
    assert.ok(marks.some((m) => m.includes(`@nc_delivery ${uncertain}`)),
      `${uncertain}: esito bounded marcato mentre il child era vivo`);
  }
});

test('cell-exec restart: senza client -> legacy injectPrompt (G4); failure delivery non uccide il keepalive', async () => {
  let clock = 0; let launches = 0; const legacy = [];
  const proc = new EventEmitter();
  const payload = {
    command: '/bin/fake', args: [], env: {},
    supervise: {
      enabled: true, initialReadyMs: 50, restartDelayMs: 50,
      maxRestartDelayMs: 100, resetAfterMs: 1000, rapidWindowMs: 1000, maxRapidRestarts: 1,
    },
    restartPrompt: { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'resume', readyMs: 0 },
  };
  const code = await cellExecMain(['--socket', '/tmp/x', '--nonce', 'c'.repeat(64)], {
    receivePayload: async () => payload,
    spawn: () => {
      launches += 1;
      const child = new EventEmitter(); child.kill = () => {};
      queueMicrotask(() => { clock += 100; child.emit('exit', 1, null); });
      return child;
    },
    now: () => clock,
    monoNow: () => clock,
    sleep: async () => {},
    process: proc,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    injectPrompt: async (_bin, session, prompt) => { legacy.push([session, prompt]); throw new Error('boom'); },
    deliverBootstrapPrompt: async () => { throw new Error('classified path non atteso senza client'); },
    writeError: () => {},
  });
  assert.equal(code, 1);
  assert.equal(launches, 2, 'restart avvenuto nonostante delivery failure');
  assert.deepEqual(legacy, [['cloud-T', 'resume']], 'legacy: solo gen>0, gen0 resta al runtime (G4)');
});

test('cell-exec validRestartPrompt: client/readyWaitMs bounded, chiavi estranee rifiutate', async () => {
  const { validRestartPrompt } = require('../lib/fleet/cell-exec.js');
  assert.equal(validRestartPrompt({
    tmuxBin: 'tmux', tmuxSession: 's', prompt: 'p', client: 'kimi', readyWaitMs: 15000,
  }), true);
  assert.equal(validRestartPrompt({
    tmuxBin: 'tmux', tmuxSession: 's', prompt: 'p', client: 'claude',
  }), true);
  assert.equal(validRestartPrompt({
    tmuxBin: 'tmux', tmuxSession: 's', prompt: 'p', client: 'codex',
  }), false, 'client fuori enum rifiutato');
  assert.equal(validRestartPrompt({
    tmuxBin: 'tmux', tmuxSession: 's', prompt: 'p', readyWaitMs: 999999,
  }), false, 'readyWaitMs oltre bound rifiutato');
  assert.equal(validRestartPrompt({
    tmuxBin: 'tmux', tmuxSession: 's', prompt: 'p', evil: 1,
  }), false, 'chiave estranea rifiutata');
});

// ===========================================================================
// 6. Regression (G5): argv degli altri managed INVARIATO (prompt su argv)
// ===========================================================================
test('regression: claude.native/codex/pi/agy conservano prompt su argv; solo kimi + kimi-code via delivery', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncpdreg-'));
  try {
    for (const name of ['claude', 'codex', 'pi', 'agy', 'kimi']) {
      const dir = path.join(home, '.local', 'bin'); fs.mkdirSync(dir, { recursive: true });
      const bin = path.join(dir, name);
      fs.writeFileSync(bin, '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.160.0" ;; --help) echo "Usage: codex --no-daemon" ;; esac\n', { mode: 0o755 }); fs.chmodSync(bin, 0o755);
    }
    const cell = { id: 'Dev', prompt: 'bootstrap' };
    const claude = resolveManagedEngine(
      { id: 'claude.native', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'standard' } },
      cell, { home, env: {} },
    );
    assert.equal(claude.engine.promptMode, 'send-keys');
    assert.equal(claude.engine.args.includes('bootstrap'), false, 'claude.native mai prompt su argv');
    const codex = resolveManagedEngine(
      { id: 'codex.native', managed: { client: 'codex', provider: 'native', model: '', permissionPolicy: 'standard' } },
      cell, { home, env: {} },
    );
    assert.equal(codex.engine.promptMode, 'managed-argv');
    assert.ok(codex.engine.args.includes('bootstrap'), 'codex: argv invariato');
    const pi = resolveManagedEngine(
      { id: 'pi.native', managed: { client: 'pi', provider: 'native', model: '', permissionPolicy: 'standard' } },
      cell, { home, env: {} },
    );
    assert.equal(pi.engine.promptMode, 'managed-argv');
    assert.ok(pi.engine.args.includes('bootstrap'), 'pi: argv invariato');
    const agy = resolveManagedEngine(
      { id: 'agy.native', managed: { client: 'agy', provider: 'native', model: '', permissionPolicy: 'standard' } },
      cell, { home, env: {} },
    );
    assert.equal(agy.engine.promptMode, 'managed-argv');
    assert.ok(agy.engine.args.includes('--prompt-interactive'), 'agy: flag nativo invariato');
    assert.ok(agy.engine.args.includes('bootstrap'), 'agy: valore prompt argv invariato');
    // kimi.native e claude.kimi-code: MAI prompt su argv
    const kimi = resolveManagedEngine(
      { id: 'kimi.native', managed: { client: 'kimi', provider: 'native', model: '', permissionPolicy: 'standard' } },
      cell, { home, env: {} },
    );
    assert.equal(kimi.engine.promptMode, 'send-keys');
    assert.ok(!kimi.engine.args.includes('bootstrap'));
    const kimiCode = resolveManagedEngine(
      { id: 'claude.kimi-code', managed: { client: 'claude', provider: 'kimi-code', model: 'k3[1m]', permissionPolicy: 'standard' } },
      cell, { home, env: { KIMI_API_KEY: 'sk-test-fixture-only' } },
    );
    assert.equal(kimiCode.engine.promptMode, 'send-keys');
    assert.ok(!kimiCode.engine.args.includes('bootstrap'), 'claude.kimi-code: prompt mai in argv');
    assert.ok(kimiCode.engine.args.includes('k3[1m]'), 'modello K3 1M preservato (regression)');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ===========================================================================
// 7. Restart cap (restart budget) + stop visibile persistente: tetto
//    cumulativo oltre gen0, misura della durata sul clock monotono catturata
//    all'exit, reset completo dopo run lunga, backoff raddoppiante, record
//    terminale per lancio su file (sopravvive al pane), selettore del lancio,
//    payload activity anche per gli engine a launcher, terminal in status.
//    Ogni test usa HOME/dir in tmpdir: nessuna scrittura fuori dalla own tmp.
// ===========================================================================
const activityFiles = require('../lib/files/activity.js');
const { validSupervise, validPayload } = require('../lib/fleet/cell-exec.js');

// Harness del supervisore: clock MONOTONO iniettato (la vita di ogni
// generazione e' lifeMs), sleep contati, spawn fake con exit a microtask
// (dopo aver fatto avanzare il clock), stderr catturato. `now` civile
// controllabile a parte per i timestamp dei record.
function supervisorHarness({
  supervise = {}, payload = {}, activity = null, lifeMs = 60,
  wall = null, manualExit = false, killExits = true, onSpawn = null,
} = {}) {
  const errs = []; const waits = [];
  let clock = 0; let launches = 0;
  const proc = new EventEmitter();
  const fullPayload = {
    command: '/bin/fake', args: [], env: {},
    ...payload,
    ...(activity ? { activity } : {}),
    supervise: {
      enabled: true, initialReadyMs: 50, restartDelayMs: 50,
      maxRestartDelayMs: 800, resetAfterMs: 1000, rapidWindowMs: 3600000,
      maxRapidRestarts: 1000,
      ...supervise,
    },
  };
  const seamsBase = {
    receivePayload: async () => fullPayload,
    spawn: () => {
      launches += 1;
      const child = new EventEmitter();
      child.kill = () => { if (killExits) child.emit('exit', 0, null); };
      if (onSpawn) onSpawn(launches, child, proc);
      if (!manualExit) queueMicrotask(() => { clock += lifeMs; child.emit('exit', 1, null); });
      return child;
    },
    now: () => (wall ? wall(launches) : 1700000000000 + clock),
    monoNow: () => clock,
    sleep: async (ms) => { waits.push(ms); },
    process: proc,
    // Il timer del prompt NON scatta nello stack che lo crea (nel runtime vero
    // e' un setTimeout): se fn() girasse subito, `timer = null` avverrebbe
    // prima che `timer = setTimer(...)` riceva l'handle, e il cancel() vedrebbe
    // un timer pendente che non esiste piu' — settle(null) spezzerebbe la
    // propagazione dell'esito incerto della delivery.
    setTimeout: (fn) => { queueMicrotask(fn); return 1; },
    clearTimeout: () => {},
    writeError: (m) => errs.push(String(m)),
    tmuxExec: async () => ({ err: null, stdout: '', stderr: '', code: 0 }),
  };
  return {
    proc,
    errs, waits,
    launches: () => launches,
    payload: fullPayload,
    seams: seamsBase,
    clock: () => clock,
    run: (extra = {}) => cellExecMain(['--socket', '/tmp/x', '--nonce', '1'.repeat(64)], { ...seamsBase, ...extra }),
  };
}

test('budget: bounds di maxTotalRestarts validati (1..200 intero), payload invalido rifiutato', () => {
  assert.equal(validSupervise({ maxTotalRestarts: 1 }), true);
  assert.equal(validSupervise({ maxTotalRestarts: 12 }), true);
  assert.equal(validSupervise({ maxTotalRestarts: 200 }), true);
  assert.equal(validSupervise({ maxTotalRestarts: 0 }), false, 'sotto bound');
  assert.equal(validSupervise({ maxTotalRestarts: 201 }), false, 'sopra bound');
  assert.equal(validSupervise({ maxTotalRestarts: 1.5 }), false, 'frazione');
  assert.equal(validSupervise({ maxTotalRestarts: '12' }), false, 'stringa');
  assert.equal(validSupervise({ maxTotalRestarts: true }), false, 'booleano');
  assert.equal(validPayload({
    command: '/bin/x', args: [], env: {},
    supervise: { enabled: true, maxTotalRestarts: 201 },
  }), false, 'payload con tetto fuori bounds rifiutato');
  const { DEFAULT_SUPERVISE } = require('../lib/fleet/cell-exec.js');
  assert.equal(DEFAULT_SUPERVISE.maxTotalRestarts, 12, 'default 12: gen0 + 12 spawn');
});

test('budget: cap=2 -> esattamente 3 spawn (gen0+2), il 4o vietato, stop SENZA sleep inutile', async () => {
  const w = supervisorHarness({ supervise: { maxTotalRestarts: 2 } });
  const code = await w.run();
  assert.equal(w.launches(), 3, 'gen0 piu\' due restart impegnati, il terzo vietato');
  assert.equal(code, 1, 'fermata terminale');
  // Il check del tetto e' ALLA DECISIONE di restart, prima di dormire: gli
  // sleep sono esattamente tanti quanti i restart davvero impegnati (2), col
  // backoff gia' raddoppiato fra il primo e il secondo.
  assert.deepEqual(w.waits, [50, 100], 'nessun backoff dormito dopo il tetto raggiunto');
  assert.ok(w.errs.some((e) => e.includes('total restart budget exhausted')), 'motivo bounded su stderr');
});

test('budget: cap=1 e cap=12 (gen0+N esatti)', async () => {
  const w1 = supervisorHarness({ supervise: { maxTotalRestarts: 1 } });
  await w1.run();
  assert.equal(w1.launches(), 2, 'cap 1: gen0 + 1 spawn');
  const w12 = supervisorHarness({ supervise: { maxTotalRestarts: 12 } });
  await w12.run();
  assert.equal(w12.launches(), 13, 'cap 12: gen0 + 12 spawn (13 in tutto)');
  assert.equal(w12.waits.length, 12, 'un backoff per ogni restart impegnato');
});

test('budget: impegno solo allo spawn certo — stop durante il backoff NON consuma', async () => {
  const w = supervisorHarness({ supervise: { maxTotalRestarts: 5 } });
  // Il primo sleep emette lo stop dell'operatore: nessun secondo spawn.
  w.seams.sleep = async () => { w.waits.push(50); w.proc.emit('SIGTERM'); };
  const code = await w.run();
  assert.equal(code, 0);
  assert.equal(w.launches(), 1, 'nessun client rilanciato dopo il segnale');
});

test('budget: run >= resetAfterMs azzera ANCHE il contatore cumulativo (burst nuovo)', async () => {
  // cap=1 con generazioni LUNGHE (2000ms >= resetAfterMs): il reset azzerando
  // totalRestarts permette il terzo spawn. Senza l'azzeramento del budget il
  // supervisore si fermerebbe a 2. Lo stop dell'operatore arriva DENTRO lo
  // spawn della terza generazione (sincrono: il loop gira a microtask puri e
  // un timer reale non girerebbe mai).
  const stopAt = (n, _child, proc) => { if (n === 3) proc.emit('SIGTERM'); };
  const w = supervisorHarness({ lifeMs: 2000, supervise: { maxTotalRestarts: 1 }, onSpawn: stopAt });
  const code = await w.run();
  assert.equal(w.launches(), 3, 'il reset della run lunga restituisce il budget del burst');
  assert.equal(code, 0, 'chiusura pulita via operatore');
});

test('budget: confine del reset — durata APPENA sotto non azzera, APPENA sopra si\'', async () => {
  // resetAfterMs di harness: 1000. lifeMs 999: la generazione non e' «lunga»,
  // il budget non si azzera, cap=1 fermo a gen0+1. lifeMs 1000: il reset si
  // applica e il burst ricomincia (si ferma l'operatore al terzo spawn).
  const sotto = supervisorHarness({ lifeMs: 999, supervise: { maxTotalRestarts: 1 } });
  await sotto.run();
  assert.equal(sotto.launches(), 2, '999ms < 1000ms: nessun reset, tetto a gen0+1');
  const stopAt = (n, _child, proc) => { if (n === 3) proc.emit('SIGTERM'); };
  const sopra = supervisorHarness({ lifeMs: 1000, supervise: { maxTotalRestarts: 1 }, onSpawn: stopAt });
  const code = await sopra.run();
  assert.equal(sopra.launches(), 3, '1000ms >= 1000ms: reset, il budget del burst torna');
  assert.equal(code, 0);
});

test('misura: durata catturata all\'exit — attesa di cancellazione LUNGA dopo l\'exit non resetta', async () => {
  // gen0 vita breve (60ms), ma la delivery si conclude molto DOPO l'exit e
  // nel frattempo fa avanzare il clock di 5000ms: la vecchia misura (letta a
  // valle delle attese) vedeva una generazione «lunga» e azzerava la finestra
  // rapid. Con l'istante catturato nel listener la generazione resta breve e
  // il circuito rapid si apre al secondo exit.
  let deliverClockJump = 5000;
  const w = supervisorHarness({
    supervise: { maxRapidRestarts: 1, maxTotalRestarts: 100 },
    payload: {
      restartPrompt: {
        tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'resume', readyMs: 0,
        client: 'kimi', readyWaitMs: 1000,
      },
    },
  });
  // safety: se il difetto tornasse (reset continuo), fermiamo l'infinito.
  let safety = 0;
  w.seams.sleep = async (ms) => {
    w.waits.push(ms); safety += 1;
    if (safety >= 6) w.proc.emit('SIGTERM');
  };
  const realClock = w.seams.monoNow;
  w.seams.deliverBootstrapPrompt = () => new Promise((resolve) => {
    setTimeout(() => {
      const base = realClock();
      w.seams.monoNow = () => base + deliverClockJump; // il clock scorre durante l'attesa...
      deliverClockJump = 0;
      resolve({ delivered: true, state: 'submitted', notReady: '' });
    }, 10);
  });
  const code = await w.run();
  assert.equal(w.launches(), 2, 'il circuito rapid apre al secondo exit breve');
  assert.equal(code, 1);
});

test('backoff: raddoppia davvero fino al tetto (50,100,200,400,800,800,800)', async () => {
  const w = supervisorHarness({
    supervise: { maxTotalRestarts: 7, restartDelayMs: 50, maxRestartDelayMs: 800 },
  });
  await w.run();
  assert.deepEqual(w.waits, [50, 100, 200, 400, 800, 800, 800], 'sequenza di backoff raddoppiante con cap');
  assert.equal(w.launches(), 8, 'gen0 + 7 restart');
});

test('stop visibile: cap raggiunto DOPO la readiness -> ragione su file, leggibile senza pane, per custom', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-term-'));
  const sessione = 'cloud-T';
  const dir = path.join(root, sessione);
  try {
    const launchId = 'a1b2c3d4e5f60718';
    // Il selettore del lancio lo pubblica il PROPRIETARIO del ciclo di vita
    // (il runtime, prima dello spawn): qui lo si simula nello stesso punto.
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, launchId), true);
    const w = supervisorHarness({
      supervise: { maxTotalRestarts: 1 },
      activity: { dir, generation: launchId },
    });
    const code = await w.run();
    assert.equal(code, 1, 'fermata terminale a budget esaurito');
    assert.equal(w.launches(), 2);
    // Il pane non esiste piu' (nessun tmux qui): la ragione vive sul FILE.
    const diagnosi = activityFiles.leggiDiagnosiTerminale(root, sessione);
    assert.equal(diagnosi.reason, 'restart-budget-exhausted');
    assert.equal(diagnosi.launchId, launchId);
    assert.ok(Number.isFinite(diagnosi.ts), 'timestamp civile finito');
    // Contenuto del record: schema chiuso, niente testo libero.
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `terminal-${launchId}.json`), 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), ['event', 'launchId', 'reason', 'ts', 'version']);
    assert.equal(raw.event, 'terminal-stop');
    assert.equal(raw.version, 1);
    // Selettore del lancio: pubblicato dal proprietario, NON toccato dal
    // supervisore (che pure ha vissuto l'intero ciclo fino allo stop).
    assert.equal(fs.readFileSync(path.join(dir, 'launch-current'), 'utf8').trim(), launchId);
    // Nessun boot automatico: il supervisore e' uscito, nessuno spawn oltre il tetto.
    assert.equal(w.launches(), 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stop visibile: il supervisore NON puo\' spostare il selettore (e\' del ciclo di vita, non suo)', async () => {
  // Prova del vincolo sul selettore: un supervisore ritardato di un lancio
  // vecchio, fermo prima della pubblicazione, non deve poter spostare la
  // selezione di un lancio nuovo. Nel codice nuovo la pubblicazione sta al
  // runtime (dentro il lock per cella): il supervisore NON scrive MAI
  // `launch-current`, quindi un ritardo qualsiasi al piu' fa arrivare tardi
  // il SUO record terminale — la selezione resta quella del lancio corrente.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-selown-'));
  const sessione = 'cloud-T';
  const dir = path.join(root, sessione);
  try {
    const vecchio = 'aaaa000000000001';
    const nuovo = 'bbbb000000000002';
    // Il runtime del lancio NUOVO ha gia' spostato il selettore...
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, nuovo), true);
    // ...e il supervisore VECCHIO (ritardato, fermo prima della vecchia
    // pubblicazione) vive ora tutto il suo ciclo e pubblica solo il proprio
    // record terminale.
    const w = supervisorHarness({
      supervise: { maxTotalRestarts: 1 },
      activity: { dir, generation: vecchio },
    });
    const code = await w.run();
    assert.equal(code, 1);
    // La selezione NON si e' mossa: resta il lancio nuovo, e la diagnosi
    // restituita e' quella del lancio nuovo (assente), MAI quella del vecchio.
    assert.equal(fs.readFileSync(path.join(dir, 'launch-current'), 'utf8').trim(), nuovo,
      'il supervisore non scrive launch-current');
    assert.equal(activityFiles.leggiDiagnosiTerminale(root, sessione), null,
      'il record del vecchio non viene selezionato');
    // Il record del vecchio esiste (diagnosi conservata per chi la cerca per
    // lancio) ma non e' la diagnosi DEL LANCIO CORRENTE.
    assert.ok(fs.existsSync(path.join(dir, `terminal-${vecchio}.json`)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stop visibile: orologi separati — salto dell\'orologio civile non tocca budget ne\' timestamp', async () => {
  // now (civile) salta avanti e indietro a ogni generazione: le DURATE e il
  // budget sono sul monotono e non cambiano; il record porta un ts civile
  // finito (interpretabile dal lettore Date.now).
  let i = 0;
  const salti = [1700000000000, 900000000000, 4200000000000, 1700000000001];
  const w = supervisorHarness({
    supervise: { maxTotalRestarts: 1 },
    wall: () => salti[i++ % salti.length],
  });
  const code = await w.run();
  assert.equal(w.launches(), 2, 'budget identico nonostante i salti civili');
  assert.equal(code, 1);
});

test('stop visibile: errore di pubblicazione onesto — dir non scrivibile, ciclo fermo comunque', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-ro-'));
  const dir = path.join(root, 'cloud-T');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o500); // scrittura negata al owner: le publish falliscono
  try {
    const w = supervisorHarness({
      supervise: { maxTotalRestarts: 1 },
      activity: { dir, generation: 'dead0000beef0001' },
    });
    const code = await w.run();
    assert.equal(code, 1, 'il ciclo si ferma comunque al tetto');
    assert.equal(w.launches(), 2);
    assert.ok(w.errs.some((e) => e.includes('terminal reason not published')),
      'diagnosi dichiarata non disponibile, mai uno stop «registrato» non scritto');
    assert.equal(activityFiles.leggiDiagnosiTerminale(root, 'cloud-T'), null, 'nessuna diagnosi inventata');
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stop visibile: ragioni terminali del supervisore sul canale (operator/spawn/uncertain)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-rag-'));
  // Il selettore del lancio lo pubblica il runtime (proprietario del ciclo di
  // vita) PRIMA dello spawn: in ogni sotto-caso lo si simula li'.
  const mk = (name) => {
    const dir = path.join(root, name);
    const launchId = name.padEnd(16, '0').slice(0, 16);
    return { dir, launchId };
  };
  try {
    // operator-stop: segnale durante il backoff.
    {
      const { dir, launchId } = mk('opstop00000000000'.slice(0, 16));
      assert.equal(activityFiles.pubblicaSelettoreLancio(dir, launchId), true);
      const w = supervisorHarness({ activity: { dir, generation: launchId } });
      w.seams.sleep = async (ms) => { w.waits.push(ms); w.proc.emit('SIGTERM'); };
      const code = await w.run();
      assert.equal(code, 0);
      assert.equal(w.launches(), 1);
      assert.equal(activityFiles.leggiDiagnosiTerminale(root, path.basename(dir)).reason, 'operator-stop');
    }
    // spawn-error: il figlio non nasce (error di spawn).
    {
      const nome = 'spawnerr';
      const dir = path.join(root, nome);
      assert.equal(activityFiles.pubblicaSelettoreLancio(dir, 'aa0000000000000b'), true);
      const w = supervisorHarness({ activity: { dir, generation: 'aa0000000000000b' } });
      w.seams.spawn = () => {
        const child = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => child.emit('error', Object.assign(new Error('enoent'), { code: 'ENOENT' })));
        return child;
      };
      const code = await w.run();
      assert.equal(code, 1);
      assert.ok(w.errs.some((e) => e.includes('spawn failed')), 'sanitize spawn error');
      assert.equal(activityFiles.leggiDiagnosiTerminale(root, nome).reason, 'spawn-error');
    }
    // uncertain-delivery: esito post-paste incerto -> fermata bounded + record.
    {
      const nome = 'uncertain';
      const dir = path.join(root, nome);
      assert.equal(activityFiles.pubblicaSelettoreLancio(dir, 'cc0000000000000d'), true);
      const w = supervisorHarness({
        activity: { dir, generation: 'cc0000000000000d' },
        payload: {
          restartPrompt: {
            tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'resume', readyMs: 0,
            client: 'kimi', readyWaitMs: 1000,
          },
        },
      });
      w.seams.deliverBootstrapPrompt = async () => ({ delivered: false, state: 'delivery-unknown', notReady: '' });
      const code = await w.run();
      assert.equal(code, 1);
      assert.equal(w.launches(), 1, 'nessuna gen1 dopo esito incerto');
      assert.equal(activityFiles.leggiDiagnosiTerminale(root, nome).reason, 'uncertain-delivery');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stop visibile: lease persa -> ragione lease-lost pubblicata (idempotente sull\'uscita)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-lease-'));
  const dir = path.join(root, 'cloud-T');
  const L = require('../lib/fleet/cell-lease.js');
  const clock = { t: 100_000 };
  const timers = [];
  const fakeSetTimeout = (fn) => { const h = { fn }; timers.push(h); return h; };
  const fakeClearTimeout = () => {};
  try {
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, 'ee0000000000000f'), true);
    const w = supervisorHarness({
      activity: { dir, generation: 'ee0000000000000f' },
      manualExit: true, // il child vive finche' onLost non lo ferma
      payload: { lease: { cellId: 'Dev', launchEpoch: 'e'.repeat(16), stablePath: '/tmp/nonexistent-lease.sock' } },
    });
    const fakeSocket = new (require('node:events').EventEmitter)();
    fakeSocket.destroyed = false;
    fakeSocket.destroy = () => { fakeSocket.destroyed = true; fakeSocket.emit('close'); };
    w.seams.receivePayload = async () => ({ payload: w.payload, socket: fakeSocket });
    w.seams.now = () => clock.t;                  // orologio civile = clock della grace
    w.seams.monoNow = () => clock.t;              // durate sullo stesso clock controllato
    w.seams.setTimeout = fakeSetTimeout;
    w.seams.clearTimeout = fakeClearTimeout;
    w.seams.net = {
      createConnection: () => {
        const s = new (require('node:events').EventEmitter)();
        s.destroyed = false;
        s.destroy = () => { s.destroyed = true; s.emit('close'); };
        s.setEncoding = () => {}; s.write = () => true;
        return s;
      },
    };
    const running = w.run();
    // Lascia partire il supervisore (spawn + lease client), poi perde il canale.
    await new Promise((resolve) => setImmediate(resolve));
    fakeSocket.emit('close');
    clock.t += L.GRACE_MS + 1;
    for (let guard = 0; guard < 40; guard += 1) {
      const pending = timers.splice(0, timers.length);
      for (const h of pending) { try { h.fn(); } catch (_) {} }
      await new Promise((resolve) => setImmediate(resolve));
    }
    const code = await running;
    assert.equal(code, 0, 'uscita pulita dopo la fermata del child');
    // La ragione e' la CAUSA (lease-lost), non il operator-stop dell'uscita.
    assert.equal(activityFiles.leggiDiagnosiTerminale(root, 'cloud-T').reason, 'lease-lost');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('canale terminale: enum chiuso, round-trip per ogni ragione, id lancio ostile rifiutato', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-enum-'));
  const dir = path.join(root, 's');
  fs.mkdirSync(dir, { recursive: true });
  try {
    assert.deepEqual([...activityFiles.RAGIONI_TERMINALI],
      ['restart-budget-exhausted', 'uncertain-delivery', 'lease-lost', 'spawn-error', 'operator-stop'],
      'enum chiuso, nessuna aggiunta libera');
    for (const reason of activityFiles.RAGIONI_TERMINALI) {
      const id = reason.slice(0, 16).padEnd(16, 'x');
      assert.equal(activityFiles.scriviRecordTerminale(dir, { launchId: id, reason, ora: 123 }), true, reason);
      assert.equal(activityFiles.pubblicaSelettoreLancio(dir, id), true);
      const d = activityFiles.leggiDiagnosiTerminale(root, 's');
      assert.equal(d.reason, reason); assert.equal(d.ts, 123); assert.equal(d.launchId, id);
    }
    // id ostile: mai un nome file fuori dalla directory, mai una ragione fuori enum.
    assert.equal(activityFiles.scriviRecordTerminale(dir, { launchId: '../escape', reason: 'operator-stop' }), false);
    assert.equal(activityFiles.scriviRecordTerminale(dir, { launchId: 'ok0000000000000f', reason: 'free-text' }), false);
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, '../../etc'), false);
    assert.equal(fs.readdirSync(dir).some((n) => n.includes('escape') || n.startsWith('..')), false);
    // Sessione ostile in lettura: traversal negato.
    assert.equal(activityFiles.leggiDiagnosiTerminale(root, '../altro'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('canale terminale: il selettore separa i lanci — il vecchio supervisore non sporca il nuovo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-sel-'));
  const dir = path.join(root, 's');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const A = 'aaaa000000000001'; const B = 'bbbb000000000002'; const C = 'cccc000000000003';
    // Lancio A pubblica la propria ragione ed e' selezionato.
    assert.equal(activityFiles.scriviRecordTerminale(dir, { launchId: A, reason: 'lease-lost', ora: 1 }), true);
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, A), true);
    assert.equal(activityFiles.leggiDiagnosiTerminale(root, 's').reason, 'lease-lost');
    // Lancio B nuovo: il selettore si sposta; la ragione di B non c'e' ancora.
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, B), true);
    assert.equal(activityFiles.leggiDiagnosiTerminale(root, 's'), null,
      'la ragione del lancio vecchio non vale per il nuovo');
    // Il VECCHIO supervisore A scrive tardi: riscrive solo il proprio record.
    assert.equal(activityFiles.scriviRecordTerminale(dir, { launchId: A, reason: 'spawn-error', ora: 2 }), true);
    assert.equal(activityFiles.leggiDiagnosiTerminale(root, 's'), null, 'scrittura tardiva di A non seleziona A');
    // B pubblica la propria ragione; un hook tardo (ClientExit) tocca solo
    // activity.json e non puo' cancellarla.
    assert.equal(activityFiles.scriviRecordTerminale(dir, { launchId: B, reason: 'operator-stop', ora: 3 }), true);
    assert.equal(activityFiles.scriviStato(dir, { evento: 'ClientExit', generazione: B, ora: 4 }), true);
    assert.equal(activityFiles.leggiDiagnosiTerminale(root, 's').reason, 'operator-stop',
      'la diagnosi sopravvive a un hook tardivo');
    // Lancio C: selezione C; scrittura tardiva di B non invalida C.
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, C), true);
    assert.equal(activityFiles.scriviRecordTerminale(dir, { launchId: B, reason: 'spawn-error', ora: 5 }), true);
    assert.equal(activityFiles.leggiDiagnosiTerminale(root, 's'), null, 'B tardivo non sposta la selezione di C');
    // Selettore rotto: onesto null, mai la ragione vecchia come nuova.
    fs.writeFileSync(path.join(dir, 'launch-current'), 'not!!a@valid id\n');
    assert.equal(activityFiles.leggiDiagnosiTerminale(root, 's'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('canale terminale: retention bounded — al lancio restano gli ultimi 8 record', () => {
  // La potatura sta al proprietario del ciclo di vita (il runtime, allo stesso
  // punto della pubblicazione del selettore): qui si prova direttamente
  // l'helper, con la stessa sequenza che usa il runtime.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-ret-'));
  const dir = path.join(root, 's');
  fs.mkdirSync(dir, { recursive: true });
  const idDi = (i) => `r${String(i).padStart(15, '0')}`;
  try {
    const base = Date.now() - 100000;
    for (let i = 0; i < 10; i += 1) {
      assert.equal(activityFiles.scriviRecordTerminale(dir, {
        launchId: idDi(i), reason: 'operator-stop', ora: base + i,
      }), true);
      fs.utimesSync(path.join(dir, `terminal-${idDi(i)}.json`), new Date(base + i), new Date(base + i));
    }
    const rimossi = activityFiles.potaTerminali(dir);
    assert.deepEqual(rimossi.sort(), [`terminal-${idDi(0)}.json`, `terminal-${idDi(1)}.json`],
      'pruna i due piu\' vecchi');
    const restanti = fs.readdirSync(dir).filter((n) => n.startsWith('terminal-')).sort();
    assert.equal(restanti.length, 8, 'retention bounded');
    assert.ok(!restanti.includes(`terminal-${idDi(0)}.json`), 'il piu\' vecchio e\' pruno');
    assert.ok(!restanti.includes(`terminal-${idDi(1)}.json`), 'il secondo piu\' vecchio e\' pruno');
    assert.ok(restanti.includes(`terminal-${idDi(2)}.json`), 'dal terzo in poi restano');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Runtime: plumb del tetto nel payload, canale activity per i custom,
// --- terminal esposto da cellStatus (la UI non mostra «attivo sano» dove
// --- c'e' una ragione terminale del lancio corrente).
function makeCustomWorld({ cfgExtra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-cw-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, 'work'); fs.mkdirSync(cwd);
  const filesRoot = path.join(root, 'files');
  const defsPath = path.join(root, 'fleet.json');
  // Il command deve passare il gate di trust: file regolare, eseguibile
  // dall'owner, non symlink, non world-writable. Nel mondo del test.
  const fakeCli = path.join(root, 'fake-cli');
  fs.writeFileSync(fakeCli, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeCli, 0o755);
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'fake.cli', label: 'F', rc: false, command: fakeCli, args: [], promptMode: 'send-keys' }],
    cells: [{ id: 'Dev', tmuxSession: 'work-custom', cwd, engine: 'fake.cli', boot: false }],
  });
  const tmuxBin = writeFakeTmux(root, {});
  let ticket = null;
  const logs = [];
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 40, filesRoot, log: (m) => logs.push(String(m)), ...cfgExtra },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async (payload) => { ticket = payload; return { socketPath: '/x', nonce: 'n'.repeat(64) }; },
      close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  return {
    runtime, root, filesRoot, logs,
    ticket: () => ticket,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('runtime custom (launcher): payload activity per il supervisore + tetto nel supervise', async () => {
  const w = makeCustomWorld();
  try {
    const res = await w.runtime.up('Dev');
    assert.equal(res.ok, true);
    const t = w.ticket();
    // Il canale esce dal solo ramo managed: anche gli engine a launcher
    // portano la directory attivita' del supervisore e la generazione.
    assert.ok(t.activity, 'payload activity per engine custom');
    assert.equal(t.activity.dir, path.join(w.filesRoot, 'work-custom'));
    assert.match(t.activity.generation, /^[0-9a-f]{16}$/, 'identita\' del lancio');
    // Tetto cumulativo: default 12, clamped 1..200.
    assert.equal(t.supervise.maxTotalRestarts, 12, 'default del tetto cumulativo');
  } finally { w.cleanup(); }
});

test('runtime: cellMaxTotalRestarts plumbed e clamped (override 7, fuori bounds -> 200)', async () => {
  const w7 = makeCustomWorld({ cfgExtra: { cellMaxTotalRestarts: 7 } });
  try {
    await w7.runtime.up('Dev');
    assert.equal(w7.ticket().supervise.maxTotalRestarts, 7, 'override da cfg');
  } finally { w7.cleanup(); }
  const wBig = makeCustomWorld({ cfgExtra: { cellMaxTotalRestarts: 9999 } });
  try {
    await wBig.runtime.up('Dev');
    assert.equal(wBig.ticket().supervise.maxTotalRestarts, 200, 'clamp al bound massimo');
  } finally { wBig.cleanup(); }
});

test('runtime: opt-out activityHooks == false vale anche per i custom (nessun canale)', async () => {
  const w = makeCustomWorld({ cfgExtra: { activityHooks: false } });
  try {
    await w.runtime.up('Dev');
    assert.equal(w.ticket().activity, undefined, 'opt-out dell\'operatore rispettato');
  } finally { w.cleanup(); }
});

test('runtime: il selettore del lancio lo pubblica il PROPRIETARIO del ciclo di vita', async () => {
  // Dentro up() (lock per cella), PRIMA dello spawn: un supervisore ritardato
  // non ha in mano la selezione di un lancio nuovo. Il selettore segue il
  // lancio corrente a ogni up.
  const w = makeCustomWorld();
  try {
    await w.runtime.up('Dev');
    const dir = path.join(w.filesRoot, 'work-custom');
    const gen1 = w.ticket().activity.generation;
    assert.equal(activityFiles.leggiSelettoreLancio(dir), gen1,
      'il runtime pubblica launch-current alla partenza');
    const problemi = w.logs.filter((riga) => !/launch target registered|control channel held/.test(riga));
    assert.equal(problemi.length, 0, `nessun problema di pubblicazione dichiarato: ${problemi.join(' | ')}`);
    // Un secondo lancio sposta la selezione: la diagnosi del vecchio lancio
    // non vale piu' per la cella.
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: gen1, reason: 'lease-lost', ora: 1,
    }), true);
    await w.runtime.down('Dev');
    await w.runtime.up('Dev');
    const gen2 = w.ticket().activity.generation;
    assert.notEqual(gen2, gen1);
    assert.equal(activityFiles.leggiSelettoreLancio(dir), gen2, 'la selezione segue il lancio nuovo');
    assert.equal(activityFiles.leggiDiagnosiTerminale(w.filesRoot, 'work-custom'), null,
      'la ragione del lancio vecchio non si presenta come attuale');
  } finally { w.cleanup(); }
});

test('runtime: selettore non pubblicabile -> lancio NON bloccato, dichiarazione onesta', async () => {
  // La directory attivita' e' read-only: la pubblicazione fallisce, il
  // lancio parte comunque (la fermata c'e' sempre, la VISIBILITA' persistente
  // richiede il canale) e il fallimento viene dichiarato — mai una diagnosi
  // silenziosamente assente.
  const w = makeCustomWorld();
  try {
    const dir = path.join(w.filesRoot, 'work-custom');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o500);
    const res = await w.runtime.up('Dev');
    assert.equal(res.ok, true, 'il lancio non si blocca sul selettore');
    assert.ok(w.logs.some((l) => l.includes('launch selector not published')),
      'fallimento dichiarato: diagnosi non disponibile');
  } finally { w.cleanup(); }
});

test('cellStatus: terminal del lancio corrente esposto (reason+ts), assente senza record', async () => {
  const w = makeCustomWorld();
  try {
    await w.runtime.up('Dev');
    const dir = path.join(w.filesRoot, 'work-custom');
    const launchId = w.ticket().activity.generation;
    // Nessun record: campo assente, la cella non finge una diagnosi.
    const prima = await w.runtime.cellStatus();
    assert.equal(prima.cells[0].terminal, undefined);
    // Record del lancio corrente: la ragione arriva a status (pane o non pane).
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId, reason: 'restart-budget-exhausted', ora: 1700000000000,
    }), true);
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, launchId), true);
    const dopo = await w.runtime.cellStatus();
    assert.deepEqual(dopo.cells[0].terminal,
      { reason: 'restart-budget-exhausted', ts: 1700000000000 },
      'solo enum + timestamp, nessun testo libero o percorso');
    // Lancio nuovo: il selettore si sposta, la ragione vecchia non si vede.
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, 'ffff000000000009'), true);
    const nuovo = await w.runtime.cellStatus();
    assert.equal(nuovo.cells[0].terminal, undefined,
      'un nuovo lancio invalida la ragione del vecchio');
  } finally { w.cleanup(); }
});

// ===========================================================================
// 7b. Correzioni dello strato 1: il lettore della diagnosi
//     terminale e' LEGATO ALL'AUTORITA' DEL LANCIO CORRENTE (registro del
//     runtime: in memoria + su file FUORI dalla directory di sessione). Una
//     pubblicazione fallita del selettore non trasforma il record del lancio
//     precedente nella diagnosi del lancio nuovo — nemmeno dopo il riavvio
//     del runtime — e l'opt-out del canale attivita' non eredita la diagnosi
//     di un lancio che non e' piu' quello corrente.
// ===========================================================================

// Mondo condiviso per le prove di RIAVVIO del runtime: stessa root (defs,
// fake tmux, file di attivita'), runtime DIVERSI — il secondo non ha memoria
// in-processo del primo, come un processo ripartito. mkRuntime(cfgExtra)
// costruisce un runtime con la propria coda di log e il proprio capture del
// ticket del broker.
function makeCustomWorldConRiavvio() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-rv-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, 'work'); fs.mkdirSync(cwd);
  const filesRoot = path.join(root, 'files');
  const defsPath = path.join(root, 'fleet.json');
  const fakeCli = path.join(root, 'fake-cli');
  fs.writeFileSync(fakeCli, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeCli, 0o755);
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'fake.cli', label: 'F', rc: false, command: fakeCli, args: [], promptMode: 'send-keys' }],
    cells: [{ id: 'Dev', tmuxSession: 'work-custom', cwd, engine: 'fake.cli', boot: false }],
  });
  const tmuxBin = writeFakeTmux(root, {});
  const mkRuntime = (cfgExtra = {}) => {
    let ticket = null;
    const logs = [];
    const runtime = createBuiltinRuntime({
      cfg: { launchReadyMs: 40, filesRoot, log: (m) => logs.push(String(m)), ...cfgExtra },
      home, defsPath, tmuxBin, readonly: () => false,
      launchBroker: {
        issue: async (payload) => { ticket = payload; return { socketPath: '/x', nonce: 'n'.repeat(64) }; },
        close: async () => {},
      },
      boot: loadDefinitions(defsPath),
    });
    return { runtime, logs, ticket: () => ticket };
  };
  return {
    root, filesRoot, mkRuntime,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('rimuoviSelettoreLancio: esito CONTROLLATO — false su errore reale, true solo su rimozione o assenza', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-rm-'));
  const dir = path.join(root, 's');
  fs.mkdirSync(dir, { recursive: true });
  try {
    assert.equal(activityFiles.rimuoviSelettoreLancio(dir), true, 'assenza = esito onesto (ENOENT)');
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, 'aaaa000000000001'), true);
    assert.equal(activityFiles.rimuoviSelettoreLancio(dir), true, 'rimozione riuscita');
    // Directory non scrivibile con selettore presente: la rimozione FALLISCE e
    // il booleano lo dichiara — chi chiama non puo' presumere la pulizia.
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, 'aaaa000000000002'), true);
    fs.chmodSync(dir, 0o500);
    assert.equal(activityFiles.rimuoviSelettoreLancio(dir), false, 'errore reale dichiarato, non muto');
  } finally { fs.chmodSync(dir, 0o700); fs.rmSync(root, { recursive: true, force: true }); }
});

test('registro dei lanci: round-trip per stato canale, id ostili rifiutati, file rotto = assenza', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-reg-'));
  try {
    for (const canale of ['selector', 'none', 'off']) {
      assert.equal(activityFiles.registraLancioCorrente(root, 'work-x', {
        launchId: 'aaaa000000000001', canale, ora: 5,
      }), true, canale);
      assert.deepEqual(activityFiles.leggiLancioCorrente(root, 'work-x'),
        { launchId: 'aaaa000000000001', canale, ts: 5 }, `round-trip ${canale}`);
    }
    // Sessione/id ostili: mai un path fuori dalla root del registro.
    assert.equal(activityFiles.registraLancioCorrente(root, '../altro', {
      launchId: 'aaaa000000000002', canale: 'off',
    }), false);
    assert.equal(activityFiles.registraLancioCorrente(root, 'a/b', {
      launchId: 'aaaa000000000003', canale: 'off',
    }), false);
    assert.equal(activityFiles.registraLancioCorrente(root, 'work-x', {
      launchId: '../escape', canale: 'off',
    }), false);
    assert.equal(activityFiles.registraLancioCorrente(root, 'work-x', {
      launchId: 'aaaa000000000004', canale: 'free',
    }), false, 'stato canale fuori enum rifiutato');
    assert.equal(activityFiles.leggiLancioCorrente(root, '../altro'), null);
    // File rotto o fuori schema: assenza onesta, mai throw.
    fs.writeFileSync(path.join(root, 'launch-registry', 'rotto.json'), '{nope');
    assert.equal(activityFiles.leggiLancioCorrente(root, 'rotto'), null);
    fs.writeFileSync(path.join(root, 'launch-registry', 'strano.json'),
      JSON.stringify({ version: 1, event: 'launch-registry', launchId: 'aaaa000000000005', channel: 'altro', ts: 1 }));
    assert.equal(activityFiles.leggiLancioCorrente(root, 'strano'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lettura legata al lancio corrente: canale compromesso legge PER IDENTITA\', canale off non legge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-auth-'));
  const dir = path.join(root, 's');
  fs.mkdirSync(dir, { recursive: true });
  const vecchio = 'aaaa000000000001';
  const nuovo = 'bbbb000000000002';
  try {
    // Il selettore e' rimasto quello del VECCHIO lancio (pubblicazione del
    // nuovo fallita, rimozione fallita): chi legge per identita' non lo guarda.
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, vecchio), true);
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: vecchio, reason: 'spawn-error', ora: 1,
    }), true);
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: nuovo, reason: 'lease-lost', ora: 2,
    }), true);
    assert.equal(activityFiles.leggiDiagnosiTerminaleCorrente(root, 's', {
      launchId: nuovo, canale: 'none',
    }).reason, 'lease-lost', 'none: la ragione del lancio CORRENTE, non quella del selettore stantio');
    assert.equal(activityFiles.leggiDiagnosiTerminaleCorrente(root, 's', {
      launchId: nuovo, canale: 'off',
    }), null, 'off: nessuna diagnosi attribuita a un lancio senza canale');
    assert.equal(activityFiles.leggiDiagnosiTerminaleCorrente(root, 's', null), null,
      'senza autorita\' nota l\'esito e\' l\'assenza, non l\'ultimo selettore leggibile');
    // Il selettore rimasto su quello del VECCHIO lancio non consegna la
    // diagnosi del vecchio al lancio nuovo: l'identita' selezionata si
    // confronta con quella dell'autorita' corrente, e una selezione diversa
    // e' assenza onesta — mai il record di un altro lancio.
    assert.equal(activityFiles.leggiDiagnosiTerminaleCorrente(root, 's', {
      launchId: nuovo, canale: 'selector',
    }), null, 'selector: una selezione che non e\' quella del lancio corrente non restituisce un altro lancio');
    // Canale integro: il selettore ripubblicato sul lancio corrente consegna
    // il record di QUEL lancio (e solo quello).
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, nuovo), true);
    assert.equal(activityFiles.leggiDiagnosiTerminaleCorrente(root, 's', {
      launchId: nuovo, canale: 'selector',
    }).reason, 'lease-lost', 'selector: con il selettore del lancio corrente si legge il suo record');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cellStatus: pubblicazione fallita con lancio precedente — la ragione del vecchio NON e\' la diagnosi del nuovo', async () => {
  const w = makeCustomWorld();
  const dir = path.join(w.filesRoot, 'work-custom');
  const vecchio = 'aaaa111122223333';
  try {
    // Il lancio precedente esiste ED e' visibile: selezione e ragione proprie.
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, vecchio), true);
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: vecchio, reason: 'restart-budget-exhausted', ora: 1,
    }), true);
    assert.equal(activityFiles.leggiDiagnosiTerminale(w.filesRoot, 'work-custom').reason,
      'restart-budget-exhausted', 'il lancio precedente era correntemente selezionato');
    // La directory di sessione diventa non scrivibile: pubblicare il selettore
    // del nuovo lancio FALLISCE e fallisce anche la rimozione di quello vecchio.
    fs.chmodSync(dir, 0o500);
    const res = await w.runtime.up('Dev');
    assert.equal(res.ok, true, 'il lancio non si blocca sul selettore');
    const nuovo = w.ticket().activity.generation;
    assert.notEqual(nuovo, vecchio, 'lancio nuovo, identita\' diversa');
    assert.equal(activityFiles.leggiSelettoreLancio(dir), vecchio,
      'il selettore su disco e\' rimasto quello VECCHIO');
    assert.ok(w.logs.some((l) => l.includes('launch selector not published')),
      'fallimento dichiarato: diagnosi non disponibile');
    // La vista non attribuisce al lancio nuovo la ragione del vecchio: il
    // selettore rimasto su disco e' STANTIO e non si presume attuale.
    const st = await w.runtime.cellStatus();
    assert.equal(st.cells[0].terminal, undefined,
      'la ragione del lancio vecchio non e\' la diagnosi del lancio nuovo');
  } finally { fs.chmodSync(dir, 0o700); w.cleanup(); }
});

test('cellStatus: dopo il RIAVVIO del runtime la selezione stantia non vale; al ripristino la ragione del lancio corrente si vede', async () => {
  const w = makeCustomWorldConRiavvio();
  const dir = path.join(w.filesRoot, 'work-custom');
  const vecchio = 'aaaa111122223334';
  try {
    const prima = w.mkRuntime();
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, vecchio), true);
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: vecchio, reason: 'operator-stop', ora: 2,
    }), true);
    fs.chmodSync(dir, 0o500);
    assert.equal((await prima.runtime.up('Dev')).ok, true, 'il lancio parte anche senza canale');
    const corrente = prima.ticket().activity.generation;
    assert.notEqual(corrente, vecchio);
    // Il runtime riparte (nessuna memoria in-processo): l'autorita' del lancio
    // si ricostruisce dal registro, non dall'ultimo selettore leggibile.
    const riavviato = w.mkRuntime();
    let st = await riavviato.runtime.cellStatus();
    assert.equal(st.cells[0].terminal, undefined,
      'dopo il riavvio la ragione del lancio vecchio non si mostra');
    // Ripristino del canale: la ragione del lancio CORRENTE (partito durante
    // l'indisponibilita') viene selezionata correttamente, per identita' —
    // mai attraverso il selettore rimasto quello del vecchio.
    fs.chmodSync(dir, 0o700);
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: corrente, reason: 'lease-lost', ora: 3,
    }), true);
    st = await riavviato.runtime.cellStatus();
    assert.deepEqual(st.cells[0].terminal, { reason: 'lease-lost', ts: 3 },
      'la ragione del lancio corrente si vede, quella del vecchio mai');
    // Il canale tornato integro serve anche al lancio SUCCESSIVO: selezione
    // normale, selettore del nuovo lancio pubblicato dal proprietario.
    await prima.runtime.down('Dev');
    const ripristinato = w.mkRuntime();
    assert.equal((await ripristinato.runtime.up('Dev')).ok, true);
    const successivo = ripristinato.ticket().activity.generation;
    assert.equal(activityFiles.leggiSelettoreLancio(dir), successivo,
      'selettore ripubblicato per il lancio nuovo');
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: successivo, reason: 'spawn-error', ora: 4,
    }), true);
    st = await ripristinato.runtime.cellStatus();
    assert.deepEqual(st.cells[0].terminal, { reason: 'spawn-error', ts: 4 },
      'con il canale integro la selezione torna quella del lancio corrente');
  } finally { fs.chmodSync(dir, 0o700); w.cleanup(); }
});

test('opt-out activityHooks: nessuna diagnosi del lancio precedente sul nuovo, nemmeno dopo il riavvio', async () => {
  const w = makeCustomWorldConRiavvio();
  const dir = path.join(w.filesRoot, 'work-custom');
  try {
    // Canale ATTIVO: il lancio A si ferma e la sua ragione e' visibile.
    const conCanale = w.mkRuntime();
    assert.equal((await conCanale.runtime.up('Dev')).ok, true);
    const idA = conCanale.ticket().activity.generation;
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: idA, reason: 'lease-lost', ora: 1,
    }), true);
    const stA = await conCanale.runtime.cellStatus();
    assert.deepEqual(stA.cells[0].terminal, { reason: 'lease-lost', ts: 1 },
      'con il canale attivo la fermata del lancio corrente si vede');
    // L'operatore disattiva il canale: il lancio B non ne ha, e la storia di
    // A non e' lo stato corrente di B.
    await conCanale.runtime.down('Dev');
    const senzaCanale = w.mkRuntime({ activityHooks: false });
    assert.equal((await senzaCanale.runtime.up('Dev')).ok, true);
    assert.equal(senzaCanale.ticket().activity, undefined, 'opt-out rispettato nel payload');
    const stB = await senzaCanale.runtime.cellStatus();
    assert.equal(stB.cells[0].terminal, undefined,
      'nessuna etichetta terminale di A sul lancio B vivo');
    // Riavvio del runtime: l'opt-out registrato vale anche senza memoria
    // in-processo.
    const riavviato = w.mkRuntime({ activityHooks: false });
    const stB2 = await riavviato.runtime.cellStatus();
    assert.equal(stB2.cells[0].terminal, undefined,
      'dopo il riavvio nessuna etichetta terminale di A');
    // Re-enable: il lancio nuovo pubblica la propria selezione e mostra la
    // propria ragione — mai quella di A.
    await senzaCanale.runtime.down('Dev');
    const rientrato = w.mkRuntime();
    assert.equal((await rientrato.runtime.up('Dev')).ok, true);
    const idC = rientrato.ticket().activity.generation;
    let st = await rientrato.runtime.cellStatus();
    assert.equal(st.cells[0].terminal, undefined,
      'lancio vivo: nessuna ragione propria da mostrare');
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: idC, reason: 'operator-stop', ora: 4,
    }), true);
    st = await rientrato.runtime.cellStatus();
    assert.deepEqual(st.cells[0].terminal, { reason: 'operator-stop', ts: 4 },
      'al re-enable la ragione del lancio CORRENTE, mai quella di A');
  } finally { w.cleanup(); }
});

// ===========================================================================
// 7c. Secondo giro di correzioni. Tre controprobe indipendenti (riportate
//     dal re-esame del primo giro e qui tenute come regressioni permanenti):
//     (1) il canale selector non sostituisce MAI l'identita' di un altro
//     lancio; (2)+(3) il fallimento PERSISTENTE della scrittura del registro
//     — con hook attivi e con activityHooks:false — non puo' far risorgere
//     la diagnosi del lancio vecchio dopo il riavvio del runtime. A questo
//     serve il registro in DUE locazioni: quando NESSUNA delle due accetta
//     la scrittura il lancio e' rifiutato, perche' un'autorita' senza alcuna
//     traccia durevole durerebbe solo fino al riavvio, e dopo il riavvio il
//     record rimasto su disco — quello del lancio precedente — tornerebbe
//     corrente. Un log e una Map in memoria non sono una traccia durevole.
// ===========================================================================

test('independent: selector mode must not substitute a different launch identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-id-'));
  const dir = path.join(root, 's');
  try {
    assert.equal(activityFiles.pubblicaSelettoreLancio(dir, 'oldlaunch'), true);
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: 'oldlaunch', reason: 'operator-stop', ora: 1,
    }), true);
    const d = activityFiles.leggiDiagnosiTerminaleCorrente(root, 's', {
      launchId: 'newlaunch', canale: 'selector',
    });
    assert.equal(d, null, 'a launch-tagged authority must not resolve another launch terminal');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const hooksOff of [false, true]) test(`independent: persistent registry failure with hooks ${hooksOff ? 'off' : 'on'} cannot revive old diagnosis after restart`, async () => {
  const w = makeCustomWorldConRiavvio();
  const dir = path.join(w.filesRoot, 'work-custom');
  const reg = path.join(w.filesRoot, 'launch-registry');
  try {
    const a = w.mkRuntime();
    assert.equal((await a.runtime.up('Dev')).ok, true);
    const old = a.ticket().activity.generation;
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: old, reason: 'lease-lost', ora: 1,
    }), true);
    assert.equal((await a.runtime.cellStatus()).cells[0].terminal.reason, 'lease-lost');
    await a.runtime.down('Dev');
    const oldRegistry = fs.readFileSync(path.join(reg, 'work-custom.json'), 'utf8');
    fs.chmodSync(reg, 0o500);
    if (!hooksOff) fs.chmodSync(dir, 0o500);
    const b = w.mkRuntime(hooksOff ? { activityHooks: false } : {});
    assert.equal((await b.runtime.up('Dev')).ok, true);
    assert.ok(b.logs.some((x) => x.includes('launch registry not written')),
      'il fallimento della locazione primaria e\' dichiarato');
    assert.equal(fs.readFileSync(path.join(reg, 'work-custom.json'), 'utf8'), oldRegistry,
      'il record primario resta byte-identico');
    assert.equal((await b.runtime.cellStatus()).cells[0].terminal, undefined,
      'in-process authority suppresses old A');
    const restarted = w.mkRuntime(hooksOff ? { activityHooks: false } : {});
    const st = await restarted.runtime.cellStatus();
    assert.equal(st.cells[0].terminal, undefined,
      'new B may be unknown; old A cannot become current after restart');
  } finally {
    if (fs.existsSync(reg)) fs.chmodSync(reg, 0o700);
    if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
    w.cleanup();
  }
});

test('registro a due locazioni: la lettura segue la piu\' recente fra primaria e riserva', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestart-2loc-'));
  const primaria = path.join(root, 'launch-registry');
  try {
    const esito1 = {};
    assert.equal(activityFiles.registraLancioCorrente(root, 's', {
      launchId: 'aaaa000000000001', canale: 'selector', ora: 10, esito: esito1,
    }), true);
    assert.equal(esito1.primario, true, 'primaria dichiarata scritta');
    assert.equal(esito1.riserva, true, 'riserva dichiarata scritta');
    assert.equal(activityFiles.leggiLancioCorrente(root, 's').launchId, 'aaaa000000000001');
    // La primaria smette di accettare scritture: la verita' corrente resta
    // durevole nella riserva, e la lettura la segue.
    fs.chmodSync(primaria, 0o500);
    const esito2 = {};
    assert.equal(activityFiles.registraLancioCorrente(root, 's', {
      launchId: 'bbbb000000000002', canale: 'off', ora: 20, esito: esito2,
    }), true, 'almeno una locazione persiste');
    assert.equal(esito2.primario, false, 'primaria dichiarata NON scritta');
    assert.equal(esito2.riserva, true, 'riserva dichiarata scritta');
    const letto = activityFiles.leggiLancioCorrente(root, 's');
    assert.equal(letto.launchId, 'bbbb000000000002',
      'vince il record piu\' recente, non quello rimasto nella primaria');
    assert.equal(letto.canale, 'off');
    // Primaria di nuovo scrivibile: il lancio successivo la aggiorna e la
    // lettura segue di nuovo lei (ts maggiore).
    fs.chmodSync(primaria, 0o700);
    assert.equal(activityFiles.registraLancioCorrente(root, 's', {
      launchId: 'cccc000000000003', canale: 'selector', ora: 30,
    }), true);
    assert.equal(activityFiles.leggiLancioCorrente(root, 's').launchId, 'cccc000000000003');
  } finally {
    if (fs.existsSync(primaria)) fs.chmodSync(primaria, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('registro inaccessibile ovunque: il lancio e\' RIFIUTATO, il corrente resta il precedente', async () => {
  const w = makeCustomWorldConRiavvio();
  const dir = path.join(w.filesRoot, 'work-custom');
  const primaria = path.join(w.filesRoot, 'launch-registry');
  const riserva = path.join(w.filesRoot, 'launch-registry-spare');
  try {
    const a = w.mkRuntime();
    assert.equal((await a.runtime.up('Dev')).ok, true);
    const idA = a.ticket().activity.generation;
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: idA, reason: 'restart-budget-exhausted', ora: 1,
    }), true);
    await a.runtime.down('Dev');
    // Nessuna delle DUE locazioni del registro accetta piu' scritture (e
    // nemmeno la directory di sessione): nessuna traccia durevole possibile.
    fs.chmodSync(primaria, 0o500); fs.chmodSync(riserva, 0o500); fs.chmodSync(dir, 0o500);
    const b = w.mkRuntime();
    await assert.rejects(b.runtime.up('Dev'), (e) => e && e.fleetCode === 'LAUNCH_REGISTRY_UNWRITABLE',
      'senza alcuna traccia durevole della nuova autorita\' il lancio non parte');
    // Il lancio precedente resta il corrente a tutti gli effetti: la sua
    // diagnosi e' quella VERA (niente di risorto, niente di nascosto), per
    // il runtime che c'e' e per uno ripartito.
    const st = await a.runtime.cellStatus();
    assert.deepEqual(st.cells[0].terminal, { reason: 'restart-budget-exhausted', ts: 1 });
    const riavviato = w.mkRuntime();
    const st2 = await riavviato.runtime.cellStatus();
    assert.deepEqual(st2.cells[0].terminal, { reason: 'restart-budget-exhausted', ts: 1 },
      'dopo il rifiuto (e un riavvio) l\'autorita\' resta quella di A');
  } finally {
    for (const d of [primaria, riserva, dir]) { if (fs.existsSync(d)) fs.chmodSync(d, 0o700); }
    w.cleanup();
  }
});

// ===========================================================================
// 7d. Terzo giro di correzioni. L'autorita' del registro si ordina per
//     REVISIONE PERSISTENTE (mai per orologio civile) e il commit
//     dell'autorita' PRECEDE la pubblicazione del selettore: un lancio
//     ammesso resta l'autorita' piu' recente dopo il riavvio del runtime
//     indipendentemente dal clock (uguale o arretrato), dall'ordine delle
//     locazioni e da quale copia sia rimasta vecchia; un lancio RIFIUTATO
//     per registro inaccessibile lascia selettore e diagnosi del lancio
//     precedente coerenti e leggibili, sessione scrivibile o meno.
// ===========================================================================

// Scrittura che tocca SOLO la primaria (riserva guasta): resta la piu'
// recente anche a timestamp UGUALE o ARRETRATO rispetto al record rimasto
// nella riserva — ordina la revisione, non il wall clock.
for (const clock of [100, 99]) test(`registro: scrittura solo-primaria a timestamp ${clock} resta la piu' recente`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-order-p-'));
  const spare = path.join(root, 'launch-registry-spare');
  try {
    assert.equal(activityFiles.registraLancioCorrente(root, 's', {
      launchId: 'oldlaunch', canale: 'selector', ora: 100,
    }), true);
    fs.chmodSync(spare, 0o500);
    const esito = {};
    assert.equal(activityFiles.registraLancioCorrente(root, 's', {
      launchId: 'newlaunch', canale: 'off', ora: clock, esito,
    }), true);
    assert.deepEqual(esito, { primario: true, riserva: false });
    assert.equal(activityFiles.leggiLancioCorrente(root, 's').launchId, 'newlaunch',
      'il lancio ammesso sopravanza l\'autorita\' precedente indipendentemente dal clock');
  } finally { fs.chmodSync(spare, 0o700); fs.rmSync(root, { recursive: true, force: true }); }
});

// Simmetria delle locazioni: la scrittura che tocca SOLO la riserva (primaria
// guasta) resta la piu' recente nelle stesse condizioni di clock.
for (const clock of [100, 99]) test(`registro: scrittura solo-riserva a timestamp ${clock} resta la piu' recente`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-order-s-'));
  const primaria = path.join(root, 'launch-registry');
  try {
    assert.equal(activityFiles.registraLancioCorrente(root, 's', {
      launchId: 'oldlaunch', canale: 'selector', ora: 100,
    }), true);
    fs.chmodSync(primaria, 0o500);
    const esito = {};
    assert.equal(activityFiles.registraLancioCorrente(root, 's', {
      launchId: 'newlaunch', canale: 'off', ora: clock, esito,
    }), true);
    assert.deepEqual(esito, { primario: false, riserva: true });
    assert.equal(activityFiles.leggiLancioCorrente(root, 's').launchId, 'newlaunch',
      'nessuna locazione e\' privilegiata: vince la revisione piu\' alta');
  } finally { fs.chmodSync(primaria, 0o700); fs.rmSync(root, { recursive: true, force: true }); }
});

// Due identita' DIVERGENTI alla stessa revisione: l'ordine non e' stabilibile
// e la lettura e' l'assenza onesta — mai una delle due per preferenza fissa
// di locazione o di clock. I record sono scritti a mano perche' l'API, che
// incrementa la revisione sotto il lock del proprietario, non puo' produrli.
test('registro: revisione pari con lanci divergenti -> assenza onesta, nessuna preferenza fissa', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-order-d-'));
  const scrivi = (dir, launchId, ts, rev) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's.json'), `${JSON.stringify({
      version: 1, event: 'launch-registry', launchId, channel: 'selector', ts, rev,
    })}\n`);
  };
  try {
    scrivi(path.join(root, 'launch-registry'), 'aaaa000000000001', 10, 7);
    scrivi(path.join(root, 'launch-registry-spare'), 'bbbb000000000002', 20, 7);
    assert.equal(activityFiles.leggiLancioCorrente(root, 's'), null,
      'ordine non stabilibile: nessuna delle due copie vince per convenzione');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Runtime: dopo il riavvio del processo l'autorita' resta quella del lancio
// AMMESSO, mai quella del lancio vecchio, con hook attivi e con attivita'
// disattivata, a timestamp uguale e arretrato. La riserva del registro resta
// vecchia: l'ordinamento non puo' dipendere da lei ne' dal clock.
for (const hooksOff of [false, true]) for (const clock of [100, 99]) test(`registro: riavvio con hook ${hooksOff ? 'disattivati' : 'attivi'} e timestamp ${clock} — l'autorita' resta il lancio ammesso`, async () => {
  const w = makeCustomWorldConRiavvio();
  const dir = path.join(w.filesRoot, 'work-custom');
  const spare = path.join(w.filesRoot, 'launch-registry-spare');
  const registro = path.join(w.filesRoot, 'launch-registry', 'work-custom.json');
  try {
    const a = w.mkRuntime({ now: () => 100 });
    assert.equal((await a.runtime.up('Dev')).ok, true);
    const idA = a.ticket().activity.generation;
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: idA, reason: 'lease-lost', ora: 1,
    }), true);
    assert.equal((await a.runtime.cellStatus()).cells[0].terminal.reason, 'lease-lost');
    await a.runtime.down('Dev');
    fs.chmodSync(spare, 0o500);
    if (!hooksOff) fs.chmodSync(dir, 0o500);
    const b = w.mkRuntime({ now: () => clock, ...(hooksOff ? { activityHooks: false } : {}) });
    assert.equal((await b.runtime.up('Dev')).ok, true);
    assert.ok(b.logs.some((l) => l.includes('launch registry spare not written')),
      'la locazione rimasta indietro e\' dichiarata');
    assert.equal((await b.runtime.cellStatus()).cells[0].terminal, undefined,
      'in processo l\'autorita\' e\' quella del lancio ammesso');
    const idB = JSON.parse(fs.readFileSync(registro, 'utf8')).launchId;
    assert.notEqual(idB, idA);
    const riavviato = w.mkRuntime(hooksOff ? { activityHooks: false } : {});
    const st = await riavviato.runtime.cellStatus();
    assert.equal(st.cells[0].terminal, undefined,
      'dopo il riavvio il lancio vecchio non torna autorita\'');
    assert.equal(activityFiles.leggiLancioCorrente(w.filesRoot, 'work-custom').launchId, idB,
      'l\'autorita\' persistente e\' il lancio ammesso, a clock uguale o arretrato');
  } finally {
    for (const d of [spare, dir]) if (fs.existsSync(d)) fs.chmodSync(d, 0o700);
    w.cleanup();
  }
});

// Off dopo il riavvio, registro sano e clock in pari col lancio precedente:
// l'autorita' e' comunque il lancio nuovo a canale disattivato, e la storia
// del vecchio non e' la sua diagnosi.
test('registro: off sopravvive al riavvio con clock in pari — autorita\' nuova, nessuna diagnosi del vecchio', async () => {
  const w = makeCustomWorldConRiavvio();
  try {
    const a = w.mkRuntime({ now: () => 100 });
    assert.equal((await a.runtime.up('Dev')).ok, true);
    const idA = a.ticket().activity.generation;
    const dir = path.join(w.filesRoot, 'work-custom');
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: idA, reason: 'lease-lost', ora: 1,
    }), true);
    await a.runtime.down('Dev');
    const b = w.mkRuntime({ now: () => 100, activityHooks: false });
    assert.equal((await b.runtime.up('Dev')).ok, true);
    assert.equal(b.ticket().activity, undefined, 'opt-out rispettato nel payload');
    const idB = JSON.parse(fs.readFileSync(
      path.join(w.filesRoot, 'launch-registry', 'work-custom.json'), 'utf8')).launchId;
    assert.notEqual(idB, idA);
    const st = await w.mkRuntime().runtime.cellStatus();
    assert.equal(st.cells[0].terminal, undefined,
      'il canale off non eredita la diagnosi del lancio vecchio');
    assert.equal(activityFiles.leggiLancioCorrente(w.filesRoot, 'work-custom').launchId, idB,
      'a pari clock vince la revisione del lancio nuovo');
  } finally { w.cleanup(); }
});

// Rifiuto per registro inaccessibile con SESSIONE SCRIVIBILE: il rifiuto
// avviene PRIMA di toccare il selettore — zero ticket al broker, identita' e
// diagnosi del lancio precedente identiche prima e dopo il rifiuto, e dopo
// il riavvio del runtime.
test('registro inaccessibile con sessione scrivibile: rifiuto PRIMA del selettore, il corrente resta leggibile', async () => {
  const w = makeCustomWorldConRiavvio();
  const dir = path.join(w.filesRoot, 'work-custom');
  const regs = ['launch-registry', 'launch-registry-spare'].map((d) => path.join(w.filesRoot, d));
  try {
    const a = w.mkRuntime();
    assert.equal((await a.runtime.up('Dev')).ok, true);
    const idA = a.ticket().activity.generation;
    assert.equal(activityFiles.scriviRecordTerminale(dir, {
      launchId: idA, reason: 'restart-budget-exhausted', ora: 1,
    }), true);
    const prima = (await a.runtime.cellStatus()).cells[0].terminal;
    assert.deepEqual(prima, { reason: 'restart-budget-exhausted', ts: 1 });
    await a.runtime.down('Dev');
    for (const d of regs) fs.chmodSync(d, 0o500);
    const b = w.mkRuntime();
    await assert.rejects(b.runtime.up('Dev'),
      (e) => e && e.fleetCode === 'LAUNCH_REGISTRY_UNWRITABLE');
    assert.equal(b.ticket(), null, 'nessun ticket al broker: il rifiuto precede lo spawn');
    assert.equal(activityFiles.leggiSelettoreLancio(dir), idA,
      'il selettore non e\' stato spostato dal lancio rifiutato');
    const dopo = (await w.mkRuntime().runtime.cellStatus()).cells[0].terminal;
    assert.deepEqual(dopo, prima,
      'diagnosi identica prima e dopo il rifiuto (e dopo il riavvio)');
  } finally {
    for (const d of regs) if (fs.existsSync(d)) fs.chmodSync(d, 0o700);
    w.cleanup();
  }
});

// ===========================================================================
// 7e. Quarto giro di correzioni. La revisione di una copia ILLEGGIBILE — o di
//     un suo record non valido — non e' osservabile: una scrittura ammessa
//     sopra il massimo LEGGIBILE potrebbe restare sotto una revisione
//     nascosta, e la copia tornata leggibile rispristinerebbe un lancio
//     superato. L'ordine non stabilibile si rifiuta PRIMA di ogni effetto
//     (stesso enum chiuso del registro inaccessibile) e la lettura dichiara
//     l'assenza onesta finche' l'autorita' non e' stabilibile. Le copie
//     provate sono ILLEGGIBILI (0000, con verifica che la lettura fallisca),
//     non solo non scrivibili: una directory 0500 resta leggibile e non basta.
//     Entrambe le locazioni, alternativamente, con hook attivi e disattivati.
// ===========================================================================

test('registry: an unreadable higher revision must not lose authority to an admitted lower revision', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-a4-hidden-'));
  const p = path.join(root, 'launch-registry');
  const q = path.join(root, 'launch-registry-spare');
  try {
    assert.equal(activityFiles.registraLancioCorrente(root, 's', { launchId: 'seedlaunch', canale: 'selector', ora: 1 }), true);
    fs.chmodSync(q, 0o500);
    for (let i = 0; i < 4; i += 1) {
      assert.equal(activityFiles.registraLancioCorrente(root, 's', { launchId: 'oldlaunch', canale: 'selector', ora: 1 }), true);
    }
    const old = JSON.parse(fs.readFileSync(path.join(p, 's.json'), 'utf8'));
    assert.ok(old.rev >= 5, 'the primary alone advanced above the frozen spare');
    fs.chmodSync(q, 0o700);
    fs.chmodSync(p, 0o000);
    assert.throws(() => fs.readFileSync(path.join(p, 's.json'), 'utf8'), (e) => e.code === 'EACCES');
    const esito = {};
    const admitted = activityFiles.registraLancioCorrente(root, 's', { launchId: 'newlaunch', canale: 'off', ora: 1, esito });
    fs.chmodSync(p, 0o700);
    const current = activityFiles.leggiLancioCorrente(root, 's');
    console.log('HIDDEN_REV', JSON.stringify({ oldRevision: old.rev, admitted, esito, current }));
    assert.ok(!admitted || current?.launchId === 'newlaunch',
      'must refuse uncertain order or keep the newly admitted authority after the unreadable copy returns');
  } finally { for (const d of [p, q]) if (fs.existsSync(d)) fs.chmodSync(d, 0o700); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const hooksOff of [false, true]) test(`registry: unreadable newer primary then runtime restart hooks ${hooksOff ? 'off' : 'on'}`, async () => {
  const w = makeCustomWorldConRiavvio();
  const p = path.join(w.filesRoot, 'launch-registry');
  const q = path.join(w.filesRoot, 'launch-registry-spare');
  const dir = path.join(w.filesRoot, 'work-custom');
  try {
    const a = w.mkRuntime();
    assert.equal((await a.runtime.up('Dev')).ok, true);
    fs.chmodSync(q, 0o500);
    for (let i = 0; i < 2; i += 1) {
      await a.runtime.down('Dev');
      assert.equal((await a.runtime.up('Dev')).ok, true);
    }
    const idA = a.ticket().activity.generation;
    assert.equal(activityFiles.scriviRecordTerminale(dir, { launchId: idA, reason: 'lease-lost', ora: 1 }), true);
    const old = JSON.parse(fs.readFileSync(path.join(p, 'work-custom.json'), 'utf8'));
    assert.ok(old.rev >= 6, 'the primary alone advanced above the frozen spare');
    assert.equal((await a.runtime.cellStatus()).cells[0].terminal.reason, 'lease-lost');
    await a.runtime.down('Dev');
    fs.chmodSync(q, 0o700);
    fs.chmodSync(p, 0o000);
    assert.throws(() => fs.readFileSync(path.join(p, 'work-custom.json'), 'utf8'), (e) => e.code === 'EACCES');
    if (!hooksOff) fs.chmodSync(dir, 0o500);
    const b = w.mkRuntime(hooksOff ? { activityHooks: false } : {});
    let admitted = false;
    let refusal = null;
    try { admitted = (await b.runtime.up('Dev')).ok === true; } catch (e) { refusal = e.fleetCode; assert.equal(refusal, 'LAUNCH_REGISTRY_UNWRITABLE'); }
    if (admitted) assert.equal((await b.runtime.cellStatus()).cells[0].terminal, undefined, 'in-memory B must suppress A');
    fs.chmodSync(p, 0o700);
    const st = await w.mkRuntime(hooksOff ? { activityHooks: false } : {}).runtime.cellStatus();
    console.log('HIDDEN_REV_RESTART', JSON.stringify({ hooksOff, oldRevision: old.rev, admitted, refusal, terminal: st.cells[0].terminal }));
    if (admitted) assert.equal(st.cells[0].terminal, undefined, 'admitted B must not restore old A after the primary returns');
  } finally { for (const d of [p, q, dir]) if (fs.existsSync(d)) fs.chmodSync(d, 0o700); w.cleanup(); }
});

test('registry: old records without rev migrate above zero', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-a4-legacy-'));
  try {
    for (const d of ['launch-registry', 'launch-registry-spare']) {
      const p = path.join(root, d);
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 's.json'), JSON.stringify({ version: 1, event: 'launch-registry', launchId: 'oldlaunch', channel: 'selector', ts: 100 }));
    }
    assert.equal(activityFiles.registraLancioCorrente(root, 's', { launchId: 'newlaunch', canale: 'off', ora: 99 }), true);
    assert.equal(activityFiles.leggiLancioCorrente(root, 's').launchId, 'newlaunch');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'launch-registry', 's.json'), 'utf8')).rev, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('registry: failed second commit retains current identity after runtime restart', async () => {
  const w = makeCustomWorldConRiavvio();
  const dir = path.join(w.filesRoot, 'work-custom');
  const regs = ['launch-registry', 'launch-registry-spare'].map((d) => path.join(w.filesRoot, d));
  const rename = fs.renameSync;
  let armed = false;
  try {
    const a = w.mkRuntime();
    assert.equal((await a.runtime.up('Dev')).ok, true);
    await a.runtime.down('Dev');
    fs.renameSync = function (from, to) {
      const r = rename.call(this, from, to);
      if (armed && to === path.join(dir, activityFiles.NOME_SELETTORE_LANCIO)) {
        armed = false;
        for (const d of regs) fs.chmodSync(d, 0o500);
      }
      return r;
    };
    armed = true;
    const b = w.mkRuntime();
    assert.equal((await b.runtime.up('Dev')).ok, true);
    assert.equal(armed, false, 'fault must fire after selector publication');
    assert.ok(b.logs.some((l) => l.includes('launch registry channel not updated')));
    const idB = b.ticket().activity.generation;
    assert.equal(activityFiles.leggiLancioCorrente(w.filesRoot, 'work-custom').launchId, idB);
    assert.equal(activityFiles.leggiLancioCorrente(w.filesRoot, 'work-custom').canale, 'none');
    assert.equal(activityFiles.scriviRecordTerminale(dir, { launchId: idB, reason: 'operator-stop', ora: 2 }), true);
    assert.deepEqual((await b.runtime.cellStatus()).cells[0].terminal, { reason: 'operator-stop', ts: 2 });
    assert.deepEqual((await w.mkRuntime().runtime.cellStatus()).cells[0].terminal, { reason: 'operator-stop', ts: 2 });
  } finally { fs.renameSync = rename; for (const d of regs) if (fs.existsSync(d)) fs.chmodSync(d, 0o700); w.cleanup(); }
});

// La copia ILLEGGIBILE con la revisione maggiore stavolta e' la RISERVA: il
// rifiuto vale per entrambe le locazioni, la copia leggibile resta intatta e
// l'autorita' resta assente finche' la copia nascosta non torna leggibile.
test('registry: an unreadable higher revision on the spare also refuses the new launch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-a4-spare-'));
  const p = path.join(root, 'launch-registry');
  const q = path.join(root, 'launch-registry-spare');
  try {
    assert.equal(activityFiles.registraLancioCorrente(root, 's', { launchId: 'seedlaunch', canale: 'selector', ora: 1 }), true);
    fs.chmodSync(p, 0o500);
    for (let i = 0; i < 4; i += 1) {
      assert.equal(activityFiles.registraLancioCorrente(root, 's', { launchId: 'oldlaunch', canale: 'selector', ora: 1 }), true);
    }
    const old = JSON.parse(fs.readFileSync(path.join(q, 's.json'), 'utf8'));
    assert.ok(old.rev >= 5, 'the spare alone advanced above the frozen primary');
    fs.chmodSync(p, 0o700);
    fs.chmodSync(q, 0o000);
    assert.throws(() => fs.readFileSync(path.join(q, 's.json'), 'utf8'), (e) => e.code === 'EACCES');
    assert.equal(activityFiles.leggiLancioCorrente(root, 's'), null,
      'authority is not establishable while a copy is unreadable: honest absence, no stale record as current');
    const esito = {};
    const prima = fs.readFileSync(path.join(p, 's.json'), 'utf8');
    assert.equal(activityFiles.registraLancioCorrente(root, 's', { launchId: 'newlaunch', canale: 'off', ora: 1, esito }), false,
      'refused before any effect: the hidden revision could outrank the new one');
    assert.deepEqual(esito, { primario: false, riserva: false }, 'no location written on refusal');
    assert.equal(fs.readFileSync(path.join(p, 's.json'), 'utf8'), prima,
      'no partial write: the readable copy is left untouched');
    fs.chmodSync(q, 0o700);
    assert.equal(activityFiles.leggiLancioCorrente(root, 's').launchId, 'oldlaunch',
      'after the spare returns readable, the refused launch never took authority');
  } finally { for (const d of [p, q]) if (fs.existsSync(d)) fs.chmodSync(d, 0o700); fs.rmSync(root, { recursive: true, force: true }); }
});

// Variante runtime della copia nascosta in RISERVA, hook attivi e off: il
// rifiuto precede lo spawn (zero ticket) e dopo il ripristino l'autorita' e'
// ancora quella del lancio mai superato, con la SUA diagnosi coerente.
for (const hooksOff of [false, true]) test(`registry: unreadable newer spare then runtime restart hooks ${hooksOff ? 'off' : 'on'}`, async () => {
  const w = makeCustomWorldConRiavvio();
  const p = path.join(w.filesRoot, 'launch-registry');
  const q = path.join(w.filesRoot, 'launch-registry-spare');
  const dir = path.join(w.filesRoot, 'work-custom');
  try {
    const a = w.mkRuntime();
    assert.equal((await a.runtime.up('Dev')).ok, true);
    fs.chmodSync(p, 0o500);
    for (let i = 0; i < 2; i += 1) {
      await a.runtime.down('Dev');
      assert.equal((await a.runtime.up('Dev')).ok, true);
    }
    const idA = a.ticket().activity.generation;
    assert.equal(activityFiles.scriviRecordTerminale(dir, { launchId: idA, reason: 'lease-lost', ora: 1 }), true);
    const old = JSON.parse(fs.readFileSync(path.join(q, 'work-custom.json'), 'utf8'));
    assert.ok(old.rev >= 6, 'the spare alone advanced above the frozen primary');
    assert.equal((await a.runtime.cellStatus()).cells[0].terminal.reason, 'lease-lost');
    await a.runtime.down('Dev');
    fs.chmodSync(p, 0o700);
    fs.chmodSync(q, 0o000);
    assert.throws(() => fs.readFileSync(path.join(q, 'work-custom.json'), 'utf8'), (e) => e.code === 'EACCES');
    if (!hooksOff) fs.chmodSync(dir, 0o500);
    const b = w.mkRuntime(hooksOff ? { activityHooks: false } : {});
    let admitted = false;
    let refusal = null;
    try { admitted = (await b.runtime.up('Dev')).ok === true; } catch (e) { refusal = e.fleetCode; assert.equal(refusal, 'LAUNCH_REGISTRY_UNWRITABLE'); }
    assert.equal(admitted, false, 'uncertain order: the launch is refused before any effect');
    assert.equal(b.ticket(), null, 'no broker ticket: the refusal precedes the spawn');
    if (!hooksOff) {
      assert.equal(activityFiles.leggiSelettoreLancio(dir), idA,
        'the selector was not moved by the refused launch');
    }
    fs.chmodSync(q, 0o700);
    const st = await w.mkRuntime(hooksOff ? { activityHooks: false } : {}).runtime.cellStatus();
    console.log('HIDDEN_SPARE_RESTART', JSON.stringify({ hooksOff, oldRevision: old.rev, admitted, refusal, terminal: st.cells[0].terminal }));
    assert.equal(st.cells[0].terminal && st.cells[0].terminal.reason, 'lease-lost',
      'the refused launch never took authority: A stays current with its own diagnosis');
  } finally { for (const d of [p, q, dir]) if (fs.existsSync(d)) fs.chmodSync(d, 0o700); w.cleanup(); }
});
