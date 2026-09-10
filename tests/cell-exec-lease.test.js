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
const { spawn: realSpawn } = require('node:child_process');
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


// ---- FIX5: R1a exit perso durante l'ACK + R1b ACK ignorato ----
// Harness e2e con pipe fake duplex (isolamento della logica di lifecycle e
// fail-closed dal difetto di direzione fd4 con figli reali — vedi referto
// R1c). Lease server/client e authority sono REALI; l'ACK di generazione
// viene ritardato/soppresso lato server con wrapper sulla write.

test('main: child exit during the generation handshake is collected and never hangs (R1a)', async (t) => {
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
  const lease = await manager.track('Dev');
  subject = { ownerInstanceId: 'owner-a', cellId: 'Dev', incarnationId: 'incarnation-a', launchEpoch: lease.launchEpoch };
  manager.setLaunchSubject('Dev', subject);
  const pairPath = path.join(home, 'pair.sock');
  const pairServer = net.createServer();
  const connected = new Promise((resolve) => pairServer.once('connection', resolve));
  await new Promise((resolve) => pairServer.listen(pairPath, resolve));
  const pairClient = net.createConnection(pairPath);
  const [pairServerSide] = await Promise.all([connected, new Promise((resolve) => pairClient.once('connect', resolve))]);
  // Seam di test: l'ACK di generazione arriva IN RITARDO (250ms): il figlio
  // della generazione 1 esce prima, mentre l'annuncio e' in attesa.
  const sow = pairServerSide.write.bind(pairServerSide);
  pairServerSide.write = (data, ...rest) => {
    const frame = String(data);
    if (frame.includes('"generationAck"')) {
      setTimeout(() => sow(data, ...rest), 250);
      return true;
    }
    return sow(data, ...rest);
  };
  t.after(() => {
    try { manager.close(); } catch (_) {}
    try { pairClient.destroy(); } catch (_) {}
    try { pairServer.close(); } catch (_) {}
    for (const child of generations) { try { child.kill(); } catch (_) {} }
  });
  assert.equal(manager.attachInitial('Dev', pairServerSide, { generation: 0 }), true);

  const generations = [];
  const payload = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: { HOME: '/tmp', PATH: process.env.PATH || '' },
    lease: { cellId: 'Dev', launchEpoch: lease.launchEpoch, stablePath: lease.stablePath },
    supervise: {
      enabled: true, initialReadyMs: 0, restartDelayMs: 0,
      maxRestartDelayMs: 0, resetAfterMs: 60_000, rapidWindowMs: 60_000, maxRapidRestarts: 8,
    },
  };
  const seams = {
    receivePayload: async () => ({ payload, socket: pairClient }),
    spawn: () => {
      // Figlio finto duplex: l'exit scatta SUBITO allo spawn (durante
      // l'attesa dell'ACK ritardato), prima che waitChild agganci i listener.
      const request = new PassThrough();
      const response = new PassThrough();
      const child = new EventEmitter();
      child.stdio = [null, null, null, request, response];
      child.kill = () => {};
      child.pid = 50000 + generations.length;
      child.exit = () => child.emit('exit', 0, null);
      setImmediate(() => child.exit());
      generations.push(child);
      return child;
    },
    sleep: () => Promise.resolve(),
  };
  const mainPromise = main(['--socket', '/tmp/x', '--nonce', '0'.repeat(64)], seams);
  const outcome = await Promise.race([
    mainPromise.then((code) => ({ settled: true, code })),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 5000)),
  ]);
  assert.equal(outcome.settled, true, 'il supervisore raccoglie exit durante la finestra di ACK e non resta appeso');
});

test('main: a lost generation ack leaves the new channel unusable with a visible diagnostic (R1b)', async (t) => {
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
  const lease = await manager.track('Dev');
  subject = { ownerInstanceId: 'owner-a', cellId: 'Dev', incarnationId: 'incarnation-a', launchEpoch: lease.launchEpoch };
  manager.setLaunchSubject('Dev', subject);
  const pairPath = path.join(home, 'pair.sock');
  const pairServer = net.createServer();
  const connected = new Promise((resolve) => pairServer.once('connection', resolve));
  await new Promise((resolve) => pairServer.listen(pairPath, resolve));
  const pairClient = net.createConnection(pairPath);
  const [pairServerSide] = await Promise.all([connected, new Promise((resolve) => pairClient.once('connect', resolve))]);
  // Seam di test: l'ACK di generazione viene SOPPRESSO (il server avanza ma
  // la risposta si perde sul filo).
  const sow = pairServerSide.write.bind(pairServerSide);
  pairServerSide.write = (data, ...rest) => {
    if (String(data).includes('"generationAck"')) return true;
    return sow(data, ...rest);
  };
  t.after(() => {
    try { manager.close(); } catch (_) {}
    try { pairClient.destroy(); } catch (_) {}
    try { pairServer.close(); } catch (_) {}
    for (const child of generations) { try { child.kill(); } catch (_) {} }
  });
  assert.equal(manager.attachInitial('Dev', pairServerSide, { generation: 0 }), true);

  const generations = [];
  const stderrCaptured = [];
  let lastChannel = null;
  const payload = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: { HOME: '/tmp', PATH: process.env.PATH || '' },
    lease: { cellId: 'Dev', launchEpoch: lease.launchEpoch, stablePath: lease.stablePath },
    supervise: {
      enabled: true, initialReadyMs: 0, restartDelayMs: 0,
      maxRestartDelayMs: 0, resetAfterMs: 60_000, rapidWindowMs: 60_000, maxRapidRestarts: 8,
    },
  };
  const seams = {
    receivePayload: async () => ({ payload, socket: pairClient }),
    spawn: () => {
      // Figlio finto duplex con pipe che RISPONDONO: se il canale viene
      // aperto, una richiesta su fd3 riceve risposta (ecco il rosso).
      const request = new PassThrough();
      const response = new PassThrough();
      response.on('data', () => { lastChannel.used = true; });
      const child = new EventEmitter();
      child.stdio = [null, null, null, request, response];
      child.kill = () => {};
      child.pid = 50000 + generations.length;
      child.exit = () => child.emit('exit', 0, null);
      // fix 6: l'exit NON e' immediato — deve vincere l'announce (timeout
      // 200ms via seam) cosi' la diagnostica osservata e' quella specifica
      // dell'annuncio, non l'uscita durante l'handshake.
      setTimeout(() => child.exit(), 600);
      lastChannel = { request, response, used: false, opened: false };
      // Rafforzamento fix 6: scrivi UNA richiesta su fd3. Se il canale fosse
      // stato aperto (regressione), il supervisore risponderebbe su fd4.
      request.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'identity.get', params: {} }) + '\n');
      generations.push(child);
      return child;
    },
    sleep: () => Promise.resolve(),
    // R1b: timer accorciato (4000 -> 200ms): il timeout dell'annuncio scatta
    // mentre il figlio e' ancora vivo.
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 200)),
    clearTimeout: (t) => clearTimeout(t),
    writeError: (message) => { stderrCaptured.push(String(message)); },
  };
  // Osservazione dell'apertura del canale: la createIdentityChannel non e'
  // direttamente spiabile qui, quindi la prova e' funzionale — richiesta su
  // fd3 con risposta = canale utilizzabile.
  const mainPromise = main(['--socket', '/tmp/x', '--nonce', '0'.repeat(64)], seams);

  // gen0: l'unico canale legittimo e' quello di generazione 0; per isolare
  // R1b si verifica l'esito FUNZIONALE della generazione con ACK perso.
  await Promise.race([mainPromise, new Promise((r) => setTimeout(r, 4000))]);
  // Il canale della generazione con ACK perso non deve risultare utilizzabile:
  // con la lib attuale il canale si apre e risponde (rosso). Dopo la fix il
  // canale non viene aperto: nessuna risposta generata dal supervisore.
  // L'assert funzionale e' sulla diagnostica + assenza di utilizzo.
  // fix 6: la diagnostica deve essere quella SPECIFICA dell'annuncio
  // ("senza identita' (announce-failed)"), non bastare l'exit durante
  // handshake ("figlio uscito durante l'handshake di generazione").
  assert.equal(stderrCaptured.some((line) => /senza identita' \(announce-failed\)/.test(line)), true,
    'diagnostica specifica dell\'annuncio fallito (ricevuto: ' + stderrCaptured.join(' | ') + ')');
  assert.equal(lastChannel === null || (lastChannel.used === false && lastChannel.opened === false), true,
    'nessun canale utilizzabile per la generazione con ACK perso (nessuna risposta alla richiesta fd3)');
  await Promise.race([mainPromise, new Promise((r) => setTimeout(r, 12_000))]);
});

// ---- R1c chiarito: figlio REALE che legge il proof da fd4 come stream ----
// Le pipe extra di spawn sono socketpair duplex (R1c NON confermato: il mio
// repro precedente usava fs.readFileSync su socket, che blocca fino a EOF).
const FD4_CHILD_SCRIPT = `
const fs = require('node:fs');
const net = require('node:net');
const nonce = require('node:crypto').randomBytes(32).toString('hex');
const now = Date.now();
const NL = String.fromCharCode(10);
const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nexuscrew/identity/challengeProof', params: { challenge: { version: 1, audience: 'daemon/connection-a', daemonBootId: 'boot-a', connectionId: 'connection-a', nonce, issuedAt: now, expiresAt: now + 15000 } } }) + NL;
fs.writeSync(3, rpc);
const s = new net.Socket({ fd: 4, readable: true, writable: false });
s.on('data', (d) => { process.stdout.write('GENREPLY:' + String(d).trim() + NL); process.exit(0); });
s.on('error', () => { process.stdout.write('GENREPLY:ERR' + NL); process.exit(3); });
setTimeout(() => { process.stdout.write('GENREPLY:TIMEOUT' + NL); process.exit(4); }, 2500).unref();
setTimeout(() => { process.exit(4); }, 3000);
`;

test('main: a real child receives the current-generation proof on fd4, and nothing without ack (R1c)', async (t) => {
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
  const lease = await manager.track('Dev');
  subject = { ownerInstanceId: 'owner-a', cellId: 'Dev', incarnationId: 'incarnation-a', launchEpoch: lease.launchEpoch };
  manager.setLaunchSubject('Dev', subject);
  const pairPath = path.join(home, 'pair.sock');
  const pairServer = net.createServer();
  const connected = new Promise((resolve) => pairServer.once('connection', resolve));
  await new Promise((resolve) => pairServer.listen(pairPath, resolve));
  const pairClient = net.createConnection(pairPath);
  const [pairServerSide] = await Promise.all([connected, new Promise((resolve) => pairClient.once('connect', resolve))]);
  // dropAck attivo DALL'INIZIO: l'announce esiste solo per generazione >= 1,
  // quindi gen0 non e' toccata; il primo announce (gen1) e' già senza ACK.
  let dropAck = true;
  const sow = pairServerSide.write.bind(pairServerSide);
  pairServerSide.write = (data, ...rest) => {
    if (dropAck && String(data).includes('"generationAck"')) return true;
    return sow(data, ...rest);
  };
  t.after(() => {
    try { manager.close(); } catch (_) {}
    try { pairClient.destroy(); } catch (_) {}
    try { pairServer.close(); } catch (_) {}
    for (const child of generations) { try { child.kill('SIGKILL'); } catch (_) {} }
  });
  assert.equal(manager.attachInitial('Dev', pairServerSide, { generation: 0 }), true);

  const generations = [];
  const stderrCaptured = [];
  const stdoutByGen = [];
  const payload = {
    command: process.execPath,
    args: ['-e', FD4_CHILD_SCRIPT],
    env: { HOME: '/tmp', PATH: process.env.PATH || '' },
    lease: { cellId: 'Dev', launchEpoch: lease.launchEpoch, stablePath: lease.stablePath },
    supervise: {
      enabled: true, initialReadyMs: 0, restartDelayMs: 0,
      maxRestartDelayMs: 0, resetAfterMs: 60_000, rapidWindowMs: 600_000, maxRapidRestarts: 8,
    },
  };
  const seams = {
    receivePayload: async () => ({ payload, socket: pairClient }),
    spawn: (cmd, args, opts) => {
      // stdout pipe: il figlio consegna la GENREPLY al test (fd1 catturato).
      const child = realSpawn(cmd, args, { ...opts, stdio: ['inherit', 'pipe', 'inherit', 'pipe', 'pipe'] });
      const gen = generations.length;
      let out = '';
      child.stdout.on('data', (chunk) => { out += String(chunk); });
      child.on('exit', (code) => { out += 'EXIT:' + code; stdoutByGen[gen] = out; });
      generations.push(child);
      return child;
    },
    sleep: () => Promise.resolve(),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 200)),
    clearTimeout: (t) => clearTimeout(t),
    writeError: (message) => { stderrCaptured.push(String(message)); },
  };
  const mainPromise = main(['--socket', '/tmp/x', '--nonce', '0'.repeat(64)], seams);

  // FASE POSITIVA (gen0): il figlio REALE riceve il proof su fd4 (stream).
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const poll = () => {
      if (stdoutByGen[0] && stdoutByGen[0].includes('GENREPLY:')) return resolve();
      if (Date.now() > deadline) return reject(new Error('gen0: nessuna GENREPLY (stdout: ' + (stdoutByGen[0] || '') + ')'));
      setTimeout(poll, 25);
    };
    poll();
  });
  assert.equal(stdoutByGen[0].includes('"cellId":"Dev"'), true, 'gen0: proof arrivato al figlio reale');
  assert.equal(stdoutByGen[0].includes('"incarnationId":"incarnation-a"'), true, 'gen0: proof della generazione corrente (incarnation del subject)');

  // FASE NEGATIVA (R1b seam): senza ACK nessun canale -> il figlio non riceve nulla.
  // (dropAck e' attivo dall'inizio: vedi nota sul wrapper.)
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const poll = () => {
      if (stdoutByGen[1] && stdoutByGen[1].includes('GENREPLY:')) return resolve();
      if (Date.now() > deadline) return reject(new Error('gen1: nessuna uscita del figlio (stdout: ' + (stdoutByGen[1] || '') + ')'));
      setTimeout(poll, 25);
    };
    poll();
  });
  assert.equal(/GENREPLY:.+"cellId"/.test(stdoutByGen[1] || ''), false,
    'gen1 senza ACK: nessun proof al figlio (stdout: ' + (stdoutByGen[1] || '') + ')');
  assert.equal(stderrCaptured.some((line) => /senza identita|generazione/i.test(line)), true,
    'diagnostica del supervisore visibile');
  await Promise.race([mainPromise, new Promise((r) => setTimeout(r, 8000))]);
});

// R1b fix 6: announceGeneration PUO' risolvere (non rigettare) {ok:false}
// (lease-down, identity-unverified). Il gate del supervisore deve ispezionare
// il valore risolto: nessun canale su ok:false, con diagnostica specifica.
// Figlio REALE come nel test R1c (fd3/fd4 pipe, nessun EventEmitter).
test('main: announce resolved {ok:false} (lease-down, identity-unverified) keeps the channel closed (R1b gate)', async (t) => {
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
  const lease = await manager.track('Dev');
  subject = { ownerInstanceId: 'owner-a', cellId: 'Dev', incarnationId: 'incarnation-a', launchEpoch: lease.launchEpoch };
  manager.setLaunchSubject('Dev', subject);
  const pairPath = path.join(home, 'pair.sock');
  const pairServer = net.createServer();
  const connected = new Promise((resolve) => pairServer.once('connection', resolve));
  await new Promise((resolve) => pairServer.listen(pairPath, resolve));
  const pairClient = net.createConnection(pairPath);
  const [pairServerSide] = await Promise.all([connected, new Promise((resolve) => pairClient.once('connect', resolve))]);
  // Wrapper sul VERO lease-client: dalla generazione 1 l'annuncio si RISOLVE
  // negativo (prima lease-down, poi identity-unverified). Gen0 resta reale.
  const leaseClientModule = require('../lib/fleet/lease-client.js');
  const realStart = leaseClientModule.startLeaseClient;
  let forceResolved = null;
  leaseClientModule.startLeaseClient = (socket, info) => {
    const ctl = realStart(socket, info);
    const realAnnounce = ctl.announceGeneration.bind(ctl);
    ctl.announceGeneration = (generation) => {
      if (forceResolved) return Promise.resolve({ ...forceResolved, generation });
      return realAnnounce(generation);
    };
    return ctl;
  };
  t.after(() => {
    leaseClientModule.startLeaseClient = realStart;
    try { manager.close(); } catch (_) {}
    try { pairClient.destroy(); } catch (_) {}
    try { pairServer.close(); } catch (_) {}
    for (const child of generations) { try { child.kill('SIGKILL'); } catch (_) {} }
  });
  assert.equal(manager.attachInitial('Dev', pairServerSide, { generation: 0 }), true);

  const generations = [];
  const stderrCaptured = [];
  const stdoutByGen = [];
  const payload = {
    command: process.execPath,
    args: ['-e', FD4_CHILD_SCRIPT],
    env: { HOME: '/tmp', PATH: process.env.PATH || '' },
    lease: { cellId: 'Dev', launchEpoch: lease.launchEpoch, stablePath: lease.stablePath },
    supervise: {
      enabled: true, initialReadyMs: 0, restartDelayMs: 0,
      maxRestartDelayMs: 0, resetAfterMs: 60_000, rapidWindowMs: 600_000, maxRapidRestarts: 8,
    },
  };
  const seams = {
    receivePayload: async () => ({ payload, socket: pairClient }),
    spawn: (cmd, args, opts) => {
      const child = realSpawn(cmd, args, { ...opts, stdio: ['inherit', 'pipe', 'inherit', 'pipe', 'pipe'] });
      const gen = generations.length;
      let out = '';
      child.stdout.on('data', (chunk) => { out += String(chunk); });
      child.on('exit', (code) => { out += 'EXIT:' + code; stdoutByGen[gen] = out; });
      generations.push(child);
      return child;
    },
    sleep: () => Promise.resolve(),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 200)),
    clearTimeout: (t) => clearTimeout(t),
    writeError: (message) => { stderrCaptured.push(String(message)); },
  };
  // Il force si attiva DALL'INIZIO: announceGeneration viene chiamata solo per
  // generation >= 1, quindi gen0 (nessun annuncio) resta reale e il forcing e'
  // deterministico — nessuna corsa col restart del supervisore.
  forceResolved = { ok: false, reason: 'lease-down' };
  const mainPromise = main(['--socket', '/tmp/x', '--nonce', '0'.repeat(64)], seams);

  const waitGen = (gen, extra) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const poll = () => {
      if (stdoutByGen[gen] && stdoutByGen[gen].includes('EXIT:')) return resolve();
      if (Date.now() > deadline) return reject(new Error('gen' + gen + ': nessuna uscita del figlio (stdout: ' + (stdoutByGen[gen] || '') + ')'));
      setTimeout(poll, 25);
    };
    poll();
  });

  // FASE POSITIVA (gen0): il canale legit di generazione 0 consegna il proof.
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const poll = () => {
      if (stdoutByGen[0] && stdoutByGen[0].includes('GENREPLY:')) return resolve();
      if (Date.now() > deadline) return reject(new Error('gen0: nessuna GENREPLY (stdout: ' + (stdoutByGen[0] || '') + ')'));
      setTimeout(poll, 25);
    };
    poll();
  });
  assert.equal(stdoutByGen[0].includes('"cellId":"Dev"'), true, 'gen0: proof arrivato al figlio reale');

  // FASE NEGATIVA 1 (gen1): annuncio RISOLTO {ok:false, reason:'lease-down'}.
  await waitGen(1);
  assert.equal(/GENREPLY:.+"cellId"/.test(stdoutByGen[1] || ''), false,
    'gen1 con annuncio ok:false (lease-down): nessun proof al figlio (stdout: ' + (stdoutByGen[1] || '') + ')');
  assert.equal(stderrCaptured.some((line) => /senza identita'.*announce-refused:lease-down/.test(line)), true,
    'diagnostica specifica per il risolto negativo lease-down (ricevuto: ' + stderrCaptured.join(' | ') + ')');

  // FASE NEGATIVA 2 (gen2): annuncio RISOLTO {ok:false, identity-unverified}.
  forceResolved = { ok: false, reason: 'identity-unverified' };
  await waitGen(2);
  assert.equal(/GENREPLY:.+"cellId"/.test(stdoutByGen[2] || ''), false,
    'gen2 con annuncio ok:false (identity-unverified): nessun proof al figlio (stdout: ' + (stdoutByGen[2] || '') + ')');
  assert.equal(stderrCaptured.some((line) => /senza identita'.*announce-refused:identity-unverified/.test(line)), true,
    'diagnostica specifica per il risolto negativo identity-unverified (ricevuto: ' + stderrCaptured.join(' | ') + ')');

  await Promise.race([mainPromise, new Promise((r) => setTimeout(r, 8000))]);
});
