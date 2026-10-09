'use strict';
// tests/notice-dismissals.test.js — owner-side store of dismissed notices.
//
// The store is the owner's own memory of "this notice was cleared": it holds
// ids and timestamps only, it lives exactly as long as the history it filters
// (15 minutes), it is bounded on both axes (200 entries, 64 KiB), it is written
// atomically and it degrades VISIBLY instead of throwing into the caller.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createNoticeDismissals, MAX_ENTRIES, MAX_BYTES, MAX_MS,
} = require('../lib/notify/notice-dismissals.js');

const T0 = 1_700_000_000_000;

function store(t, { now = () => T0, limits = {}, file } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdismiss-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = file || path.join(dir, 'notice-dismissals.json');
  return { filePath, dir, make: (opts = {}) => createNoticeDismissals({ filePath, now, limits, ...opts }) };
}

test('dismiss is idempotent and survives a reload from disk', async (t) => {
  const s = store(t);
  const first = s.make();
  assert.equal(first.isDismissed('0f8fad5b-d9cb-469f-a165-70867728950e'), false);
  const out = first.dismiss('0f8fad5b-d9cb-469f-a165-70867728950e');
  assert.deepStrictEqual(out, { ok: true, idempotent: false });
  assert.equal(first.isDismissed('0f8fad5b-d9cb-469f-a165-70867728950e'), true);
  const again = first.dismiss('0f8fad5b-d9cb-469f-a165-70867728950e');
  assert.deepStrictEqual(again, { ok: true, idempotent: true });
  // A second instance on the same file sees the same truth: it is on disk.
  const reloaded = s.make();
  assert.equal(reloaded.isDismissed('0f8fad5b-d9cb-469f-a165-70867728950e'), true);
});

test('entries older than the retention window are pruned on load and on write', async (t) => {
  let clock = T0;
  const s = store(t, { now: () => clock });
  const a = s.make();
  a.dismiss('aaaaaaaa-1111-4111-8111-111111111111');
  assert.equal(a.status().count, 1);

  // 16 minutes later the entry has outlived the history it filters.
  clock = T0 + MAX_MS + 60_000;
  const b = s.make();
  assert.equal(b.status().count, 0, 'the expired entry is not loaded');
  assert.equal(b.isDismissed('aaaaaaaa-1111-4111-8111-111111111111'), false);

  // A write at that time does not resurrect it either.
  b.dismiss('bbbbbbbb-2222-4222-8222-222222222222');
  const onDisk = JSON.parse(fs.readFileSync(s.filePath, 'utf8'));
  assert.deepStrictEqual(onDisk.entries.map((e) => e.eventId), ['bbbbbbbb-2222-4222-8222-222222222222']);
});

test('the entry cap keeps the newest 200 and drops the oldest', async (t) => {
  let clock = T0;
  const s = store(t, { now: () => clock });
  const d = s.make();
  const ids = [];
  for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
    const id = `${String(i).padStart(8, '0')}-3333-4333-8333-333333333333`;
    ids.push(id);
    d.dismiss(id);
    clock += 10;
  }
  assert.equal(d.status().count, MAX_ENTRIES);
  assert.equal(d.isDismissed(ids[ids.length - 1]), true, 'the newest survives');
  assert.equal(d.isDismissed(ids[0]), false, 'the oldest is pruned');
  const onDisk = JSON.parse(fs.readFileSync(s.filePath, 'utf8'));
  assert.equal(onDisk.entries.length, MAX_ENTRIES);
});

test('the byte cap prunes the oldest, and an entry that cannot fit is refused with visible degradation', async (t) => {
  const s = store(t, { limits: { maxBytes: 400 } });
  const d = s.make();
  for (let i = 0; i < 6; i += 1) d.dismiss(`${String(i).padStart(8, '0')}-4444-4444-8444-444444444444`);
  const written = JSON.parse(fs.readFileSync(s.filePath, 'utf8'));
  assert.ok(Buffer.byteLength(fs.readFileSync(s.filePath), 'utf8') <= 400, 'the file stays under the cap');
  assert.ok(written.entries.length < 6, 'the cap pruned');
  assert.equal(d.isDismissed(written.entries[written.entries.length - 1].eventId), true);

  const refused = d.dismiss('x'.repeat(400));
  assert.deepStrictEqual(refused, { ok: false, reason: 'oversize' });
  assert.equal(d.status().degraded, 'dismissals-oversize', 'the refusal is declared, not silent');
  // The store keeps working for the entries it already holds.
  assert.equal(d.isDismissed(written.entries[0].eventId), true);
});

test('the file is written atomically: 0600, declared schema, no temp left behind', async (t) => {
  const s = store(t);
  const d = s.make();
  d.dismiss('cccccccc-5555-4555-8555-555555555555');
  await new Promise((resolve) => setImmediate(resolve));
  const raw = fs.readFileSync(s.filePath, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schema, 'nexuscrew-notice-dismissals-v1');
  assert.equal(parsed.entries.length, 1);
  assert.deepStrictEqual(Object.keys(parsed.entries[0]).sort(), ['at', 'eventId']);
  assert.equal(typeof parsed.entries[0].at, 'number');
  assert.equal(fs.statSync(s.filePath).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(s.dir).filter((n) => n.endsWith('.tmp')), []);
});

test('a write failure degrades visibly and never throws into the caller', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdismiss-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A directory in place of the file makes the atomic rename fail for real.
  const filePath = path.join(dir, 'notice-dismissals.json');
  fs.mkdirSync(filePath);
  const d = createNoticeDismissals({ filePath, now: () => T0 });
  const out = d.dismiss('dddddddd-6666-4666-8666-666666666666');
  assert.equal(out.ok, true, 'a local dismissal is never lost to a disk problem');
  assert.equal(d.status().degraded, 'dismissals-write-failed');
});

test('a foreign or corrupt file degrades instead of being trusted', async (t) => {
  const s = store(t);
  fs.writeFileSync(s.filePath, 'not json at all');
  const broken = s.make();
  assert.equal(broken.status().count, 0);
  assert.equal(broken.status().degraded, 'dismissals-schema');
  assert.equal(broken.isDismissed('anything'), false);

  fs.writeFileSync(s.filePath, JSON.stringify({ schema: 'other-schema', entries: [{ eventId: 'e', at: T0 }] }));
  const foreign = s.make();
  assert.equal(foreign.status().degraded, 'dismissals-schema');
  assert.equal(foreign.isDismissed('e'), false);
});

test('the exported limits describe the contract the store enforces', () => {
  assert.equal(MAX_MS, 15 * 60 * 1000);
  assert.equal(MAX_ENTRIES, 200);
  assert.equal(MAX_BYTES, 64 * 1024);
});
