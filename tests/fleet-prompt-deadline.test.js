'use strict';
// 0.9.80 strato 2a — guardie di consegna sulla deadline (C7):
//  - la deadline si controlla DOPO ogni await, prima di accettare ready o di
//    proseguire verso il paste (capture tardivo, gate MCP, readyWaitMs: 0);
//  - timeout del capture e sleep limitati al RESIDUO, mai finestre nuove;
//  - il retry certo pre-paste resta entro il bound originario;
//  - i salti dell'orologio CIVILE non spostano il budget monotono;
//  - nessun marcatore del testo catturato o del prompt nel valore di ritorno.
const { test } = require('node:test');
const assert = require('node:assert');

const { deliverBootstrapPrompt, submitPromptWithEnter } = require('../lib/fleet/prompt-delivery.js');
const { virtualClock } = require('./helpers/delivery-clock.js');
const {
  SIM_CLAUDE_CONTRACT, CLAUDE_READY_LIKE, CLAUDE_ATTRS_EMPTY, CLAUDE_ATTRS_OCCUPIED,
} = require('./helpers/composer-fixtures.js');

// tmux finto con clock virtuale: registra argv E timeoutMs (per il caso del
// residuo), failure injection su load/paste/enter, delay iniettabile sul load
// (attesa lenta DENTRO securePaste, caso 19).
function mkTmux(clk, script = {}) {
  const calls = [];
  const exec = async (bin, args, opts = {}) => {
    calls.push({ argv: args.join(' '), timeoutMs: opts.timeoutMs });
    const cmd = args[0];
    if (cmd === 'display-message') {
      const pane = script.paneAfterResolve || '%42';
      return { err: null, stdout: `${script.sessionName || 'cloud-T'}\t0\t${pane}\n`, stderr: '', code: 0 };
    }
    if (cmd === 'load-buffer') {
      if (script.loadDelayMs) clk.advanceMono(script.loadDelayMs);
      if (script.loadFailsFirst && !script._lf) { script._lf = true; return { err: new Error('load'), stdout: '', stderr: '', code: 1 }; }
      if (script.loadFails) return { err: new Error('load'), stdout: '', stderr: '', code: 1 };
      return { err: null, stdout: '', stderr: '', code: 0 };
    }
    if (cmd === 'paste-buffer' && script.pasteFails) return { err: new Error('paste'), stdout: '', stderr: '', code: 1 };
    if (cmd === 'send-keys' && script.enterFails) return { err: new Error('enter'), stdout: '', stderr: '', code: 1 };
    return { err: null, stdout: '', stderr: '', code: 0 };
  };
  const count = (prefix) => calls.filter((c) => c.argv.startsWith(prefix)).length;
  return { calls, exec, count };
}

const OPTS = { tmuxBin: 'tmux', session: 'cloud-T', prompt: 'PROMPT-SENTINEL-s2a', client: 'claude' };
const pasteCount = (t) => t.count('paste-buffer');
const enterCount = (t) => t.count('send-keys');

// 1. Capture tardivo: il capture finisce oltre la deadline e restituisce
// ready -> skipped-unknown, reason compatibile, deadlineExceeded, ZERO paste.
test('deadline 1: capture tardivo oltre il limite -> skipped-unknown + deadlineExceeded, 0 paste', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk);
  const r = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 5000, pollMs: 500,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,
    captureImpl: async () => { clk.advanceMono(6000); return CLAUDE_READY_LIKE; },
  });
  assert.equal(r.delivered, false);
  assert.equal(r.state, 'skipped-unknown');
  assert.equal(r.reason, 'skipped-unknown', 'reason = state (enum chiuso)');
  assert.equal(r.deadlineExceeded, true, 'dettaglio bounded della deadline nel ritorno');
  assert.equal(pasteCount(t), 0);
  assert.equal(enterCount(t), 0);
});

// 2. Positivo 20/60: pronto a 20 s con limite 60 s -> submitted, UN solo
// paste e UN Enter, attempts 1; mcp: degraded atteso (budget composto
// dall'avvio della generazione: non compensa una TUI lenta e non e' un
// secondo tentativo di consegna). Dimostra il flusso NEL SIMULATORE
// qualificato per il test, non «il caso Asus risolto».
test('deadline 2: positivo 20/60 -> submitted con 1 paste/1 Enter, mcp degraded atteso', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk);
  const r = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 60000, pollMs: 2000,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,
    captureImpl: async () => (clk.now() >= 20000 ? CLAUDE_READY_LIKE : '⏺ working…\nesc to interrupt'),
    captureAttrsImpl: async () => CLAUDE_ATTRS_EMPTY,
    composerContract: SIM_CLAUDE_CONTRACT,
    mcpWait: async () => ({ state: 'pending', ready: ['a'], failed: [], pending: ['lento'] }),
  });
  assert.equal(r.state, 'submitted');
  assert.equal(r.delivered, true);
  assert.equal(r.attempts, 1);
  assert.equal(t.count('load-buffer'), 1);
  assert.equal(pasteCount(t), 1, 'esattamente un paste');
  assert.equal(enterCount(t), 1, 'esattamente un Enter');
  assert.equal(r.mcp.state, 'degraded', 'budget MCP composto: degradato visibile, atteso');
  assert.deepStrictEqual(r.mcp.pending, ['lento']);
});

// 3. Negativi al limite: busy / not-ready-* / unknown -> ZERO paste, ZERO
// Enter, kind bounded conservato come dettaglio, stato skipped-unknown.
test('deadline 3: kind qualificati al limite -> skipped-unknown, kind bounded, 0 paste/0 Enter', async () => {
  const { CLAUDE_CONSENT_LIKE, CLAUDE_TRUST_LIKE, CLAUDE_AUTH_LIKE } = require('./helpers/composer-fixtures.js');
  for (const [screen, kind] of [
    ['⏺ working…\nesc to interrupt', 'busy'],
    [CLAUDE_CONSENT_LIKE, 'not-ready-consent'],
    [CLAUDE_TRUST_LIKE, 'not-ready-onboarding'],
    [CLAUDE_AUTH_LIKE, 'not-ready-auth'],
    ['schermo mai riconosciuto', ''],
  ]) {
    const clk = virtualClock();
    const t = mkTmux(clk);
    const r = await deliverBootstrapPrompt({
      ...OPTS, readyWaitMs: 1000, pollMs: 400,
      nowImpl: clk.now, sleepImpl: clk.sleep,
      tmuxExecImpl: t.exec,
      captureImpl: async () => screen,
    });
    assert.equal(r.delivered, false, `${kind}: non consegnato`);
    assert.equal(r.state, 'skipped-unknown', `${kind}: a deadline lo stato resta skipped-unknown (C7)`);
    assert.equal(r.deadlineExceeded, true, `${kind}: dettaglio deadline`);
    assert.equal(r.notReady, kind, `${kind || 'unknown'}: kind bounded conservato come dettaglio`);
    assert.equal(pasteCount(t), 0, `${kind}: zero paste`);
    assert.equal(enterCount(t), 0, `${kind}: zero Enter`);
  }
});

// 4. Deadline durante il gate MCP: l'attesa MCP fa avanzare il tempo oltre
// il limite -> ZERO paste con lo stesso esito bounded.
test('deadline 4: gate MCP oltre il limite -> skipped-unknown + deadlineExceeded, 0 paste', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk);
  const r = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 3000, pollMs: 500,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,
    captureImpl: async () => CLAUDE_READY_LIKE,
    mcpWait: async () => { clk.advanceMono(5000); return { state: 'ready', ready: ['a'], failed: [], pending: [] }; },
  });
  assert.equal(r.state, 'skipped-unknown');
  assert.equal(r.deadlineExceeded, true);
  assert.equal(pasteCount(t), 0);
  assert.equal(enterCount(t), 0);
});

// 10. Salto dell'orologio civile (+1 h / -1 h): il budget monotono non si
// sposta e non produce paste tardivi. Nessun orologio civile entra nella
// deadline della consegna.
test('deadline 10: salto civile +/-1h non sposta il budget monotono', async () => {
  // (a) +1h durante l'attesa readiness con capture pronto: la consegna resta
  // entro il budget monotono -> submitted, un solo paste.
  const clkA = virtualClock();
  const tA = mkTmux(clkA);
  let jumped = false;
  const rA = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 30000, pollMs: 1000,
    nowImpl: clkA.now, sleepImpl: async (ms) => {
      clkA.advanceMono(ms);
      if (!jumped) { jumped = true; clkA.jumpWall(3600_000); clkA.jumpWall(-7200_000); clkA.jumpWall(3600_000); }
    },
    tmuxExecImpl: tA.exec,
    captureImpl: async () => (clkA.now() >= 5000 ? CLAUDE_READY_LIKE : 'loading…\n'),
    captureAttrsImpl: async () => CLAUDE_ATTRS_EMPTY,
    composerContract: SIM_CLAUDE_CONTRACT,
  });
  assert.equal(rA.state, 'submitted', '+1h/-1h civile: budget monotono intatto');
  assert.equal(pasteCount(tA), 1);

  // (b) budget monotono esaurito: nessun salto civile lo riapre -> skip.
  const clkB = virtualClock();
  const tB = mkTmux(clkB);
  const rB = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 1000, pollMs: 400,
    nowImpl: clkB.now, sleepImpl: async (ms) => { clkB.advanceMono(ms); clkB.jumpWall(-3600_000); },
    tmuxExecImpl: tB.exec,
    captureImpl: async () => 'loading…\n',
  });
  assert.equal(rB.state, 'skipped-unknown');
  assert.equal(rB.deadlineExceeded, true);
  assert.equal(pasteCount(tB), 0, 'nessun paste tardivo grazie a un salto civile');
});

// 11. readyWaitMs: 0: NESSUNA osservazione privilegiata a budget zero —
// zero paste, zero Enter, skipped-unknown + deadlineExceeded. Il gate sta
// nella funzione, non nel caller (input negativi al clamp producono 0).
test('deadline 11: readyWaitMs 0 (e clamp a 0) -> mai paste, skipped-unknown + deadlineExceeded', async () => {
  for (const zero of [0, -1, -1000]) {
    const clk = virtualClock();
    const t = mkTmux(clk);
    const r = await deliverBootstrapPrompt({
      ...OPTS, readyWaitMs: zero, pollMs: 100,
      nowImpl: clk.now, sleepImpl: clk.sleep,
      tmuxExecImpl: t.exec,
      captureImpl: async () => CLAUDE_READY_LIKE,
    });
    assert.equal(r.delivered, false, `readyWaitMs ${zero}: budget zero non consegna`);
    assert.equal(r.state, 'skipped-unknown');
    assert.equal(r.deadlineExceeded, true);
    assert.equal(pasteCount(t), 0, `readyWaitMs ${zero}: zero paste`);
    assert.equal(enterCount(t), 0, `readyWaitMs ${zero}: zero Enter`);
  }
});

// 12. Retry oltre il bound: primo load PROVATAMENTE fallito pre-paste con
// residuo esaurito -> failed-pre-paste con dettaglio deadline, NESSUN secondo
// paste, attempts conservato.
test('deadline 12a: load fallito pre-paste a residuo esaurito -> failed-pre-paste, nessun secondo tentativo', async () => {
  const clk = virtualClock();
  // il load del primo tentativo consuma tutto il residuo prima di fallire
  const t = mkTmux(clk, { loadFailsFirst: true, loadDelayMs: 5000 });
  const r = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 5000, pollMs: 2000,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,
    captureImpl: async () => CLAUDE_READY_LIKE,
    captureAttrsImpl: async () => CLAUDE_ATTRS_EMPTY,
    composerContract: SIM_CLAUDE_CONTRACT,
  });
  assert.equal(r.state, 'failed-pre-paste');
  assert.equal(r.deadlineExceeded, true, 'dettaglio deadline sul fallimento certo pre-paste');
  assert.equal(r.attempts, 1, 'attempts conservato: il secondo tentativo non parte');
  assert.equal(t.count('load-buffer'), 1, 'nessun secondo load');
  assert.equal(pasteCount(t), 0);
  assert.equal(enterCount(t), 0);
});

// 12b: verifica fresca negativa al retry -> failed-pre-paste, zero paste.
test('deadline 12b: riverifica negativa al retry -> failed-pre-paste, 0 paste', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk, { loadFailsFirst: true });
  let calls = 0;
  const r = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 30000, pollMs: 500,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,
    captureImpl: async () => {
      calls += 1;
      // readiness (1) e verifica fresca pre-paste (2): pronto; riverifica al
      // retry (3+): non piu' pronto
      return calls <= 2 ? CLAUDE_READY_LIKE : '❯ \nNot logged in · Run /login\n';
    },
    captureAttrsImpl: async () => CLAUDE_ATTRS_EMPTY,
    composerContract: SIM_CLAUDE_CONTRACT,
  });
  assert.equal(r.state, 'failed-pre-paste');
  assert.equal(pasteCount(t), 0);
  assert.equal(enterCount(t), 0);
});

// 13. Timeout al residuo: il timeoutMs passato al capture non supera MAI il
// residuo della finestra (oggi e' fisso a 2000 ms).
test('deadline 13: timeout del capture limitato al residuo, mai oltre la finestra', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk);
  await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 3000, pollMs: 1000,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,   // nessun captureImpl: capture di default via exec
  });
  const caps = t.calls.filter((c) => c.argv.startsWith('capture-pane'));
  assert.ok(caps.length >= 2, `almeno due capture (${caps.length})`);
  let mono = 0; const deadline = 3000;
  for (const c of caps) {
    const residuo = deadline - mono;
    // mai oltre il residuo; il floor a 1 ms e' voluto: execFile tratta
    // timeout 0 come NESSUN timeout (finestra infinita), quindi a residuo 0
    // il limite e' 1 ms, non 0.
    assert.ok(c.timeoutMs <= Math.max(1, residuo), `timeout ${c.timeoutMs} > residuo ${residuo}`);
    assert.ok(c.timeoutMs >= 1, 'mai timeout zero (0 = nessun timeout per execFile)');
    mono += 1000; // il pollMs del test avanza il clock virtuale
  }
});

// 14. Nessun leak: il valore di ritorno serializzato non contiene marcatori
// del testo catturato né del prompt.
test('deadline 14: nessun marcatore del testo catturato o del prompt nel ritorno', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk);
  const r = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 10000, pollMs: 500,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,
    captureImpl: async () => '❯ CAPTURE-SENTINEL-s2a visible\n',
    captureAttrsImpl: async () => CLAUDE_ATTRS_EMPTY,
    composerContract: SIM_CLAUDE_CONTRACT,
  });
  const body = JSON.stringify(r);
  assert.ok(!body.includes('CAPTURE-SENTINEL-s2a'), 'nessun testo catturato nel ritorno');
  assert.ok(!body.includes('PROMPT-SENTINEL-s2a'), 'nessun prompt nel ritorno');
});

// ===========================================================================
// Verifica fresca prima del PRIMO paste e prima del retry certo (A4/C6):
// pane pinned con binding del proprietario, capture con attributi su quel
// pane, classifyPane ready, composer empty qualificato. Qualunque altro
// esito -> ZERO paste, ZERO Enter, stato/dettaglio bounded.
// ===========================================================================

// 5. Input umano nel gate MCP: il composer e' occupato alla verifica fresca
// -> ZERO paste con motivo bounded.
test('fresh 5: composer occupato alla verifica fresca -> skipped-unknown, motivo bounded, 0 paste', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk);
  let attrsCalls = 0;
  const r = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 30000, pollMs: 500,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,
    captureImpl: async () => CLAUDE_READY_LIKE,
    captureAttrsImpl: async () => { attrsCalls += 1; return CLAUDE_ATTRS_OCCUPIED; },
    composerContract: SIM_CLAUDE_CONTRACT,
    mcpWait: async () => ({ state: 'ready', ready: ['a'], failed: [], pending: [] }),
  });
  assert.equal(attrsCalls, 1, 'la verifica fresca legge il composer con attributi');
  assert.equal(r.delivered, false);
  assert.equal(r.state, 'skipped-unknown');
  assert.equal(r.notReady, 'busy', 'motivo bounded: il composer e' + ' occupato da input umano');
  assert.equal(pasteCount(t), 0);
  assert.equal(enterCount(t), 0);
});

// 6. Capture tardivo NELLA verifica fresca: l'attrs capture finisce oltre
// la deadline -> ZERO paste (guardia al confine pre-effetto).
test('fresh 6: attrs capture oltre la deadline nella verifica fresca -> 0 paste', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk);
  const r = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 5000, pollMs: 500,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,
    captureImpl: async () => CLAUDE_READY_LIKE,
    captureAttrsImpl: async () => { clk.advanceMono(6000); return CLAUDE_ATTRS_EMPTY; },
    composerContract: SIM_CLAUDE_CONTRACT,
  });
  assert.equal(r.delivered, false);
  assert.equal(r.deadlineExceeded, true);
  assert.equal(pasteCount(t), 0, 'nessun paste oltre la deadline, nemmeno con verify ok');
  assert.equal(enterCount(t), 0);
});

// 7. Cancellazione durante la verifica fresca -> cancelled, ZERO paste.
test('fresh 7: cancellazione durante la verifica fresca -> cancelled, 0 paste', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk);
  let cancelled = false;
  let attrsCalls = 0;
  const r = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 30000, pollMs: 500,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,
    captureImpl: async () => CLAUDE_READY_LIKE,
    captureAttrsImpl: async () => { attrsCalls += 1; cancelled = true; return CLAUDE_ATTRS_EMPTY; },
    composerContract: SIM_CLAUDE_CONTRACT,
    isCancelled: () => cancelled,
  });
  assert.equal(attrsCalls, 1, 'la cancellazione avviene DENTRO la finestra di verifica');
  assert.equal(r.state, 'cancelled');
  assert.equal(pasteCount(t), 0);
  assert.equal(enterCount(t), 0);
});

// 8. Pane sostituito fra readiness e consegna: %N non piu' quello atteso ->
// ZERO paste, nessuna ri-risoluzione libera.
test('fresh 8: pane sostituito (%N diverso) -> 0 paste', async () => {
  // (a) il pane della sessione non e' piu' risolvibile alla verifica fresca:
  // la PRIMA verifica (pre-paste) non qualifica il pane -> skipped-unknown.
  const clkA = virtualClock();
  let resolves = 0;
  const tA = mkTmux(clkA, {});
  const execA = async (bin, args, opts) => {
    if (args[0] === 'display-message') {
      resolves += 1;
      return { err: new Error('gone'), stdout: '', stderr: '', code: 1 };
    }
    return tA.exec(bin, args, opts);
  };
  const rA = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 30000, pollMs: 500,
    nowImpl: clkA.now, sleepImpl: clkA.sleep,
    tmuxExecImpl: execA,
    captureImpl: async () => CLAUDE_READY_LIKE,
    captureAttrsImpl: async () => CLAUDE_ATTRS_EMPTY,
    composerContract: SIM_CLAUDE_CONTRACT,
  });
  assert.equal(rA.state, 'skipped-unknown', 'pane non qualificabile: zero effetti');
  assert.equal(pasteCount(tA), 0);
  assert.equal(enterCount(tA), 0);

  // (b) il %N cambia DOPO il pinning della verifica: il target pinned non
  // viene ri-risolto a un pane nuovo -> fallimento certo pre-paste, 0 paste.
  const clkB = virtualClock();
  let seq = 0;
  const tB = mkTmux(clkB, {});
  const execB = async (bin, args, opts) => {
    if (args[0] === 'display-message') {
      seq += 1;
      const pane = seq === 1 ? '%42' : '%99';
      tB.calls.push({ argv: `display-message -p -t ${args[3]} … ${pane}`, timeoutMs: opts && opts.timeoutMs });
      return { err: null, stdout: `cloud-T\t0\t${pane}\n`, stderr: '', code: 0 };
    }
    return tB.exec(bin, args, opts);
  };
  const rB = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 30000, pollMs: 500,
    nowImpl: clkB.now, sleepImpl: clkB.sleep,
    tmuxExecImpl: execB,
    captureImpl: async () => CLAUDE_READY_LIKE,
    captureAttrsImpl: async () => CLAUDE_ATTRS_EMPTY,
    composerContract: SIM_CLAUDE_CONTRACT,
  });
  assert.equal(rB.delivered, false);
  assert.notEqual(rB.state, 'submitted');
  assert.equal(pasteCount(tB), 0, 'il pane atteso non e' + ' piu' + ' quello: nessun paste');
  assert.equal(enterCount(tB), 0);
});

// 9. Generazione morta durante la verifica fresca (child uscito) ->
// cancelled, ZERO paste.
test('fresh 9: generazione morta durante la verifica fresca -> cancelled, 0 paste', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk);
  const childState = { exited: false };
  let attrsCalls = 0;
  const r = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 30000, pollMs: 500,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,
    captureImpl: async () => CLAUDE_READY_LIKE,
    captureAttrsImpl: async () => { attrsCalls += 1; childState.exited = true; return CLAUDE_ATTRS_EMPTY; },
    composerContract: SIM_CLAUDE_CONTRACT,
    isCancelled: () => childState.exited === true,
  });
  assert.equal(attrsCalls, 1, 'la generazione muore DENTRO la verifica fresca');
  assert.equal(r.state, 'cancelled');
  assert.equal(pasteCount(t), 0);
  assert.equal(enterCount(t), 0);
});

// 19. Attesa lenta DENTRO securePaste: il load supera la deadline fra la
// verifica e l'effetto -> ZERO paste (guardia al confine pre-effetto reale,
// non solo prima della chiamata).
test('fresh 19: load lento dentro securePaste oltre la deadline -> 0 paste', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk, { loadDelayMs: 9000 });
  const r = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 5000, pollMs: 500,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,
    captureImpl: async () => CLAUDE_READY_LIKE,
    captureAttrsImpl: async () => CLAUDE_ATTRS_EMPTY,
    composerContract: SIM_CLAUDE_CONTRACT,
  });
  assert.equal(r.delivered, false);
  assert.equal(r.state, 'failed-pre-paste');
  assert.equal(r.deadlineExceeded, true, 'dettaglio deadline sul abort pre-effetto');
  assert.equal(pasteCount(t), 0, 'il paste NON parte oltre la deadline');
  assert.equal(enterCount(t), 0);
});

// 20. Proprietario cambiato con lo STESSO %N: il pane e' riusato dalla
// generazione successiva e isCancelled cambia fra verifica e paste ->
// ZERO paste; da =session il target pinned non viene ri-risolto a un pane
// nuovo.
test('fresh 20: proprietario cambiato sullo stesso %N -> 0 paste, target pinned mai ri-risolto', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk, {});
  let cancelled = false;
  const execT = async (bin, args, opts) => {
    if (args[0] === 'load-buffer') cancelled = true;
    return t.exec(bin, args, opts);
  };
  const r = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 30000, pollMs: 500,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: execT,
    captureImpl: async () => CLAUDE_READY_LIKE,
    captureAttrsImpl: async () => CLAUDE_ATTRS_EMPTY,
    composerContract: SIM_CLAUDE_CONTRACT,
    isCancelled: () => cancelled,
  });
  assert.equal(r.state, 'cancelled', 'binding del proprietario: la generazione non e' + ' piu' + ' quella');
  assert.equal(pasteCount(t), 0);
  assert.equal(enterCount(t), 0);
  // il pinning: dopo la verifica (=sessione -> %42) il trasporto lavora sul
  // %N PINNATO; il codice attuale risolve liberamente =sessione dentro
  // securePaste, quindi nessun '-t %42' comparirebbe.
  const resolves = t.calls.filter((c) => c.argv.startsWith('display-message'));
  assert.ok(resolves.some((c) => c.argv.includes('-t %42')),
    'il trasporto risolve il %N pinnato dalla verifica, non =sessione');
});

// ===========================================================================
// Submit opt-in custom (C8/A7): stessa disciplina di deadline sul trasporto
// (sleep e timeout al residuo, deadline dopo ogni await) e identita' fresca
// del pane (binding del proprietario) ri-verificata subito prima del primo
// effetto, con il bound passato al nucleo condiviso e alla guardia
// pre-effetto di securePaste. NESSUN classifier del composer: un engine
// custom non ce l'ha. Retry certo pre-paste e post-paste incerto invariati.
// ===========================================================================

// 16a. Pane cambiato prima del primo effetto -> ZERO paste, ZERO Enter.
test('submit 16a: pane cambiato prima del primo effetto -> 0 paste / 0 Enter', async () => {
  const clk = virtualClock();
  let resolves = 0;
  const t = mkTmux(clk, {});
  const execT = async (bin, args, opts) => {
    if (args[0] === 'display-message') {
      resolves += 1;
      const pane = resolves === 1 ? '%42' : '%99';
      t.calls.push({ argv: `display-message … ${pane}`, timeoutMs: opts && opts.timeoutMs });
      return { err: null, stdout: `cloud-T\t0\t${pane}\n`, stderr: '', code: 0 };
    }
    return t.exec(bin, args, opts);
  };
  const r = await submitPromptWithEnter({
    tmuxBin: 'tmux', session: 'cloud-T', prompt: 'p', env: {},
    readyWaitMs: 30000, pollMs: 500,
    bracketedPaste: true,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: execT,
  });
  assert.equal(r.delivered, false);
  assert.notEqual(r.state, 'submitted');
  assert.equal(pasteCount(t), 0, 'il pane atteso non e' + ' piu' + ' quello: nessun paste');
  assert.equal(enterCount(t), 0);
});

// 16b. Resolve oltre la deadline -> ZERO paste.
test('submit 16b: resolve oltre la deadline -> failed-pre-paste + deadlineExceeded, 0 paste', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk, {});
  const execT = async (bin, args, opts) => {
    if (args[0] === 'display-message') clk.advanceMono(9000);
    return t.exec(bin, args, opts);
  };
  const r = await submitPromptWithEnter({
    tmuxBin: 'tmux', session: 'cloud-T', prompt: 'p', env: {},
    readyWaitMs: 5000, pollMs: 500,
    bracketedPaste: true,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: execT,
  });
  assert.equal(r.state, 'failed-pre-paste', 'il submit mantiene il suo esito pre-effetto');
  assert.equal(r.deadlineExceeded, true);
  assert.equal(pasteCount(t), 0);
  assert.equal(enterCount(t), 0);
});

// 16c. Retry certo pre-paste e post-paste incerto INVARIATI (regressione
// esplicita): il bound non indebolisce il retry entro finestra ne' la
// disciplina at-most-once.
test('submit 16c: retry entro finestra e post-paste invariati', async () => {
  // (a) load fallito al primo tentativo, residuo ampio: UN retry, submitted.
  const clkA = virtualClock();
  const tA = mkTmux(clkA, { loadFailsFirst: true });
  const rA = await submitPromptWithEnter({
    tmuxBin: 'tmux', session: 'cloud-T', prompt: 'p', env: {},
    readyWaitMs: 30000, pollMs: 500,
    bracketedPaste: true,
    nowImpl: clkA.now, sleepImpl: clkA.sleep,
    tmuxExecImpl: tA.exec,
  });
  assert.equal(rA.state, 'submitted');
  assert.equal(rA.attempts, 2, 'un solo retry pre-paste, come oggi');
  assert.equal(pasteCount(tA), 1);

  // (b) paste fallito: delivery-unknown, NESSUN secondo paste.
  const clkB = virtualClock();
  const tB = mkTmux(clkB, { pasteFails: true });
  const rB = await submitPromptWithEnter({
    tmuxBin: 'tmux', session: 'cloud-T', prompt: 'p', env: {},
    readyWaitMs: 30000, pollMs: 500,
    bracketedPaste: true,
    nowImpl: clkB.now, sleepImpl: clkB.sleep,
    tmuxExecImpl: tB.exec,
  });
  assert.equal(rB.state, 'delivery-unknown');
  assert.equal(pasteCount(tB), 1, 'il paste e' + ' stato tentato: zero secondi paste');
  assert.equal(enterCount(tB), 0);
});

// 16d. Guardia pre-effetto anche per il submit: load lento dentro securePaste
// oltre la deadline -> ZERO paste.
test('submit 16d: load lento dentro securePaste oltre la deadline -> 0 paste', async () => {
  const clk = virtualClock();
  const t = mkTmux(clk, { loadDelayMs: 9000 });
  const r = await submitPromptWithEnter({
    tmuxBin: 'tmux', session: 'cloud-T', prompt: 'p', env: {},
    readyWaitMs: 5000, pollMs: 500,
    bracketedPaste: true,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,
  });
  assert.equal(r.state, 'failed-pre-paste');
  assert.equal(r.deadlineExceeded, true);
  assert.equal(pasteCount(t), 0);
});

// ===========================================================================
// Due orologi (C7/A8, rischio R7): notBeforeMs e' CIVILE (confrontato con i
// nomi dei log MCP su disco), deadlineMs e' MONOTONA. Seam distinti
// (wallNowImpl / monoNowImpl) e LO STESSO monotono passato al consumer,
// altrimenti il gate non scade piu'. Poll limitato al residuo e deadline
// ricontrollata dopo il sonno, prima di una nuova lettura.
// ===========================================================================
const { startGenerationPrompt } = require('../lib/fleet/cell-exec.js');
const { waitMcpReadiness } = require('../lib/fleet/mcp-cache-readiness.js');

test('clocks 17a: buildMcpWait — notBeforeMs civile e deadlineMs monotona da DUE seam distinti, stesso monotono al consumer', async () => {
  const t0Wall = 1_700_000_000_000;
  const monoT0 = 12345;
  const monoNow = () => monoT0;
  const wallNow = () => t0Wall;
  const waitCalls = [];
  const s = {
    setTimeout: (fn) => { queueMicrotask(() => { try { fn(); } catch (_) {} }); return { unref() {} }; },
    clearTimeout: () => {},
    waitMcpReadiness: async (args) => { waitCalls.push(args); return { state: 'ready', ready: ['a'], failed: [], pending: [] }; },
    deliverBootstrapPrompt: async (opts) => {
      if (opts.mcpWait) await opts.mcpWait({ isCancelled: () => false });
      return { delivered: true, state: 'submitted', notReady: '', attempts: 1 };
    },
    tmuxExec: async () => ({ err: null, stdout: '', stderr: '', code: 0 }),
    wallNowImpl: wallNow,
    monoNowImpl: monoNow,
  };
  const ctl = startGenerationPrompt({
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', client: 'claude', readyMs: 1,
    readyWaitMs: 1000,
    mcpReadiness: { cwd: '/tmp/cella', expectedServers: ['nexuscrew'], budgetMs: 20000 },
  }, 0, { exited: false }, s);
  await ctl.settled;
  const arg = waitCalls[0];
  assert.ok(arg, 'il gate passa dall adattatore waitMcpReadiness');
  assert.strictEqual(arg.params.notBeforeMs, t0Wall, 'notBeforeMs dal seam CIVILE (log MCP su disco)');
  assert.strictEqual(arg.deadlineMs, monoT0 + 20000, 'deadlineMs dal seam MONOTONO (spawn + budget)');
  assert.strictEqual(arg.nowImpl, monoNow, 'LO STESSO monotono passa esplicitamente al consumer');
});

test('clocks 17b: waitMcpReadiness — sleep clampato al residuo, deadline ricontrollata dopo il sonno', async () => {
  // (a) sleep mai oltre il residuo: deadline a mono 600, pollMs 500 -> il
  // sonno e' <= al residuo rimanente.
  let mono = 0;
  const sleeps = [];
  const root = '/tmp/nc-0980-s2a/mcp-mai-pronto';
  const rA = await waitMcpReadiness({
    params: { cacheRoot: root, cwd: '/x', expectedServers: ['mai'] },
    deadlineMs: 600,
    pollMs: 500,
    nowImpl: () => mono,
    sleepImpl: async (ms) => { sleeps.push(ms); mono += ms; },
  });
  assert.strictEqual(rA.timedOut, true);
  assert.ok(sleeps.length >= 1);
  let t = 0;
  for (const ms of sleeps) {
    assert.ok(ms <= 600 - t, `sleep ${ms} > residuo ${600 - t}`);
    t += ms;
  }

  // (b) la deadline si ricontrolla DOPO il sonno e PRIMA di una nuova
  // lettura: un insieme che diventa ready durante un sonno che scavalca la
  // deadline resta timedOut (il budget e' scaduto: non e' una nuova finestra).
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s2a-clocks-'));
  const serverDir = path.join(dir, 'mcp-logs-x');
  fs.mkdirSync(serverDir, { recursive: true });
  const stamp = '2026-09-22T18-00-00-000Z';
  const START = Date.parse('2026-09-22T18:00:00.000Z');
  fs.writeFileSync(path.join(serverDir, `${stamp}.jsonl`),
    JSON.stringify({ debug: 'Starting connection with timeout of 30000ms' }) + '\n');
  let monoB = 0;
  let flips = 0;
  const fsImpl = {
    readdirSync: () => [`${stamp}.jsonl`],
    readFileSync: () => {
      // primo giro: pending; dal secondo la cache dice ready — ma la
      // deadline scatta durante il PRIMO sonno, quindi non deve esserci un
      // secondo giro di lettura.
      flips += 1;
      return flips <= 1
        ? JSON.stringify({ debug: 'Starting connection with timeout of 30000ms' }) + '\n'
        : JSON.stringify({ debug: 'Successfully connected (transport: stdio) in 1ms' }) + '\n';
    },
  };
  const rB = await waitMcpReadiness({
    params: { cacheRoot: dir, cwd: 'x', expectedServers: ['x'], notBeforeMs: START, fsImpl },
    deadlineMs: 100,
    pollMs: 500,   // il sonno clampato deve comunque restare <= residuo
    nowImpl: () => monoB,
    sleepImpl: async (ms) => { monoB += ms; },
  });
  assert.strictEqual(rB.timedOut, true, 'deadline scaduta durante il sonno: timedOut, non una lettura in piu');
  assert.strictEqual(flips, 1, 'nessuna nuova lettura della cache dopo la deadline');
  fs.rmSync(dir, { recursive: true, force: true });
});
