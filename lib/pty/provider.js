'use strict';
// Ritorna un oggetto { spawn(file, args, opts) } con un PTY REALE.
// Termux/Android → @mmmbuto/node-pty-android-arm64 ; altrove → node-pty upstream.
// `tmux attach` ESIGE un vero tty: il fallback child_process NON è accettabile qui.
let _cached = null;

function loadPty() {
  if (_cached) return _cached;
  const isTermux = process.platform === 'android'
    || (process.env.PREFIX || '').includes('com.termux');
  const candidates = isTermux
    ? ['@mmmbuto/node-pty-android-arm64', 'node-pty']
    : ['node-pty', '@lydell/node-pty-linux-x64', '@mmmbuto/node-pty-android-arm64'];
  for (const mod of candidates) {
    try {
      const pty = require(mod);
      // Accept ONLY a provider with a complete PTY API; never child_process.
      if (pty && typeof pty.spawn === 'function') {
        const t = pty.spawn(process.env.SHELL || '/bin/sh', ['-c', 'true'], { cols: 80, rows: 24 });
        const ok = t && typeof t.write === 'function' && typeof t.onData === 'function'
          && typeof t.resize === 'function' && typeof t.kill === 'function';
        try { t.kill(); } catch (_) {}
        if (ok) {
          if (process.env.NEXUSCREW_DEBUG) console.error(`[pty] provider=${mod}`);
          _cached = pty;
          return pty;
        }
      }
    } catch (_) { /* prova il prossimo */ }
  }
  throw new Error('no real PTY provider available (need node-pty or @mmmbuto/node-pty-android-arm64)');
}
module.exports = { loadPty };
