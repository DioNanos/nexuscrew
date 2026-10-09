'use strict';
// tests/live-registry.test.js — registro persistito dei thread Live.
//
// Il registro sta accanto a live-host.json e sopravvive al riavvio del server:
// prima viveva in tre Map in memoria del ponte, quindi dopo un riavvio la Live
// ancora viva nel daemon risultava «thread assente».
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { createLiveThreadRegistry, liveThreadsPath } = require('../lib/live-host/registry.js');
const { createLiveBridge } = require('../lib/live-host/bridge.js');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'live-reg-'));

test('liveThreadsPath: accanto a live-host.json, stessa convenzione', () => {
  assert.equal(liveThreadsPath({ tokenPath: '/x/y/token' }), '/x/y/live-threads.json');
  assert.equal(liveThreadsPath({ liveThreadsPath: '/z/t.json' }), '/z/t.json');
  assert.equal(liveThreadsPath({ home: '/h' }), '/h/.nexuscrew/live-threads.json');
});

test('il registro persiste: una nuova istanza rilegge cio\' che l\'altra ha scritto', () => {
  const file = path.join(dir(), 'live-threads.json');
  const a = createLiveThreadRegistry({ filePath: file, now: () => 7 });
  a.set('Dev', { threadId: 'thr-1', ref: 'a'.repeat(32), tmuxSession: 'cloud-Dev' });
  const b = createLiveThreadRegistry({ filePath: file });
  assert.deepEqual(b.get('Dev'), { threadId: 'thr-1', ref: 'a'.repeat(32), tmuxSession: 'cloud-Dev', startedAt: 7 });
  assert.equal(b.findByRef('a'.repeat(32)).cell, 'Dev');
  assert.equal(b.findByRef('b'.repeat(32)), null);
  b.remove('Dev');
  assert.equal(createLiveThreadRegistry({ filePath: file }).get('Dev'), null);
});

test('il registro rifiuta voci malformate e un file corrotto vale vuoto', () => {
  const file = path.join(dir(), 'live-threads.json');
  const r = createLiveThreadRegistry({ filePath: file });
  assert.throws(() => r.set('../x', { threadId: 't', ref: 'a'.repeat(32) }));
  assert.throws(() => r.set('Dev', { threadId: '', ref: 'a'.repeat(32) }));
  assert.throws(() => r.set('Dev', { threadId: 't', ref: 'non-esadecimale' }));
  fs.writeFileSync(file, '{{{ non json', { mode: 0o600 });
  assert.deepEqual(createLiveThreadRegistry({ filePath: file }).entries(), []);
  // un file con permessi larghi non si legge e non si crede: nessun riferimento valido
  const wide = path.join(dir(), 'live-threads.json');
  fs.writeFileSync(wide, JSON.stringify({ version: 1, threads: { Dev: { threadId: 't', ref: 'a'.repeat(32) } } }), { mode: 0o666 });
  fs.chmodSync(wide, 0o666);
  const w = createLiveThreadRegistry({ filePath: wide });
  assert.equal(w.get('Dev'), null);
  assert.equal(w.findByRef('a'.repeat(32)), null);
});

// Daemon finto minimo: risponde a thread/read con lo stato configurato per id.
function fakeDaemon(socketPath, statusOf) {
  const server = http.createServer((_q, res) => { res.writeHead(426); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.method === 'initialize') ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'f', codexHome: '/tmp' } }));
      else if (msg.method === 'thread/read') {
        Promise.resolve(statusOf(msg.params.threadId)).then((s) => {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: msg.params.threadId, status: { type: s } } } }));
        });
      }
    });
  }));
  return {
    listen: () => new Promise((resolve) => { try { fs.rmSync(socketPath, { force: true }); } catch (_) { /* assente */ } server.listen(socketPath, resolve); }),
    close: () => new Promise((resolve) => { wss.clients.forEach((c) => c.terminate()); server.close(resolve); }),
  };
}

test('dopo un riavvio la Live viva nel daemon resta visibile (registro persistito)', async (t) => {
  const d = dir();
  const socketPath = path.join(d, 'c.sock');
  const daemon = fakeDaemon(socketPath, () => 'idle');
  await daemon.listen();
  t.after(() => daemon.close());
  const file = path.join(d, 'live-threads.json');
  createLiveThreadRegistry({ filePath: file }).set('Dev', { threadId: 'thr-1', ref: 'c'.repeat(32), tmuxSession: 'cloud-Dev' });
  // «riavvio»: un ponte nuovo, un registro nuovo sullo stesso file.
  const cfg = { port: 1, liveBridgeEnabled: true, liveBridgeSocketPath: socketPath, liveBridgeTimeoutMs: 1500, filesRoot: d };
  const bridge = createLiveBridge({
    cfg, fleetP: Promise.resolve({ available: true }), tokenGet: () => 't', filesRoot: d,
    registry: createLiveThreadRegistry({ filePath: file }),
  });
  assert.equal(await bridge.threadStatus('Dev'), 'present');
});

test('reconcile all\'avvio toglie dal registro i thread che il daemon dichiara assenti, tiene gli incerti', async (t) => {
  const d = dir();
  const socketPath = path.join(d, 'c.sock');
  const status = { 'thr-ok': 'idle', 'thr-gone': 'notLoaded', 'thr-err': 'systemError' };
  const daemon = fakeDaemon(socketPath, (id) => status[id]);
  await daemon.listen();
  t.after(() => daemon.close());
  const file = path.join(d, 'live-threads.json');
  const reg = createLiveThreadRegistry({ filePath: file });
  reg.set('Ok', { threadId: 'thr-ok', ref: '1'.repeat(32), tmuxSession: 'cloud-Ok' });
  reg.set('Gone', { threadId: 'thr-gone', ref: '2'.repeat(32), tmuxSession: 'cloud-Gone' });
  reg.set('Err', { threadId: 'thr-err', ref: '3'.repeat(32), tmuxSession: 'cloud-Err' });
  const cfg = { port: 1, liveBridgeEnabled: true, liveBridgeSocketPath: socketPath, liveBridgeTimeoutMs: 1500, filesRoot: d };
  const bridge = createLiveBridge({ cfg, fleetP: Promise.resolve({ available: true }), tokenGet: () => 't', filesRoot: d, registry: reg });
  const out = await bridge.reconcile();
  assert.deepEqual(out.removed, ['Gone']);
  assert.deepEqual(reg.entries().map((e) => e.cell).sort(), ['Err', 'Ok']);
  // persistito: la rimozione sopravvive a un'altra istanza
  assert.deepEqual(createLiveThreadRegistry({ filePath: file }).entries().map((e) => e.cell).sort(), ['Err', 'Ok']);
});

test('a thread the daemon reports as gone is removed from the registry when its status is read', async (t) => {
  const d = dir();
  const socketPath = path.join(d, 'c.sock');
  const status = { value: 'notLoaded' };
  const daemon = fakeDaemon(socketPath, () => status.value);
  await daemon.listen();
  t.after(() => daemon.close());
  const file = path.join(d, 'live-threads.json');
  const reg = createLiveThreadRegistry({ filePath: file });
  reg.set('Dev', { threadId: 'thr-1', ref: 'a'.repeat(32), tmuxSession: 'cloud-Dev' });
  const cfg = { port: 1, liveBridgeEnabled: true, liveBridgeSocketPath: socketPath, liveBridgeTimeoutMs: 1500, liveThreadStatusCacheMs: 0, filesRoot: d };
  const bridge = createLiveBridge({ cfg, fleetP: Promise.resolve({ available: true }), tokenGet: () => 't', filesRoot: d, registry: reg });
  // alive or uncertain: the entry stays
  status.value = 'idle';
  assert.equal(await bridge.threadStatus('Dev'), 'present');
  status.value = 'systemError';
  assert.equal(await bridge.threadStatus('Dev'), 'unknown');
  assert.ok(reg.get('Dev'), 'an uncertain answer never removes the entry');
  // gone: the answer is absent and the entry is dropped, on disk too
  status.value = 'notLoaded';
  assert.equal(await bridge.threadStatus('Dev'), 'absent');
  assert.equal(reg.get('Dev'), null);
  assert.equal(createLiveThreadRegistry({ filePath: file }).get('Dev'), null);
  assert.equal(reg.findByRef('a'.repeat(32)), null, 'the reference stops resolving');
});

test('a socket failure never removes a registry entry', async (t) => {
  const d = dir();
  const file = path.join(d, 'live-threads.json');
  const reg = createLiveThreadRegistry({ filePath: file });
  reg.set('Dev', { threadId: 'thr-1', ref: 'a'.repeat(32), tmuxSession: 'cloud-Dev' });
  const cfg = { port: 1, liveBridgeEnabled: true, liveBridgeSocketPath: path.join(d, 'nobody.sock'), liveBridgeTimeoutMs: 300, liveThreadStatusCacheMs: 0, filesRoot: d };
  const bridge = createLiveBridge({ cfg, fleetP: Promise.resolve({ available: true }), tokenGet: () => 't', filesRoot: d, registry: reg });
  assert.equal(await bridge.threadStatus('Dev'), 'unknown');
  assert.ok(reg.get('Dev'));
  void t;
});

test('the registry is bounded: the oldest entries go when it grows past its limit', () => {
  const file = path.join(dir(), 'live-threads.json');
  let clock = 0;
  const reg = createLiveThreadRegistry({ filePath: file, now: () => ++clock });
  const limit = createLiveThreadRegistry.MAX_ENTRIES;
  assert.ok(Number.isInteger(limit) && limit > 0);
  for (let i = 0; i < limit + 5; i += 1) {
    reg.set(`cell-${i}`, { threadId: `thr-${i}`, ref: i.toString(16).padStart(32, '0') });
  }
  const names = reg.entries().map((e) => e.cell);
  assert.equal(names.length, limit);
  assert.ok(!names.includes('cell-0') && !names.includes('cell-4'), 'the oldest are evicted');
  assert.ok(names.includes(`cell-${limit + 4}`), 'the newest stays');
  // overwriting an existing cell does not count twice
  reg.set(`cell-${limit + 4}`, { threadId: 'thr-new', ref: 'f'.repeat(32) });
  assert.equal(reg.entries().length, limit);
});

// A status read started on the old thread must not remove the entry of a newer
// Live that replaced it while the read was in flight.
test('a late "gone" answer for the old thread does not remove the replacement entry', async (t) => {
  const d = dir();
  const socketPath = path.join(d, 'c.sock');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const daemon = fakeDaemon(socketPath, async () => { await gate; return 'notLoaded'; });
  await daemon.listen();
  t.after(() => daemon.close());
  const file = path.join(d, 'live-threads.json');
  const reg = createLiveThreadRegistry({ filePath: file });
  reg.set('Dev', { threadId: 'thr-old', ref: 'a'.repeat(32), tmuxSession: 'cloud-Dev' });
  const cfg = { port: 1, liveBridgeEnabled: true, liveBridgeSocketPath: socketPath, liveBridgeTimeoutMs: 5000, liveThreadStatusCacheMs: 0, filesRoot: d };
  const bridge = createLiveBridge({ cfg, fleetP: Promise.resolve({ available: true }), tokenGet: () => 't', filesRoot: d, registry: reg });
  const pending = bridge.threadStatus('Dev');
  await new Promise((r) => setTimeout(r, 50)); // the read is in flight
  reg.set('Dev', { threadId: 'thr-new', ref: 'b'.repeat(32), tmuxSession: 'cloud-Dev' });
  release();
  assert.equal(await pending, 'absent');
  assert.equal(reg.get('Dev').threadId, 'thr-new', 'the replacement entry survives');
  assert.equal(reg.findByRef('b'.repeat(32)).cell, 'Dev');
});

test('startup reconciliation does not remove an entry replaced while it was reading', async (t) => {
  const d = dir();
  const socketPath = path.join(d, 'c.sock');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const daemon = fakeDaemon(socketPath, async () => { await gate; return 'notLoaded'; });
  await daemon.listen();
  t.after(() => daemon.close());
  const reg = createLiveThreadRegistry({ filePath: path.join(d, 'live-threads.json') });
  reg.set('Dev', { threadId: 'thr-old', ref: 'a'.repeat(32), tmuxSession: 'cloud-Dev' });
  const cfg = { port: 1, liveBridgeEnabled: true, liveBridgeSocketPath: socketPath, liveBridgeTimeoutMs: 5000, filesRoot: d };
  const bridge = createLiveBridge({ cfg, fleetP: Promise.resolve({ available: true }), tokenGet: () => 't', filesRoot: d, registry: reg });
  const running = bridge.reconcile();
  await new Promise((r) => setTimeout(r, 50));
  reg.set('Dev', { threadId: 'thr-new', ref: 'b'.repeat(32), tmuxSession: 'cloud-Dev' });
  release();
  const out = await running;
  assert.deepEqual(out.removed, [], 'nothing removed: the entry is not the one that was read');
  assert.equal(reg.get('Dev').threadId, 'thr-new');
});

test('remove with an expected thread id only removes that thread', () => {
  const reg = createLiveThreadRegistry({ filePath: path.join(dir(), 'live-threads.json') });
  reg.set('Dev', { threadId: 'thr-1', ref: 'a'.repeat(32) });
  assert.equal(reg.remove('Dev', 'thr-other'), false);
  assert.ok(reg.get('Dev'));
  assert.equal(reg.remove('Dev', 'thr-1'), true);
  assert.equal(reg.get('Dev'), null);
});
