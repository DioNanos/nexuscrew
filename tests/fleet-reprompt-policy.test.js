'use strict';
// Policy `restartReprompt` per engine custom send-keys: separa il prompt
// iniziale dal reinvio ai restart. Contratto:
//  - campo booleano nella definizione, default = assente = comportamento
//    storico identico (legacy: gen0 al runtime, reinject gen>0 senza Enter);
//  - `false`: la consegna della generazione 0 ha UN SOLO proprietario, il
//    supervisore (paste delimitato SENZA Enter, cancellabile e stage-aware,
//    costruito su securePaste); alle generazioni > 0 non si incolla nulla;
//  - il campo viaggia DENTRO il payload validato restartPrompt come policy
//    `reprompt`, e vale solo per generation > 0;
//  - engine managed: campo sconosciuto -> definizione rifiutata (fail-closed);
//  - round-trip: parse -> define/edit -> reload -> export -> restore;
//  - esiti: pasted = paste-delivered (paste-only NON e' submitted), stadi
//    pre-paste = paste-failed:<stage>, post-paste = delivery-unknown con
//    fermata bounded del supervisore e NESSUN retry;
//  - cancel + settled PRIMA di ogni respawn: nessun task di una gen0 tardiva
//    scrive sulla generazione successiva.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseDefinitions, atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { validPayload } = require('../lib/fleet/cell-exec.js');
const { startGenerationPrompt, main: cellExecMain } = require('../lib/fleet/cell-exec.js');
const { waitDeliveryReport, DELIVERY_STATES } = require('../lib/fleet/prompt-delivery.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

const MIN = () => ({
  schemaVersion: 1,
  engines: [{ id: 'sh', command: '/bin/sh', promptMode: 'send-keys' }],
  cells: [{ id: 'C', cwd: '/tmp', engine: 'sh' }],
});
const withEngine = (engine) => {
  const d = MIN();
  d.engines = [engine];
  return d;
};
const CUSTOM = (extra = {}) => ({ id: 'sh', command: '/bin/sh', promptMode: 'send-keys', ...extra });

// --- 1. validazione della definizione --------------------------------------

test('parse: restartReprompt false su custom send-keys e accettato e conservato al re-parse', () => {
  const d = parseDefinitions(withEngine(CUSTOM({ restartReprompt: false })));
  assert.ok(d, 'opt-in valido');
  assert.equal(d.engines[0].restartReprompt, false);
  const again = parseDefinitions(d);
  assert.ok(again);
  assert.equal(again.engines[0].restartReprompt, false, 'round-trip della definizione');
});

test('parse: campo assente -> NESSUNA chiave aggiunta (legacy identico)', () => {
  const d = parseDefinitions(MIN());
  assert.ok(d);
  assert.equal('restartReprompt' in d.engines[0], false);
});

test('parse: engine managed con restartReprompt rifiuta la definizione (fail-closed)', () => {
  const MANAGED = (extra = {}) => ({
    schemaVersion: 1,
    engines: [{ id: 'kimi.native', managed: { client: 'kimi', provider: 'native', model: '', permissionPolicy: 'standard' }, ...extra }],
    cells: [],
  });
  // controllo positivo: la stessa spec SENZA il campo e' valida
  assert.ok(parseDefinitions(MANAGED()), 'spec managed valida senza il campo');
  // con il campo: rifiuto, mai scarto in silenzio
  assert.equal(parseDefinitions(MANAGED({ restartReprompt: false })), null);
  assert.equal(parseDefinitions(MANAGED({ restartReprompt: true })), null);
});

test('parse: tipo non booleano rifiuta la definizione', () => {
  for (const value of ['no', 1, null, 'false']) {
    assert.equal(parseDefinitions(withEngine(CUSTOM({ restartReprompt: value }))), null,
      `deve rifiutare: ${JSON.stringify(value)}`);
  }
});

test('parse: restartReprompt con promptMode flag rifiuta la definizione', () => {
  const engine = { id: 'sh', command: '/bin/sh', promptMode: 'flag', promptFlag: '-p', restartReprompt: false };
  assert.equal(parseDefinitions(withEngine(engine)), null);
});

test('parse: submit e restartReprompt insieme rifiutati (due policy di consegna non si sommano)', () => {
  for (const value of [false, true]) {
    assert.equal(parseDefinitions(withEngine(CUSTOM({ submit: 'enter', restartReprompt: value }))), null,
      `rifiutato submit+restartReprompt:${value}`);
  }
});

// --- 2. validazione del payload (restartPrompt.reprompt) --------------------

const PAYLOAD_BASE = (restartPrompt) => ({
  command: '/bin/fake', args: [], env: {},
  ...(restartPrompt ? { restartPrompt } : {}),
});

test('validPayload: reprompt false dentro restartPrompt custom e accettato', () => {
  const p = PAYLOAD_BASE({
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0,
    client: '', readyWaitMs: 0, reprompt: false,
  });
  assert.equal(validPayload(p), true);
});

test('validPayload: reprompt true esplicito su custom accettato (il default dichiarato)', () => {
  const p = PAYLOAD_BASE({
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0,
    client: '', readyWaitMs: 0, reprompt: true,
  });
  assert.equal(validPayload(p), true);
});

test('validPayload: reprompt non booleano rifiuta il payload', () => {
  for (const value of ['false', 0, null]) {
    const p = PAYLOAD_BASE({
      tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0,
      client: '', readyWaitMs: 0, reprompt: value,
    });
    assert.equal(validPayload(p), false, `payload rifiutato: reprompt=${JSON.stringify(value)}`);
  }
});

test('validPayload: reprompt su client classificato rifiuta il payload', () => {
  const p = PAYLOAD_BASE({
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0,
    client: 'kimi', readyWaitMs: 0, reprompt: false,
  });
  assert.equal(validPayload(p), false, 'la policy e' + ' dei soli engine custom');
});

test('validPayload: reprompt insieme a submit rifiuta il payload (policy non sommabili)', () => {
  const p = PAYLOAD_BASE({
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0,
    client: '', readyWaitMs: 0, submit: true, reprompt: false,
  });
  assert.equal(validPayload(p), false);
});

// --- 3. supervisore: owner, generazioni, mapping degli stati ---------------

// fakeTmux con opzioni di pane in memoria (produttore -> consumer veri).
function paneOptionsTmux() {
  const options = new Map();
  const argv = [];
  const exec = async (_bin, args) => {
    argv.push(args.join(' '));
    if (args[0] === 'set-option') {
      options.set(`${args[3]} ${args[4]}`, args[5] === undefined ? '' : args[5]);
      return { err: null, stdout: '', stderr: '', code: 0 };
    }
    if (args[0] === 'display-message') {
      const field = args[args.length - 1];
      if (field === '#{@nc_delivery}') {
        return { err: null, stdout: `${options.get(`${args[3]} @nc_delivery`) || ''}\n`, stderr: '', code: 0 };
      }
      if (field.includes('session_name')) return { err: null, stdout: `cloud-T\t0\t%42\n`, stderr: '', code: 0 };
      return { err: null, stdout: `cloud-T\t0\t%42\n`, stderr: '', code: 0 };
    }
    return { err: null, stdout: '', stderr: '', code: 0 };
  };
  return { exec, argv, options };
}

const IMMEDIATE = { setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {} };
const CFG = (extra = {}) => ({
  tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'mandato', readyMs: 0,
  readyWaitMs: 0, client: '', ...extra,
});

test('supervisore: gen0 dell opt-in e del supervisore — un solo paste SENZA Enter, mai injectPrompt', async () => {
  const { exec, argv } = paneOptionsTmux();
  let inject = 0;
  const ctl = startGenerationPrompt(CFG({ reprompt: false }), 0, { exited: false }, {
    ...IMMEDIATE, tmuxExec: exec,
    securePaste: async () => ({ ok: true, stage: 'pasted', paneId: '%42' }),
    injectPrompt: async () => { inject += 1; return { injected: true }; },
  });
  assert.ok(ctl, 'gen0 consegnata dal supervisore');
  const outcome = await ctl.settled;
  assert.equal(outcome, null, 'paste riuscito: nessuna incertezza da propagare');
  assert.equal(inject, 0, 'il percorso legacy injectPrompt non si attiva');
  assert.equal(argv.filter((a) => a.startsWith('send-keys')).length, 0, 'nessun Enter: paste-only');
  assert.equal(argv.filter((a) => a.startsWith('paste-buffer')).length, 0, 'il paste e del seam securePaste, non del ramo legacy');
});

test('supervisore: gen>0 dell opt-in — NESSUN paste e NESSUN injectPrompt', async () => {
  const { exec } = paneOptionsTmux();
  let inject = 0; let pastes = 0;
  for (const generation of [1, 2, 3]) {
    const ctl = startGenerationPrompt(CFG({ reprompt: false }), generation, { exited: false }, {
      ...IMMEDIATE, tmuxExec: exec,
      securePaste: async () => { pastes += 1; return { ok: true, stage: 'pasted', paneId: '%42' }; },
      injectPrompt: async () => { inject += 1; return { injected: true }; },
    });
    await ctl.settled;
  }
  assert.equal(pastes, 0, 'nessun reinvio alle generazioni > 0');
  assert.equal(inject, 0, 'il ramo legacy reinject resta spento per questi engine');
});

test('supervisore: legacy invariato — campo assente: gen0 al runtime, gen>0 reinject senza Enter', async () => {
  const { exec } = paneOptionsTmux();
  const inject = [];
  // gen0: nessuna consegna del supervisore -> null (il runtime e l owner)
  const ctl0 = startGenerationPrompt(CFG(), 0, { exited: false }, {
    ...IMMEDIATE, tmuxExec: exec,
    injectPrompt: async () => { inject.push('gen0'); return { injected: true }; },
  });
  assert.equal(ctl0, null, 'gen0 legacy resta al runtime');
  // gen>0: reinject legacy (paste senza Enter)
  const ctl1 = startGenerationPrompt(CFG(), 1, { exited: false }, {
    ...IMMEDIATE, tmuxExec: exec,
    injectPrompt: async () => { inject.push('gen1'); return { injected: true }; },
  });
  assert.ok(ctl1);
  await ctl1.settled;
  assert.deepEqual(inject, ['gen1'], 'solo il reinject storico, identico a prima');
});

test('supervisore: pasted -> paste-delivered pubblicato bounded; paste-only NON e submitted', async () => {
  const { exec, options } = paneOptionsTmux();
  const target = process.env.TMUX_PANE || '=cloud-T';
  const ctl = startGenerationPrompt(CFG({ reprompt: false }), 0, { exited: false }, {
    ...IMMEDIATE, tmuxExec: exec,
    securePaste: async () => ({ ok: true, stage: 'pasted', paneId: '%42' }),
  });
  await ctl.settled;
  assert.equal(options.get(`${target} @nc_delivery`), 'paste-delivered',
    'esito pubblicato sul canale report');
  assert.ok(DELIVERY_STATES.includes('paste-delivered'), 'stato nell enum chiuso');
  const report = await waitDeliveryReport('tmux', target, {
    env: {}, exec, timeoutMs: 50, pollMs: 10, sleepImpl: async () => {},
  });
  assert.ok(report, 'il consumer legge il report, niente report-timeout');
  assert.equal(report.state, 'paste-delivered');
  assert.equal(report.delivered, false, 'NC non attesta l Enter del guardiano esterno');
});

test('supervisore: fallimento certo pre-paste (load) -> paste-failed:load, la gen0 prosegue senza prompt', async () => {
  const { exec, options } = paneOptionsTmux();
  const target = process.env.TMUX_PANE || '=cloud-T';
  const ctl = startGenerationPrompt(CFG({ reprompt: false }), 0, { exited: false }, {
    ...IMMEDIATE, tmuxExec: exec,
    securePaste: async () => ({ ok: false, stage: 'load', reason: 'buffer non disponibile' }),
  });
  const outcome = await ctl.settled;
  assert.deepEqual(outcome, null, 'pre-paste: esito visibile, nessuna incertezza inventata');
  assert.equal(options.get(`${target} @nc_delivery`), 'paste-failed:load');
  assert.ok(DELIVERY_STATES.includes('paste-failed'), 'stato nell enum chiuso');
  const report = await waitDeliveryReport('tmux', target, {
    env: {}, exec, timeoutMs: 50, pollMs: 10, sleepImpl: async () => {},
  });
  assert.equal(report.state, 'paste-failed', 'il consumer legge paste-failed');
  assert.equal(report.delivered, false);
});

test('supervisore: errore post-paste -> delivery-unknown al main, pubblicato, mai null innocuo', async () => {
  const { exec, options } = paneOptionsTmux();
  const target = process.env.TMUX_PANE || '=cloud-T';
  // (a) lo stage esplicito 'paste' del trasporto: tentativo fatto, esito incerto.
  const ctl = startGenerationPrompt(CFG({ reprompt: false }), 0, { exited: false }, {
    ...IMMEDIATE, tmuxExec: exec,
    securePaste: async () => ({ ok: false, stage: 'paste', reason: 'paste-buffer failed' }),
  });
  const outcome = await ctl.settled;
  assert.deepEqual(outcome, { state: 'delivery-unknown' }, 'l incertezza post-paste si propaga al main');
  // (b) un throw del trasporto non puo' diventare null innocuo: non si puo'
  // provare che il paste non sia partito -> delivery-unknown, fermata bounded.
  const ctl2 = startGenerationPrompt(CFG({ reprompt: false }), 0, { exited: false }, {
    ...IMMEDIATE, tmuxExec: exec,
    securePaste: async () => { throw new Error('boom nel paste'); },
  });
  const outcome2 = await ctl2.settled;
  assert.deepEqual(outcome2, { state: 'delivery-unknown' }, 'mai null innocuo su un trasporto rotto');
  assert.equal(options.get(`${target} @nc_delivery`), 'delivery-unknown', 'pubblicato bounded');
  const report = await waitDeliveryReport('tmux', target, {
    env: {}, exec, timeoutMs: 50, pollMs: 10, sleepImpl: async () => {},
  });
  assert.equal(report.state, 'delivery-unknown', 'il consumer legge l incertezza');
});

test('supervisore: securePaste VERA — load fallito -> paste-failed, paste fallito -> delivery-unknown, mai retry', async () => {
  const { securePaste } = require('../lib/fleet/launch.js');
  // Il trasporto reale con tmux finto: prima chiamata fallisce il load.
  const mkExec = (failures) => {
    const calls = [];
    const exec = async (_bin, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'load-buffer' && failures.load) return { err: new Error('load'), stdout: '', stderr: '', code: 1 };
      if (args[0] === 'paste-buffer' && failures.paste) return { err: new Error('paste'), stdout: '', stderr: '', code: 1 };
      return { err: null, stdout: 'cloud-T\t0\t%42\n', stderr: '', code: 0 };
    };
    return { calls, exec };
  };
  const { calls: c1, exec: e1 } = mkExec({ load: true });
  const r1 = await securePaste('tmux', 'cloud-T', 'p', { exec: e1, isCancelled: () => false });
  assert.equal(r1.ok, false);
  assert.equal(r1.stage, 'load');
  assert.equal(c1.filter((c) => c.startsWith('paste-buffer')).length, 0);

  const { calls: c2, exec: e2 } = mkExec({ paste: true });
  const r2 = await securePaste('tmux', 'cloud-T', 'p', { exec: e2, isCancelled: () => false });
  assert.equal(r2.ok, false);
  assert.equal(r2.stage, 'paste', 'il fallimento post-tentativo resta post-paste');
  assert.equal(c2.filter((c) => c.startsWith('paste-buffer')).length, 1, 'un solo tentativo');
});

test('supervisore: cancellazione durante il load -> nessun paste, buffer pulito, esito pre-paste pulito', async () => {
  const { securePaste } = require('../lib/fleet/launch.js');
  const calls = [];
  let cancelled = false;
  const exec = async (_bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'load-buffer') cancelled = true;
    return { err: null, stdout: 'cloud-T\t0\t%42\n', stderr: '', code: 0 };
  };
  const r = await securePaste('tmux', 'cloud-T', 'p', { exec, isCancelled: () => cancelled });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'cancelled');
  assert.equal(calls.filter((c) => c.startsWith('paste-buffer')).length, 0, 'nessun paste dopo l invalidazione');
  assert.equal(calls.filter((c) => c.startsWith('delete-buffer')).length, 1, 'cleanup del buffer comunque dovuto');
});

// --- 4. fence di generazione: cancel + settled PRIMA del respawn -----------

test('fence: la delivery gen0 annullata non tocca la generazione nuova sullo stesso %N', async () => {
  const effects = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const config = CFG({ reprompt: false });
  const childState = { exited: false };
  const ctl0 = startGenerationPrompt(config, 0, childState, {
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    securePaste: async (bin, session, prompt, opts) => {
      effects.push('paste-gen0');
      await gate;
      if (opts && opts.isCancelled && opts.isCancelled()) { effects.push('stop-gen0'); return { ok: false, stage: 'cancelled' }; }
      effects.push('effetto-gen0');
      return { ok: true, stage: 'pasted' };
    },
  });
  await new Promise((r) => setImmediate(r));
  childState.exited = true;   // la generazione muore con la consegna in volo
  ctl0.cancel();              // il supervisore annulla PRIMA del respawn
  release();
  const outcome0 = await ctl0.settled;
  effects.push('settled-gen0');
  // generazione nuova sul medesimo pane: per la policy, NESSUN paste
  const ctl1 = startGenerationPrompt({ ...config, prompt: 'nuovo' }, 1, { exited: false }, {
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    securePaste: async () => { effects.push('paste-gen1'); return { ok: true, stage: 'pasted' }; },
  });
  await ctl1.settled;
  effects.push('settled-gen1');
  assert.equal(effects.includes('effetto-gen0'), false, 'nessun effetto della consegna vecchia');
  assert.equal(effects.includes('paste-gen1'), false, 'gen>0: nessun reinvio');
  assert.ok(effects.indexOf('settled-gen0') < effects.indexOf('settled-gen1'), 'ordine: vecchia chiusa prima della nuova');
  assert.equal(outcome0, null, 'cancellazione pre-paste: nessuna incertezza inventata');
});

// --- 5. main loop del supervisore: fermata bounded, nessuna gen1 ------------

function supervisorPayload(restartPrompt) {
  return {
    command: '/bin/fake', args: [], env: {},
    supervise: {
      enabled: true, initialReadyMs: 5, restartDelayMs: 5,
      maxRestartDelayMs: 20, resetAfterMs: 100000, rapidWindowMs: 100000, maxRapidRestarts: 10,
    },
    restartPrompt,
  };
}

test('main: esito incerto della gen0 (paste tentato) -> fermata bounded, NESSUNA gen1, un solo paste', async () => {
  const { EventEmitter } = require('node:events');
  const proc = new EventEmitter();
  const errs = [];
  let launches = 0; let pastes = 0;
  const payload = supervisorPayload({
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'mandato', readyMs: 0,
    client: '', readyWaitMs: 0, reprompt: false,
  });
  const code = await cellExecMain(['--socket', '/tmp/x', '--nonce', 'a'.repeat(64)], {
    receivePayload: async () => payload,
    process: proc,
    spawn: () => {
      launches += 1;
      const child = new EventEmitter(); child.kill = () => {};
      setTimeout(() => { child.emit('exit', 1, null); }, 5);
      return child;
    },
    tmuxExec: async () => ({ err: null, stdout: '', stderr: '', code: 0 }),
    securePaste: async () => { pastes += 1; return { ok: false, stage: 'paste', reason: 'paste-buffer failed' }; },
    now: () => 0, monoNow: () => 0, sleep: async () => {},
    setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {},
    writeError: (m) => errs.push(String(m)),
  });
  assert.notEqual(code, 0, 'uscita con errore');
  assert.equal(launches, 1, 'nessuna generazione successiva dopo l esito incerto');
  assert.equal(pastes, 1, 'un solo tentativo, NESSUN retry');
  assert.ok(errs.some((m) => /uncertain prompt delivery/.test(m)), 'messaggio bounded per l operatore');
});

test('main: gen>0 dell opt-in — nessun paste dopo il restart, spawn regolare', async () => {
  const { EventEmitter } = require('node:events');
  const proc = new EventEmitter();
  let launches = 0; let pastes = 0;
  const payload = supervisorPayload({
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'mandato', readyMs: 0,
    client: '', readyWaitMs: 0, reprompt: false,
  });
  const code = await cellExecMain(['--socket', '/tmp/x', '--nonce', 'c'.repeat(64)], {
    receivePayload: async () => payload,
    process: proc,
    spawn: () => {
      launches += 1;
      const child = new EventEmitter(); child.kill = () => { child.emit('exit', 0, null); };
      // gen0 completa la consegna ed esce tardi (oltre la readiness); il
      // restart parte; la gen1 viene fermata dall operatore.
      setTimeout(() => { child.emit('exit', 0, null); }, 50);
      return child;
    },
    tmuxExec: async () => ({ err: null, stdout: '', stderr: '', code: 0 }),
    securePaste: async () => { pastes += 1; return { ok: true, stage: 'pasted', paneId: '%42' }; },
    now: () => 0,
    monoNow: (() => { let t = 0; return () => { t += 100; return t; }; })(),
    sleep: async () => {
      if (launches >= 2) { proc.emit('SIGTERM'); }
    },
    setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {},
    writeError: () => {},
  });
  assert.ok(launches >= 2, 'il restart supervisionato e' + ' partito');
  assert.equal(pastes, 1, 'solo la gen0 incolla: gen>0 senza reinvio');
  assert.equal(code, 0);
});

// --- 6. runtime up(): owner zero-paste, payload del broker ------------------

function customWorld(t, { engineExtra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncreprompt-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'Dev');
  fs.mkdirSync(cwd, { recursive: true });
  const client = path.join(root, 'client');
  fs.writeFileSync(client, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  fs.chmodSync(client, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'client', label: 'Client', rc: false, command: client, args: [], env: {},
      promptMode: 'send-keys', ...engineExtra,
    }],
    cells: [{ id: 'Dev', tmuxSession: 'work-reprompt', cwd, engine: 'client', boot: false, prompt: 'hello\nworld' }],
  });
  const natoFile = path.join(root, 'nato');
  const marker = path.join(root, 'delivery-marker');
  const log = path.join(root, 'tmux.log');
  fs.writeFileSync(log, '');
  const tmuxBin = path.join(root, 'fake-tmux.js');
  fs.writeFileSync(tmuxBin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  if (args.includes('nc-control-open')) process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
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
      n += 1;
      const r = spawnSync(process.execPath, [__filename, '-S', 'sock'].concat(riga.split(/\\s+/)), { encoding: 'utf8' });
      if ((r.status || 0) === 0) process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stdout || '') + '%end 1 ' + n + ' 1\\n');
      else process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stderr || '') + '%error 1 ' + n + ' 1\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
const log = ${JSON.stringify(log)};
const nato = ${JSON.stringify(natoFile)};
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const field = args[args.length - 1];
if (args[0] === 'list-sessions') { if (fs.existsSync(nato)) process.stdout.write('$5\\twork-reprompt\\n'); process.exit(0); }
if (args[0] === 'new-session') { fs.writeFileSync(nato, '1'); process.stdout.write('$5\\t@7\\t%9\\n'); process.exit(0); }
if (args[0] === 'display-message') {
  if (field === '#{session_id}') { process.stdout.write('$5\\n'); process.exit(0); }
  if (field === '#{pane_dead}\\t#{pane_dead_status}\\t#{pane_id}') { process.stdout.write('0\\t\\t%9\\n'); process.exit(0); }
  if (field === '#{session_name}\\t#{pane_dead}\\t#{pane_id}') { process.stdout.write('work-reprompt\\t0\\t%9\\n'); process.exit(0); }
  if (field === '#{@nc_delivery}') {
    let value = '';
    try { value = fs.readFileSync(${JSON.stringify(marker)}, 'utf8').trim(); } catch (_) {}
    process.stdout.write(value + '\\n');
    process.exit(0);
  }
  process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (args[0] === 'kill-session') { try { fs.unlinkSync(nato); } catch (_) {} process.exit(0); }
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, defsPath, tmuxBin, marker, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

async function upWith(t, opts = {}) {
  const w = customWorld(t, opts);
  if (opts.markerValue !== undefined) fs.writeFileSync(w.marker, `${opts.markerValue}\n`);
  let ticket = null;
  const launchBroker = {
    issue: async (payload) => { ticket = payload; return { socketPath: path.join(w.root, 'broker.sock'), nonce: 'b'.repeat(64) }; },
    revoke: async () => {}, close: async () => {},
  };
  const fleet = await createBuiltinFleet({
    home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin,
    ensureTmuxProtection: async () => {}, launchBroker, platform: 'win32', env: {},
    launchReadyMs: 0, sendKeysReadyMs: 0, bootstrapReadyWaitMs: 0,
  });
  t.after(() => fleet.close().catch(() => {}));
  const result = await fleet.up('Dev');
  return { w, result, calls: w.calls(), ticket: () => ticket };
}

test('runtime: custom restartReprompt:false — zero paste/Enter dal runtime, esito letto dal report', async (t) => {
  const { result, calls } = await upWith(t, { engineExtra: { restartReprompt: false }, markerValue: 'paste-delivered' });
  assert.ok(result && result.ok);
  assert.equal(result.prompt.state, 'paste-delivered', 'il runtime riporta l esito del supervisore');
  assert.equal(result.prompt.delivered, false, 'paste-only non e submitted');
  assert.equal(calls.filter((args) => args[0] === 'paste-buffer').length, 0, 'zero paste dal runtime');
  assert.equal(calls.filter((args) => args[0] === 'send-keys').length, 0, 'zero Enter dal runtime');
});

test('runtime: il payload del broker porta reprompt:false DENTRO restartPrompt', async (t) => {
  const { ticket } = await upWith(t, { engineExtra: { restartReprompt: false }, markerValue: 'paste-delivered' });
  const tkt = ticket();
  assert.ok(tkt && tkt.restartPrompt, 'restartPrompt presente nel payload');
  assert.equal(tkt.restartPrompt.reprompt, false, 'la policy viaggia nel payload validato');
});

test('runtime: legacy senza campo — NESSUNA chiave reprompt nel payload', async (t) => {
  const { ticket } = await upWith(t, { markerValue: '' });
  const tkt = ticket();
  assert.ok(tkt.restartPrompt);
  assert.equal('reprompt' in tkt.restartPrompt, false, 'assente = comportamento di oggi');
});

test('runtime: custom restartReprompt:false — il runtime NON digita quando il report manca', async (t) => {
  const { result, calls } = await upWith(t, { engineExtra: { restartReprompt: false } });
  assert.ok(result && result.ok);
  assert.equal(result.prompt.state, 'report-timeout', 'esito onesto senza report');
  assert.equal(calls.filter((args) => args[0] === 'paste-buffer').length, 0, 'mai un paste dal runtime');
  assert.equal(calls.filter((args) => args[0] === 'send-keys').length, 0, 'mai un tasto dal runtime');
});

// --- 7. round-trip di persistenza: API, schema, export/restore --------------

function apiWorld(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncreprompt-api-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'NexusFiles'), { recursive: true });
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  fs.writeFileSync(tmuxBin, `#!${process.execPath}
'use strict';
const args = process.argv.slice(2);
if (args[0] === 'list-sessions') process.exit(0);
if (args[0] === 'display-message') { process.stdout.write('0\\t\\t%9\\n'); process.exit(0); }
if (args[0] === 'capture-pane') { process.stdout.write(''); process.exit(0); }
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, { schemaVersion: 1, engines: [], cells: [] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    home, defsPath,
    async fleet() {
      const f = await createBuiltinFleet({
        home, fleetDefsPath: defsPath, tmuxBin,
        ensureTmuxProtection: async () => {}, platform: 'linux', env: {},
        launchReadyMs: 0, now: () => 0,
      });
      t.after(() => f.close().catch(() => {}));
      return f;
    },
  };
}

test('restore-engines: restartReprompt nel portabile accettato e persistito nel fleet.json', async (t) => {
  const w = apiWorld(t);
  const fleet = await w.fleet();
  const res = await fleet.restoreEngines([{
    id: 'sh', label: 'Shell', rc: false, command: '/bin/sh', args: [],
    envKeys: [], promptMode: 'send-keys', restartReprompt: false,
  }]);
  assert.equal(res.ok, true);
  const defs = loadDefinitions(w.defsPath);
  const sh = defs.engines.find((e) => e.id === 'sh');
  assert.equal(sh.restartReprompt, false, 'il campo sopravvive al restore');
});

test('restore-engines: campo non ammesso fuori schema -> 400', async (t) => {
  const fleet = await apiWorld(t).fleet();
  await assert.rejects(
    () => fleet.restoreEngines([{
      id: 'sh', label: 'Shell', rc: false, command: '/bin/sh', args: [],
      envKeys: [], promptMode: 'send-keys', repromptPolicy: false,
    }]),
    (e) => e.status === 400,
  );
});

test('restore-engines: managed con restartReprompt -> 400', async (t) => {
  const fleet = await apiWorld(t).fleet();
  const SPEC = (id) => ({
    id, label: 'K', rc: false,
    managed: { client: 'kimi', provider: 'native', model: '', permissionPolicy: 'standard' },
  });
  // controllo positivo: lo stesso managed SENZA il campo si ripristina
  // (id non backfillato: niente conflitto con gli engine predefiniti)
  const ok = await fleet.restoreEngines([SPEC('kimi.prova-a')]);
  assert.equal(ok.ok, true);
  await assert.rejects(
    () => fleet.restoreEngines([{ ...SPEC('kimi.prova-b'), restartReprompt: false }]),
    (e) => e.status === 400,
    'engine managed con il campo: definizione rifiutata',
  );
});

test('restore-engines: tipo non booleano -> 400', async (t) => {
  const fleet = await apiWorld(t).fleet();
  await assert.rejects(
    () => fleet.restoreEngines([{
      id: 'sh2', label: 'Shell2', rc: false, command: '/bin/sh', args: [],
      envKeys: [], promptMode: 'send-keys', restartReprompt: 'no',
    }]),
    (e) => e.status === 400,
  );
});

test('edit-engine via API: restartReprompt applicato e rileggetto; valore non booleano -> 400', async (t) => {
  const w = apiWorld(t);
  const fleet = await w.fleet();
  await fleet.restoreEngines([{
    id: 'sh', label: 'Shell', rc: false, command: '/bin/sh', args: [],
    envKeys: [], promptMode: 'send-keys',
  }]);
  const byId = () => loadDefinitions(w.defsPath).engines.find((e) => e.id === 'sh');
  const res = await fleet.editEngine('sh', { restartReprompt: false });
  assert.equal(res.ok, true);
  assert.equal(byId().restartReprompt, false);
  // la vista definitions (reload) lo espone
  const view = fleet.definitions();
  assert.equal(view.engines.find((e) => e.id === 'sh').restartReprompt, false);
  // tipo invalido: rifiuto
  await assert.rejects(
    () => fleet.editEngine('sh', { restartReprompt: 'no' }),
    (e) => e.status === 400,
  );
  assert.equal(byId().restartReprompt, false, 'scritta rifiutata: valore intatto');
  // cancellazione con null: torna al default assente
  const res2 = await fleet.editEngine('sh', { restartReprompt: null });
  assert.equal(res2.ok, true);
  assert.equal('restartReprompt' in byId(), false);
});

test('schema: restartReprompt e un booleano opzionale del custom send-keys', async (t) => {
  const fleet = await apiWorld(t).fleet();
  const s = fleet.schema();
  const engine = s.engine || s.fleet?.engine;
  assert.ok(engine, 'schema engine esposto');
  assert.equal(engine.restartReprompt && engine.restartReprompt.type, 'boolean');
  assert.equal(engine.restartReprompt.required, false);
});

test('backup PWA: portableEngineDefinition porta restartReprompt e il round-trip lo conserva', async () => {
  const { portableEngineDefinition, parseFleetBackup, createFleetBackup } = await import('../frontend/src/lib/fleet-backup.js');
  const engine = {
    id: 'sh', label: 'Shell', rc: false, command: '/bin/sh', args: [],
    envKeys: [], promptMode: 'send-keys', restartReprompt: false,
  };
  const portable = portableEngineDefinition(engine);
  assert.ok(portable);
  assert.equal(portable.restartReprompt, false, 'export: il campo non sparisce');
  const backup = createFleetBackup([], new Set(), [portable], new Set(['sh']), new Date('2026-10-25T00:00:00Z'));
  const parsed = parseFleetBackup(JSON.stringify(backup));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.engines[0].restartReprompt, false, 'restore: il campo torna');
});

test('backup PWA: managed con restartReprompt rifiutato dal parser del backup', async () => {
  const { portableEngineDefinition } = await import('../frontend/src/lib/fleet-backup.js');
  const managed = {
    id: 'kimi.native', label: 'K', rc: false,
    managed: { client: 'kimi', provider: 'native', model: '', permissionPolicy: 'standard' },
  };
  assert.ok(portableEngineDefinition(managed), 'controllo positivo: managed valido senza il campo');
  const out = portableEngineDefinition({ ...managed, restartReprompt: false });
  assert.equal(out, null, 'fail-closed anche lato client');
});
