'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { WebSocket } = require('ws');
const { createServer, start } = require('../lib/server.js');

function makeTempHome(t, prefix = 'nc-srv-ord-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cfgDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(cfgDir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function serverOpts(dir, extra = {}) {
  const cfgDir = path.join(dir, '.nexuscrew');
  return {
    home: dir,
    configDir: cfgDir,
    configPath: path.join(cfgDir, 'config.json'),
    tokenPath: path.join(cfgDir, 'token'),
    nodesPath: path.join(cfgDir, 'nodes.json'),
    filesRoot: path.join(dir, 'files'),
    bind: '127.0.0.1',
    port: 0,
    panelPort: 0,
    autoUpdate: false,
    fleetEnabled: false,
    log: () => {},
    lang: 'en',
    protectSharedTmuxServer: false,
    ...extra,
  };
}

function listenServer(srv) {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      srv.removeListener('error', reject);
      resolve(srv.address().port);
    });
  });
}

function httpRequest({ port, method = 'GET', reqPath = '/api/health', agent, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
      agent,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function createFakeClock(initialNow = 1000) {
  let now = initialNow;
  let nextId = 1;
  const timers = new Map();
  const nowMono = () => now;
  const setTimer = (fn, delayMs) => {
    const id = nextId++;
    timers.set(id, { fn, fireAt: now + Math.max(0, Number(delayMs) || 0), cancelled: false });
    return id;
  };
  const clearTimer = (id) => {
    const entry = timers.get(id);
    if (entry) entry.cancelled = true;
    timers.delete(id);
  };
  const setNow = (nextNow) => {
    now = nextNow;
  };
  const advance = async (deltaMs) => {
    now += deltaMs;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, e]) => !e.cancelled && e.fireAt <= now)
        .sort((a, b) => a[1].fireAt - b[1].fireAt);
      if (due.length === 0) break;
      const [id, entry] = due[0];
      timers.delete(id);
      entry.fn();
      await new Promise((r) => setImmediate(r));
    }
  };
  return {
    nowMono,
    setTimer,
    clearTimer,
    setNow,
    advance,
    pendingCount: () => timers.size,
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function rawUpgradeAttempt({ port, reqPath }) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(
        `GET ${reqPath} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + 'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let chunked = '';
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      resolve({ reason, data: chunked, switched: chunked.includes('101 Switching Protocols') });
    };
    sock.on('data', (d) => {
      chunked += d.toString('utf8');
      if (chunked.includes('101 Switching Protocols')) finish('upgraded');
    });
    sock.on('error', () => finish('error'));
    sock.on('close', () => finish('close'));
  });
}

test('closeOrdered drains HTTP keep-alive and active WS cleanly within budget', async (t) => {
  const dir = makeTempHome(t);
  const { server, panelServer, token, diagnostics, closeOrdered, wss } = createServer(serverOpts(dir));
  diagnostics.setVerbose(true, 300);
  const port = await listenServer(server);
  await listenServer(panelServer);

  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  t.after(() => agent.destroy());

  const okResp = await httpRequest({
    port,
    reqPath: '/api/config',
    agent,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(okResp.status, 200);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let wsCloseCode = null;
  const wsClosed = new Promise((resolve) => {
    ws.once('close', (code) => {
      wsCloseCode = code;
      resolve();
    });
  });

  const outcome = await closeOrdered({
    reason: 'test-drain',
    deadlineMono: performance.now() + 2000,
  });
  await wsClosed;

  assert.equal(wsCloseCode, 1001);
  assert.equal(wss.clients.size, 0);
  assert.equal(server.listening, false);
  assert.equal(panelServer.listening, false);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.quiescent, true);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.counts.forcedConnections, 0);
  assert.equal(outcome.counts.residues, 0);
  assert.deepEqual(outcome.codes, []);
  assert.equal(outcome.fleet.skipped, true);
  assert.equal(outcome.fleet.quiescent, true);
});

test('disarm rejects new HTTP (main & panel) with 503 SERVER_DISARMED and destroys WS upgrades', async (t) => {
  const dir = makeTempHome(t);
  const { server, panelServer, shutdownController, closeOrdered, wss, fleetP } = createServer(serverOpts(dir));
  await fleetP;
  const port = await listenServer(server);
  const panelPort = await listenServer(panelServer);

  assert.equal(shutdownController.isDisarmed(), false);
  shutdownController.disarm();
  assert.equal(shutdownController.isDisarmed(), true);
  assert.equal(shutdownController.state().disarmed, true);

  const mainResp = await httpRequest({ port, method: 'POST', reqPath: '/api/health' });
  assert.equal(mainResp.status, 503);
  assert.deepEqual(mainResp.json, { error: 'shutting down', code: 'SERVER_DISARMED' });
  assert.notEqual(mainResp.json.code, 'RUNTIME_DISARMED');

  const panelResp = await httpRequest({ port: panelPort, method: 'GET', reqPath: '/panel/cell-1/' });
  assert.equal(panelResp.status, 503);
  assert.deepEqual(panelResp.json, { error: 'shutting down', code: 'SERVER_DISARMED' });

  const wsUpgrade = await rawUpgradeAttempt({ port, reqPath: '/ws' });
  assert.equal(wsUpgrade.switched, false);
  assert.equal(wss.clients.size, 0);

  const panelUpgrade = await rawUpgradeAttempt({ port: panelPort, reqPath: '/panel/cell-1/ws' });
  assert.equal(panelUpgrade.switched, false);

  const outcome = await closeOrdered({
    reason: 'secret-token-should-not-leak',
    deadlineMono: performance.now() + 1500,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.quiescent, true);
});

test('stuck HTTP request held past grace is forced only after disarm, marking residue', async (t) => {
  const dir = makeTempHome(t);
  const { server, token, closeOrdered } = createServer(serverOpts(dir));

  const reqStarted = new Promise((resolve) => {
    server.once('request', () => resolve());
  });
  const port = await listenServer(server);

  const req = http.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/api/config',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': '100',
    },
  });
  req.on('error', () => {});
  req.write('{"partial":');
  await reqStarted;

  const outcome = await closeOrdered({
    reason: 'forced-test',
    deadlineMono: performance.now() + 500,
  });
  try { req.destroy(); } catch (_) {}

  assert.equal(outcome.quiescent, false);
  assert.ok(outcome.counts.forcedConnections >= 1);
  assert.ok(outcome.counts.residues >= 1);
  assert.ok(outcome.codes.includes('CONNECTIONS_FORCED'));
});

test('stuck HTTP request held only on panelServer past grace forces connection and marks residue', async (t) => {
  const dir = makeTempHome(t, 'nc-panel-stuck-');
  const { panelServer, token, closeOrdered } = createServer(serverOpts(dir));

  const reqStarted = new Promise((resolve) => {
    panelServer.once('request', () => resolve());
  });
  const panelPort = await listenServer(panelServer);

  const req = http.request({
    host: '127.0.0.1',
    port: panelPort,
    method: 'POST',
    path: '/panel/cell-1/api/config',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': '100',
    },
  });
  req.on('error', () => {});
  req.write('{"partial":');
  await reqStarted;

  const outcome = await closeOrdered({
    reason: 'forced-test',
    deadlineMono: performance.now() + 500,
  });
  try { req.destroy(); } catch (_) {}

  assert.equal(outcome.quiescent, false);
  assert.ok(outcome.counts.forcedConnections >= 1);
  assert.ok(outcome.counts.residues >= 1);
  assert.ok(outcome.codes.includes('CONNECTIONS_FORCED'));
});

test('start() cancels listenAfterOwn port-retry timer synchronously on disarm and preserves http.Server return', async (t) => {
  const dir = makeTempHome(t);
  const port = await freePort();
  const blocker = net.createServer((s) => s.on('error', () => {}));
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  t.after(() => { try { blocker.close(); } catch (_) {} });

  const clock = createFakeClock(2000);
  const listenErrors = [];
  const srv = start(serverOpts(dir, {
    port,
    ownPortWaitMs: 5000,
    ownPortRetryMs: 500,
    isOwnRuntimeImpl: () => true,
    nowMono: clock.nowMono,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onListenError: (err) => listenErrors.push(err),
  }));
  t.after(() => { try { srv.close(); } catch (_) {} });

  assert.ok(srv instanceof http.Server, 'start() must continue returning http.Server');
  assert.ok(srv.shutdownController && typeof srv.shutdownController.disarm === 'function');
  assert.equal(typeof srv.closeOrdered, 'function');

  // Wait for first async EADDRINUSE event to schedule listenAfterOwn retry timer.
  const waitStart = performance.now();
  while (clock.pendingCount() === 0 && performance.now() - waitStart < 1000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(clock.pendingCount() >= 1, 'listenAfterOwn retry timer should be scheduled');

  let listenCallCount = 0;
  const origListen = srv.listen.bind(srv);
  srv.listen = (...args) => {
    listenCallCount += 1;
    return origListen(...args);
  };

  srv.shutdownController.disarm();
  assert.equal(clock.pendingCount(), 0, 'disarm must cancel pending retry timer synchronously');

  await clock.advance(6000);
  assert.equal(listenCallCount, 0, 'no retry listen() after disarm');
  assert.equal(listenErrors.length, 0, 'no spurious listen errors after disarm');

  const outcome = await srv.closeOrdered({ reason: 'boot-abort', deadlineMono: clock.nowMono() + 1000 });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.quiescent, true);
});

test('single shared deadlineMono governs pending fleetP wait, late rejection causes zero unhandledRejection', async (t) => {
  const dir = makeTempHome(t);
  const clock = createFakeClock(1000);
  let rejectFleet;
  const fleetP = new Promise((_resolve, reject) => { rejectFleet = reject; });

  const { closeOrdered } = createServer(serverOpts(dir, {
    fleetP,
    nowMono: clock.nowMono,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  }));

  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));

  let afterDrainSnapshot = null;
  const closeP = closeOrdered({
    reason: 'deadline-shared',
    deadlineMono: 1800,
    afterDrainHook: (snap) => { afterDrainSnapshot = snap; },
  });

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(clock.pendingCount(), 1, 'one deadline timer waiting on fleetP');

  await clock.advance(799);
  assert.equal(clock.pendingCount(), 1, 'timer must not fire before exact deadline');

  await clock.advance(1);
  const outcome = await closeP;

  assert.equal(outcome.ok, false);
  assert.equal(outcome.quiescent, false);
  assert.equal(outcome.timedOut, true);
  assert.ok(outcome.codes.includes('FLEET_PENDING_TIMEOUT'));
  assert.ok(outcome.counts.residues >= 1);
  assert.equal(outcome.fleet.status, 'pending_timeout');
  assert.equal(outcome.fleet.timedOut, true);
  assert.equal(afterDrainSnapshot.deadlineMono, 1800);
  assert.equal(afterDrainSnapshot.timedOut, true);

  rejectFleet(new Error('late-fleet-init-boom'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(unhandled, null, 'late fleetP rejection after timeout must not trigger unhandledRejection');
});

test('rejected fleetP yields FLEET_INIT_ERROR with ok=false and quiescent=false', async (t) => {
  const dir = makeTempHome(t);
  const fleetP = Promise.reject(new Error('provider init failure'));
  fleetP.catch(() => {});

  const { closeOrdered } = createServer(serverOpts(dir, { fleetP }));
  const outcome = await closeOrdered({
    reason: 'rejected-fleet',
    deadlineMono: performance.now() + 1000,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.quiescent, false);
  assert.equal(outcome.timedOut, false);
  assert.ok(outcome.codes.includes('FLEET_INIT_ERROR'));
  assert.equal(outcome.fleet.status, 'init_error');
  assert.ok(outcome.counts.residues >= 1);
});

test('unknown fleetP (undefined, null, malformed object without close) fails closed unlike explicit available=false', async (t) => {
  for (const [label, fleetP, expectedCode, expectedStatus] of [
    ['undefined', Promise.resolve(undefined), 'FLEET_UNRESOLVED', 'unknown'],
    ['null', Promise.resolve(null), 'FLEET_UNRESOLVED', 'unknown'],
    ['missing-close', Promise.resolve({ available: true }), 'FLEET_CLOSE_UNAVAILABLE', 'close_unavailable'],
  ]) {
    const dir = makeTempHome(t, `nc-unknown-${label}-`);
    const { closeOrdered } = createServer(serverOpts(dir, { fleetP }));
    const outcome = await closeOrdered({
      reason: 'programmatic',
      deadlineMono: performance.now() + 1000,
    });
    assert.equal(outcome.ok, false, `${label}: ok must be false`);
    assert.equal(outcome.quiescent, false, `${label}: quiescent must be false`);
    assert.equal(outcome.fleet.skipped, false, `${label}: skipped must be false`);
    assert.equal(outcome.fleet.quiescent, false, `${label}: fleet.quiescent must be false`);
    assert.equal(outcome.fleet.status, expectedStatus);
    assert.ok(outcome.codes.includes(expectedCode), `${label}: missing ${expectedCode}`);
    assert.ok(outcome.counts.residues >= 1);
  }

  // Explicit disabled provider (fleetEnabled: false) remains attested skipped + quiescent.
  const dirOk = makeTempHome(t, 'nc-disabled-ok-');
  const { closeOrdered: closeOk } = createServer(serverOpts(dirOk, { fleetEnabled: false }));
  const okOutcome = await closeOk({
    reason: 'programmatic',
    deadlineMono: performance.now() + 1000,
  });
  assert.equal(okOutcome.ok, true);
  assert.equal(okOutcome.quiescent, true);
  assert.equal(okOutcome.fleet.skipped, true);
  assert.equal(okOutcome.fleet.status, 'skipped');
});

test('late-resolving fleetP is disarmed immediately on settle and receives exact same deadlineMono', async (t) => {
  const dir = makeTempHome(t);
  let resolveFleet;
  const fleetP = new Promise((resolve) => { resolveFleet = resolve; });
  const events = [];
  let observedDeadline = null;
  const clock = createFakeClock(5000);
  const expectedDeadline = 6200;

  const { shutdownController, closeOrdered } = createServer(serverOpts(dir, {
    fleetP,
    nowMono: clock.nowMono,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  }));

  shutdownController.disarm();
  resolveFleet({
    available: true,
    disarm: () => { events.push('disarm'); },
    close: async ({ deadlineMono }) => {
      events.push('close');
      observedDeadline = deadlineMono;
      return {
        status: 'completed',
        quiescent: true,
        timedOut: false,
        activeOpsRemaining: 0,
        claims: { activeCount: 0 },
        codes: [],
      };
    },
  });

  await Promise.resolve();
  assert.deepEqual(events, ['disarm'], 'fleet.disarm must fire immediately when fleetP resolves after server disarm');

  const outcome = await closeOrdered({
    reason: 'same-deadline',
    deadlineMono: expectedDeadline,
  });

  assert.equal(events[0], 'disarm');
  assert.equal(events[events.length - 1], 'close');
  assert.equal(observedDeadline, expectedDeadline);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.quiescent, true);
});

test('listener error, wss.close error, fleet.close error, and non-quiescent fleet are never masked', async (t) => {
  {
    const dir = makeTempHome(t, 'nc-err-http-');
    const { server, closeOrdered } = createServer(serverOpts(dir));
    await listenServer(server);
    const origClose = server.close.bind(server);
    server.close = (cb) => origClose(() => cb && cb(new Error('listener close failure')));
    const outcome = await closeOrdered({ deadlineMono: performance.now() + 1000 });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.quiescent, false);
    assert.ok(outcome.codes.includes('LISTENER_CLOSE_ERROR'));
    assert.ok(outcome.counts.residues >= 1);
  }

  {
    const dir = makeTempHome(t, 'nc-err-wss-');
    const { wss, closeOrdered } = createServer(serverOpts(dir));
    const origWssClose = wss.close.bind(wss);
    wss.close = (cb) => origWssClose(() => cb && cb(new Error('wss close failure')));
    const outcome = await closeOrdered({ deadlineMono: performance.now() + 1000 });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.quiescent, false);
    assert.ok(outcome.codes.includes('WSS_CLOSE_ERROR'));
  }

  {
    const dir = makeTempHome(t, 'nc-err-fleet-');
    const fleetP = Promise.resolve({
      available: true,
      disarm: () => {},
      close: async () => { throw new Error('fleet close failure'); },
    });
    const { closeOrdered } = createServer(serverOpts(dir, { fleetP }));
    const outcome = await closeOrdered({ deadlineMono: performance.now() + 1000 });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.quiescent, false);
    assert.ok(outcome.codes.includes('FLEET_CLOSE_ERROR'));
    assert.equal(outcome.fleet.status, 'close_error');
  }

  {
    const dir = makeTempHome(t, 'nc-nonq-fleet-');
    const fleetP = Promise.resolve({
      available: true,
      disarm: () => {},
      close: async () => ({
        status: 'completed_with_residues',
        quiescent: false,
        timedOut: false,
        activeOpsRemaining: 0,
        claims: { activeCount: 1 },
        codes: ['CLAIM_ACTIVE'],
      }),
    });
    const { closeOrdered } = createServer(serverOpts(dir, { fleetP }));
    const outcome = await closeOrdered({ deadlineMono: performance.now() + 1000 });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.quiescent, false, 'server quiescent cannot be true if fleet quiescent is false');
    assert.equal(outcome.counts.activeClaims, 1);
    assert.ok(outcome.counts.residues >= 1);
    assert.ok(outcome.codes.includes('CLAIM_ACTIVE'));
  }
});

test('repeated closeOrdered calls share one promise/run; direct server.close stays safe and idempotent', async (t) => {
  const dir = makeTempHome(t);
  let fleetCloseCalls = 0;
  let hookCalls = 0;
  const fleetP = Promise.resolve({
    available: true,
    disarm: () => {},
    close: async () => {
      fleetCloseCalls += 1;
      await new Promise((r) => setTimeout(r, 15));
      return { status: 'completed', quiescent: true, timedOut: false, activeOpsRemaining: 0, claims: { activeCount: 0 }, codes: [] };
    },
  });
  const { closeOrdered, diagnostics } = createServer(serverOpts(dir, { fleetP }));
  diagnostics.setVerbose(true, 300);

  const p1 = closeOrdered({ reason: 'first', deadlineMono: performance.now() + 1000, afterDrainHook: () => { hookCalls += 1; } });
  const p2 = closeOrdered({ reason: 'second', deadlineMono: performance.now() + 10 });
  assert.equal(p1, p2, 'repeated closeOrdered must return the identical shared promise');

  const [o1, o2] = await Promise.all([p1, p2]);
  const o3 = await closeOrdered({ reason: 'third' });
  assert.deepEqual(o1, o2);
  assert.deepEqual(o1, o3);
  assert.equal(fleetCloseCalls, 1);
  assert.equal(hookCalls, 1);

  const recCount = diagnostics.logs({}).records.filter((r) => r.code === 'SERVER_SHUTDOWN_ORDERED').length;
  assert.equal(recCount, 1);

  // Direct server.close() path remains compatible and non-duplicating.
  const dir2 = makeTempHome(t, 'nc-direct-close-');
  let fleetDirectCalls = 0;
  const ctx2 = createServer(serverOpts(dir2, {
    fleetP: Promise.resolve({
      available: true,
      disarm: () => {},
      close: async () => {
        fleetDirectCalls += 1;
        return { status: 'completed', quiescent: true, timedOut: false, activeOpsRemaining: 0, claims: { activeCount: 0 }, codes: [] };
      },
    }),
  }));
  ctx2.diagnostics.setVerbose(true, 300);
  await listenServer(ctx2.server);
  await new Promise((resolve) => ctx2.server.close(resolve));
  const outcome2 = await ctx2.closeOrdered({ reason: 'after-direct-close' });
  assert.equal(outcome2.ok, true);
  assert.equal(outcome2.quiescent, true);
  assert.equal(fleetDirectCalls, 1);
  const recs2 = ctx2.diagnostics.logs({}).records;
  assert.equal(recs2.filter((r) => r.code === 'SERVER_STOPPED').length, 1);
  assert.equal(recs2.filter((r) => r.code === 'SERVER_SHUTDOWN_ORDERED').length, 1);
});

test('SERVER_SHUTDOWN_ORDERED diagnostic metadata is bounded without forbidden keys, and diagnostics throw never breaks closeOrdered', async (t) => {
  const dir = makeTempHome(t);
  const { diagnostics, closeOrdered } = createServer(serverOpts(dir));
  diagnostics.setVerbose(true, 300);

  const outcome = await closeOrdered({
    reason: 'sigterm',
    deadlineMono: performance.now() + 1000,
  });
  assert.equal(outcome.quiescent, true);

  const entry = diagnostics.logs({}).records.find((r) => r.code === 'SERVER_SHUTDOWN_ORDERED');
  assert.ok(entry, 'SERVER_SHUTDOWN_ORDERED diagnostic event recorded');
  assert.equal(entry.component, 'server');
  assert.deepEqual(
    Object.keys(entry.meta).sort(),
    ['activeClaims', 'activeOps', 'budgetMs', 'elapsedMs', 'quiescent', 'reason', 'residues', 'skipped', 'timedOut'],
  );
  assert.equal(typeof entry.meta.elapsedMs, 'number');
  assert.equal(typeof entry.meta.budgetMs, 'number');
  assert.equal(entry.meta.timedOut, false);
  assert.equal(entry.meta.quiescent, true);
  assert.equal(entry.meta.skipped, true);
  assert.equal(entry.meta.residues, 0);
  assert.equal(entry.meta.activeOps, 0);
  assert.equal(entry.meta.activeClaims, 0);
  for (const forbidden of ['token', 'secret', 'path', 'argv', 'command', 'payload', 'error']) {
    assert.equal(forbidden in entry.meta, false);
  }

  // Throwing diagnostics.record does not reject or break closeOrdered outcome.
  const dir2 = makeTempHome(t, 'nc-diag-throw-');
  const ctx2 = createServer(serverOpts(dir2));
  ctx2.diagnostics.record = () => { throw new Error('diag ring broken'); };
  const outcome2 = await ctx2.closeOrdered({ deadlineMono: performance.now() + 500 });
  assert.equal(outcome2.ok, true);
  assert.equal(outcome2.quiescent, true);
});

test('canary free-text reason, fleet code, and fleet status are closed to safe fallbacks across outcome, hook, and store', async (t) => {
  const dir = makeTempHome(t, 'nc-closed-canary-');
  const reasonCanary = 'canary-reason-/tmp/host-alpha';
  const codeCanary = 'CANARY_CUSTOM_SECRET_CODE';
  const statusCanary = 'canary-status-host-beta';
  let hookArg = null;

  const fleetP = Promise.resolve({
    available: true,
    disarm: () => {},
    close: async () => ({
      status: statusCanary,
      quiescent: true,
      timedOut: false,
      activeOpsRemaining: 0,
      claims: { activeCount: 0 },
      codes: [codeCanary],
    }),
  });
  const { diagnostics, closeOrdered } = createServer(serverOpts(dir, { fleetP }));
  diagnostics.setVerbose(true, 300);

  const outcome = await closeOrdered({
    reason: reasonCanary,
    deadlineMono: performance.now() + 1000,
    afterDrainHook: (arg) => { hookArg = arg; },
  });

  const diagEntry = diagnostics.logs({}).records.find((r) => r.code === 'SERVER_SHUTDOWN_ORDERED');
  assert.ok(diagEntry);
  assert.equal(diagEntry.meta.reason, 'unknown');
  assert.ok(hookArg);
  assert.equal(hookArg.reason, 'unknown');
  assert.equal(outcome.fleet.status, 'unknown');
  assert.equal(outcome.quiescent, false);
  assert.ok(outcome.codes.includes('FLEET_UNKNOWN_CODE'));
  assert.ok(outcome.codes.includes('FLEET_UNKNOWN_STATUS'));
  assert.ok(outcome.counts.residues >= 1);

  const serializedAll = JSON.stringify({ outcome, hookArg, diagEntry });
  assert.equal(serializedAll.includes(reasonCanary), false);
  assert.equal(serializedAll.includes(codeCanary), false);
  assert.equal(serializedAll.includes(statusCanary), false);
});

test('ordered shutdown bounds fleet.close and afterDrainHook to original deadlineMono', async (t) => {
  // 1) Hanging fleet.close + late rejection (zero unhandledRejection) + hook gets quiescent=false
  {
    const dir = makeTempHome(t, 'nc-bound-fleet-hang-');
    const clock = createFakeClock(10_000);
    let rejectClose;
    const seenDeadlines = [];
    let hookSawQuiescent = null;
    let unhandled = null;
    const onUnhandled = (err) => { unhandled = err; };
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));

    const fleetP = Promise.resolve({
      available: true,
      disarm: () => {},
      close: ({ deadlineMono }) => {
        seenDeadlines.push(deadlineMono);
        return new Promise((_resolve, reject) => { rejectClose = reject; });
      },
    });
    const { closeOrdered } = createServer(serverOpts(dir, {
      fleetP,
      nowMono: clock.nowMono,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    }));

    const outP = closeOrdered({
      reason: 'programmatic',
      deadlineMono: 10_500,
      afterDrainHook: (arg) => { hookSawQuiescent = arg.quiescent; },
    });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    await clock.advance(500);
    const out = await outP;

    assert.deepEqual(seenDeadlines, [10_500]);
    assert.equal(out.timedOut, true);
    assert.equal(out.quiescent, false);
    assert.equal(out.ok, false);
    assert.ok(out.codes.includes('FLEET_CLOSE_TIMEOUT'));
    assert.equal(hookSawQuiescent, false);

    // Late rejection must be observed with zero unhandledRejection and must not mutate outcome
    rejectClose(new Error('late fleet close reject'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled, null);
    assert.equal(out.quiescent, false);
  }

  // 2) Late-resolving fleet.close after timeout never flips outcome back to quiescent=true
  {
    const dir = makeTempHome(t, 'nc-bound-fleet-late-res-');
    const clock = createFakeClock(20_000);
    let resolveClose;
    const fleetP = Promise.resolve({
      available: true,
      disarm: () => {},
      close: () => new Promise((r) => { resolveClose = r; }),
    });
    const { closeOrdered } = createServer(serverOpts(dir, {
      fleetP,
      nowMono: clock.nowMono,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    }));

    const outP = closeOrdered({ deadlineMono: 20_300 });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    await clock.advance(300);
    const out = await outP;
    assert.equal(out.quiescent, false);
    assert.equal(out.timedOut, true);

    resolveClose({
      status: 'completed',
      quiescent: true,
      timedOut: false,
      activeOpsRemaining: 0,
      claims: { activeCount: 0 },
      codes: [],
    });
    await Promise.resolve();
    assert.equal(out.quiescent, false);
  }

  // 3) Pending afterDrainHook + late rejection, plus late resolution
  {
    const dir = makeTempHome(t, 'nc-bound-hook-');
    const clock = createFakeClock(30_000);
    let rejectHook;
    let unhandled = null;
    const onUnhandled = (err) => { unhandled = err; };
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));

    const { closeOrdered } = createServer(serverOpts(dir, {
      nowMono: clock.nowMono,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    }));

    const outP = closeOrdered({
      deadlineMono: 30_400,
      afterDrainHook: () => new Promise((_r, reject) => { rejectHook = reject; }),
    });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    await clock.advance(400);
    const out = await outP;

    assert.equal(out.timedOut, true);
    assert.equal(out.quiescent, false);
    assert.equal(out.ok, false);
    assert.ok(out.codes.includes('AFTER_DRAIN_HOOK_TIMEOUT'));

    rejectHook(new Error('late hook error'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled, null);
  }

  // 4) Positive case: both fleet.close and afterDrainHook finish strictly before deadlineMono
  {
    const dir = makeTempHome(t, 'nc-bound-positive-');
    const clock = createFakeClock(40_000);
    let hookSawQuiescent = null;
    const fleetP = Promise.resolve({
      available: true,
      disarm: () => {},
      close: async ({ deadlineMono }) => {
        assert.equal(deadlineMono, 41_000);
        clock.nowMono();
        return { status: 'completed', quiescent: true, timedOut: false, activeOpsRemaining: 0, claims: { activeCount: 0 }, codes: [] };
      },
    });
    const { closeOrdered } = createServer(serverOpts(dir, {
      fleetP,
      nowMono: clock.nowMono,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    }));
    const out = await closeOrdered({
      deadlineMono: 41_000,
      afterDrainHook: async (arg) => { hookSawQuiescent = arg.quiescent; },
    });
    assert.equal(out.ok, true);
    assert.equal(out.quiescent, true);
    assert.equal(out.timedOut, false);
    assert.equal(hookSawQuiescent, true);
  }
});

test('late-resolving fleet after pending timeout receives single disarm and close on expired deadline', async (t) => {
  const dir = makeTempHome(t, 'nc-late-fleet-');
  const clock = createFakeClock(50_000);
  let resolveFleet;
  const fleetP = new Promise((resolve) => { resolveFleet = resolve; });
  const events = [];
  const seenDeadlines = [];

  const { closeOrdered } = createServer(serverOpts(dir, {
    fleetP,
    nowMono: clock.nowMono,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  }));

  const outP = closeOrdered({ reason: 'signal', deadlineMono: 50_750 });
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await clock.advance(750);
  const out1 = await outP;

  assert.equal(out1.timedOut, true);
  assert.equal(out1.quiescent, false);
  assert.ok(out1.codes.includes('FLEET_PENDING_TIMEOUT'));
  assert.deepEqual(events, []);

  resolveFleet({
    available: true,
    disarm: () => { events.push('disarm'); },
    close: async ({ deadlineMono }) => {
      events.push('close');
      seenDeadlines.push(deadlineMono);
      return {
        status: 'completed',
        quiescent: true,
        timedOut: false,
        activeOpsRemaining: 0,
        claims: { activeCount: 0 },
        codes: [],
      };
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(events, ['disarm', 'close']);
  assert.deepEqual(seenDeadlines, [50_750]);

  const out2 = await closeOrdered({ reason: 'signal', deadlineMono: 99_999 });
  assert.strictEqual(out2, out1);
  assert.equal(out2.quiescent, false);
  assert.deepEqual(events, ['disarm', 'close'], 'close must still have been called only once');
});

test('expired deadline clock checks override pre-timer callbacks across fleet and hook boundaries', async (t) => {
  // Case 1: fleet.close advances clock to deadlineMono before timer fires, claiming quiescent=true
  {
    const dir = makeTempHome(t, 'nc-dl-fleet-');
    let now = 60_000;
    const fleetP = Promise.resolve({
      available: true,
      disarm: () => {},
      close: async () => {
        now = 60_500; // Equals deadlineMono -> expired!
        return {
          status: 'completed',
          quiescent: true,
          timedOut: false,
          activeOpsRemaining: 0,
          claims: { activeCount: 0 },
          codes: [],
        };
      },
    });
    let hookQuiescent = null;
    const { closeOrdered } = createServer(serverOpts(dir, {
      fleetP,
      nowMono: () => now,
    }));
    const out = await closeOrdered({
      deadlineMono: 60_500,
      afterDrainHook: (arg) => { hookQuiescent = arg.quiescent; },
    });
    assert.equal(out.timedOut, true);
    assert.equal(out.quiescent, false);
    assert.equal(hookQuiescent, false, 'hook must receive current quiescent=false after deadline expiry');
    assert.ok(out.codes.includes('SHUTDOWN_BUDGET_EXHAUSTED'));
  }

  // Case 2: afterDrainHook advances clock past deadlineMono before completing
  {
    const dir = makeTempHome(t, 'nc-dl-hook-');
    let now = 70_000;
    const { closeOrdered } = createServer(serverOpts(dir, { nowMono: () => now }));
    const out = await closeOrdered({
      deadlineMono: 70_500,
      afterDrainHook: async (arg) => {
        assert.equal(arg.quiescent, true);
        now = 70_600;
      },
    });
    assert.equal(out.timedOut, true);
    assert.equal(out.quiescent, false);
    assert.ok(out.codes.includes('SHUTDOWN_BUDGET_EXHAUSTED'));
  }

  // Case 3: strictly within deadlineMono (69_999 < 70_000) stays quiescent=true
  {
    const dir = makeTempHome(t, 'nc-dl-ok-');
    let now = 80_000;
    const { closeOrdered } = createServer(serverOpts(dir, { nowMono: () => now }));
    const out = await closeOrdered({
      deadlineMono: 80_500,
      afterDrainHook: async () => { now = 80_499; },
    });
    assert.equal(out.timedOut, false);
    assert.equal(out.quiescent, true);
  }
});

test('direct server.close awaits reverse slot listeners, forces stuck requests, and propagates close errors', async (t) => {
  // Case 1: direct server.close with an open reverse slot listener holding a stuck request
  {
    const dir = makeTempHome(t, 'nc-rev-direct-');
    let capturedSlotSrv = null;
    let resolveSlotReq = null;
    const reqStartedP = new Promise((resolve) => { resolveSlotReq = resolve; });

    const created = createServer(serverOpts(dir, {
      reverseSlotCreateServerImpl: (reqApp) => {
        const srv = http.createServer(reqApp);
        capturedSlotSrv = srv;
        srv.once('request', () => resolveSlotReq());
        return srv;
      },
    }));
    const { server, reverseSlotListeners, closeOrdered, shutdownController } = created;

    await listenServer(server);
    const slot = await reverseSlotListeners.open({
      nodeName: 'peer', generation: 1, instanceId: 'f'.repeat(32), secret: 's', remotePort: 44601,
    });
    assert.ok(capturedSlotSrv);

    const req = http.request({
      host: '127.0.0.1',
      port: slot.localPort,
      method: 'POST',
      path: '/api/config',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '100',
      },
    });
    req.on('error', () => {});
    req.write('{"partial":');
    await reqStartedP;

    const serverClosed = new Promise((resolve) => server.once('close', resolve));
    server.close();
    await serverClosed;

    const outcome = await closeOrdered({ reason: 'direct-close-check' });
    try { req.destroy(); } catch (_) {}
    assert.equal(outcome.quiescent, false, 'reverse listener forced connection must not claim quiescent');
    assert.ok(outcome.counts.forcedConnections >= 1);
    assert.ok(outcome.codes.includes('CONNECTIONS_FORCED'));
    assert.equal(reverseSlotListeners.size(), 0);
    assert.strictEqual(shutdownController.state().outcome, outcome);
  }

  // Case 2: direct server.close when reverse slot listener server.close callback returns an error
  {
    const dir = makeTempHome(t, 'nc-rev-err-');
    const created = createServer(serverOpts(dir, {
      reverseSlotCreateServerImpl: (reqApp) => {
        const srv = http.createServer(reqApp);
        const origClose = srv.close.bind(srv);
        srv.close = (cb) => origClose(() => cb && cb(new Error('reverse slot close failure')));
        return srv;
      },
    }));
    const { server, reverseSlotListeners, closeOrdered } = created;
    await listenServer(server);
    await reverseSlotListeners.open({
      nodeName: 'peer', generation: 1, instanceId: 'a'.repeat(32), secret: 's', remotePort: 44602,
    });

    const serverClosed = new Promise((resolve) => server.once('close', resolve));
    server.close();
    await serverClosed;

    const outcome = await closeOrdered();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.quiescent, false);
    assert.ok(outcome.counts.residues >= 1);
    assert.ok(outcome.codes.includes('LISTENER_CLOSE_ERROR'));
  }
});

test('local service close and disarm errors fail closed while attempting remaining stops', async (t) => {
  // Case 1: synchronous updater.close throw still closes sibling services and records error
  {
    const dir = makeTempHome(t, 'nc-loc-err-');
    let activeTimer = setInterval(() => {}, 60_000);
    let closeCalls = 0;
    let watcherClosed = false;
    const { closeOrdered, watcher } = createServer(serverOpts(dir, {
      updateManager: {
        start: () => {},
        check: async () => ({}),
        apply: async () => ({}),
        launch: () => ({}),
        schedule: () => {},
        setEnabled: () => {},
        status: () => ({}),
        close: () => {
          closeCalls += 1;
          throw new Error('updater stop failed before clearing activity');
        },
      },
    }));
    const origWatcherClose = watcher.close.bind(watcher);
    watcher.close = () => {
      watcherClosed = true;
      return origWatcherClose();
    };
    t.after(() => {
      if (activeTimer) {
        clearInterval(activeTimer);
        activeTimer = null;
      }
    });

    const outcome = await closeOrdered({ deadlineMono: performance.now() + 500 });
    assert.equal(watcherClosed, true, 'sibling services must still be closed');
    assert.equal(closeCalls, 1);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.quiescent, false);
    assert.ok(outcome.counts.residues >= 1);
    assert.ok(outcome.codes.includes('LOCAL_SERVICE_CLOSE_ERROR'));
    assert.ok(!outcome.codes.includes('DISARM_ERROR'));
  }

  // Case 2: disarm error from fleet.disarm is captured cleanly without dropping remaining close steps
  {
    const dir = makeTempHome(t, 'nc-disarm-err-');
    let fleetClosed = false;
    const { closeOrdered } = createServer(serverOpts(dir, {
      fleetP: Promise.resolve({
        available: true,
        disarm: () => { throw new Error('fleet disarm failure'); },
        close: async () => {
          fleetClosed = true;
          return { status: 'completed', quiescent: true, timedOut: false, activeOpsRemaining: 0, claims: { activeCount: 0 }, codes: [] };
        },
      }),
    }));

    const outcome = await closeOrdered({ deadlineMono: performance.now() + 500 });
    assert.equal(fleetClosed, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.quiescent, false);
    assert.ok(outcome.counts.residues >= 1);
    assert.ok(outcome.codes.includes('DISARM_ERROR'));
  }

  // Case 3: async updater.close rejection and timeout stay bounded to deadlineMono
  {
    const dir = makeTempHome(t, 'nc-loc-async-');
    const { closeOrdered } = createServer(serverOpts(dir, {
      updateManager: {
        start: () => {},
        check: async () => ({}),
        apply: async () => ({}),
        launch: () => ({}),
        schedule: () => {},
        setEnabled: () => {},
        status: () => ({}),
        close: () => Promise.reject(new Error('async updater close failed')),
      },
    }));
    const outcome = await closeOrdered({ deadlineMono: performance.now() + 500 });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.quiescent, false);
    assert.ok(outcome.counts.residues >= 1);
    assert.ok(outcome.codes.includes('LOCAL_SERVICE_CLOSE_ERROR'));
  }

  {
    const dir = makeTempHome(t, 'nc-loc-timeout-');
    const { closeOrdered } = createServer(serverOpts(dir, {
      updateManager: {
        start: () => {},
        check: async () => ({}),
        apply: async () => ({}),
        launch: () => ({}),
        schedule: () => {},
        setEnabled: () => {},
        status: () => ({}),
        close: () => new Promise(() => {}),
      },
    }));
    const t0 = performance.now();
    const outcome = await closeOrdered({ deadlineMono: t0 + 80 });
    const elapsed = performance.now() - t0;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.quiescent, false);
    assert.equal(outcome.timedOut, true);
    assert.ok(outcome.codes.includes('LOCAL_SERVICE_TIMEOUT'));
    assert.ok(elapsed < 400, `bounded async local close took ${elapsed}ms`);
  }
});

test('disarm barriers prevent late listening events and reverse reconciliation continuations from spawning producers', async (t) => {
  const nodesStore = require('../lib/nodes/store.js');
  const reversePool = require('../lib/nodes/reverse-pool.js');

  // Case 1: listening event emitted after closeOrdered/disarm starts nothing
  {
    const dir = makeTempHome(t, 'nc-late-listen-');
    let updaterStarts = 0;
    let tunnelReconciles = 0;
    const { server, closeOrdered, diagnostics } = createServer(serverOpts(dir, {
      reconcileTunnelSupervisorsImpl: () => {
        tunnelReconciles += 1;
        return { kept: [], stopped: [], cleaned: [], failed: [] };
      },
      updateManager: {
        start: () => { updaterStarts += 1; },
        check: async () => ({}),
        apply: async () => ({}),
        launch: () => ({}),
        schedule: () => {},
        setEnabled: () => {},
        status: () => ({}),
        close: () => {},
      },
    }));

    const out = await closeOrdered({ deadlineMono: performance.now() + 500 });
    assert.equal(out.quiescent, true);
    server.emit('listening');
    await new Promise((r) => setImmediate(r));
    assert.equal(updaterStarts, 0);
    assert.equal(tunnelReconciles, 0);
    const startedEvents = diagnostics.logs({}).records.filter((r) => r.code === 'SERVER_STARTED');
    assert.equal(startedEvents.length, 0);
  }

  // Case 2: in-flight reverse pool reconciliation resolving after disarm spawns zero listeners/forwards; pending past deadline prevents quiescence
  {
    const dir = makeTempHome(t, 'nc-rev-cont-');
    const cfgDir = path.join(dir, '.nexuscrew');
    const nodesPath = path.join(cfgDir, 'nodes.json');
    const ledgerPath = reversePool.defaultLedgerPath(dir);
    const ledger = reversePool.emptyLedger('e'.repeat(32));
    reversePool.atomicWriteLedger(ledgerPath, ledger);
    let st = nodesStore.upgradeToReversePoolSchema(
      nodesStore.emptyStore('a'.repeat(32)),
      reversePool.ledgerHead(ledger),
    );
    const pool = nodesStore.reversePoolDefault(44100);
    st = nodesStore.addNode(st, {
      name: 'hub',
      ssh: 'user@hub',
      remotePort: 41777,
      localPort: 43001,
      direction: 'outbound',
      transport: 'auto',
      autostart: true,
      shared: true,
      visibility: 'network',
      token: 'hub-token',
      acceptToken: 'local-token',
      nodeId: 'b'.repeat(32),
      reversePool: pool,
    });
    nodesStore.atomicWriteStore(nodesPath, st);

    let releasePoolFetch = null;
    const poolFetchGate = new Promise((resolve) => { releasePoolFetch = resolve; });
    const spawnCalls = [];
    let shareReconcileCalls = 0;

    const { server, closeOrdered, reverseSlotListeners } = createServer(serverOpts(dir, {
      nodesPath,
      tunnelSpawnSyncImpl: () => ({ stderr: 'OpenSSH_9.6p1\n' }),
      tunnelSpawnImpl: (bin, args) => {
        spawnCalls.push([bin, args]);
        return { pid: 4193990 + spawnCalls.length, unref() {} };
      },
      reconcileTunnelSupervisorsImpl: () => ({ kept: [], stopped: [], cleaned: [], failed: [] }),
      reconcilePeerShareImpl: async () => {
        shareReconcileCalls += 1;
        return { shared: true };
      },
      fetchImpl: async (url) => {
        if (String(url).includes('reverse-pool')) {
          await poolFetchGate;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              pool: st.nodes[0].reversePool,
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    }));

    await listenServer(server);
    // Outbound forward ran before pool reconcile settled
    assert.equal(spawnCalls.length, 1);

    // Trigger closeOrdered with a short budget while reverse pool fetch is still pending
    const out = await closeOrdered({ deadlineMono: performance.now() + 80 });
    assert.equal(out.timedOut, true);
    assert.equal(out.quiescent, false);
    assert.ok(out.codes.includes('LOCAL_SERVICE_TIMEOUT'));

    // Release delayed reverse pool fetch after disarm: zero new slot listeners, zero -R forwards, zero share reconciles
    releasePoolFetch();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(reverseSlotListeners.size(), 0);
    assert.equal(spawnCalls.length, 1, 'no -R forward may spawn after disarm');
    assert.equal(shareReconcileCalls, 0);
  }
});

test('fleet resolved after deadline expiry before timer callback still receives single close on expired deadline and records late outcome', async (t) => {
  // Case 1: clock jumps past deadline WITHOUT firing timer callback; fleetP resolves right before callback
  {
    const dir = makeTempHome(t, 'nc-late-pretimer-');
    const clock = createFakeClock(50_000);
    let resolveFleet;
    const fleetP = new Promise((resolve) => { resolveFleet = resolve; });
    const events = [];
    const seenDeadlines = [];

    const { closeOrdered, shutdownController, diagnostics } = createServer(serverOpts(dir, {
      fleetP,
      nowMono: clock.nowMono,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    }));

    const outP = closeOrdered({ reason: 'signal', deadlineMono: 50_500 });
    while (clock.pendingCount() === 0) {
      await new Promise((r) => setImmediate(r));
    }

    // Advance only the clock past effectiveDeadline without triggering timer callback
    clock.setNow(50_650);
    resolveFleet({
      available: true,
      disarm: () => { events.push('disarm'); },
      close: async ({ deadlineMono }) => {
        events.push('close');
        seenDeadlines.push(deadlineMono);
        return {
          status: 'completed',
          quiescent: false,
          timedOut: true,
          activeOpsRemaining: 1,
          claims: { activeCount: 0 },
          codes: ['FLEET_CLOSE_TIMEOUT'],
        };
      },
    });

    const out1 = await outP;
    await new Promise((r) => setImmediate(r));
    await clock.advance(1000);

    assert.equal(out1.timedOut, true);
    assert.equal(out1.quiescent, false);
    assert.ok(out1.codes.includes('FLEET_PENDING_TIMEOUT'));
    assert.deepEqual(events, ['disarm', 'close'], 'late fleet resolved before timer callback must still close once');
    assert.deepEqual(seenDeadlines, [50_500], 'late close must receive original expired deadline');

    const lateDiag = diagnostics.logs({}).records.find((r) => r.code === 'FLEET_LATE_CLOSE_INCOMPLETE');
    assert.ok(lateDiag, 'late fleet non-quiescent settle must record bounded diagnostic');
    assert.equal(lateDiag.meta.quiescent, false);
    assert.equal(lateDiag.meta.timedOut, true);

    const out2 = await closeOrdered({ reason: 'signal', deadlineMono: 99_999 });
    assert.strictEqual(out2, out1);
    assert.strictEqual(shutdownController.state().outcome, out1);
    assert.equal(out2.quiescent, false);
    assert.deepEqual(events, ['disarm', 'close']);
  }

  // Case 2: late fleet close rejects -> records FLEET_LATE_CLOSE_ERROR without unhandledRejection or outcome mutation
  {
    const dir = makeTempHome(t, 'nc-late-pretimer-err-');
    const clock = createFakeClock(70_000);
    let resolveFleet;
    const fleetP = new Promise((resolve) => { resolveFleet = resolve; });
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));

    const { closeOrdered, diagnostics } = createServer(serverOpts(dir, {
      fleetP,
      nowMono: clock.nowMono,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    }));

    const outP = closeOrdered({ reason: 'signal', deadlineMono: 70_400 });
    while (clock.pendingCount() === 0) {
      await new Promise((r) => setImmediate(r));
    }
    clock.setNow(70_500);
    resolveFleet({
      available: true,
      disarm: () => {},
      close: () => Promise.reject(new Error('late close boom')),
    });

    const out1 = await outP;
    await new Promise((r) => setImmediate(r));
    assert.equal(out1.quiescent, false);
    assert.equal(out1.timedOut, true);
    assert.deepEqual(unhandled, []);
    const errDiag = diagnostics.logs({}).records.find((r) => r.code === 'FLEET_LATE_CLOSE_ERROR');
    assert.ok(errDiag, 'late fleet rejection must record FLEET_LATE_CLOSE_ERROR');
    assert.equal(errDiag.meta.quiescent, false);
  }
});

test('disarm clears scheduled reconcileImportedAsks retry timers without post-disarm execution', async (t) => {
  const nodesStore = require('../lib/nodes/store.js');
  const dir = makeTempHome(t, 'nc-reconcile-disarm-');
  const clock = createFakeClock(10_000);
  const cfgDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(cfgDir, { recursive: true });
  const nodesPath = path.join(cfgDir, 'nodes.json');
  const ownerId = 'e'.repeat(32);

  let ownerFetches = 0;
  const ownerSockets = new Set();
  const ownerSrv = http.createServer((req, res) => {
    const reqUrl = req.url || '';
    if (reqUrl === '/federation/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, instanceId: ownerId, eventFeedV1: true }));
      return;
    }
    if (reqUrl.includes('/event-feed/snapshot')) {
      ownerFetches += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ epoch: 1, cursor: 0, truncated: false, asks: [] }));
      return;
    }
    if (reqUrl.includes('/event-feed')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': mute\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  ownerSrv.on('connection', (sock) => {
    ownerSockets.add(sock);
    sock.on('close', () => ownerSockets.delete(sock));
  });
  const ownerPort = await listenServer(ownerSrv);
  t.after(() => new Promise((r) => {
    for (const s of ownerSockets) { try { s.destroy(); } catch (_) {} }
    ownerSrv.close(r);
  }));

  nodesStore.initStore(nodesPath);
  let st = nodesStore.loadStoreStrict(nodesPath);
  st = nodesStore.addNode(st, {
    name: 'owner',
    ssh: 'owner@127.0.0.1',
    remotePort: 44100,
    localPort: ownerPort,
    direction: 'outbound',
    transport: 'auto',
    autostart: false,
    visibility: 'network',
    nodeId: ownerId,
    token: 'tok-owner',
  });
  nodesStore.atomicWriteStore(nodesPath, st);
  fs.writeFileSync(path.join(cfgDir, 'asks.json'), JSON.stringify({
    asks: [{
      id: 'alias-rb2',
      question: 'keep open?',
      options: [],
      session: 'dev',
      ts: Date.now(),
      revision: 0,
      originNode: ownerId,
      ownerId,
      ownerAskId: 'own-rb2',
    }],
  }), { mode: 0o600 });

  const { server, token, closeOrdered } = createServer(serverOpts(dir, {
    nodesPath,
    nowMono: clock.nowMono,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    eventFeedClientMinSnapshotIntervalMs: 5_000,
    eventFeedClientPollMs: 60_000,
  }));
  const port = await listenServer(server);

  // First GET triggers eventFeedClient snapshot ('ok'); second immediate GET hits minSnapshotIntervalMs ('skipped') and arms retry timer
  const r1 = await fetch(`http://127.0.0.1:${port}/api/asks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(r1.status, 200);
  const fetchesAfterFirst = ownerFetches;
  assert.ok(fetchesAfterFirst >= 1);

  const pendingBeforeSecond = clock.pendingCount();
  const r2 = await fetch(`http://127.0.0.1:${port}/api/asks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(r2.status, 200);
  assert.ok(clock.pendingCount() > pendingBeforeSecond, 'skipped snapshot must arm reconcile retry timer');

  const fetchesBeforeClose = ownerFetches;
  const out = await closeOrdered({ reason: 'signal', deadlineMono: clock.nowMono() + 500 });
  assert.equal(out.quiescent, true);
  assert.equal(clock.pendingCount(), 0, 'reconcile retry timer must be cleared on disarm/stop');

  await clock.advance(60_000);
  assert.equal(ownerFetches, fetchesBeforeClose, 'disarmed server must not fire reconcile retry timer');
});

test('closeOrdered drains in-flight reverse opens, failed closePort, hung close, and clean case', async (t) => {
  // Case 1: in-flight open when closeOrdered begins, plus failed close on the late-opened listener
  {
    const { EventEmitter } = require('node:events');
    const dir = makeTempHome(t, 'nc-revslot-inflight-err-');
    let releaseListen = null;
    let closeInvoked = false;
    const { server, reverseSlotListeners, closeOrdered } = createServer(serverOpts(dir, {
      reverseSlotCreateServerImpl: () => {
        const em = new EventEmitter();
        let addr = null;
        em.listen = () => {
          new Promise((resolve) => { releaseListen = resolve; }).then(() => {
            addr = { host: '127.0.0.1', port: 45201 };
            em.emit('listening');
          });
        };
        em.address = () => addr;
        em.closeIdleConnections = () => {};
        em.closeAllConnections = () => {};
        em.close = (cb) => {
          closeInvoked = true;
          if (cb) setImmediate(() => cb(new Error('late reverse port close failed')));
        };
        return em;
      },
    }));
    await listenServer(server);

    const openP = reverseSlotListeners.open({
      nodeName: 'peer-inflight',
      remotePort: 44721,
      generation: 1,
      instanceId: 'a'.repeat(32),
      secret: 'secret',
    });
    assert.equal(reverseSlotListeners.size(), 0);

    let closeFinished = false;
    const closeP = closeOrdered({ reason: 'signal', deadlineMono: performance.now() + 2000 }).then((o) => {
      closeFinished = true;
      return o;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(closeFinished, false, 'closeOrdered must not declare quiescence before in-flight open finishes closing');

    releaseListen();
    await openP;
    const out = await closeP;
    assert.equal(closeInvoked, true);
    assert.equal(reverseSlotListeners.size(), 0);
    assert.equal(out.ok, false);
    assert.equal(out.quiescent, false);
    assert.ok(out.counts.residues >= 1);
    assert.ok(out.codes.includes('LISTENER_CLOSE_ERROR'));
  }

  // Case 2: failed closePort before closeOrdered must be preserved across subsequent drain
  {
    const dir = makeTempHome(t, 'nc-revslot-closeport-err-');
    const { server, reverseSlotListeners, closeOrdered } = createServer(serverOpts(dir, {
      reverseSlotCreateServerImpl: (reqApp) => {
        const srv = http.createServer(reqApp);
        const origClose = srv.close.bind(srv);
        srv.close = (cb) => origClose(() => cb && cb(new Error('closePort boom')));
        return srv;
      },
    }));
    await listenServer(server);
    const slot = await reverseSlotListeners.open({
      nodeName: 'peer-cp',
      remotePort: 44722,
      generation: 1,
      instanceId: 'b'.repeat(32),
      secret: 'secret',
    });
    const existed = await reverseSlotListeners.closePort(slot.localPort);
    assert.equal(existed, true);
    assert.equal(reverseSlotListeners.size(), 0);

    const out = await closeOrdered({ reason: 'signal', deadlineMono: performance.now() + 1000 });
    assert.equal(out.ok, false);
    assert.equal(out.quiescent, false);
    assert.ok(out.counts.residues >= 1);
    assert.ok(out.codes.includes('LISTENER_CLOSE_ERROR'));
  }

  // Case 3: hung close on reverse slot listener stops cleanly at deadlineMono
  {
    const dir = makeTempHome(t, 'nc-revslot-hung-');
    const { EventEmitter } = require('node:events');
    const clock = createFakeClock(90_000);
    const { server, reverseSlotListeners, closeOrdered } = createServer(serverOpts(dir, {
      nowMono: clock.nowMono,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      reverseSlotCreateServerImpl: () => {
        const em = new EventEmitter();
        let addr = null;
        em.listen = () => {
          setImmediate(() => {
            addr = { host: '127.0.0.1', port: 45203 };
            em.emit('listening');
          });
        };
        em.address = () => addr;
        em.closeIdleConnections = () => {};
        em.closeAllConnections = () => {};
        em.close = () => { /* intentionally never calls cb */ };
        return em;
      },
    }));
    await listenServer(server);
    await reverseSlotListeners.open({
      nodeName: 'peer-hung',
      remotePort: 44723,
      generation: 1,
      instanceId: 'c'.repeat(32),
      secret: 'secret',
    });

    const closeP = closeOrdered({ reason: 'signal', deadlineMono: clock.nowMono() + 250 });
    await new Promise((r) => setImmediate(r));
    await clock.advance(250);
    const out = await closeP;
    assert.equal(out.ok, false);
    assert.equal(out.quiescent, false);
    assert.equal(out.timedOut, true);
    assert.ok(out.counts.residues >= 1);
    assert.ok(out.codes.includes('SERVER_CLOSE_TIMEOUT'));
  }

  // Case 4: clean in-flight open completes and closes within deadline with quiescent true
  {
    const dir = makeTempHome(t, 'nc-revslot-clean-');
    let releaseListen = null;
    const { server, reverseSlotListeners, closeOrdered } = createServer(serverOpts(dir, {
      reverseSlotCreateServerImpl: (reqApp) => {
        const srv = http.createServer(reqApp);
        const origListen = srv.listen.bind(srv);
        srv.listen = (opts, cb) => {
          new Promise((resolve) => { releaseListen = resolve; }).then(() => {
            origListen(opts, cb);
          });
          return srv;
        };
        return srv;
      },
    }));
    await listenServer(server);
    const openP = reverseSlotListeners.open({
      nodeName: 'peer-ok',
      remotePort: 44724,
      generation: 1,
      instanceId: 'd'.repeat(32),
      secret: 'secret',
    });

    const closeP = closeOrdered({ reason: 'signal', deadlineMono: performance.now() + 2000 });
    await new Promise((r) => setTimeout(r, 15));
    releaseListen();
    await openP;
    const out = await closeP;
    assert.equal(out.ok, true);
    assert.equal(out.quiescent, true);
    assert.equal(out.counts.residues, 0);
    assert.equal(reverseSlotListeners.size(), 0);
  }
});

test('trackLocalOp rejections before or during drain fail closed with zero unhandledRejection', async (t) => {
  // Track unhandled rejections explicitly across all subcases
  let unhandledCount = 0;
  const onUnhandled = () => { unhandledCount += 1; };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));

  // Case 1: tracked op rejects before closeOrdered starts (never awaited by caller)
  {
    const dir = makeTempHome(t, 'nc-localops-pre-');
    const { server, closeOrdered, shutdownController } = createServer(serverOpts(dir));
    await listenServer(server);

    shutdownController.trackLocalOp(Promise.reject(new Error('pre-drain local op boom')));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));

    const out = await closeOrdered({ reason: 'signal', deadlineMono: performance.now() + 1000 });
    assert.equal(unhandledCount, 0, 'pre-drain rejection must not trigger unhandledRejection');
    assert.equal(out.ok, false);
    assert.equal(out.quiescent, false);
    assert.ok(out.counts.residues >= 1);
    assert.ok(out.codes.includes('LOCAL_SERVICE_CLOSE_ERROR'));
  }

  // Case 2: tracked op is pending at drain start and rejects during closeOrdered
  {
    const dir = makeTempHome(t, 'nc-localops-during-');
    const { server, closeOrdered, shutdownController } = createServer(serverOpts(dir));
    await listenServer(server);

    let rejectOp = null;
    const pendingOp = new Promise((_resolve, reject) => { rejectOp = reject; });
    shutdownController.trackLocalOp(pendingOp);

    let settled = false;
    const closeP = closeOrdered({ reason: 'signal', deadlineMono: performance.now() + 2000 }).then((o) => {
      settled = true;
      return o;
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(settled, false, 'closeOrdered must wait for pending local op before draining further');

    rejectOp(new Error('in-drain local op boom'));
    const out = await closeP;
    await new Promise((r) => setImmediate(r));
    assert.equal(unhandledCount, 0, 'in-drain rejection must not trigger unhandledRejection');
    assert.equal(out.ok, false);
    assert.equal(out.quiescent, false);
    assert.ok(out.counts.residues >= 1);
    assert.ok(out.codes.includes('LOCAL_SERVICE_CLOSE_ERROR'));
  }

  // Case 3: hung tracked op stops at deadlineMono
  {
    const dir = makeTempHome(t, 'nc-localops-timeout-');
    const clock = createFakeClock(40_000);
    const { server, closeOrdered, shutdownController } = createServer(serverOpts(dir, {
      nowMono: clock.nowMono,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    }));
    await listenServer(server);

    shutdownController.trackLocalOp(new Promise(() => {}));
    const closeP = closeOrdered({ reason: 'signal', deadlineMono: clock.nowMono() + 250 });
    await new Promise((r) => setImmediate(r));
    await clock.advance(250);
    const out = await closeP;
    assert.equal(out.ok, false);
    assert.equal(out.quiescent, false);
    assert.equal(out.timedOut, true);
    assert.ok(out.codes.includes('LOCAL_SERVICE_TIMEOUT'));
  }

  // Case 4: clean tracked op resolves before closeOrdered yields quiescent true
  {
    const dir = makeTempHome(t, 'nc-localops-clean-');
    const { server, closeOrdered, shutdownController } = createServer(serverOpts(dir));
    await listenServer(server);

    let resolveOp = null;
    shutdownController.trackLocalOp(new Promise((resolve) => { resolveOp = resolve; }));
    const closeP = closeOrdered({ reason: 'signal', deadlineMono: performance.now() + 2000 });
    await new Promise((r) => setTimeout(r, 10));
    resolveOp('done');
    const out = await closeP;
    assert.equal(out.ok, true);
    assert.equal(out.quiescent, true);
    assert.equal(out.counts.residues, 0);
  }
});

test('panelServerV6 closes cleanly without forced connections and forces isolated stuck requests via createPanelV6ServerImpl', async (t) => {
  // Case 1: isolated pending HTTP request held only on panelServerV6 forces connection and marks non-quiescent
  {
    const dir = makeTempHome(t, 'nc-pv6-stuck-');
    let resolveReq = null;
    const reqStarted = new Promise((resolve) => { resolveReq = resolve; });
    const { panelServerV6, closeOrdered } = createServer(serverOpts(dir, {
      createPanelV6ServerImpl: (reqApp) => {
        const srv = http.createServer(reqApp);
        srv.once('request', () => resolveReq());
        return srv;
      },
    }));

    const pv6Port = await listenServer(panelServerV6);
    const req = http.request({
      host: '127.0.0.1',
      port: pv6Port,
      method: 'POST',
      path: '/panel/stuck',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '100',
      },
    });
    req.on('error', () => {});
    req.write('{"partial":');
    await reqStarted;

    const out = await closeOrdered({ reason: 'signal', deadlineMono: performance.now() + 200 });
    try { req.destroy(); } catch (_) {}
    assert.equal(out.ok, true);
    assert.equal(out.quiescent, false);
    assert.ok(out.counts.forcedConnections >= 1);
    assert.ok(out.counts.residues >= 1);
    assert.ok(out.codes.includes('CONNECTIONS_FORCED'));
    assert.equal(panelServerV6.listening, false);
  }

  // Case 2: clean completed request on panelServerV6 closes without forcing any connection
  {
    const dir = makeTempHome(t, 'nc-pv6-clean-');
    let wrappedUsed = false;
    const { panelServerV6, closeOrdered } = createServer(serverOpts(dir, {
      createPanelV6ServerImpl: (reqApp) => {
        wrappedUsed = true;
        return http.createServer(reqApp);
      },
    }));
    assert.equal(wrappedUsed, true);
    const pv6Port = await listenServer(panelServerV6);
    const res = await fetch(`http://127.0.0.1:${pv6Port}/nonexistent`);
    assert.equal(res.status, 404);
    await res.text();

    const out = await closeOrdered({ reason: 'signal', deadlineMono: performance.now() + 1000 });
    assert.equal(out.ok, true);
    assert.equal(out.quiescent, true);
    assert.equal(out.counts.forcedConnections, 0);
    assert.equal(out.counts.residues, 0);
    assert.equal(panelServerV6.listening, false);
  }
});
