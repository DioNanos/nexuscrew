'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const { receivePayload, validPayload, main } = require('../lib/fleet/cell-exec.js');

test('launch broker delivers a payload once over a private Unix socket and leaves no secret file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncbroker-')); fs.chmodSync(home, 0o700);
  const broker = createLaunchBroker({ home, launchTokenTtlMs: 2000 });
  try {
    const payload = { command: '/bin/echo', args: ['ok'], env: { API_KEY: 'secret-value', PATH: '/bin' } };
    const ticket = await broker.issue(payload);
    assert.equal(ticket.socketPath.includes('secret-value'), false);
    assert.equal(ticket.nonce.includes('secret-value'), false);
    assert.equal(fs.statSync(path.dirname(ticket.socketPath)).mode & 0o777, 0o700);
    const received = await receivePayload(ticket.socketPath, ticket.nonce);
    assert.deepEqual(received, payload);
    assert.equal(broker.pendingCount(), 0);
    await assert.rejects(() => receivePayload(ticket.socketPath, ticket.nonce, 200), /closed early|timed out/);
    assert.equal(fs.readdirSync(path.dirname(ticket.socketPath)).some((name) => name.endsWith('.json')), false);
  } finally { await broker.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

// Audit: il chmod 0600 sul socket era INGOIATO (try/catch/ignora), a
// differenza della directory 15 righe sopra in ensureRuntimeDir, che
// verifica il mode REALE dopo il proprio chmod e fallisce chiuso se non
// conforme. MISURA (chmod fatto fallire DAVVERO — si intercetta la vera
// fs.chmodSync del modulo condiviso, non si mocka il broker): con la dir
// 0700 la garanzia end-to-end regge comunque per il vettore "altro utente"
// (attraversare una directory richiede il bit x su OGNI componente del
// path — il mode del file terminale non conta per chi non puo' nemmeno
// raggiungerlo), ma il fallimento restava silenzioso e la sicurezza restava
// appesa a UNA sola garanzia indipendente invece di due.

async function withChmodFailingOnSockets(fn) {
  const originalChmodSync = fs.chmodSync;
  fs.chmodSync = function (p, mode) {
    if (String(p).endsWith('.sock')) {
      const e = new Error('simulated: chmod fallisce sul socket (fs.chmodSync reale intercettata)');
      e.code = 'EIO';
      throw e;
    }
    return originalChmodSync.call(fs, p, mode);
  };
  // fn() e' async: il monkeypatch deve restare attivo fino a quando il
  // callback di server.listen (asincrono, futuro nell'event loop) non ha
  // gia' chiamato la fs.chmodSync intercettata — un finally non-awaited
  // ripristinerebbe l'originale PRIMA che quel callback si esegua.
  try { return await fn(); } finally { fs.chmodSync = originalChmodSync; }
}

test('MISURA + FIX: chmod 0600 sul socket fallito -> il broker fallisce chiuso, non lascia un socket con mode largo abbandonato', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncbroker-chmodfail-'));
  fs.chmodSync(home, 0o700);
  const originalUmask = process.umask(0o022);
  const broker = createLaunchBroker({ home, launchTokenTtlMs: 2000 });
  try {
    await withChmodFailingOnSockets(async () => {
      await assert.rejects(
        () => broker.issue({ command: '/bin/echo', args: ['ok'], env: {} }),
        /unsafe launch broker socket/,
        'un chmod fallito non deve risolversi come successo silenzioso',
      );
    });
    // Nessun socket con mode largo lasciato sul disco: il fallimento pulisce.
    const runDir = path.join(home, '.nexuscrew', 'run');
    const leftover = fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((n) => n.endsWith('.sock')) : [];
    assert.deepEqual(leftover, [], 'nessun socket abbandonato con permessi non verificati');
  } finally {
    process.umask(originalUmask);
    await broker.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Riconsegna: la guardia sopra verificava SOLO il mode (chmod, poi
// statSync().mode) — il PERMESSO, non l'IDENTITA'. MISURA (sostituzione
// REALE del file, non simulata: si intercetta la vera fs.chmodSync, si
// lascia che faccia il suo lavoro sul vero socket, e SUBITO DOPO si
// rimpiazza il path con un file regolare mode 0600 — stesso trust boundary
// di un attaccante con accesso alla dir 0700): con la guardia precedente
// issue() si risolveva comunque, perche' il mode del file regolare
// combaciava. La guardia dichiarava di verificare "questo socket ha i
// permessi giusti" ma in realta' non garantiva che fosse ancora un socket.
async function withSocketSwappedForRegularFileAfterChmod(fn) {
  const originalChmodSync = fs.chmodSync;
  let swapped = false;
  fs.chmodSync = function (p, mode) {
    const r = originalChmodSync.call(fs, p, mode);
    if (String(p).endsWith('.sock') && !swapped) {
      swapped = true;
      fs.unlinkSync(p);
      fs.writeFileSync(p, 'non e un socket');
      originalChmodSync.call(fs, p, 0o600);
    }
    return r;
  };
  try { return await fn(); } finally { fs.chmodSync = originalChmodSync; }
}

test('MISURA + FIX: il socket sostituito con un file regolare (stesso mode 0600) dopo il chmod -> il broker se ne accorge, non verifica solo il permesso', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncbroker-toctou-'));
  fs.chmodSync(home, 0o700);
  const broker = createLaunchBroker({ home, launchTokenTtlMs: 2000 });
  try {
    await withSocketSwappedForRegularFileAfterChmod(async () => {
      await assert.rejects(
        () => broker.issue({ command: '/bin/echo', args: ['ok'], env: {} }),
        /unsafe launch broker socket/,
        'un permesso corretto su un oggetto che non e\' piu\' un socket non deve passare',
      );
    });
    const runDir = path.join(home, '.nexuscrew', 'run');
    const leftover = fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((n) => n.endsWith('.sock')) : [];
    assert.deepEqual(leftover, [], 'nessun residuo (socket o file sostituito) abbandonato sul disco');
  } finally {
    await broker.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cell-exec payload validation rejects shell-shaped or malformed launch data', () => {
  assert.equal(validPayload({ command: '/bin/x', args: ['; rm -rf /'], env: { SAFE: 'value' } }), true,
    'argv is data and is never shell-evaluated');
  assert.equal(validPayload({ command: '/bin/x', args: 'bad', env: {} }), false);
  assert.equal(validPayload({ command: '/bin/x', args: [], env: { 'BAD-KEY': 'x' } }), false);
  assert.equal(validPayload({ command: '/bin/x', args: [], env: {}, supervise: { enabled: true, restartDelayMs: 1000 } }), true);
  assert.equal(validPayload({ command: '/bin/x', args: [], env: {}, supervise: { restartDelayMs: 1 } }), false);
});

function fakeChild(onStart) {
  const child = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => onStart(child));
  return child;
}

test('cell-exec supervisor preserves early-failure gate and does not restart an invalid launch', async () => {
  let clock = 0; let launches = 0;
  const payload = {
    command: '/bin/fake', args: [], env: {},
    supervise: { enabled: true, initialReadyMs: 50, restartDelayMs: 50 },
  };
  const code = await main(['--socket', '/tmp/x', '--nonce', 'a'.repeat(64)], {
    receivePayload: async () => payload,
    spawn: () => { launches += 1; return fakeChild((child) => { clock += 10; child.emit('exit', 2, null); }); },
    now: () => clock,
    process: new EventEmitter(),
  });
  assert.equal(code, 2);
  assert.equal(launches, 1);
});

test('cell-exec restarts stable children with backoff, reinjects send-keys prompt and opens the circuit', async () => {
  let clock = 0; let launches = 0; const waits = []; const prompts = [];
  const proc = new EventEmitter();
  const payload = {
    command: '/bin/fake', args: ['--safe'], env: { SAFE: '1' },
    supervise: {
      enabled: true, initialReadyMs: 50, restartDelayMs: 50,
      maxRestartDelayMs: 100, resetAfterMs: 1000,
      rapidWindowMs: 1000, maxRapidRestarts: 1,
    },
    restartPrompt: { tmuxBin: 'tmux', tmuxSession: 'cloud-Dev', prompt: 'resume', readyMs: 0 },
  };
  const code = await main(['--socket', '/tmp/x', '--nonce', 'b'.repeat(64)], {
    receivePayload: async () => payload,
    spawn: () => {
      launches += 1;
      return fakeChild((child) => { clock += 100; child.emit('exit', 1, null); });
    },
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); },
    process: proc,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    injectPrompt: async (_bin, session, prompt) => { prompts.push([session, prompt]); },
    writeError: () => {},
  });
  assert.equal(code, 1);
  assert.equal(launches, 2);
  assert.deepEqual(waits, [50]);
  assert.deepEqual(prompts, [['cloud-Dev', 'resume']]);
  assert.equal(proc.listenerCount('SIGTERM'), 0, 'signal handlers cleaned up');
});

test('cell-exec stop during backoff disarms relaunch', async () => {
  let clock = 0; let launches = 0;
  const proc = new EventEmitter();
  const payload = {
    command: '/bin/fake', args: [], env: {},
    supervise: {
      enabled: true, initialReadyMs: 50, restartDelayMs: 50,
      maxRestartDelayMs: 100, resetAfterMs: 1000,
      rapidWindowMs: 1000, maxRapidRestarts: 4,
    },
  };
  const code = await main(['--socket', '/tmp/x', '--nonce', 'c'.repeat(64)], {
    receivePayload: async () => payload,
    spawn: () => {
      launches += 1;
      return fakeChild((child) => { clock += 100; child.emit('exit', 1, null); });
    },
    now: () => clock,
    sleep: async () => { proc.emit('SIGTERM'); },
    process: proc,
  });
  assert.equal(code, 0);
  assert.equal(launches, 1, 'nessun client rilanciato dopo il segnale di stop');
});

test('R3.1.1 lease: la connessione resta APERTA dopo il payload e sopravvive a un refresh (no destroy)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncbroker-lease-')); fs.chmodSync(home, 0o700);
  let leasedSocket = null;
  let onLeaseFired;
  const onLeasePromise = new Promise((resolve) => { onLeaseFired = resolve; });
  const broker = createLaunchBroker({
    home, launchTokenTtlMs: 60000,
    onLease: (socket, lease) => {
      leasedSocket = socket;
      // Il server lease registra il proprio data listener sulla connessione APERTA
      // e risponde con un ack a ogni messaggio: dimostra che vive dopo il payload.
      socket.setEncoding('utf8');
      socket.on('data', () => { try { socket.write('{"type":"ack"}\n'); } catch (_) {} });
      onLeaseFired(lease);
    },
  });
  try {
    const ticket = await broker.issue({ command: '/bin/x', args: [], env: {}, lease: { cellId: 'Dev' } });
    const sock = net.createConnection(ticket.socketPath);
    await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
    // Data listener registrato PRIMA del nonce: il frame payload viene drainato e si
    // rileva l'ack del server lease sul messaggio successivo.
    let gotAck = false;
    sock.on('data', (chunk) => { if (chunk.toString('utf8').includes('ack')) gotAck = true; });
    // Invia il nonce one-shot
    sock.write(`${JSON.stringify({ nonce: ticket.nonce })}\n`);
    // Attendi che il server sia entrato nel path lease (ha scritto il payload).
    const lease = await Promise.race([
      onLeasePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('onLease timeout')), 1000)),
    ]);
    assert.equal(lease && lease.cellId, 'Dev', 'onLease riceve il lease');
    assert.ok(leasedSocket && !leasedSocket.destroyed, 'socket lease APERTA dopo il payload');
    // Un messaggio successivo (refresh) NON deve distruggere la connessione lease.
    sock.write('{"type":"refresh"}\n');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(leasedSocket.destroyed, false, 'R3.1.1: la socket lease non e stata distrutta dal refresh');
    assert.equal(gotAck, true, 'R3.1.1: la connessione persiste (ack ricevuto dal server lease)');
    sock.destroy();
  } finally { await broker.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('launch broker revoke consuma il ticket senza attendere il TTL (cleanup su respawn fallito)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncbroker-rv-')); fs.chmodSync(home, 0o700);
  const broker = createLaunchBroker({ home, launchTokenTtlMs: 60000 });
  try {
    const ticket = await broker.issue({ command: '/bin/x', args: [], env: {} });
    assert.equal(broker.pendingCount(), 1);
    broker.revoke(ticket.nonce);
    assert.equal(broker.pendingCount(), 0, 'revoke consuma subito il ticket');
    // il payload non e' piu riscattabile (nonce revocato prima di qualunque byte lasci il processo)
    await assert.rejects(() => receivePayload(ticket.socketPath, ticket.nonce, 200), /closed early|timed out/);
    // revoke idempotente su nonce gia' revocato o sconosciuto (no-op, non throw)
    broker.revoke(ticket.nonce);
    broker.revoke('nonexistent');
  } finally { await broker.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
