'use strict';
// The guard directory alone is not enough: every ancestor of the pid file up
// to the filesystem root must be qualified with the trust conditions already
// adopted by the product (real directory, not a symlink, owned by root or by
// the current user, not writable by group/others, executable by us). An
// untrusted chain refuses the guard; a trusted chain is re-checked after the
// lock is taken.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guardMod = () => require('../lib/cli/service-guard.js');
const FLOCK = '/usr/bin/flock';
const IMPL = { flockPath: FLOCK, waitSec: '0.3' };

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sga-'));
  t.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });
  return d;
}

function pidPathIn(dir) {
  fs.mkdirSync(path.join(dir, '.nexuscrew'), { mode: 0o700 });
  return path.join(dir, '.nexuscrew', 'nexuscrew.pid');
}

test('guard: trusted ancestor chain acquires', (t) => {
  const home = tmp(t);
  const pidPath = pidPathIn(home);
  const g = guardMod().acquireGuard(pidPath, IMPL);
  assert.equal(g.ok, true);
  try { fs.closeSync(g.fd); } catch (_) {}
});

test('guard: group-writable non-sticky ancestor refuses', (t) => {
  const home = tmp(t);
  fs.chmodSync(home, 0o770);
  t.after(() => { try { fs.chmodSync(home, 0o700); } catch (_) {} });
  const pidPath = pidPathIn(home);
  const g = guardMod().acquireGuard(pidPath, IMPL);
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
});

test('guard: symlinked ancestor refuses', (t) => {
  const base = tmp(t);
  const reale = path.join(base, 'reale');
  const link = path.join(base, 'link');
  fs.mkdirSync(reale, { mode: 0o700 });
  fs.symlinkSync(reale, link);
  const pidPath = pidPathIn(link);
  const g = guardMod().acquireGuard(pidPath, IMPL);
  assert.equal(g.ok, false);
  assert.equal(g.code, 'GUARD_UNSAFE');
});

test('guard: sticky world-writable ancestor (trusted /tmp shape) acquires', (t) => {
  // The product already trusts a sticky, root-owned, world-writable ancestor
  // (the exact shape of /tmp and /data): the guard must admit it.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sgs-'));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {} });
  fs.chmodSync(base, 0o1777);
  fs.mkdirSync(path.join(base, 'cell'), { mode: 0o700 });
  const pidPath = pidPathIn(path.join(base, 'cell'));
  const g = guardMod().acquireGuard(pidPath, IMPL);
  assert.equal(g.ok, true);
  try { fs.closeSync(g.fd); } catch (_) {}
});
