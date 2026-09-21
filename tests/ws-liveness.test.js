'use strict';
// tests/ws-liveness.test.js — il client terminale si accorge da solo di una
// connessione MEZZO-APERTA.
//
// Un tunnel che muore senza FIN non produce nessun close TCP: il browser resta
// convinto di essere connesso e lo schermo si gela. Qui il client manda un ping
// applicativo a cadenza e, se non vede NE' dati NE' pong per il budget, chiude
// e riconnette — senza aspettare un close che non arriverà.
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('il client manda ping applicativi a cadenza', async () => {
  await withFakeWs(async () => {
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?ping=${Date.now()}`);
    const socket = openTerminalSocket({
      session: 'work-build', token: 't', cols: 80, rows: 24,
      pingMs: 30, deadMs: 5000,
    });
    const ws = FakeWebSocket.sockets[0];
    ws.open();
    await wait(150); // ~5 cadenze
    assert.ok(ws.sentTypes().includes('ping'), 'il client deve mandare ping applicativi');
    socket.close();
  });
});

test('senza dati ne\' pong il client chiude e riconnette da solo', async () => {
  await withFakeWs(async () => {
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?dead=${Date.now()}`);
    const socket = openTerminalSocket({
      session: 'work-build', token: 't', cols: 80, rows: 24,
      pingMs: 30, deadMs: 300, retryBaseMs: 1,
    });
    const first = FakeWebSocket.sockets[0];
    first.open();
    // Nessun pong, nessun dato: la connessione è mezzo-aperta.
    await wait(900);
    assert.ok(FakeWebSocket.sockets.length >= 2, 'il client deve aver chiuso e riconnesso da solo');
    socket.close();
  });
});

test('con i pong che arrivano NON riconnette', async () => {
  await withFakeWs(async () => {
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?alive=${Date.now()}`);
    const socket = openTerminalSocket({
      session: 'work-build', token: 't', cols: 80, rows: 24,
      pingMs: 30, deadMs: 300, retryBaseMs: 1,
    });
    const ws = FakeWebSocket.sockets[0];
    ws.open();
    // Ogni ping riceve il suo pong: la liveness è viva.
    const pump = setInterval(() => {
      const ping = ws.sent.findLast?.((s) => { try { return JSON.parse(s).type === 'ping'; } catch { return false; } });
      if (ping) { const t = JSON.parse(ping).t; ws.message(JSON.stringify({ type: 'pong', t })); }
    }, 10);
    await wait(900);
    clearInterval(pump);
    assert.equal(FakeWebSocket.sockets.length, 1, 'con i pong non deve riconnettere');
    socket.close();
  });
});
