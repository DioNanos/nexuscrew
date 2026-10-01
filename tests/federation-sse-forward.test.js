'use strict';

// lib/proxy/federation.js — the federated GET forward must not treat an idle SSE
// stream like a stalled request. The peer's heartbeat is 20 s apart, the GET
// forward timeout is 10 s, and destroying the upstream between beats leaves the
// client hanging on a dead stream until its own idle fires.
//
// Timings are scaled down here (the mechanism is the same): the point is that a
// silence LONGER than the initial-response timeout, but shorter than the idle
// watchdog, must not end the stream.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const federation = require('../lib/proxy/federation.js');
const nodesStore = require('../lib/nodes/store.js');

function tempNodesPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-federation-sse-'));
  const nodesPath = path.join(dir, 'nodes.json');
  nodesStore.initStore(nodesPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return nodesPath;
}

// The local API the federated route forwards to (the last hop).
function listen(t, handler) {
  const server = http.createServer(handler);
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// The federated route mounted exactly as the product mounts it.
function listenRoute(t, { nodesPath, upstreamPort, sseIdleMs, getTimeoutMs }) {
  const express = require('express');
  const handler = federation.routeHandler({
    nodesPath,
    localPort: () => upstreamPort,
    localCredential: () => 'local-token',
    readonly: () => false,
    hopSecret: () => 'hop-secret',
    forwardGetTimeoutMs: getTimeoutMs,
    forwardSseIdleMs: sseIdleMs,
  });
  const app = express();
  app.use('/federation/route', (req, res) => handler(req, res));
  const server = http.createServer(app);
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Reads the downstream response, reporting every chunk and the moment it ends.
function readStream(port, { maxMs }) {
  const started = Date.now();
  const seen = [];
  let endedMs = null;
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/federation/route/_/event-feed' }, (res) => {
      res.on('data', (b) => seen.push({ at: Date.now() - started, text: b.toString() }));
      res.on('end', () => { endedMs = Date.now() - started; resolve({ seen, endedMs }); });
      res.on('close', () => { if (endedMs === null) endedMs = Date.now() - started; resolve({ seen, endedMs }); });
    });
    req.on('error', () => { if (endedMs === null) endedMs = Date.now() - started; resolve({ seen, endedMs }); });
    setTimeout(() => {
      if (endedMs === null) endedMs = Date.now() - started;
      try { req.destroy(); } catch (_) { /* already gone */ }
      resolve({ seen, endedMs });
    }, maxMs).unref();
  });
}

test('an SSE stream keeps flowing across a silence longer than the request timeout', async (t) => {
  const nodesPath = tempNodesPath(t);
  // The first heartbeat arrives AFTER the initial-response timeout: that is the
  // production shape (10 s timeout, 20 s heartbeat).
  const upstreamPort = await listen(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write('retry: 5000\n\n');
    setTimeout(() => { try { res.write(':hb\n\n'); } catch (_) { /* gone */ } }, 600);
  });
  const routePort = await listenRoute(t, {
    nodesPath, upstreamPort, sseIdleMs: 5000, getTimeoutMs: 300,
  });

  const { seen } = await readStream(routePort, { maxMs: 3000 });
  const heartbeats = seen.filter((c) => c.text.includes(':hb'));
  assert.equal(
    heartbeats.length, 1,
    `the heartbeat must reach the client; saw ${JSON.stringify(seen)}`,
  );
});

test('a silent SSE stream is closed instead of hanging the client', async (t) => {
  const nodesPath = tempNodesPath(t);
  const upstreamPort = await listen(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write('retry: 5000\n\n');
    // ...and then nothing at all: the watchdog is the only thing left.
  });
  const routePort = await listenRoute(t, {
    nodesPath, upstreamPort, sseIdleMs: 400, getTimeoutMs: 10000,
  });

  const { endedMs } = await readStream(routePort, { maxMs: 2500 });
  assert.ok(
    endedMs !== null && endedMs < 2000,
    `the idle watchdog must end the stream (endedMs=${endedMs})`,
  );
});

test('a peer that never answers still gets the 504 of a normal GET', async (t) => {
  const nodesPath = tempNodesPath(t);
  const upstreamPort = await listen(t, () => { /* accept and never answer */ });
  const routePort = await listenRoute(t, {
    nodesPath, upstreamPort, sseIdleMs: 5000, getTimeoutMs: 300,
  });

  const status = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: routePort, path: '/federation/route/_/event-feed' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    setTimeout(() => { try { req.destroy(); } catch (_) { /* gone */ } resolve(0); }, 2000).unref();
  });
  assert.equal(status, 504, 'a peer that never answers keeps the 504');
});
