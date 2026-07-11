'use strict';
// Persistenza JSON condivisa dei moduli notify (vapid.json, push.json, asks.json).
// Stesso hardening di lib/settings/routes.js atomicWriteConfig: no-symlink,
// tmp stessa dir con suffisso random -> chmod 0600 -> rename atomico.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Legge un JSON (oggetto) da file segreto. Fail-closed (F4 audit): open
// O_NOFOLLOW + fstat sullo STESSO fd (niente race lstat->open), e un file
// preesistente con symlink, tipo non-regolare, owner inatteso o permessi di
// gruppo/altri viene RIFIUTATO con errore chiaro — mai riparato in silenzio
// (un mode largo su vapid/push/asks significa che il segreto e' gia' esposto:
// deve emergere, non essere nascosto da un chmod automatico).
// Restano NON-errori: file assente ({} — stato iniziale legittimo) e JSON
// malformato ({} — garbage non deve crashare il server, e non e' un leak).
function readJsonSafe(p) {
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    if (e.code === 'ELOOP') {
      throw new Error(`refuse to read ${path.basename(p)}: symlink (atteso file regolare)`);
    }
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`refuse to read ${path.basename(p)}: non e' un file regolare`);
    }
    if (typeof process.getuid === 'function') {
      const uid = process.getuid();
      if (st.uid !== uid && st.uid !== 0) {
        throw new Error(`refuse to read ${path.basename(p)}: owner inatteso (uid ${st.uid})`);
      }
    }
    if ((st.mode & 0o077) !== 0) {
      throw new Error(`refuse to read ${path.basename(p)}: permessi troppo larghi (mode ${(st.mode & 0o777).toString(8)}, atteso 0600)`);
    }
    let obj;
    try { obj = JSON.parse(fs.readFileSync(fd, 'utf8')); }
    catch (_) { return {}; } // garbage JSON: non un problema di sicurezza
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* best-effort */ }
  }
}

// Scrittura atomica 0600. Rifiuta un target symlink preesistente (ENOENT ok).
function atomicWriteJson(p, obj) {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) {
      throw new Error(`refuse to write: ${path.basename(p)} target e' un symlink`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* cleanup best-effort */ }
    throw e;
  }
}

module.exports = { readJsonSafe, atomicWriteJson };
