'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createLiveBridge, queryThreadStatusOnControlSocket } = require('../lib/live-host/bridge.js');
const { liveHostRoutes } = require('../lib/live-host/routes.js');
const { createLiveHostStore } = require('../lib/live-host/store.js');

// Fake WebSocket con handle espliciti: il controllo V4 conta questi handle,
// invece di dedurre la chiusura dal risultato della Promise.
class FakeControlSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static status = 'Idle';
  static failure = null;
  static instances = [];

  constructor() {
    this.readyState = FakeControlSocket.OPEN;
    this.handlers = new Map();
    FakeControlSocket.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }

  on(name, handler) { this.handlers.set(name, handler); return this; }

  emit(name, value) {
    const handler = this.handlers.get(name);
    if (handler) handler(value);
  }

  send(raw) {
    const message = JSON.parse(String(raw));
    if (message.method === 'initialize') {
      queueMicrotask(() => this.emit('message', JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })));
    } else if (message.method === 'thread/start') {
      queueMicrotask(() => this.emit('message', JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        result: { thread: { id: 'bridge-thread-0001' }, cwd: message.params.cwd },
      })));
    } else if (message.method === 'thread/read') {
      if (FakeControlSocket.failure) {
        queueMicrotask(() => this.emit('error', FakeControlSocket.failure));
        queueMicrotask(() => this.terminate());
      } else {
        queueMicrotask(() => this.emit('message', JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { thread: { id: message.params.threadId, status: { type: FakeControlSocket.status } } },
        })));
      }
    }
  }

  close() { this.terminate(); }

  terminate() {
    if (this.readyState === FakeControlSocket.CLOSED) return;
    this.readyState = FakeControlSocket.CLOSED;
    queueMicrotask(() => this.emit('close'));
  }

  static reset() {
    FakeControlSocket.status = 'Idle';
    FakeControlSocket.failure = null;
    FakeControlSocket.instances = [];
  }

  static openHandleCount() {
    return FakeControlSocket.instances.filter((socket) => socket.readyState !== FakeControlSocket.CLOSED).length;
  }
}

function resetSocket() { FakeControlSocket.reset(); }

test('thread/read traduce assente, presente e attivo e chiude ogni handle', async () => {
  for (const [raw, expected] of [['NotLoaded', 'absent'], ['Idle', 'present'], ['Active', 'active']]) {
    resetSocket();
    FakeControlSocket.status = raw;
    assert.equal(await queryThreadStatusOnControlSocket({
      socketPath: '/tmp/fake.sock', threadId: 'thread-1', timeoutMs: 100,
      WebSocket: FakeControlSocket,
    }), expected, raw);
    assert.equal(FakeControlSocket.openHandleCount(), 0, `${raw}: handle aperti`);
  }
});

test('errore thread/read produce unknown e non lascia handle aperti', async () => {
  resetSocket();
  FakeControlSocket.failure = new Error('read failed');
  await assert.rejects(queryThreadStatusOnControlSocket({
    socketPath: '/tmp/fake.sock', threadId: 'thread-1', timeoutMs: 100,
    WebSocket: FakeControlSocket,
  }));
  assert.equal(FakeControlSocket.openHandleCount(), 0, 'handle rimasti dopo errore');
});

test('bridge cache: due letture ravvicinate fanno una query, dopo scadenza ne fanno un’altra', async () => {
  resetSocket();
  let now = 0;
  const bridge = createLiveBridge({
    cfg: { liveBridgeEnabled: true, liveBridgeTimeoutMs: 100, liveThreadStatusCacheMs: 200, port: 1 },
    fleetP: Promise.resolve({ available: true, status: async () => ({ cells: [
      { cell: 'cloud-Alfa', active: true, tmux: true, tmuxSession: 'cloud-Alfa', engine: 'codex-vl.native', cwd: '/tmp' },
    ] }) }),
    tokenGet: () => 'token',
    fetchImpl: async () => ({ status: 200, json: async () => ({ hostCell: 'cloud-Alfa', eligible: true }) }),
    WebSocket: FakeControlSocket,
    now: () => now,
  });

  const started = await bridge.resolveForLive();
  assert.equal(started.threadId, 'bridge-thread-0001');
  const beforeReads = FakeControlSocket.instances.length;
  FakeControlSocket.status = 'Active';
  const [first, second] = await Promise.all([
    bridge.threadStatus('cloud-Alfa'), bridge.threadStatus('cloud-Alfa'),
  ]);
  assert.equal(first, 'active');
  assert.equal(second, 'active');
  assert.equal(FakeControlSocket.instances.length, beforeReads + 1);

  now = 201;
  assert.equal(await bridge.threadStatus('cloud-Alfa'), 'active');
  assert.equal(FakeControlSocket.instances.length, beforeReads + 2);
  assert.equal(FakeControlSocket.openHandleCount(), 0);
});

test('cache scaduta con query fallita torna unknown, non all’ultimo valore buono', async () => {
  resetSocket();
  let now = 0;
  const bridge = createLiveBridge({
    cfg: { liveBridgeEnabled: true, liveBridgeTimeoutMs: 100, liveThreadStatusCacheMs: 50, port: 1 },
    fleetP: Promise.resolve({ available: true, status: async () => ({ cells: [
      { cell: 'cloud-Alfa', active: true, tmux: true, tmuxSession: 'cloud-Alfa', engine: 'codex-vl.native', cwd: '/tmp' },
    ] }) }),
    tokenGet: () => 'token',
    fetchImpl: async () => ({ status: 200, json: async () => ({ hostCell: 'cloud-Alfa', eligible: true }) }),
    WebSocket: FakeControlSocket,
    now: () => now,
  });

  await bridge.resolveForLive();
  assert.equal(await bridge.threadStatus('cloud-Alfa'), 'present');
  now = 51;
  FakeControlSocket.failure = new Error('read failed');
  assert.equal(await bridge.threadStatus('cloud-Alfa'), 'unknown');
  assert.equal(FakeControlSocket.openHandleCount(), 0);
});

test('GET live-host espone threadStatus e conserva unknown distinto da absent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-thread-route-'));
  const store = createLiveHostStore({ filePath: path.join(dir, 'live-host.json') });
  await store.compareAndSet(0, 'cloud-Alfa');
  let value = 'active';
  const app = express();
  app.use('/api/live-host', liveHostRoutes({
    fleetP: Promise.resolve({
      available: true,
      status: async () => ({ cells: [{ cell: 'cloud-Alfa', active: true }] }),
    }),
    store,
    bridge: { threadStatus: async () => {
      if (value === 'throw') throw new Error('probe failed');
      return value;
    } },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    let response = await fetch(`http://127.0.0.1:${server.address().port}/api/live-host`);
    assert.equal((await response.json()).threadStatus, 'active');
    value = 'throw';
    response = await fetch(`http://127.0.0.1:${server.address().port}/api/live-host`);
    assert.equal((await response.json()).threadStatus, 'unknown');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
