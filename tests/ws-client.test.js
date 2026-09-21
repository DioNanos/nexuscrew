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
  message(value) { this.onmessage?.({ data: value }); }
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

test('ws client conserva la capability server-side per il reconnect', async () => {
  const oldWs = globalThis.WebSocket;
  const oldLocation = globalThis.location;
  try {
    FakeWebSocket.sockets = [];
    globalThis.WebSocket = FakeWebSocket;
    globalThis.location = { hostname: '127.0.0.1', protocol: 'http:', host: '127.0.0.1:41820' };
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?grace=${Date.now()}`);
    const socket = openTerminalSocket({ session: 'work-build', token: 't', cols: 80, rows: 24, retryBaseMs: 1 });
    const first = FakeWebSocket.sockets[0];
    first.open();
    first.message(JSON.stringify({ type: 'attached', reconnectToken: 'server-capability' }));
    first.end(1006);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = FakeWebSocket.sockets[1];
    second.open();
    assert.equal(JSON.parse(second.sent[0]).reconnectToken, 'server-capability');
    socket.close();
  } finally {
    if (oldWs === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = oldWs;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
});

test('ws client aumenta il backoff se le aperture cadono prima della stabilità', async () => {
  const oldWs = globalThis.WebSocket;
  const oldLocation = globalThis.location;
  try {
    FakeWebSocket.sockets = [];
    globalThis.WebSocket = FakeWebSocket;
    globalThis.location = { hostname: '127.0.0.1', protocol: 'http:', host: '127.0.0.1:41820' };
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?backoff=${Date.now()}`);
    const delays = [];
    const socket = openTerminalSocket({
      session: 'work-build', token: 't', cols: 80, rows: 24,
      retryBaseMs: 10, retryStableMs: 1000,
      onRetryScheduled: (delay) => delays.push(delay),
    });
    for (let i = 0; i < 4; i++) {
      const current = FakeWebSocket.sockets.at(-1);
      current.open();
      current.end(1006);
      await new Promise((resolve) => {
        const poll = () => FakeWebSocket.sockets.length > i + 1 ? resolve() : setTimeout(poll, 1);
        poll();
      });
    }
    assert.deepEqual(delays, [10, 20, 40, 80], `backoff effettivo: ${delays.join(',')}ms`);
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

test('ws client cleanup annulla un reconnect già schedulato', async () => {
  const oldWs = globalThis.WebSocket; const oldLocation = globalThis.location;
  try {
    FakeWebSocket.sockets = []; globalThis.WebSocket = FakeWebSocket;
    globalThis.location = { hostname: 'localhost', protocol: 'http:', host: 'localhost:41820' };
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?cleanup=${Date.now()}`);
    const socket = openTerminalSocket({ session: 'work-build', token: 't', cols: 80, rows: 24, retryBaseMs: 20 });
    FakeWebSocket.sockets[0].end(1006);
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(FakeWebSocket.sockets.length, 1, 'cleanup prevents an orphan socket after unmount');
  } finally {
    if (oldWs === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = oldWs;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
});

test('ws client marks a terminal exit final until GridTile creates the next generation', async () => {
  const oldWs = globalThis.WebSocket; const oldLocation = globalThis.location;
  try {
    FakeWebSocket.sockets = []; globalThis.WebSocket = FakeWebSocket;
    globalThis.location = { hostname: 'localhost', protocol: 'http:', host: 'localhost:41820' };
    const exits = [];
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?ended=${Date.now()}`);
    const socket = openTerminalSocket({ session: 'work-build', token: 't', cols: 80, rows: 24, retryBaseMs: 1, onExit: (code) => exits.push(code) });
    const ws = FakeWebSocket.sockets[0]; ws.open(); ws.message(JSON.stringify({ type: 'exit', code: 0 })); ws.end(1006);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(exits, [0]);
    assert.equal(FakeWebSocket.sockets.length, 1, 'ended transcript does not reconnect by itself');
    socket.close();
  } finally {
    if (oldWs === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = oldWs;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
});

// Il contratto della consegna (aggiornato con ): ONLINE il byte parte subito;
// OFFLINE non si perde — si accoda (true) e parte in ordine al ritorno. Il
// `false` resta per il solo caso in cui la coda e' piena.
test('ws client: online consegna subito, offline accoda (la coda piena rifiuta)', async () => {
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
    assert.equal(socket.sendInput('non perdere'), true, 'offline accoda');
    ws.open();
    assert.equal(socket.isReady(), true);
    assert.equal(socket.sendInput('x'.repeat(3000)), true, 'online consegna');
    assert.equal(Buffer.from(ws.sent.at(-1)).toString(), 'x'.repeat(3000));
    ws.readyState = 3;
    assert.equal(socket.sendInput('offline di nuovo'), true, 'offline accoda ancora');
    socket.close();
  } finally {
    if (oldWs === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = oldWs;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
});

// ---- Streaming resiliente: resync al riconnect, chiusure terminali solo
// ---- auth/acl/sessione, stato del link per l'overlay.

test('ws client alla riconnessione chiede il resync e consegna lo snapshot', async () => {
  const oldWs = globalThis.WebSocket;
  const oldLocation = globalThis.location;
  try {
    FakeWebSocket.sockets = [];
    globalThis.WebSocket = FakeWebSocket;
    globalThis.location = { hostname: '127.0.0.1', protocol: 'http:', host: '127.0.0.1:41820' };
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?resync=${Date.now()}`);
    const snapshots = [];
    const socket = openTerminalSocket({
      session: 'work-build', token: 't', cols: 80, rows: 24, retryBaseMs: 1,
      onSnapshot: (data) => snapshots.push(data),
    });
    const first = FakeWebSocket.sockets[0];
    first.open();
    first.message(JSON.stringify({ type: 'attached', reconnectToken: 'cap' }));
    first.end(1006);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = FakeWebSocket.sockets[1];
    assert.ok(second, 'riconnesso');
    second.open();
    const sentTypes = second.sent.map((s) => JSON.parse(s).type);
    assert.ok(sentTypes.includes('resync'), 'il riconnect chiede il resync');
    second.message(JSON.stringify({ type: 'snapshot', data: 'REPAINT-DAL-CAPTURE' }));
    assert.deepEqual(snapshots, ['REPAINT-DAL-CAPTURE']);
    socket.close();
  } finally {
    if (oldWs === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = oldWs;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
});

test('ws client riconnette anche su close 1000 pulito (solo 4401/4403/4404 sono terminali)', async () => {
  const oldWs = globalThis.WebSocket;
  const oldLocation = globalThis.location;
  try {
    FakeWebSocket.sockets = [];
    globalThis.WebSocket = FakeWebSocket;
    globalThis.location = { hostname: '127.0.0.1', protocol: 'http:', host: '127.0.0.1:41820' };
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?c1000=${Date.now()}`);
    const socket = openTerminalSocket({ session: 'work-build', token: 't', cols: 80, rows: 24, retryBaseMs: 1 });
    const first = FakeWebSocket.sockets[0];
    first.open();
    first.end(1000); // riavvio del servizio con chiusura pulita, senza 'exit'
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(FakeWebSocket.sockets[1], 'riconnette dopo 1000');
    socket.close();
  } finally {
    if (oldWs === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = oldWs;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
});

test('ws client NON riconnette su 4401/4403/4404 (auth/acl/sessione)', async () => {
  const oldWs = globalThis.WebSocket;
  const oldLocation = globalThis.location;
  try {
    for (const code of [4401, 4403, 4404]) {
      FakeWebSocket.sockets = [];
      globalThis.WebSocket = FakeWebSocket;
      globalThis.location = { hostname: '127.0.0.1', protocol: 'http:', host: '127.0.0.1:41820' };
      const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?term${code}=${Date.now()}`);
      const socket = openTerminalSocket({ session: 'work-build', token: 't', cols: 80, rows: 24, retryBaseMs: 1 });
      const first = FakeWebSocket.sockets[0];
      first.open();
      first.end(code);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(FakeWebSocket.sockets.length, 1, `nessun reconnect dopo ${code}`);
      socket.close();
    }
  } finally {
    if (oldWs === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = oldWs;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
});

test('ws client segnala lo stato del link (reconnecting/live) per l\'overlay', async () => {
  const oldWs = globalThis.WebSocket;
  const oldLocation = globalThis.location;
  try {
    FakeWebSocket.sockets = [];
    globalThis.WebSocket = FakeWebSocket;
    globalThis.location = { hostname: '127.0.0.1', protocol: 'http:', host: '127.0.0.1:41820' };
    const { openTerminalSocket } = await import(`../frontend/src/lib/ws-client.js?link=${Date.now()}`);
    const linkStates = [];
    const socket = openTerminalSocket({
      session: 'work-build', token: 't', cols: 80, rows: 24, retryBaseMs: 1,
      onLink: (state) => linkStates.push(state),
    });
    const first = FakeWebSocket.sockets[0];
    first.open();
    first.end(1006);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(linkStates.includes('reconnecting'), 'la caduta viene segnala come reconnecting');
    const second = FakeWebSocket.sockets[1];
    second.open();
    second.message(JSON.stringify({ type: 'link', state: 'live' }));
    assert.ok(linkStates.includes('live'), 'il live dichiarato dal server arriva all\'overlay');
    socket.close();
  } finally {
    if (oldWs === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = oldWs;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
});
