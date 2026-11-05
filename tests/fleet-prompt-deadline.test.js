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

const { deliverBootstrapPrompt } = require('../lib/fleet/prompt-delivery.js');
const { virtualClock } = require('./helpers/delivery-clock.js');
const {
  SIM_CLAUDE_CONTRACT, CLAUDE_READY_LIKE, CLAUDE_ATTRS_EMPTY,
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
  let first = true;
  const r = await deliverBootstrapPrompt({
    ...OPTS, readyWaitMs: 30000, pollMs: 500,
    nowImpl: clk.now, sleepImpl: clk.sleep,
    tmuxExecImpl: t.exec,
    captureImpl: async () => {
      const ready = first;
      first = false;
      // readiness: pronto; riverifica al retry: non piu' pronto
      return ready ? CLAUDE_READY_LIKE : '❯ \nNot logged in · Run /login\n';
    },
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
