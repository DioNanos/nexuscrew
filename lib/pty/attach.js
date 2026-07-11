'use strict';
const { execFile } = require('node:child_process');
const os = require('node:os');
const { loadPty } = require('./provider.js');

// Opens `tmux attach` inside a real PTY, non-destructive for other clients.
//
// Size model (emendamento post-audit §5b — deck multi-finestra): la sessione usa
// `window-size latest` (impostato dal bridge). Un client "possiede" la geometria
// SOLO se NON è `ignore-size`. I tile grid/deck attaccano `ignore-size` (non
// contendono la geometria da N finestre/N ResizeObserver); l'owner è il tile col
// FOCUS, promosso a runtime via `refresh-client -f '!ignore-size'` (demozione col
// flag `ignore-size`). La single-view / gli attach diretti restano owner di
// default (takeSize non specificato → drive).
//   - takeSize esplicito vince sempre (true = owner, false = ignore-size)
//   - readonly ⇒ SEMPRE ignore-size (un viewer non guida mai)
//   - readonly → `-f read-only,ignore-size` (read-only limita anche copy-mode/KeyBar)
function openAttach(session, opts = {}) {
  const { readonly = false, cols = 80, rows = 24, tmuxBin = 'tmux' } = opts;
  const drives = opts.takeSize !== undefined
    ? !!opts.takeSize
    : (opts.ignoreSize !== undefined ? !opts.ignoreSize : true);
  const ignoreSize = readonly || !drives;
  const pty = loadPty();
  const args = ['attach-session', '-t', session];
  const flags = [];
  if (readonly) flags.push('read-only');
  if (ignoreSize) flags.push('ignore-size');
  if (flags.length) args.push('-f', flags.join(','));
  const term = pty.spawn(tmuxBin, args, {
    name: 'xterm-256color',
    cols, rows,
    cwd: process.env.HOME || os.homedir(),
    env: process.env,
  });
  // tty del client tmux (es. /dev/pts/N): identifica QUESTO client per la
  // promozione/demozione runtime del size-owner via `refresh-client -t <tty>`.
  const tty = term.ptsName || term._pty || null;
  const setFlags = (spec) => {
    if (!tty) return;
    try { execFile(tmuxBin, ['refresh-client', '-t', tty, '-f', spec], () => {}); } catch (_) {}
  };
  return {
    tty,
    write: (data) => term.write(data),
    resize: (c, r) => { try { term.resize(c, r); } catch (_) {} },
    onData: (cb) => term.onData(cb),
    onExit: (cb) => term.onExit(cb),
    kill: () => { try { term.kill(); } catch (_) {} },
    // Promozione a size-owner (focus). I readonly non guidano MAI la geometria.
    promote: () => { if (!readonly) setFlags('!ignore-size'); },
    demote: () => setFlags('ignore-size'),
  };
}
module.exports = { openAttach };
