'use strict';
// Fake fs for the durability tests of the prompt-outcome record. It wraps the
// REAL fs (files land in a temp directory of the test) and records every call
// in order, tagging the calls the durable write must make; one step at a time
// can be made to fail. Test-only dependency: it is never reachable from the
// product's payload, config or environment.
const fs = require('node:fs');

function fakeDurableFs({ dir, fail = null } = {}) {
  const calls = [];
  const kinds = new Map(); // fd -> 'file' | 'dir'
  const inject = (step) => { const e = new Error(`inject ${step}`); e.code = 'EIO'; throw e; };
  const f = {
    __calls: calls,
    mkdirSync: (...a) => { calls.push(['mkdir', ...a]); return fs.mkdirSync(...a); },
    statSync: (...a) => { calls.push(['stat', ...a]); return fs.statSync(...a); },
    openSync: (p, flags, mode) => {
      calls.push([flags === 'wx' ? 'open-wx' : 'open', p]);
      if (flags === 'wx' && fail === 'open') inject('open');
      const fd = fs.openSync(p, flags, mode);
      kinds.set(fd, p === dir ? 'dir' : 'file');
      return fd;
    },
    writeSync: (fd, ...a) => {
      calls.push(['write', fd]);
      if (kinds.get(fd) === 'file' && fail === 'write') inject('write');
      return fs.writeSync(fd, ...a);
    },
    fsyncSync: (fd) => {
      const kind = kinds.get(fd) || 'file';
      calls.push([`fsync-${kind}`, fd]);
      if ((kind === 'file' && fail === 'fsync') || (kind === 'dir' && fail === 'dirfsync')) inject('fsync');
      return fs.fsyncSync(fd);
    },
    closeSync: (fd) => { calls.push(['close', fd]); return fs.closeSync(fd); },
    renameSync: (...a) => {
      calls.push(['rename', ...a]);
      if (fail === 'rename') inject('rename');
      return fs.renameSync(...a);
    },
    unlinkSync: (...a) => { calls.push(['unlink', ...a]); return fs.unlinkSync(...a); },
  };
  return f;
}

module.exports = { fakeDurableFs };
