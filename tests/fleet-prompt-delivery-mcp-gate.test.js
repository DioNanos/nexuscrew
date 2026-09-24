'use strict';
// Gate readiness MCP in deliverBootstrapPrompt (claude.*).
// Casi del contratto: consegna con MCP pronti; degradato visibile a budget esaurito;
// cancellazione durante l'attesa MCP (zero paste); composer non pronto a
// timeout resta bloccante (il gate MCP non bypassa mai il composer).
const { test } = require('node:test');
const assert = require('node:assert');

const { deliverBootstrapPrompt } = require('../lib/fleet/prompt-delivery.js');
const { startGenerationPrompt, validRestartPrompt } = require('../lib/fleet/cell-exec.js');

function seams({ captures, pasteOk = true, enterOk = true } = {}) {
  const order = [];
  let n = 0;
  return {
    order,
    captureImpl: async () => (n < captures.length ? captures[n++] : captures[captures.length - 1]),
    tmuxExecImpl: async (bin, args) => {
      order.push(args.join(' '));
      if (args[0] === 'display-message') {
        // resolveSessionPane: '#{session_name}\t#{pane_dead}\t#{pane_id}'
        return { err: null, stdout: 'sess\t0\t%0\n', stderr: '', code: 0 };
      }
      if (args[0] === 'load-buffer' || args[0] === 'paste-buffer') {
        return { err: pasteOk ? null : new Error('paste ko'), stdout: '', stderr: '', code: pasteOk ? 0 : 1 };
      }
      if (args[0] === 'send-keys') {
        return { err: enterOk ? null : EnterKo(), stdout: '', stderr: '', code: enterOk ? 0 : 1 };
      }
      return { err: null, stdout: '', stderr: '', code: 0 };
    },
  };
  function EnterKo() { return new Error('enter ko'); }
}

test('MCP ready subito: consegna submitted con mcp ready (contratto P3 del Gate B)', async () => {
  const s = seams({ captures: ['❯'] });
  const result = await deliverBootstrapPrompt({
    tmuxBin: 'tmux', session: 'sess', prompt: 'bootstrap', client: 'claude',
    readyWaitMs: 100, pollMs: 10, settleMs: 0,
    captureImpl: s.captureImpl, tmuxExecImpl: s.tmuxExecImpl,
    mcpWait: async () => ({ state: 'ready', ready: ['a', 'b'], failed: [], pending: [] }),
  });
  assert.strictEqual(result.delivered, true);
  assert.strictEqual(result.state, 'submitted');
  assert.deepStrictEqual(result.mcp.ready, ['a', 'b']);
  assert.deepStrictEqual(result.mcp.failed, []);
});

test('budget esaurito con pending: consegna DEGRADATO VISIBILE con elenco bounded', async () => {
  const s = seams({ captures: ['❯'] });
  const result = await deliverBootstrapPrompt({
    tmuxBin: 'tmux', session: 'sess', prompt: 'bootstrap', client: 'claude',
    readyWaitMs: 100, pollMs: 10, settleMs: 0,
    captureImpl: s.captureImpl, tmuxExecImpl: s.tmuxExecImpl,
    mcpWait: async () => ({ state: 'pending', ready: ['a'], failed: [], pending: ['lento', 'ko-server'] }),
  });
  assert.strictEqual(result.delivered, true);
  assert.strictEqual(result.state, 'submitted');
  assert.strictEqual(result.mcp.state, 'degraded');
  assert.deepStrictEqual(result.mcp.pending, ['lento', 'ko-server']);
});

test('cancel durante attesa MCP: esito cancelled, ZERO paste (at-most-once)', async () => {
  const s = seams({ captures: ['❯'] });
  let pasteChiamate = 0;
  const result = await deliverBootstrapPrompt({
    tmuxBin: 'tmux', session: 'sess', prompt: 'bootstrap', client: 'claude',
    readyWaitMs: 100, pollMs: 10, settleMs: 0,
    isCancelled: () => true,
    captureImpl: s.captureImpl,
    tmuxExecImpl: async (bin, args) => {
      if (args[0] === 'load-buffer' || args[0] === 'paste-buffer') pasteChiamate += 1;
      return { err: null, stdout: '', stderr: '', code: 0 };
    },
    mcpWait: async ({ isCancelled }) => {
      assert.strictEqual(isCancelled(), true, 'il flag cancel deve essere propagato alla mcpWait');
      return { cancelled: true };
    },
  });
  assert.strictEqual(result.state, 'cancelled');
  assert.strictEqual(result.delivered, false);
  assert.strictEqual(pasteChiamate, 0, 'mai paste dopo cancel');
});

test('dialogo aperto al timeout: skipped-not-ready, mai consegna (il gate MCP non bypassa il composer)', async () => {
  const s = seams({ captures: ['  Do you want to use this API key?'] });
  let mcpChiamata = false;
  const result = await deliverBootstrapPrompt({
    tmuxBin: 'tmux', session: 'sess', prompt: 'bootstrap', client: 'claude',
    readyWaitMs: 40, pollMs: 10, settleMs: 0,
    captureImpl: s.captureImpl, tmuxExecImpl: s.tmuxExecImpl,
    mcpWait: async () => { mcpChiamata = true; return { state: 'ready', ready: ['x'], failed: [], pending: [] }; },
  });
  assert.strictEqual(result.delivered, false);
  assert.strictEqual(result.state, 'skipped-not-ready');
  assert.strictEqual(result.notReady, 'not-ready-consent');
  assert.strictEqual(mcpChiamata, false, 'composer blocca: niente consegna, niente gate MCP a valle');
  assert.strictEqual(result.mcp, undefined);
});

test('composer never-ready (unknown a timeout): skipped-unknown anche con mcpWait presente', async () => {
  const s = seams({ captures: [''] });
  const result = await deliverBootstrapPrompt({
    tmuxBin: 'tmux', session: 'sess', prompt: 'bootstrap', client: 'claude',
    readyWaitMs: 40, pollMs: 10, settleMs: 0,
    captureImpl: s.captureImpl, tmuxExecImpl: s.tmuxExecImpl,
    mcpWait: async () => ({ state: 'ready', ready: ['x'], failed: [], pending: [] }),
  });
  assert.strictEqual(result.state, 'skipped-unknown');
  assert.strictEqual(result.mcp, undefined);
});

test('parseMcpListOption: formato bounded, nomi validati, duplicati e spazzatura ignorati', async () => {
  const { parseMcpListOption } = require('../lib/fleet/prompt-delivery.js');
  assert.deepStrictEqual(parseMcpListOption('failed=a,b|pending=c'), { failed: ['a', 'b'], pending: ['c'] });
  assert.deepStrictEqual(parseMcpListOption('failed=a,a,b'), { failed: ['a', 'b'], pending: [] });
  assert.deepStrictEqual(parseMcpListOption('weird=x|failed=../etc;;'), { failed: [], pending: [] });
  assert.deepStrictEqual(parseMcpListOption(''), { failed: [], pending: [] });
  assert.deepStrictEqual(parseMcpListOption(null), { failed: [], pending: [] });
});
// --- cell-exec: gate MCP nel payload (casi del contratto) ---

function cellExecSeams({ deliverResult, waitResult, optsCatturati }) {
  const setOptions = [];
  const waitCalls = [];
  return {
    setOptions,
    waitCalls,
    // Il timer di consegna del prodotto e' unref'd (non deve tenere vivo il
    // supervisor): nel test lo scatto avviene in microtask, cosi' la promise
    // del test si risolve senza dipendere dal timer sullo scheduler reale
    // (su node <= 22 l'event loop si svuota prima e il runner cancella).
    setTimeout: (fn) => { queueMicrotask(() => { try { fn(); } catch (_) {} }); return { unref() {}, ref() {} }; },
    clearTimeout: () => {},
    deliverBootstrapPrompt: async (opts) => {
      optsCatturati.push(opts);
      // come la deliver vera: il gate MCP viene atteso PRIMA del paste
      if (opts.mcpWait) await opts.mcpWait({ isCancelled: () => false });
      return deliverResult;
    },
    waitMcpReadiness: async (args) => {
      waitCalls.push(args);
      return waitResult;
    },
    tmuxExec: async (bin, args) => {
      if (args[0] === 'set-option') setOptions.push(`${args[4]}=${args[5]}`);
      if (args[0] === 'display-message') return { err: null, stdout: 'sess\t0\t%0\n', stderr: '', code: 0 };
      return { err: null, stdout: '', stderr: '', code: 0 };
    },
  };
}

test('cell-exec: claude.* riceve mcpWait con deadline composta (spawn + budget approvato)', async () => {
  const optsCatturati = [];
  const t0 = 1_700_000_000_000;
  const s = cellExecSeams({
    deliverResult: { delivered: true, state: 'submitted', notReady: '', attempts: 1, mcp: { state: 'ready', ready: ['a'], failed: [], pending: [] } },
    waitResult: { state: 'ready', ready: ['a'], failed: [], pending: [] },
    optsCatturati,
  });
  const ctl = startGenerationPrompt(
    {
      tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'bootstrap', client: 'claude',
      readyMs: 5, readyWaitMs: 1000,
      mcpReadiness: { cwd: '/tmp/cella', expectedServers: ['nexuscrew', 'memory'], budgetMs: 20000 },
    },
    0, { exited: false },
    { ...s, nowImpl: () => t0, sleepImpl: async () => {} },
  );
  await ctl.settled;
  assert.strictEqual(optsCatturati.length, 1);
  assert.strictEqual(typeof optsCatturati[0].mcpWait, 'function', 'la deliver riceve il gate MCP');
  const waitArg = s.waitCalls[0];
  assert.ok(waitArg, 'il gate deve passare dall adattatore waitMcpReadiness');
  assert.deepStrictEqual(waitArg.params.expectedServers, ['nexuscrew', 'memory']);
  assert.strictEqual(waitArg.params.cwd, '/tmp/cella');
  assert.strictEqual(waitArg.params.notBeforeMs, t0, 'notBefore = avvio della GENERAZIONE corrente');
  assert.strictEqual(waitArg.deadlineMs, t0 + 20000, 'deadline composta = spawn + budget');
});

test('cell-exec: avvio degradato visibile -> @nc_delivery con :mcpdegraded e @nc_mcp_list bounded', async () => {
  const optsCatturati = [];
  const s = cellExecSeams({
    deliverResult: { delivered: true, state: 'submitted', notReady: '', attempts: 1, mcp: { state: 'degraded', ready: ['a'], failed: ['ko-server'], pending: ['lento'] } },
    waitResult: { state: 'degraded', ready: ['a'], failed: ['ko-server'], pending: ['lento'] },
    optsCatturati,
  });
  const ctl = startGenerationPrompt(
    {
      tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'bootstrap', client: 'claude',
      readyMs: 5, readyWaitMs: 1000,
      mcpReadiness: { cwd: '/tmp/cella', expectedServers: ['a', 'lento', 'ko-server'], budgetMs: 20000 },
    },
    0, { exited: false }, s,
  );
  await ctl.settled;
  const delivery = s.setOptions.filter((v) => v.startsWith('@nc_delivery=')).pop();
  assert.ok(delivery && delivery.includes('submitted:mcpdegraded'), `esito degradato visibile (${delivery})`);
  const list = s.setOptions.find((v) => v.startsWith('@nc_mcp_list='));
  assert.ok(list.includes('failed=ko-server') && list.includes('pending=lento'), `elenco bounded (${list})`);
});

test('cell-exec: kimi invariato — nessun mcpWait, nessun @nc_mcp_list (contratto 0.8.47 preservato)', async () => {
  const optsCatturati = [];
  const s = cellExecSeams({
    deliverResult: { delivered: true, state: 'submitted', notReady: '', attempts: 1 },
    waitResult: { state: 'ready', ready: [], failed: [], pending: [] },
    optsCatturati,
  });
  const ctl = startGenerationPrompt(
    { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'bootstrap', client: 'kimi', readyMs: 5, readyWaitMs: 1000 },
    0, { exited: false }, s,
  );
  await ctl.settled;
  assert.strictEqual(optsCatturati.length, 1);
  assert.strictEqual(optsCatturati[0].mcpWait, undefined, 'kimi: nessun gate MCP');
  assert.strictEqual(s.waitCalls.length, 0);
  assert.ok(!s.setOptions.some((v) => v.startsWith('@nc_mcp_list=')));
  assert.ok(s.setOptions.some((v) => v === '@nc_delivery=submitted'), 'esito senza segmento mcp');
});

test('validRestartPrompt: accetta client claude con mcpReadiness; rifiuta attesa vuota o campi extra', () => {
  assert.strictEqual(validRestartPrompt({
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 10, client: 'claude', readyWaitMs: 1000,
    mcpReadiness: { cwd: '/tmp/cella', expectedServers: ['nexuscrew'], budgetMs: 20000 },
  }), true);
  assert.strictEqual(validRestartPrompt({
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', client: 'claude',
    mcpReadiness: { cwd: '/tmp/cella', expectedServers: [] },
  }), false, 'attesa vuota: niente gate, il payload non la deve nemmeno portare');
  assert.strictEqual(validRestartPrompt({
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', client: 'claude',
    mcpReadiness: { cwd: '/tmp/cella', expectedServers: ['x'], extra: 1 },
  }), false);
  assert.strictEqual(validRestartPrompt({
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', client: 'altro', readyWaitMs: 1000,
  }), false, 'solo kimi/claude sono classified');
});

// --- runtime: gate anche per celle claude legacy (config nota meno negati) ---
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMcpReadinessPayload, cellMcpExpectedServers } = require('../lib/fleet/runtime.js');

function legacyHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-legacy-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cfg = { mcpServers: { nexuscrew: { command: 'x' }, memory: { command: 'y' } } };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(cfg));
  return home;
}

test('runtime legacy: senza cell.mcp l atteso e la config nota (tutti i server enumerabili)', (t) => {
  const home = legacyHome(t);
  const cell = { id: 'Dev' };
  const p = buildMcpReadinessPayload(cell, '/tmp/cella-legacy', home, {});
  assert.deepStrictEqual(p.expectedServers, ['memory', 'nexuscrew']);
  assert.strictEqual(p.budgetMs, 20000);
  assert.strictEqual(p.cwd, '/tmp/cella-legacy');
});

test('runtime legacy: con cell.mcp parziale l atteso e l intersezione voluti/noti', (t) => {
  const home = legacyHome(t);
  const cell = { id: 'Dev', mcp: ['nexuscrew', 'inesistente'] };
  const p = buildMcpReadinessPayload(cell, '/tmp/cella-legacy', home, {});
  assert.deepStrictEqual(p.expectedServers, ['nexuscrew'], 'server non enumerabile non e atteso');
});

test('runtime legacy: config nota assente -> nessun gate (payload undefined)', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-empty-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const p = buildMcpReadinessPayload({ id: 'Dev' }, '/tmp/cella-legacy', home, {});
  assert.strictEqual(p, undefined);
});

test('runtime: il materializzato cell-mcp vince sempre sulla config legacy', (t) => {
  const home = legacyHome(t);
  const dir = path.join(home, '.nexuscrew', 'cell-mcp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Dev.json'), JSON.stringify({ mcpServers: { soloquesto: { command: 'z' } } }));
  assert.deepStrictEqual(cellMcpExpectedServers(home, 'Dev'), ['soloquesto']);
  const p = buildMcpReadinessPayload({ id: 'Dev' }, '/tmp/cella-strict', home, {});
  assert.deepStrictEqual(p.expectedServers, ['soloquesto']);
});
