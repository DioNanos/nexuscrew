'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sessionsFromPanes, FLEET_PANES_FMT } = require('../lib/tmux/list.js');
const { parsePanes } = require('../lib/tmux/supervisor-pane.js');
const { TMUX_READS_WINDOW_MS, createTmuxReadWindow } = require('../lib/tmux-reads.js');

// Le parti pure del coalescing: la derivazione per-sessione dalle righe
// per-pane e la finestra di condivisione. Il contratto di rete (spawn,
// freschezza end-to-end) sta in sessions-coalescing.test.js: qui si verifica
// la FORMA — che i campi non si spostino, che il pane attivo vinca, che la
// cache non mangi errori.

// 13 campi del formato fleet snapshot: sessione, pane, dead, marcatore,
// attached, windows, created, activity, cmd, visibility, w_active, p_active,
// titolo.
const riga = (over = {}) => {
  const f = ['cell-One', '%1', '0', '', '0', '1', '1718380800', '1751990000', 'node', '', '1', '1', 'Dev'];
  Object.entries(over).forEach(([i, v]) => { f[Number(i)] = v; });
  return f.join('\t');
};

test('sessionsFromPanes: i campi sessione restano al loro posto', () => {
  const [s] = sessionsFromPanes(riga());
  assert.equal(s.name, 'cell-One');
  assert.equal(s.attached, false);
  assert.equal(s.windows, 1);
  assert.equal(s.created, 1718380800);
  assert.equal(s.activity, 1751990000);
  assert.equal(s.cmd, 'node');
  assert.equal(s.technical, false);
  assert.equal(s.paneTitle, 'Dev');
});

test('sessionsFromPanes: una riga per sessione, e vince il pane attivo', () => {
  const raw = [
    riga({ 1: '%1', 2: '1', 3: '1', 10: '0', 11: '0', 12: 'Killed supervisor' }),
    riga({ 1: '%2', 10: '1', 11: '1', 12: 'Dev' }),
  ].join('\n');
  const out = sessionsFromPanes(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].paneTitle, 'Dev');
});

test('sessionsFromPanes: senza marker attivi resta la prima riga del nome', () => {
  const raw = [riga({ 10: '0', 11: '0', 12: 'Prima' }), riga({ 1: '%2', 10: '0', 11: '0', 12: 'Seconda' })].join('\n');
  assert.equal(sessionsFromPanes(raw)[0].paneTitle, 'Prima');
});

test('il formato fleet snapshot non sposta i campi del supervisore: parsePanes resta valido', () => {
  const raw = riga({ 1: '%7', 2: '1', 3: '1' });
  const [pane] = parsePanes(raw);
  assert.equal(pane.session, 'cell-One');
  assert.equal(pane.paneId, '%7');
  assert.equal(pane.dead, true);
  assert.equal(pane.marked, true);
  // Il formato comincia con i quattro campi di PANES_FMT e poi aggiunge i
  // campi sessione: se l'ordine cambiasse, parsePanes leggerebbe i campi
  // sbagliati senza fallire — questo e' il guardiano.
  assert.ok(FLEET_PANES_FMT.startsWith('#{session_name}\t#{pane_id}\t#{pane_dead}\t'));
});

test('createTmuxReadWindow: finestra di coalescing del valore operativo (2 s)', () => {
  assert.equal(TMUX_READS_WINDOW_MS, 2000);
});

test('createTmuxReadWindow: letture vicine e burst condividono un solo giro', async () => {
  let giri = 0;
  const cache = createTmuxReadWindow(async () => { giri += 1; return { giri }; }, 1000);
  const a = cache.read();
  const b = cache.read();
  const c = cache.read();
  assert.deepEqual(await Promise.all([a, b, c]), [{ giri: 1 }, { giri: 1 }, { giri: 1 }]);
  assert.equal(giri, 1);
  assert.equal((await cache.read()).giri, 1);
  assert.equal(giri, 1);
});

test('createTmuxReadWindow: oltre la finestra si rilegge', async () => {
  let giri = 0;
  const cache = createTmuxReadWindow(async () => { giri += 1; return giri; }, 30);
  assert.equal(await cache.read(), 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await cache.read(), 2);
});

test('createTmuxReadWindow: un errore non si cache-a, la prossima lettura riparte', async () => {
  let tentativi = 0;
  const cache = createTmuxReadWindow(async () => {
    tentativi += 1;
    if (tentativi === 1) throw new Error('boom');
    return tentativi;
  }, 1000);
  await assert.rejects(() => cache.read(), /boom/);
  assert.equal(await cache.read(), 2);
});
