'use strict';
// File exchange per sessione: <root>/<sessione>/{inbox,outbox}.
// Ogni path e' derivato SOLO da input validati: sessione via regex tmux,
// nome file senza separatori. Mai overwrite in inbox.
//
// NOTE: i check su control-char/separatori/backslash usano charCode invece
// di regex con escape (\u00XX, \w, \\) perche' il layer di scrittura del file
// corrompe gli escape backslash. Semantica identica al piano.
const fs = require('node:fs');
const path = require('node:path');

const BOXES = new Set(['inbox', 'outbox']);
// \w === [A-Za-z0-9_]; espanso in letterali per evitare escape nel sorgente.
const SESSION_RE = /^[A-Za-z0-9_.@%:+-]{1,128}$/;
const BS = String.fromCharCode(0x5c); // backslash

function isValidSession(name) {
  return typeof name === 'string' && SESSION_RE.test(name);
}

// Rimuove i control char (0x00-0x1f e 0x7f) — eliminati, non sostituiti.
function stripControl(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c > 0x1f && c !== 0x7f) out += s[i];
  }
  return out;
}

// Sostituisce separatori di path e whitespace con '_' (mai un separatore nel nome).
function replaceSeparators(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    const c = s.charCodeAt(i);
    if (ch === '/' || ch === BS || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) out += '_';
    else out += ch;
  }
  return out;
}

function sanitizeName(name) {
  const base = replaceSeparators(stripControl(path.basename(String(name || ''))));
  // '..' o solo punti -> neutri (mai un nome che il shell interpreta).
  let onlyDots = true;
  for (let i = 0; i < base.length; i += 1) { if (base[i] !== '.') { onlyDots = false; break; } }
  const safe = onlyDots ? '' : base;
  return (safe || 'file').slice(0, 128);
}

function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

function boxDir(root, session, box) {
  if (!isValidSession(session) || !BOXES.has(box)) return null;
  return path.join(root, session, box);
}

function ensureBox(root, session, box) {
  const dir = boxDir(root, session, box);
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveUpload(root, session, buffer, origName, now = new Date()) {
  const dir = ensureBox(root, session, 'inbox');
  if (!dir) return null;
  const base = `${stamp(now)}_${sanitizeName(origName)}`;
  let name = base;
  for (let i = 1; fs.existsSync(path.join(dir, name)); i += 1) name = `${i}-${base}`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, buffer, { flag: 'wx' });
  return { name, path: full, size: buffer.length };
}

function listBox(root, session, box) {
  const dir = boxDir(root, session, box);
  if (!dir) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return []; }
  return entries
    .filter((e) => e.isFile())
    .map((e) => {
      const st = fs.statSync(path.join(dir, e.name));
      return { name: e.name, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// true se il nome contiene separatori/NUL o e' '.'/'..' (guardia anti-traversal).
function isUnsafeName(name) {
  if (name === '.' || name === '..') return true;
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i];
    const c = name.charCodeAt(i);
    if (ch === '/' || ch === BS || c === 0x00) return true;
  }
  return false;
}

function resolveExisting(root, session, box, name) {
  const dir = boxDir(root, session, box);
  if (!dir || typeof name !== 'string' || name === '') return null;
  if (isUnsafeName(name)) return null;
  const full = path.join(dir, name);
  // lstat (non stat): NON segue i symlink. Un symlink ha isFile()=false su lstat,
  // quindi un link nella box che punta fuori NON viene mai servito/scaricato (anti-evasion).
  try { if (!fs.lstatSync(full).isFile()) return null; } catch (_) { return null; }
  return full;
}

function removeFile(root, session, box, name) {
  const full = resolveExisting(root, session, box, name);
  if (!full) return false;
  fs.unlinkSync(full);
  return true;
}

module.exports = {
  isValidSession, sanitizeName, stamp, boxDir, ensureBox,
  saveUpload, listBox, resolveExisting, removeFile, BOXES,
};
