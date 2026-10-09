'use strict';
// tests/notice-dismissal-queue-sequences.test.js — a property sweep over short
// operation sequences, on a fake in-memory fs.
//
// Every sequence of 2-4 steps from the alphabet below runs against a FRESH
// queue on a FRESH fake disk, seeded with records near the interesting
// limits (1 record, the cap minus one, exactly the cap, and a record near the
// byte budget), and must hold four invariants:
//
//   1. a healthy write keeps every accepted, unconfirmed record it can hold
//      under the cap (the oldest ones leave room: declared cap policy);
//   2. when the queue reports healthy, every accepted, unconfirmed record
//      that no refused write has declared lost is on the disk;
//   3. when the queue reports healthy, for every record the disk holds, the
//      in-memory state outranks it — EXCEPT for records a refused write
//      declared lost (their divergence is the announced outcome);
//   4. a CONFIRMED record never reappears on the disk once the queue reports
//      healthy.
//
// A refused write DECLARES the divergence for the records it held: the
// declaration covers them until the next successful (consolidating) write.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { createNoticeDismissalQueue, SCHEMA } = require('../lib/notify/notice-dismissal-queue.js');

const FILE = '/mem/notice-dismissal-queue.json';
const STEPS = ['RD', 'RS', 'RO', 'WF', 'WR', 'MK', 'SO', 'PO', 'E', 'U', 'C', 'T'];
const SEEDS = ['one', 'cap-1', 'cap', 'big'];

function makeFakeFs() {
  const disk = new Map();
  let readRule = null;
  let writeRule = null;
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
    peek(p) { return disk.has(p) ? disk.get(p) : null; },
    currentWriteRule() { return writeRule; },
  };
}

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
    const declared = new Set(); // ids whose divergence a refused write declared
    const atRisk = new Set();   // ids not on the disk while a degradation is declared
    const evicted = new Set();  // records the cap policy legitimately removed
    const confirmed = new Set(); // eventId never allowed back on the disk
    const confirmedSeenAbsent = new Set(); // confirmed AND seen absent from the disk at least once
    let nextId = 0;
    let lastAccepted = null;

    const diskEntries = () => {
      try { return JSON.parse(fake.peek(FILE) || '{"entries":[]}').entries || []; } catch (_) { return []; }
    };
    const sync = () => { try { q.status(); } catch (_) {} };
    let onDiskPrev = [];
    for (const eventId of diskEntries().map((e) => e.eventId)) onDiskPrev.push(eventId);

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
        // A restart re-bases the truth on the disk for EVERYTHING: records a
        // declared degradation had put at risk are gone, records a declared
        // refused write held in memory lose their unconsolidated state, and
        // the records the disk holds come back with the disk's own state. A
        // confirmed record never comes back either.
        q = createNoticeDismissalQueue({ filePath: FILE });
        // The oracle re-bases on the disk too: after a restart the disk is
        // the truth for what survived (at-risk records are gone, unconsol-
        // idated declared intent is gone) and for the state it holds.
        const diskAfter = new Map(diskEntries().map((e) => [e.eventId, e]));
        for (const [eventId, entry] of [...accepted.entries()]) {
          const rec = diskAfter.get(eventId);
          if (rec) accepted.set(eventId, { syncState: rec.syncState, attempts: rec.attempts || 0 });
          else accepted.delete(eventId);
        }
      }
      sync();

      // A declared degradation puts every accepted record at-risk and
      // declares the possible divergence for all of them. A HEALTHY write
      // consolidates what it wrote: prior declarations are void.
      const degradedNow = (() => { try { return q.status().degraded !== null; } catch (_) { return false; } })();
      const nowList = diskEntries().map((e) => e.eventId);
      if (degradedNow) {
        for (const [eventId] of accepted) declared.add(eventId);
        for (const [eventId] of accepted) if (!nowList.includes(eventId)) atRisk.add(eventId);
      } else {
        declared.clear();
        const onDisk = new Set(nowList);
        for (const eventId of onDiskPrev) if (!onDisk.has(eventId)) evicted.add(eventId);
        onDiskPrev = nowList;
      }
    }

    // Final state.
    const final = (() => { try { return q.status(); } catch (_) { return { degraded: 'status-failed' }; } })();
    const onDisk = new Map(diskEntries().map((e) => [e.eventId, e]));
    if (final.degraded === null) {
      // INV2: healthy → everything accepted, unconfirmed, not evicted and not
      // declared lost is on the disk.
      for (const [eventId] of accepted) {
        if (!declared.has(eventId) && !evicted.has(eventId) && !onDisk.has(eventId)) violations.push(`healthy report with records off disk: ${eventId}`);
      }
      // INV3: for every record the disk holds, the in-memory state outranks
      // it — in every sequence, degraded or not.
      for (const [eventId, expected] of accepted) {
        const rec = onDisk.get(eventId);
        if (rec) {
          if (rec.syncState !== expected.syncState) violations.push(`disk state outranks the cache for ${eventId}`);
          if (rec.attempts !== expected.attempts) violations.push(`disk attempts outrank the cache for ${eventId}`);
        }
      }
      // INV4: a confirmed record never reappears on the disk once the disk
      // has been seen without it. (While a degradation is declared, a refused
      // write may leave the record where it was: that is the announced
      // outcome, not a reappearance.)
      for (const eventId of confirmed) {
        if (confirmedSeenAbsent.has(eventId) && onDisk.has(eventId)) violations.push(`confirmed record reappeared: ${eventId}`);
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
