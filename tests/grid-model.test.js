'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const mod = () => import('../frontend/src/lib/grid-model.js');

test('addTile: nuova colonna, split in colonna, dedup, cap 9', async () => {
  const m = await mod();
  let l = m.emptyLayout();
  l = m.addTile(l, 'a', 'end');
  l = m.addTile(l, 'b', 'end');
  assert.equal(l.columns.length, 2);
  l = m.addTile(l, 'c', { col: 0, row: 1 });          // split sotto 'a'
  assert.deepEqual(l.columns[0].tiles.map((t) => t.session), ['a', 'c']);
  assert.equal(m.addTile(l, 'a', 'end'), l, 'dedup: layout invariato');
  for (const s of ['d','e','f','g','h','i']) l = m.addTile(l, s, 'end');
  assert.equal(m.sessions(l).length, 9);
  assert.equal(m.addTile(l, 'z', 'end'), l, 'cap 9');
});

test('removeTile: colonna vuota sparisce; moveTile atomico', async () => {
  const m = await mod();
  let l = m.emptyLayout();
  l = m.addTile(l, 'a', 'end'); l = m.addTile(l, 'b', 'end');
  l = m.removeTile(l, 'a');
  assert.equal(l.columns.length, 1);
  l = m.addTile(l, 'c', { col: 0, row: 1 });
  l = m.moveTile(l, 'c', { col: 1 });
  assert.deepEqual(l.columns.map((c) => c.tiles.map((t) => t.session)), [['b'], ['c']]);
});

test('resize clamp + normalize ripara garbage', async () => {
  const m = await mod();
  let l = m.addTile(m.emptyLayout(), 'a', 'end');
  l = m.resizeColumn(l, 0, 0.05);
  assert.equal(l.columns[0].width, 0.2);
  assert.deepEqual(m.normalize(null), m.emptyLayout());
  assert.deepEqual(m.normalize({ columns: 'x' }), m.emptyLayout());
  const ok = m.normalize({ columns: [{ width: 2, tiles: [{ session: 'a', height: 1 }] }] });
  assert.equal(ok.columns[0].tiles[0].session, 'a');
});
