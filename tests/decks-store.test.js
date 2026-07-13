'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/decks/store.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ncdeck-'));
const layout = { columns: [{ width: 1, tiles: [{ session: 'dev', height: 1, fontSize: 11 }] }] };

test('decks store: create 0600, round-trip e layout strict', () => {
  const dir = tmp(); const p = path.join(dir, 'decks.json');
  const st = store.loadOrCreate(p);
  assert.equal(st.decks[0].name, 'main');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  st.decks[0].layout = layout; st.decks[0].revision = 1;
  store.atomicWrite(p, st);
  assert.deepEqual(store.loadStore(p).decks[0].layout, layout);
  assert.equal(store.parseLayout({ columns: [{ width: 1, tiles: Array(10).fill({ session: 'x', height: 1, fontSize: 11 }) }] }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('decks store: rifiuta symlink target e duplicati', () => {
  const dir = tmp(); const real = path.join(dir, 'real'); const p = path.join(dir, 'decks.json');
  fs.writeFileSync(real, '{}'); fs.symlinkSync(real, p);
  assert.throws(() => store.atomicWrite(p, store.emptyStore()), /symlink/);
  const bad = store.emptyStore(); bad.decks.push({ ...bad.decks[0] });
  assert.equal(store.parseStore(bad), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('decks store persists strict multi-hop routes and rejects route cycles', () => {
  const ownerA = 'a'.repeat(32); const ownerB = 'b'.repeat(32);
  const multi = { columns: [{ width: 1, tiles: [
    { session: 'work', node: 'relay/phone', ownerId: ownerA, height: 1, fontSize: 11 },
    { session: 'work', node: 'relay/mac', ownerId: ownerB, height: 1, fontSize: 11 },
  ] }] };
  assert.deepEqual(store.parseLayout(multi), multi);
  assert.equal(store.parseLayout({ columns: [{ width: 1, tiles: [{ session: 'work', ownerId: 'bad', height: 1, fontSize: 11 }] }] }), null);
  assert.equal(store.parseLayout({ columns: [{ width: 1, tiles: [{ session: 'work', node: 'relay/phone/relay', height: 1, fontSize: 11 }] }] }), null);
  assert.equal(store.parseLayout({ columns: [{ width: 1, tiles: [{ session: 'work', node: 'a/b/c/d/e', height: 1, fontSize: 11 }] }] }), null);
});
