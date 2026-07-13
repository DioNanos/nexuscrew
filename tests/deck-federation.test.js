'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const federation = () => import('../frontend/src/lib/deck-federation.js');
const grid = () => import('../frontend/src/lib/grid-model.js');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const tile = (session, extra = {}) => ({ session, height: 1, fontSize: 11, ...extra });

test('deck identity is owner-qualified and duplicate names remain distinct', async () => {
  const m = await federation();
  assert.equal(m.deckId(null, 'main'), 'local:main');
  assert.equal(m.deckId(A, 'main'), `${A}:main`);
  assert.notEqual(m.deckId(A, 'work'), m.deckId(B, 'work'));
  assert.deepEqual(m.parseDeckId(`${B}:work`), { ownerId: B, name: 'work' });
  assert.equal(m.parseDeckId('bad:work'), null);
});

test('canonical deck tiles bind to stable owners and resolve per viewer route', async () => {
  const m = await federation();
  const raw = { columns: [{ width: 1, tiles: [
    tile('owner-local'),
    tile('peer-cell', { node: 'peer' }),
  ] }] };
  const canonical = m.annotateCanonicalLayout(raw, A, [{ instanceId: B, route: ['peer'] }]);
  assert.equal(canonical.columns[0].tiles[0].ownerId, A);
  assert.equal(canonical.columns[0].tiles[1].ownerId, B);

  const viewed = m.resolveLayoutForViewer(canonical, B, [{ instanceId: A, route: ['relay', 'owner'] }]);
  assert.equal(viewed.columns[0].tiles[0].node, 'relay/owner');
  assert.equal(viewed.columns[0].tiles[1].node, undefined);
  assert.equal(viewed.columns[0].tiles[1].unavailable, undefined);

  const saved = m.canonicalizeLayoutForOwner(viewed, A, [{ instanceId: B, route: ['peer'] }]);
  assert.equal(saved.columns[0].tiles[0].node, undefined);
  assert.equal(saved.columns[0].tiles[1].node, 'peer');
  assert.equal(saved.columns[0].tiles[0].unavailable, undefined);
});

test('unknown stable owner is visible but fail-closed and never becomes a local attach', async () => {
  const m = await federation(); const g = await grid();
  const canonical = { columns: [{ width: 1, tiles: [tile('same-name', { ownerId: C, node: 'stale-route' })] }] };
  const viewed = m.resolveLayoutForViewer(canonical, A, [{ instanceId: B, route: ['stale-route'] }]);
  assert.equal(viewed.columns[0].tiles[0].ownerId, C);
  assert.equal(viewed.columns[0].tiles[0].unavailable, true);
  assert.equal(g.normalize(viewed).columns[0].tiles[0].unavailable, true, 'ephemeral fail-closed state survives grid edits');
  const saved = m.canonicalizeLayoutForOwner(viewed, A, []);
  assert.equal(saved.columns[0].tiles[0].unavailable, undefined, 'ephemeral viewer state is never persisted');
});

test('new session references acquire the stable local or routed owner', async () => {
  const m = await federation();
  assert.deepEqual(m.refWithOwner('dev', A, []), { session: 'dev', ownerId: A });
  assert.deepEqual(m.refWithOwner('relay/mac:dev', A, [{ instanceId: B, route: ['relay', 'mac'] }]), {
    session: 'dev', node: 'relay/mac', ownerId: B,
  });
});
