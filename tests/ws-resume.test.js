'use strict';
// tests/ws-resume.test.js — lato client: i frame di output portano il seq e
// al ritorno si chiede SOLO il tratto mancante.
const { test } = require('node:test');
const assert = require('node:assert');

class FakeWebSocket {
  static sockets = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.binaryType = 'blob'; FakeWebSocket.sockets.push(this); }
  send(value) { this.sent.push(value); }
  close(code = 1005) { this.readyState = 3; this.onclose?.({ code }); }
  open() { this.readyState = 1; this.onopen?.(); }
  end(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  message(value) { this.onmessage?.({ data: value }); }
  jsonSent() { return this.sent.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean); }
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

// Frame di output come li manda il bridge: [seq 4 byte BE][payload].
function outFrame(seq, text) {
  const payload = Buffer.from(text, 'utf8');
  const buf = new ArrayBuffer(4 + payload.length);
  new DataView(buf).setUint32(0, seq);
  new Uint8Array(buf).set(payload, 4);
  return buf;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('client: il seq viene letto dall\'header e il payload arriva integro', async () => {
  await withFakeWs(async () => {
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?seq=${Date.now()}`);
    const chunks = [];
    const socket = openTerminalSocket({
      session: 'work-build', token: 't', cols: 80, rows: 24, retryBaseMs: 1,
      onData: (bytes) => chunks.push(Buffer.from(bytes).toString('utf8')),
    });
    const ws = FakeWebSocket.sockets[0];
    ws.open();
    ws.message(outFrame(7, 'CIAO'));
    assert.deepEqual(chunks, ['CIAO'], 'il payload non deve contenere i 4 byte di seq');
    socket.close();
  });
});

test('client: al riconnect chiede la ripresa dall\'ultimo seq ricevuto', async () => {
  await withFakeWs(async () => {
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?resume=${Date.now()}`);
    const socket = openTerminalSocket({ session: 'work-build', token: 't', cols: 80, rows: 24, retryBaseMs: 1 });
    const first = FakeWebSocket.sockets[0];
    first.open();
    first.message(outFrame(7, 'CIAO'));
    first.end(1006);
    await wait(15);
    const second = FakeWebSocket.sockets[1];
    assert.ok(second, 'riconnesso');
    second.open();
    const resume = second.jsonSent().find((m) => m.type === 'resume');
    assert.ok(resume, 'deve chiedere la ripresa');
    assert.equal(resume.seq, 7, 'dal seq effettivamente ricevuto');
    socket.close();
  });
});

test('client: resync-needed fa chiedere il repaint dal pane', async () => {
  await withFakeWs(async () => {
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?need=${Date.now()}`);
    const socket = openTerminalSocket({ session: 'work-build', token: 't', cols: 80, rows: 24, retryBaseMs: 1 });
    const first = FakeWebSocket.sockets[0];
    first.open();
    first.message(outFrame(7, 'CIAO'));
    first.end(1006);
    await wait(15);
    const second = FakeWebSocket.sockets[1];
    second.open();
    const before = second.jsonSent().length;
    second.message(JSON.stringify({ type: 'resync-needed' }));
    const after = second.jsonSent().slice(before);
    assert.ok(after.some((m) => m.type === 'resync'), 'il repaint dal capture-pane è la via di recupero');
    socket.close();
  });
});
