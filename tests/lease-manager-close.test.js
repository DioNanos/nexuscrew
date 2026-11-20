'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { createLeaseManager, resolveStablePath } = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');

function makeTempDir(t, prefix = 'nc-lease-close-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });
  return dir;
}

function sha32(cellId) {
  return crypto.createHash('sha256').update(cellId, 'utf8').digest('hex').slice(0, 32);
}

function connectUnix(sockPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(sockPath, () => resolve(client));
    client.once('error', reject);
  });
}

function recv(client, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting for frame'));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      client.off('data', onData);
      client.off('error', onErr);
      client.off('close', onClose);
    }
    function onErr(err) {
      cleanup();
      reject(err);
    }
    function onClose() {
      cleanup();
      reject(new Error('socket closed before matching frame'));
    }
    function onData(chunk) {
      buf += chunk.toString('utf8');
      while (true) {
        const nl = buf.indexOf('\n');
        if (nl === -1) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (predicate(msg)) {
          cleanup();
          resolve(msg);
          return;
        }
      }
    }
    client.on('data', onData);
    client.once('error', onErr);
    client.once('close', onClose);
  });
}

function tcpPair(t) {
  return new Promise((resolve, reject) => {
    let accepted = null;
    const srv = net.createServer((sock) => { accepted = sock; });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const client = net.createConnection(port, '127.0.0.1', () => {
        const poll = () => {
          if (accepted) {
            srv.close(() => {});
            t.after(() => {
              try { accepted.destroy(); } catch (_) {}
              try { client.destroy(); } catch (_) {}
            });
            resolve({ serverSide: accepted, client });
          } else {
            setTimeout(poll, 2);
          }
        };
        poll();
      });
      client.once('error', reject);
    });
  });
}

test('empty and live UDS managers: synchronous close, single whenClosed promise, idempotency, and real server close attestation', async (t) => {
  const base = makeTempDir(t);

  // 1) Empty manager has zero servers/sockets and attests immediately
  {
    const mgr = createLeaseManager({ home: base, launchRuntimeDir: path.join(base, 'r0') });
    await assert.rejects(() => mgr.whenClosed(), /close\(\) has not been called/);
    const s1 = mgr.close();
    assert.equal(typeof s1.then, 'undefined');
    assert.equal(s1.closed, true);
    assert.equal(s1.quiescent, true);
    assert.equal(s1.pendingOpens, 0);
    assert.equal(s1.unresolvedOpens, 0);
    assert.equal(s1.pendingServers, 0);
    assert.equal(s1.pendingSockets, 0);
    assert.equal(s1.closeFailures, 0);

    const p1 = mgr.whenClosed();
    const p2 = mgr.whenClosed();
    assert.equal(p1, p2);
    const done = await p1;
    assert.equal(done.quiescent, true);
    assert.deepEqual(mgr.close(), done);
    await assert.rejects(() => mgr.track('Dev'), /manager is closed/);
    await assert.rejects(() => mgr.boot(), /manager is closed/);
  }

  // 2) Live UDS endpoint with zero connections does not anticipate quiescent before 'close' event
  {
    let serverCloseCalls = 0;
    let closeEmitted = false;
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: path.join(base, 'r1') },
      {
        net: {
          ...net,
          createServer(...args) {
            const srv = net.createServer(...args);
            const origClose = srv.close.bind(srv);
            srv.once('close', () => { closeEmitted = true; });
            srv.close = (...cArgs) => {
              serverCloseCalls += 1;
              return origClose(...cArgs);
            };
            t.after(() => { try { origClose(); } catch (_) {} });
            return srv;
          },
        },
      },
    );

    await mgr.track('LiveIdleCell');
    const pre = mgr.close();
    assert.equal(typeof pre.then, 'undefined');
    assert.equal(pre.closed, true);
    assert.equal(pre.quiescent, false);
    assert.equal(pre.pendingServers, 1);
    assert.equal(pre.pendingSockets, 0);

    const w1 = mgr.whenClosed();
    const w2 = mgr.whenClosed();
    assert.equal(w1, w2);
    assert.equal(mgr.close().pendingServers, 1);
    assert.equal(serverCloseCalls, 1, 'repeated close() must not re-invoke server.close()');

    const drained = await w1;
    assert.equal(closeEmitted, true);
    assert.equal(drained.closed, true);
    assert.equal(drained.quiescent, true);
    assert.equal(drained.pendingServers, 0);
    assert.equal(drained.pendingSockets, 0);
    assert.equal(drained.closeFailures, 0);
    assert.equal(mgr.closeState().quiescent, true);
  }
});

test('incomplete UDS handshake, adopted broker socket, reconnect replacement, external socket isolation, and close boundary', async (t) => {
  const base = makeTempDir(t);
  const runDir = path.join(base, 'run');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  // Unrelated external UDS server + socket that manager does not own and must never destroy
  const extSockPath = path.join(base, 'unrelated-external.sock');
  let extServerSide = null;
  const extSrv = net.createServer((s) => { extServerSide = s; });
  await new Promise((resolve) => extSrv.listen(extSockPath, resolve));
  const extClient = await connectUnix(extSockPath);
  t.after(() => {
    try { extClient.destroy(); } catch (_) {}
    try { if (extServerSide) extServerSide.destroy(); } catch (_) {}
    try { extSrv.close(); } catch (_) {}
  });

  let capturedConnListener = null;
  const acceptedSockets = [];
  let holdAcceptedClose = true;
  let heldDestroyFns = [];

  const mgr = createLeaseManager(
    { home: base, launchRuntimeDir: runDir, leaseStateDir: stateDir },
    {
      net: {
        ...net,
        createServer(connListener) {
          capturedConnListener = connListener;
          const srv = net.createServer((sock) => {
            acceptedSockets.push(sock);
            const origDestroy = sock.destroy.bind(sock);
            sock.destroy = (...dArgs) => {
              if (holdAcceptedClose) {
                heldDestroyFns.push(() => origDestroy(...dArgs));
                return sock;
              }
              return origDestroy(...dArgs);
            };
            connListener(sock);
          });
          t.after(() => {
            holdAcceptedClose = false;
            for (const fn of heldDestroyFns) { try { fn(); } catch (_) {} }
            try { srv.close(); } catch (_) {}
          });
          return srv;
        },
      },
    },
  );
  t.after(() => {
    holdAcceptedClose = false;
    for (const fn of heldDestroyFns) { try { fn(); } catch (_) {} }
    try { mgr.close(); } catch (_) {}
  });

  // Cell A: silent client stuck in handshake (entry.socket === null)
  const infoA = await mgr.track('CellHandshake');
  const handshakeClient = await connectUnix(infoA.stablePath);
  t.after(() => { try { handshakeClient.destroy(); } catch (_) {} });
  while (acceptedSockets.length < 1) {
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(mgr._cells.get('CellHandshake').socket, null);

  // Cell B: adopted initial socket, refreshed, then replaced via UDS reconnect
  const infoB = await mgr.track('CellAdopted');
  const pair1 = await tcpPair(t);
  const adoptedFrames = [];
  const origWrite = pair1.client.write.bind(pair1.client);
  pair1.client.write = (chunk, ...rest) => origWrite(chunk, ...rest);
  pair1.client.on('data', (c) => adoptedFrames.push(c.toString('utf8')));
  assert.equal(mgr.attachInitial('CellAdopted', pair1.serverSide, { generation: 0 }), true);

  pair1.client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  const ack = await recv(pair1.client, (m) => m.type === 'ack');
  assert.ok(ack.proof);

  // Reconnect on Cell B via UDS so onStableConnection -> handleReconnect -> bindLiveSocket -> detachSocket
  const reconnectedClient = await connectUnix(infoB.stablePath);
  t.after(() => { try { reconnectedClient.destroy(); } catch (_) {} });
  reconnectedClient.write(`${JSON.stringify({ type: 'reconnect', generation: 1, proof: ack.proof })}\n`);
  const leaseFrame = await recv(reconnectedClient, (m) => m.type === 'lease');
  assert.ok(leaseFrame.leaseId);
  assert.equal(acceptedSockets.length, 2);

  // Clear timer before close() and initiate transport close while socket 'close' events are held
  const preClose = mgr.close();
  assert.equal(preClose.closed, true);
  assert.equal(preClose.quiescent, false);
  assert.ok(preClose.pendingSockets >= 2, `expected >= 2 tracked sockets, got ${preClose.pendingSockets}`);

  // External unrelated socket stays completely open; zero control stop frames written to client
  assert.equal(extClient.destroyed, false);
  assert.equal(extServerSide.destroyed, false);
  assert.equal(adoptedFrames.some((f) => f.includes('"stop"')), false);

  // detachSocket did NOT strip our socket close observer: whenClosed stays pending until real socket close
  const earlyBarrier = await Promise.race([
    mgr.whenClosed().then(() => 'resolved'),
    new Promise((r) => setTimeout(() => r('pending'), 35)),
  ]);
  assert.equal(earlyBarrier, 'pending', 'whenClosed must stay pending while sockets have not emitted close');

  // Late attachInitial and late onStableConnection after close() are rejected and destroyed immediately
  const latePair = await tcpPair(t);
  assert.equal(mgr.attachInitial('CellAdopted', latePair.serverSide, { generation: 2 }), false);
  const lateUdsPair = await tcpPair(t);
  const lateClosedP = new Promise((r) => lateUdsPair.serverSide.once('close', () => r(true)));
  capturedConnListener(lateUdsPair.serverSide);
  assert.equal(lateUdsPair.serverSide.destroyed, true);
  assert.equal(await lateClosedP, true, 'post-close onStableConnection must destroy incoming socket');
  assert.equal(mgr._cells.size, 0);

  // Release socket destroys -> real 'close' events fire -> server 'close' fires -> whenClosed resolves quiescent
  holdAcceptedClose = false;
  for (const fn of heldDestroyFns) fn();
  const done = await mgr.whenClosed();
  assert.equal(done.closed, true);
  assert.equal(done.quiescent, true);
  assert.equal(done.pendingSockets, 0);
  assert.equal(done.pendingServers, 0);
  assert.equal(done.closeFailures, 0);
  assert.equal(extClient.destroyed, false);
});

test('server/socket pending close barriers, rollback barrier, synchronous/callback errors, and non-attestable handles stay non-quiescent', async (t) => {
  const base = makeTempDir(t);

  // 1) Server close returns without throwing and withholds 'close' until explicitly released
  {
    let releaseServerClose = null;
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: path.join(base, 'b1') },
      {
        net: {
          ...net,
          createServer(...args) {
            const srv = net.createServer(...args);
            const origClose = srv.close.bind(srv);
            srv.close = () => {
              releaseServerClose = () => origClose();
              return srv;
            };
            t.after(() => { try { origClose(); } catch (_) {} });
            return srv;
          },
        },
      },
    );
    await mgr.track('BarrierSrvCell');
    const pre = mgr.close();
    assert.equal(pre.quiescent, false);
    assert.equal(pre.pendingServers, 1);

    const stalled = await Promise.race([
      mgr.whenClosed().then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('pending'), 35)),
    ]);
    assert.equal(stalled, 'pending');
    assert.ok(releaseServerClose);
    releaseServerClose();
    const settled = await mgr.whenClosed();
    assert.equal(settled.quiescent, true);
    assert.equal(settled.pendingServers, 0);
  }

  // 2) Rollback recovery whose rolledBackServer.close() holds 'close' remains tracked until 'close' emits
  {
    const stateDir = path.join(base, 's-rb');
    const runDir = path.join(base, 'r-rb');
    fs.mkdirSync(stateDir, { recursive: true });
    const cellRec = 'RollbackCloseBarrier';
    fs.writeFileSync(path.join(stateDir, `${cellRec}.json`), JSON.stringify({
      launchEpoch: 'aa'.repeat(8),
      graceDeadline: Date.now() + 60000,
    }));
    let releaseRbClose = null;
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: runDir, leaseStateDir: stateDir },
      {
        fs: {
          ...fs,
          renameSync(src, dst) {
            if (dst.endsWith(`${cellRec}.json`)) {
              throw Object.assign(new Error('rename fail'), { code: 'EIO' });
            }
            return fs.renameSync(src, dst);
          },
        },
        net: {
          ...net,
          createServer(...args) {
            const srv = net.createServer(...args);
            const origClose = srv.close.bind(srv);
            srv.close = () => {
              releaseRbClose = () => origClose();
              return srv;
            };
            t.after(() => { try { origClose(); } catch (_) {} });
            return srv;
          },
        },
      },
    );
    mgr.loadPersisted();
    await assert.rejects(() => mgr.track(cellRec), /persist outcome uncertain|not persisted/);
    const closePre = mgr.close();
    assert.equal(closePre.quiescent, false);
    assert.equal(closePre.pendingServers, 1);
    const wait1 = await Promise.race([
      mgr.whenClosed().then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('pending'), 35)),
    ]);
    assert.equal(wait1, 'pending');
    releaseRbClose();
    const afterRb = await mgr.whenClosed();
    assert.equal(afterRb.quiescent, true);
  }

  // 3) Server callback error -> non-quiescent residual & closeFailures
  {
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: path.join(base, 'cb-err') },
      {
        net: {
          ...net,
          createServer(...args) {
            const srv = net.createServer(...args);
            const origClose = srv.close.bind(srv);
            srv.close = (cb) => {
              if (typeof cb === 'function') setImmediate(() => cb(new Error('close cb failed')));
              return srv;
            };
            t.after(() => { try { origClose(); } catch (_) {} });
            return srv;
          },
        },
      },
    );
    await mgr.track('CbErrCell');
    mgr.close();
    const out = await mgr.whenClosed();
    assert.equal(out.closed, true);
    assert.equal(out.quiescent, false);
    assert.ok(out.closeFailures >= 1);
    assert.ok(out.unresolvedOpens >= 1);
  }

  // 3b) In-flight listen -> publish abort barrier holds whenClosed until server emits physical 'close'
  {
    let releaseAbortedServerClose = null;
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: path.join(base, 'lp-barrier') },
      {
        fs: {
          ...fs,
          chmodSync(p, mode) {
            // Delay completion only conceptually; abort via close() synchronously inside chmodSync on .sock
            if (p.endsWith('ListenPublishCell.sock')) {
              // Trigger manager close right between listen() completion and publish!
              mgr.close();
            }
            return fs.chmodSync(p, mode);
          },
        },
        net: {
          ...net,
          createServer(...args) {
            const srv = net.createServer(...args);
            const origClose = srv.close.bind(srv);
            srv.close = () => {
              releaseAbortedServerClose = () => origClose();
              return srv;
            };
            t.after(() => { try { origClose(); } catch (_) {} });
            return srv;
          },
        },
      },
    );
    await assert.rejects(() => mgr.track('ListenPublishCell'), /manager is closed/);
    const snap = mgr.close();
    assert.equal(snap.quiescent, false);
    assert.ok(snap.pendingOpens >= 1 || snap.pendingServers >= 1);
    const blocked = await Promise.race([
      mgr.whenClosed().then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('pending'), 35)),
    ]);
    assert.equal(blocked, 'pending', 'listen->publish abort must hold whenClosed until server emits close');
    releaseAbortedServerClose();
    const settled = await mgr.whenClosed();
    assert.equal(settled.quiescent, true);
    assert.equal(settled.pendingServers, 0);
    assert.equal(settled.pendingOpens, 0);
  }

  // 4) Non-attestable server (no .once method) and throwing socket.destroy() stay non-quiescent
  {
    const fakeNonAttestableServerNet = {
      ...net,
      createServer() {
        return {
          listening: true,
          once: null,
          removeListener() {},
          unref() {},
          listen(sp, cb) {
            const real = net.createServer();
            t.after(() => { try { real.close(); } catch (_) {} });
            real.listen(sp, () => {
              real.unref();
              this._real = real;
              if (typeof cb === 'function') cb();
            });
          },
          close() {
            if (this._real) { try { this._real.close(); } catch (_) {} }
          },
        };
      },
    };
    const mgrNoOnce = createLeaseManager(
      { home: base, launchRuntimeDir: path.join(base, 'no-once') },
      { net: fakeNonAttestableServerNet },
    );
    await mgrNoOnce.track('NonAttestableCell');
    const summaryNoOnce = mgrNoOnce.close();
    assert.equal(summaryNoOnce.quiescent, false);
    assert.ok(summaryNoOnce.closeFailures >= 1);
    const doneNoOnce = await mgrNoOnce.whenClosed();
    assert.equal(doneNoOnce.quiescent, false);
    assert.ok(doneNoOnce.closeFailures >= 1);

    // Socket destroy throwing synchronously
    const mgrSockThrow = createLeaseManager({ home: base, launchRuntimeDir: path.join(base, 'sock-throw') });
    await mgrSockThrow.track('SockThrowCell');
    const pair = await tcpPair(t);
    pair.serverSide.destroy = () => { throw new Error('destroy boom'); };
    assert.equal(mgrSockThrow.attachInitial('SockThrowCell', pair.serverSide, { generation: 0 }), true);
    const sumSock = mgrSockThrow.close();
    assert.equal(sumSock.quiescent, false);
    assert.ok(sumSock.closeFailures >= 1);
    const doneSock = await mgrSockThrow.whenClosed();
    assert.equal(doneSock.quiescent, false);
    assert.ok(doneSock.closeFailures >= 1);
    t.after(() => { try { net.Socket.prototype.destroy.call(pair.serverSide); } catch (_) {} });
  }
});

test('residual identity guard: unknown dev/ino or mismatched object never unlinks, ENOENT attests absence, and matching socket recovers', async (t) => {
  const base = makeTempDir(t);

  // Helper to run residual cleanup matrix on a controlled runtimeDir
  async function setupFailedCleanup({ failLstatAtRecord }) {
    const dir = makeTempDir(t, 'nc-resid-id-');
    const stateDir = path.join(dir, 'state');
    const runDir = path.join(dir, `run-${'p'.repeat(15)}`);
    fs.mkdirSync(stateDir, { recursive: true });
    const cellId = `ResidualIdCell_${'x'.repeat(49)}`;
    const fixedDigest = 'cd'.repeat(16);
    const sp = resolveStablePath(runDir, cellId, { digestFn: () => fixedDigest }).path;

    let failChmod = true;
    let failServerClose = true;
    let failSockUnlink = true;
    let failLstat = failLstatAtRecord;
    let closeCallsDuringRecovery = 0;
    let unlinkCalls = 0;
    let countUnlinks = false;
    const captured = [];

    const mgr = createLeaseManager(
      { home: dir, launchRuntimeDir: runDir, leaseStateDir: stateDir },
      {
        socketDigest: () => fixedDigest,
        fs: {
          ...fs,
          chmodSync(p, mode) {
            if (failChmod && path.dirname(p) === runDir) {
              throw Object.assign(new Error('chmod denied'), { code: 'EPERM' });
            }
            return fs.chmodSync(p, mode);
          },
          unlinkSync(p) {
            if (countUnlinks && path.dirname(p) === runDir) unlinkCalls += 1;
            if (failSockUnlink && path.dirname(p) === runDir) {
              throw Object.assign(new Error('unlink denied'), { code: 'EPERM' });
            }
            return fs.unlinkSync(p);
          },
          lstatSync(p) {
            if (failLstat && p === sp) {
              throw Object.assign(new Error('lstat io error'), { code: 'EIO' });
            }
            return fs.lstatSync(p);
          },
        },
        net: {
          ...net,
          createServer() {
            const fakeSrv = new EventEmitter();
            let backingSrv = null;
            fakeSrv.listening = false;
            fakeSrv.unref = () => fakeSrv;
            fakeSrv.listen = (_sp, cb) => {
              const tmpSock = path.join(dir, `backing-${captured.length}.sock`);
              backingSrv = net.createServer();
              backingSrv.listen(tmpSock, () => {
                fs.renameSync(tmpSock, _sp);
                fakeSrv.listening = true;
                if (typeof cb === 'function') cb();
              });
              t.after(() => { try { if (backingSrv) backingSrv.close(); } catch (_) {} });
              return fakeSrv;
            };
            const triggerClose = () => {
              fakeSrv.listening = false;
              if (backingSrv) { try { backingSrv.close(); } catch (_) {} }
              fakeSrv.emit('close');
            };
            fakeSrv.close = (cb) => {
              closeCallsDuringRecovery += 1;
              if (failServerClose) throw new Error('close refused');
              triggerClose();
              if (typeof cb === 'function') cb();
              return fakeSrv;
            };
            captured.push({ srv: fakeSrv, triggerClose });
            return fakeSrv;
          },
        },
      },
    );
    t.after(() => { try { mgr.close(); } catch (_) {} });

    await assert.rejects(() => mgr.track(cellId), /chmod denied/);
    assert.equal(mgr.readiness().unresolvedOpens, 1);

    failChmod = false;
    failServerClose = false;
    failSockUnlink = false;
    failLstat = false;
    countUnlinks = true;

    return {
      mgr, cellId, sp, captured, stateDir,
      getUnlinkCalls: () => unlinkCalls,
      getCreateCount: () => closeCallsDuringRecovery,
    };
  }

  // 1) Unknown identity (lstat EIO during failure) + foreign file present at server close -> ZERO unlinks, file preserved, stable block
  {
    const ctx = await setupFailedCleanup({ failLstatAtRecord: true });
    fs.unlinkSync(ctx.sp);
    fs.writeFileSync(ctx.sp, 'sentinel-content', 'utf8');
    const replacementIno = fs.lstatSync(ctx.sp).ino;

    await new Promise((resolve) => {
      ctx.captured[0].srv.once('close', () => setImmediate(resolve));
      ctx.captured[0].triggerClose();
    });

    assert.equal(ctx.getUnlinkCalls(), 0, 'unknown original identity must NEVER unlink replacement object');
    assert.equal(fs.readFileSync(ctx.sp, 'utf8'), 'sentinel-content');
    assert.equal(fs.lstatSync(ctx.sp).ino, replacementIno);
    assert.equal(ctx.mgr.readiness().unresolvedOpens, 1);
    await assert.rejects(() => ctx.mgr.track(ctx.cellId), /residual|endpoint/);
    await assert.rejects(() => ctx.mgr.track(`OtherDigestCollidingCell_${'y'.repeat(39)}`), /endpoint/);
  }

  // 2) Acquired dev/ino + replaced by different socket inode -> ZERO unlinks, replacement socket preserved
  {
    const ctx = await setupFailedCleanup({ failLstatAtRecord: false });
    fs.unlinkSync(ctx.sp);
    const foreignSrv = net.createServer();
    await new Promise((resolve) => foreignSrv.listen(ctx.sp, resolve));
    t.after(() => { try { foreignSrv.close(); } catch (_) {} });
    const foreignIno = fs.lstatSync(ctx.sp).ino;

    await new Promise((resolve) => {
      ctx.captured[0].srv.once('close', () => setImmediate(resolve));
      ctx.captured[0].triggerClose();
    });

    assert.equal(ctx.getUnlinkCalls(), 0, 'mismatched inode must NEVER be unlinked');
    assert.equal(fs.lstatSync(ctx.sp).ino, foreignIno);
    assert.equal(ctx.mgr.readiness().unresolvedOpens, 1);
    await assert.rejects(() => ctx.mgr.track(ctx.cellId), /residual|endpoint/);
  }

  // 3) Unknown identity (lstat EIO during failure) + path absent (ENOENT) at server close -> ZERO unlinks, qualified absence clears residual
  {
    const ctx = await setupFailedCleanup({ failLstatAtRecord: true });
    fs.unlinkSync(ctx.sp);

    await new Promise((resolve) => {
      ctx.captured[0].srv.once('close', () => setImmediate(resolve));
      ctx.captured[0].triggerClose();
    });

    assert.equal(ctx.getUnlinkCalls(), 0, 'ENOENT attests absence without unlink');
    assert.equal(ctx.mgr.readiness().unresolvedOpens, 0);
    assert.equal(ctx.mgr.readiness().historicalResiduals, 1);
    const tracked = await ctx.mgr.track(ctx.cellId);
    assert.equal(tracked.stablePath, ctx.sp);
    ctx.mgr.close();
    assert.equal((await ctx.mgr.whenClosed()).quiescent, true);
  }

  // 4) Positive control: acquired matching dev/ino + socket type preserved -> safe unlink recovers cleanly
  {
    const ctx = await setupFailedCleanup({ failLstatAtRecord: false });
    const origIno = fs.lstatSync(ctx.sp).ino;
    assert.ok(origIno > 0);

    await new Promise((resolve) => {
      ctx.captured[0].srv.once('close', () => setImmediate(resolve));
      ctx.captured[0].triggerClose();
    });

    assert.equal(ctx.getUnlinkCalls(), 1);
    assert.equal(fs.existsSync(ctx.sp), false);
    assert.equal(ctx.mgr.readiness().unresolvedOpens, 0);
    const tracked = await ctx.mgr.track(ctx.cellId);
    assert.equal(tracked.stablePath, ctx.sp);
    ctx.mgr.close();
    assert.equal((await ctx.mgr.whenClosed()).quiescent, true);
  }
});

test('real startLeaseClient survives transport-only manager close and reconnects to booted successor with same identity within grace', async (t) => {
  const base = makeTempDir(t, 'nc-lease-reconn-');
  const runDir = path.join(base, 'run');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const mgr1 = createLeaseManager({ home: base, launchRuntimeDir: runDir, leaseStateDir: stateDir });
  t.after(() => { try { mgr1.close(); } catch (_) {} });
  const info1 = await mgr1.track('Dev');
  const pair = await tcpPair(t);
  assert.equal(mgr1.attachInitial('Dev', pair.serverSide, { generation: 0 }), true);

  let lostCount = 0;
  const firstAckP = recv(pair.client, (m) => m.type === 'ack' && Boolean(m.proof));
  const client = startLeaseClient(pair.client, {
    launchEpoch: info1.launchEpoch,
    stablePath: info1.stablePath,
    generation: () => 0,
    onLost: () => { lostCount += 1; },
  }, {
    retryDelayMs: 25,
  });
  t.after(() => { try { client.stop(); } catch (_) {} });

  // Wait for first ack so client holds a valid lease proof before transport closes
  const firstAck = await firstAckP;
  assert.ok(firstAck.proof);

  // Close mgr1 cleanly (transport destroy + server close only; does not signal client lost)
  const c1 = mgr1.close();
  assert.equal(c1.closed, true);
  assert.equal((await mgr1.whenClosed()).quiescent, true);
  assert.equal(lostCount, 0, 'transient transport detach must not immediately mark workload lost');

  // Boot successor manager on same stateDir/runDir with real reconnect proof check
  const logs2 = [];
  const mgr2 = createLeaseManager({
    home: base,
    launchRuntimeDir: runDir,
    leaseStateDir: stateDir,
    leaseLog: (l) => logs2.push(l),
  });
  t.after(() => { try { mgr2.close(); } catch (_) {} });
  await mgr2.boot();

  // Wait for supervisor lease-client to reconnect with preserved launchEpoch & proof
  const hasReconnectedLog = () => logs2.some((l) => (
    typeof l === 'string' ? l.includes('"reconnected"') : (l && l.event === 'reconnected')
  ));
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && (mgr2.status('Dev').state !== 'live' || !hasReconnectedLog())) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(mgr2.status('Dev').state, 'live');
  assert.equal(hasReconnectedLog(), true);
  assert.equal(client._isConnected(), true);
  assert.ok(client._heldProof());
  assert.equal(mgr2._cells.get('Dev').launchEpoch, info1.launchEpoch);
  assert.equal(lostCount, 0);

  mgr2.close();
  const done2 = await mgr2.whenClosed();
  assert.equal(done2.quiescent, true);
  client.stop();
});

test('whenClosed awaits same-dispatch server close callback error and agrees negatively with closeState', async (t) => {
  const base = makeTempDir(t);

  // 1) Error path: real physical 'close' fires manager observer first, then cb(err) in same dispatch
  {
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: path.join(base, 'same-dispatch-err') },
      {
        net: {
          ...net,
          createServer(...args) {
            const srv = net.createServer(...args);
            const origClose = srv.close.bind(srv);
            srv.close = (cb) => {
              if (typeof cb === 'function') {
                srv.once('close', () => cb(new Error('same-dispatch close cb error')));
              }
              return origClose();
            };
            t.after(() => { try { origClose(); } catch (_) {} });
            return srv;
          },
        },
      },
    );
    await mgr.track('SameDispatchErr');
    const pre = mgr.close();
    assert.equal(pre.closed, true);
    assert.equal(pre.quiescent, false);

    const settled = await mgr.whenClosed();
    const state = mgr.closeState();
    assert.equal(settled.closed, true);
    assert.equal(settled.quiescent, false);
    assert.ok(settled.closeFailures >= 1);
    assert.ok(settled.unresolvedOpens >= 1);
    assert.equal(state.quiescent, false);
    assert.ok(state.closeFailures >= 1);
    assert.ok(state.unresolvedOpens >= 1);
    assert.deepEqual(settled, state);
  }

  // 2) Positive control: same-dispatch clean close without error settles quiescent=true
  {
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: path.join(base, 'same-dispatch-ok') },
      {
        net: {
          ...net,
          createServer(...args) {
            const srv = net.createServer(...args);
            const origClose = srv.close.bind(srv);
            srv.close = (cb) => {
              if (typeof cb === 'function') {
                srv.once('close', () => cb());
              }
              return origClose();
            };
            t.after(() => { try { origClose(); } catch (_) {} });
            return srv;
          },
        },
      },
    );
    await mgr.track('SameDispatchOk');
    mgr.close();

    const settled = await mgr.whenClosed();
    const state = mgr.closeState();
    assert.equal(settled.closed, true);
    assert.equal(settled.quiescent, true);
    assert.equal(settled.closeFailures, 0);
    assert.equal(settled.unresolvedOpens, 0);
    assert.deepEqual(settled, state);
  }
});
