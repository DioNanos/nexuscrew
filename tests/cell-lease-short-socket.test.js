'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  createLeaseManager,
  resolveStablePath,
  socketPathLimit,
} = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');
const { loadOrCreateVerifier, signProof } = require('../lib/fleet/lease-verifier.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const { atomicWrite } = require('../lib/fleet/definitions.js');

function makeTempDir(t, prefix = 'nc-lease-short-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });
  return dir;
}

function sha32(cellId) {
  return crypto.createHash('sha256').update(cellId, 'utf8').digest('hex').slice(0, 32);
}

function parseLeaseLog(line) {
  return JSON.parse(String(line).replace(/^cell-lease:\s*/, ''));
}

function connectUnix(sockPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(sockPath, () => resolve(client));
    client.once('error', reject);
  });
}

function recv(client, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('recv timeout'));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      client.removeListener('data', onData);
    }
    function onData(chunk) {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (!predicate || predicate(msg)) {
          cleanup();
          resolve(msg);
        }
      }
    }
    client.on('data', onData);
  });
}

function tcpPair() {
  return new Promise((resolve, reject) => {
    let pending = null;
    const srv = net.createServer((sock) => { pending = sock; });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const client = net.createConnection(port, '127.0.0.1', () => {
        const poll = () => {
          if (pending) {
            srv.close(() => {});
            resolve({ serverSide: pending, client });
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

test('boundary UTF-8 byte limits (107 Linux/Android, 103 darwin) switch legacy to short~hash on limit+1 with multi-byte runtimeDir', () => {
  assert.equal(socketPathLimit('linux'), 107);
  assert.equal(socketPathLimit('android'), 107);
  assert.equal(socketPathLimit('darwin'), 103);

  // Multi-byte UTF-8 directory so ID lengths stay <= 64 while UTF-8 byte length differs from UTF-16 length.
  const multiDir = '/tmp/' + 'c'.repeat(42) + 'af\u00e9-\u20ac';
  const overheadBytes = Buffer.byteLength(path.join(multiDir, 'cell-.sock'), 'utf8');
  assert.ok(Buffer.byteLength(multiDir, 'utf8') > multiDir.length);

  for (const [platform, limit] of [['linux', 107], ['darwin', 103]]) {
    const exactIdLen = limit - overheadBytes;
    assert.ok(exactIdLen + 1 <= 64, `expected ID length <= 64, got ${exactIdLen + 1}`);
    const atLimitMinus1 = 'a'.repeat(exactIdLen - 1);
    const atLimit = 'a'.repeat(exactIdLen);
    const overLimit = 'a'.repeat(exactIdLen + 1);

    const rMinus = resolveStablePath(multiDir, atLimitMinus1, { platform });
    assert.deepEqual(rMinus, {
      ok: true,
      path: path.join(multiDir, `cell-${atLimitMinus1}.sock`),
      mode: 'legacy',
      bytes: limit - 1,
      limit,
    });

    const rExact = resolveStablePath(multiDir, atLimit, { platform });
    assert.deepEqual(rExact, {
      ok: true,
      path: path.join(multiDir, `cell-${atLimit}.sock`),
      mode: 'legacy',
      bytes: limit,
      limit,
    });

    const rOver = resolveStablePath(multiDir, overLimit, { platform });
    const expectedShort = path.join(multiDir, `cell~${sha32(overLimit)}.sock`);
    assert.equal(rOver.ok, true);
    assert.equal(rOver.mode, 'short');
    assert.equal(rOver.path, expectedShort);
    assert.equal(rOver.limit, limit);
    assert.ok(Buffer.byteLength(rOver.path, 'utf8') <= limit);

    // Crucial: choose a directory where UTF-16 `.length` <= limit while UTF-8 byte count > limit.
    const utf16TrickDir = '/tmp/' + '\u20ac'.repeat(5) + 'r'.repeat(40);
    const trickIdLen = limit - Buffer.byteLength(path.join(utf16TrickDir, 'cell-.sock'), 'utf8') + 1;
    assert.ok(trickIdLen <= 64);
    const trickId = 'x'.repeat(trickIdLen);
    const utf16Len = path.join(utf16TrickDir, `cell-${trickId}.sock`).length;
    const utf8Bytes = Buffer.byteLength(path.join(utf16TrickDir, `cell-${trickId}.sock`), 'utf8');
    assert.ok(utf16Len <= limit && utf8Bytes > limit, `expected UTF-16(${utf16Len}) <= ${limit} < UTF-8(${utf8Bytes})`);
    const resTrick = resolveStablePath(utf16TrickDir, trickId, { platform });
    assert.equal(resTrick.ok, true);
    assert.equal(resTrick.mode, 'short');
    assert.equal(path.basename(resTrick.path), `cell~${sha32(trickId)}.sock`);
  }
});

test('Termux HOME paths (90 B and 92 B) and real long launchRuntimeDir bind short 0o600 socket cleanly', async (t) => {
  const longId = 'Worker_Cell_' + 'a'.repeat(52);
  assert.equal(longId.length, 64);

  const termuxDir1 = path.join('/data/data/com.termux/files/home', '.nexuscrew', 'run');
  const termuxDir2 = path.join('/data/user/0/com.termux/files/home', '.nexuscrew', 'run');
  const res1 = resolveStablePath(termuxDir1, longId, { platform: 'linux' });
  const res2 = resolveStablePath(termuxDir2, longId, { platform: 'linux' });

  assert.equal(res1.ok, true);
  assert.equal(res1.mode, 'short');
  assert.equal(res1.bytes, 90);
  assert.ok(res1.bytes <= 107);

  assert.equal(res2.ok, true);
  assert.equal(res2.mode, 'short');
  assert.equal(res2.bytes, 92);
  assert.ok(res2.bytes <= 107);

  // Real filesystem bind using a long custom launchRuntimeDir whose legacy path exceeds 107 B.
  const base = makeTempDir(t, 'nc-lease-short-real-');
  const padLen = Math.max(4, 58 - Buffer.byteLength(base, 'utf8'));
  const longRuntimeDir = path.join(base, 'r'.repeat(padLen));
  const expectedLegacyBytes = Buffer.byteLength(path.join(longRuntimeDir, `cell-${longId}.sock`), 'utf8');
  assert.ok(expectedLegacyBytes > 107, `legacy bytes(${expectedLegacyBytes}) must exceed 107`);

  const mgr = createLeaseManager({ home: base, launchRuntimeDir: longRuntimeDir });
  t.after(() => mgr.close());

  const info = await mgr.track(longId);
  assert.equal(path.basename(info.stablePath), `cell~${sha32(longId)}.sock`);
  assert.ok(Buffer.byteLength(info.stablePath, 'utf8') <= 107);
  assert.equal(fs.statSync(info.stablePath).mode & 0o777, 0o600);

  const { serverSide, client: brokerClient } = await tcpPair();
  t.after(() => brokerClient.destroy());
  t.after(() => serverSide.destroy());
  assert.equal(mgr.attachInitial(longId, serverSide, { generation: 0 }), true);
  brokerClient.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  const ackFrame = await recv(brokerClient, (m) => m.type === 'ack');
  assert.ok(ackFrame.proof);

  // Verify the bound UDS accepts reconnect connections with the issued proof.
  brokerClient.destroy();
  const sock = await connectUnix(info.stablePath);
  t.after(() => sock.destroy());
  sock.write(`${JSON.stringify({ type: 'reconnect', generation: '1', proof: ackFrame.proof })}\n`);
  const leaseFrame = await recv(sock, (m) => m.type === 'lease');
  assert.ok(leaseFrame.leaseId);
  assert.ok(leaseFrame.proof);
});

test('full 64-byte prefix-sharing IDs get distinct short endpoints and invalid cellIds fail before side effects', async (t) => {
  const base = makeTempDir(t, 'nc-lease-short-id-');
  const runtimeSub = path.join(base, 'custom-long-runtime-segment-1234567890');
  const missingRuntime = path.join(base, 'never-created-runtime');
  let fsWrites = 0;
  let netListens = 0;

  const spyMgr = createLeaseManager(
    { home: base, launchRuntimeDir: missingRuntime },
    {
      fs: {
        ...fs,
        mkdirSync(...args) { fsWrites += 1; return fs.mkdirSync(...args); },
        writeFileSync(...args) { fsWrites += 1; return fs.writeFileSync(...args); },
      },
      net: {
        ...net,
        createServer(...args) {
          netListens += 1;
          return net.createServer(...args);
        },
      },
    },
  );
  t.after(() => spyMgr.close());

  for (const bad of ['', 'a:b', 'has space', 'cell~bad', 'x'.repeat(65)]) {
    assert.equal(resolveStablePath(runtimeSub, bad).ok, false);
    await assert.rejects(() => spyMgr.track(bad), /invalid cell identifier/);
  }
  assert.equal(fsWrites, 0);
  assert.equal(netListens, 0);
  assert.equal(fs.existsSync(missingRuntime), false);

  const idA = 'SamePrefix_' + 'p'.repeat(52) + 'A';
  const idB = 'SamePrefix_' + 'p'.repeat(52) + 'B';
  assert.equal(idA.length, 64);
  assert.equal(idB.length, 64);

  const padLen = Math.max(4, 58 - Buffer.byteLength(base, 'utf8'));
  const dir = path.join(base, 'd'.repeat(padLen));
  const mgr = createLeaseManager({ home: base, launchRuntimeDir: dir });
  t.after(() => mgr.close());

  const [infoA, infoB] = await Promise.all([mgr.track(idA), mgr.track(idB)]);
  assert.notEqual(infoA.stablePath, infoB.stablePath);
  assert.equal(path.basename(infoA.stablePath), `cell~${sha32(idA)}.sock`);
  assert.equal(path.basename(infoB.stablePath), `cell~${sha32(idB)}.sock`);

  const verifier = loadOrCreateVerifier({ dir });
  const nowTs = Date.now();
  const proofA = signProof(verifier, {
    kind: 'lease', cellId: idA, launchEpoch: infoA.launchEpoch,
    leaseId: 'a'.repeat(16), generation: '1', jti: '1'.repeat(16), issuedAt: nowTs,
  }, { now: () => nowTs });
  const sockB = await connectUnix(infoB.stablePath);
  t.after(() => sockB.destroy());
  sockB.write(`${JSON.stringify({ type: 'reconnect', generation: '1', proof: proofA })}\n`);
  const resB = await recv(sockB);
  assert.equal(resB.type, 'deny');
});

test('tilde namespace (~) stays strictly disjoint from legacy cell-<id>.sock names', () => {
  assert.equal(resolveStablePath('/tmp/nc-ns', 'tilde~cell').ok, false);

  const shortDir = '/tmp/nc-ns';
  const shortDigestId = '0'.repeat(32);
  const legacyRes = resolveStablePath(shortDir, shortDigestId);
  assert.equal(legacyRes.ok, true);
  assert.equal(legacyRes.mode, 'legacy');
  assert.equal(path.basename(legacyRes.path), `cell-${shortDigestId}.sock`);

  const longSamePrefix = 'long_' + '0'.repeat(59);
  const longDir = '/tmp/' + 'n'.repeat(50);
  const hashedRes = resolveStablePath(longDir, longSamePrefix, {
    digestFn: () => shortDigestId,
  });
  assert.equal(hashedRes.ok, true);
  assert.equal(hashedRes.mode, 'short');
  assert.equal(path.basename(hashedRes.path), `cell~${shortDigestId}.sock`);
  assert.notEqual(path.basename(legacyRes.path), path.basename(hashedRes.path));
});

test('simulated digest collision rejects conflict without unlinking or disturbing existing endpoint (sequential, Promise.all, and boot)', async (t) => {
  const base = makeTempDir(t, 'nc-lease-short-col-');
  const padLen = Math.max(4, 58 - Buffer.byteLength(base, 'utf8'));
  const dir = path.join(base, 'c'.repeat(padLen));
  const idA = 'Colliding_Cell_Alpha_' + '1'.repeat(43);
  const idB = 'Colliding_Cell_Bravo_' + '2'.repeat(43);
  const fixedDigest = 'deadbeef'.repeat(4);

  // 1) Sequential collision + spy verifying 0 unlinkSync on loser and invariant socket inode
  const unlinks = [];
  const logs = [];
  const spyFs = {
    ...fs,
    unlinkSync(target) {
      unlinks.push(target);
      return fs.unlinkSync(target);
    },
  };
  const mgr1 = createLeaseManager(
    { home: base, launchRuntimeDir: dir, leaseLog: (line) => logs.push(parseLeaseLog(line)) },
    { fs: spyFs, socketDigest: () => fixedDigest },
  );
  t.after(() => mgr1.close());

  const infoA = await mgr1.track(idA);
  const inoBefore = fs.statSync(infoA.stablePath).ino;
  const { serverSide, client: brokerClient } = await tcpPair();
  t.after(() => brokerClient.destroy());
  t.after(() => serverSide.destroy());
  assert.equal(mgr1.attachInitial(idA, serverSide, { generation: 0 }), true);

  unlinks.length = 0;
  await assert.rejects(() => mgr1.track(idB), /endpoint conflict/);
  assert.deepEqual(unlinks, [], 'conflicting track must never unlink the existing endpoint');
  assert.equal(fs.statSync(infoA.stablePath).ino, inoBefore);
  assert.equal(mgr1.status(idA).state, 'live');
  assert.ok(logs.some((e) => e.event === 'commit-failed' && e.cell === idB && e.reason === 'socket-conflict'));

  // Winner keeps serving refresh messages cleanly
  brokerClient.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  const ackA = await recv(brokerClient, (m) => m.type === 'ack');
  assert.ok(ackA.proof);
  mgr1.close();

  // 2) Concurrent Promise.all collision: only one owner reserves endpoint and zero unlinks occur against winner
  const concUnlinks = [];
  const concDir = path.join(base, 'k'.repeat(padLen));
  const mgr2 = createLeaseManager(
    { home: base, launchRuntimeDir: concDir },
    {
      fs: {
        ...fs,
        unlinkSync(target) {
          concUnlinks.push(target);
          return fs.unlinkSync(target);
        },
      },
      socketDigest: () => fixedDigest,
    },
  );
  t.after(() => mgr2.close());

  const settled = await Promise.allSettled([mgr2.track(idA), mgr2.track(idB)]);
  const fulfilled = settled.filter((r) => r.status === 'fulfilled');
  const rejected = settled.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /endpoint conflict/);
  assert.equal(concUnlinks.length, 1, 'only the single winner performs pre-listen stale cleanup');
  assert.equal(mgr2._cells.size, 1);
  mgr2.close();

  // 3) Persisted boot() collision: first persisted cell opens endpoint, colliding second cell skips without touching first
  const bootDir = path.join(base, 'b'.repeat(padLen));
  const stateDir = path.join(bootDir, 'cell-leases');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const futureDeadline = Date.now() + 60_000;
  fs.writeFileSync(path.join(stateDir, `${idA}.json`), JSON.stringify({ launchEpoch: '1'.repeat(16), graceDeadline: futureDeadline }));
  fs.writeFileSync(path.join(stateDir, `${idB}.json`), JSON.stringify({ launchEpoch: '2'.repeat(16), graceDeadline: futureDeadline }));

  const bootLogs = [];
  const bootUnlinks = [];
  const mgrBoot = createLeaseManager(
    { home: base, launchRuntimeDir: bootDir, leaseLog: (line) => bootLogs.push(parseLeaseLog(line)) },
    {
      fs: {
        ...fs,
        unlinkSync(target) {
          bootUnlinks.push(target);
          return fs.unlinkSync(target);
        },
      },
      socketDigest: () => fixedDigest,
    },
  );
  t.after(() => mgrBoot.close());

  await mgrBoot.boot();
  assert.equal(mgrBoot._cells.size, 1);
  assert.equal(bootUnlinks.length, 1);
  assert.ok(bootLogs.some((e) => e.event === 'commit-failed' && e.reason === 'socket-conflict'));
});

test('full short-socket lifecycle: track -> attach/refresh -> close -> boot -> startLeaseClient reconnect with full-cellId proof', async (t) => {
  const base = makeTempDir(t, 'nc-lease-short-life-');
  const padLen = Math.max(4, 58 - Buffer.byteLength(base, 'utf8'));
  const dir = path.join(base, 'l'.repeat(padLen));
  const longId = 'Lifecycle_Short_Socket_' + 'z'.repeat(41);
  const otherId = 'Forged_Other_Cell_' + 'y'.repeat(46);

  const mgr1 = createLeaseManager({ home: base, launchRuntimeDir: dir });
  t.after(() => mgr1.close());
  const info = await mgr1.track(longId);
  assert.equal(path.basename(info.stablePath), `cell~${sha32(longId)}.sock`);

  const { serverSide: initServer1, client: initClient1 } = await tcpPair();
  t.after(() => { try { initClient1.destroy(); } catch (_) {} });
  t.after(() => { try { initServer1.destroy(); } catch (_) {} });
  assert.equal(mgr1.attachInitial(longId, initServer1, { generation: 1 }), true);

  let currentGen = 1;
  let reconnectedObserved = false;
  const firstAckPromise = recv(initClient1, (m) => m.type === 'ack' && Boolean(m.proof));
  const lc = startLeaseClient(initClient1, {
    launchEpoch: info.launchEpoch,
    stablePath: info.stablePath,
    generation: () => currentGen,
  }, {
    retryDelayMs: 25,
    onReconnected: () => { reconnectedObserved = true; },
  });
  assert.ok(lc);
  t.after(() => lc.stop());

  const firstAck = await firstAckPromise;
  assert.ok(firstAck.proof);

  // Close initial server and stop channel cleanly before rebooting second server instance
  initServer1.destroy();
  initClient1.destroy();
  mgr1.close();
  assert.equal(fs.existsSync(info.stablePath), false, 'close() must unlink short endpoint');

  // Reboot server manager: boot() reloads persisted entry and reopens exact same short socket
  const mgr2 = createLeaseManager({ home: base, launchRuntimeDir: dir });
  t.after(() => mgr2.close());
  await mgr2.boot();
  assert.equal(fs.existsSync(info.stablePath), true, 'boot() must reopen short endpoint');

  // Forged proof signed for another cellId must be denied on the short endpoint
  const verifier = loadOrCreateVerifier({ dir });
  const forgedNow = Date.now();
  const forgedProof = signProof(verifier, {
    kind: 'lease',
    cellId: otherId,
    launchEpoch: info.launchEpoch,
    leaseId: 'f'.repeat(16),
    generation: '2',
    jti: 'f'.repeat(16),
    issuedAt: forgedNow,
  }, { now: () => forgedNow });
  const probe = await connectUnix(info.stablePath);
  t.after(() => { try { probe.destroy(); } catch (_) {} });
  probe.write(`${JSON.stringify({ type: 'reconnect', generation: '2', proof: forgedProof })}\n`);
  const denyMsg = await recv(probe);
  assert.equal(denyMsg.type, 'deny');
  probe.destroy();

  // Wait for legitimate lease client to reconnect over info.stablePath with full-cellId heldProof
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 4000;
    const poll = () => {
      const st = mgr2.status(longId);
      if (st.state === 'live' && st.leaseId) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error(`short-socket reconnect did not reach live state (state=${st.state})`)); return; }
      setTimeout(poll, 10);
    };
    poll();
  });

  lc.stop();
  mgr2.close();
  assert.equal(fs.existsSync(info.stablePath), false, 'final close() must unlink short endpoint');
});

test('impossible final runtimeDir rejects before any side effects and builtin runtime fails with redacted LEASE_ARM_FAILED pre-launch', async (t) => {
  const base = makeTempDir(t, 'nc-lease-short-imp-');
  // >= 65 UTF-8 bytes guarantees <dir>/cell~<32hex>.sock exceeds 107 B on Linux/Android.
  const padLen = Math.max(4, 72 - Buffer.byteLength(base, 'utf8'));
  const impossibleDir = path.join(base, 'x'.repeat(padLen));
  const longId = 'Impossible_Path_Cell_' + 'q'.repeat(43);

  let fsEffects = 0;
  let netEffects = 0;
  const logs = [];
  const spyMgr = createLeaseManager(
    { home: base, launchRuntimeDir: impossibleDir, leaseLog: (l) => logs.push(parseLeaseLog(l)) },
    {
      fs: {
        ...fs,
        mkdirSync(...args) { fsEffects += 1; return fs.mkdirSync(...args); },
        writeFileSync(...args) { fsEffects += 1; return fs.writeFileSync(...args); },
        unlinkSync(...args) { fsEffects += 1; return fs.unlinkSync(...args); },
      },
      net: {
        ...net,
        createServer(...args) { netEffects += 1; return net.createServer(...args); },
      },
    },
  );
  t.after(() => spyMgr.close());

  let caught = null;
  try {
    await spyMgr.track(longId);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'impossible final path must reject explicitly');
  assert.match(caught.message, /exceeds platform limit/);
  assert.equal(caught.message.includes(impossibleDir), false, 'error must not leak filesystem path');
  assert.equal(caught.message.includes(base), false);
  assert.equal(fsEffects, 0, 'zero fs side effects allowed on impossible path');
  assert.equal(netEffects, 0, 'zero net side effects allowed on impossible path');
  assert.equal(fs.existsSync(impossibleDir), false);
  assert.equal(spyMgr._cells.size, 0);
  assert.ok(logs.some((e) => e.event === 'commit-failed' && e.cell === longId && e.reason === 'socket-path'));

  // Empty or non-string runtime directory uses dedicated invalid-dir reason (redacted, zero path leak)
  assert.deepEqual(resolveStablePath('', 'Dev'), { ok: false, reason: 'invalid-dir', bytes: 0, limit: socketPathLimit() });
  assert.deepEqual(resolveStablePath(null, 'Dev'), { ok: false, reason: 'invalid-dir', bytes: 0, limit: socketPathLimit() });

  // Builtin fleet integration: up() rejects with LEASE_ARM_FAILED before any launchBroker.issue or tmux new-session spawn
  // Use a deep home so <home>/.nexuscrew/run itself exceeds the impossible short-path threshold (> 64 B).
  const deepHome = path.join(base, 'h'.repeat(padLen));
  fs.mkdirSync(deepHome, { recursive: true, mode: 0o700 });
  const deepRunDir = path.join(deepHome, '.nexuscrew', 'run');
  const cwd = path.join(deepHome, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const cmdBin = path.join(deepHome, 'fake-cli');
  fs.writeFileSync(cmdBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
  const defsPath = path.join(base, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'claude',
      label: 'Claude',
      rc: true,
      command: cmdBin,
      args: ['--dangerously-skip-permissions'],
      env: { ANTHROPIC_API_KEY: 'sk-x' },
      model: { flag: '--model', value: 'sonnet' },
      promptMode: 'flag',
      promptFlag: '--append-system-prompt',
    }],
    cells: [{ id: 'ImpossibleCell', tmuxSession: 'work-short-imp', cwd, engine: 'claude', boot: true, prompt: 'test' }],
  });
  const tmuxLog = path.join(base, 'tmux.log');
  const fakeTmux = path.join(base, 'fake-tmux');
  fs.writeFileSync(fakeTmux, `#!/bin/sh
echo "$*" >> ${JSON.stringify(tmuxLog)}
case "$1" in
  has-session) exit 1 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });

  let brokerIssueCalls = 0;
  const realBroker = createLaunchBroker({
    home: deepHome,
    launchRuntimeDir: deepRunDir,
    cellLeaseEnabled: true,
    log: () => {},
  });
  const spyBroker = {
    ...realBroker,
    async issue(...args) {
      brokerIssueCalls += 1;
      return realBroker.issue(...args);
    },
  };

  const fleet = await createBuiltinFleet({
    home: deepHome,
    filesRoot: path.join(base, 'files'),
    fleetDefsPath: defsPath,
    tmuxBin: fakeTmux,
    cellLeaseEnabled: true,
    launchRuntimeDir: deepRunDir,
    launchBroker: spyBroker,
    log: () => {},
  });
  t.after(async () => {
    if (fleet && typeof fleet.close === 'function') {
      try { await fleet.close(); } catch (_) {}
    }
  });

  let fleetErr = null;
  try {
    await fleet.up('ImpossibleCell');
  } catch (e) {
    fleetErr = e;
  }
  assert.ok(fleetErr);
  assert.equal(fleetErr.fleetCode, 'LEASE_ARM_FAILED');
  assert.equal(brokerIssueCalls, 0, 'launchBroker.issue must not run when lease track rejects impossible path');
  assert.equal(String(fleetErr.message).includes(deepRunDir), false);
  assert.equal(String(fleetErr.message).includes(deepHome), false);
  const tmuxCalls = fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8') : '';
  assert.equal(tmuxCalls.includes('new-session'), false, 'tmux new-session must not run before lease failure');
  assert.equal(fs.existsSync(deepRunDir), false, 'impossible runtime dir must remain uncreated');
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createListenBarrierNet() {
  let createServerCalls = 0;
  let listenCalls = 0;
  const gates = [];
  const waiters = [];
  const servers = [];

  return {
    get createServerCalls() { return createServerCalls; },
    get listenCalls() { return listenCalls; },
    gates,
    servers,
    async nextGate(idx = 0) {
      if (gates[idx]) return gates[idx];
      return new Promise((resolve) => {
        waiters.push({ idx, resolve });
      });
    },
    netImpl: {
      ...net,
      createServer(...args) {
        createServerCalls += 1;
        const real = net.createServer(...args);
        let closedCalled = false;
        const origClose = real.close.bind(real);
        real.close = (...closeArgs) => {
          closedCalled = true;
          return origClose(...closeArgs);
        };
        const origListen = real.listen.bind(real);
        real.listen = (sp, cb) => {
          listenCalls += 1;
          const gate = deferred();
          const entry = {
            sp,
            server: real,
            closedCalled: () => closedCalled,
            entered: deferred(),
            releaseSuccess: () => {
              origListen(sp, () => {
                if (typeof cb === 'function') cb();
                gate.resolve();
              });
            },
            releaseCallbackOnly: () => {
              // Simulate listen callback firing after close without mutating a successor socket
              if (typeof cb === 'function') cb();
              gate.resolve();
            },
            releaseError: (err = Object.assign(new Error('listen failed'), { code: 'EACCES' })) => {
              real.emit('error', err);
              gate.resolve();
            },
          };
          const idx = gates.length;
          gates.push(entry);
          entry.entered.resolve(entry);
          for (let i = waiters.length - 1; i >= 0; i -= 1) {
            if (waiters[i].idx === idx) {
              waiters[i].resolve(entry);
              waiters.splice(i, 1);
            }
          }
          return real;
        };
        servers.push(real);
        return real;
      },
    },
  };
}

test('close during in-flight open keeps admission closed monotonically, censors pending open, and blocks late publish and winner unlink/chmod', async (t) => {
  const base = makeTempDir(t, 'nc-lease-close-race-');
  const padLen = Math.max(4, 58 - Buffer.byteLength(base, 'utf8'));
  const cellA = 'CloseRace_Alpha_' + 'a'.repeat(48);
  const cellB = 'CloseRace_Bravo_' + 'b'.repeat(48);
  const fixedDigest = 'cafebabe'.repeat(4);

  // 1) Late listen success callback after close() never republishes entry/server; closed manager rejects track/boot
  {
    const dir = path.join(base, 's'.repeat(padLen));
    const barrier = createListenBarrierNet();
    const mgr = createLeaseManager({ home: base, launchRuntimeDir: dir }, { net: barrier.netImpl, socketDigest: () => fixedDigest });
    t.after(() => { try { mgr.close(); } catch (_) {} });

    const trackP = mgr.track(cellA);
    const gate = await barrier.nextGate(0);

    const closeRes = mgr.close();
    assert.equal(closeRes.closed, true);
    assert.equal(closeRes.pendingOpens, 1);
    assert.equal(closeRes.unresolvedOpens, 1);
    assert.equal(mgr.readiness().closed, true);
    assert.equal(mgr.readiness().pendingOpens, 1);
    assert.equal(mgr._endpointOwners.size, 1, 'reservation must stay held while suspended open outcome is unknown');

    await assert.rejects(() => mgr.track(cellB), /manager is closed/);
    await assert.rejects(() => mgr.boot(), /manager is closed/);

    gate.releaseCallbackOnly();
    await assert.rejects(() => trackP, /closed|aborted/);
    assert.equal(mgr._cells.size, 0, 'closed manager must never publish late entry');
    assert.equal(mgr.readiness().listening, 0);
    await mgr.whenClosed();
    assert.equal(mgr.readiness().pendingOpens, 0);
    assert.equal(mgr.readiness().unresolvedOpens, 0);
  }

  // 2) Late listen error event after close() leaves closed manager empty and cleans reservation cleanly
  {
    const dir = path.join(base, 'e'.repeat(padLen));
    const barrier = createListenBarrierNet();
    const mgr = createLeaseManager({ home: base, launchRuntimeDir: dir }, { net: barrier.netImpl, socketDigest: () => fixedDigest });
    t.after(() => { try { mgr.close(); } catch (_) {} });

    const trackP = mgr.track(cellA);
    const gate = await barrier.nextGate(0);
    mgr.close();
    assert.equal(mgr._endpointOwners.size, 1);

    gate.releaseError(new Error('late bind error'));
    await assert.rejects(() => trackP, /manager is closed/);
    assert.equal(mgr._cells.size, 0);
    await mgr.whenClosed();
    assert.equal(mgr.readiness().pendingOpens, 0);
    assert.equal(mgr.readiness().unresolvedOpens, 0);
    assert.equal(mgr._endpointOwners.size, 0);
  }

  // 3) Colliding successor binds path after close; late chmod/callback on closed predecessor performs ZERO chmod/unlink on winner
  {
    const dir = path.join(base, 'c'.repeat(padLen));
    const sharedPath = resolveStablePath(dir, cellA, { digestFn: () => fixedDigest }).path;
    const oldChmodTargets = [];
    const oldUnlinkTargets = [];
    const barrier = createListenBarrierNet();

    const oldMgr = createLeaseManager(
      { home: base, launchRuntimeDir: dir },
      {
        net: barrier.netImpl,
        socketDigest: () => fixedDigest,
        fs: {
          ...fs,
          chmodSync(target, mode) {
            oldChmodTargets.push(target);
            throw Object.assign(new Error('chmod boom'), { code: 'EPERM' });
          },
          unlinkSync(target) {
            oldUnlinkTargets.push(target);
            return fs.unlinkSync(target);
          },
        },
      },
    );
    t.after(() => { try { oldMgr.close(); } catch (_) {} });

    const trackAP = oldMgr.track(cellA);
    const gateA = await barrier.nextGate(0);
    oldMgr.close();
    oldUnlinkTargets.length = 0;

    // Successor acquires colliding path and starts serving live client
    const winnerMgr = createLeaseManager({ home: base, launchRuntimeDir: dir }, { socketDigest: () => fixedDigest });
    t.after(() => { try { winnerMgr.close(); } catch (_) {} });
    const infoB = await winnerMgr.track(cellB);
    assert.equal(infoB.stablePath, sharedPath);
    const winnerIno = fs.statSync(sharedPath).ino;

    const { serverSide, client: brokerClient } = await tcpPair();
    t.after(() => brokerClient.destroy());
    t.after(() => serverSide.destroy());
    assert.equal(winnerMgr.attachInitial(cellB, serverSide, { generation: 0 }), true);

    // Trigger stalled callback of closed oldMgr -> must perform ZERO chmod/unlink on winner's socket
    gateA.releaseCallbackOnly();
    await assert.rejects(() => trackAP, /closed|aborted/);
    assert.deepEqual(oldChmodTargets, [], 'closed open must not invoke chmodSync on successor endpoint');
    assert.deepEqual(oldUnlinkTargets, [], 'closed open must not invoke unlinkSync on successor endpoint');
    assert.equal(fs.statSync(sharedPath).ino, winnerIno, 'winner socket inode must remain intact');

    brokerClient.write(`${JSON.stringify({ type: 'refresh' })}\n`);
    const ack = await recv(brokerClient, (m) => m.type === 'ack');
    assert.ok(ack.proof);
  }

  // 4) Re-entrant close inside chmodSync right before chmod failure also preserves winner endpoint (zero unlink in chmod catch)
  {
    const dir = path.join(base, 'r'.repeat(padLen));
    const sharedPath = resolveStablePath(dir, cellA, { digestFn: () => fixedDigest }).path;
    const oldUnlinkTargets = [];
    const barrier = createListenBarrierNet();
    let oldMgr = null;
    let winnerMgr = null;
    let winnerInfo = null;

    oldMgr = createLeaseManager(
      { home: base, launchRuntimeDir: dir },
      {
        net: barrier.netImpl,
        socketDigest: () => fixedDigest,
        fs: {
          ...fs,
          chmodSync(target) {
            // Simulate close + colliding owner acquiring path just before chmod throws
            oldMgr.close();
            oldUnlinkTargets.length = 0;
            // Synchronously place winner socket file on disk at sharedPath and open winner manager afterward
            throw Object.assign(new Error('late chmod failure'), { code: 'EPERM' });
          },
          unlinkSync(target) {
            oldUnlinkTargets.push(target);
            return fs.unlinkSync(target);
          },
        },
      },
    );
    t.after(() => { try { oldMgr.close(); } catch (_) {} });

    const trackAP = oldMgr.track(cellA);
    const gateA = await barrier.nextGate(0);
    // Actually bind sharedPath via winner-like file before releasing callback so winner's inode exists
    winnerMgr = createLeaseManager({ home: base, launchRuntimeDir: dir }, { socketDigest: () => fixedDigest });
    t.after(() => { try { winnerMgr.close(); } catch (_) {} });
    winnerInfo = await winnerMgr.track(cellB);
    const inoBefore = fs.statSync(winnerInfo.stablePath).ino;

    gateA.releaseCallbackOnly();
    await assert.rejects(() => trackAP, /late chmod failure|closed/);
    assert.deepEqual(oldUnlinkTargets, [], 'chmod catch must not unlink endpoint once aborted by close');
    assert.equal(fs.existsSync(winnerInfo.stablePath), true);
    assert.equal(fs.statSync(winnerInfo.stablePath).ino, inoBefore);
  }

  // 5) Fleet close() at deadline with in-flight open in listen barrier preserves synchronous close() with zero late publish
  {
    const fleetBase = path.join(base, 'fleet-inflight');
    const fleetDir = path.join(fleetBase, 'run');
    const cwd = path.join(fleetBase, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    const cmdBin = path.join(fleetBase, 'fake-cli');
    fs.writeFileSync(cmdBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const defsPath = path.join(fleetBase, 'fleet.json');
    atomicWrite(defsPath, {
      schemaVersion: 1,
      engines: [{
        id: 'claude', label: 'Claude', rc: true, command: cmdBin,
        args: [], env: {}, model: { flag: '--model', value: 'sonnet' },
        promptMode: 'flag', promptFlag: '--prompt',
      }],
      cells: [{ id: 'InFlightCell', tmuxSession: 'work-inflight', cwd, engine: 'claude', boot: false, prompt: 'hi' }],
    });
    const fakeTmux = path.join(fleetBase, 'fake-tmux');
    fs.writeFileSync(fakeTmux, `#!/bin/sh
case "$1" in
  has-session) exit 1 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });

    const barrier = createListenBarrierNet();
    const leaseMgr = createLeaseManager(
      { home: fleetBase, launchRuntimeDir: fleetDir },
      { net: barrier.netImpl },
    );
    t.after(() => { try { leaseMgr.close(); } catch (_) {} });

    const fleet = await createBuiltinFleet({
      home: fleetBase,
      filesRoot: path.join(fleetBase, 'files'),
      fleetDefsPath: defsPath,
      tmuxBin: fakeTmux,
      cellLeaseEnabled: true,
      launchRuntimeDir: fleetDir,
      leaseManager: leaseMgr,
      log: () => {},
    });

    const upPromise = fleet.up('InFlightCell').catch((e) => e);
    while (barrier.gates.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const gate = await barrier.gates[0].entered.promise;

    const closeOut = await fleet.close({ budgetMs: 0 });
    assert.equal(closeOut.leaseClosed, false);
    assert.equal(closeOut.quiescent, false);
    assert.equal(closeOut.canCleanupOwnedResources, false);
    assert.ok(closeOut.codes.includes('LEASE_CLOSE_ERROR'));
    assert.equal(leaseMgr.readiness().closed, true);
    assert.equal(leaseMgr.readiness().pendingOpens, 1);
    assert.equal(leaseMgr.readiness().unresolvedOpens, 1);

    gate.releaseCallbackOnly();
    const upRes = await upPromise;
    assert.ok(upRes instanceof Error);
    assert.equal(leaseMgr._cells.size, 0, 'no late cell entry published into closed leaseManager');
    await leaseMgr.whenClosed();
    assert.equal(leaseMgr.readiness().pendingOpens, 0);
    assert.equal(leaseMgr.readiness().unresolvedOpens, 0);
  }
});

test('boot and track on the same cell share a single open attempt across both orders (success and failure)', async (t) => {
  const base = makeTempDir(t, 'nc-lease-boot-track-');
  const padLen = Math.max(4, 58 - Buffer.byteLength(base, 'utf8'));
  const cellId = 'SharedOpen_Cell_' + 'm'.repeat(48);
  const persistedEpoch = 'a1b2c3d4e5f60718';

  const setupPersisted = (sub) => {
    const dir = path.join(base, sub + 'p'.repeat(padLen));
    const stateDir = path.join(dir, 'cell-leases');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(stateDir, `${cellId}.json`),
      JSON.stringify({ launchEpoch: persistedEpoch, graceDeadline: Date.now() + 60_000 }),
      { mode: 0o600 },
    );
    return dir;
  };

  // 1) Order boot -> concurrent track, SUCCESS
  {
    const dir = setupPersisted('b1');
    let unlinkCount = 0;
    const barrier = createListenBarrierNet();
    const spiedFs = {
      ...fs,
      unlinkSync(target) {
        if (String(target).endsWith('.sock')) unlinkCount += 1;
        return fs.unlinkSync(target);
      },
    };
    const mgr = createLeaseManager({ home: base, launchRuntimeDir: dir }, { fs: spiedFs, net: barrier.netImpl });
    t.after(() => { try { mgr.close(); } catch (_) {} });

    const bootP = mgr.boot();
    const gate = await barrier.gates[0].entered.promise;
    const trackP = mgr.track(cellId);
    await new Promise((r) => setTimeout(r, 15));

    assert.equal(unlinkCount, 1, 'boot+track paused at first listen must do only 1 unlink');
    assert.equal(barrier.createServerCalls, 1, 'boot+track must create only 1 server');
    assert.equal(barrier.listenCalls, 1, 'boot+track must listen only once');

    gate.releaseSuccess();
    const [, trackInfo] = await Promise.all([bootP, trackP]);
    assert.equal(unlinkCount, 1);
    assert.equal(barrier.createServerCalls, 1);
    assert.equal(barrier.listenCalls, 1);
    assert.equal(trackInfo.launchEpoch, persistedEpoch, 'persisted valid epoch must stay invariant');
    assert.equal(mgr._cells.size, 1);
    assert.ok(mgr._cells.get(cellId).stableServer);
    mgr.close();
  }

  // 2) Order boot -> concurrent track, FAILURE
  {
    const dir = setupPersisted('b2');
    let unlinkCount = 0;
    const logs = [];
    const barrier = createListenBarrierNet();
    const spiedFs = {
      ...fs,
      unlinkSync(target) {
        if (String(target).endsWith('.sock')) unlinkCount += 1;
        return fs.unlinkSync(target);
      },
    };
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: dir, leaseLog: (l) => logs.push(parseLeaseLog(l)) },
      { fs: spiedFs, net: barrier.netImpl },
    );
    t.after(() => { try { mgr.close(); } catch (_) {} });

    const bootP = mgr.boot();
    const gate = await barrier.gates[0].entered.promise;
    const trackP = mgr.track(cellId);
    await new Promise((r) => setTimeout(r, 15));

    gate.releaseError(new Error('boot open bind failure'));
    await bootP;
    await assert.rejects(() => trackP, /boot open bind failure/);
    assert.equal(unlinkCount, 1);
    assert.equal(barrier.createServerCalls, 1);
    assert.equal(barrier.listenCalls, 1);
    assert.equal(mgr._cells.get(cellId)?.launchEpoch, persistedEpoch);
    assert.equal(mgr._cells.get(cellId)?.stableServer, null);
    assert.ok(logs.some((e) => e.event === 'commit-failed' && e.cell === cellId && e.reason === 'endpoint'));
    await new Promise((r) => setImmediate(r));
    assert.equal(mgr.readiness().pendingOpens, 0);
    mgr.close();
  }

  // 3) Order track -> concurrent boot, SUCCESS
  {
    const dir = setupPersisted('t1');
    let unlinkCount = 0;
    const barrier = createListenBarrierNet();
    const spiedFs = {
      ...fs,
      unlinkSync(target) {
        if (String(target).endsWith('.sock')) unlinkCount += 1;
        return fs.unlinkSync(target);
      },
    };
    const mgr = createLeaseManager({ home: base, launchRuntimeDir: dir }, { fs: spiedFs, net: barrier.netImpl });
    t.after(() => { try { mgr.close(); } catch (_) {} });

    const trackP = mgr.track(cellId);
    while (barrier.gates.length === 0) await new Promise((r) => setTimeout(r, 2));
    const gate = await barrier.gates[0].entered.promise;
    const bootP = mgr.boot();
    await new Promise((r) => setTimeout(r, 15));

    assert.equal(unlinkCount, 1);
    assert.equal(barrier.createServerCalls, 1);
    assert.equal(barrier.listenCalls, 1);

    gate.releaseSuccess();
    const [trackInfo] = await Promise.all([trackP, bootP]);
    assert.equal(unlinkCount, 1);
    assert.equal(barrier.createServerCalls, 1);
    assert.equal(barrier.listenCalls, 1);
    assert.equal(trackInfo.launchEpoch, persistedEpoch);
    assert.equal(mgr._cells.size, 1);
    assert.ok(mgr._cells.get(cellId).stableServer);
    mgr.close();
  }

  // 4) Order track -> concurrent boot, FAILURE (no second unlink/listen and no orphan handles)
  {
    const dir = setupPersisted('t2');
    let unlinkCount = 0;
    const logs = [];
    const barrier = createListenBarrierNet();
    const spiedFs = {
      ...fs,
      unlinkSync(target) {
        if (String(target).endsWith('.sock')) unlinkCount += 1;
        return fs.unlinkSync(target);
      },
    };
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: dir, leaseLog: (l) => logs.push(parseLeaseLog(l)) },
      { fs: spiedFs, net: barrier.netImpl },
    );
    t.after(() => { try { mgr.close(); } catch (_) {} });

    const trackP = mgr.track(cellId);
    while (barrier.gates.length === 0) await new Promise((r) => setTimeout(r, 2));
    const gate = await barrier.gates[0].entered.promise;
    const bootP = mgr.boot();
    await new Promise((r) => setTimeout(r, 15));

    gate.releaseError(new Error('track open bind failure'));
    await assert.rejects(() => trackP, /track open bind failure/);
    await bootP;
    assert.equal(unlinkCount, 1);
    assert.equal(barrier.createServerCalls, 1);
    assert.equal(barrier.listenCalls, 1);
    assert.equal(mgr._cells.get(cellId)?.launchEpoch, persistedEpoch);
    assert.equal(mgr._cells.get(cellId)?.stableServer, null);
    await new Promise((r) => setImmediate(r));
    assert.equal(mgr.readiness().pendingOpens, 0);
    mgr.close();
  }
});

test('open and persistence error matrix preserves owner reservations, live state, post-rename uncertainty, and cleanup residues against colliding IDs', async (t) => {
  const base = makeTempDir(t, 'nc-lease-err-matrix-');
  const padLen = Math.max(4, 58 - Buffer.byteLength(base, 'utf8'));
  const cellA = 'Matrix_Cell_Alpha_' + '1'.repeat(46);
  const cellB = 'Matrix_Cell_Bravo_' + '2'.repeat(46);
  const fixedDigest = 'feedface'.repeat(4);

  // 1) New track fails pre-bind -> owner releases reservation and colliding successor B is admitted cleanly
  {
    const dir = path.join(base, 'pre' + 'x'.repeat(padLen));
    let failCreateOnce = true;
    let createCalls = 0;
    let unlinkCalls = 0;
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: dir },
      {
        socketDigest: () => fixedDigest,
        fs: {
          ...fs,
          unlinkSync(target) {
            if (String(target).endsWith('.sock')) unlinkCalls += 1;
            return fs.unlinkSync(target);
          },
        },
        net: {
          ...net,
          createServer(...args) {
            createCalls += 1;
            if (failCreateOnce) {
              failCreateOnce = false;
              throw Object.assign(new Error('createServer failed pre-bind'), { code: 'EACCES' });
            }
            return net.createServer(...args);
          },
        },
      },
    );
    t.after(() => mgr.close());

    await assert.rejects(() => mgr.track(cellA), /createServer failed pre-bind/);
    assert.equal(mgr._cells.size, 0);
    assert.equal(mgr._endpointOwners.size, 0, 'failed pre-bind new track must release its own reservation');

    const infoB = await mgr.track(cellB);
    const winnerIno = fs.statSync(infoB.stablePath).ino;
    assert.equal(mgr._cells.size, 1);
    assert.ok(mgr._cells.get(cellB).stableServer);
    assert.equal(createCalls, 2);
    assert.equal(unlinkCalls, 2);
    assert.equal(fs.statSync(infoB.stablePath).ino, winnerIno);
    mgr.close();
  }

  // 2) Pre-existing live cell with persist failure keeps live lease, identity, handle/inode, and blocks colliding ID
  {
    const dir = path.join(base, 'liv' + 'x'.repeat(padLen));
    let failWrite = false;
    let sockUnlinks = 0;
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: dir },
      {
        socketDigest: () => fixedDigest,
        fs: {
          ...fs,
          writeFileSync(p, ...rest) {
            if (failWrite && String(p).endsWith('.tmp')) {
              throw Object.assign(new Error('store write failed'), { code: 'EACCES' });
            }
            return fs.writeFileSync(p, ...rest);
          },
          unlinkSync(target) {
            if (String(target).endsWith('.sock')) sockUnlinks += 1;
            return fs.unlinkSync(target);
          },
        },
      },
    );
    t.after(() => mgr.close());

    const infoA = await mgr.track(cellA);
    const inoBefore = fs.statSync(infoA.stablePath).ino;
    const serverBefore = mgr._cells.get(cellA).stableServer;
    const { serverSide, client: brokerClient } = await tcpPair();
    t.after(() => brokerClient.destroy());
    t.after(() => serverSide.destroy());
    assert.equal(mgr.attachInitial(cellA, serverSide, { generation: 0 }), true);

    failWrite = true;
    await assert.rejects(() => mgr.track(cellA), /not persisted/);
    failWrite = false;

    assert.equal(mgr.status(cellA).state, 'live');
    assert.equal(mgr._cells.get(cellA).launchEpoch, infoA.launchEpoch);
    assert.equal(mgr._cells.get(cellA).stableServer, serverBefore);
    assert.equal(fs.statSync(infoA.stablePath).ino, inoBefore);

    const unlinksBeforeConflict = sockUnlinks;
    await assert.rejects(() => mgr.track(cellB), /endpoint conflict/);
    assert.equal(sockUnlinks, unlinksBeforeConflict, 'conflicting track must perform zero unlinks');
    assert.equal(fs.statSync(infoA.stablePath).ino, inoBefore);

    brokerClient.write(`${JSON.stringify({ type: 'refresh' })}\n`);
    const ack = await recv(brokerClient, (m) => m.type === 'ack');
    assert.ok(ack.proof);
    mgr.close();
  }

  // 2b) Recovery-loaded entry with persist failure restores persisted identity, record, reservation, and rejects colliding B
  {
    const dir = path.join(base, 'rec' + 'x'.repeat(padLen));
    const stateDir = path.join(dir, 'cell-leases');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const savedEpoch = '0123456789abcdef';
    const savedDeadline = Date.now() + 50_000;
    const savedPath = path.join(stateDir, `${cellA}.json`);
    fs.writeFileSync(savedPath, JSON.stringify({ launchEpoch: savedEpoch, graceDeadline: savedDeadline }), { mode: 0o600 });

    let failWrite = true;
    let sockUnlinks = 0;
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: dir },
      {
        socketDigest: () => fixedDigest,
        fs: {
          ...fs,
          writeFileSync(p, ...rest) {
            if (failWrite && String(p).endsWith('.tmp')) {
              throw Object.assign(new Error('recovery store write failed'), { code: 'EACCES' });
            }
            return fs.writeFileSync(p, ...rest);
          },
          unlinkSync(target) {
            if (String(target).endsWith('.sock')) sockUnlinks += 1;
            return fs.unlinkSync(target);
          },
        },
      },
    );
    t.after(() => mgr.close());

    mgr.loadPersisted();
    assert.equal(mgr._cells.get(cellA).launchEpoch, savedEpoch);
    assert.equal(mgr._cells.get(cellA).stableServer, null);

    await assert.rejects(() => mgr.track(cellA), /not persisted/);
    failWrite = false;
    assert.equal(mgr._cells.get(cellA).launchEpoch, savedEpoch);
    assert.equal(mgr._cells.get(cellA).graceDeadline, savedDeadline);
    assert.equal(mgr._cells.get(cellA).stableServer, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(savedPath, 'utf8')), { launchEpoch: savedEpoch, graceDeadline: savedDeadline });

    const unlinksBeforeB = sockUnlinks;
    await assert.rejects(() => mgr.track(cellB), /endpoint conflict/);
    assert.equal(sockUnlinks, unlinksBeforeB);
    mgr.close();
  }

  // 3) Error after rename (rename applies durable file then throws EIO): never claims absence of durable effect
  {
    const dir = path.join(base, 'unc' + 'x'.repeat(padLen));
    const logs = [];
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: dir, leaseLog: (l) => logs.push(parseLeaseLog(l)) },
      {
        socketDigest: () => fixedDigest,
        fs: {
          ...fs,
          renameSync(from, to) {
            fs.renameSync(from, to);
            throw Object.assign(new Error('disk error after rename'), { code: 'EIO' });
          },
        },
      },
    );
    t.after(() => mgr.close());

    let caught = null;
    try {
      await mgr.track(cellA);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught);
    assert.equal(caught.persistOutcome, 'uncertain');
    assert.match(caught.message, /uncertain/);
    assert.equal(/non persistito|not persisted/.test(caught.message), false, 'post-rename fault must never claim absence of durable write');
    assert.ok(logs.some((e) => e.event === 'commit-failed' && e.cell === cellA && e.reason === 'persist-uncertain'));
    const persistedPath = path.join(dir, 'cell-leases', `${cellA}.json`);
    assert.equal(fs.existsSync(persistedPath), true, 'durable record written by rename remains observable on disk');

    // Colliding cell B must be rejected rather than overwriting/stealing uncertain persisted reservation
    await assert.rejects(() => mgr.track(cellB), /endpoint conflict/);
    mgr.close();
  }

  // 4) Cleanup failure / unknown usage (chmod fails + unlink fails): residue stays protected, zero destructive steal by colliding ID
  {
    const dir = path.join(base, 'res' + 'x'.repeat(padLen));
    let sockUnlinks = 0;
    let failChmod = true;
    let failSockUnlink = true;
    let netCreates = 0;
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: dir },
      {
        socketDigest: () => fixedDigest,
        fs: {
          ...fs,
          chmodSync(target, mode) {
            if (failChmod && String(target).endsWith('.sock')) {
              throw Object.assign(new Error('chmod denied'), { code: 'EPERM' });
            }
            return fs.chmodSync(target, mode);
          },
          unlinkSync(target) {
            if (String(target).endsWith('.sock')) {
              sockUnlinks += 1;
              if (failSockUnlink) {
                throw Object.assign(new Error('unlink denied'), { code: 'EACCES' });
              }
            }
            return fs.unlinkSync(target);
          },
        },
        net: {
          ...net,
          createServer(...args) {
            netCreates += 1;
            const srv = net.createServer(...args);
            const realClose = srv.close.bind(srv);
            t.after(() => { try { realClose(); } catch (_) {} });
            srv.close = () => {
              if (failChmod) throw new Error('server close stalled');
              return realClose();
            };
            return srv;
          },
        },
      },
    );
    t.after(() => mgr.close());

    await assert.rejects(() => mgr.track(cellA), /chmod denied/);
    assert.equal(mgr.readiness().unresolvedOpens, 1);
    const sp = resolveStablePath(dir, cellA, { digestFn: () => fixedDigest }).path;
    assert.equal(fs.existsSync(sp), true, 'failed-cleanup socket file remains on disk');
    const inoBefore = fs.statSync(sp).ino;
    const createsBeforeB = netCreates;
    const unlinksBeforeB = sockUnlinks;

    failChmod = false;
    failSockUnlink = false;
    await assert.rejects(() => mgr.track(cellB), /endpoint conflict/);
    assert.equal(netCreates, createsBeforeB, 'colliding B must not create server on protected residual endpoint');
    assert.equal(sockUnlinks, unlinksBeforeB, 'colliding B must not unlink protected residual endpoint');
    assert.equal(fs.statSync(sp).ino, inoBefore);
  }
});

test('residual cleanup failure blocks same cell on track and repeated boot without new binds, then recovers on attested close', async (t) => {
  const base = makeTempDir(t);
  const dir = path.join(base, 'r-res');
  const stateDir = path.join(base, 'state', 'cell-leases');
  fs.mkdirSync(stateDir, { recursive: true });
  const cellA = 'ResidualSameCellAlpha_0123456789';
  const fixedDigest = 'dd'.repeat(16);

  let failChmod = true;
  let failServerClose = true;
  let failSockUnlink = true;
  let netCreates = 0;
  let listenCalls = 0;
  let sockUnlinks = 0;
  const capturedServers = [];

  const mgr = createLeaseManager(
    { home: base, launchRuntimeDir: dir, leaseStateDir: stateDir },
    {
      socketDigest: () => fixedDigest,
      fs: {
        ...fs,
        chmodSync(p, mode) {
          if (failChmod && path.dirname(p) === dir) {
            const err = new Error('chmod denied');
            err.code = 'EPERM';
            throw err;
          }
          return fs.chmodSync(p, mode);
        },
        unlinkSync(p) {
          if (path.dirname(p) === dir) {
            sockUnlinks += 1;
            if (failSockUnlink) {
              const err = new Error('unlink blocked');
              err.code = 'EPERM';
              throw err;
            }
          }
          return fs.unlinkSync(p);
        },
      },
      net: {
        ...net,
        createServer(...args) {
          netCreates += 1;
          const srv = net.createServer(...args);
          const origListen = srv.listen.bind(srv);
          const origClose = srv.close.bind(srv);
          capturedServers.push({ srv, origClose });
          t.after(() => { try { origClose(); } catch (_) {} });
          srv.listen = (...lArgs) => {
            listenCalls += 1;
            return origListen(...lArgs);
          };
          srv.close = () => {
            if (failServerClose) throw new Error('close refused');
            return origClose();
          };
          return srv;
        },
      },
    },
  );
  t.after(() => { try { mgr.close(); } catch (_) {} });

  await assert.rejects(() => mgr.track(cellA), /chmod denied/);
  const sp = resolveStablePath(dir, cellA, { digestFn: () => fixedDigest }).path;
  assert.equal(fs.existsSync(sp), true);
  const inode = fs.statSync(sp).ino;
  assert.equal(mgr.readiness().unresolvedOpens, 1);
  assert.equal(mgr.readiness().historicalResiduals, 1);
  assert.equal(mgr._endpointOwners.size, 1);
  assert.equal(capturedServers.length, 1);

  const createsAfterFail = netCreates;
  const listensAfterFail = listenCalls;
  const unlinksAfterFail = sockUnlinks;

  // Same cell retries via track() must fail before any unlinkSync / createServer / listen.
  await assert.rejects(() => mgr.track(cellA), /residual|endpoint/);
  await assert.rejects(() => mgr.track(cellA), /residual|endpoint/);
  assert.equal(netCreates, createsAfterFail);
  assert.equal(listenCalls, listensAfterFail);
  assert.equal(sockUnlinks, unlinksAfterFail);
  assert.equal(fs.statSync(sp).ino, inode);
  assert.equal(mgr.readiness().unresolvedOpens, 1);
  assert.equal(mgr.readiness().historicalResiduals, 1);
  assert.equal(mgr._endpointOwners.size, 1);

  // Repeated boot() with persisted cell entry must also skip without allocating handles/records.
  fs.writeFileSync(path.join(stateDir, `${cellA}.json`), JSON.stringify({
    launchEpoch: 'ab'.repeat(8),
    graceDeadline: Date.now() + 60000,
  }));
  await mgr.boot();
  await mgr.boot();
  assert.equal(netCreates, createsAfterFail);
  assert.equal(listenCalls, listensAfterFail);
  assert.equal(sockUnlinks, unlinksAfterFail);
  assert.equal(fs.statSync(sp).ino, inode);
  assert.equal(mgr._cells.has(cellA), false);
  assert.equal(mgr.readiness().unresolvedOpens, 1);
  assert.equal(mgr.readiness().historicalResiduals, 1);
  assert.equal(mgr._endpointOwners.size, 1);

  // Attested server close + safe unlink clears current unresolved residual while preserving historical count.
  failChmod = false;
  failServerClose = false;
  failSockUnlink = false;
  await new Promise((resolve) => {
    capturedServers[0].srv.once('close', () => setImmediate(resolve));
    capturedServers[0].origClose();
  });
  assert.equal(mgr.readiness().unresolvedOpens, 0);
  assert.equal(mgr.readiness().historicalResiduals, 1);
  assert.equal(mgr._endpointOwners.size, 0);
  assert.equal(fs.existsSync(sp), false);

  const recovered = await mgr.track(cellA);
  assert.equal(recovered.stablePath, sp);
  assert.equal(mgr._cells.has(cellA), true);
  const closePre = mgr.close();
  assert.equal(closePre.closed, true);
  assert.equal(closePre.quiescent, false);
  assert.equal((await mgr.whenClosed()).quiescent, true);
});

test('close summary captures live and rollback cleanup failures, covers listen-to-publish gap, and blocks unattested Fleet close', async (t) => {
  const base = makeTempDir(t);

  // 1) Live endpoint server.close() failure and unlink failure are never swallowed by close()
  {
    const dir = path.join(base, 'l1');
    const cellCloseErr = 'LiveCloseErrCell_01';
    const cellUnlinkErr = 'LiveUnlinkErrCell_02';
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: dir, stateDir: path.join(base, 's1') },
      {
        fs: {
          ...fs,
          unlinkSync(p) {
            if (path.basename(p).includes('LiveUnlinkErrCell') || p.includes(sha32(cellUnlinkErr))) {
              const err = new Error('unlink denied');
              err.code = 'EPERM';
              throw err;
            }
            return fs.unlinkSync(p);
          },
        },
        net: {
          ...net,
          createServer(...args) {
            const srv = net.createServer(...args);
            const origClose = srv.close.bind(srv);
            t.after(() => { try { origClose(); } catch (_) {} });
            let isCloseTarget = false;
            const origListen = srv.listen.bind(srv);
            srv.listen = (sp, ...rest) => {
              if (String(sp).includes(sha32(cellCloseErr)) || String(sp).includes('LiveCloseErrCell')) {
                isCloseTarget = true;
              }
              return origListen(sp, ...rest);
            };
            srv.close = () => {
              if (isCloseTarget) throw new Error('live server close boom');
              return origClose();
            };
            return srv;
          },
        },
      },
    );
    t.after(() => { try { mgr.close(); } catch (_) {} });

    const closeErrTracked = await mgr.track(cellCloseErr);
    await mgr.track(cellUnlinkErr);
    const summary = mgr.close();
    assert.equal(summary.closed, true);
    assert.equal(summary.quiescent, false);
    assert.ok(summary.closeFailures >= 2);
    assert.equal(summary.unresolvedOpens, 2);
    assert.equal(summary.historicalResiduals, 2);
    assert.equal(fs.existsSync(closeErrTracked.stablePath), true);
  }

  // 2) Rollback on persisted recovery entry whose temporary reopen close throws records residual & close failure
  {
    const dir = path.join(base, 'l2');
    const stateDir = path.join(base, 's2');
    fs.mkdirSync(stateDir, { recursive: true });
    const cellRec = 'RecoveryRollbackCell_01';
    fs.writeFileSync(path.join(stateDir, `${cellRec}.json`), JSON.stringify({
      launchEpoch: 'cd'.repeat(8),
      graceDeadline: Date.now() + 60000,
    }));
    let failRename = true;
    let failRollbackClose = false;
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: dir, leaseStateDir: stateDir },
      {
        fs: {
          ...fs,
          renameSync(src, dst) {
            if (failRename && dst.endsWith(`${cellRec}.json`)) {
              const err = new Error('rename disk io');
              err.code = 'EIO';
              throw err;
            }
            return fs.renameSync(src, dst);
          },
        },
        net: {
          ...net,
          createServer(...args) {
            const srv = net.createServer(...args);
            const origClose = srv.close.bind(srv);
            t.after(() => { try { origClose(); } catch (_) {} });
            srv.close = () => {
              if (failRollbackClose) throw new Error('rollback close failed');
              return origClose();
            };
            return srv;
          },
        },
      },
    );
    t.after(() => { try { mgr.close(); } catch (_) {} });

    mgr.loadPersisted();
    assert.equal(mgr._cells.has(cellRec), true);
    failRollbackClose = true;
    await assert.rejects(() => mgr.track(cellRec), /persist outcome uncertain|not persisted/);
    assert.equal(mgr.readiness().unresolvedOpens, 1);
    const closeSum = mgr.close();
    assert.equal(closeSum.quiescent, false);
    assert.ok(closeSum.closeFailures >= 1);
    assert.equal(closeSum.unresolvedOpens, 1);
  }

  // 3) Listen-to-publish barrier: close() triggered after listen cb resolves but before stableServer publish
  {
    const dir = path.join(base, 'l3');
    const cellGap = 'ListenPublishGapCell';
    let closeSummary = null;
    const mgr = createLeaseManager(
      { home: base, launchRuntimeDir: dir, leaseStateDir: path.join(base, 's3') },
      {
        fs: {
          ...fs,
          chmodSync(p, mode) {
            fs.chmodSync(p, mode);
            if (path.dirname(p) === dir) {
              // Schedule close() before openPromise continuation runs on microtask queue.
              Promise.resolve().then(() => { closeSummary = mgr.close(); });
            }
          },
        },
      },
    );
    t.after(() => { try { mgr.close(); } catch (_) {} });

    await assert.rejects(() => mgr.track(cellGap), /aborted by close/);
    assert.ok(closeSummary, 'close ran before stableServer publish');
    assert.equal(closeSummary.closed, true);
    assert.equal(closeSummary.pendingOpens, 1);
    assert.equal(closeSummary.quiescent, false);
    assert.equal(mgr._cells.size, 0);
    assert.equal((await mgr.whenClosed()).quiescent, true);
    assert.equal(mgr.readiness().pendingOpens, 0);
  }

  // 4) Unattested or non-quiescent lease summary from close() drives LEASE_CLOSE_ERROR and blocks cleanup
  {
    for (const badSummary of [
      undefined,
      null,
      { closed: false, quiescent: true, pendingOpens: 0, unresolvedOpens: 0, closeFailures: 0 },
      { closed: true, quiescent: false, pendingOpens: 0, unresolvedOpens: 1, closeFailures: 0 },
      { closed: true, quiescent: true, pendingOpens: 1, unresolvedOpens: 0, closeFailures: 0 },
      { closed: true, quiescent: true, pendingOpens: 0, unresolvedOpens: 0, closeFailures: 1 },
    ]) {
      const fb = makeTempDir(t, 'nc-bad-sum-');
      const defsPath = path.join(fb, 'fleet.json');
      atomicWrite(defsPath, { schemaVersion: 1, engines: [], cells: [] });
      const fakeTmux = path.join(fb, 'fake-tmux');
      fs.writeFileSync(fakeTmux, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const fleet = await createBuiltinFleet({
        home: fb,
        filesRoot: path.join(fb, 'files'),
        fleetDefsPath: defsPath,
        tmuxBin: fakeTmux,
        protectSharedTmuxServer: false,
        ensureTmuxProtection: () => {},
        leaseManager: {
          boot: async () => {},
          close: () => badSummary,
        },
        log: () => {},
      });
      const out = await fleet.close({ budgetMs: 0 });
      assert.equal(out.leaseClosed, false);
      assert.equal(out.quiescent, false);
      assert.equal(out.canCleanupOwnedResources, false);
      assert.ok(out.codes.includes('LEASE_CLOSE_ERROR'));
    }
  }
});

test('close settles pending track, queued turns, and joining boot logically without listen or error, ignoring late callbacks', async (t) => {
  const base = makeTempDir(t);
  const dir = path.join(base, 'k');
  const stateDir = path.join(base, 'state', 'cell-leases');
  fs.mkdirSync(stateDir, { recursive: true });
  const cellA = 'CloseLogicalCancelCell_01';
  const fixedDigest = 'ee'.repeat(16);

  fs.writeFileSync(path.join(stateDir, `${cellA}.json`), JSON.stringify({
    launchEpoch: 'ef'.repeat(8),
    graceDeadline: Date.now() + 60000,
  }));

  const barrier = createListenBarrierNet();
  let postCloseChmodCount = 0;
  let postCloseUnlinkCount = 0;
  let closedFlag = false;

  const mgr = createLeaseManager(
    { home: base, launchRuntimeDir: dir, leaseStateDir: stateDir },
    {
      socketDigest: () => fixedDigest,
      fs: {
        ...fs,
        chmodSync(p, mode) {
          if (closedFlag && path.dirname(p) === dir) postCloseChmodCount += 1;
          return fs.chmodSync(p, mode);
        },
        unlinkSync(p) {
          if (closedFlag && path.dirname(p) === dir) postCloseUnlinkCount += 1;
          return fs.unlinkSync(p);
        },
      },
      net: barrier.netImpl,
    },
  );
  t.after(() => { try { mgr.close(); } catch (_) {} });

  const track1P = mgr.track(cellA);
  const gate = await barrier.nextGate(0);
  const track2P = mgr.track(cellA);
  const bootP = mgr.boot();

  closedFlag = true;
  const closeSummary = mgr.close();
  assert.equal(closeSummary.closed, true);
  assert.equal(closeSummary.quiescent, false);
  assert.equal(closeSummary.pendingOpens, 1);
  assert.equal(closeSummary.unresolvedOpens, 1);

  // Neither listen callback nor error event has fired; all pending callers must still settle immediately.
  const settled = await Promise.race([
    Promise.allSettled([track1P, track2P, bootP]),
    new Promise((_, rej) => setTimeout(() => rej(new Error('logical close timed out waiting for bind')), 300)),
  ]);
  for (const r of settled) {
    assert.equal(r.status, 'rejected');
    assert.match(String(r.reason && r.reason.message), /manager is closed/);
  }
  assert.equal(mgr._cells.size, 0);
  assert.equal(mgr.readiness().pendingOpens, 1);
  assert.equal(mgr.readiness().unresolvedOpens, 1);

  // Late callback arrives with zero chmod/unlink/publish side effects and clears pending-at-close physical record.
  gate.releaseCallbackOnly();
  await new Promise((r) => setImmediate(r));
  assert.equal(postCloseChmodCount, 0);
  assert.equal(postCloseUnlinkCount, 0);
  assert.equal(mgr._cells.size, 0);
  assert.equal(mgr.readiness().pendingOpens, 0);
  assert.equal(mgr.readiness().unresolvedOpens, 0);
  assert.equal(mgr.readiness().historicalResiduals, 1);
});
