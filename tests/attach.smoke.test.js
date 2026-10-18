const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { openAttach } = require('../lib/pty/attach.js');
const { loadPty } = require('../lib/pty/provider.js');
const { runAction } = require('../lib/tmux/actions.js');
const { avviaTmuxTest } = require('./tmux-test-server.js');

// Skip CONTATO quando il PTY prebuilt non c'e' (es. CI con --omit=optional):
// un rosso invisibile nel tail non e' un gate, e' rumore.
let ptyAvailable = true;
try { loadPty(); } catch (_) { ptyAvailable = false; }

// Server tmux DI TEST dedicato per l'intero file (socket -L, -f /dev/null,
// chiusura per PID): mai il socket dell'operatore, dentro o fuori harness.
// La sessione di avvio della fabbrica fa anche da sentinella che tiene il
// server vivo per tutto il file: cosi' il ciclo di vita del server non e'
// una race («server exited unexpectedly» all'ultimo kill-session) perche'
// il server esce solo quando lo chiudiamo noi, per PID.
let server;
const S = 'nc_smoke_' + process.pid;

before(async () => {
  server = await avviaTmuxTest();
});
after(() => server.chiudi());

const tmux = (args) => {
  const r = server.runSync(args);
  if (r.code !== 0) throw new Error(`tmux ${args.join(' ')} fallito: ${r.stderr.trim()}`);
  return r.stdout;
};

test('attach streams real tmux bytes and forwards input', { timeout: 15000 }, async (t) => {
  if (!ptyAvailable) return t.skip('no real PTY provider');
  // Use a minimal shell: the user's interactive zsh/theme may still be
  // initializing after the 500 ms settle and swallow the first command.
  tmux(['new-session', '-d', '-s', S, '-x', '80', '-y', '24', 'sh']);
  try {
    const h = openAttach(S, { cols: 80, rows: 24, tmuxBin: server.wrapper() });
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
    tmux(['kill-session', '-t', S]);
  }
});

// Gate "segue il focus": con window-size latest il
// client USATO piu' di recente comanda la geometria. Un client piccolo puo'
// restringere la finestra mentre lo usi, ma tornare a usare il client grande
// DEVE riportarla grande. (Sostituisce il vecchio gate ignore-size.)
test('window-size latest: usare di nuovo il client grande riporta la size grande', { timeout: 15000 }, async (t) => {
  if (!ptyAvailable) return t.skip('no real PTY provider');
  const wsz = () => tmux(['display-message', '-p', '-t', S, '#{window_width}x#{window_height}']).trim();
  tmux(['new-session', '-d', '-s', S, '-x', '100', '-y', '30']);
  tmux(['set-option', '-t', `=${S}:`, 'window-size', 'latest']);
  try {
    const big = openAttach(S, { cols: 100, rows: 30, tmuxBin: server.wrapper() });
    await new Promise((r) => setTimeout(r, 400));
    big.write(' ');                                        // attivita' sul grande
    await new Promise((r) => setTimeout(r, 400));
    const bigSize = wsz();                                 // riferimento (status bar inclusa)
    const small = openAttach(S, { cols: 40, rows: 10, tmuxBin: server.wrapper() });
    await new Promise((r) => setTimeout(r, 300));
    small.write(' ');                                      // il piccolo prende il focus
    await new Promise((r) => setTimeout(r, 600));
    const shrunk = wsz();
    big.write(' ');                                        // torno sul grande
    await new Promise((r) => setTimeout(r, 800));
    const back = wsz();
    small.kill(); big.kill();
    assert.notStrictEqual(shrunk, bigSize, 'il client piccolo attivo deve restringere');
    assert.strictEqual(back, bigSize, `focus non ripristina la size: grande=${bigSize}, piccolo=${shrunk}, dopo=${back}`);
  } finally {
    tmux(['kill-session', '-t', S]);
  }
});

// --- Size policy deck (§5b): tile grid/deck = ignore-size, owner = focus ---
// Sessioni con nome unico prefissato nxc-b3-test-, kill garantito in cleanup.
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Due attach deck concorrenti (takeSize:false → ignore-size) sulla STESSA sessione
// NON devono contendere la geometria: la finestra resta di dimensione dell'owner.
test('size policy: due deck ignore-size non restringono la sessione', { timeout: 15000 }, async (t) => {
  if (!ptyAvailable) return t.skip('no real PTY provider');
  const S = 'nxc-b3-test-noncontend-' + process.pid;
  tmux(['new-session', '-d', '-s', S, '-x', '120', '-y', '40']);
  tmux(['set-option', '-t', `=${S}:`, 'window-size', 'latest']);
  try {
    const owner = openAttach(S, { takeSize: true, cols: 100, rows: 30, tmuxBin: server.wrapper() });
    await settle(400); owner.write(' '); await settle(400);
    const ownedSize = tmux(['display-message', '-p', '-t', S, '#{window_width}x#{window_height}']).trim();
    const deck1 = openAttach(S, { takeSize: false, cols: 40, rows: 12, tmuxBin: server.wrapper() });
    const deck2 = openAttach(S, { takeSize: false, cols: 50, rows: 14, tmuxBin: server.wrapper() });
    await settle(300); deck1.write(' '); deck2.write(' '); await settle(600);
    const afterDecks = tmux(['display-message', '-p', '-t', S, '#{window_width}x#{window_height}']).trim();
    owner.kill(); deck1.kill(); deck2.kill();
    assert.strictEqual(afterDecks, ownedSize,
      `i deck ignore-size hanno mosso la geometria: owner=${ownedSize} dopo=${afterDecks}`);
  } finally {
    tmux(['kill-session', '-t', S]);
  }
});

// Promozione runtime del size-owner via focus: promote() (=refresh-client -f
// '!ignore-size') rende owner il tile col focus; spostare il focus (demote+promote)
// sposta la geometria. Verifica reale della transizione size-owner (§7 advisory b).
test('size policy: il focus promuove il size-owner (transizione stabile)', { timeout: 15000 }, async (t) => {
  if (!ptyAvailable) return t.skip('no real PTY provider');
  const S = 'nxc-b3-test-focus-' + process.pid;
  tmux(['new-session', '-d', '-s', S, '-x', '120', '-y', '40']);
  tmux(['set-option', '-t', `=${S}:`, 'window-size', 'latest']);
  try {
    const a = openAttach(S, { takeSize: false, cols: 100, rows: 30, tmuxBin: server.wrapper() }); // deck A (ignore-size)
    const b = openAttach(S, { takeSize: false, cols: 40, rows: 12, tmuxBin: server.wrapper() });  // deck B (ignore-size)
    await settle(400); a.write(' '); b.write(' '); await settle(400);
    a.promote(); a.write(' '); await settle(700);
    const ownerA = tmux(['display-message', '-p', '-t', S, '#{window_width}x#{window_height}']).trim();
    a.demote(); b.promote(); b.write(' '); await settle(700);
    const ownerB = tmux(['display-message', '-p', '-t', S, '#{window_width}x#{window_height}']).trim();
    a.kill(); b.kill();
    assert.strictEqual(ownerA, '100x29', `focus A non possiede la geometria: ${ownerA}`);
    assert.strictEqual(ownerB, '40x11', `focus B non ha spostato la geometria: ${ownerB}`);
  } finally {
    tmux(['kill-session', '-t', S]);
  }
});

// Gate: the server-side window nav actually changes window
// (where `M-p` as a key sequence inside the PTY would fail).
test('server-side prev-window action changes the active window', { timeout: 10000 }, async (t) => {
  if (!ptyAvailable) return t.skip('no real PTY provider');
  const winIdx = () => tmux(['display-message', '-p', '-t', S, '#{window_index}']).trim();
  tmux(['new-session', '-d', '-s', S, '-x', '80', '-y', '24']);
  try {
    tmux(['new-window', '-t', S]);   // crea 2a window, diventa attiva
    const before = winIdx();
    assert.strictEqual(runAction(server.wrapper(), S, 'prev-window'), true);
    await new Promise((r) => setTimeout(r, 300));
    const after = winIdx();
    assert.notStrictEqual(after, before, `prev-window non ha cambiato finestra: ${before} -> ${after}`);
  } finally {
    tmux(['kill-session', '-t', S]);
  }
});
