'use strict';
// R3 — il terminale durevole di una consegna scaduta deve portare il limite di
// ammissione: il flag che lo dice non si perde nella canonicalizzazione, e un
// terminale che conclude DOPO la scadenza resta un record valido (il ts del
// terminale e' successivo al limite per costruzione).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  canonicalOutcome, validPromptRecord, VERSIONE_RECORD_PROMPT, EVENTO_RECORD_PROMPT,
} = require('../lib/fleet/prompt-outcome.js');
const { startGenerationPrompt } = require('../lib/fleet/cell-exec.js');

test('R3: la canonicalizzazione resta chiusa e la scadenza non ci entra', () => {
  // La scadenza NON e' una chiave dello schema canonico: se entrasse
  // nell'oggetto, la tabella esaustiva dei record la rifiuterebbe come campo
  // fuori catalogo. Il flag viaggia come argomento del publisher, che e' il
  // solo a sapere quale limite ha rifiutato la consegna.
  const c = canonicalOutcome({
    state: 'skipped-not-ready', notReady: 'busy',
    deadlineExceeded: true, deadlinePhase: 'capture',
  });
  assert.equal(c.state, 'skipped');
  assert.equal(c.reason, 'deadline-exceeded');
  assert.equal(c.notReady, 'busy');
  assert.equal(c.deadlinePhase, 'capture');
  assert.deepEqual(Object.keys(c).sort(),
    ['deadlinePhase', 'notReady', 'reason', 'state'], 'chiavi fuori schema nel canonico');
});

test('R3: un terminale dopo la scadenza e\' un record valido; un pending no', () => {
  const base = {
    version: VERSIONE_RECORD_PROMPT, event: EVENTO_RECORD_PROMPT,
    launchId: '1a2b3c4d5e6f7788', generation: 0,
  };
  const terminale = {
    ...base, state: 'skipped', reason: 'deadline-exceeded', notReady: 'busy',
    deadlinePhase: 'capture', ts: 2001, deadlineTs: 2000,
  };
  assert.equal(validPromptRecord(terminale), true, 'terminale dopo il limite rifiutato');
  const pending = { ...base, state: 'pending', ts: 2001, deadlineTs: 2000 };
  assert.equal(validPromptRecord(pending), false, 'pending oltre il proprio limite accettato');
  const pendingOk = { ...base, state: 'pending', ts: 2000, deadlineTs: 2000 };
  assert.equal(validPromptRecord(pendingOk), true);
});

test('R3: il terminale scritto dal supervisore porta deadlineTs e resta leggibile', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-prompt-deadline-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  const launchId = '1a2b3c4d5e6f7788';
  let wall = 1_700_000_000_000;
  const mono = 1000;
  const s = {
    promptOutcome: { dir, launchId },
    setTimeout: (fn) => { queueMicrotask(() => { try { fn(); } catch (_) {} }); return { unref() {} }; },
    clearTimeout: () => {},
    deliverBootstrapPrompt: async () => {
      // Il tempo passa: la conclusione arriva DOPO il limite di ammissione.
      wall += 5000;
      return {
        delivered: false, state: 'skipped-not-ready', notReady: 'busy', attempts: 0,
        deadlineExceeded: true, deadlinePhase: 'capture',
      };
    },
    tmuxExec: async () => ({ err: null, stdout: '', stderr: '', code: 0 }),
    wallNowImpl: () => wall,
    monoNowImpl: () => mono,
  };
  const ctl = startGenerationPrompt({
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', client: 'claude', readyMs: 1,
    readyWaitMs: 1000,
  }, 0, { exited: false }, s);
  await ctl.settled;
  const file = path.join(dir, `prompt-${launchId}.json`);
  assert.ok(fs.existsSync(file), 'terminale non scritto');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.state, 'skipped', JSON.stringify(record));
  assert.equal(record.reason, 'deadline-exceeded');
  assert.equal(Number.isFinite(record.deadlineTs), true, 'deadlineTs assente nel terminale durevole');
  assert.equal(record.deadlinePhase, 'capture');
  // Il terminale conclude quando il tempo e' passato oltre il limite: il ts
  // civile puo' superarlo, ed e' comunque un record valido.
  assert.ok(record.ts >= record.deadlineTs, 'ts prima del limite dichiarato');
  assert.equal(validPromptRecord(record), true, JSON.stringify(record));
});
