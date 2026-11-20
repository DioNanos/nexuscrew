'use strict';
// OS-level regression for the per-instance node runtime isolation.
//
// Two REAL child processes of the same user share one TMPDIR (and, in the
// second scenario, one home). Each child is a fresh module incarnation: it
// qualifies the real runtime of its own process, publishes the per-home
// node pin once per call and, in "cycle" mode, removes only its own objects
// after every publication. Before the per-instance perimeter this exact
// shape made the warm reader refuse with PIN_REREAD, because the sibling's
// link/unlink mutated the shared snapshot inode's ctime during the stable
// read.
//
// Oracle: zero refusals in BOTH processes and the (dev,ino) sets of the
// node paths (snapshot and published finals) of the two instances disjoint.
// The identities are recorded while the objects exist; the warm side keeps
// its objects alive for the whole scenario, so a match is real sharing and
// not a recycled inode.
//
// The reduced form (1 run x 10 calls per process) always runs, no skip; the
// full form (3 runs x 40 calls) runs when NEXUSCREW_NODE_ISOLATION_FULL=1.
// Every run uses its own temporary directory and removes at the end only
// what it created.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RUNTIME_MODULE = path.join(__dirname, '..', 'lib', 'fleet', 'vl-node-runtime.js');

const ENV_FULL_VALUE = Object.prototype.hasOwnProperty.call(process.env, 'NEXUSCREW_NODE_ISOLATION_FULL')
  ? process.env.NEXUSCREW_NODE_ISOLATION_FULL
  : null;
const FULL = ENV_FULL_VALUE === '1';
const MODE = FULL ? 'full' : 'reduced';
const RUNS = FULL ? 3 : 1;
const CALLS = FULL ? 40 : 10;
const BARRIER_DEADLINE_MS = FULL ? 180000 : 60000;
const EXPECTED_TOTAL_SUCCEEDED = 2 * RUNS * 2 * CALLS; // 40 reduced, 480 full

const CHILD_PROGRAM = `
'use strict';
// One module incarnation driven by explicit stdin barriers: qualifies the
// real runtime of this process, executes requested claim batches, reports
// progress + live object identities over stdout, and removes only its own
// objects when instructed in "cycle" mode.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const runtime = require(process.env.TEST_ISO_MODULE);

const home = process.env.TEST_ISO_HOME;
const mode = process.env.TEST_ISO_MODE;
const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });

function idOf(p) {
  const st = fs.lstatSync(p);
  return st.dev + ':' + st.ino;
}
function emit(o) {
  process.stdout.write(JSON.stringify(o) + '\\n');
}

const ids = new Set();
let requested = 0;
let completed = 0;
let succeeded = 0;
let refusals = 0;
let snapshotPath = null;
let namespacePath = null;
let removed = null;

function runBatch(count) {
  requested += count;
  for (let i = 0; i < count; i += 1) {
    completed += 1;
    const q = runtime.qualifica();
    if (!q.ok) {
      refusals += 1;
      emit({ t: 'refusal', phase: 'qualifica', code: q.code || null, motivo: q.motivo || null });
      continue;
    }
    snapshotPath = q.path;
    const p = runtime.pubblica(q, staging);
    if (!p.ok) {
      refusals += 1;
      emit({ t: 'refusal', phase: 'publish', code: p.code || null });
      continue;
    }
    namespacePath = path.dirname(p.path);
    ids.add(idOf(q.path));
    ids.add(idOf(p.path));
    if (mode === 'cycle') {
      try {
        fs.unlinkSync(p.path);
      } catch (e) {
        refusals += 1;
        emit({ t: 'refusal', phase: 'removal', code: (e && e.code) || null });
        continue;
      }
    }
    succeeded += 1;
  }
  emit({
    t: 'progress',
    pid: process.pid,
    requested,
    completed,
    succeeded,
    refusals,
    ids: Array.from(ids),
  });
}

function runCleanup() {
  if (mode === 'cycle' && snapshotPath && namespacePath) {
    try {
      fs.rmdirSync(namespacePath);
      fs.unlinkSync(snapshotPath);
      fs.rmdirSync(path.dirname(snapshotPath));
      removed = true;
    } catch (_) {
      removed = false;
    }
  }
  emit({ t: 'cleaned', pid: process.pid, removed });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (raw) => {
  if (!raw.trim()) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    emit({ t: 'error', error: String(e) });
    process.exit(2);
    return;
  }
  if (msg.cmd === 'run') {
    runBatch(Number(msg.count));
  } else if (msg.cmd === 'cleanup') {
    runCleanup();
  } else if (msg.cmd === 'finish') {
    emit({
      t: 'done',
      pid: process.pid,
      requested,
      completed,
      succeeded,
      refusals,
      ids: Array.from(ids),
      removed,
    });
    rl.close();
  }
});

rl.on('close', () => {
  process.exit(0);
});

emit({ t: 'ready', pid: process.pid });
`;

function startChild(childPath, sharedTmp, { home, mode, label }) {
  const child = spawn(process.execPath, [childPath], {
    env: {
      ...process.env,
      TMPDIR: sharedTmp,
      TEST_ISO_MODULE: RUNTIME_MODULE,
      TEST_ISO_HOME: home,
      TEST_ISO_MODE: mode,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let closedInfo = null;
  const events = [];
  const waiters = [];

  function notifyWaiters() {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i];
      const match = events.find((e, idx) => idx >= w.from && w.predicate(e));
      if (match) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(match);
      } else if (closedInfo) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.reject(new Error(`${label}: exited early rc=${closedInfo.code} signal=${closedInfo.signal} err=${err.slice(0, 500)}`));
      }
    }
  }

  child.stdout.on('data', (chunk) => {
    out += chunk.toString('utf8');
    let nl;
    while ((nl = out.indexOf('\n')) >= 0) {
      const raw = out.slice(0, nl);
      out = out.slice(nl + 1);
      if (!raw.trim()) continue;
      let entry;
      try { entry = JSON.parse(raw); } catch (_) { continue; }
      events.push(entry);
    }
    notifyWaiters();
  });
  child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });

  const closed = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      closedInfo = { code, signal, err };
      notifyWaiters();
      resolve({ pid: child.pid, code, signal, err, events });
    });
  });

  function waitEvent(predicate, desc, fromIndex = 0) {
    const existing = events.find((e, idx) => idx >= fromIndex && predicate(e));
    if (existing) return Promise.resolve(existing);
    if (closedInfo) {
      return Promise.reject(new Error(`${label} (${desc}): exited rc=${closedInfo.code} signal=${closedInfo.signal}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        try { child.kill('SIGKILL'); } catch (_) { /* already dead */ }
        reject(new Error(`${label}: deadline (${BARRIER_DEADLINE_MS}ms) waiting for ${desc}`));
      }, BARRIER_DEADLINE_MS);
      waiters.push({ from: fromIndex, predicate, resolve, reject, timer });
    });
  }

  function send(msg) {
    assert.equal(closedInfo, null, `${label}: cannot send ${msg.cmd} to closed child`);
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  function cursor() {
    return events.length;
  }

  async function finishAndClose() {
    const cur = cursor();
    send({ cmd: 'finish' });
    await waitEvent((e) => e.t === 'done', 'done', cur);
    return closed;
  }

  function forceKill() {
    if (!closedInfo) {
      try { child.kill('SIGKILL'); } catch (_) { /* best effort */ }
    }
  }

  return {
    pid: child.pid,
    events,
    cursor,
    send,
    waitEvent,
    finishAndClose,
    forceKill,
    closed,
  };
}

const runRecords = [];

function checkDisjoint(idsA, idsB, context) {
  const shared = idsA.filter((id) => idsB.includes(id));
  assert.equal(shared.length, 0, `${context}: node inodes shared: ${shared.join(', ')}`);
  return true;
}

function assertCleanChild(doneInfo, expectedCalls, label) {
  assert.equal(doneInfo.code, 0, `${label}: rc=${doneInfo.code} signal=${doneInfo.signal} err=${doneInfo.err}`);
  const summary = doneInfo.events.find((e) => e.t === 'done') || null;
  assert.ok(summary, `${label}: missing done summary`);
  assert.equal(summary.requested, expectedCalls, `${label}: requested mismatch`);
  assert.equal(summary.completed, expectedCalls, `${label}: completed mismatch`);
  assert.equal(summary.succeeded, expectedCalls, `${label}: succeeded mismatch`);
  assert.equal(summary.refusals, 0, `${label}: unexpected refusals: ${JSON.stringify(doneInfo.events.filter((e) => e.t === 'refusal'))}`);
  return summary;
}

function emitRecord(record) {
  runRecords.push(record);
  console.log(JSON.stringify({ kind: 'nc-node-isolation-iteration', ...record }));
}

async function scenarioDistinctHomes(iteration) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-isol-os-'));
  let a = null;
  let b = null;
  try {
    const sharedTmp = path.join(base, 'tmp');
    fs.mkdirSync(sharedTmp, { mode: 0o700 });
    const childPath = path.join(base, 'child.js');
    fs.writeFileSync(childPath, CHILD_PROGRAM, { mode: 0o700 });
    const homeA = path.join(base, 'home-a');
    const homeB = path.join(base, 'home-b');
    fs.mkdirSync(homeA, { recursive: true, mode: 0o700 });
    fs.mkdirSync(homeB, { recursive: true, mode: 0o700 });

    const barriers = {
      aReady: false,
      aWarmed: false,
      bReady: false,
      bCycledWhileAAlive: false,
      disjointBeforeCleanup: false,
      bCleaned: false,
      aWarmAfterBCleanup: false,
    };

    a = startChild(childPath, sharedTmp, { home: homeA, mode: 'warm', label: 'distinct_homes A' });
    await a.waitEvent((e) => e.t === 'ready', 'A ready');
    barriers.aReady = true;

    let aCur = a.cursor();
    a.send({ cmd: 'run', count: 1 });
    const aWarm = await a.waitEvent((e) => e.t === 'progress', 'A initial warm batch', aCur);
    assert.equal(aWarm.succeeded, 1);
    assert.equal(aWarm.refusals, 0);
    barriers.aWarmed = true;

    b = startChild(childPath, sharedTmp, { home: homeB, mode: 'cycle', label: 'distinct_homes B' });
    await b.waitEvent((e) => e.t === 'ready', 'B ready');
    barriers.bReady = true;

    let bCur = b.cursor();
    b.send({ cmd: 'run', count: CALLS });
    const bProg = await b.waitEvent((e) => e.t === 'progress', 'B full cycle batch while A alive', bCur);
    assert.equal(bProg.succeeded, CALLS);
    assert.equal(bProg.refusals, 0);
    barriers.bCycledWhileAAlive = true;

    const disjoint = checkDisjoint(aWarm.ids, bProg.ids, 'distinct_homes (live before cleanup)');
    barriers.disjointBeforeCleanup = disjoint;

    bCur = b.cursor();
    b.send({ cmd: 'cleanup' });
    const bClean = await b.waitEvent((e) => e.t === 'cleaned', 'B cleanup', bCur);
    assert.equal(bClean.removed, true, 'distinct_homes: B must remove its own resources');
    barriers.bCleaned = true;
    const bDone = await b.finishAndClose();
    const sb = assertCleanChild(bDone, CALLS, 'distinct_homes B');
    assert.equal(sb.removed, true);

    aCur = a.cursor();
    a.send({ cmd: 'run', count: CALLS - 1 });
    const aAfter = await a.waitEvent((e) => e.t === 'progress', 'A warm reuse after B cleanup', aCur);
    assert.equal(aAfter.succeeded, CALLS);
    assert.equal(aAfter.refusals, 0);
    barriers.aWarmAfterBCleanup = true;

    const aDone = await a.finishAndClose();
    const sa = assertCleanChild(aDone, CALLS, 'distinct_homes A');

    emitRecord({
      mode: MODE,
      envFullValue: ENV_FULL_VALUE,
      runs: RUNS,
      callsPerChild: CALLS,
      deadlineMs: BARRIER_DEADLINE_MS,
      scenario: 'distinct_homes',
      iteration,
      homeLabel: 'distinct',
      uid: typeof process.getuid === 'function' ? process.getuid() : 0,
      sharedTmpdir: sharedTmp,
      barriers,
      children: [
        {
          role: 'A',
          pid: sa.pid,
          rc: aDone.code,
          signal: aDone.signal,
          requested: sa.requested,
          completed: sa.completed,
          succeeded: sa.succeeded,
          refusals: sa.refusals,
          removed: sa.removed,
        },
        {
          role: 'B',
          pid: sb.pid,
          rc: bDone.code,
          signal: bDone.signal,
          requested: sb.requested,
          completed: sb.completed,
          succeeded: sb.succeeded,
          refusals: sb.refusals,
          removed: sb.removed,
        },
      ],
      disjoint,
    });
  } finally {
    if (a) a.forceKill();
    if (b) b.forceKill();
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

async function scenarioSameHome(iteration) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-isol-sh-'));
  let a = null;
  let b = null;
  try {
    const sharedTmp = path.join(base, 'tmp');
    fs.mkdirSync(sharedTmp, { mode: 0o700 });
    const childPath = path.join(base, 'child.js');
    fs.writeFileSync(childPath, CHILD_PROGRAM, { mode: 0o700 });
    const home = path.join(base, 'home');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });

    const barriers = {
      bothReady: false,
      simultaneousGo: false,
      bCycledWhileAAlive: false,
      disjointBeforeCleanup: false,
      bCleaned: false,
      aWarmAfterBCleanup: false,
    };

    a = startChild(childPath, sharedTmp, { home, mode: 'warm', label: 'same_home A' });
    b = startChild(childPath, sharedTmp, { home, mode: 'cycle', label: 'same_home B' });
    await Promise.all([
      a.waitEvent((e) => e.t === 'ready', 'A ready'),
      b.waitEvent((e) => e.t === 'ready', 'B ready'),
    ]);
    barriers.bothReady = true;

    let aCur = a.cursor();
    let bCur = b.cursor();
    a.send({ cmd: 'run', count: CALLS - 1 });
    b.send({ cmd: 'run', count: CALLS });
    barriers.simultaneousGo = true;

    const [aProg, bProg] = await Promise.all([
      a.waitEvent((e) => e.t === 'progress', 'A concurrent cold+warm batch', aCur),
      b.waitEvent((e) => e.t === 'progress', 'B concurrent cold+cycle batch', bCur),
    ]);
    assert.equal(aProg.succeeded, CALLS - 1);
    assert.equal(bProg.succeeded, CALLS);
    assert.equal(aProg.refusals, 0);
    assert.equal(bProg.refusals, 0);
    barriers.bCycledWhileAAlive = true;

    const disjoint = checkDisjoint(aProg.ids, bProg.ids, 'same_home (live before cleanup)');
    barriers.disjointBeforeCleanup = disjoint;

    bCur = b.cursor();
    b.send({ cmd: 'cleanup' });
    const bClean = await b.waitEvent((e) => e.t === 'cleaned', 'B cleanup', bCur);
    assert.equal(bClean.removed, true, 'same_home: B must remove its own resources');
    barriers.bCleaned = true;
    const bDone = await b.finishAndClose();
    const sb = assertCleanChild(bDone, CALLS, 'same_home B');
    assert.equal(sb.removed, true);

    aCur = a.cursor();
    a.send({ cmd: 'run', count: 1 });
    const aAfter = await a.waitEvent((e) => e.t === 'progress', 'A warm reuse after B cleanup', aCur);
    assert.equal(aAfter.succeeded, CALLS);
    assert.equal(aAfter.refusals, 0);
    barriers.aWarmAfterBCleanup = true;

    const aDone = await a.finishAndClose();
    const sa = assertCleanChild(aDone, CALLS, 'same_home A');

    emitRecord({
      mode: MODE,
      envFullValue: ENV_FULL_VALUE,
      runs: RUNS,
      callsPerChild: CALLS,
      deadlineMs: BARRIER_DEADLINE_MS,
      scenario: 'same_home',
      iteration,
      homeLabel: 'shared',
      uid: typeof process.getuid === 'function' ? process.getuid() : 0,
      sharedTmpdir: sharedTmp,
      barriers,
      children: [
        {
          role: 'A',
          pid: sa.pid,
          rc: aDone.code,
          signal: aDone.signal,
          requested: sa.requested,
          completed: sa.completed,
          succeeded: sa.succeeded,
          refusals: sa.refusals,
          removed: sa.removed,
        },
        {
          role: 'B',
          pid: sb.pid,
          rc: bDone.code,
          signal: bDone.signal,
          requested: sb.requested,
          completed: sb.completed,
          succeeded: sb.succeeded,
          refusals: sb.refusals,
          removed: sb.removed,
        },
      ],
      disjoint,
    });
  } finally {
    if (a) a.forceKill();
    if (b) b.forceKill();
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

test('node isolation (os): two processes, same uid and tmpdir, distinct homes, zero refusals and disjoint dev/ino', async () => {
  for (let run = 0; run < RUNS; run += 1) {
    await scenarioDistinctHomes(run + 1);
  }
});

test('node isolation (os): same home, concurrent bootstrap and warm reuse, zero refusals and disjoint dev/ino', async () => {
  for (let run = 0; run < RUNS; run += 1) {
    await scenarioSameHome(run + 1);
  }
});

after(() => {
  if (runRecords.length !== 2 * RUNS) return;
  const totalSucceeded = runRecords.reduce(
    (sum, rec) => sum + rec.children.reduce((cSum, ch) => cSum + ch.succeeded, 0),
    0,
  );
  const totalRefusals = runRecords.reduce(
    (sum, rec) => sum + rec.children.reduce((cSum, ch) => cSum + ch.refusals, 0),
    0,
  );
  const allDisjoint = runRecords.every((rec) => rec.disjoint === true);
  assert.equal(totalSucceeded, EXPECTED_TOTAL_SUCCEEDED);
  assert.equal(totalRefusals, 0);
  assert.equal(allDisjoint, true);
  console.log(JSON.stringify({
    kind: 'nc-node-isolation-summary',
    mode: MODE,
    envFullValue: ENV_FULL_VALUE,
    runs: RUNS,
    callsPerChild: CALLS,
    deadlineMs: BARRIER_DEADLINE_MS,
    scenarios: runRecords.length,
    expectedSucceeded: EXPECTED_TOTAL_SUCCEEDED,
    totalSucceeded,
    totalRefusals,
    allDisjoint,
  }));
});
