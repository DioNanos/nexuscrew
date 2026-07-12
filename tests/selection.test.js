'use strict';
// tests/selection.test.js — gesto "forza selezione locale" (fix copia Mac) e
// shortcut di copia. Logica pura (lib/selection.js) testabile in Node: un TUI con
// mouse reporting (tmux) cattura i drag; Shift (con o senza Control) deve avviare
// la selezione locale, e Cmd+C / Ctrl+Shift+C devono essere riconosciuti come copy.
const { test } = require('node:test');
const assert = require('node:assert');
const sel = () => import('../frontend/src/lib/selection.js');

test('wantsLocalSelection: Shift (solo o con Control/Alt) avvia la selezione locale', async () => {
  const { wantsLocalSelection } = await sel();
  assert.equal(wantsLocalSelection({ shiftKey: true }), true, 'Shift da solo (standard xterm)');
  assert.equal(wantsLocalSelection({ shiftKey: true, ctrlKey: true }), true, 'Shift+Control (iTerm-like Mac)');
  assert.equal(wantsLocalSelection({ shiftKey: true, altKey: true }), true);
});

test('wantsLocalSelection: senza Shift non triggera (Control/Alt soli = shortcut TUI)', async () => {
  const { wantsLocalSelection } = await sel();
  assert.equal(wantsLocalSelection({ ctrlKey: true }), false);
  assert.equal(wantsLocalSelection({ altKey: true }), false);
  assert.equal(wantsLocalSelection({}), false);
  assert.equal(wantsLocalSelection(null), false);
  assert.equal(wantsLocalSelection(undefined), false);
});

test('isCopyShortcut: Cmd+C (Mac) e Ctrl+Shift+C (X11) riconosciuti', async () => {
  const { isCopyShortcut } = await sel();
  assert.equal(isCopyShortcut({ metaKey: true, key: 'c' }), true, 'Cmd+C');
  assert.equal(isCopyShortcut({ ctrlKey: true, shiftKey: true, key: 'c' }), true, 'Ctrl+Shift+C');
  assert.equal(isCopyShortcut({ metaKey: true, key: 'C' }), true, 'case-insensitive');
});

test('isCopyShortcut: Ctrl+C senza Shift NON e\' copy (e\' interrupt della shell)', async () => {
  const { isCopyShortcut } = await sel();
  assert.equal(isCopyShortcut({ ctrlKey: true, key: 'c' }), false, 'Ctrl+C nudo passa alla TUI');
  assert.equal(isCopyShortcut({ metaKey: true, key: 'v' }), false, 'Cmd+V non e\' copy');
  assert.equal(isCopyShortcut({ key: 'c' }), false);
  assert.equal(isCopyShortcut(null), false);
});

test('long press touch: piccoli tremori non cancellano, drag/scroll sì', async () => {
  const { LONG_PRESS_MS, movedBeyondLongPress } = await sel();
  assert.equal(LONG_PRESS_MS, 450);
  assert.equal(movedBeyondLongPress(100, 100, 105, 107), false);
  assert.equal(movedBeyondLongPress(100, 100, 109, 100), true);
  assert.equal(movedBeyondLongPress(100, 100, 100, 91), true);
});
