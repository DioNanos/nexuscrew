'use strict';
// D-342 — gate readiness MCP in deliverBootstrapPrompt (claude.*).
// Casi R6: consegna con MCP pronti; degradato visibile a budget esaurito;
// cancellazione durante l'attesa MCP (zero paste); composer non pronto a
// timeout resta bloccante (il gate MCP non bypassa mai il composer).
const { test } = require('node:test');
const assert = require('node:assert');

const { deliverBootstrapPrompt } = require('../lib/fleet/prompt-delivery.js');

function seams({ captures, pasteOk = true, enterOk = true } = {}) {
  const order = [];
  let n = 0;
  return {
    order,
    captureImpl: async () => (n < captures.length ? captures[n++] : captures[captures.length - 1]),
    tmuxExecImpl: async (bin, args) => {
      order.push(args.join(' '));
      if (args[0] === 'list-panes') {
        return { err: null, stdout: '%0\n', stderr: '', code: 0 };
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

test('cancel durante attesa MCP: esito cancelled, ZERO paste (R6 at-most-once)', async () => {
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