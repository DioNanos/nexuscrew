'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Exclusive create + anti-symlink. [M4]
// - file esistente non-vuoto (lstat, NO follow symlink) -> preserva (mai overwrite)
// - symlink path -> reject
// - file vuoto -> unlink + ricrea exclusive (wx)
// - race con altro processo (EEXIST) -> leggi il token dell'altro
// Legge un token esistente in modo safe (lstat no-follow, reject symlink, regular file).
// Usato sia dal path iniziale che dal ramo EEXIST (race symlink-safe). [M2]
function readTokenSafe(tokenPath) {
  const st = fs.lstatSync(tokenPath); // lstat: no follow symlink
  if (st.isSymbolicLink()) {
    throw new Error(`refusing symlink token path: ${tokenPath}`);
  }
  if (st.isFile()) {
    const t = fs.readFileSync(tokenPath, 'utf8').trim();
    return t || null;
  }
  return null;
}

function loadOrCreateToken(tokenPath) {
  try {
    const st = fs.lstatSync(tokenPath); // lstat: no follow symlink
    if (st.isSymbolicLink()) {
      throw new Error(`refusing symlink token path: ${tokenPath}`);
    }
    if (st.isFile()) {
      const t = fs.readFileSync(tokenPath, 'utf8').trim();
      if (t) return t; // preserva esistente valido
      fs.unlinkSync(tokenPath); // file vuoto: ricrea exclusive
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // symlink/permessi/altro -> propaga
    // ENOENT: non esiste, crea sotto
  }
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  const tok = crypto.randomBytes(24).toString('base64url');
  try {
    fs.writeFileSync(tokenPath, tok + '\n', { flag: 'wx', mode: 0o600 }); // exclusive create
  } catch (e) {
    if (e.code === 'EEXIST') {
      // un altro processo ha creato nel frattempo: re-validate no-follow (race symlink-safe, M2)
      const t = readTokenSafe(tokenPath);
      if (t) return t;
    }
    throw e;
  }
  fs.chmodSync(tokenPath, 0o600);
  return tok;
}

// Rotazione token: genera un NUOVO segreto e sostituisce il file in modo ATOMICO
// (tmp stessa dir -> chmod 0600 -> rename), no-follow symlink. [A2 §4b(3)]
// A differenza di loadOrCreateToken NON preserva l'esistente: overwrite voluto.
// L'invalidazione reale delle sessioni attive la fa il chiamante (restart service:
// il server carica il token solo allo startup). Ritorna il nuovo token (il chiamante
// NON deve stamparlo: si usa `nexuscrew show token`).
function rotateToken(tokenPath) {
  // reject symlink target preesistente (no-follow), ENOENT ok (nuovo file)
  try {
    const st = fs.lstatSync(tokenPath);
    if (st.isSymbolicLink()) {
      throw new Error(`refusing symlink token path: ${tokenPath}`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  const tok = crypto.randomBytes(24).toString('base64url');
  const tmp = tokenPath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, tok + '\n', { flag: 'wx', mode: 0o600 }); // exclusive temp
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, tokenPath); // atomic replace
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {} // cleanup temp su failure
    throw e;
  }
  return tok;
}

function verify(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { loadOrCreateToken, readTokenSafe, rotateToken, verify };
