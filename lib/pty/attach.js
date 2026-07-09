'use strict';
const { loadPty } = require('./provider.js');

// Opens `tmux attach` inside a real PTY, non-destructive for other clients.
// Size model (decisione DAG 2026-07-09, "segue il focus"): la sessione usa
// `window-size latest` (impostato dal bridge) e i client web NON readonly
// PARTECIPANO alla geometria — chi è attivo per ultimo comanda. Tornare sul
// desktop e digitare riporta la sessione grande; il telefono la restringe
// solo mentre lo usi. I viewer readonly restano ignore-size (mai guidare).
//   readonly → `-f read-only,ignore-size` (read-only limita anche copy-mode/KeyBar)
function openAttach(session, opts = {}) {
  const { readonly = false, takeSize = false, cols = 80, rows = 24, tmuxBin = 'tmux' } = opts;
  const pty = loadPty();
  const args = ['attach-session', '-t', session];
  if (readonly) args.push('-f', 'read-only,ignore-size');
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
