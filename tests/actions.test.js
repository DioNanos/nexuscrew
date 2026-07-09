const { test } = require('node:test');
const assert = require('node:assert');
const { actionArgs } = require('../lib/tmux/actions.js');

test('actionArgs maps allowlisted actions to tmux args', () => {
  assert.deepStrictEqual(actionArgs('prev-window'), ['previous-window']);
  assert.deepStrictEqual(actionArgs('next-window'), ['next-window']);
  assert.deepStrictEqual(actionArgs('pane-left'), ['select-pane', '-L']);
  assert.deepStrictEqual(actionArgs('pane-right'), ['select-pane', '-R']);
});

test('actionArgs returns null for non-allowlisted names', () => {
  assert.strictEqual(actionArgs('kill-session'), null);
  assert.strictEqual(actionArgs('previous-window; rm -rf'), null);
  assert.strictEqual(actionArgs(''), null);
  assert.strictEqual(actionArgs('__proto__'), null);
});

test('pasteArgs: literal, -- protegge, niente newline/control', () => {
  const { pasteArgs } = require('../lib/tmux/actions.js');
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  // Target '=sess1:' (con colon): su tmux 3.4 il bare '=name' fallisce per i
  // comandi pane-target (send-keys: "can't find pane"), '=name:' funziona.
  assert.deepEqual(
    pasteArgs('sess1', '/home/dag/NexusFiles/sess1/inbox/f.jpg'),
    ['send-keys', '-t', '=sess1:', '-l', '--', '/home/dag/NexusFiles/sess1/inbox/f.jpg'],
  );
  assert.equal(pasteArgs('sess1', 'testo' + NL + 'con invio'), null);
  assert.equal(pasteArgs('sess1', 'testo' + CR + 'cr'), null);
  assert.equal(pasteArgs('sess1', ''), null);
  assert.equal(pasteArgs('sess1', 'x'.repeat(5000)), null);
});

test('pasteToSession: promessa che riflette il vero esito di tmux', async () => {
  const { pasteToSession } = require('../lib/tmux/actions.js');
  assert.equal(await pasteToSession('/bin/true', 'sess1', 'testo ok'), true);
  assert.equal(await pasteToSession('/bin/false', 'sess1', 'testo ok'), false);
  assert.equal(await pasteToSession('/bin/true', 'sess1', ''), false); // args invalidi
});

test('scrollArgs: copy-mode -e + send-keys -X, direzioni valide', () => {
  const { scrollArgs } = require('../lib/tmux/actions.js');
  assert.deepEqual(scrollArgs('sess1', 'up'), [
    ['copy-mode', '-e', '-t', '=sess1:'],
    ['send-keys', '-t', '=sess1:', '-X', '-N', '3', 'scroll-up'],
  ]);
  assert.deepEqual(scrollArgs('sess1', 'down')[1].slice(-1), ['scroll-down']);
  assert.equal(scrollArgs('sess1', 'left'), null);
  assert.equal(scrollArgs(42, 'up'), null);
});

test('runAction: scroll-up/down instradati, allowlist intatta', () => {
  const { runAction } = require('../lib/tmux/actions.js');
  assert.equal(runAction('/bin/true', 'sess1', 'scroll-up'), true);
  assert.equal(runAction('/bin/true', 'sess1', 'scroll-down'), true);
  assert.equal(runAction('/bin/true', 'sess1', 'kill-session'), false);
});
