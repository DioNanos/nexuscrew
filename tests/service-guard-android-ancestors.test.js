'use strict';
// Ancestor chain of the guard on the Android layout. The private root of the
// app is attested by the installed runtime path (never by HOME/PREFIX from the
// environment); above it only explicitly qualified platform owners are
// admitted (root / system), never "any owner that is not writable". Below it
// everything is ours, protected, never a symlink. The test simulates the
// Android chain with a fake root and injected owners: no root, no phone.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guardMod = () => require('../lib/cli/service-guard.js');
const FLOCK = '/usr/bin/flock';
// A system uid distinct from ours (on a phone: 1000 vs the app uid).
const SYSTEM = process.getuid() + 7;

function mk(t) {
  const R = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sga-and-')));
  t.after(() => { try { fs.rmSync(R, { recursive: true, force: true }); } catch (_) {} });
  const dirs = [
    ['data', 0o771], ['data/user', 0o711], ['data/user/0', 0o771],
    ['data/user/0/com.termux', 0o700], ['data/user/0/com.termux/files', 0o700],
    ['data/user/0/com.termux/files/usr', 0o700], ['data/user/0/com.termux/files/usr/bin', 0o700],
    ['data/user/0/com.termux/files/home', 0o700], ['data/user/0/com.termux/files/home/.nexuscrew', 0o700],
  ];
  for (const [d, m] of dirs) { fs.mkdirSync(path.join(R, d)); fs.chmodSync(path.join(R, d), m); }
  fs.chmodSync(R, 0o755);
  fs.symlinkSync('user/0', path.join(R, 'data', 'data'));
  const node = path.join(R, 'data/user/0/com.termux/files/usr/bin/node');
  fs.writeFileSync(node, '#!/bin/sh\n', { mode: 0o700 });
  // Platform owners are injected: the real files are all ours.
  const owners = new Map();
  for (const p of ['', 'data', 'data/user', 'data/user/0', 'data/data']) {
    owners.set(path.join(R, p), { uid: SYSTEM, gid: SYSTEM });
  }
  const over = (p, o) => owners.set(path.join(R, p), o);
  const android = () => ({
    fsRoot: R,
    execPath: node,
    systemIds: [0, SYSTEM],
    lstat: (p) => {
      const st = fs.lstatSync(p);
      const o = owners.get(p);
      return o ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, o) : st;
    },
  });
  const pid = (via) => path.join(R, via || 'data/user/0', 'com.termux/files/home/.nexuscrew/nexuscrew.pid');
  const impl = (extra) => ({ flockPath: FLOCK, waitSec: '0.3', android: android(), ...(extra || {}) });
  return { R, owners, over, impl, pid, node };
}

function libera(g) { try { fs.closeSync(g.fd); } catch (_) {} }

test('android chain: system-owned platform ancestors above the attested app root acquire', (t) => {
  const c = mk(t);
  const g = guardMod().acquireGuard(c.pid(), c.impl());
  assert.equal(g.ok, true, JSON.stringify(g));
  libera(g);
});

test('android chain: the /data/data alias resolves to the attested canonical path', (t) => {
  const c = mk(t);
  const g = guardMod().acquireGuard(c.pid('data/data'), c.impl());
  assert.equal(g.ok, true, JSON.stringify(g));
  libera(g);
});

test('android chain: an alias that is not system-owned refuses', (t) => {
  const c = mk(t);
  c.over('data/data', { uid: 4242, gid: 4242 });
  const g = guardMod().acquireGuard(c.pid('data/data'), c.impl());
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
});

test('android chain: a symlink that is not the platform alias refuses', (t) => {
  const c = mk(t);
  const home = path.join(c.R, 'data/user/0/com.termux/files/home');
  const altro = path.join(c.R, 'data/user/0/com.termux/files/altro');
  fs.renameSync(home, altro);
  fs.symlinkSync('altro', home);
  const g = guardMod().acquireGuard(c.pid(), c.impl());
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
});

test('android chain: a platform ancestor owned by an unqualified uid refuses', (t) => {
  const c = mk(t);
  c.over('data/user', { uid: 4242, gid: SYSTEM });
  const g = guardMod().acquireGuard(c.pid(), c.impl());
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
});

test('android chain: a group-writable platform ancestor of an unqualified group refuses', (t) => {
  const c = mk(t);
  c.over('data/user/0', { uid: SYSTEM, gid: 4242 });
  const g = guardMod().acquireGuard(c.pid(), c.impl());
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
});

test('android chain: an other-writable platform ancestor refuses even when system-owned', (t) => {
  const c = mk(t);
  fs.chmodSync(path.join(c.R, 'data/user/0'), 0o773);
  const g = guardMod().acquireGuard(c.pid(), c.impl());
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
});

test('android chain: the app root owned by the system instead of us refuses', (t) => {
  const c = mk(t);
  c.over('data/user/0/com.termux', { uid: SYSTEM, gid: SYSTEM });
  const g = guardMod().acquireGuard(c.pid(), c.impl());
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
});

test('android chain: a system-owned component below the app root refuses', (t) => {
  const c = mk(t);
  c.over('data/user/0/com.termux/files', { uid: SYSTEM, gid: SYSTEM });
  const g = guardMod().acquireGuard(c.pid(), c.impl());
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
});

test('android chain: a runtime that is not under an app root does not widen the rule', (t) => {
  const c = mk(t);
  const fuori = path.join(c.R, 'node-fuori');
  fs.writeFileSync(fuori, '#!/bin/sh\n', { mode: 0o700 });
  const a = { ...c.impl().android, execPath: fuori };
  const g = guardMod().acquireGuard(c.pid(), { flockPath: FLOCK, waitSec: '0.3', android: a });
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
});

test('android chain: a pid file outside the attested app root does not widen the rule', (t) => {
  const c = mk(t);
  const altro = path.join(c.R, 'data/local');
  fs.mkdirSync(altro, { mode: 0o700 });
  fs.mkdirSync(path.join(altro, 'tmp'), { mode: 0o700 });
  const g = guardMod().acquireGuard(path.join(altro, 'tmp', 'x.pid'), c.impl());
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
});

test('guard: an ancestor replaced while the lock is taken refuses (identity re-check)', (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sga-id-')));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {} });
  fs.chmodSync(base, 0o700);
  const cell = path.join(base, 'cell');
  fs.mkdirSync(cell, { mode: 0o700 });
  fs.mkdirSync(path.join(cell, '.nexuscrew'), { mode: 0o700 });
  const pidPath = path.join(cell, '.nexuscrew', 'nexuscrew.pid');
  const g = guardMod().acquireGuard(pidPath, {
    flockPath: FLOCK,
    waitSec: '0.3',
    afterLock: () => {
      // Same name, same mode, new inode: the chain is no longer what was qualified.
      const vecchia = path.join(base, 'cell.old');
      fs.renameSync(cell, vecchia);
      fs.mkdirSync(cell, { mode: 0o700 });
      fs.renameSync(path.join(vecchia, '.nexuscrew'), path.join(cell, '.nexuscrew'));
    },
  });
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
});

// The app root itself (below the attested platform) with the Termux default
// mode 0771: admitted only for the app's own private group (uid==gid), refused
// for any other group shape and for every others-writable mode. The process
// identity is injected through the chain seam: the guard directory and the
// lock keep the real identity of the test runner.
const APP_UID = process.getuid() + 11;      // a private app identity (uid == gid)
const APP_GID = APP_UID;
const OTHER_GID = process.getuid() + 23;    // a group that is not the app's own
const APP_SEGMENTS = [
  'data/user/0/com.termux',
  'data/user/0/com.termux/files',
  'data/user/0/com.termux/files/usr',
  'data/user/0/com.termux/files/usr/bin',
  'data/user/0/com.termux/files/home',
  'data/user/0/com.termux/files/home/.nexuscrew',
];
// The whole app subtree belongs to the injected identity (the fixture files
// are owned by the real runner, the chain qualification sees the seam).
const overApp = (c) => { for (const seg of APP_SEGMENTS) c.over(seg, { uid: APP_UID, gid: APP_GID }); };

test('android chain: a 0771 app ancestor owned by the app private group (uid==gid) acquires', (t) => {
  const c = mk(t);
  overApp(c);
  const files = path.join(c.R, 'data/user/0/com.termux/files');
  fs.chmodSync(files, 0o771);
  c.over('data/user/0/com.termux/files', { uid: APP_UID, gid: APP_GID });
  const g = guardMod().acquireGuard(c.pid(), c.impl({ identity: { uid: APP_UID, gid: APP_GID } }));
  assert.equal(g.ok, true, JSON.stringify(g));
  libera(g);
});

test('android chain: a 0771 app ancestor of a foreign group refuses and names the ancestor', (t) => {
  const c = mk(t);
  overApp(c);
  const files = path.join(c.R, 'data/user/0/com.termux/files');
  fs.chmodSync(files, 0o771);
  c.over('data/user/0/com.termux/files', { uid: APP_UID, gid: OTHER_GID });
  const g = guardMod().acquireGuard(c.pid(), c.impl({ identity: { uid: APP_UID, gid: APP_GID } }));
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
  assert.ok(g.detail && g.detail.path === files, JSON.stringify(g.detail));
  assert.equal(g.detail.mode, '771');
});

test('android chain: the claim error names the rejected ancestor and its mode', (t) => {
  const c = mk(t);
  overApp(c);
  const files = path.join(c.R, 'data/user/0/com.termux/files');
  fs.chmodSync(files, 0o771);
  c.over('data/user/0/com.termux/files', { uid: APP_UID, gid: OTHER_GID });
  let err = null;
  try {
    guardMod().claimService({ pidPath: c.pid(), cmd: 'c', port: 1, guardImpl: c.impl({ identity: { uid: APP_UID, gid: APP_GID } }) });
  } catch (e) { err = e; }
  assert.ok(err, 'must throw');
  assert.equal(err.code, 'GUARD_UNSAFE');
  assert.ok(err.message.includes(`unsafe ancestor ${files} mode 771`), err.message);
  assert.equal(fs.existsSync(c.pid()), false, 'a guard refusal must not create any pidfile');
});

test('android chain: a 0771 app ancestor with the app gid but a process gid != uid refuses', (t) => {
  const c = mk(t);
  overApp(c);
  const files = path.join(c.R, 'data/user/0/com.termux/files');
  fs.chmodSync(files, 0o771);
  c.over('data/user/0/com.termux/files', { uid: APP_UID, gid: APP_GID });
  // The effective gid matches the file group, but it is not the private
  // uid==gid pair: g+w must stay refused.
  const g = guardMod().acquireGuard(c.pid(), c.impl({ identity: { uid: APP_UID, gid: APP_GID + 5 } }));
  assert.equal(g.ok, false, JSON.stringify(g));
  assert.equal(g.code, 'GUARD_UNSAFE');
});

test('android chain: an others-writable app ancestor refuses even with the app private group', (t) => {
  const c = mk(t);
  overApp(c);
  const files = path.join(c.R, 'data/user/0/com.termux/files');
  fs.chmodSync(files, 0o773);
  c.over('data/user/0/com.termux/files', { uid: APP_UID, gid: APP_GID });
  const g = guardMod().acquireGuard(c.pid(), c.impl({ identity: { uid: APP_UID, gid: APP_GID } }));
  assert.equal(g.ok, false, JSON.stringify(g));
  assert.equal(g.code, 'GUARD_UNSAFE');
});
