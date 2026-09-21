'use strict';
// tests/terminal-params.test.js — i parametri del terminale devono AGIRE: se la
// config del server li cambia, il client che non riceve override li usa. Senza
// questo cablaggio i parametri restano inerti (il difetto segnalato in audit).
const { test } = require('node:test');
const assert = require('node:assert');

class FakeWebSocket {
  static sockets = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWebSocket.sockets.push(this); }
  send(value) { this.sent.push(value); }
  close(code = 1005) { this.readyState = 3; this.onclose?.({ code }); }
  open() { this.readyState = 1; this.onopen?.(); }
  end(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  message(value) { this.onmessage?.({ data: value }); }
  sentTypes() { return this.sent.map((s) => { try { return JSON.parse(s).type; } catch { return 'binary'; } }); }
}

async function withFakeWs(fn) {
  const oldWs = globalThis.WebSocket;
  const oldLocation = globalThis.location;
  try {
    FakeWebSocket.sockets = [];
    globalThis.WebSocket = FakeWebSocket;
    globalThis.location = { hostname: '127.0.0.1', protocol: 'http:', host: '127.0.0.1:41820' };
    await fn();
  } finally {
    if (oldWs === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = oldWs;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(10); }
  return false;
};
// Import SENZA cache-buster: e' la stessa istanza di modulo che usa ws-client.
const cfg = () => import('../frontend/src/lib/terminal-runtime-config.js');

test('config del server: liveness e coda del client seguono i valori configurati', async () => {
  await withFakeWs(async () => {
    const mod = await cfg();
    mod.setTerminalRuntimeConfig({ pingMs: 30, deadMs: 300, queuedInputBytes: 8, retryBaseMs: 1, retryMaxMs: 4, overlayDelayMs: 1000 });
    try {
      const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?cfg=${Date.now()}`);
      // NESSUN override: il client deve prendere i valori dalla config.
      const socket = openTerminalSocket({ session: 'work-build', token: 't', cols: 80, rows: 24 });
      const ws = FakeWebSocket.sockets[0];
      ws.open();
      // Attese su CONDIZIONE: sotto carico un tempo fisso misura la macchina.
      assert.ok(await waitFor(() => ws.sentTypes().includes('ping')), 'il ping parte alla cadenza configurata');

      // deadMs configurato senza pong: il client chiude da solo e riconnette.
      assert.ok(await waitFor(() => FakeWebSocket.sockets.length >= 2), 'il budget di silenzio configurato fa riconnettere');

      // Cap della coda = 8 byte: oltre, rifiuto esplicito.
      const second = FakeWebSocket.sockets.at(-1);
      second.open();
      second.end(1006);
      await wait(20);
      assert.equal(socket.sendInput('12345'), true, 'dentro il cap configurato');
      assert.equal(socket.sendInput('67890'), false, 'oltre il cap configurato');
      socket.close();
    } finally {
      mod.setTerminalRuntimeConfig(null);
    }
  });
});

test('config del server: valori invalidi non entrano (restano i default)', async () => {
  await withFakeWs(async () => {
    const mod = await cfg();
    mod.setTerminalRuntimeConfig({ pingMs: -5, deadMs: 'x', queuedInputBytes: 0, retryBaseMs: null, retryMaxMs: NaN, overlayDelayMs: undefined });
    try {
      assert.equal(mod.terminalRuntimeConfig().deadMs, mod.TERMINAL_RUNTIME_DEFAULTS.deadMs);
      assert.equal(mod.terminalRuntimeConfig().pingMs, mod.TERMINAL_RUNTIME_DEFAULTS.pingMs);
    } finally {
      mod.setTerminalRuntimeConfig(null);
    }
  });
});
