'use strict';
const { execFile } = require('node:child_process');

// Window/pane navigation must NOT be emulated with client-side prefix keys
// (it depends on each host's bindings, which may be remapped or broken).
// It runs server-side with direct, allowlisted tmux commands on the active session.
const ACTIONS = {
  'prev-window': ['previous-window'],
  'next-window': ['next-window'],
  'pane-left': ['select-pane', '-L'],
  'pane-right': ['select-pane', '-R'],
};

// Pure: ritorna gli arg tmux per un'azione allowlistata, o null.
function actionArgs(name) {
  return Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name].slice() : null;
}

const SCROLL_LINES = 3;

// Scroll della cronologia via copy-mode: 'up' entra in copy-mode (idempotente
// se già dentro) e scorre; con -e il ritorno in fondo ESCE da copy-mode da
// solo, quindi il gesto "trascina giù fino in fondo" riporta al vivo.
function scrollArgs(session, dir) {
  if (typeof session !== 'string') return null;
  if (dir !== 'up' && dir !== 'down') return null;
  const target = `=${session}:`;
  return [
    ['copy-mode', '-e', '-t', target],
    ['send-keys', '-t', target, '-X', '-N', String(SCROLL_LINES), dir === 'up' ? 'scroll-up' : 'scroll-down'],
  ];
}

function runScroll(tmuxBin, session, dir) {
  const steps = scrollArgs(session, dir);
  if (!steps) return false;
  try {
    // send-keys -X vale solo in copy-mode: va in sequenza, non in parallelo.
    execFile(tmuxBin, steps[0], () => { execFile(tmuxBin, steps[1], () => {}); });
    return true;
  } catch (_) { return false; }
}

// Fire-and-forget: esegue l'azione sulla sessione. Target `=name:` (exact-match
// + colon): su tmux 3.4 il bare `=name` fallisce per i comandi pane/window-target.
function runAction(tmuxBin, session, name) {
  if (name === 'scroll-up') return runScroll(tmuxBin, session, 'up');
  if (name === 'scroll-down') return runScroll(tmuxBin, session, 'down');
  const base = actionArgs(name);
  if (!base) return false;
  try { execFile(tmuxBin, [...base, '-t', `=${session}:`], () => {}); return true; }
  catch (_) { return false; }
}

const MAX_PASTE = 4096;

// true se text contiene control char (codici 0x00-0x1f e 0x7f). Espresso via
// charCode invece di regex perche' il write-layer corrompe gli escape backslash
// nel sorgente (v. NOTE in lib/files/store.js).
function hasControlChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

// Digita testo literal nella sessione, SENZA Invio: il '--' protegge testi
// che iniziano con '-'; i control char (inclusi i ritorni a capo CR e LF)
// sono rifiutati a monte così un paste non può mai submitare un prompt.
function pasteArgs(session, text) {
  if (typeof session !== 'string' || typeof text !== 'string') return null;
  if (!text || text.length > MAX_PASTE) return null;
  if (hasControlChar(text)) return null;
  return ['send-keys', '-t', `=${session}:`, '-l', '--', text];
}

// Risolve col VERO esito di tmux (l'exit code), non col solo lancio del
// processo: un target inesistente deve produrre pasted:false, non un falso ok.
function pasteToSession(tmuxBin, session, text) {
  const args = pasteArgs(session, text);
  if (!args) return Promise.resolve(false);
  return new Promise((resolve) => {
    try { execFile(tmuxBin, args, (err) => resolve(!err)); }
    catch (_) { resolve(false); }
  });
}

module.exports = { actionArgs, runAction, ACTIONS, pasteArgs, pasteToSession, scrollArgs };
