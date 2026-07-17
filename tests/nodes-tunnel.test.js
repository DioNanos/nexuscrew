'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
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
    '-o', 'ConnectTimeout=15',
    '-o', 'LogLevel=ERROR',
    '-i', '/home/user/.nexuscrew/keys/host_ed25519',
    '-L', '127.0.0.1:43001:127.0.0.1:41820',
    'user@example.com',
  ]);
  // nessun argomento contiene spazi/shell (argv puro)
  for (const a of args) assert.ok(!/\s/.test(a) || a === '-o', `arg "${a}" senza whitespace`);
});

test('buildForwardArgs: sshPort usa -p senza confonderla con remotePort', () => {
  const args = tunnel.buildForwardArgs({ ...NODE, sshPort: 41822, remotePort: 41777 });
  assert.deepEqual(args.slice(0, 15), [
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'LogLevel=ERROR',
    '-p', '41822',
  ]);
  assert.ok(args.includes('127.0.0.1:43001:127.0.0.1:41777'));
  assert.equal(args.at(-1), 'user@example.com');
});

test('buildForwardArgs: reverse negoziata resta privata finche Share non e esplicito', () => {
  const privateArgs = tunnel.buildForwardArgs({ ...NODE, reversePort: 44001, shared: false, localAppPort: 41777 });
  assert.equal(privateArgs.includes('-R'), false, 'pairing privato = solo -L');
  const sharedArgs = tunnel.buildForwardArgs({ ...NODE, reversePort: 44001, shared: true, localAppPort: 41777 });
  assert.ok(sharedArgs.includes('-R'));
  assert.ok(sharedArgs.includes('127.0.0.1:44001:127.0.0.1:41777'));
});

test('buildForwardArgs: Share non ripiega mai sulla porta remota se localAppPort manca', () => {
  assert.throws(
    () => tunnel.buildForwardArgs({ ...NODE, reversePort: 44001, shared: true }),
    /Share richiede localAppPort esplicita/,
  );
  assert.doesNotThrow(() => tunnel.buildForwardArgs({ ...NODE, reversePort: 44001, shared: false }));
});

test('build*Args: spec invalida -> throw (no argv injection)', () => {
  assert.throws(() => tunnel.buildForwardArgs({ ...NODE, ssh: 'user@-evil' }), /ssh/);
  assert.throws(() => tunnel.buildForwardArgs({ ...NODE, localPort: 0 }), /localPort/);
  assert.throws(() => tunnel.buildForwardArgs({ ...NODE, sshPort: 0 }), /sshPort/);
  assert.throws(() => tunnel.buildForwardArgs({ ...NODE, keyPath: 'relative' }), /keyPath/);
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

test('reconcileTunnelSupervisors: ferma solo pidfile orfani con nomi stretti', () => {
  const dir = tmpDir();
  const root = tunnel.tunnelDir(dir);
  fs.mkdirSync(root, { recursive: true });
  for (const name of ['configured', 'orphan', tunnel.REVERSE_NAME, 'bad name']) {
    fs.writeFileSync(path.join(root, `${name}.pid`), '{}\n', { mode: 0o600 });
  }
  fs.symlinkSync(path.join(root, 'orphan.pid'), path.join(root, 'linked.pid'));
  const stopped = [];
  const result = tunnel.reconcileTunnelSupervisors({
    home: dir,
    configuredNames: ['configured'],
    stopImpl: ({ name }) => { stopped.push(name); return { stopped: true }; },
  });
  assert.deepEqual(result.kept, ['configured']);
  assert.deepEqual(stopped, [tunnel.REVERSE_NAME, 'orphan']);
  assert.deepEqual(result.stopped, [tunnel.REVERSE_NAME, 'orphan']);
  assert.deepEqual(result.failed, []);
  fs.rmSync(dir, { recursive: true, force: true });
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

test('startForward: auto usa un solo supervisor OpenSSH anche se autossh risulta disponibile', () => {
  const dir = tmpDir(); const calls = [];
  const r = tunnel.startForward({
    home: dir, node: { ...NODE, transport: 'auto' }, logFd: null,
    spawnSyncImpl: () => ({ stderr: 'OpenSSH_9.6p1\n' }),
    spawnImpl: (bin, args) => { calls.push([bin, args]); return { pid: 4243, unref() {} }; },
  });
  assert.equal(r.started, true);
  assert.equal(r.transport, 'ssh');
  assert.equal(calls[0][1][1], 'ssh');
  assert.equal(calls[0][1].includes('-M'), false, 'niente autossh annidato nel supervisor');
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

test('startTunnel: specifica cambiata sostituisce il supervisor vivo verificato', () => {
  const dir = tmpDir();
  fs.mkdirSync(tunnel.tunnelDir(dir), { recursive: true });
  const pidPath = tunnel.tunnelPidPath(dir, 'vps');
  const previous = `${process.execPath} ${path.join(__dirname, '..', 'lib', 'nodes', 'tunnel-supervisor.js')} ssh -N -L 127.0.0.1:43001:127.0.0.1:41820 x`;
  pidf.writePidfile(pidPath, process.pid, previous);
  let spawned = 0;
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === process.pid && signal === 'SIGTERM') return true;
    return originalKill(pid, signal);
  };
  try {
    const result = tunnel.startTunnel({
      home: dir, name: 'vps', args: ['-N', '-L', '127.0.0.1:43001:127.0.0.1:41777', 'x'],
      logFd: null, spawnSyncImpl: sshThere,
      spawnImpl: () => { spawned += 1; return { pid: 987654, unref() {} }; },
    });
    assert.equal(result.started, true);
    assert.equal(spawned, 1);
    assert.match(pidf.readPidfile(pidPath).cmd, /41777/);
  } finally {
    process.kill = originalKill;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readTunnelState: down se nessun pidfile', () => {
  const dir = tmpDir();
  assert.deepEqual(tunnel.readTunnelState(dir, 'vps'), { status: 'down' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('supervisorExited usa ps su macOS quando procfs non esiste', () => {
  const common = {
    pidExistsImpl: () => true,
    procReadImpl: () => { throw new Error('ENOENT'); },
  };
  assert.equal(tunnel.supervisorExited(4242, 0, {
    ...common, spawnSyncImpl: (bin, args) => {
      assert.equal(bin, 'ps'); assert.deepEqual(args, ['-p', '4242', '-o', 'stat=']);
      return { stdout: 'Z+\n' };
    },
  }), true);
  assert.equal(tunnel.supervisorExited(4242, 0, {
    ...common, spawnSyncImpl: () => ({ stdout: 'S+\n' }),
  }), false);
});

test('readTunnelState ignora sidecar di una generazione precedente', () => {
  const dir = tmpDir();
  fs.mkdirSync(tunnel.tunnelDir(dir), { recursive: true });
  pidf.writePidfile(tunnel.tunnelPidPath(dir, 'vps'), process.pid, '', { runId: 'new-generation' });
  fs.writeFileSync(tunnel.tunnelStatePath(dir, 'vps'), JSON.stringify({
    status: 'transport-ready', supervisorPid: process.pid, runId: 'old-generation', transport: 'ssh',
  }));
  assert.equal(tunnel.readTunnelState(dir, 'vps').status, 'down');
  assert.equal(tunnel.readTunnelState(dir, 'vps').reason, 'starting');

  fs.writeFileSync(tunnel.tunnelStatePath(dir, 'vps'), JSON.stringify({
    status: 'transport-ready', supervisorPid: process.pid, runId: 'new-generation', transport: 'ssh',
  }));
  const ready = tunnel.readTunnelState(dir, 'vps');
  assert.equal(ready.status, 'up');
  assert.equal(ready.phase, 'transport-ready');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanup di una vecchia generazione non cancella lo stato nuovo', () => {
  const dir = tmpDir();
  fs.mkdirSync(tunnel.tunnelDir(dir), { recursive: true });
  const statePath = tunnel.tunnelStatePath(dir, 'vps');
  fs.writeFileSync(statePath, JSON.stringify({
    status: 'starting', supervisorPid: 222, runId: 'new-generation',
  }));
  assert.equal(tunnel.removeStateIfOwned(dir, 'vps', { pid: 111, runId: 'old-generation' }), false);
  assert.equal(fs.existsSync(statePath), true);
  assert.equal(tunnel.removeStateIfOwned(dir, 'vps', { pid: 222, runId: 'new-generation' }), true);
  assert.equal(fs.existsSync(statePath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diagnostica SSH distingue forward negato, auth, host key, DNS e rete senza esporre log grezzo', () => {
  assert.deepEqual(tunnel.classifySshFailure('channel 2: open failed: administratively prohibited: open failed', 41777), {
    code: 'forward-denied',
    detail: 'SSH autenticato, ma il server ha negato il port forwarding verso 127.0.0.1:41777',
    hint: "verifica AllowTcpForwarding e l'eventuale permitopen per 127.0.0.1:41777; il link NON e' stato consumato",
  });
  assert.equal(tunnel.classifySshFailure('Permission denied (publickey).', 41777).code, 'ssh-auth-failed');
  assert.equal(tunnel.classifySshFailure('Host key verification failed.', 41777).code, 'ssh-host-key');
  assert.equal(tunnel.classifySshFailure('ssh: Could not resolve hostname hub', 41777).code, 'ssh-dns');
  assert.equal(tunnel.classifySshFailure('connect to host x port 22: Connection refused', 41777).code, 'ssh-unreachable');
  const reverse = tunnel.classifySshFailure('remote port forwarding failed for listen port 44001', 41777);
  assert.equal(reverse.code, 'reverse-forward-failed');
  assert.doesNotMatch(reverse.detail, /ha negato/i, 'a generic remote failure must not claim a policy denial');
  assert.equal(tunnel.classifySshFailure('remote port forwarding failed: bind 127.0.0.1:44001: Address already in use', 41777).code, 'reverse-forward-bind');
  assert.equal(tunnel.classifySshFailure('unrelated harmless line', 41777), null);
});

test('readTunnelDiagnostic legge solo un log regolare controllato e rifiuta symlink', () => {
  const dir = tmpDir();
  fs.mkdirSync(tunnel.tunnelDir(dir), { recursive: true });
  fs.writeFileSync(tunnel.tunnelLogPath(dir, 'hub'), 'channel 3: open failed: administratively prohibited\n');
  assert.equal(tunnel.readTunnelDiagnostic(dir, 'hub', 41777).code, 'forward-denied');
  fs.unlinkSync(tunnel.tunnelLogPath(dir, 'hub'));
  fs.symlinkSync('/etc/passwd', tunnel.tunnelLogPath(dir, 'hub'));
  assert.equal(tunnel.readTunnelDiagnostic(dir, 'hub', 41777), null);
  assert.equal(tunnel.readTunnelDiagnostic(dir, '../bad', 41777), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diagnoseTunnel espone solo stato strutturato e preferisce la causa SSH classificata', () => {
  const dir = tmpDir();
  const node = { ...NODE, name: 'hub', remotePort: 41777 };
  assert.equal(tunnel.diagnoseTunnel(dir, node).code, 'tunnel-stopped');
  assert.equal(tunnel.diagnoseTunnel(dir, node, { status: 'down', reason: 'starting' }).code, 'ssh-starting');
  assert.equal(tunnel.diagnoseTunnel(dir, node, { status: 'down', reason: 'retrying', attempt: 2 }).code, 'ssh-retrying');
  fs.mkdirSync(tunnel.tunnelDir(dir), { recursive: true });
  fs.writeFileSync(tunnel.tunnelLogPath(dir, 'hub'), 'channel 3: open failed: administratively prohibited\nSECRET_PATH=/private/user\n');
  const denied = tunnel.diagnoseTunnel(dir, node, { status: 'up', phase: 'transport-ready' });
  assert.equal(denied.code, 'forward-denied');
  assert.ok(!JSON.stringify(denied).includes('SECRET_PATH'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tunnel log: directory 0700, file 0600 e contenuto per-run (niente append stale)', () => {
  const dir = tmpDir();
  tunnel.prepareTunnelDir(dir);
  const logPath = tunnel.tunnelLogPath(dir, 'secure');
  fs.writeFileSync(logPath, 'stale diagnostic from a previous run\n', { mode: 0o666 });
  fs.chmodSync(tunnel.tunnelDir(dir), 0o775);
  fs.chmodSync(logPath, 0o664);

  const result = tunnel.startTunnel({
    home: dir, name: 'secure', args: ['-N', 'x'], spawnSyncImpl: sshThere,
    spawnImpl: () => ({ pid: 998877, unref() {} }),
  });
  assert.equal(result.started, true);
  assert.equal(fs.statSync(tunnel.tunnelDir(dir)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  const diagnostic = fs.readFileSync(logPath, 'utf8');
  assert.match(diagnostic, /^\[nexuscrew\] supervisor requested transport=/,
    'ogni supervisor scrive un breadcrumb sicuro anche quando ssh è silenzioso');
  assert.ok(!diagnostic.includes('stale diagnostic'), 'il log precedente viene troncato');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tunnel log: symlink file o directory viene rifiutato prima dello spawn', () => {
  const dir = tmpDir();
  const outside = path.join(dir, 'outside');
  fs.writeFileSync(outside, 'do not touch');
  tunnel.prepareTunnelDir(dir);
  fs.symlinkSync(outside, tunnel.tunnelLogPath(dir, 'unsafe'));
  let spawned = 0;
  const fileLink = tunnel.startTunnel({
    home: dir, name: 'unsafe', args: ['-N', 'x'], spawnSyncImpl: sshThere,
    spawnImpl: () => { spawned += 1; return { pid: 1, unref() {} }; },
  });
  assert.equal(fileLink.started, false);
  assert.match(fileLink.reason, /unsafe tunnel log/);
  assert.equal(spawned, 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'do not touch');

  const second = tmpDir();
  const targetDir = path.join(second, 'target');
  fs.mkdirSync(path.join(second, '.nexuscrew'), { recursive: true });
  fs.mkdirSync(targetDir);
  fs.symlinkSync(targetDir, tunnel.tunnelDir(second));
  const dirLink = tunnel.startTunnel({
    home: second, name: 'unsafe', args: ['-N', 'x'], spawnSyncImpl: sshThere,
    spawnImpl: () => { spawned += 1; return { pid: 2, unref() {} }; },
  });
  assert.equal(dirLink.started, false);
  assert.match(dirLink.reason, /unsafe tunnel log/);
  assert.equal(spawned, 0);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
});

// --- ssh version / permitlisten --------------------------------------------

test('readSshVersion e solo diagnostica locale, non certifica la policy remota', () => {
  const mkSpawn = (text) => () => ({ stdout: '', stderr: text });
  const v = tunnel.readSshVersion(mkSpawn('OpenSSH_9.6p1 Ubuntu, OpenSSL 3.0\n'));
  assert.deepEqual({ major: v.major, minor: v.minor }, { major: 9, minor: 6 });
  const old = tunnel.readSshVersion(mkSpawn('OpenSSH_7.2p2\n'));
  assert.deepEqual({ major: old.major, minor: old.minor }, { major: 7, minor: 2 });
  const v78 = tunnel.readSshVersion(mkSpawn('OpenSSH_7.8\n'));
  assert.deepEqual({ major: v78.major, minor: v78.minor }, { major: 7, minor: 8 });
  const none = tunnel.readSshVersion(mkSpawn('garbage'));
  assert.equal(none, null);
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
  const pidPath = path.join(dir, 'tunnel.pid');
  const runId = 'retry-generation';
  fs.writeFileSync(fakeSsh, [
    "'use strict';",
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(attemptsPath)}, 'attempt\\n');`,
    'process.exit(7);',
    '',
  ].join('\n'), { mode: 0o700 });
  const supervisor = path.join(__dirname, '..', 'lib', 'nodes', 'tunnel-supervisor.js');
  const child = spawn(process.execPath, [supervisor, process.execPath, fakeSsh], {
    env: {
      ...process.env,
      NEXUSCREW_TUNNEL_STATE: statePath,
      NEXUSCREW_TUNNEL_PIDFILE: pidPath,
      NEXUSCREW_TUNNEL_RUN_ID: runId,
      // Questo test misura retry/backoff di un child che cade, non readiness.
      // Tieni il probe oltre il deadline per non osservare lo stato concorrente
      // transport-probing sotto carico: quel path ha test dedicati qui sotto.
      NEXUSCREW_TUNNEL_STABLE_MS: '30000',
    },
    stdio: 'ignore',
  });
  pidf.writePidfile(pidPath, child.pid, `${process.execPath} ${supervisor}`, { runId });
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

test('reverse-forward failure ripetuto apre il circuit breaker e conserva una diagnosi terminale', async () => {
  const dir = tmpDir();
  const attemptsPath = path.join(dir, 'reverse-attempts.log');
  const fakeSsh = path.join(dir, 'fake-reverse-failure.js');
  const statePath = tunnel.tunnelStatePath(dir, 'hub');
  const pidPath = tunnel.tunnelPidPath(dir, 'hub');
  const runId = 'reverse-terminal-generation';
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(fakeSsh, [
    "'use strict';",
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(attemptsPath)}, 'attempt\\n');`,
    "console.error('remote port forwarding failed for listen port 44001');",
    'process.exit(255);',
    '',
  ].join('\n'), { mode: 0o700 });
  const supervisor = path.join(__dirname, '..', 'lib', 'nodes', 'tunnel-supervisor.js');
  const child = spawn(process.execPath, [
    supervisor, process.execPath, fakeSsh,
    '-N', '-L', '127.0.0.1:43001:127.0.0.1:41820',
    '-R', '127.0.0.1:44001:127.0.0.1:41820', 'hub',
  ], {
    env: {
      ...process.env,
      NEXUSCREW_TUNNEL_STATE: statePath,
      NEXUSCREW_TUNNEL_PIDFILE: pidPath,
      NEXUSCREW_TUNNEL_RUN_ID: runId,
      NEXUSCREW_TUNNEL_STABLE_MS: '30000',
      NEXUSCREW_TUNNEL_REVERSE_FAILURE_MAX: '2',
    },
    stdio: 'ignore',
  });
  pidf.writePidfile(pidPath, child.pid, `${process.execPath} ${supervisor}`, { runId });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('circuit breaker non terminato')), 6000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    const attempts = fs.readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.equal(attempts, 2, 'retry count is bounded for a persistent reverse-forward failure');
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(raw.status, 'failed');
    assert.equal(raw.terminal, true);
    assert.equal(raw.code, 'reverse-forward-failed');
    assert.doesNotMatch(raw.detail, /ha negato/i);
    const visible = tunnel.readTunnelState(dir, 'hub');
    assert.equal(visible.phase, 'failed');
    assert.equal(visible.code, 'reverse-forward-failed');
    assert.equal(tunnel.diagnoseTunnel(dir, { ...NODE, name: 'hub' }, visible).code, 'reverse-forward-failed');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F1 supervisor dichiara transport-ready e resetta il backoff solo dopo stabilita', async () => {
  const dir = tmpDir();
  const forward = net.createServer((socket) => socket.end());
  await new Promise((resolve) => forward.listen(0, '127.0.0.1', resolve));
  const forwardPort = forward.address().port;
  const fakeSsh = path.join(dir, 'stable-ssh.js');
  const statePath = path.join(dir, 'stable.state.json');
  const pidPath = path.join(dir, 'stable.pid');
  const runId = 'stable-generation';
  fs.writeFileSync(fakeSsh, "setInterval(() => {}, 1000);\n", { mode: 0o700 });
  const supervisor = path.join(__dirname, '..', 'lib', 'nodes', 'tunnel-supervisor.js');
  const child = spawn(process.execPath, [supervisor, process.execPath, fakeSsh,
    '-L', `127.0.0.1:${forwardPort}:127.0.0.1:41777`], {
    env: {
      ...process.env,
      NEXUSCREW_TUNNEL_STATE: statePath,
      NEXUSCREW_TUNNEL_PIDFILE: pidPath,
      NEXUSCREW_TUNNEL_RUN_ID: runId,
      NEXUSCREW_TUNNEL_STABLE_MS: '120',
    },
    stdio: 'ignore',
  });
  pidf.writePidfile(pidPath, child.pid, `${process.execPath} ${supervisor}`, { runId });
  try {
    const deadline = Date.now() + 3000;
    let state = null;
    while (Date.now() < deadline) {
      try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
      if (state && state.status === 'transport-ready') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(state, 'sidecar stato supervisor non scritto');
    assert.equal(state.status, 'transport-ready');
    assert.equal(state.runId, runId);
    assert.equal(state.supervisorPid, child.pid);
    assert.equal(state.attempt, 0);
    assert.ok(state.stableMs >= 100);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await new Promise((resolve) => forward.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F1 supervisor non dichiara ready finche il forward TCP non risponde', async () => {
  const dir = tmpDir();
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const unavailablePort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const fakeSsh = path.join(dir, 'blocked-ssh.js');
  const statePath = path.join(dir, 'blocked.state.json');
  const pidPath = path.join(dir, 'blocked.pid');
  const runId = 'blocked-generation';
  fs.writeFileSync(fakeSsh, "setInterval(() => {}, 1000);\n", { mode: 0o700 });
  const supervisor = path.join(__dirname, '..', 'lib', 'nodes', 'tunnel-supervisor.js');
  const child = spawn(process.execPath, [supervisor, process.execPath, fakeSsh,
    '-L', `127.0.0.1:${unavailablePort}:127.0.0.1:41777`], {
    env: {
      ...process.env,
      NEXUSCREW_TUNNEL_STATE: statePath,
      NEXUSCREW_TUNNEL_PIDFILE: pidPath,
      NEXUSCREW_TUNNEL_RUN_ID: runId,
      NEXUSCREW_TUNNEL_STABLE_MS: '100',
    },
    stdio: 'ignore',
  });
  pidf.writePidfile(pidPath, child.pid, `${process.execPath} ${supervisor}`, { runId });
  try {
    const deadline = Date.now() + 1500;
    let state = null;
    while (Date.now() < deadline) {
      try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
      if (state?.status === 'transport-probing') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(state, 'sidecar stato supervisor non scritto');
    assert.equal(state.status, 'transport-probing');
    await new Promise((resolve) => setTimeout(resolve, 400));
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.notEqual(state.status, 'transport-ready');
    assert.equal(state.attempt, 0, 'il processo e vivo ma non deve qualificarsi come trasporto pronto');
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

test('F1 supervisor termina ssh e se stesso quando perde la generazione pidfile', async () => {
  const dir = tmpDir();
  const forward = net.createServer((socket) => socket.end());
  await new Promise((resolve) => forward.listen(0, '127.0.0.1', resolve));
  const forwardPort = forward.address().port;
  const sshPidPath = path.join(dir, 'ssh.pid');
  const fakeSsh = path.join(dir, 'owned-ssh.js');
  const statePath = path.join(dir, 'owned.state.json');
  const pidPath = path.join(dir, 'owned.pid');
  const runId = 'owned-generation';
  fs.writeFileSync(fakeSsh, `require('node:fs').writeFileSync(${JSON.stringify(sshPidPath)}, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const supervisor = path.join(__dirname, '..', 'lib', 'nodes', 'tunnel-supervisor.js');
  const child = spawn(process.execPath, [supervisor, process.execPath, fakeSsh,
    '-L', `127.0.0.1:${forwardPort}:127.0.0.1:41777`], {
    env: {
      ...process.env,
      NEXUSCREW_TUNNEL_STATE: statePath,
      NEXUSCREW_TUNNEL_PIDFILE: pidPath,
      NEXUSCREW_TUNNEL_RUN_ID: runId,
      NEXUSCREW_TUNNEL_STABLE_MS: '100',
    },
    stdio: 'ignore',
  });
  pidf.writePidfile(pidPath, child.pid, `${process.execPath} ${supervisor}`, { runId });
  let sshPid = null;
  try {
    const readyBy = Date.now() + 3000;
    while (Date.now() < readyBy) {
      try { sshPid = Number(fs.readFileSync(sshPidPath, 'utf8')); } catch (_) {}
      let state = null;
      try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
      if (sshPid && state?.status === 'transport-ready') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(sshPid, 'ssh child non avviato');
    fs.writeFileSync(pidPath, `${JSON.stringify({ pid: child.pid, cmd: 'replacement', runId: 'replacement-generation' })}\n`, { mode: 0o600 });
    await new Promise((resolve, reject) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => reject(new Error('supervisor orfano non terminato')), 3500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    const sshGoneBy = Date.now() + 2000;
    while (pidf.pidExists(sshPid) && Date.now() < sshGoneBy) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(pidf.pidExists(sshPid), false, 'ssh child deve terminare con la generazione persa');
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
    if (sshPid) try { process.kill(sshPid, 'SIGKILL'); } catch (_) {}
    await new Promise((resolve) => forward.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
