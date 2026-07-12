'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

class FakeWebSocket {
  static sockets = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWebSocket.sockets.push(this); }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  end(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

test('ws client riconnette dopo close transiente e riattacca con size/focus correnti', async () => {
  const oldWs = globalThis.WebSocket;
  const oldLocation = globalThis.location;
  try {
    FakeWebSocket.sockets = [];
    globalThis.WebSocket = FakeWebSocket;
    globalThis.location = { hostname: '127.0.0.1', protocol: 'http:', host: '127.0.0.1:41820' };
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?reconnect=${Date.now()}`);
    const socket = openTerminalSocket({ session: 'work-build', token: 't', cols: 80, rows: 24, focused: true, retryBaseMs: 1 });
    const first = FakeWebSocket.sockets[0]; first.open();
    assert.equal(JSON.parse(first.sent[0]).type, 'attach');
    socket.resize(120, 40);
    first.end(1006);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = FakeWebSocket.sockets[1];
    assert.ok(second, 'secondo websocket creato');
    second.open();
    assert.deepEqual(JSON.parse(second.sent[0]), { type: 'attach', session: 'work-build', token: 't', cols: 120, rows: 40, readonly: false });
    assert.deepEqual(JSON.parse(second.sent[1]), { type: 'focus', on: true });
    socket.close();
  } finally {
    if (oldWs === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = oldWs;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
});

test('ws client non riconnette dopo close intenzionale o errore auth', async () => {
  const oldWs = globalThis.WebSocket;
  const oldLocation = globalThis.location;
  try {
    FakeWebSocket.sockets = [];
    globalThis.WebSocket = FakeWebSocket;
    globalThis.location = { hostname: 'localhost', protocol: 'http:', host: 'localhost:41820' };
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?stop=${Date.now()}`);
    const auth = openTerminalSocket({ session: 'work-build', token: 'bad', cols: 80, rows: 24, retryBaseMs: 1 });
    FakeWebSocket.sockets[0].end(4401);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(FakeWebSocket.sockets.length, 1);
    auth.close();
  } finally {
    if (oldWs === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = oldWs;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
});

test('ws client rende osservabile la consegna: false offline, true quando OPEN', async () => {
  const oldWs = globalThis.WebSocket;
  const oldLocation = globalThis.location;
  try {
    FakeWebSocket.sockets = [];
    globalThis.WebSocket = FakeWebSocket;
    globalThis.location = { hostname: '127.0.0.1', protocol: 'http:', host: '127.0.0.1:41820' };
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?delivery=${Date.now()}`);
    const socket = openTerminalSocket({ session: 'work-build', token: 't', cols: 80, rows: 24 });
    const ws = FakeWebSocket.sockets[0];

    assert.equal(socket.isReady(), false);
    assert.equal(socket.sendInput('non perdere'), false);
    ws.open();
    assert.equal(socket.isReady(), true);
    assert.equal(socket.sendInput('x'.repeat(3000)), true);
    assert.equal(Buffer.from(ws.sent.at(-1)).toString(), 'x'.repeat(3000));
    ws.readyState = 3;
    assert.equal(socket.sendInput('offline di nuovo'), false);
    socket.close();
  } finally {
    if (oldWs === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = oldWs;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
});
