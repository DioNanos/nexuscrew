'use strict';
const { loadPty } = require('./provider.js');

// Opens `tmux attach` inside a real PTY, non-destructive for other clients.
// With `window-size latest` + `aggressive-resize on`, a small web client would
// shrink the window for the user's real terminal too. So:
//   default  → `-f ignore-size`  (our client does NOT drive the geometry)
//   takeSize → normal attach      (only when the size should be driven deliberately)
//   readonly → `-f read-only,ignore-size` (note: read-only also limits copy-mode/KeyBar)
function openAttach(session, opts = {}) {
  const { readonly = false, takeSize = false, cols = 80, rows = 24, tmuxBin = 'tmux' } = opts;
  const pty = loadPty();
  const args = ['attach-session', '-t', session];
  if (readonly) args.push('-f', 'read-only,ignore-size');
  else if (!takeSize) args.push('-f', 'ignore-size');
  const term = pty.spawn(tmuxBin, args, {
    name: 'xterm-256color',
    cols, rows,
    cwd: process.env.HOME,
    env: process.env,
  });
  return {
    write: (data) => term.write(data),
    resize: (c, r) => { try { term.resize(c, r); } catch (_) {} },
    onData: (cb) => term.onData(cb),
    onExit: (cb) => term.onExit(cb),
    kill: () => { try { term.kill(); } catch (_) {} },
  };
}
module.exports = { openAttach };
