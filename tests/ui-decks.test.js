'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = (file) => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', file), 'utf8');

test('deck navigation flushes dirty state before switching or renaming', () => {
  const hook = src('hooks/useDecks.js');
  const rename = hook.slice(hook.indexOf('const rename = async'), hook.indexOf('const remove = async'));
  const select = hook.slice(hook.indexOf('const select = async'), hook.indexOf('return { decks:'));
  assert.ok(rename.indexOf('await saveNow(fromId)') < rename.indexOf('await renameDeck('));
  assert.match(rename, /if \(!savedDirty\) throw/);
  assert.ok(select.indexOf('await saveNow(currentRef.current)') < select.indexOf('const target ='));
  assert.match(select, /if \(!saved\) throw/);
});

test('deck click stays in the current PWA; only detach opens a window', () => {
  const app = src('App.jsx');
  const bar = src('components/DeckBar.jsx');
  assert.match(app, /const nextLayout = await deckStore\.select\(id\)/);
  assert.match(app, /history\.replaceState\(null, '', deckUrl\(target \|\| id, null\)\)/);
  assert.match(bar, /onClick=\{\(\) => navigate\(d\)\}/);
  assert.match(bar, /onClick=\{\(\) => popout\(d\)\}/);
  assert.match(bar, /group\.decks\.map/);
  assert.doesNotMatch(bar, /location\.(?:assign|replace)/);
});

test('every local or remote owner group has its own translated compact new action', () => {
  const app = src('App.jsx');
  const bar = src('components/DeckBar.jsx');
  const hook = src('hooks/useDecks.js');
  assert.match(bar, /setAdding\(group\.key\)/);
  assert.match(bar, />\+ \{t\('new'\)\}<\/button>/);
  assert.doesNotMatch(bar, /@\$\{current\.ownerLabel\}/);
  assert.match(app, /deckStore\.add\(name, ownerId\)/);
  assert.match(hook, /ownerId === LOCAL_OWNER/);
});

test('fleet modal owns keyboard focus and reports errors inside the dialog', () => {
  const fleet = src('components/FleetTab.jsx');
  assert.match(fleet, /event\.key === 'Escape'/);
  assert.match(fleet, /event\.key !== 'Tab'/);
  assert.match(fleet, /previous\.focus\(\{ preventScroll: true \}\)/);
  assert.match(fleet, /role="alert" aria-live="assertive"/);
  assert.match(fleet, /scrollIntoView\(\{ block: 'nearest' \}\)/);
});
