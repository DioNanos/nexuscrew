'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const aliases = require('../lib/nodes/aliases.js');

function tmpPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, '.nexuscrew', 'node-aliases.json');
}

test('alias store normalizza NFC e conserva instanceId distinti', (t) => {
  const file = tmpPath(t);
  const a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  let store = aliases.emptyStore();
  store = aliases.setAlias(store, a, '  Cafe\u0301  ');
  store = aliases.setAlias(store, b, 'Café');
  aliases.atomicWriteStore(file, store);
  const loaded = aliases.loadStore(file);
  assert.equal(loaded.aliasesByInstanceId[a], 'Café');
  assert.equal(loaded.aliasesByInstanceId[b], 'Café');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['node-aliases.json']);
});

test('alias store rifiuta schema aperto, controlli, limiti e id non validi', () => {
  const id = 'a'.repeat(32);
  assert.equal(aliases.parseStore({ version: 1, aliasesByInstanceId: {}, extra: true }), null);
  assert.equal(aliases.parseStore({ version: 1, aliasesByInstanceId: { [id]: 'A\nB' } }), null);
  assert.equal(aliases.parseStore({ version: 1, aliasesByInstanceId: { bad: 'Phone' } }), null);
  assert.throws(() => aliases.setAlias(aliases.emptyStore(), id, 'x'.repeat(65)), /alias non valido/);
  assert.throws(() => aliases.setAlias(aliases.emptyStore(), id, 'safe\u202Ename'), /alias non valido/);
});

test('alias store rifiuta symlink, file non regolare e permessi non owner-only', (t) => {
  const file = tmpPath(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const target = path.join(path.dirname(file), 'target');
  fs.writeFileSync(target, JSON.stringify(aliases.emptyStore()), { mode: 0o600 });
  fs.symlinkSync(target, file);
  assert.throws(() => aliases.loadStore(file), /regular file/);
  fs.unlinkSync(file);
  fs.writeFileSync(file, JSON.stringify(aliases.emptyStore()), { mode: 0o644 });
  assert.throws(() => aliases.loadStore(file), /permissions/);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => aliases.loadStore(file), /regular file/);
});

test('deleteAlias e store assente sono deterministici', (t) => {
  const file = tmpPath(t);
  const id = 'c'.repeat(32);
  assert.deepEqual(aliases.loadStore(file), aliases.emptyStore());
  let store = aliases.setAlias(aliases.emptyStore(), id, 'Remote Workstation');
  store = aliases.deleteAlias(store, id);
  assert.deepEqual(store, aliases.emptyStore());
});
