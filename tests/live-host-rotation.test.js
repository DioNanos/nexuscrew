'use strict';
// Attestazione della Live durante una rotazione del thread. L'etichetta «Live» si
// guadagna per una tupla (cella, thread, riferimento): una lettura in volo del
// thread vecchio non puo' attestare ne' il riferimento vecchio dopo la rotazione
// ne' quello nuovo, e non deve ripopolare la cache del thread nuovo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const express = require('express');

const { createLiveThreadRegistry } = require('../lib/live-host/registry.js');
const { createLiveAttestation } = require('../lib/live-host/attest.js');
const { createLiveBridge } = require('../lib/live-host/bridge.js');
const { cellsRoutes } = require('../lib/cells/routes.js');

const OLD_REF = 'd'.repeat(32);
const NODE = 'a'.repeat(32);
// Attende una condizione, ma mai all'infinito: un'attesa che non arriva e' un'asserzione fallita.
const until = async (pred, what = 'condition') => {
  const deadline = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out waiting for ${what}` });
    await new Promise((r) => setImmediate(r));
  }
};

// Un daemon finto: ogni lettura di thread resta sospesa finche' il test non la rilascia;
// lo stato risposto e' per thread (default notLoaded = assente).
function makeDaemon(statusByThread) {
  const pending = [];
  const seen = [];
  class Socket extends EventEmitter {
    static OPEN = 1;
    constructor() { super(); this.readyState = 1; setImmediate(() => this.emit('open')); }
    send(raw) {
      const msg = JSON.parse(raw);
      const reply = (result) => setImmediate(() => this.emit('message', JSON.stringify({ id: msg.id, result })));
      if (msg.method === 'initialize') reply({});
      if (msg.method === 'thread/start') reply({ thread: { id: 'new-thread' }, cwd: '/tmp' });
      if (msg.method === 'thread/read') {
        const id = msg.params.threadId;
        seen.push(id);
        pending.push(() => this.emit('message', JSON.stringify({
          id: msg.id, result: { thread: { id, status: { type: statusByThread[id] || 'notLoaded' } } },
        })));
      }
    }
    close() { this.readyState = 3; }
    terminate() { this.readyState = 3; }
  }
  return { Socket, pending, seen };
}

function setup(statusByThread, { cacheMs } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-live-rotation-'));
  const registry = createLiveThreadRegistry({ filePath: path.join(dir, 'threads.json') });
  registry.set('Host', { threadId: 'old-thread', ref: OLD_REF, tmuxSession: 'local-Host' });
  const daemon = makeDaemon(statusByThread);
  const cfg = { liveBridgeEnabled: true, port: 1, liveBridgeSocketPath: path.join(dir, 'unused'), liveBridgeTimeoutMs: 1000 };
  if (cacheMs !== undefined) cfg.liveThreadStatusCacheMs = cacheMs;
  const bridge = createLiveBridge({
    cfg, registry, WebSocket: daemon.Socket, tokenGet: () => 'probe',
    fleetP: Promise.resolve({
      available: true,
      status: async () => ({ cells: [{ cell: 'Host', active: true, cwd: '/tmp', tmuxSession: 'local-Host', engine: 'codex-vl.native' }] }),
      lease: { status: () => ({ state: 'live' }) },
    }),
    fetchImpl: async () => ({ status: 200, json: async () => ({ hostCell: 'Host', eligible: true, revision: 1 }) }),
  });
  return { dir, registry, bridge, daemon, attest: createLiveAttestation({ registry, bridge }) };
}

function post(app, ref) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/cells/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-nexuscrew-live-thread': ref },
          body: JSON.stringify({
            id: '12345678-1234-1234-1234-123456789abc',
            from: { instanceId: NODE, cell: 'Host', tmuxSession: 'local-Host' },
            to: { instanceId: NODE, cell: 'Dst', tmuxSession: 'local-Dst' },
            message: 'test',
          }),
        });
        resolve({ res, close: () => new Promise((r) => server.close(r)) });
      } catch (e) { server.close(); reject(e); }
    });
  });
}

function appFor(attest, submissions) {
  const status = { available: true, cells: [
    { cell: 'Host', tmuxSession: 'local-Host', active: true, tmux: true },
    { cell: 'Dst', tmuxSession: 'local-Dst', active: true, tmux: true },
  ] };
  const app = express();
  app.use('/api/cells', cellsRoutes({
    fleetP: Promise.resolve({ available: true, status: async () => status }),
    instanceId: () => NODE,
    liveAttest: attest,
    submit: async (session, text) => { submissions.push(text); return { submitted: true }; },
  }));
  return app;
}

test('rotazione durante la lettura: la risposta tardiva del thread vecchio non da l\'etichetta Live al riferimento vecchio', async () => {
  const ctx = setup({ 'old-thread': 'idle', 'new-thread': 'notLoaded' });
  const submissions = [];
  const started = (async () => post(appFor(ctx.attest, submissions), OLD_REF))();
  await until(() => ctx.daemon.pending.length === 1);
  // La lettura del vecchio thread e' sospesa: parte la rotazione.
  const rotation = await ctx.bridge.resolveForLive();
  assert.equal(rotation.mode, 'native');
  assert.equal(ctx.registry.findByRef(OLD_REF), null, 'il riferimento vecchio non risolve piu\'');
  ctx.daemon.pending.shift()();
  const { res, close } = await started;
  await close();
  assert.equal(res.status, 200, 'il messaggio parte comunque');
  assert.doesNotMatch(submissions[0], /from Live\(via/, 'ma come semplice messaggio della cella');
  assert.match(submissions[0], /from Host@aaaaaaaa/);
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('rotazione durante la lettura: il riferimento nuovo si attesta leggendo il thread nuovo, non la risposta del vecchio', async () => {
  const ctx = setup({ 'old-thread': 'idle', 'new-thread': 'idle' });
  const first = ctx.attest.verify({ ref: OLD_REF, fromCell: 'Host' });
  await until(() => ctx.daemon.pending.length === 1);
  await ctx.bridge.resolveForLive();
  const newRef = ctx.registry.get('Host').ref;
  const secondVerdict = ctx.attest.verify({ ref: newRef, fromCell: 'Host' });
  await until(() => ctx.daemon.pending.length === 2);
  assert.deepEqual(ctx.daemon.seen, ['old-thread', 'new-thread'], 'il thread nuovo ha la sua lettura');
  ctx.daemon.pending.shift()();
  assert.deepEqual(await first, { ok: false, reason: 'ref-changed' });
  ctx.daemon.pending.shift()();
  assert.deepEqual(await secondVerdict, { ok: true, hostCell: 'Host' });
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('rotazione: un thread nuovo assente non eredita lo stato vivo del vecchio', async () => {
  const ctx = setup({ 'old-thread': 'idle', 'new-thread': 'notLoaded' });
  const first = ctx.attest.verify({ ref: OLD_REF, fromCell: 'Host' });
  await until(() => ctx.daemon.pending.length === 1);
  await ctx.bridge.resolveForLive();
  const newRef = ctx.registry.get('Host').ref;
  ctx.daemon.pending.shift()();
  await first;
  const verdict = ctx.attest.verify({ ref: newRef, fromCell: 'Host' });
  await until(() => ctx.daemon.pending.length === 1);
  ctx.daemon.pending.shift()();
  assert.deepEqual(await verdict, { ok: false, reason: 'thread-not-alive' });
  assert.deepEqual(ctx.daemon.seen, ['old-thread', 'new-thread']);
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('la cache dello stato e\' per thread: dopo la rotazione il valore del vecchio non risponde per il nuovo', async () => {
  const ctx = setup({ 'old-thread': 'idle', 'new-thread': 'active' }, { cacheMs: 60000 });
  const warm = ctx.bridge.threadStatus('Host');
  await until(() => ctx.daemon.pending.length === 1);
  ctx.daemon.pending.shift()();
  assert.equal(await warm, 'present');
  // Rotazione SENZA passare dal bridge (la cache per cella non verrebbe toccata): il registro nomina un altro thread.
  ctx.registry.set('Host', { threadId: 'new-thread', ref: 'e'.repeat(32), tmuxSession: 'local-Host' });
  const next = ctx.bridge.threadStatus('Host');
  await until(() => ctx.daemon.pending.length === 1);
  assert.deepEqual(ctx.daemon.seen, ['old-thread', 'new-thread'], 'il thread nuovo e\' stato letto, non servito dalla cache del vecchio');
  ctx.daemon.pending.shift()();
  assert.equal(await next, 'active');
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('la richiesta in corso e\' per thread: due thread della stessa cella non condividono la lettura', async () => {
  const ctx = setup({ 'old-thread': 'idle', 'new-thread': 'active' });
  const a = ctx.bridge.threadStatus('Host', 'old-thread');
  const b = ctx.bridge.threadStatus('Host', 'new-thread');
  await until(() => ctx.daemon.pending.length === 2);
  assert.deepEqual(ctx.daemon.seen, ['old-thread', 'new-thread']);
  while (ctx.daemon.pending.length) ctx.daemon.pending.shift()();
  assert.equal(await a, 'present');
  assert.equal(await b, 'active');
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('lo stesso riferimento legato a un altro thread durante l\'attesa non attesta', async () => {
  const ctx = setup({ 'old-thread': 'idle', 'other-thread': 'idle' });
  const verdict = ctx.attest.verify({ ref: OLD_REF, fromCell: 'Host' });
  await until(() => ctx.daemon.pending.length === 1, 'the read of the old thread');
  // Stessa cella e stesso riferimento, ma un altro thread: la tupla non e' piu' quella letta.
  ctx.registry.set('Host', { threadId: 'other-thread', ref: OLD_REF, tmuxSession: 'local-Host' });
  ctx.daemon.pending.shift()();
  assert.deepEqual(await verdict, { ok: false, reason: 'ref-changed' });
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('senza rotazione l\'attestazione resta quella di prima', async () => {
  const ctx = setup({ 'old-thread': 'idle' });
  const verdict = ctx.attest.verify({ ref: OLD_REF, fromCell: 'Host' });
  await until(() => ctx.daemon.pending.length === 1);
  ctx.daemon.pending.shift()();
  assert.deepEqual(await verdict, { ok: true, hostCell: 'Host' });
  assert.deepEqual(await ctx.attest.verify({ ref: OLD_REF, fromCell: 'Other' }), { ok: false, reason: 'wrong-host' });
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});
