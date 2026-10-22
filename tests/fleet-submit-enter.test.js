'use strict';
// F4 (piano 2026-10-22_DEVAUDITOR_PIANO_VL_STRATO3) — CONSEGNA del submit
// opt-in `enter` per gli engine custom con promptMode 'send-keys': un solo
// paste delimitato, UN solo Enter sullo stesso %N, nessun retry dopo un paste
// tentato, nessun degrado a testo grezzo. La validazione della definizione sta
// in fleet-submit-enter-validate.test.js.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  submitPromptWithEnter, DELIVERY_STATES,
} = require('../lib/fleet/prompt-delivery.js');

// --- 2. consegna at-most-once ----------------------------------------------

// fakeTmux: stesso formato di output del vero resolveSessionPane
// (session_name \t pane_dead \t pane_id). `script` permette di far fallire un
// comando o di cambiare il %N alla seconda risoluzione.
function fakeTmux(script = {}) {
  const calls = [];
  let resolutions = 0;
  const exec = async (bin, args) => {
    calls.push(args.join(' '));
    const cmd = args[0];
    if (cmd === 'display-message') {
      resolutions += 1;
      const pane = script.paneSequence ? script.paneSequence[Math.min(resolutions - 1, script.paneSequence.length - 1)] : '%42';
      if (pane === null) return { err: new Error('no pane'), stdout: '', stderr: '', code: 1 };
      return { err: null, stdout: `${script.sessionName || 'cloud-T'}\t0\t${pane}\n`, stderr: '', code: 0 };
    }
    if (cmd === 'load-buffer' && script.loadFailsFirst && !script._loadFailed) {
      script._loadFailed = true;
      return { err: new Error('load'), stdout: '', stderr: '', code: 1 };
    }
    if (cmd === 'load-buffer' && script.loadFails) return { err: new Error('load'), stdout: '', stderr: '', code: 1 };
    if (cmd === 'paste-buffer' && script.pasteFails) return { err: new Error('paste'), stdout: '', stderr: '', code: 1 };
    if (cmd === 'send-keys' && script.enterFails) return { err: new Error('enter'), stdout: '', stderr: '', code: 1 };
    return { err: null, stdout: '', stderr: '', code: 0 };
  };
  return { calls, exec };
}

const submit = (script, extra = {}) => {
  const { calls, exec } = fakeTmux(script);
  return { calls, run: () => submitPromptWithEnter({
    tmuxBin: 'tmux', session: 'cloud-T', prompt: 'boot prompt', env: {},
    readyWaitMs: 0, tmuxExecImpl: exec, sleepImpl: async () => {}, ...extra,
  }) };
};
const count = (calls, prefix) => calls.filter((c) => c.startsWith(prefix)).length;

test('consegna: opt-in -> UN paste delimitato e UN Enter sullo stesso %N', async () => {
  const { calls, run } = submit({}, { bracketedPaste: true });
  const r = await run();
  assert.equal(r.delivered, true);
  assert.equal(r.state, 'submitted');
  assert.equal(r.reason, 'submitted', 'reason = state (enum chiuso)');
  assert.equal(r.attempts, 1);
  assert.equal(count(calls, 'load-buffer'), 1);
  assert.equal(count(calls, 'paste-buffer -p'), 1, 'un solo paste, e delimitato (-p)');
  assert.equal(count(calls, 'send-keys -t %42 Enter'), 1, 'un solo Enter sul %N risolto');
  assert.ok(!calls.some((c) => c.includes('boot prompt')), 'testo mai in argv tmux');
  assert.equal(calls.filter((c) => c.startsWith('send-keys') && c.includes(' -l')).length, 0,
    'nessun ripiego a tasti grezzi');
});

test('consegna: prompt multilinea -> un solo paste, un solo Enter (LF mai inviato come tasto)', async () => {
  const { calls, run } = submit({}, { bracketedPaste: true, prompt: 'riga1\nriga2\n\triga3' });
  const r = await run();
  assert.equal(r.state, 'submitted');
  assert.equal(count(calls, 'paste-buffer'), 1);
  assert.equal(count(calls, 'send-keys'), 1, 'un solo send-keys: Enter');
  assert.equal(count(calls, 'send-keys -t %42 Enter'), 1);
});

test('consegna: pane cambiato prima dell\'Enter -> nessun Enter, esito incerto', async () => {
  const { calls, run } = submit({ paneSequence: ['%42', '%42', '%43'] }, { bracketedPaste: true });
  const r = await run();
  assert.equal(r.delivered, false);
  assert.equal(r.state, 'delivery-unknown');
  assert.equal(count(calls, 'paste-buffer'), 1, 'il paste c\'e stato: zero secondo paste');
  assert.equal(count(calls, 'send-keys'), 0, 'mai Enter su un altro pane/generazione');
});

test('consegna: paste fallito -> delivery-unknown, zero secondo paste e zero Enter', async () => {
  const { calls, run } = submit({ pasteFails: true }, { bracketedPaste: true });
  const r = await run();
  assert.equal(r.state, 'delivery-unknown');
  assert.equal(r.attempts, 1);
  assert.equal(count(calls, 'paste-buffer'), 1);
  assert.equal(count(calls, 'send-keys'), 0);
});

test('consegna: Enter fallito dopo paste ok -> staged-not-submitted, nessun replay', async () => {
  const { calls, run } = submit({ enterFails: true }, { bracketedPaste: true });
  const r = await run();
  assert.equal(r.state, 'staged-not-submitted');
  assert.equal(r.delivered, false);
  assert.equal(count(calls, 'paste-buffer'), 1);
  assert.equal(count(calls, 'send-keys'), 1);
});

test('consegna: cancellazione PRIMA del paste -> cancelled, zero paste/Enter', async () => {
  const { calls, run } = submit({}, { bracketedPaste: true, isCancelled: () => true });
  const r = await run();
  assert.equal(r.state, 'cancelled');
  assert.equal(count(calls, 'paste-buffer'), 0);
  assert.equal(count(calls, 'send-keys'), 0);
});

test('consegna: cancellazione DOPO il paste -> nessun Enter, esito incerto', async () => {
  // Il flag si alza durante il paste (a ogni await successivo e' valutato).
  let cancelled = false;
  const { calls, exec } = fakeTmux({});
  const exec2 = async (bin, args) => {
    const r = await exec(bin, args);
    if (args[0] === 'paste-buffer') cancelled = true;
    return r;
  };
  const r = await submitPromptWithEnter({
    tmuxBin: 'tmux', session: 'cloud-T', prompt: 'p', env: {},
    readyWaitMs: 0, tmuxExecImpl: exec2, sleepImpl: async () => {},
    bracketedPaste: true, isCancelled: () => cancelled,
  });
  assert.equal(r.state, 'delivery-unknown');
  assert.equal(count(calls, 'paste-buffer'), 1);
  assert.equal(count(calls, 'send-keys'), 0, 'mai un Enter dopo una cancellazione');
});

test('consegna: retry SOLO su fallimento certo pre-paste (load), poi un solo paste', async () => {
  const { calls, run } = submit({ loadFailsFirst: true }, { bracketedPaste: true });
  const r = await run();
  assert.equal(r.state, 'submitted');
  assert.equal(r.attempts, 2);
  assert.equal(count(calls, 'load-buffer'), 2);
  assert.equal(count(calls, 'paste-buffer'), 1);
  assert.equal(count(calls, 'send-keys'), 1);
});

test('consegna: load sempre fallito -> failed-pre-paste, zero paste', async () => {
  const { calls, run } = submit({ loadFails: true }, { bracketedPaste: true });
  const r = await run();
  assert.equal(r.state, 'failed-pre-paste');
  assert.equal(r.attempts, 2);
  assert.equal(count(calls, 'paste-buffer'), 0);
});

test('consegna: trasporto non attestato -> transport-unsupported, ZERO comandi tmux', async () => {
  for (const extra of [{}, { bracketedPaste: false }, { bracketedPaste: 'enter' }]) {
    const { calls, run } = submit({}, extra);
    const r = await run();
    assert.equal(r.state, 'transport-unsupported');
    assert.equal(r.delivered, false);
    assert.equal(calls.length, 0, 'nessun paste, nessun Enter, nessun testo grezzo');
  }
});

test('consegna: prompt con byte di controllo -> prompt-rejected, zero paste', async () => {
  const { calls, run } = submit({}, { bracketedPaste: true, prompt: 'a\u001b[200~b' });
  const r = await run();
  assert.equal(r.state, 'prompt-rejected');
  assert.equal(calls.length, 0);
});

test('consegna: readiness di trasporto bounded — pane mai risolvibile', async () => {
  const { calls, run } = submit({ paneSequence: [null] }, {
    bracketedPaste: true, readyWaitMs: 100, pollMs: 50,
  });
  const r = await run();
  assert.equal(r.state, 'failed-pre-paste');
  assert.equal(r.attempts, 0);
  assert.equal(count(calls, 'paste-buffer'), 0);
});

test('consegna: nessun retry dopo un esito incerto, anche se il pane torna', async () => {
  // paste ok, poi il pane sparisce alla riverifica: un solo paste, zero Enter,
  // e nessun secondo tentativo anche con un pane di nuovo disponibile.
  const { calls, run } = submit({ paneSequence: ['%42', '%42', null] }, { bracketedPaste: true });
  const r = await run();
  assert.equal(r.state, 'delivery-unknown');
  assert.equal(count(calls, 'paste-buffer'), 1);
  assert.equal(count(calls, 'send-keys'), 0);
});
