'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../lib/nodes/reverse-pool.js');

test('reverse pool: tre slot disgiunte e candidate che non si sovrappongono', () => {
  assert.deepEqual(pool.reversePoolForBase(44003), [44003, 44103, 44203]);
  const ledger = pool.appendLedger(pool.emptyLedger('a'.repeat(32)), { type: 'allocated', base: 44001, at: 1 });
  assert.deepEqual(pool.nextReversePool([], ledger), { base: 44002, slots: [44002, 44102, 44202] });
  assert.equal(pool.reversePoolForBase(65436), null, 'non deve emettere slot oltre 65535');
});

test('reverse pool: ledger append-only a digest concatenato e anchor corrente', () => {
  const one = pool.appendLedger(pool.emptyLedger('b'.repeat(32)), { type: 'allocated', base: 44003, at: 1 });
  const two = pool.appendLedger(one, { type: 'retired', base: 44003, at: 2 });
  const anchor = pool.ledgerHead(two);
  assert.deepEqual(pool.validateLedgerAnchor(two, anchor), {
    ok: true, code: 'reverse-pool-anchor-current', allocationBlocked: false, anchor,
  });
  assert.equal(pool.parseLedger({ ...two, entries: [{ ...two.entries[0], digest: '0'.repeat(64) }] }), null);
});

test('reverse pool: ledger avanti riconcilia, indietro o prefisso perso blocca solo allocazioni', () => {
  const one = pool.appendLedger(pool.emptyLedger('c'.repeat(32)), { type: 'allocated', base: 44003, at: 1 });
  const anchor = pool.ledgerHead(one);
  const two = pool.appendLedger(one, { type: 'retired', base: 44003, at: 2 });
  const ahead = pool.validateLedgerAnchor(two, anchor);
  assert.equal(ahead.ok, true); assert.equal(ahead.code, 'reverse-pool-anchor-advance');
  assert.deepEqual(ahead.advanceAnchor, pool.ledgerHead(two));
  assert.deepEqual(pool.validateLedgerAnchor(one, pool.ledgerHead(two)), {
    ok: false, code: 'reverse-pool-ledger-behind-anchor', allocationBlocked: true,
  });
  assert.deepEqual(pool.validateLedgerAnchor(one, { ...anchor, digest: 'd'.repeat(64) }), {
    ok: false, code: 'reverse-pool-anchor-prefix-mismatch', allocationBlocked: true,
  });
});

test('reverse pool: pool rimosso non torna allocabile e ledger 0600 rifiuta symlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-reverse-pool-'));
  const ledgerPath = path.join(dir, 'reverse-pool-ledger.json');
  const ledger = pool.appendLedger(pool.emptyLedger('d'.repeat(32)), { type: 'allocated', base: 44001, at: 1 });
  pool.atomicWriteLedger(ledgerPath, ledger);
  assert.equal(fs.statSync(ledgerPath).mode & 0o777, 0o600);
  assert.equal(pool.nextReversePool([], pool.loadLedger(ledgerPath)).base, 44002);
  const link = path.join(dir, 'link.json'); fs.symlinkSync(ledgerPath, link);
  assert.throws(() => pool.atomicWriteLedger(link, ledger), /symlink/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reverse pool: preflight richiede tutte le slot e non alloca una pool parziale', async () => {
  const seen = [];
  const chosen = await pool.allocateAvailableReversePool([], null, {
    canBind: async (port) => { seen.push(port); return port !== 44101; },
  });
  assert.deepEqual(chosen, { base: 44002, slots: [44002, 44102, 44202] });
  assert.deepEqual(seen, [44001, 44101, 44002, 44102, 44202]);
});
