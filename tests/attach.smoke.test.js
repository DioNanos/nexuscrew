const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { openAttach } = require('../lib/pty/attach.js');
const { runAction } = require('../lib/tmux/actions.js');

const S = 'nc_smoke_' + process.pid;

test('attach streams real tmux bytes and forwards input', { timeout: 15000 }, async () => {
  execFileSync('tmux', ['new-session', '-d', '-s', S, '-x', '80', '-y', '24']);
  try {
    const h = openAttach(S, { cols: 80, rows: 24 });
    let buf = '';
    const got = new Promise((resolve) => {
      h.onData((d) => { buf += d; if (buf.includes('NEXUSOK')) resolve(); });
    });
    await new Promise((r) => setTimeout(r, 500));   // lascia disegnare tmux
    h.write("printf 'NEXUS''OK\\n'\n");              // split evita match dell'eco comando
    await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no NEXUSOK in stream')), 8000))]);
    assert.ok(buf.includes('NEXUSOK'));
    h.kill();
  } finally {
    execFileSync('tmux', ['kill-session', '-t', S]);
  }
});

// Gate: a small default attach must NOT shrink the window for the real terminal.
test('default attach (ignore-size) does NOT resize a session held by another client', { timeout: 15000 }, async () => {
  const wsz = () => execFileSync('tmux',
    ['display-message', '-p', '-t', S, '#{window_width}x#{window_height}']).toString().trim();
  execFileSync('tmux', ['new-session', '-d', '-s', S, '-x', '100', '-y', '30']);
  try {
    const big = openAttach(S, { cols: 100, rows: 30, takeSize: true }); // real terminal holding the geometry
    await new Promise((r) => setTimeout(r, 400));
    const before = wsz();
    const small = openAttach(S, { cols: 40, rows: 10 });          // client piccolo, default ignore-size
    await new Promise((r) => setTimeout(r, 600));
    const after = wsz();
    small.kill(); big.kill();
    assert.strictEqual(after, before, `ignore-size violato: ${before} -> ${after}`);
  } finally {
    execFileSync('tmux', ['kill-session', '-t', S]);
  }
});

// Gate: the server-side window nav actually changes window
// (where `M-p` as a key sequence inside the PTY would fail).
test('server-side prev-window action changes the active window', { timeout: 10000 }, async () => {
  const winIdx = () => execFileSync('tmux',
    ['display-message', '-p', '-t', S, '#{window_index}']).toString().trim();
  execFileSync('tmux', ['new-session', '-d', '-s', S, '-x', '80', '-y', '24']);
  try {
    execFileSync('tmux', ['new-window', '-t', S]);   // crea 2a window, diventa attiva
    const before = winIdx();
    assert.strictEqual(runAction('tmux', S, 'prev-window'), true);
    await new Promise((r) => setTimeout(r, 300));
    const after = winIdx();
    assert.notStrictEqual(after, before, `prev-window non ha cambiato finestra: ${before} -> ${after}`);
  } finally {
    execFileSync('tmux', ['kill-session', '-t', S]);
  }
});
