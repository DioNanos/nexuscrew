'use strict';
// tests/ws-attachid.test.js — l'attachId è 128 bit CASUALI per (session,node),
// tenuto in sessionStorage (per scheda, mai su disco) e stabile fra riconnessioni.
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
}

function fakeSessionStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

async function withFakeWs(storage, fn) {
  const oldWs = globalThis.WebSocket;
  const oldLocation = globalThis.location;
  const oldStorage = globalThis.sessionStorage;
  try {
    FakeWebSocket.sockets = [];
    globalThis.WebSocket = FakeWebSocket;
    globalThis.location = { hostname: '127.0.0.1', protocol: 'http:', host: '127.0.0.1:41820' };
    if (storage) globalThis.sessionStorage = storage; else delete globalThis.sessionStorage;
    await fn();
  } finally {
    if (oldWs === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = oldWs;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
    if (oldStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = oldStorage;
  }
}

const attachIdOf = (url) => new URL(url).searchParams.get('attachId');

test('client: l\'URL di upgrade porta un attachId di 128 bit casuali', async () => {
  await withFakeWs(fakeSessionStorage(), async () => {
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?aid=${Date.now()}`);
    const socket = openTerminalSocket({ session: 'work-build', node: 'hub/peer', token: 't', cols: 80, rows: 24, retryBaseMs: 1 });
    const url = FakeWebSocket.sockets[0].url;
    const id = attachIdOf(url);
    assert.match(id, /^[0-9a-f]{32}$/, 'attacheadId di 128 bit in esadecimale');
    assert.equal(new URL(url).searchParams.get('attachSession'), 'work-build', 'la session viaggia con l\'id');
    socket.close();
  });
});

test('client: lo stesso (session,node) riusa lo stesso attachId; un altro no', async () => {
  await withFakeWs(fakeSessionStorage(), async () => {
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?stable=${Date.now()}`);
    const a = openTerminalSocket({ session: 'work-build', node: 'hub/peer', token: 't', cols: 80, rows: 24, retryBaseMs: 1 });
    const idA = attachIdOf(FakeWebSocket.sockets[0].url);
    // Caduta e ritorno: l'id NON cambia (è la chiave dell'aggancio).
    FakeWebSocket.sockets[0].open();
    FakeWebSocket.sockets[0].end(1006);
    await new Promise((r) => setTimeout(r, 10));
    FakeWebSocket.sockets[1].open();
    assert.equal(attachIdOf(FakeWebSocket.sockets[1].url), idA, 'lo stesso id al ritorno');
    a.close();

    const b = openTerminalSocket({ session: 'altra-sessione', node: 'hub/peer', token: 't', cols: 80, rows: 24, retryBaseMs: 1 });
    const urlB = FakeWebSocket.sockets.at(-1).url;
    assert.notEqual(attachIdOf(urlB), idA, 'un\'altra sessione ha il suo id');
    b.close();
  });
});

test('client: senza sessionStorage non si inventa un id (nessun aggancio)', async () => {
  await withFakeWs(null, async () => {
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?nostorage=${Date.now()}`);
    const socket = openTerminalSocket({ session: 'work-build', node: 'hub/peer', token: 't', cols: 80, rows: 24, retryBaseMs: 1 });
    assert.equal(attachIdOf(FakeWebSocket.sockets[0].url), null, 'niente id: il proxy farà una attach nuova');
    socket.close();
  });
});
