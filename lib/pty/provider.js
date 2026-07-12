'use strict';
// Ritorna un oggetto { spawn(file, args, opts) } con un PTY REALE.
// Termux/Android e desktop usano esclusivamente pacchetti prebuilt scriptless.
// `tmux attach` ESIGE un vero tty: il fallback child_process NON è accettabile qui.
let _cached = null;

function providerCandidates({ platform = process.platform, arch = process.arch, env = process.env } = {}) {
  const isTermux = platform === 'android'
    || (env.PREFIX || '').includes('com.termux');
  if (isTermux) return ['@mmmbuto/node-pty-android-arm64'];
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? ['@lydell/node-pty-darwin-arm64']
      : ['@lydell/node-pty-darwin-x64'];
  }
  if (platform === 'linux' && arch === 'arm64') {
    return ['@lydell/node-pty-linux-arm64'];
  }
  return ['@lydell/node-pty-linux-x64'];
}

function loadPty() {
  if (_cached) return _cached;
  const isTermux = process.platform === 'android'
    || (process.env.PREFIX || '').includes('com.termux');
  const candidates = providerCandidates();
  for (const mod of candidates) {
    try {
      const pty = require(mod);
      // Accept ONLY a provider with a complete PTY API; never child_process.
      if (pty && typeof pty.spawn === 'function') {
        const fallbackShell = isTermux && process.env.PREFIX
          ? require('node:path').join(process.env.PREFIX, 'bin', 'sh') : '/bin/sh';
        const t = pty.spawn(process.env.SHELL || fallbackShell, ['-c', 'true'], { cols: 80, rows: 24 });
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
  throw new Error('no real PTY provider available (platform prebuilt missing)');
}
module.exports = { loadPty, providerCandidates };
