'use strict';
// tests/notice-dismissal-queue-sequences.test.js — a property sweep over short
// operation sequences, on a fake in-memory fs.
//
// Every sequence of 2-4 steps from the alphabet below runs against a FRESH
// queue on a FRESH fake disk, seeded with records near the interesting limits
// (1 record, the cap minus one, exactly the cap, and a record that leaves room
// for one more small record before the byte budget). The faults are REAL: each
// one is consumed only by the operation it targets (the read, the mkdir, the
// tmp write, the rename, the serialization, an oversize body) and the fake
// counts every injection, so a fault that never reaches its operation shows up
// as a zero in the final tally instead of as a silent pass.
//
// The oracle is a MODEL of the contract, written down here and never derived
// from what the queue under test reports:
//
//   policy   the cap is 200 records and applies the moment a 201st intent is
//            accepted, whatever the disk does: the oldest leaves first, and a
//            record the cap has removed may be on the disk or not, but never a
//            younger one in its place; a record lives 15 minutes (the clock is
//            injected and a step moves it); a confirmed record is gone.
//            Nothing else may remove a record.
//   declare  the only declaration the operator gets is `status().degraded`
//            (the server answers `durable:false` from it). A record or a state
//            change accepted while the queue reports degradation is AT RISK
//            until a healthy status proves it consolidated; a confirmation
//            accepted then is the same. A restart may lose exactly that and
//            nothing else.
//
// Checked after EVERY step:
//   1. healthy → every accepted, unconfirmed, unexpired record is on the disk
//      with the accepted state (the cap has already removed, in the model, the
//      oldest ones: nothing else may be missing);
//   2. healthy → nothing else is on the disk (a confirmed record never stays
//      or comes back; only a record the cap removed may linger) and
//      status().count matches the disk;
//   3. degraded → a record that had reached the disk never vanishes, and an
//      accepted record that is off the disk or in an older state must be at
//      risk, i.e. declared;
//   4. a write fault that did not end in a successful write is never reported
//      healthy;
//   5. the file on the disk is always a valid queue file within the cap and the
//      byte budget;
//   6. a restart loses only what was declared: a persisted record or its state
//      never changes, a declared loss is the announced outcome, a confirmation
//      refused while degraded may resurface.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const {
  createNoticeDismissalQueue, SCHEMA, MAX_ENTRIES, MAX_BYTES, MAX_MS,
} = require('../lib/notify/notice-dismissal-queue.js');

const FILE = '/mem/notice-dismissal-queue.json';
const STEPS = ['RD', 'RS', 'RO', 'WF', 'WR', 'MK', 'SO', 'PO', 'E', 'U', 'C', 'T', 'A'];
const SEEDS = ['one', 'cap-1', 'cap', 'big'];

// The policy numbers the model relies on, spelled out here on purpose: the
// first test pins them to the module, so a change there is a decision, not a
// silent shift of the oracle.
const CAP = 200;
const TTL_MS = 15 * 60 * 1000;
const BYTES = 64 * 1024;
const TICK_MS = 8 * 60 * 1000; // two ticks outlive a record
const T0 = 1_700_000_000_000;
// One id this long leaves room for a single small record under the budget.
const BIG_ID_LENGTH = 65000;
const OWNER = 'a'.repeat(32);

const WRITE_KINDS = ['mkdir', 'write', 'rename', 'serialization', 'oversizeBody'];
const READ_KINDS = ['denied', 'schema', 'oversizeRead'];

function makeFakeFs() {
  const disk = new Map();
  // Faults are armed by counters and consumed only by their own operation.
  const armed = Object.fromEntries([...READ_KINDS, ...WRITE_KINDS].map((k) => [k, 0]));
  const injected = Object.fromEntries(Object.keys(armed).map((k) => [k, 0]));
  let renamesToFile = 0;
  const take = (kind) => {
    if (armed[kind] <= 0) return false;
    armed[kind] -= 1;
    injected[kind] += 1;
    return true;
  };
  const denied = (what) => { const e = new Error(`${what} denied`); e.code = 'EACCES'; return e; };
  const missing = () => { const e = new Error('no file'); e.code = 'ENOENT'; return e; };
  return {
    arm(kind) { armed[kind] += 1; },
    take,
    injected,
    injectedWrites() { return WRITE_KINDS.reduce((n, k) => n + injected[k], 0); },
    renames() { return renamesToFile; },
    preload(p, body) { disk.set(p, body); },
    peek(p) { return disk.has(p) ? disk.get(p) : null; },
    readFileSync(p) {
      if (p === FILE) {
        if (take('denied')) throw denied('read');
        if (take('schema')) return JSON.stringify({ schema: 'wrong-v1', entries: [] });
        if (take('oversizeRead')) return 'x'.repeat(300000);
      }
      if (!disk.has(p)) throw missing();
      return disk.get(p);
    },
    mkdirSync() {
      if (take('mkdir')) throw denied('mkdir');
    },
    writeFileSync(p, body) {
      if (take('write')) throw denied('write');
      disk.set(p, String(body));
    },
    renameSync(a, b) {
      if (take('rename')) throw denied('rename');
      if (!disk.has(a)) throw missing();
      disk.set(b, disk.get(a));
      disk.delete(a);
      if (b === FILE) renamesToFile += 1;
    },
  };
}

// Installs the fake over fs (and the serialization hook over JSON.stringify,
// scoped to the queue's own payload) and returns the undo.
function installFake(fake) {
  const original = {
    read: fs.readFileSync, write: fs.writeFileSync, rename: fs.renameSync,
    mkdir: fs.mkdirSync, stringify: JSON.stringify,
  };
  fs.readFileSync = fake.readFileSync;
  fs.writeFileSync = fake.writeFileSync;
  fs.renameSync = fake.renameSync;
  fs.mkdirSync = fake.mkdirSync;
  JSON.stringify = function (value, replacer, space) {
    if (value && value.schema === SCHEMA) {
      if (fake.take('serialization')) { const e = new Error('serialization denied'); e.code = 'EACCES'; throw e; }
      // A body that really is over the budget: the queue's own size check has
      // to refuse it, nothing is faked on that side.
      if (fake.take('oversizeBody')) return original.stringify.call(JSON, { ...value, pad: 'x'.repeat(2 * BYTES) }, replacer, space);
    }
    return original.stringify.call(JSON, value, replacer, space);
  };
  return () => {
    fs.readFileSync = original.read;
    fs.writeFileSync = original.write;
    fs.renameSync = original.rename;
    fs.mkdirSync = original.mkdir;
    JSON.stringify = original.stringify;
  };
}

function seedIds(mode) {
  if (mode === 'cap-1' || mode === 'cap') {
    const n = mode === 'cap' ? CAP : CAP - 1;
    return Array.from({ length: n }, (_, i) => `old-${i}`);
  }
  return [mode === 'big' ? 'b'.repeat(BIG_ID_LENGTH) : 'old'];
}

// The seeds are built once, by the queue itself, on a healthy fake disk: every
// sequence then starts from a copy of the file the queue wrote.
const seedCache = new Map();
function seedFor(mode) {
  if (seedCache.has(mode)) return seedCache.get(mode);
  const fake = makeFakeFs();
  const restore = installFake(fake);
  try {
    const ids = seedIds(mode);
    const queue = createNoticeDismissalQueue({ filePath: FILE, now: () => T0 });
    for (const eventId of ids) assert.equal(queue.enqueue({ ownerId: OWNER, eventId }).ok, true);
    const raw = fake.peek(FILE);
    assert.ok(raw !== null, `the ${mode} seed reached the disk`);
    assert.deepStrictEqual(JSON.parse(raw).entries.map((e) => e.eventId), ids, `the ${mode} seed is exactly what the disk holds`);
    const seeded = { ids, raw };
    seedCache.set(mode, seeded);
    return seeded;
  } finally { restore(); }
}

function newStats() {
  return {
    sequences: 0, checkpoints: 0, healthyChecks: 0, injected: {}, naturalOversize: 0,
    capEvictions: 0, ttlExpired: 0, confirmedAbsent: 0, declaredLosses: 0, stateAdopted: 0, resurrected: 0,
  };
}

function runSequence(steps, seedMode, stats) {
  const violations = [];
  const fail = (message) => { violations.push(message); };
  const seeded = seedFor(seedMode);
  const fake = makeFakeFs();
  fake.preload(FILE, seeded.raw);
  const restore = installFake(fake);
  try {
    let clock = T0;
    const now = () => clock;
    let q = createNoticeDismissalQueue({ filePath: FILE, now });

    let nextSeq = 0;
    const universe = new Map();   // every id ever accepted or seeded -> { at, seq }
    const accepted = new Map();   // accepted, unconfirmed, believed alive -> { syncState, attempts }
    for (const id of seeded.ids) {
      universe.set(id, { at: T0, seq: nextSeq += 1 });
      accepted.set(id, { syncState: 'pending', attempts: 0 });
    }
    const persisted = new Set(seeded.ids); // ids seen on the disk and since neither confirmed nor explained away
    const atRisk = new Set();              // accepted while degradation was declared, not yet consolidated
    const confirmed = new Set();           // confirmed and expected off the disk
    const confirmedAtRisk = new Set();     // confirmed while degradation was declared
    const policyEvicted = new Set();       // removed by the cap in the model: may linger on the disk
    let lastAccepted = null;
    let nextId = 0;

    const expired = (id) => { const u = universe.get(id); return !!u && clock >= u.at + TTL_MS; };
    const readDisk = () => {
      const out = new Map();
      const raw = fake.peek(FILE);
      if (raw === null) return out;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (_) { /* reported below */ }
      if (!parsed || parsed.schema !== SCHEMA || !Array.isArray(parsed.entries)) { fail('the queue file on the disk is not a valid queue file'); return out; }
      for (const e of parsed.entries) out.set(e.eventId, e);
      if (out.size !== parsed.entries.length) fail('the queue file on the disk holds a duplicate record');
      if (parsed.entries.length > CAP) fail(`the queue file on the disk holds ${parsed.entries.length} records, over the cap`);
      if (Buffer.byteLength(raw, 'utf8') > BYTES) fail('the queue file on the disk is over the byte budget');
      return out;
    };
    // A restart re-bases the truth on the disk, but only for what was declared.
    const restart = () => {
      q = createNoticeDismissalQueue({ filePath: FILE, now });
      const disk = readDisk();
      for (const [id, model] of [...accepted]) {
        const rec = disk.get(id);
        if (expired(id)) { accepted.delete(id); persisted.delete(id); stats.ttlExpired += 1; continue; }
        if (rec) {
          if (atRisk.has(id)) {
            if (rec.syncState !== model.syncState || (rec.attempts || 0) !== model.attempts) stats.stateAdopted += 1;
            accepted.set(id, { syncState: rec.syncState, attempts: rec.attempts || 0 });
          } else if (rec.syncState !== model.syncState || (rec.attempts || 0) !== model.attempts) {
            fail(`restart changed the state of ${id} and nothing declared it`);
          }
        } else if (persisted.has(id)) {
          fail(`restart lost ${id}, a record that had reached the disk`);
        } else if (atRisk.has(id)) {
          accepted.delete(id);
          stats.declaredLosses += 1;
        } else {
          fail(`restart lost ${id} and its loss was never declared`);
        }
      }
      for (const [id, rec] of disk) {
        if (!universe.has(id)) { fail(`an unknown record is on the disk after the restart: ${id}`); continue; }
        if (accepted.has(id) || expired(id)) continue;
        if (confirmedAtRisk.has(id) || policyEvicted.has(id)) {
          // The refused write left it where it was (the announced outcome), or
          // the cap removed it in memory and the disk never heard of it: the
          // new instance reads it back as a plain record.
          accepted.set(id, { syncState: rec.syncState, attempts: rec.attempts || 0 });
          persisted.add(id);
          confirmed.delete(id);
          policyEvicted.delete(id);
          stats.resurrected += 1;
        } else {
          fail(`a record nobody has accepted is on the disk after the restart: ${id}`);
        }
      }
      atRisk.clear();
      confirmedAtRisk.clear();
    };

    for (const step of steps) {
      const writeFaultsBefore = fake.injectedWrites();
      const renamesBefore = fake.renames();
      let touchedRisk = null;
      let touchedConfirmed = null;

      if (step === 'RD') fake.arm('denied');
      else if (step === 'RS') fake.arm('schema');
      else if (step === 'RO') fake.arm('oversizeRead');
      else if (step === 'WF') fake.arm('rename');
      else if (step === 'WR') fake.arm('write');
      else if (step === 'MK') fake.arm('mkdir');
      else if (step === 'SO') fake.arm('serialization');
      else if (step === 'PO') fake.arm('oversizeBody');
      else if (step === 'A') clock += TICK_MS;
      else if (step === 'E') {
        const eventId = `e${nextId += 1}`;
        const out = q.enqueue({ ownerId: OWNER, eventId });
        if (out.ok) {
          universe.set(eventId, { at: clock, seq: nextSeq += 1 });
          accepted.set(eventId, { syncState: 'pending', attempts: 0 });
          lastAccepted = eventId;
          touchedRisk = eventId;
          // The cap policy, applied by the model the moment it is exceeded.
          while (accepted.size > CAP) {
            let oldest = null;
            for (const id of accepted.keys()) if (oldest === null || universe.get(id).seq < universe.get(oldest).seq) oldest = id;
            accepted.delete(oldest);
            persisted.delete(oldest);
            atRisk.delete(oldest);
            policyEvicted.add(oldest);
            stats.capEvictions += 1;
          }
        } else fail(`a fresh valid record was refused: ${JSON.stringify(out)}`);
      } else if (step === 'U') {
        if (lastAccepted && accepted.has(lastAccepted)) {
          const attempts = accepted.get(lastAccepted).attempts + 7;
          const out = q.update(OWNER, lastAccepted, { syncState: 'blocked', attempts, lastReason: 'probe' });
          // An instance whose load failed does not know the records the disk
          // holds: it answers unknown and changes nothing.
          if (out.ok) { accepted.set(lastAccepted, { syncState: 'blocked', attempts }); touchedRisk = lastAccepted; }
        }
      } else if (step === 'C') {
        if (lastAccepted && accepted.has(lastAccepted)) {
          const id = lastAccepted;
          const out = q.confirm(OWNER, id);
          if (out.ok) { accepted.delete(id); atRisk.delete(id); confirmed.add(id); touchedConfirmed = id; }
          lastAccepted = null;
        }
      } else if (step === 'T') {
        restart();
      }

      // ---- checkpoint -------------------------------------------------------
      stats.checkpoints += 1;
      for (const id of [...accepted.keys()]) {
        if (expired(id)) { accepted.delete(id); persisted.delete(id); atRisk.delete(id); stats.ttlExpired += 1; }
      }
      let status;
      try { status = q.status(); } catch (error) { fail(`status() threw: ${error.message}`); continue; }
      const healthy = status.degraded === null;
      if (!healthy) {
        if (touchedRisk) atRisk.add(touchedRisk);
        if (touchedConfirmed) confirmedAtRisk.add(touchedConfirmed);
        if (status.degraded === 'queue-oversize' && seedMode === 'big' && fake.injected.oversizeBody === 0 && fake.injected.oversizeRead === 0) stats.naturalOversize += 1;
      }
      // 4. a write fault that ended in no successful write is never healthy.
      if (healthy && fake.injectedWrites() > writeFaultsBefore && fake.renames() === renamesBefore) {
        fail(`a write fault was injected in step ${step} and the queue reports healthy`);
      }

      const disk = readDisk();
      for (const id of disk.keys()) if (!expired(id)) persisted.add(id);
      for (const [id, model] of [...accepted]) {
        const rec = disk.get(id);
        if (rec) {
          // 1/3. on the disk: the accepted state, unless that change is at risk.
          if (healthy || !atRisk.has(id)) {
            if (rec.syncState !== model.syncState) fail(`the disk state outranks the accepted one for ${id}`);
            if ((rec.attempts || 0) !== model.attempts) fail(`the disk attempts outrank the accepted ones for ${id}`);
          }
        } else if (healthy) {
          // 1. off the disk of a healthy queue: the cap already took the oldest
          //    ones out of the model, nothing else may be missing.
          fail(`healthy report with an accepted record off the disk: ${id}`);
        } else if (persisted.has(id)) {
          // 3. only a successful write can remove a record from the disk.
          fail(`a record that was on the disk vanished while degradation is declared: ${id}`);
        } else if (!atRisk.has(id)) {
          fail(`an accepted record is off the disk and nobody declared it: ${id}`);
        }
      }
      // 2. nothing but accepted records is on the disk.
      for (const id of disk.keys()) {
        if (!universe.has(id)) { fail(`an unknown record is on the disk: ${id}`); continue; }
        if (accepted.has(id) || expired(id) || policyEvicted.has(id)) continue;
        if (!healthy && confirmedAtRisk.has(id)) continue; // announced: the refused write left it where it was
        fail(healthy ? `a confirmed or removed record is on the disk of a healthy queue: ${id}` : `a removed record is on the disk: ${id}`);
      }
      if (healthy) {
        stats.healthyChecks += 1;
        for (const id of confirmed) if (!disk.has(id)) stats.confirmedAbsent += 1;
        const live = [...disk.keys()].filter((id) => !expired(id)).length;
        if (status.count !== live) fail(`status().count is ${status.count} and the disk holds ${live}`);
        // Everything above held for every accepted record: nothing is at risk any more.
        atRisk.clear();
        confirmedAtRisk.clear();
      }
    }
    for (const [kind, n] of Object.entries(fake.injected)) stats.injected[kind] = (stats.injected[kind] || 0) + n;
  } finally { restore(); }
  stats.sequences += 1;
  return violations;
}

function allSequences() {
  const sequences = [];
  for (const a of STEPS) for (const b of STEPS) for (const seedMode of SEEDS) sequences.push([a, b, seedMode]);
  for (const a of STEPS) for (const b of STEPS) for (const c of STEPS) for (const seedMode of SEEDS) sequences.push([a, b, c, seedMode]);
  for (const a of STEPS) for (const b of STEPS) for (const c of STEPS) for (const d of STEPS) sequences.push([a, b, c, d, 'one']);
  return sequences;
}

test('the oracle model uses the numbers the module really has', () => {
  assert.equal(MAX_ENTRIES, CAP);
  assert.equal(MAX_BYTES, BYTES);
  assert.equal(MAX_MS, TTL_MS);
  assert.ok(2 * TICK_MS >= TTL_MS && TICK_MS < TTL_MS, 'two ticks outlive a record, one does not');
});

test('the big seed reaches the real byte budget with a small record', () => {
  const fake = makeFakeFs();
  const seeded = seedFor('big');
  fake.preload(FILE, seeded.raw);
  const restore = installFake(fake);
  try {
    assert.ok(Buffer.byteLength(seeded.raw, 'utf8') <= BYTES, 'the seed itself fits');
    const q = createNoticeDismissalQueue({ filePath: FILE, now: () => T0 });
    q.enqueue({ ownerId: OWNER, eventId: 'e1' });
    assert.equal(q.status().degraded, null, 'one small record still fits');
    q.enqueue({ ownerId: OWNER, eventId: 'e2' });
    assert.equal(q.status().degraded, 'queue-oversize', 'the next one is refused by the real byte budget');
  } finally { restore(); }
});

test('each injected fault reaches its own operation, is declared, leaves the disk alone and is recovered from', () => {
  const reasons = {
    mkdir: 'queue-write-failed', write: 'queue-write-failed', rename: 'queue-write-failed',
    serialization: 'queue-write-failed', oversizeBody: 'queue-oversize',
  };
  for (const [kind, reason] of Object.entries(reasons)) {
    const fake = makeFakeFs();
    const seeded = seedFor('one');
    fake.preload(FILE, seeded.raw);
    const restore = installFake(fake);
    try {
      const q = createNoticeDismissalQueue({ filePath: FILE, now: () => T0 });
      fake.arm(kind);
      assert.equal(q.enqueue({ ownerId: OWNER, eventId: 'e1' }).ok, true, `${kind}: the intent is honoured in memory`);
      assert.equal(fake.injected[kind], 1, `${kind}: the fault reached its operation`);
      assert.equal(fake.renames(), 0, `${kind}: nothing was renamed over the queue file`);
      assert.equal(q.status().degraded, reason, `${kind}: the failure is declared`);
      assert.equal(fake.peek(FILE), seeded.raw, `${kind}: the file on the disk is untouched`);
      q.enqueue({ ownerId: OWNER, eventId: 'e2' });
      assert.equal(q.status().degraded, null, `${kind}: the next write recovers`);
      assert.deepStrictEqual(JSON.parse(fake.peek(FILE)).entries.map((e) => e.eventId), ['old', 'e1', 'e2'], `${kind}: the recovery writes everything`);
    } finally { restore(); }
  }
  const readReasons = { denied: 'queue-read-failed', schema: 'queue-schema', oversizeRead: 'queue-oversize' };
  for (const [kind, reason] of Object.entries(readReasons)) {
    const fake = makeFakeFs();
    const seeded = seedFor('one');
    fake.preload(FILE, seeded.raw);
    const restore = installFake(fake);
    try {
      fake.arm(kind);
      const q = createNoticeDismissalQueue({ filePath: FILE, now: () => T0 });
      assert.equal(q.status().degraded, reason, `${kind}: the load failure is declared`);
      assert.equal(fake.injected[kind], 1, `${kind}: the fault reached the read`);
      assert.equal(fake.peek(FILE), seeded.raw, `${kind}: the file on the disk is untouched`);
    } finally { restore(); }
  }
});

test('every short operation sequence keeps the durability, precedence and confirmed-removal invariants', () => {
  const failing = [];
  const sequences = allSequences();
  assert.equal(sequences.length, (STEPS.length ** 2 + STEPS.length ** 3) * SEEDS.length + STEPS.length ** 4,
    'the sweep covers every sequence up to 4 steps (4 steps on the single-record seed)');
  const stats = newStats();

  for (const steps of sequences) {
    const seedMode = steps.pop();
    const violations = runSequence(steps, seedMode, stats);
    if (violations.length > 0) failing.push(`${steps.join(' ')} [${seedMode}]: ${violations[0]}`);
  }
  console.log('SEQ-STATS', JSON.stringify(stats));
  if (failing.length > 0) {
    console.log('SEQ-FAILURES', JSON.stringify({ count: failing.length, of: sequences.length, sample: failing.slice(0, 24) }, null, 1));
  }
  assert.deepEqual(failing, [], `${failing.length} of ${sequences.length} sequences violated the invariants`);

  // The sweep must really have exercised what it claims: every fault reached
  // its operation, the cap and the clock removed records, the checks that
  // looked for a confirmed record ran, and a restart lost declared records.
  for (const kind of [...READ_KINDS, ...WRITE_KINDS]) assert.ok(stats.injected[kind] > 0, `the ${kind} fault was never injected`);
  assert.ok(stats.naturalOversize > 0, 'the real byte budget was never reached');
  assert.ok(stats.capEvictions > 0, 'the cap policy never removed a record');
  assert.ok(stats.ttlExpired > 0, 'the clock never expired a record');
  assert.ok(stats.confirmedAbsent > 0, 'no healthy checkpoint ever verified a confirmed record absent');
  assert.ok(stats.declaredLosses > 0, 'no restart ever lost a declared record');
  assert.ok(stats.stateAdopted > 0, 'no restart ever adopted a declared older state');
  assert.ok(stats.resurrected > 0, 'no confirmation refused while degraded ever resurfaced');
});
