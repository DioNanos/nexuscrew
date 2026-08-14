'use strict';
// Risoluzione eseguibili senza shell: nessun `command -v`, nessuna espansione
// o concatenazione di input. Supporta path assoluti/espliciti e scan di PATH.
const fs = require('node:fs');
const path = require('node:path');

// Il discriminante e' CHI ha fallito, non "c'e' stata un'eccezione" (stessa
// forma gia' corretta in tests/helpers/pi-real-consumer.js, qui nel codice di
// prodotto): ENOENT su statSync/accessSync significa "il path non c'e' qui",
// legittimo, si continua a cercare altrove sul PATH. Ogni altro errore
// (EACCES — permessi sul file O sulla directory che lo contiene, ELOOP —
// symlink circolare, ENOTDIR, EIO) significa "non sono riuscito a
// verificarlo", non "non c'e'".
function probe(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { status: 'absent' };
    fs.accessSync(p, fs.constants.X_OK);
    return { status: 'found', path: p };
  } catch (e) {
    if (e.code === 'ENOENT') return { status: 'absent' };
    return { status: 'blocked', path: p, code: e.code || e.constructor.name, message: e.message };
  }
}

function executable(p) {
  return probe(p).status === 'found';
}

// Risolve `bin` sul PATH riportando anche le entry dove la verifica e'
// fallita per un motivo diverso da "non c'e' qui" — cosi' un chiamante che
// deve spiegare un esito negativo puo' distinguere un'assenza genuina da un
// controllo impossibile (permessi, symlink rotto, directory non
// attraversabile), invece di trattarli come lo stesso "non trovato".
function resolveCommand(bin, env = process.env) {
  if (typeof bin !== 'string' || !bin || bin.includes('\0')) return { found: false, path: null, blocked: [] };
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    const r = probe(bin);
    return r.status === 'found'
      ? { found: true, path: r.path, blocked: [] }
      : { found: false, path: null, blocked: r.status === 'blocked' ? [r] : [] };
  }
  const dirs = String((env && env.PATH) || '').split(path.delimiter).filter(Boolean);
  const blocked = [];
  for (const dir of dirs) {
    const r = probe(path.join(dir, bin));
    if (r.status === 'found') return { found: true, path: r.path, blocked };
    if (r.status === 'blocked') blocked.push(r);
  }
  return { found: false, path: null, blocked };
}

function commandExists(bin, env = process.env) {
  return resolveCommand(bin, env).found;
}

module.exports = { commandExists, resolveCommand };
