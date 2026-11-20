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

function unixSocketPathsByInode() {
  const byInode = new Map();
  let raw;
  try { raw = fs.readFileSync('/proc/net/unix', 'utf8'); } catch (_) { return byInode; }
  for (const line of raw.split('\n')) {
    const match = line.match(/^\S+:\s+(?:\S+\s+){5}(\d+)\s+(\/.*)$/);
    if (match) byInode.set(match[1], match[2]);
  }
  return byInode;
}

// Seam for the deterministic regressions below: the default reads the real
// /proc, the synthetic one is injected. Same error contract (errno codes) so
// the filter logic is exercised unchanged.
const defaultProcIo = {
  unixSocketTable: () => unixSocketPathsByInode(),
  listFds: (pid) => fs.readdirSync(`/proc/${pid}/fd`),
  readFdLink: (pid, fd) => fs.readlinkSync(`/proc/${pid}/fd/${fd}`),
  readEnviron: (pid) => fs.readFileSync(`/proc/${pid}/environ`),
};

// The fd survey counts ONLY fds that resolve to a unix socket through
// /proc/net/unix. An ordinary file or directory fd under the suite root (a
// logfile, a working directory) is not socket evidence: counting it made a
// non-sibling server disappear from the watched set and silently pass the
// disappearance check.
function pidSocketPaths(pid, inodePaths, io = defaultProcIo) {
  let fds;
  try { fds = io.listFds(pid); } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ESRCH')) return { gone: true, denied: false, paths: [] };
    return { gone: false, denied: true, paths: [] };
  }
  const paths = [];
  let denied = false;
  for (const fd of fds) {
    let target = '';
    try { target = io.readFdLink(pid, fd); } catch (e) {
      if (e && (e.code === 'EACCES' || e.code === 'EPERM')) denied = true;
      continue;
    }
    if (target.startsWith('socket:[') && target.endsWith(']')) {
      const resolved = inodePaths.get(target.slice(8, -1));
      if (resolved) paths.push(resolved);
    }
  }
  return { gone: false, denied, paths };
}

function isUnderDir(candidate, dir) {
  if (!candidate || !dir) return false;
  const base = path.resolve(dir);
  const resolved = path.resolve(candidate);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

function environValue(environ, key) {
  const prefix = `${key}=`;
  for (const entry of environ.toString('utf8').split('\0')) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return '';
}

// The before/after comparison of these tests must not react to tmux servers
// owned by SIBLING test files of the same suite: the isolated runner keeps
// more than one test file in flight under NEXUSCREW_TEST_HOME_ROOT, so a
// server spawned by a sibling can appear or vanish while this test holds its
// survey. Sibling tests that sanitize child environments strip
// NEXUSCREW_TEST_HOME_ROOT before launching tmux, so matching the environment
// marker alone misses them. Recognising a sibling by a socket path or
// TMUX_TMPDIR under the suite root (checked via /proc/<pid>/fd + /proc/net/unix
// and /proc/<pid>/environ), with the NEXUSCREW_TEST_HOME_ROOT marker as
// fallback, catches both marked and sanitized siblings. Everything else stays
// under surveillance: operator servers carry neither a socket nor a variable
// under the suite root, another host user's servers deny /proc inspection
// (kept watched, see below), and servers under this test's ownRoot are
// matched first so they can never be mistaken for siblings. When
// NEXUSCREW_TEST_HOME_ROOT is unset, no sibling filtering runs at all.
// The watched set is computed ONCE, on the before pids, BEFORE the code
// under test runs, and is never re-derived afterwards: re-reading a pid after
// the code under test runs would let a killed server disappear from the
// watched set and pass silently. In the snapshot, unreadable /proc entries
// split by cause: ENOENT/ESRCH means already exited before the window, while
// EACCES/EPERM is another user's server and stays watched.
function surveyedServerPids(pids = serverPids(), ownRoot = '', io = defaultProcIo) {
  const suiteRoot = process.env.NEXUSCREW_TEST_HOME_ROOT;
  const marker = suiteRoot ? `NEXUSCREW_TEST_HOME_ROOT=${suiteRoot}\0` : null;
  const inodePaths = io.unixSocketTable();
  return pids.filter((pid) => {
    const sockInfo = pidSocketPaths(pid, inodePaths, io);
    if (sockInfo.gone) return false;
    let environ = null;
    try { environ = io.readEnviron(pid); } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ESRCH')) return false;
    }
    if (ownRoot && ((environ && environ.includes(ownRoot)) || sockInfo.paths.some((p) => isUnderDir(p, ownRoot)))) {
      return true;
    }
    if (environ === null || sockInfo.denied) return true;
    if (!suiteRoot) return true;
    if (sockInfo.paths.some((p) => isUnderDir(p, suiteRoot))) return false;
    if (isUnderDir(environValue(environ, 'TMUX_TMPDIR'), suiteRoot)) return false;
    return !environ.includes(marker);
  });
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

function liveSockets(pids) {
  const found = [];
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch (_) { continue; }
    for (const fd of fds) {
      let target = '';
      try { target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch (_) { continue; }
      if (target.startsWith('/') && target.includes('tmux')) found.push(target);
    }
  }
  return found;
}

test('socket policy: discordant private TMUX never selects the NexusCrew client', async () => {
  assert.equal(fs.existsSync(TMUX_BIN), true);
  const before = serverPids();
  const live = liveSockets(before);
  const root = fs.mkdtempSync(path.join('/tmp', 'nc-s6c-pol-'));
  const home = path.join(root, 'home');
  const run = path.join(root, 'run');
  const trapDir = path.join(root, 'trap');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(run, { mode: 0o700 });
  fs.mkdirSync(trapDir, { mode: 0o700 });
  // Watched set: one snapshot of the before survey, taken here, before any
  // code under test runs (the directory setup above spawns no tmux server).
  // Filtering the before pids at comparison time instead would drop a server
  // the code under test killed, and the disappearance check could not fail.
  const watched = surveyedServerPids(before, root);
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
  for (const sock of live) assert.notEqual(expected, sock);
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
    for (const sock of live) assert.equal(launched.stderr.includes(sock), false);

    const surfaceEnv = tmuxClientEnv(source);
    assert.equal(surfaceEnv.TMUX, undefined);
    assert.equal(surfaceEnv.TMUX_TMPDIR, run);
    assert.equal(surfaceEnv.TMUX_PANE, '%1');
    assert.equal(source.TMUX, `${trapSock},99999,0`, 'la sorgente non viene mutata');
    const listed = await runRaw(surfaceEnv, ['list-sessions']);
    assert.notEqual(listed.code, 0);
    assert.ok(listed.stderr.includes(`error connecting to ${expected}`), listed.stderr);
    assert.equal(listed.stderr.includes(trapSock), false);
    for (const sock of live) assert.equal(listed.stderr.includes(sock), false);

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
      if (before.includes(pid)) continue;
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
  for (const pid of watched) {
    assert.ok(after.includes(pid), `server preesistente sparito: ${pid}`);
  }
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
  // Watched set: one snapshot of the before survey, taken here, before the
  // code under test runs; the final comparison restricts the after pids to
  // this snapshot instead of re-reading the before environs after the fact.
  const watched = surveyedServerPids(before, root);
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
  const after = serverPids();
  assert.deepEqual(after.filter((pid) => watched.includes(pid)), watched);
});

// ---------------------------------------------------------------------------
// Deterministic regressions for the fd survey, on a synthetic /proc seam.
// No real tmux server is created or signalled here: every /proc read is
// injected through syntheticProcIo, with errno codes preserved so the filter
// logic above runs unchanged. These pin the sibling-evidence contract:
// only unix sockets RESOLVED through /proc/net/unix count, environmental
// criteria and the marker still work, ownRoot wins, the path boundary needs
// a separator, refusals stay watched, vanished pids are dropped, and the
// watched set is a snapshot taken before the code under test runs.
// ---------------------------------------------------------------------------

function setSuiteRoot(value) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'NEXUSCREW_TEST_HOME_ROOT');
  const prev = process.env.NEXUSCREW_TEST_HOME_ROOT;
  if (value === undefined) delete process.env.NEXUSCREW_TEST_HOME_ROOT;
  else process.env.NEXUSCREW_TEST_HOME_ROOT = value;
  return () => {
    if (had) process.env.NEXUSCREW_TEST_HOME_ROOT = prev;
    else delete process.env.NEXUSCREW_TEST_HOME_ROOT;
  };
}

function envBuffer(vars) {
  const entries = [];
  for (const [key, val] of Object.entries(vars)) {
    if (val !== undefined) entries.push(`${key}=${val}`);
  }
  return Buffer.from(`${entries.join('\0')}\0`, 'utf8');
}

function syntheticIoError(code) {
  const err = new Error(`synthetic ${code}`);
  err.code = code;
  return err;
}

// Synthetic /proc: pids maps pid -> { fds, environ }. fds maps an fd number
// to its readlink target ('socket:[<inode>]', a path, a pipe, ...) or to
// { throws: 'EACCES' | 'EPERM' } for one fd, or is itself { throws } when the
// whole listing is refused. environ is a Buffer or { throws } for the refused
// read. A pid removed with forget() reads as ENOENT from then on.
function syntheticProcIo({ pids, unixTable = new Map() }) {
  const live = pids;
  const refusal = (value) => (
    value && typeof value === 'object' && value.throws ? syntheticIoError(value.throws) : null
  );
  return {
    unixSocketTable: () => unixTable,
    listFds: (pid) => {
      const rec = live[pid];
      if (!rec) throw syntheticIoError('ENOENT');
      const err = refusal(rec.fds);
      if (err) throw err;
      return Object.keys(rec.fds);
    },
    readFdLink: (pid, fd) => {
      const err = refusal(live[pid].fds[fd]);
      if (err) throw err;
      return live[pid].fds[fd];
    },
    readEnviron: (pid) => {
      const rec = live[pid];
      if (!rec) throw syntheticIoError('ESRCH');
      const err = refusal(rec.environ);
      if (err) throw err;
      return rec.environ;
    },
    forget: (pid) => { delete live[pid]; },
  };
}

const CLEAN_ENV = { HOME: '/home/other', TMUX_TMPDIR: '/var/other-run' };

test('fd survey: an ordinary fd under the suite root does not hide a non-sibling server', () => {
  const restore = setSuiteRoot('/suite-root');
  try {
    const io = syntheticProcIo({
      unixTable: new Map([['111', '/var/other-run/tmux-1000/outer']]),
      pids: {
        '4242': {
          fds: {
            3: 'socket:[111]',
            4: '/suite-root/logs/server.log',
            5: '/suite-root',
            6: 'pipe:[7]',
            7: 'anon_inode:[eventpoll]',
          },
          environ: envBuffer(CLEAN_ENV),
        },
      },
    });
    assert.deepEqual(surveyedServerPids(['4242'], '', io), ['4242']);
  } finally { restore(); }
});

test('fd survey: a resolved sibling socket excludes the server even without the marker', () => {
  const restore = setSuiteRoot('/suite-root');
  try {
    const io = syntheticProcIo({
      unixTable: new Map([
        ['222', '/suite-root/tmux-1000/sib'],
        ['223', '/var/other-run/tmux-1000/mk'],
      ]),
      pids: {
        '510': {
          fds: { 3: 'socket:[222]' },
          environ: envBuffer(CLEAN_ENV),
        },
        '515': {
          fds: { 3: 'socket:[223]' },
          environ: envBuffer({ ...CLEAN_ENV, NEXUSCREW_TEST_HOME_ROOT: '/suite-root' }),
        },
        '516': {
          fds: { 3: 'pipe:[9]' },
          environ: envBuffer({ HOME: '/home/other', TMUX_TMPDIR: '/suite-root/tmpdir-run' }),
        },
      },
    });
    assert.deepEqual(surveyedServerPids(['510', '515', '516'], '', io), []);
  } finally { restore(); }
});

test('fd survey: ownRoot wins, the boundary needs a separator, missing proof stays watched', () => {
  const restore = setSuiteRoot('/suite-root');
  try {
    const io = syntheticProcIo({
      unixTable: new Map([
        ['222', '/suite-root/tmux-1000/sib'],
        ['225', '/own-root/tmux-1000/mine'],
        ['226', '/suite-root-evil/tmux-1000/evil'],
      ]),
      pids: {
        '511': {
          fds: { 3: 'socket:[222]' },
          environ: envBuffer({ HOME: '/own-root/home', TMUX_TMPDIR: '/var/other-run' }),
        },
        '512': {
          fds: { 3: 'socket:[225]' },
          environ: envBuffer(CLEAN_ENV),
        },
        '513': {
          fds: { 3: 'socket:[226]' },
          environ: envBuffer(CLEAN_ENV),
        },
        '514': {
          fds: { 3: 'socket:[999]', 4: 'pipe:[8]' },
          environ: envBuffer(CLEAN_ENV),
        },
      },
    });
    assert.deepEqual(surveyedServerPids(['511', '512', '513', '514'], '/own-root', io),
      ['511', '512', '513', '514']);
  } finally { restore(); }
});

test('fd survey: injected EACCES and EPERM keep the server watched', () => {
  const restore = setSuiteRoot('/suite-root');
  try {
    const io = syntheticProcIo({
      unixTable: new Map([['111', '/var/other-run/tmux-1000/outer']]),
      pids: {
        '600': { fds: { throws: 'EACCES' }, environ: envBuffer(CLEAN_ENV) },
        '601': { fds: { throws: 'EPERM' }, environ: envBuffer(CLEAN_ENV) },
        '602': { fds: { 3: 'socket:[111]' }, environ: { throws: 'EACCES' } },
        '603': { fds: { 3: 'socket:[111]' }, environ: { throws: 'EPERM' } },
        '604': {
          fds: { 3: 'socket:[111]', 4: { throws: 'EACCES' } },
          environ: envBuffer(CLEAN_ENV),
        },
        '605': {
          fds: { 3: { throws: 'EPERM' }, 4: 'socket:[111]' },
          environ: envBuffer(CLEAN_ENV),
        },
        '606': {
          fds: { throws: 'EACCES' },
          environ: envBuffer({ ...CLEAN_ENV, NEXUSCREW_TEST_HOME_ROOT: '/suite-root' }),
        },
        '607': {
          fds: { throws: 'EPERM' },
          environ: envBuffer({ HOME: '/home/other', TMUX_TMPDIR: '/suite-root/tmpdir-run' }),
        },
        '608': {
          fds: { 3: { throws: 'EACCES' } },
          environ: envBuffer({ ...CLEAN_ENV, NEXUSCREW_TEST_HOME_ROOT: '/suite-root' }),
        },
        '609': {
          fds: { 3: { throws: 'EPERM' } },
          environ: envBuffer({ HOME: '/home/other', TMUX_TMPDIR: '/suite-root/tmpdir-run' }),
        },
      },
    });
    assert.deepEqual(
      surveyedServerPids(['600', '601', '602', '603', '604', '605', '606', '607', '608', '609'], '', io),
      ['600', '601', '602', '603', '604', '605', '606', '607', '608', '609'],
    );
  } finally { restore(); }
});

test('fd survey: ENOENT and ESRCH of the pid are ignored, not watched', () => {
  const restore = setSuiteRoot('/suite-root');
  try {
    const io = syntheticProcIo({
      unixTable: new Map([['111', '/var/other-run/tmux-1000/outer']]),
      pids: {
        '700': { fds: { throws: 'ENOENT' }, environ: envBuffer(CLEAN_ENV) },
        '701': { fds: { throws: 'ESRCH' }, environ: envBuffer(CLEAN_ENV) },
        '702': { fds: { 3: 'socket:[111]' }, environ: { throws: 'ENOENT' } },
        '703': { fds: { 3: 'socket:[111]' }, environ: { throws: 'ESRCH' } },
        '704': { fds: { 3: 'socket:[111]' }, environ: envBuffer(CLEAN_ENV) },
      },
    });
    assert.deepEqual(surveyedServerPids(['700', '701', '702', '703', '704'], '', io), ['704']);
  } finally { restore(); }
});

test('fd survey: without NEXUSCREW_TEST_HOME_ROOT no sibling exclusion runs', () => {
  const restore = setSuiteRoot(undefined);
  try {
    const io = syntheticProcIo({
      unixTable: new Map([['227', '/suite-root/tmux-1000/any']]),
      pids: {
        '800': {
          fds: { 3: 'socket:[227]' },
          environ: envBuffer(CLEAN_ENV),
        },
        '801': {
          fds: { 3: 'pipe:[9]' },
          environ: envBuffer({ ...CLEAN_ENV, NEXUSCREW_TEST_HOME_ROOT: '/suite-root' }),
        },
        '802': {
          fds: { 3: 'pipe:[10]' },
          environ: envBuffer({ HOME: '/home/other', TMUX_TMPDIR: '/suite-root/tmpdir-run' }),
        },
      },
    });
    assert.deepEqual(surveyedServerPids(['800', '801', '802'], '', io), ['800', '801', '802']);
  } finally { restore(); }
});

test('fd survey: a server vanishing after the snapshot stays flagged in both assertion forms', () => {
  const restore = setSuiteRoot('/suite-root');
  const io = syntheticProcIo({
    unixTable: new Map([
      ['31', '/var/other-run/tmux-1000/outer-a'],
      ['32', '/var/other-run/tmux-1000/outer-b'],
    ]),
    pids: {
      '100': { fds: { 3: 'socket:[31]' }, environ: envBuffer(CLEAN_ENV) },
      '4242': { fds: { 3: 'socket:[32]' }, environ: envBuffer(CLEAN_ENV) },
    },
  });
  try {
    const before = ['100', '4242'];
    // Watched set: one snapshot of the before survey, taken here, BEFORE the
    // code under test runs. Re-deriving it after the fact would let the
    // vanished pid slip out of the watched set and hide the disappearance.
    const watched = surveyedServerPids(before, '', io);
    assert.deepEqual(watched, ['100', '4242']);
    // The code under test runs and the non-sibling 4242 exits: its /proc
    // entries now read as ENOENT.
    io.forget('4242');
    const after = ['100'];
    // Membership form, as in the first policy test above.
    const missing = watched.filter((pid) => !after.includes(pid));
    assert.deepEqual(missing, ['4242'], 'the vanished server must be flagged');
    // deepEqual form, as in the second policy test above.
    assert.notDeepEqual(after.filter((pid) => watched.includes(pid)), watched);
  } finally { restore(); }
});
