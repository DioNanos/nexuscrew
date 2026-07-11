'use strict';
// Risoluzione eseguibili senza shell: nessun `command -v`, nessuna espansione
// o concatenazione di input. Supporta path assoluti/espliciti e scan di PATH.
const fs = require('node:fs');
const path = require('node:path');

function executable(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) { return false; }
}

function commandExists(bin, env = process.env) {
  if (typeof bin !== 'string' || !bin || bin.includes('\0')) return false;
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) return executable(bin);
  return String((env && env.PATH) || '').split(path.delimiter)
    .filter(Boolean)
    .some((dir) => executable(path.join(dir, bin)));
}

module.exports = { commandExists };
