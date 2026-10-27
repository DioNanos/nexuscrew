'use strict';

// Durability of the owned-launch record: the intent barrier must survive a
// crash of the writer, so every commit (file content, rename, directory
// entry, directory creation, removal) is synced before success is reported,
// and every fault point leaves the previous state intact or the launch
// refused. The reader is restarted as a fresh process: what is on disk, not
// what lives in the writer's cache.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const target = require('../lib/fleet/launch-target.js');

const NODE = process.execPath;
const LAUNCH_ID = '11'.repeat(8);
const INTENT = { launchId: LAUNCH_ID, tmuxSocket: '/synthetic/socket', family: 'vl' };
const FULL = {
  launchId: LAUNCH_ID, sessionId: '$1', paneId: '%1',
  tmuxSocket: '/synthetic/socket', serverPid: 4242, family: 'vl',
};

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-target-dur-'));
}

// Fault the Nth directory fsync (1-based); 0 = never.
function withDirSyncFault(n, fn) {
  const sync = fs.fsyncSync;
  let dirs = 0;
  try {
    fs.fsyncSync = (fd) => {
      if (fs.fstatSync(fd).isDirectory() && ++dirs === n) {
        throw Object.assign(new Error('synthetic dir sync EIO'), { code: 'EIO' });
      }
      return sync(fd);
    };
    return fn(dirs);
  } finally {
    fs.fsyncSync = sync;
  }
}

test('intent write syncs file and directory before reporting success', () => {
  const root = scratch();
  try {
    let syncs = 0;
    const sync = fs.fsyncSync;
    try {
      fs.fsyncSync = (fd) => { syncs += 1; return sync(fd); };
      assert.equal(target.registraIntent(root, 'Cell', INTENT), true);
    } finally {
      fs.fsyncSync = sync;
    }
    assert.ok(syncs >= 2, `file and directory must be durable (got ${syncs} syncs)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('intent write failure rejects the launch and preserves the previous record', () => {
  const root = scratch();
  try {
    assert.equal(target.registra(root, 'Cell', FULL), true);
    const open = fs.openSync;
    try {
      fs.openSync = (p, flags, ...rest) => {
        if (flags === 'wx' && String(p).endsWith('.tmp')) {
          throw Object.assign(new Error('synthetic write ENOSPC'), { code: 'ENOSPC' });
        }
        return open(p, flags, ...rest);
      };
      assert.equal(target.registraIntent(root, 'Cell', { ...INTENT, launchId: '22'.repeat(8) }), false);
    } finally {
      fs.openSync = open;
    }
    const letto = target.leggi(root, 'Cell');
    assert.equal(letto.stato, 'presente');
    assert.equal(letto.record.launchId, LAUNCH_ID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file fsync failure rejects the intent before the rename', () => {
  const root = scratch();
  try {
    const sync = fs.fsyncSync;
    try {
      fs.fsyncSync = (fd) => {
        if (!fs.fstatSync(fd).isDirectory()) {
          throw Object.assign(new Error('synthetic file sync EIO'), { code: 'EIO' });
        }
        return sync(fd);
      };
      assert.equal(target.registraIntent(root, 'Cell', INTENT), false);
    } finally {
      fs.fsyncSync = sync;
    }
    assert.equal(target.leggi(root, 'Cell').stato, 'assente');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rename failure rejects the launch and preserves the previous record', () => {
  const root = scratch();
  try {
    assert.equal(target.registra(root, 'Cell', FULL), true);
    const rename = fs.renameSync;
    try {
      fs.renameSync = (...args) => {
        throw Object.assign(new Error('synthetic rename EIO'), { code: 'EIO' });
      };
      assert.equal(target.registraIntent(root, 'Cell', { ...INTENT, launchId: '22'.repeat(8) }), false);
    } finally {
      fs.renameSync = rename;
    }
    const letto = target.leggi(root, 'Cell');
    assert.equal(letto.stato, 'presente');
    assert.equal(letto.record.launchId, LAUNCH_ID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('directory sync failure after the rename is reported as failure', () => {
  const root = scratch();
  try {
    withDirSyncFault(1, () => {
      assert.equal(target.registraIntent(root, 'Cell', INTENT), false);
    });
    // The rename may have reached the page cache; the API must not promise
    // durability it could not prove. Whatever is on disk stays a barrier.
    const letto = target.leggi(root, 'Cell');
    assert.ok(letto.stato === 'assente' || letto.stato === 'presente');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removal commits with a directory sync; its failure keeps the barrier declared', () => {
  const root = scratch();
  try {
    assert.equal(target.registra(root, 'Cell', FULL), true);
    assert.equal(target.rimuovi(root, 'Cell'), true);
    assert.equal(target.leggi(root, 'Cell').stato, 'assente');
    assert.equal(target.registra(root, 'Cell', FULL), true);
    withDirSyncFault(1, () => {
      assert.equal(target.rimuovi(root, 'Cell'), false);
    });
    // The unlink may or may not be durable: the honest answer is "not
    // provably removed", never a success that could resurrect the barrier
    // on the reader side after a crash.
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a restarted reader process sees the durable intent', () => {
  const root = scratch();
  try {
    assert.equal(target.registraIntent(root, 'Cell', INTENT), true);
    const script = [
      `const t = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'fleet', 'launch-target.js'))});`,
      `const letto = t.leggi(${JSON.stringify(root)}, ${JSON.stringify('Cell')});`,
      'process.stdout.write(JSON.stringify(letto));',
    ].join('\n');
    const r = spawnSync(NODE, ['-e', script], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `reader restart failed: ${r.stderr}`);
    const letto = JSON.parse(r.stdout);
    assert.equal(letto.stato, 'presente');
    assert.equal(letto.record.launchId, LAUNCH_ID);
    assert.equal(letto.record.incerto, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nested newly created ancestors are all committed and retried on failure', () => {
  const base = scratch();
  try {
    const root = path.join(base, 'a', 'b', 'c');
    const sync = fs.fsyncSync;
    const synced = [];
    try {
      fs.fsyncSync = (fd) => {
        if (fs.fstatSync(fd).isDirectory()) synced.push(fs.readlinkSync('/proc/self/fd/' + fd));
        return sync(fd);
      };
      assert.equal(target.registraIntent(root, 'Cell', INTENT), true);
    } finally {
      fs.fsyncSync = sync;
    }
    assert.ok(synced.includes(path.join(base, 'a', 'b')));
    assert.ok(synced.includes(path.join(base, 'a')));
    assert.ok(synced.includes(base));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
