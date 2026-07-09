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

test('dropForQuadrant: mapping direzionale + invalidi', async () => {
  const m = await mod();
  let l = m.emptyLayout();
  l = m.addTile(l, 'a', 'end'); l = m.addTile(l, 'b', { col: 0, row: 1 });
  assert.deepEqual(m.dropForQuadrant(l, 0, 0, 'left'), { col: 0 });
  assert.deepEqual(m.dropForQuadrant(l, 0, 0, 'right'), { col: 1 });
  assert.deepEqual(m.dropForQuadrant(l, 0, 1, 'top'), { col: 0, row: 1 });
  assert.deepEqual(m.dropForQuadrant(l, 0, 1, 'bottom'), { col: 0, row: 2 });
  assert.equal(m.dropForQuadrant(l, 9, 0, 'left'), null);
  assert.equal(m.dropForQuadrant(l, 0, 0, 'diag'), null);
});

test('equalize / toGrid2x2 / toColumns', async () => {
  const m = await mod();
  let l = m.emptyLayout();
  for (const s of ['a','b','c','d','e']) l = m.addTile(l, s, 'end');
  l = m.resizeColumn(l, 0, 3);
  assert.ok(m.equalize(l).columns.every((c) => c.width === 1));
  const g = m.toGrid2x2(l);
  assert.equal(g.columns.length, 2);
  assert.deepEqual(g.columns.map((c) => c.tiles.length), [3, 2]);
  assert.deepEqual(m.sessions(g), ['a','b','c','d','e']);
  const cols = m.toColumns(l);
  assert.equal(cols.columns.length, 5);
  assert.deepEqual(m.toGrid2x2(m.emptyLayout()), m.emptyLayout());
});

test('snapFraction: scatta a 25/50/75 entro tolleranza', async () => {
  const m = await mod();
  assert.equal(m.snapFraction(0.51), 0.5);
  assert.equal(m.snapFraction(0.27), 0.25);
  assert.equal(m.snapFraction(0.60), 0.60);
});

test('addTileSmart: crescita bilanciata a griglia (~sqrt)', async () => {
  const m = await mod();
  let l = m.emptyLayout();
  l = m.addTileSmart(l, 'a');                     // 1 -> [[a]]
  assert.deepEqual(l.columns.map((c) => c.tiles.length), [1]);
  l = m.addTileSmart(l, 'b');                     // 2 -> [[a],[b]]
  assert.deepEqual(l.columns.map((c) => c.tiles.length), [1, 1]);
  l = m.addTileSmart(l, 'c');                     // 3 -> [[a,c],[b]]
  assert.deepEqual(l.columns.map((c) => c.tiles.length), [2, 1]);
  l = m.addTileSmart(l, 'd');                     // 4 -> 2x2
  assert.deepEqual(l.columns.map((c) => c.tiles.length), [2, 2]);
  l = m.addTileSmart(l, 'e');                     // 5 -> terza colonna
  assert.deepEqual(l.columns.map((c) => c.tiles.length), [2, 2, 1]);
  assert.equal(m.addTileSmart(l, 'a'), l, 'dedup');
});

test('cap 9: normalize tronca layout corrotti, preset non superano il cap', async () => {
  const m = await mod();
  const fat = { columns: Array.from({ length: 11 }, (_, i) => ({ width: 1, tiles: [{ session: `s${i}`, height: 1 }] })) };
  const n = m.normalize(fat);
  assert.equal(m.sessions(n).length, 9, 'normalize applica il cap');
  assert.ok(m.sessions(m.toGrid2x2(n)).length <= 9);
  assert.ok(m.sessions(m.toColumns(n)).length <= 9);
  // preset direttamente sul layout CORROTTO (senza passare da normalize)
  assert.equal(m.sessions(m.toGrid2x2(fat)).length, 9, 'toGrid2x2 cap diretto');
  assert.equal(m.sessions(m.toColumns(fat)).length, 9, 'toColumns cap diretto');
});
