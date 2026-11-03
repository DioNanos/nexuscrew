'use strict';

// R3-04: one socket-selection policy. A private TMUX trap and a different
// private TMUX_TMPDIR must not send a NexusCrew tmux client at the trap.
// The raw client is the control: it follows TMUX. No server is created.
// The live fleet server is never addressed.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert');
const { tmuxClientEnv, sharedTmuxSocketPath } = require('../lib/runtime/env.js');
const { tmuxExec } = require('../lib/fleet/launch.js');
const { protectSharedTmuxServer } = require('../lib/tmux/shared-server.js');

const TMUX_BIN = '/bin/tmux';
const LIVE_SERVER_PID = 6083;

function serverPids() {
  const found = [];
  let names;
  try { names = fs.readdirSync('/proc'); } catch (_) { return found; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let comm = '';
    try { comm = fs.readFileSync(`/proc/${name}/comm`, 'utf8').trim(); } catch (_) { continue; }
    if (comm === 'tmux: server') found.push(name);
  }
  found.sort();
  return found;
}

function runRaw(env, args) {
  return new Promise((resolve) => {
    execFile(TMUX_BIN, args, { env, timeout: 5000 }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

function liveSocketPath() {
  let fds;
  try { fds = fs.readdirSync(`/proc/${LIVE_SERVER_PID}/fd`); } catch (_) { return ''; }
  for (const fd of fds) {
    let target = '';
    try { target = fs.readlinkSync(`/proc/${LIVE_SERVER_PID}/fd/${fd}`); } catch (_) { continue; }
    if (target.endsWith('/default') && target.includes('/tmux-')) return target;
  }
  return '';
}

test('socket policy: discordant private TMUX never selects the NexusCrew client', async () => {
  assert.equal(fs.existsSync(TMUX_BIN), true);
  const before = serverPids();
  assert.ok(before.includes(String(LIVE_SERVER_PID)), 'il server vivo deve restare l unico di partenza');
  const liveSocket = liveSocketPath();
  const root = fs.mkdtempSync(path.join('/tmp', 'nc-s6c-pol-'));
  const home = path.join(root, 'home');
  const run = path.join(root, 'run');
  const trapDir = path.join(root, 'trap');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(run, { mode: 0o700 });
  fs.mkdirSync(trapDir, { mode: 0o700 });
  const trapSock = path.join(trapDir, 'selected.sock');
  const source = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    LC_ALL: 'C',
    TMUX_TMPDIR: run,
    TMUX: `${trapSock},99999,0`,
    TMUX_PANE: '%1',
  };
  const expected = sharedTmuxSocketPath(source);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  assert.equal(expected, path.join(run, `tmux-${uid}`, 'default'));
  assert.ok(expected.startsWith(`${root}${path.sep}`));
  assert.notEqual(expected, liveSocket);
  assert.equal(expected.includes(trapSock), false);

  const extras = [];
  try {
    const raw = await runRaw(source, ['has-session', '-t', '=nc-s6c-absent']);
    assert.equal(raw.code, 1);
    assert.ok(raw.stderr.includes(`error connecting to ${trapSock}`), raw.stderr);
    assert.equal(raw.stderr.includes(expected), false);

    const launched = await tmuxExec(TMUX_BIN, ['has-session', '-t', '=nc-s6c-absent'], {
      env: source, timeoutMs: 5000,
    });
    assert.notEqual(launched.code, 0);
    assert.ok(launched.stderr.includes(`error connecting to ${expected}`), launched.stderr);
    assert.equal(launched.stderr.includes(trapSock), false);
    if (liveSocket) assert.equal(launched.stderr.includes(liveSocket), false);

    const surfaceEnv = tmuxClientEnv(source);
    assert.equal(surfaceEnv.TMUX, undefined);
    assert.equal(surfaceEnv.TMUX_TMPDIR, run);
    assert.equal(surfaceEnv.TMUX_PANE, '%1');
    assert.equal(source.TMUX, `${trapSock},99999,0`, 'la sorgente non viene mutata');
    const listed = await runRaw(surfaceEnv, ['list-sessions']);
    assert.notEqual(listed.code, 0);
    assert.ok(listed.stderr.includes(`error connecting to ${expected}`), listed.stderr);
    assert.equal(listed.stderr.includes(trapSock), false);
    if (liveSocket) assert.equal(listed.stderr.includes(liveSocket), false);

    let seen = null;
    const guarded = await protectSharedTmuxServer(TMUX_BIN, {
      env: source,
      execFileImpl: (bin, args, opts, cb) => {
        seen = { bin, args, env: opts.env };
        cb(null, '', '');
      },
    });
    assert.equal(guarded.ok, true);
    assert.equal(seen.bin, TMUX_BIN);
    assert.equal(seen.args[0], 'start-server');
    assert.equal(seen.args.includes('-S'), false);
    assert.equal(seen.env.TMUX, undefined);
    assert.equal(seen.env.TMUX_TMPDIR, run);

    assert.equal(fs.existsSync(trapSock), false);
    assert.equal(fs.existsSync(expected), false);
  } finally {
    const after = serverPids();
    for (const pid of after) {
      if (before.includes(pid) || pid === String(LIVE_SERVER_PID)) continue;
      let mine = false;
      try {
        mine = fs.readFileSync(`/proc/${pid}/environ`).includes(root);
      } catch (_) { mine = false; }
      if (!mine) continue;
      extras.push(pid);
      try { process.kill(Number(pid), 'SIGTERM'); } catch (_) { /* gia' uscito */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(extras, [], `server di test inatteso: ${extras.join(',')}`);
  const after = serverPids();
  assert.ok(after.includes(String(LIVE_SERVER_PID)), 'il server vivo deve restare');
  for (const pid of after) {
    if (before.includes(pid)) continue;
    let mine = false;
    try { mine = fs.readFileSync(`/proc/${pid}/environ`).includes(root); } catch (_) { mine = false; }
    assert.equal(mine, false, `server residuo sul root di prova: ${pid}`);
  }
});

test('socket policy: relative, empty, absent and absolute TMUX_TMPDIR use the resolver base', async () => {
  assert.equal(fs.existsSync(TMUX_BIN), true);
  const before = serverPids();
  const root = fs.mkdtempSync(path.join('/tmp', 'nc-s6f-sock-'));
  const home = path.join(root, 'home');
  const abs = path.join(root, 'abs');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(abs, { mode: 0o700 });
  const trap = path.join(root, 'trap.sock');
  const label = `nc-s6f-${process.pid}`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const cases = [
    { name: 'relative', extra: { TMUX_TMPDIR: 'run' }, base: '/tmp', kept: undefined },
    { name: 'empty', extra: { TMUX_TMPDIR: '' }, base: '/tmp', kept: undefined },
    { name: 'absent', extra: {}, base: '/tmp', kept: undefined },
    { name: 'absolute', extra: { TMUX_TMPDIR: abs }, base: abs, kept: abs },
  ];
  const extras = [];
  try {
    for (const c of cases) {
      const source = {
        PATH: '/usr/bin:/bin',
        HOME: home,
        LC_ALL: 'C',
        TMUX: `${trap},99999,0`,
        ...c.extra,
      };
      const resolved = sharedTmuxSocketPath(source);
      assert.equal(path.dirname(resolved), path.join(c.base, `tmux-${uid}`), c.name);
      const clientEnv = tmuxClientEnv(source);
      assert.equal(clientEnv.TMUX, undefined, c.name);
      assert.equal(clientEnv.TMUX_TMPDIR, c.kept, c.name);
      assert.equal(source.TMUX, `${trap},99999,0`, c.name);
      const launched = await tmuxExec(TMUX_BIN, ['-L', label, 'has-session', '-t', '=nc-s6f-absent'], {
        env: source, timeoutMs: 5000,
      });
      const attempted = path.join(c.base, `tmux-${uid}`, label);
      assert.ok(
        launched.stderr.includes(`error connecting to ${attempted}`),
        `${c.name}: ${launched.stderr}`,
      );
      assert.equal(launched.stderr.includes(trap), false, c.name);
      assert.equal(fs.existsSync(attempted), false, c.name);
    }
    assert.equal(fs.existsSync(trap), false);
  } finally {
    const mid = serverPids();
    for (const pid of mid) {
      if (before.includes(pid)) continue;
      let mine = false;
      try { mine = fs.readFileSync(`/proc/${pid}/environ`).includes(root); } catch (_) { mine = false; }
      if (!mine) continue;
      extras.push(pid);
      try { process.kill(Number(pid), 'SIGTERM'); } catch (_) { /* gia' uscito */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(extras, []);
  assert.deepEqual(serverPids(), before);
});
