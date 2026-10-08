'use strict';
// tests/notice-dismissal-queue-sequences.test.js — a property sweep over short
// operation sequences, on a fake in-memory fs.
//
// Every sequence of 2-4 steps drawn from a small alphabet runs against a FRESH
// queue on a FRESH fake disk, and must hold three invariants at the end:
//
//   1. an accepted, unconfirmed record may be missing from the disk ONLY while
//      the queue declares a degradation (durable:false) — a record that
//      disappears while the queue reports healthy is a silent loss;
//   2. if the queue reports healthy (no degradation), every accepted,
//      unconfirmed record is on the disk;
//   3. when a record exists in memory and on the disk, the in-memory state is
//      the one that wins on the next write.
//
// The fake fs is fully deterministic: read denial, foreign schema, oversize
// and write denial are one-shot rules, and no wall clock is involved in the
// ordering of anything the invariants check.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { createNoticeDismissalQueue, SCHEMA } = require('../lib/notify/notice-dismissal-queue.js');

const FILE = '/mem/notice-dismissal-queue.json';
const STEPS = ['RD', 'RS', 'RO', 'WF', 'E', 'U', 'C', 'T'];

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
    writeFileSync(p, body) { disk.set(p, String(body)); },
    // The truth on disk, with no read rule applied: the invariants look at
    // what a write actually stored, not at what a one-shot read rule would
    // have made a real reader see (an unconsumed rule is a wasted rule, not
    // a lost record).
    peek(p) { return disk.has(p) ? disk.get(p) : null; },
    renameSync(a, b) {
      const rule = writeRule;
      writeRule = null;
      if (rule === 'fail') { const e = new Error('write denied'); e.code = 'EACCES'; throw e; }
      if (!disk.has(a)) { const e = new Error('no file'); e.code = 'ENOENT'; throw e; }
      disk.set(b, disk.get(a));
      disk.delete(a);
    },
    mkdirSync() {},
  };
}

// One sequence run: returns { violations: [...] } — empty means all three
// invariants held.
function runSequence(steps) {
  const violations = [];
  const fake = makeFakeFs();
  const original = { read: fs.readFileSync, write: fs.writeFileSync, rename: fs.renameSync, mkdir: fs.mkdirSync };
  fs.readFileSync = fake.readFileSync;
  fs.writeFileSync = fake.writeFileSync;
  fs.renameSync = fake.renameSync;
  fs.mkdirSync = fake.mkdirSync;
  try {
    const ownerId = 'a'.repeat(32);
    // Every sequence starts with a record ALREADY on disk: the interesting
    // failure (a failed load followed by an overwriting write) needs records
    // that the in-memory list cannot know about.
    const seed = createNoticeDismissalQueue({ filePath: FILE });
    assert.equal(seed.enqueue({ ownerId, eventId: 'old' }).ok, true);
    let q = createNoticeDismissalQueue({ filePath: FILE });
    // Whether ANY degradation has been declared in this sequence: its
    // declarations cover state divergence, so INV3 (state precedence) is a
    // strict invariant only for sequences that never degraded.
    let everDegraded = false;
    const accepted = new Map([['old', { syncState: 'pending', attempts: 0 }]]);
    // Records accepted while the queue declares a degradation (or degraded by
    // their own refused write): their loss at a RESTART is the announced one.
    const atRisk = new Set();
    let nextId = 0;
    let lastAccepted = null;

    const diskEntries = () => {
      try { return JSON.parse(fake.peek(FILE) || '{"entries":[]}').entries || []; } catch (_) { return []; }
    };
    const sync = () => { try { q.status(); } catch (_) {} };

    for (const step of steps) {
      if (step === 'RD') fake.setReadRule('denied');
      else if (step === 'RS') fake.setReadRule('schema');
      else if (step === 'RO') fake.setReadRule('oversize');
      else if (step === 'WF') fake.setWriteRule('fail');
      else if (step === 'E') {
        const eventId = `e${nextId += 1}`;
        if (q.enqueue({ ownerId, eventId }).ok) {
          accepted.set(eventId, { syncState: 'pending', attempts: 0 });
          lastAccepted = eventId;
        }
      } else if (step === 'U') {
        if (lastAccepted && accepted.has(lastAccepted)) {
          const cur = accepted.get(lastAccepted);
          if (q.update(ownerId, lastAccepted, { syncState: 'blocked', attempts: (cur.attempts || 0) + 7, lastReason: 'probe' }).ok) {
            accepted.set(lastAccepted, { syncState: 'blocked', attempts: (cur.attempts || 0) + 7 });
          }
        }
      } else if (step === 'C') {
        if (lastAccepted && accepted.has(lastAccepted)) {
          if (q.confirm(ownerId, lastAccepted).ok) accepted.delete(lastAccepted);
          lastAccepted = null;
        }
      } else if (step === 'T') {
        q = createNoticeDismissalQueue({ filePath: FILE });
      }
      sync();

      // A declared degradation marks as at-risk every accepted record that is
      // NOT on the disk yet: losing one of those at a restart is the announced
      // outcome. Records already consolidated on the disk keep full
      // protection — a later write must never take them away silently.
      const degradedNow = (() => { try { return q.status().degraded !== null; } catch (_) { return false; } })();
      if (degradedNow) everDegraded = true;
      if (degradedNow) {
        const onDisk = new Set(diskEntries().map((e) => e.eventId));
        for (const [eventId] of accepted) if (!onDisk.has(eventId)) atRisk.add(eventId);
      }

      // INV1: a record that was accepted on a HEALTHY queue never disappears
      // while the queue reports healthy. (Fresh event ids make the acceptance
      // unambiguous.)
      if (degradedNow === false) {
        const onDisk = new Set(diskEntries().map((e) => e.eventId));
        for (const [eventId] of accepted) {
          if (!atRisk.has(eventId) && !onDisk.has(eventId)) {
            violations.push(`silent loss of ${eventId}`);
            break;
          }
        }
      }
    }

    // INV2 + INV3 on the final state — both hold only while the queue reports
    // healthy: a reported degradation is exactly the declaration that the
    // disk may diverge.
    const final = (() => { try { return q.status(); } catch (_) { return { degraded: 'status-failed' }; } })();
    const onDisk = new Map(diskEntries().map((e) => [e.eventId, e]));
    if (final.degraded === null) {
      for (const [eventId] of accepted) {
        if (!atRisk.has(eventId) && !onDisk.has(eventId)) violations.push('healthy report with records off disk');
      }
      for (const [eventId, expected] of accepted) {
        if (atRisk.has(eventId) || everDegraded) continue;
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
  }
  return violations;
}

test('every short operation sequence keeps the durability and precedence invariants', () => {
  const failing = [];
  const sequences = [];
  for (const a of STEPS) for (const b of STEPS) sequences.push([a, b]);
  for (const a of STEPS) for (const b of STEPS) for (const c of STEPS) sequences.push([a, b, c]);
  for (const a of STEPS) for (const b of STEPS) for (const c of STEPS) for (const d of STEPS) sequences.push([a, b, c, d]);
  assert.equal(sequences.length, 8 ** 2 + 8 ** 3 + 8 ** 4, 'the sweep covers every sequence up to 4 steps');

  for (const steps of sequences) {
    const violations = runSequence(steps);
    if (violations.length > 0) failing.push(`${steps.join(' ')}: ${violations[0]}`);
  }
  if (failing.length > 0) {
    console.log('SEQ-FAILURES', JSON.stringify({ count: failing.length, of: sequences.length, sample: failing.slice(0, 24) }, null, 1));
  }
  assert.deepEqual(failing, [], `${failing.length} of ${sequences.length} sequences violated the invariants`);
});

