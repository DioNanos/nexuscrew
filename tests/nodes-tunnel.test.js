'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const tunnel = require('../lib/nodes/tunnel.js');
const pidf = require('../lib/cli/pidfile.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-tun-'));

const NODE = {
  name: 'vps', ssh: 'user@example.com',
  remotePort: 41820, localPort: 43001,
  keyPath: '/home/user/.nexuscrew/keys/host_ed25519',
};

// --- argv EXACT-MATCH (design §4b(1)) --------------------------------------

test('buildForwardArgs: argv esatto dal template §4b(1)', () => {
  const args = tunnel.buildForwardArgs(NODE);
  assert.deepEqual(args, [
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'BatchMode=yes',
    '-i', '/home/user/.nexuscrew/keys/host_ed25519',
    '-L', '127.0.0.1:43001:127.0.0.1:41820',
    'user@example.com',
  ]);
  // nessun argomento contiene spazi/shell (argv puro)
  for (const a of args) assert.ok(!/\s/.test(a) || a === '-o', `arg "${a}" senza whitespace`);
});

test('buildReverseArgs: argv esatto con bind loopback esplicito lato remoto', () => {
  const args = tunnel.buildReverseArgs({ ssh: 'user@host', publishedPort: 41821, localPort: 41820, keyPath: '/home/user/.nexuscrew/keys/rendezvous_ed25519' });
  assert.deepEqual(args, [
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'BatchMode=yes',
    '-i', '/home/user/.nexuscrew/keys/rendezvous_ed25519',
    '-R', '127.0.0.1:41821:127.0.0.1:41820', // 127.0.0.1: esplicito, mai wildcard
    'user@host',
  ]);
});

test('build*Args: spec invalida -> throw (no argv injection)', () => {
  assert.throws(() => tunnel.buildForwardArgs({ ...NODE, ssh: 'user@-evil' }), /ssh/);
  assert.throws(() => tunnel.buildForwardArgs({ ...NODE, localPort: 0 }), /localPort/);
  assert.throws(() => tunnel.buildForwardArgs({ ...NODE, keyPath: 'relative' }), /keyPath/);
  assert.throws(() => tunnel.buildReverseArgs({ ssh: 'u@h', publishedPort: 99999, localPort: 22, keyPath: '/k' }), /publishedPort/);
});

// --- backoff deterministico -------------------------------------------------

test('backoffDelay: esponenziale, cap, jitter deterministico', () => {
  const o = { baseMs: 1000, factor: 2, capMs: 60000, jitter: 0.2 };
  // rng=0.5 -> jitter nullo -> valore base clamperato
  assert.equal(tunnel.backoffDelay(0, { ...o, rng: () => 0.5 }), 1000);
  assert.equal(tunnel.backoffDelay(1, { ...o, rng: () => 0.5 }), 2000);
  assert.equal(tunnel.backoffDelay(3, { ...o, rng: () => 0.5 }), 8000);
  // cap
  assert.equal(tunnel.backoffDelay(100, { ...o, rng: () => 0.5 }), 60000);
  // jitter estremi: rng=1 -> +20%, rng=0 -> -20%
  assert.equal(tunnel.backoffDelay(1, { ...o, rng: () => 1 }), 2400);
  assert.equal(tunnel.backoffDelay(1, { ...o, rng: () => 0 }), 1600);
  // mai negativo
  assert.ok(tunnel.backoffDelay(0, { ...o, rng: () => 0 }) >= 0);
});

// --- lifecycle con spawn mockato (mai ssh reale) ---------------------------

test('startForward: spawn con argv esatto, detached, pidfile scritto', () => {
  const dir = tmpDir();
  const calls = [];
  const r = tunnel.startForward({
    home: dir, node: NODE,
    logFd: null, // evita openSync reale
    spawnImpl: (bin, args, spawnOpts) => { calls.push([bin, args, spawnOpts]); return { pid: 4242, unref() {} }; },
  });
  assert.equal(r.started, true);
  assert.equal(r.pid, 4242);
  assert.equal(calls[0][0], process.execPath);
  assert.ok(calls[0][1][0].endsWith('tunnel-supervisor.js'));
  assert.equal(calls[0][1][1], 'ssh');
  assert.deepEqual(calls[0][1].slice(2), tunnel.buildForwardArgs(NODE));
  assert.equal(calls[0][2].detached, true);
  // pidfile presente e vivo? isAlive dipende dal pid: qui il pid 4242 e' finto,
  // ma lo stato letto deve almeno riconoscere il file. Verifichiamo il file.
  const pidPath = tunnel.tunnelPidPath(dir, 'vps');
  assert.ok(fs.existsSync(pidPath));
  const meta = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
  assert.equal(meta.pid, 4242);
  assert.ok(meta.cmd.includes('ssh -N'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('startTunnel: idempotente se gia vivo (no doppio spawn)', () => {
  const dir = tmpDir();
  // pidfile vivo pre-esistente (cmd vuoto -> isAlive via solo pidExists, self pid)
  fs.mkdirSync(tunnel.tunnelDir(dir), { recursive: true });
  pidf.writePidfile(tunnel.tunnelPidPath(dir, 'vps'), process.pid, '');
  let spawned = 0;
  const r = tunnel.startTunnel({
    home: dir, name: 'vps', args: ['-N', 'x'], logFd: null,
    spawnImpl: () => { spawned += 1; return { pid: process.pid, unref() {} }; },
  });
  assert.equal(r.started, false);
  assert.match(r.reason, /already running/);
  assert.equal(spawned, 0); // non ha spawnato: tunnel gia' vivo
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTunnelState: down se nessun pidfile', () => {
  const dir = tmpDir();
  assert.deepEqual(tunnel.readTunnelState(dir, 'vps'), { status: 'down' });
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- ssh version / permitlisten --------------------------------------------

test('readSshVersion + sshSupportsPermitlisten', () => {
  const mkSpawn = (text) => () => ({ stdout: '', stderr: text });
  const v = tunnel.readSshVersion(mkSpawn('OpenSSH_9.6p1 Ubuntu, OpenSSL 3.0\n'));
  assert.deepEqual({ major: v.major, minor: v.minor }, { major: 9, minor: 6 });
  assert.equal(tunnel.sshSupportsPermitlisten(v), true);
  const old = tunnel.readSshVersion(mkSpawn('OpenSSH_7.2p2\n'));
  assert.equal(tunnel.sshSupportsPermitlisten(old), false);
  const v78 = tunnel.readSshVersion(mkSpawn('OpenSSH_7.8\n'));
  assert.equal(tunnel.sshSupportsPermitlisten(v78), true);
  const none = tunnel.readSshVersion(mkSpawn('garbage'));
  assert.equal(none, null);
  assert.equal(tunnel.sshSupportsPermitlisten(null), null);
});

// --- audit F2: spawn failure non crasha mai, failure esplicita ----------------

const sshThere = () => ({ stderr: 'OpenSSH_9.6p1\n' });
const sshMissing = () => ({ error: { code: 'ENOENT' } });

test('F2 ssh mancante: started:false esplicito, NESSUNO spawn, niente pidfile, niente crash', () => {
  const dir = tmpDir();
  let spawned = 0;
  const r = tunnel.startTunnel({
    home: dir, name: 'ghost', args: ['-N', 'x'],
    sshBin: 'ssh-che-non-esiste-affatto',
    spawnSyncImpl: sshMissing,
    spawnImpl: () => { spawned += 1; return { pid: 123, unref() {} }; },
  });
  assert.equal(r.started, false);
  assert.match(r.reason, /ssh binary not found/);
  assert.equal(spawned, 0, 'spawnImpl non deve essere chiamato se il binario ssh manca');
  assert.ok(!fs.existsSync(tunnel.tunnelPidPath(dir, 'ghost')), 'nessun pidfile scritto');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F2 spawn throw: started:false esplicito (spawn error), niente crash, niente pidfile', () => {
  const dir = tmpDir();
  const r = tunnel.startTunnel({
    home: dir, name: 'k', args: ['-N', 'x'], logFd: null,
    spawnSyncImpl: sshThere,
    spawnImpl: () => { throw new Error('boom EMFILE'); },
  });
  assert.equal(r.started, false);
  assert.match(r.reason, /spawn error/);
  assert.ok(!fs.existsSync(tunnel.tunnelPidPath(dir, 'k')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F2 spawn senza pid: started:false esplicito (no pid)', () => {
  const dir = tmpDir();
  const r = tunnel.startTunnel({
    home: dir, name: 'k', args: ['-N', 'x'], logFd: null,
    spawnSyncImpl: sshThere,
    spawnImpl: () => ({ pid: undefined, unref() {} }),
  });
  assert.equal(r.started, false);
  assert.match(r.reason, /no pid/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F2 error async: niente crash (uncaught), cleanup pidfile, closeOwnedFd idempotente', () => {
  const dir = tmpDir();
  const realClose = fs.closeSync;
  const realOpen = fs.openSync;
  let openedFd = null;
  let closeOfOpened = 0;
  // Contiamo solo le chiusure della fd di log aperta internamente (writeFileSync
  // chiama closeSync internamente su un'altra fd: filtriamo per non falsare il conteggio).
  fs.openSync = (p, ...rest) => { const fd = realOpen(p, ...rest); openedFd = fd; return fd; };
  fs.closeSync = (fd) => { if (openedFd !== null && fd === openedFd) closeOfOpened += 1; return realClose(fd); };
  try {
    const { EventEmitter } = require('node:events');
    let child;
    const r = tunnel.startTunnel({
      home: dir, name: 'err', args: ['-N', 'x'],
      spawnSyncImpl: sshThere,
      spawnImpl: () => { child = new EventEmitter(); child.pid = 5555; child.unref = () => {}; return child; },
    });
    assert.equal(r.started, true);
    assert.equal(closeOfOpened, 1, 'la fd di log aperta internamente va chiusa una volta dopo lo spawn');
    assert.ok(fs.existsSync(tunnel.tunnelPidPath(dir, 'err')));
    // race: il binario sparisce tra pre-flight e spawn -> 'error' async.
    // Prima dell'audit questo evento non aveva listener -> crash Node (unhandled).
    child.emit('error', new Error('ENOENT race'));
    assert.equal(closeOfOpened, 1, 'closeOwnedFd idempotente: nessuna doppia chiusura');
    assert.ok(!fs.existsSync(tunnel.tunnelPidPath(dir, 'err')), 'pidfile rimosso sul cleanup');
  } finally {
    fs.openSync = realOpen; fs.closeSync = realClose;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- audit F3: la fd di log aperta internamente non lecca mai ----------------

test('F3 successo: la fd aperta internamente viene chiusa sul SUCCESSO (no leak)', () => {
  const dir = tmpDir();
  const realClose = fs.closeSync;
  const realOpen = fs.openSync;
  let openedFd = null;
  const closed = new Set();
  fs.openSync = (p, ...rest) => { const fd = realOpen(p, ...rest); openedFd = fd; return fd; };
  fs.closeSync = (fd) => { closed.add(fd); return realClose(fd); };
  try {
    const r = tunnel.startTunnel({
      home: dir, name: 'leak', args: ['-N', 'x'],
      spawnSyncImpl: sshThere,
      spawnImpl: () => ({ pid: 7777, unref() {} }),
    });
    assert.equal(r.started, true);
    assert.ok(openedFd !== null, 'una fd di log è stata aperta internamente');
    assert.ok(closed.has(openedFd), 'la fd aperta internamente DEVE essere chiusa dal padre (no leak)');
  } finally {
    fs.openSync = realOpen; fs.closeSync = realClose;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F3 failure: la fd aperta internamente viene chiusa su OGNI path di failure', () => {
  const realClose = fs.closeSync;
  const realOpen = fs.openSync;
  const closed = [];
  let fdSeq = 100;
  fs.openSync = () => { fdSeq += 1; return fdSeq; };
  fs.closeSync = (fd) => { closed.push(fd); };
  try {
    // ssh missing
    tunnel.startTunnel({
      home: tmpDir(), name: 'a', args: ['-N', 'x'],
      spawnSyncImpl: sshMissing, spawnImpl: () => ({ pid: 1, unref() {} }),
    });
    // spawn throw
    tunnel.startTunnel({
      home: tmpDir(), name: 'b', args: ['-N', 'x'],
      spawnSyncImpl: sshThere, spawnImpl: () => { throw new Error('x'); },
    });
    // no pid
    tunnel.startTunnel({
      home: tmpDir(), name: 'c', args: ['-N', 'x'],
      spawnSyncImpl: sshThere, spawnImpl: () => ({ pid: undefined, unref() {} }),
    });
    assert.equal(closed.length, 3, 'la fd aperta internamente va chiusa in ogni path di failure');
  } finally {
    fs.openSync = realOpen; fs.closeSync = realClose;
  }
});

test('F3 caller-provided logFd (es. logFd:null): il tunnel NON apre una fd di log propria', () => {
  const dir = tmpDir();
  const realOpen = fs.openSync;
  const opens = [];
  fs.openSync = (p, ...rest) => { opens.push(p); return realOpen(p, ...rest); };
  try {
    tunnel.startTunnel({
      home: dir, name: 'cust', args: ['-N', 'x'], logFd: null,
      spawnSyncImpl: sshThere, spawnImpl: () => ({ pid: 8888, unref() {} }),
    });
    const logPath = tunnel.tunnelLogPath(dir, 'cust');
    assert.ok(!opens.includes(logPath), 'con logFd fornito dal caller il tunnel NON deve aprire una fd di log propria');
  } finally {
    fs.openSync = realOpen;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F1 supervisor: un ssh che cade viene rilanciato con stato retrying/backoff', async () => {
  const dir = tmpDir();
  const attemptsPath = path.join(dir, 'attempts.log');
  const fakeSsh = path.join(dir, 'fake-ssh.js');
  const statePath = path.join(dir, 'tunnel.state.json');
  fs.writeFileSync(fakeSsh, [
    "'use strict';",
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(attemptsPath)}, 'attempt\\n');`,
    'process.exit(7);',
    '',
  ].join('\n'), { mode: 0o700 });
  const supervisor = path.join(__dirname, '..', 'lib', 'nodes', 'tunnel-supervisor.js');
  const child = spawn(process.execPath, [supervisor, process.execPath, fakeSsh], {
    env: { ...process.env, NEXUSCREW_TUNNEL_STATE: statePath },
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 6000;
    let attempts = 0;
    let state = null;
    while (Date.now() < deadline) {
      try { attempts = fs.readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean).length; } catch (_) {}
      try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
      if (attempts >= 2 && state && state.attempt >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(attempts >= 2, `attesi almeno 2 tentativi, osservati ${attempts}`);
    assert.ok(state, 'sidecar stato supervisor non scritto');
    assert.ok(['starting', 'retrying'].includes(state.status));
    assert.ok(state.attempt >= 1);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
