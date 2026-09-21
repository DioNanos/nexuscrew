'use strict';
// tests/ws-input-queue.test.js — i tasti digitati mentre il canale è giù non
// si perdono: si accodano (cap 4 KB) e partono in ordine al ritorno.
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
  textSent() { return this.sent.filter((s) => typeof s === 'string'); }
  binaryText() { return this.sent.filter((s) => typeof s !== 'string').map((b) => Buffer.from(b).toString('utf8')); }
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

test('i tasti digitati da disconnesso partono in ordine al ritorno', async () => {
  await withFakeWs(async () => {
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?q=${Date.now()}`);
    const socket = openTerminalSocket({ session: 'work-build', token: 't', cols: 80, rows: 24, retryBaseMs: 1 });
    const first = FakeWebSocket.sockets[0];
    first.open();
    first.end(1006); // canale giù
    await wait(10);

    // L'utente continua a digitare: niente va perso.
    assert.equal(socket.sendInput('a'), true, 'offline accoda, non rifiuta');
    assert.equal(socket.sendInput('bb'), true);
    assert.equal(socket.sendInput('ccc'), true);

    const second = FakeWebSocket.sockets[1];
    assert.ok(second, 'riconnesso');
    second.open();
    assert.deepEqual(second.binaryText(), ['a', 'bb', 'ccc'], 'in ordine, al ritorno');
    socket.close();
  });
});

test('oltre il cap l\'input viene rifiutato, non accodato in silenzio', async () => {
  await withFakeWs(async () => {
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?cap=${Date.now()}`);
    const socket = openTerminalSocket({
      session: 'work-build', token: 't', cols: 80, rows: 24, retryBaseMs: 1, queuedInputBytes: 8,
    });
    const first = FakeWebSocket.sockets[0];
    first.open();
    first.end(1006);
    await wait(10);

    assert.equal(socket.sendInput('12345'), true, 'dentro il cap: accodato');
    assert.equal(socket.sendInput('67890'), false, 'oltre il cap: rifiutato');
    socket.close();
  });
});

test('la coda si svuota davvero (nessun doppio invio al ritorno successivo)', async () => {
  await withFakeWs(async () => {
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?once=${Date.now()}`);
    const socket = openTerminalSocket({ session: 'work-build', token: 't', cols: 80, rows: 24, retryBaseMs: 1 });
    const first = FakeWebSocket.sockets[0];
    first.open();
    first.end(1006);
    await wait(10);
    socket.sendInput('x');
    const second = FakeWebSocket.sockets[1];
    second.open();
    assert.deepEqual(second.binaryText(), ['x']);
    second.end(1006);
    await wait(10);
    const third = FakeWebSocket.sockets[2];
    third.open();
    assert.deepEqual(third.binaryText(), [], 'la coda non si ripete');
    socket.close();
  });
});
