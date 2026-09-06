'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { main, validPayload, validLease } = require('../lib/fleet/cell-exec.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { createIdentityAuthority } = require('../lib/fleet/identity-authority.js');

function mockSocket() {
  const e = new EventEmitter();
  e.setEncoding = () => {};
  e.write = () => true;
  e.destroy = () => { e.destroyed = true; };
  e.writable = true;
  e.destroyed = false;
  return e;
}

// 2b (A2): la capability statica non esiste piu' nel payload. Il lease porta
// solo i dati di routing; il proof arriva sul canale, non nel payload.
test('validLease: accetta lease ben formato (senza capability), rifiuta il resto (fail-closed)', () => {
  assert.equal(validLease(undefined), true);
  assert.equal(validLease({ cellId: 'Dev', launchEpoch: 'ep', stablePath: '/tmp/x.sock' }), true);
  assert.equal(validLease({ launchEpoch: 'ep', stablePath: '/tmp/x.sock' }), true);
  // capability: revocata — la sua presenza e' un payload non valido
  assert.equal(validLease({ launchEpoch: 'ep', capability: 'ab'.repeat(32), stablePath: '/tmp/x.sock' }), false, 'capability revocata (A2): rifiutata');
  assert.equal(validLease({ launchEpoch: 'ep', stablePath: '/tmp/x.sock', extra: 1 }), false, 'chiavi non ammesse');
  assert.equal(validLease({ launchEpoch: '', stablePath: '/tmp/x.sock' }), false);
  assert.equal(validLease(null), false);
});

test('validPayload: accetta payload con lease opzionale', () => {
  const base = { command: '/bin/true', args: [], env: { A: 'b' } };
  assert.equal(validPayload({ ...base }), true);
  assert.equal(validPayload({ ...base, lease: { launchEpoch: 'ep', stablePath: '/tmp/x.sock' } }), true);
  assert.equal(validPayload({ ...base, lease: { launchEpoch: 'ep' } }), false, 'lease parziale rifiutato');
});

test('main: nessun dato di lease compare nell\'env passato allo spawn del child (R3.1.2)', async () => {
  const launchEpoch = 'cd'.repeat(8);
  const stablePath = '/tmp/cell-Dev-lease-test.sock';
  const payload = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: { HOME: '/tmp', PATH: process.env.PATH || '' },
    lease: { cellId: 'Dev', launchEpoch, stablePath },
  };
  const sock = mockSocket();
  const captured = {};
  let spawned = 0;
  const seams = {
    receivePayload: async () => ({ payload, socket: sock }),
    spawn: (cmd, args, opts) => {
      spawned += 1;
      captured.env = opts && opts.env ? { ...opts.env } : {};
      captured.stdio = opts && opts.stdio;
      const child = new EventEmitter();
      child.kill = () => {};
      child.pid = 12345;
      setTimeout(() => child.emit('exit', 0, null), 5);
      return child;
    },
    sleep: () => Promise.resolve(),
    now: () => 1000,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  const code = await main(['--socket', '/tmp/x', '--nonce', '0'.repeat(64)], seams);
  assert.equal(spawned, 1, 'child spawnato una volta');
  // R3.1.2: nessun segreto/dato di lease nell'env del child. In 2b il proof non
  // transita nemmeno nel payload: vive solo nel lease-client del supervisore.
  assert.equal(Object.values(captured.env).some((v) => String(v).includes(launchEpoch)), false, 'launchEpoch assente dai valori env');
  assert.equal(Object.values(captured.env).some((v) => String(v).includes(stablePath)), false, 'stablePath assente dai valori env');
  assert.equal(Object.keys(captured.env).some((k) => /lease|capability|proof|launchepoch|stablepath/i.test(k)), false, 'nessuna chiave di lease nell\'env');
  // 2b (piano CANALE_B, vincolante): stdio inherit per std/err + due pipe
  // fd 3/4 per il canale identita; env comunque senza dati di lease (R3.1.2
  // invariato). Nessun bearer/capability transitira' mai su queste pipe.
  assert.deepEqual(captured.stdio, ['inherit', 'inherit', 'inherit', 'pipe', 'pipe']);
  assert.equal(typeof code, 'number');
});


// R1 (fix4): due generazioni reali sullo STESSO lease — main() vero, lease
// server/client e authority veri, pipe fd 3/4 vere. Il canale della generazione
// nuova si apre solo DOPO l'annuncio di generazione sul lease (handshake), e la
// pendenza della generazione precedente e' invalidata con EOF su fd4.
test('main: two supervised generations keep the identity channel working on the same lease (R1)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cell-exec-gen-'));
  let subject = null;
  const authority = createIdentityAuthority({
    dir: path.join(home, 'authority'),
    daemonCredential: 'daemon-credential',
    launcherCredential: 'launcher-credential',
    subjectResolver: (candidate) => !!subject
      && Object.entries(subject).every(([key, value]) => candidate[key] === value),
  });
  const manager = createLeaseManager({ home, log: () => {}, identityAuthority: authority });
  const launchEpochLease = await manager.track('Dev');
  subject = {
    ownerInstanceId: 'owner-a',
    cellId: 'Dev',
    incarnationId: 'incarnation-a',
    launchEpoch: launchEpochLease.launchEpoch,
  };
  assert.equal(manager.setLaunchSubject('Dev', subject), true);
  const pairPath = path.join(home, 'pair.sock');
  const pairServer = net.createServer();
  const connected = new Promise((resolve) => pairServer.once('connection', resolve));
  await new Promise((resolve) => pairServer.listen(pairPath, resolve));
  const pairClient = net.createConnection(pairPath);
  const [pairServerSide] = await Promise.all([
    connected,
    new Promise((resolve) => pairClient.once('connect', resolve)),
  ]);
  // Frame wire log lato client: prova diretta dell'annuncio di generazione.
  const wireFrames = [];
  const originalWrite = pairClient.write.bind(pairClient);
  pairClient.write = (data, ...rest) => {
    wireFrames.push(String(data));
    return originalWrite(data, ...rest);
  };
  assert.equal(manager.attachInitial('Dev', pairServerSide, { generation: 0 }), true);

  const challengeFor = (nonce) => ({
    version: 1,
    audience: 'daemon/connection-a',
    daemonBootId: 'boot-a',
    connectionId: 'connection-a',
    nonce,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 15_000,
  });
  const rpcFor = (id, nonce) => `${JSON.stringify({
    jsonrpc: '2.0', id, method: 'nexuscrew/identity/challengeProof', params: { challenge: challengeFor(nonce) },
  })}\n`;

  const generations = []; // {request, response, exit()}
  const payload = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: { HOME: '/tmp', PATH: process.env.PATH || '' },
    lease: { cellId: 'Dev', launchEpoch: launchEpochLease.launchEpoch, stablePath: launchEpochLease.stablePath },
    supervise: {
      enabled: true, initialReadyMs: 0, restartDelayMs: 0,
      maxRestartDelayMs: 0, resetAfterMs: 60_000, rapidWindowMs: 60_000, maxRapidRestarts: 8,
    },
  };
  const seams = {
    receivePayload: async () => ({ payload, socket: pairClient }),
    spawn: (cmd, args, opts) => {
      const generation = generations.length;
      const request = new PassThrough();
      const response = new PassThrough();
      const child = new EventEmitter();
      child.stdio = [null, null, null, request, response];
      child.kill = () => {};
      child.pid = 40000 + generation;
      generations.push({ request, response, exit: () => child.emit('exit', 0, null) });
      if (generation >= 2) {
        // L'exit parte SOLO quando waitChild ha il listener: l'announce (R1)
        // cede il tick fra spawn e attach, un setImmediate andrebbe nel vuoto.
        const t = setInterval(() => {
          if (child.listenerCount('exit') > 0) {
            clearInterval(t);
            child.emit('exit', 0, null);
          }
        }, 5);
        if (typeof t.unref === 'function') t.unref();
      }
      return child;
    },
    sleep: () => Promise.resolve(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
  };
  const mainPromise = main(['--socket', '/tmp/x', '--nonce', '0'.repeat(64)], seams);

  // attesa pipe generazione 0
  const waitFor = async (fn, ms = 5000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() > deadline) throw new Error('timeout in attesa generazione');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const gen0 = await waitFor(() => generations[0]);
  const readLine = (stream) => new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      stream.off('data', onData);
      resolve(JSON.parse(buf.slice(0, nl)));
    };
    stream.on('data', onData);
    stream.once('end', () => reject(Object.assign(new Error('eof'), { code: 'eof' })));
  });
  const eofWhen = (stream) => new Promise((resolve) => {
    // Un PassThrough in pausa non emette 'end' finche' nessuno lo consuma:
    // resume() porta il flusso, l'EOF arriva davvero come per la TUI.
    stream.resume();
    stream.once('end', resolve);
  });

  gen0.request.write(rpcFor(1, 'a'.repeat(64)));
  const gen0Reply = await readLine(gen0.response);
  assert.equal(gen0Reply.result.proof.cellId, 'Dev', 'gen0: relay ok con subject del record');

  const gen0Eof = eofWhen(gen0.response);
  generations[0].exit();
  await gen0Eof;
  assert.equal(wireFrames.some((frame) => frame.includes('"type":"generation"')), true,
    'annuncio di generazione osservato sul filo del lease');

  const gen1 = await waitFor(() => generations[1]);
  assert.notEqual(gen1.request, gen0.request, 'pipe nuove nella generazione 1');
  gen1.request.write(rpcFor(2, 'b'.repeat(64)));
  const gen1Reply = await readLine(gen1.response);
  assert.equal(gen1Reply.result.proof.cellId, 'Dev', 'gen1: relay ok dopo handshake di generazione');
  assert.equal(gen1Reply.result.proof.incarnationId, 'incarnation-a');

  generations[1].exit();
  await mainPromise;
  manager.close();
  try { pairClient.destroy(); } catch (_) {}
  try { pairServer.close(); } catch (_) {}
  fs.rmSync(home, { recursive: true, force: true });
});
