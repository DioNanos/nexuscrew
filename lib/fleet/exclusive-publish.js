'use strict';
// Exclusive publication of a complete object under a final name, never
// replacing an existing name.
//
// Preferred path: hard-link a fully written private temporary to the final
// name. A reader then either sees no name or the complete object (atomic
// appearance), and an existing name makes link(2) fail with EEXIST.
//
// Fallback, ONLY when the link call itself fails with one of LINK_DENIED
// (filesystems that deny link(2), e.g. some Android mounts): the final name is
// created with O_CREAT|O_EXCL|O_NOFOLLOW (0600), the bytes are written and
// verified through the same descriptor, synced, and only then made executable
// when asked. This keeps exclusivity and non-overwrite but LOSES atomic
// appearance: until the write completes a reader may observe an empty or
// partial file, and a crash can leave a truncated file under the final name.
// The fallback is therefore not equivalent to link(2). Readers must qualify
// the final object (type, owner, mode, size, content); leftovers fail closed
// and are never repaired or removed here.
//
// No check on the platform name and no process-wide memo: the decision is per
// call, because one mount can allow link(2) while another denies it.
//
// Result: { status, via?, code?, created? }
//   published             via 'link' | 'create'; `created` ({dev, ino}) on
//                         via 'create' names the inode created by this call
//   exists                the final name was already present (untouched)
//   failed-before-create  nothing was created; code is the errno or a label
//   uncertain-after-create the final name was created but a later step failed;
//                          it is left in place and must not be trusted;
//                          `created` ({dev, ino}) names the object this call
//                          created, so that ONLY the creator can later prove
//                          the generation it may clean up
// Never throws; never reports contents.
const fs = require('node:fs');
const path = require('node:path');

const LINK_DENIED = new Set(['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EXDEV']);

function codice(e, predefinito) {
  return e && typeof e.code === 'string' ? e.code : predefinito;
}

function scriviTutto(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off, off);
    if (!(n > 0)) { const e = new Error('short write'); e.code = 'EIO'; throw e; }
    off += n;
  }
}

// Reads the whole object back from an explicit offset zero.
function rileggi(fd, lunghezza) {
  const out = Buffer.alloc(lunghezza);
  let off = 0;
  while (off < lunghezza) {
    const n = fs.readSync(fd, out, off, lunghezza - off, off);
    if (!(n > 0)) { const e = new Error('short read'); e.code = 'EIO'; throw e; }
    off += n;
  }
  const extra = Buffer.alloc(1);
  if (fs.readSync(fd, extra, 0, 1, lunghezza) !== 0) { const e = new Error('longer'); e.code = 'EIO'; throw e; }
  return out;
}

function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function stessaIdentita(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function pubblicaEsclusiva({ src, dest, bytes, executable = false } = {}) {
  if (typeof src !== 'string' || typeof dest !== 'string') {
    return { status: 'failed-before-create', code: 'EINVAL' };
  }
  try {
    fs.linkSync(src, dest);
    return { status: 'published', via: 'link' };
  } catch (e) {
    if (e && e.code === 'EEXIST') return { status: 'exists' };
    if (!e || !LINK_DENIED.has(e.code)) return { status: 'failed-before-create', code: codice(e, 'EIO') };
  }

  // Fallback path: the link call was denied.
  let buf;
  try {
    buf = typeof bytes === 'function' ? bytes() : bytes;
  } catch (e) {
    return { status: 'failed-before-create', code: codice(e, 'EIO') };
  }
  if (!Buffer.isBuffer(buf)) return { status: 'failed-before-create', code: 'EINVAL' };

  const dir = path.dirname(dest);
  let dirPrima;
  try { dirPrima = fs.lstatSync(dir); } catch (e) { return { status: 'failed-before-create', code: codice(e, 'EIO') }; }
  if (!dirPrima.isDirectory() || dirPrima.isSymbolicLink()) return { status: 'failed-before-create', code: 'ENOTDIR' };

  let fd;
  try {
    fd = fs.openSync(dest,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    if (e && e.code === 'EEXIST') return { status: 'exists' };
    return { status: 'failed-before-create', code: codice(e, 'EIO') };
  }

  // From here the final name exists: any failure leaves it in place.
  let creato = null;
  try {
    const st = fs.fstatSync(fd);
    creato = { dev: st.dev, ino: st.ino };
    if (!st.isFile() || st.nlink !== 1
      || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
      throw Object.assign(new Error('unexpected object'), { code: 'EBADF' });
    }
    scriviTutto(fd, buf);
    if (fs.fstatSync(fd).size !== buf.length) throw Object.assign(new Error('size'), { code: 'EIO' });
    if (!rileggi(fd, buf.length).equals(buf)) throw Object.assign(new Error('content'), { code: 'EIO' });
    fs.fsyncSync(fd);
    if (executable) {
      fs.fchmodSync(fd, 0o500);
      fs.fsyncSync(fd);
    }
    fsyncDirectory(dir);
    const dirDopo = fs.lstatSync(dir);
    if (!dirDopo.isDirectory() || !stessaIdentita(dirPrima, dirDopo)) {
      throw Object.assign(new Error('directory changed'), { code: 'ESTALE' });
    }
    const finale = fs.lstatSync(dest);
    const stFd = fs.fstatSync(fd);
    const modoAtteso = executable ? 0o500 : 0o600;
    if (!finale.isFile() || finale.isSymbolicLink() || !stessaIdentita(finale, stFd)
      || (finale.mode & 0o777) !== modoAtteso || finale.nlink !== 1) {
      throw Object.assign(new Error('final name changed'), { code: 'ESTALE' });
    }
    return { status: 'published', via: 'create', created: { dev: stFd.dev, ino: stFd.ino } };
  } catch (e) {
    return creato
      ? { status: 'uncertain-after-create', code: codice(e, 'EIO'), created: creato }
      : { status: 'uncertain-after-create', code: codice(e, 'EIO') };
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* best-effort */ }
  }
}

module.exports = { pubblicaEsclusiva, LINK_DENIED };
