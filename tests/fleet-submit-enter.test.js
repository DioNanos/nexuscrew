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

// Fixture del canale del record del prompt (consegna supervisionata: il canale
// dedicato e' obbligatorio). Directory effimera per chiamata, lancio fisso.
const fsFx = require('node:fs');
const osFx = require('node:os');
const pathFx = require('node:path');
const FX_DIRS = [];
process.on('exit', () => {
  for (const d of FX_DIRS) { try { fsFx.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});
const fxPromptOutcome = () => {
  const dir = fsFx.mkdtempSync(pathFx.join(osFx.tmpdir(), 'nc-prompt-fx-'));
  FX_DIRS.push(dir);
  return { dir, launchId: '2b3c4d5e6f708192' };
};

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
    readyWaitMs: 1000, tmuxExecImpl: exec, sleepImpl: async () => {}, ...extra,
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
    readyWaitMs: 1000, tmuxExecImpl: exec2, sleepImpl: async () => {},
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

// --- l'opt-in non e' un'attestazione ---------------------------------------
// Il supervisore non deve passare `bracketedPaste: true` perche' la
// definizione contiene `submit: 'enter'`: il valore viene dall'attestatore.
const { startGenerationPrompt } = require('../lib/fleet/cell-exec.js');
const { setBracketedPasteAttestor } = require('../lib/fleet/pane-attestation.js');

function supervisorRun({ attestor = null } = {}) {
  setBracketedPasteAttestor(attestor);
  const seen = [];
  const config = {
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0,
    readyWaitMs: 1000, submit: true,
  };
  const seams = {
    promptOutcome: fxPromptOutcome(),
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

test('supervisore: l opt-in non e la prova del framing', async () => {
  const { seen, config, seams, childState } = supervisorRun();
  try {
    // La generazione 1 e' quella che il supervisore possiede gia' per i
    // custom (la 0 passa al supervisore insieme al resto dell'opt-in).
    const ctl = startGenerationPrompt(config, 1, childState, seams);
    assert.ok(ctl, 'gen>0 di un opt-in e consegnata dal supervisore');
    await ctl.settled;
    assert.deepEqual(seen, [false], 'senza attestazione bracketedPaste resta false');
  } finally { setBracketedPasteAttestor(null); }
});

test('supervisore: con un attestatore esplicito il percorso e ammesso', async () => {
  const { seen, config, seams, childState } = supervisorRun({ attestor: () => ({ attested: true }) });
  try {
    const ctl = startGenerationPrompt(config, 1, childState, seams);
    await ctl.settled;
    assert.deepEqual(seen, [true], 'solo l attestazione apre il percorso');
  } finally { setBracketedPasteAttestor(null); }
});

// --- cancellazione dentro gli stadi del paste e incertezza -----------------
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
  readyWaitMs: 1000, tmuxExecImpl: harness.exec, sleepImpl: async () => {},
  bracketedPaste: true, isCancelled: harness.isCancelled, ...extra,
});

test('cancellazione durante il load -> il paste NON parte', async () => {
  const h = cancelAt(null, (args) => args[0] === 'load-buffer');
  const r = await runWith(h);
  assert.equal(r.state, 'cancelled');
  assert.equal(count(h.calls, 'paste-buffer'), 0, 'nessun paste dopo l invalidazione');
  assert.equal(count(h.calls, 'send-keys'), 0);
});

test('cancellazione dopo il resolve -> nessun load e nessun paste', async () => {
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
    readyWaitMs: 1000, tmuxExecImpl: exec2, sleepImpl: async () => {},
    bracketedPaste: true, isCancelled: () => cancelled,
  });
  assert.equal(r.state, 'cancelled');
  assert.equal(count(calls, 'load-buffer'), 0, 'nessun effetto dopo il resolve');
  assert.equal(count(calls, 'paste-buffer'), 0);
});

test('paste tentato e fallito mentre si cancella -> delivery-unknown, non cancelled', async () => {
  const h = cancelAt(null, (args) => args[0] === 'paste-buffer', { pasteFails: true });
  const r = await runWith(h);
  assert.equal(r.state, 'delivery-unknown', 'l incertezza post-paste non si perde');
  assert.equal(count(h.calls, 'paste-buffer'), 1);
  assert.equal(count(h.calls, 'send-keys'), 0);
});

test('cancellazione durante il cleanup (delete-buffer) -> nessun Enter, incerto', async () => {
  const h = cancelAt(null, (args) => args[0] === 'delete-buffer');
  const r = await runWith(h);
  assert.equal(r.state, 'delivery-unknown');
  assert.equal(count(h.calls, 'paste-buffer'), 1);
  assert.equal(count(h.calls, 'send-keys'), 0, 'mai Enter dopo l invalidazione');
});

test('il bootstrap riceve lo stesso predicato (paste non parte dopo il load)', async () => {
  const { deliverBootstrapPrompt } = require('../lib/fleet/prompt-delivery.js');
  const { CLAUDE_ATTRS_EMPTY, SIM_CLAUDE_CONTRACT } = require('./helpers/composer-fixtures.js');
  const { calls, exec } = fakeTmux({});
  let cancelled = false;
  const exec2 = async (bin, args) => {
    const result = await exec(bin, args);
    if (args[0] === 'load-buffer') cancelled = true;
    return result;
  };
  const r = await deliverBootstrapPrompt({
    tmuxBin: 'tmux', session: 'cloud-T', prompt: 'boot', client: 'claude',
    readyWaitMs: 1000, tmuxExecImpl: exec2, sleepImpl: async () => {},
    captureImpl: async () => '❯\n', isCancelled: () => cancelled,
    captureAttrsImpl: async () => CLAUDE_ATTRS_EMPTY, composerContract: SIM_CLAUDE_CONTRACT,
  });
  assert.equal(r.state, 'cancelled');
  assert.equal(count(calls, 'paste-buffer'), 0, 'bootstrap: nessun paste dopo l invalidazione');
});

test('il supervisore conserva l incertezza anche se il figlio e gia morto', async () => {
  // Un paste tentato resta incerto: l'esito attraversa l'uscita del child e
  // arriva al loop principale, che su delivery-unknown non riavvia.
  for (const state of ['delivery-unknown', 'staged-not-submitted']) {
    const seen = [];
    const config = { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0, readyWaitMs: 1000, submit: true };
    const childState = { exited: false };
    const ctl = startGenerationPrompt(config, 1, childState, {
      promptOutcome: fxPromptOutcome(),
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout: () => {},
      submitPromptWithEnter: async () => { childState.exited = true; seen.push(state); return { delivered: false, state }; },
    });
    const outcome = await ctl.settled;
    assert.deepEqual(seen, [state], `${state}: consegna tentata una volta`);
    assert.deepEqual(outcome, { state }, `${state}: l esito incerto sopravvive all uscita del figlio`);
  }
});

// --- un solo proprietario e fence di generazione ---------------------------
test('la generazione 0 di un opt-in e del supervisore (un solo proprietario)', async () => {
  for (const generation of [0, 1]) {
    const seen = [];
    const config = { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0, readyWaitMs: 1000, submit: true };
    const ctl = startGenerationPrompt(config, generation, { exited: false }, {
      promptOutcome: fxPromptOutcome(),
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout: () => {},
      submitPromptWithEnter: async () => { seen.push(generation); return { delivered: false, state: 'transport-unsupported' }; },
    });
    assert.ok(ctl, `generazione ${generation}: consegnata dal supervisore`);
    await ctl.settled;
    assert.deepEqual(seen, [generation], `generazione ${generation}: una sola consegna`);
  }
});

test('fence: la delivery della generazione vecchia non tocca la nuova sul medesimo %N', async () => {
  // Barrier: la consegna di gen0 e' ferma DENTRO il paste quando il child
  // muore. cancel() deve fermarla e settled deve risolvere PRIMA che gen1
  // parta: nessun testo/Enter vecchio sulla generazione nuova.
  const { EventEmitter } = require('node:events');
  const effects = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const config = { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'vecchio', readyMs: 0, readyWaitMs: 60000, submit: true };
  const childState = { exited: false };
  const fxCanaleFence = fxPromptOutcome();
  const ctl0 = startGenerationPrompt(config, 0, childState, {
    promptOutcome: fxCanaleFence,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    submitPromptWithEnter: async (opts) => {
      effects.push('paste-vecchio');
      // Attende il permesso, ma rispetta la cancellazione come fa il nucleo.
      await gate;
      if (opts.isCancelled && opts.isCancelled()) { effects.push('stop-vecchio'); return { delivered: false, state: 'cancelled' }; }
      effects.push('enter-vecchio');
      return { delivered: true, state: 'submitted' };
    },
  });
  await new Promise((r) => setImmediate(r));
  childState.exited = true;        // il child muore
  ctl0.cancel();                    // il supervisore annulla PRIMA del respawn
  release();
  const outcome0 = await ctl0.settled;
  // gen1 sullo stesso pane
  const ctl1 = startGenerationPrompt({ ...config, prompt: 'nuovo' }, 1, { exited: false }, {
    promptOutcome: fxCanaleFence,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    submitPromptWithEnter: async () => { effects.push('consegna-nuova'); return { delivered: true, state: 'submitted' }; },
  });
  await ctl1.settled;
  assert.equal(effects.includes('enter-vecchio'), false, 'nessun Enter della generazione vecchia');
  assert.equal(effects.filter((e) => e === 'consegna-nuova').length, 1, 'una sola consegna nuova (nessun doppio bootstrap)');
  assert.ok(outcome0 === null || !outcome0.state || outcome0.state === 'cancelled',
    'pre-paste cancellato: nessuna incertezza inventata');
});

// --- R01: il report del ramo custom deve arrivare al consumer --------------
// Il difetto: il supervisore azzerava e pubblicava solo nel ramo classificato,
// quindi `up()` arrivava alla propria deadline e ripiegava su report-timeout
// invece di leggere transport-unsupported. Qui il produttore e il consumer
// sono QUELLI VERI e condividono lo stesso tmux (finto, in memoria): se il
// produttore non scrive, il consumer non legge — nessun valore precaricato.
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
        const value = options.get(`${args[3]} @nc_delivery`) || '';
        return { err: null, stdout: `${value}\n`, stderr: '', code: 0 };
      }
      return { err: null, stdout: '', stderr: '', code: 0 };
    }
    return { err: null, stdout: '', stderr: '', code: 0 };
  };
  return { exec, argv, options };
}

test('R01: il ramo custom pubblica il report e il consumer lo legge davvero', async () => {
  const { waitDeliveryReport } = require('../lib/fleet/prompt-delivery.js');
  const { exec, argv, options } = paneOptionsTmux();
  // Nessuna attestazione (default di produzione): l'esito e' il rifiuto.
  const target = process.env.TMUX_PANE || '=cloud-T';
  const ctl = startGenerationPrompt(
    { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0, readyWaitMs: 1000, submit: true },
    0,
    { exited: false },
    { promptOutcome: fxPromptOutcome(), setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {}, tmuxExec: exec },
  );
  assert.ok(ctl, 'la generazione 0 del opt-in e del supervisore');
  await ctl.settled;

  // Il produttore ha scritto l'opzione di pane?
  assert.equal(options.get(`${target} @nc_delivery`), 'transport-unsupported',
    'il ramo custom deve pubblicare il proprio esito, non lasciare il pane muto');

  // E il consumer VERO legge quello che il produttore ha scritto.
  const report = await waitDeliveryReport('tmux', target, {
    env: {}, exec, timeoutMs: 50, pollMs: 10, sleepImpl: async () => {},
  });
  assert.ok(report, 'waitDeliveryReport deve leggere il report (niente report-timeout)');
  assert.equal(report.state, 'transport-unsupported');
  assert.equal(report.delivered, false);

  // Rifiuto = zero digitazione, e nessun comando di consegna e' stato emesso.
  for (const prefix of ['load-buffer', 'paste-buffer', 'send-keys']) {
    assert.equal(argv.filter((a) => a.startsWith(prefix)).length, 0, `zero ${prefix}`);
  }
});

test('R01: un esito incerto viene pubblicato e resta bloccante', async () => {
  const { exec, options } = paneOptionsTmux();
  const target = process.env.TMUX_PANE || '=cloud-T';
  const ctl = startGenerationPrompt(
    { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0, readyWaitMs: 1000, submit: true },
    1,
    { exited: false },
    {
      promptOutcome: fxPromptOutcome(),
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout: () => {},
      tmuxExec: exec,
      submitPromptWithEnter: async () => ({ delivered: false, state: 'delivery-unknown' }),
    },
  );
  const outcome = await ctl.settled;
  assert.equal(options.get(`${target} @nc_delivery`), 'delivery-unknown', 'pubblicato come enum bounded');
  assert.deepEqual(outcome, { state: 'delivery-unknown' }, 'e conservato per il loop principale');
});

test('R01: un esito di generazione invalidata non diventa l esito della nuova', async () => {
  const { exec, options } = paneOptionsTmux();
  const target = process.env.TMUX_PANE || '=cloud-T';
  const childState = { exited: false };
  const ctl = startGenerationPrompt(
    { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0, readyWaitMs: 1000, submit: true },
    0,
    childState,
    {
      promptOutcome: fxPromptOutcome(),
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout: () => {},
      tmuxExec: exec,
      submitPromptWithEnter: async () => {
        childState.exited = true;                       // la generazione muore durante la consegna
        return { delivered: false, state: 'delivery-unknown' };
      },
    },
  );
  const outcome = await ctl.settled;
  // L'azzeramento iniziale c'e' (pulisce l'esito della generazione
  // precedente), ma nessun ESITO viene pubblicato per una generazione che non
  // c'e' piu'.
  assert.equal(options.get(`${target} @nc_delivery`), '',
    'nessun esito sul pane di una generazione che non c e piu');
  assert.deepEqual(outcome, { state: 'delivery-unknown' }, 'ma l incertezza interna si conserva');
});

// --- R02: la cancellazione non deve disabilitare il cleanup ---------------
// Se il load e' riuscito, il buffer nominato esiste NEL SERVER tmux con dentro
// il prompt: la cancellazione vieta il paste, non il cleanup. Prima il flag
// `loaded` veniva alzato DOPO il controllo di cancellazione, quindi l'uscita
// anticipata lasciava il buffer nel server.
test('R02: cancellazione durante il load -> il buffer tmux viene comunque cancellato', async () => {
  const h = cancelAt(null, (args) => args[0] === 'load-buffer');
  const r = await runWith(h);
  assert.equal(r.state, 'cancelled');
  assert.equal(count(h.calls, 'paste-buffer'), 0, 'nessun paste dopo l invalidazione');
  assert.equal(count(h.calls, 'delete-buffer'), 1, 'il buffer caricato si cancella comunque');
  assert.match(h.calls.find((c) => c.startsWith('delete-buffer')), /-b ncstage-[a-f0-9]{16}/);
});

test('R02: il bootstrap cancella il buffer dopo una cancellazione durante il load', async () => {
  const { deliverBootstrapPrompt } = require('../lib/fleet/prompt-delivery.js');
  const { CLAUDE_ATTRS_EMPTY, SIM_CLAUDE_CONTRACT } = require('./helpers/composer-fixtures.js');
  const { calls, exec } = fakeTmux({});
  let cancelled = false;
  const exec2 = async (bin, args) => {
    const result = await exec(bin, args);
    if (args[0] === 'load-buffer') cancelled = true;
    return result;
  };
  const r = await deliverBootstrapPrompt({
    tmuxBin: 'tmux', session: 'cloud-T', prompt: 'boot', client: 'claude',
    readyWaitMs: 1000, tmuxExecImpl: exec2, sleepImpl: async () => {},
    captureImpl: async () => '❯\n', isCancelled: () => cancelled,
    captureAttrsImpl: async () => CLAUDE_ATTRS_EMPTY, composerContract: SIM_CLAUDE_CONTRACT,
  });
  assert.equal(r.state, 'cancelled');
  assert.equal(count(calls, 'paste-buffer'), 0);
  assert.equal(count(calls, 'delete-buffer'), 1, 'bootstrap: stesso cleanup');
});

test('R02: successo e errore del load restano coerenti sul cleanup', async () => {
  // successo normale: un load, un paste, un Enter, un delete
  const ok = submit({}, { bracketedPaste: true });
  const r1 = await ok.run();
  assert.equal(r1.state, 'submitted');
  assert.equal(count(ok.calls, 'delete-buffer'), 1, 'successo: buffer cancellato');

  // load fallito: nessun buffer creato, nessun delete da fare
  const bad = submit({ loadFails: true }, { bracketedPaste: true });
  const r2 = await bad.run();
  assert.equal(r2.state, 'failed-pre-paste');
  assert.equal(count(bad.calls, 'load-buffer'), 2);
  assert.equal(count(bad.calls, 'delete-buffer'), 0, 'load fallito: niente da cancellare');

  // cancellazione PRIMA del load: nessun buffer e nessun delete
  const early = submit({}, { bracketedPaste: true, isCancelled: () => true });
  const r3 = await early.run();
  assert.equal(r3.state, 'cancelled');
  assert.equal(count(early.calls, 'load-buffer'), 0);
  assert.equal(count(early.calls, 'delete-buffer'), 0);
});
