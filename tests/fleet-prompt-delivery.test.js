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
const cfg = ${JSON.stringify(cfg)};
const log = (s) => fs.appendFileSync(${JSON.stringify(path.join(dir, 'tmux.log'))}, s + '\\n');
const cmd = process.argv[2] || '';
const out = (s) => process.stdout.write(s);
const fmt = process.argv[process.argv.length - 1] || '';
const tgt = (() => { const i = process.argv.indexOf('-t'); return i >= 0 ? process.argv[i + 1] : ''; })();
const sess = (() => { const m = /^=([^:]+):?$/.exec(tgt); return m ? m[1] : 'work-kimi'; })();
switch (cmd) {
  case 'new-session':
    log('new-session');
    if (process.argv.includes('-P')) out('$1\\t@1\\t%42\\n');
    process.exit(0);
  case 'has-session':
    process.exit(0);
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
    log(process.argv.slice(2).join(' '));
    process.exit(0);
  case 'kill-session':
    log('kill-session');
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
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); fs.chmodSync(bin, 0o755);
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
    env: { KIMI_API_KEY: 'sk-test-fixture-only', NC_SENTINEL_LEAK: 'no' },
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
    // nessuna chiave runtime spuria (NC_SENTINEL_LEAK) passa.
    const names = Object.keys(t.env).sort();
    for (const required of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CONFIG_DIR', 'NEXUSCREW_MCP_SESSION', 'PATH', 'HOME']) {
      assert.ok(names.includes(required), `env name richiesto presente: ${required}`);
    }
    assert.ok(!names.includes('NC_SENTINEL_LEAK'), 'env runtime non allowlisted mai ereditato');
    assert.ok(!names.includes('KIMI_API_KEY'), 'la variabile sorgente non passa: il child vede solo ANTHROPIC_*');
    const allowed = /^(PATH|HOME|SHELL|TERM|COLORTERM|LANG|LANGUAGE|LC_ALL|LC_CTYPE|USER|LOGNAME|TMUX|TMUX_TMPDIR|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|PREFIX|TMPDIR|TERMUX_VERSION|ANDROID_DATA|ANDROID_ROOT|ANTHROPIC_[A-Z_]+|CLAUDE_CODE_[A-Z_]+|CLAUDE_CONFIG_DIR|API_TIMEOUT_MS|NEXUSCREW_MCP_SESSION)$/;
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
// 6. Regression (G5 audit): argv degli altri managed INVARIATO (prompt su argv)
// ===========================================================================
test('regression: claude.native/codex/pi/agy conservano prompt su argv; solo kimi + kimi-code via delivery', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncpdreg-'));
  try {
    for (const name of ['claude', 'codex', 'pi', 'agy', 'kimi']) {
      const dir = path.join(home, '.local', 'bin'); fs.mkdirSync(dir, { recursive: true });
      const bin = path.join(dir, name);
      fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); fs.chmodSync(bin, 0o755);
    }
    const cell = { id: 'Dev', prompt: 'bootstrap' };
    const claude = resolveManagedEngine(
      { id: 'claude.native', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'standard' } },
      cell, { home, env: {} },
    );
    assert.equal(claude.engine.promptMode, 'managed-argv');
    assert.ok(claude.engine.args.includes('bootstrap'), 'claude.native: argv invariato');
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
