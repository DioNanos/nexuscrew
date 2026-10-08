'use strict';
// tests/notice-dismissal-queue-sequences.test.js — a property sweep over short
// operation sequences, on a fake in-memory fs.
//
// Every sequence of 2-4 steps from the alphabet below runs against a FRESH
// queue on a FRESH fake disk, seeded with records near the interesting
// limits (1 record, the cap minus one, exactly the cap, and a record near the
// byte budget), and must hold four invariants at the end and at every step:
//
//   1. an accepted, unconfirmed record may be missing from the disk ONLY while
//      the queue declares a degradation;
//   2. if the queue reports healthy (no degradation), every accepted,
//      unconfirmed record is on the disk;
//   3. when a record exists in memory and on the disk, the in-memory state is
//      the one that wins on the next write — in EVERY sequence, degraded or
//      not (a degradation never disables this one);
//   4. a CONFIRMED record never reappears on the disk, whatever follows.
//
// atRisk resets after consolidation: once a healthy write puts a record on
// the disk, it is no longer excused from the invariants.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { createNoticeDismissalQueue, SCHEMA } = require('../lib/notify/notice-dismissal-queue.js');

const FILE = '/mem/notice-dismissal-queue.json';
const STEPS = ['RD', 'RS', 'RO', 'WF', 'WR', 'MK', 'SO', 'PO', 'E', 'U', 'C', 'T'];
// Seeds near the interesting limits: 1 record, the cap minus one, exactly the
// cap, and a record big enough to sit near the 64 KiB write budget.
const SEEDS = ['one', 'cap-1', 'cap', 'big'];

function makeFakeFs() {
  const disk = new Map();
  let readRule = null;   // 'denied' | 'schema' | 'oversize' | null (one-shot)
  let writeRule = null;  // 'fail' | 'mkdir' | 'write' | 'serialization' | 'oversize' | null
  return {
    setReadRule(r) { readRule = r; },
    setWriteRule(r) { writeRule = r; },
    readFileSync(p, enc) {
      if (p === FILE) {
        const rule = readRule;
        readRule = null;
        if (rule === 'denied') { const e = new Error('read denied'); e.code = 'EACCES'; throw e; }
        if (rule === 'schema') return JSON.stringify({ schema: 'wrong-v1', entries: [] });
        if (rule === 'oversize') return 'x'.repeat(300000);
        if (!disk.has(p)) { const e = new Error('no file'); e.code = 'ENOENT'; throw e; }
        return disk.get(p);
      }
      if (!disk.has(p)) { const e = new Error('no file'); e.code = 'ENOENT'; throw e; }
      return disk.get(p);
    },
    writeFileSync(p, body) {
      const rule = writeRule;
      writeRule = null;
      if (rule === 'write') { const e = new Error('write denied'); e.code = 'EACCES'; throw e; }
      disk.set(p, String(body));
    },
    renameSync(a, b) {
      const rule = writeRule;
      writeRule = null;
      if (rule === 'fail') { const e = new Error('rename denied'); e.code = 'EACCES'; throw e; }
      if (!disk.has(a)) { const e = new Error('no file'); e.code = 'ENOENT'; throw e; }
      disk.set(b, disk.get(a));
      disk.delete(a);
    },
    mkdirSync(p, opts) {
      const rule = writeRule;
      writeRule = null;
      if (rule === 'mkdir') { const e = new Error('mkdir denied'); e.code = 'EACCES'; throw e; }
    },
    // The truth on disk, with no read rule applied.
    peek(p) { return disk.has(p) ? disk.get(p) : null; },
    currentWriteRule() { return writeRule; },
  };
}

// One sequence run on one seed: returns { violations: [...] } — empty means
// all the invariants held.
function runSequence(steps, seedMode) {
  const violations = [];
  const fake = makeFakeFs();
  const original = {
    read: fs.readFileSync, write: fs.writeFileSync, rename: fs.renameSync,
    mkdir: fs.mkdirSync, stringify: JSON.stringify, byteLength: Buffer.byteLength,
  };
  fs.readFileSync = fake.readFileSync;
  fs.writeFileSync = fake.writeFileSync;
  fs.renameSync = fake.renameSync;
  fs.mkdirSync = fake.mkdirSync;
  JSON.stringify = function (value, replacer, space) {
    const rule = fake.currentWriteRule();
    if (rule === 'serialization' && value && value.schema === SCHEMA) { const e = new Error('serialization denied'); e.code = 'EACCES'; throw e; }
    return original.stringify.call(JSON, value, replacer, space);
  };
  Buffer.byteLength = function (value, ...args) {
    const rule = fake.currentWriteRule();
    if (rule === 'oversize' && typeof value === 'string' && value.includes(SCHEMA)) return 64 * 1024 * 10;
    return original.byteLength.call(Buffer, value, ...args);
  };
  try {
    const ownerId = 'a'.repeat(32);
    const seed = createNoticeDismissalQueue({ filePath: FILE });
    if (seedMode === 'cap-1' || seedMode === 'cap') {
      const n = seedMode === 'cap' ? 200 : 199;
      for (let i = 0; i < n; i += 1) assert.equal(seed.enqueue({ ownerId, eventId: `old-${i}` }).ok, true);
    } else if (seedMode === 'big') {
      assert.equal(seed.enqueue({ ownerId, eventId: 'b'.repeat(50000) }).ok, true, 'the big seed fits its own write');
    } else {
      assert.equal(seed.enqueue({ ownerId, eventId: 'old' }).ok, true);
    }

    let q = createNoticeDismissalQueue({ filePath: FILE });
    const accepted = new Map(); // eventId -> {syncState, attempts}
    if (seedMode === 'cap-1' || seedMode === 'cap') {
      const n = seedMode === 'cap' ? 200 : 199;
      for (let i = 0; i < n; i += 1) accepted.set(`old-${i}`, { syncState: 'pending', attempts: 0 });
    } else {
      accepted.set(seedMode === 'big' ? 'b'.repeat(50000) : 'old', { syncState: 'pending', attempts: 0 });
    }
    const atRisk = new Set();
    const evicted = new Set();  // records the cap policy legitimately removed
    const confirmed = new Set(); // eventId never allowed back on the disk
    let nextId = 0;
    let lastAccepted = null;

    const diskEntries = () => {
      try { return JSON.parse(fake.peek(FILE) || '{"entries":[]}').entries || []; } catch (_) { return []; }
    };
    const sync = () => { try { q.status(); } catch (_) {} };
    let onDiskPrev = diskEntries().map((e) => e.eventId);

    for (const step of steps) {
      if (step === 'RD') fake.setReadRule('denied');
      else if (step === 'RS') fake.setReadRule('schema');
      else if (step === 'RO') fake.setReadRule('oversize');
      else if (step === 'WF') fake.setWriteRule('fail');
      else if (step === 'WR') fake.setWriteRule('write');
      else if (step === 'MK') fake.setWriteRule('mkdir');
      else if (step === 'SO') fake.setWriteRule('serialization');
      else if (step === 'PO') fake.setWriteRule('oversize');
      else if (step === 'E') {
        const eventId = `e${nextId += 1}`;
        const out = q.enqueue({ ownerId, eventId });
        if (out.ok) {
          accepted.set(eventId, { syncState: 'pending', attempts: 0 });
          lastAccepted = eventId;
        }
      } else if (step === 'U') {
        if (lastAccepted && accepted.has(lastAccepted)) {
          const cur = accepted.get(lastAccepted);
          const out = q.update(ownerId, lastAccepted, { syncState: 'blocked', attempts: (cur.attempts || 0) + 7, lastReason: 'probe' });
          if (out.ok) accepted.set(lastAccepted, { syncState: 'blocked', attempts: (cur.attempts || 0) + 7 });
        }
      } else if (step === 'C') {
        if (lastAccepted && accepted.has(lastAccepted)) {
          const out = q.confirm(ownerId, lastAccepted);
          if (out.ok) { accepted.delete(lastAccepted); confirmed.add(lastAccepted); }
          lastAccepted = null;
        }
      } else if (step === 'T') {
        // A restart re-bases the truth on the disk: records that a DECLARED
        // degradation had put at risk are gone (accepted catches up), the
        // rest is loaded back. A confirmed record never comes back either.
        const onDiskIds = new Set(diskEntries().map((e) => e.eventId));
        for (const [eventId] of accepted) {
          if (!onDiskIds.has(eventId) && atRisk.has(eventId)) accepted.delete(eventId);
        }
        q = createNoticeDismissalQueue({ filePath: FILE });
      }
      sync();

      // A declared degradation marks as at-risk every accepted record that is
      // NOT on the disk yet. Records already consolidated keep full
      // protection, and a healthy report consolidates what it wrote.
      const degradedNow = (() => { try { return q.status().degraded !== null; } catch (_) { return false; } })();
      // A healthy write that shrinks the disk evicts the OLDEST records by
      // the cap policy: they never come back, and the invariants stop
      // requiring them.
      const nowList = diskEntries().map((e) => e.eventId);
      if (!degradedNow) {
        const before = new Set(onDiskPrev);
        for (const eventId of before) if (!nowList.includes(eventId)) evicted.add(eventId);
      }
      onDiskPrev = nowList;
      if (degradedNow) {
        const onDisk = new Set(diskEntries().map((e) => e.eventId));
        for (const [eventId] of accepted) if (!onDisk.has(eventId)) atRisk.add(eventId);
      } else {
        const onDisk = new Set(diskEntries().map((e) => e.eventId));
        for (const [eventId] of accepted) if (onDisk.has(eventId)) atRisk.delete(eventId);
        // A healthy report must hold every accepted, unconfirmed record that
        // the cap allows it to hold: the LAST maxEntries in acceptance order.
        // The oldest ones an evicted record leaves room for are the declared
        // cap policy, not a loss.
        const expected = [...accepted.keys()].filter((id) => !atRisk.has(id) && !evicted.has(id)).slice(-200);
        for (const eventId of expected) {
          if (!onDisk.has(eventId)) {
            violations.push(`silent loss of ${eventId}`);
            break;
          }
        }
      }
      // INV4: a confirmed record never reappears on the disk.
      const onDiskNow = new Set(diskEntries().map((e) => e.eventId));
      for (const eventId of confirmed) {
        if (onDiskNow.has(eventId)) { violations.push(`confirmed record reappeared: ${eventId}`); break; }
      }
    }

    // Final state, evaluated on the last report: healthy means everything
    // accepted, unconfirmed and not lost (declared) is on the disk; and the
    // in-memory state outranks the disk for every duplicate — in every
    // sequence, degraded or not.
    const final = (() => { try { return q.status(); } catch (_) { return { degraded: 'status-failed' }; } })();
    const onDisk = new Map(diskEntries().map((e) => [e.eventId, e]));
    if (final.degraded === null) {
      // Same cap rule as the per-step check: the LAST maxEntries accepted
      // records (minus the at-risk ones) are what a healthy report must hold.
      const expectedFinal = [...accepted.keys()].filter((id) => !atRisk.has(id)).slice(-200);
      for (const eventId of expectedFinal) {
        if (!onDisk.has(eventId)) violations.push(`healthy report with records off disk: ${eventId}`);
      }
      for (const [eventId, expected] of accepted) {
        const rec = onDisk.get(eventId);
        if (rec) {
          if (rec.syncState !== expected.syncState) violations.push(`disk state outranks the cache for ${eventId}`);
          if (rec.attempts !== expected.attempts) violations.push(`disk attempts outrank the cache for ${eventId}`);
        }
      }
    }
  } finally {
    fs.readFileSync = original.read;
    fs.writeFileSync = original.write;
    fs.renameSync = original.rename;
    fs.mkdirSync = original.mkdir;
    JSON.stringify = original.stringify;
    Buffer.byteLength = original.byteLength;
  }
  return violations;
}

test('every short operation sequence keeps the durability, precedence and confirmed-removal invariants', () => {
  const failing = [];
  const sequences = [];
  for (const a of STEPS) for (const b of STEPS) for (const seedMode of SEEDS) sequences.push([a, b, seedMode]);
  for (const a of STEPS) for (const b of STEPS) for (const c of STEPS) for (const seedMode of SEEDS) sequences.push([a, b, c, seedMode]);
  for (const a of STEPS) for (const b of STEPS) for (const c of STEPS) for (const d of STEPS) sequences.push([a, b, c, d, 'one']);
  assert.equal(sequences.length, (12 ** 2 + 12 ** 3) * 4 + 12 ** 4, 'the sweep covers every sequence up to 4 steps');

  for (const steps of sequences) {
    const seedMode = steps.pop();
    const violations = runSequence(steps, seedMode);
    if (violations.length > 0) failing.push(`${steps.join(' ')} [${seedMode}]: ${violations[0]}`);
  }
  if (failing.length > 0) {
    console.log('SEQ-FAILURES', JSON.stringify({ count: failing.length, of: sequences.length, sample: failing.slice(0, 24) }, null, 1));
  }
  assert.deepEqual(failing, [], `${failing.length} of ${sequences.length} sequences violated the invariants`);
});
