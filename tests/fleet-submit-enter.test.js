'use strict';
// DELIVERY of the opt-in `enter` submit for custom engines with promptMode
// 'send-keys': one delimited paste, ONE Enter on the same %N, no retry after a
// paste attempt, no degradation to raw keystrokes. The definition validation
// lives in fleet-submit-enter-validate.test.js.
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

// --- E02: l'opt-in non e' un'attestazione --------------------------------
// Il supervisore non deve passare `bracketedPaste: true` perche' la
// definizione contiene `submit: 'enter'`: il valore viene dall'attestatore.
const { startGenerationPrompt } = require('../lib/fleet/cell-exec.js');
const { setBracketedPasteAttestor } = require('../lib/fleet/pane-attestation.js');

function supervisorRun({ attestor = null } = {}) {
  setBracketedPasteAttestor(attestor);
  const seen = [];
  const config = {
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0,
    readyWaitMs: 0, submit: true,
  };
  const seams = {
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    submitPromptWithEnter: async (opts) => {
      seen.push(opts.bracketedPaste);
      return { delivered: false, state: opts.bracketedPaste ? 'submitted' : 'transport-unsupported' };
    },
  };
  const childState = { exited: false };
  return { seen, config, seams, childState };
}

test('E02: il supervisore non usa l opt-in come prova del framing', async () => {
  const { seen, config, seams, childState } = supervisorRun();
  try {
    // La generazione 1 e' quella che il supervisore possiede gia' per i
    // custom (la 0 passa al supervisore col rilievo E04).
    const ctl = startGenerationPrompt(config, 1, childState, seams);
    assert.ok(ctl, 'gen>0 di un opt-in e consegnata dal supervisore');
    await ctl.settled;
    assert.deepEqual(seen, [false], 'senza attestazione bracketedPaste resta false');
  } finally { setBracketedPasteAttestor(null); }
});

test('E02: con un attestatore esplicito il supervisore ammette il percorso', async () => {
  const { seen, config, seams, childState } = supervisorRun({ attestor: () => ({ attested: true }) });
  try {
    const ctl = startGenerationPrompt(config, 1, childState, seams);
    await ctl.settled;
    assert.deepEqual(seen, [true], 'solo l attestazione apre il percorso');
  } finally { setBracketedPasteAttestor(null); }
});

// --- E03: cancellazione dentro gli stadi del paste e incertezza ------------
// Il predicato deve arrivare DENTRO securePaste (resolve, load, paste): se la
// generazione finisce durante il load, il paste non deve partire. E da quando
// il paste e' tentato l'incertezza non si perde mai, nemmeno su errore,
// cancellazione o cleanup.
function cancelAt(calls, when, script = {}) {
  const { calls: log, exec } = fakeTmux(script);
  let cancelled = false;
  const exec2 = async (bin, args) => {
    const result = await exec(bin, args);
    if (when(args)) cancelled = true;
    return result;
  };
  return { calls: log, exec: exec2, isCancelled: () => cancelled, cancelledAt: () => cancelled };
}

const runWith = (harness, extra = {}) => submitPromptWithEnter({
  tmuxBin: 'tmux', session: 'cloud-T', prompt: 'p', env: {},
  readyWaitMs: 0, tmuxExecImpl: harness.exec, sleepImpl: async () => {},
  bracketedPaste: true, isCancelled: harness.isCancelled, ...extra,
});

test('E03: cancellazione durante il load -> il paste NON parte', async () => {
  const h = cancelAt(null, (args) => args[0] === 'load-buffer');
  const r = await runWith(h);
  assert.equal(r.state, 'cancelled');
  assert.equal(count(h.calls, 'paste-buffer'), 0, 'nessun paste dopo l invalidazione');
  assert.equal(count(h.calls, 'send-keys'), 0);
});

test('E03: cancellazione dopo il resolve -> nessun load e nessun paste', async () => {
  let seenResolve = 0;
  const { calls, exec } = fakeTmux({});
  let cancelled = false;
  const exec2 = async (bin, args) => {
    const result = await exec(bin, args);
    if (args[0] === 'display-message') { seenResolve += 1; if (seenResolve >= 1) cancelled = true; }
    return result;
  };
  const r = await submitPromptWithEnter({
    tmuxBin: 'tmux', session: 'cloud-T', prompt: 'p', env: {},
    readyWaitMs: 0, tmuxExecImpl: exec2, sleepImpl: async () => {},
    bracketedPaste: true, isCancelled: () => cancelled,
  });
  assert.equal(r.state, 'cancelled');
  assert.equal(count(calls, 'load-buffer'), 0, 'nessun effetto dopo il resolve');
  assert.equal(count(calls, 'paste-buffer'), 0);
});

test('E03: paste tentato e fallito mentre si cancella -> delivery-unknown, non cancelled', async () => {
  const h = cancelAt(null, (args) => args[0] === 'paste-buffer', { pasteFails: true });
  const r = await runWith(h);
  assert.equal(r.state, 'delivery-unknown', 'l incertezza post-paste non si perde');
  assert.equal(count(h.calls, 'paste-buffer'), 1);
  assert.equal(count(h.calls, 'send-keys'), 0);
});

test('E03: cancellazione durante il cleanup (delete-buffer) -> nessun Enter, incerto', async () => {
  const h = cancelAt(null, (args) => args[0] === 'delete-buffer');
  const r = await runWith(h);
  assert.equal(r.state, 'delivery-unknown');
  assert.equal(count(h.calls, 'paste-buffer'), 1);
  assert.equal(count(h.calls, 'send-keys'), 0, 'mai Enter dopo l invalidazione');
});

test('E03: il bootstrap riceve lo stesso predicato (paste non parte dopo il load)', async () => {
  const { deliverBootstrapPrompt } = require('../lib/fleet/prompt-delivery.js');
  const { calls, exec } = fakeTmux({});
  let cancelled = false;
  const exec2 = async (bin, args) => {
    const result = await exec(bin, args);
    if (args[0] === 'load-buffer') cancelled = true;
    return result;
  };
  const r = await deliverBootstrapPrompt({
    tmuxBin: 'tmux', session: 'cloud-T', prompt: 'boot', client: 'claude',
    readyWaitMs: 0, tmuxExecImpl: exec2, sleepImpl: async () => {},
    captureImpl: async () => '❯\n', isCancelled: () => cancelled,
  });
  assert.equal(r.state, 'cancelled');
  assert.equal(count(calls, 'paste-buffer'), 0, 'bootstrap: nessun paste dopo l invalidazione');
});

test('E03: il supervisore conserva l incertezza anche se il figlio e gia morto', async () => {
  // Un paste tentato resta incerto: l'esito attraversa l'uscita del child e
  // arriva al loop principale, che su delivery-unknown non riavvia.
  for (const state of ['delivery-unknown', 'staged-not-submitted']) {
    const seen = [];
    const config = { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0, readyWaitMs: 0, submit: true };
    const childState = { exited: false };
    const ctl = startGenerationPrompt(config, 1, childState, {
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout: () => {},
      submitPromptWithEnter: async () => { childState.exited = true; seen.push(state); return { delivered: false, state }; },
    });
    const outcome = await ctl.settled;
    assert.deepEqual(seen, [state], `${state}: consegna tentata una volta`);
    assert.deepEqual(outcome, { state }, `${state}: l esito incerto sopravvive all uscita del figlio`);
  }
});
