'use strict';
// Unit of the process-level census (lib/fleet/vl-node-census.js).
//
// Everything runs in throwaway directories and child processes: never the
// installed instance, never the live Fleet, no signal to any real process.
// The real createBuiltinRuntime factory covers registration and the fence;
// synthetic readState producers cover the strict raw/live validation of
// retirement. The census is module state for the whole process, so counts
// are asserted as deltas and the poisoning/fence cases run last or in
// child processes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const census = require('../lib/fleet/vl-node-census.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');

const PERCORSO_CENSUS = require.resolve('../lib/fleet/vl-node-census.js');
const PERCORSO_RUNTIME = require.resolve('../lib/fleet/runtime.js');
const PERCORSO_V = require.resolve('../lib/fleet/vl-node-runtime.js');

function radiceTmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-census-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });
  return root;
}

// A strictly green raw close outcome of the builtin fleet close block.
function rawVerde(override = {}) {
  return {
    ok: true,
    status: 'completed',
    quiescent: true,
    disarmed: true,
    disarmedBeforeWait: true,
    elapsedMs: 1,
    budgetMs: 1500,
    timedOut: false,
    budgetExhausted: false,
    activeOpsRemaining: 0,
    activeRuntimeOpsRemaining: 0,
    activeMutationsRemaining: 0,
    writerLockHeld: false,
    writerLockReleaseAttempted: true,
    writerLockReleased: true,
    writerLockReleaseFailed: false,
    writerLockReleaseOutcome: 'released',
    brokerClosed: true,
    leaseClosed: true,
    canCleanupOwnedResources: true,
    claims: {
      disarmed: true, drainExpired: false, idle: true, timedOut: false,
      activeCount: 0, attestedActive: 0, unattestedCount: 0, code: null,
    },
    codes: [],
    ...override,
  };
}

// A synthetic live producer state: disarmed, idle and cleanup-able unless
// overridden.
function statoVerde(override = {}) {
  return {
    disarmed: true,
    inFlightOps: 0,
    canCleanupOwnedResources: true,
    activeCount: 0,
    attestedActive: 0,
    unattestedCount: 0,
    drainExpired: false,
    ...override,
  };
}

test('census: the real factory registers every runtime before first use, pin or not', (t) => {
  const root = radiceTmp(t);
  const prima = census.snapshot();
  assert.equal(prima.attestable, true);
  const rt1 = createBuiltinRuntime({ cfg: { filesRoot: path.join(root, 'uno') } });
  const dopoUno = census.snapshot();
  assert.equal(dopoUno.producers, prima.producers + 1, 'the first runtime must be censused at construction');
  assert.equal(dopoUno.claims, prima.claims);
  assert.equal(dopoUno.consumers, prima.consumers);
  assert.ok(rt1.censusToken, 'the runtime must carry its own census token');
  assert.equal(typeof rt1.censusToken, 'object');
  // A second fleet that never produced a pin is censused the same way.
  const rt2 = createBuiltinRuntime({ cfg: { filesRoot: path.join(root, 'due') } });
  const dopoDue = census.snapshot();
  assert.equal(dopoDue.producers, prima.producers + 2);
  assert.notEqual(rt1.censusToken, rt2.censusToken);
  // A shutdown without the attested fleet close does NOT retire: the
  // producer stays censused until its close attests.
  rt1.shutdown();
  rt2.shutdown();
  assert.equal(census.snapshot().producers, prima.producers + 2);
  assert.equal(census.snapshot().admissionClosed, false);
});

test('census: snapshot is a fresh frozen record and never resets', (t) => {
  const root = radiceTmp(t);
  const s1 = census.snapshot();
  assert.ok(Object.isFrozen(s1));
  const rt = createBuiltinRuntime({ cfg: { filesRoot: path.join(root, 'tre') } });
  const s2 = census.snapshot();
  assert.equal(s2.producers, s1.producers + 1);
  // A new home/filesRoot does not reset the census: the same process keeps
  // counting its producers.
  const rtAltro = createBuiltinRuntime({ cfg: { filesRoot: path.join(root, 'quattro') } });
  assert.equal(census.snapshot().producers, s2.producers + 1);
  rt.shutdown();
  rtAltro.shutdown();
});

test('census: retirement demands a strictly green raw outcome, each negative on a fresh token', () => {
  const prima = census.snapshot().producers;
  const violazioni = [
    ['non-object raw', 'stringa'],
    ['null raw', null],
    ['array raw', []],
    ['missing disarmed', (r) => { const q = { ...r }; delete q.disarmed; return q; }],
    ['disarmed false', (r) => ({ ...r, disarmed: false })],
    ['disarmedBeforeWait false', (r) => ({ ...r, disarmedBeforeWait: false })],
    ['quiescent false', (r) => ({ ...r, quiescent: false })],
    ['timedOut true', (r) => ({ ...r, timedOut: true })],
    ['budgetExhausted true', (r) => ({ ...r, budgetExhausted: true })],
    ['activeOpsRemaining 1', (r) => ({ ...r, activeOpsRemaining: 1 })],
    ['canCleanupOwnedResources false', (r) => ({ ...r, canCleanupOwnedResources: false })],
    ['codes non-empty', (r) => ({ ...r, codes: ['OPS_DRAIN_TIMEOUT'] })],
    ['codes missing', (r) => { const q = { ...r }; delete q.codes; return q; }],
  ];
  // Every negative runs on its own FRESH token: the refusal must exercise
  // this field, not the final latch of a previous refusal on the same
  // token. A first failed attempt stays final per token.
  for (let i = 0; i < violazioni.length; i += 1) {
    const [nome, muta] = violazioni[i];
    const raw = typeof muta === 'function' ? muta(rawVerde()) : muta;
    const token = census.registerProducer(() => statoVerde());
    assert.ok(token, nome);
    assert.equal(census.retireProducer(token, raw), false, nome);
    assert.equal(census.snapshot().producers, prima + i + 1, `${nome}: the refused producer stays censused`);
    assert.equal(census.retireProducer(token, rawVerde()), false, `${nome}: no green a posteriori`);
    assert.equal(census.snapshot().producers, prima + i + 1, `${nome}: still censused after the green retry`);
  }
  // Live state violations on fresh producers refuse the same way.
  const statiCattivi = [
    ['inFlightOps 2', statoVerde({ inFlightOps: 2 })],
    ['drainExpired true', statoVerde({ drainExpired: true })],
    ['canCleanupOwnedResources false', statoVerde({ canCleanupOwnedResources: false })],
    ['disarmed false', statoVerde({ disarmed: false })],
    ['activeCount 1', statoVerde({ activeCount: 1, attestedActive: 1 })],
  ];
  for (let i = 0; i < statiCattivi.length; i += 1) {
    const [nome, cattivo] = statiCattivi[i];
    const token = census.registerProducer(() => cattivo);
    assert.ok(token, nome);
    assert.equal(census.retireProducer(token, rawVerde()), false, nome);
  }
  const dopoCattivi = census.snapshot().producers;
  assert.equal(dopoCattivi, prima + violazioni.length + statiCattivi.length);
  // A valid retirement removes the producer with no tombstone.
  const tokenOk = census.registerProducer(() => statoVerde());
  assert.equal(census.retireProducer(tokenOk, rawVerde()), true);
  assert.equal(census.snapshot().producers, dopoCattivi); // tokenOk left: exactly one less than the last count
});

test('census: retirement demands drainExpired exactly false, each case on a fresh token', () => {
  const prima = census.snapshot().producers;
  // Missing, null, 0, 'false' and true are all NOT the exact false the
  // tracker projects: a non-attested drain never authorizes a retirement.
  // Every case runs on its own FRESH token so the refusal exercises this
  // field, not the final latch of a previous refusal.
  const casi = [
    ['missing', (() => { const s = statoVerde(); delete s.drainExpired; return s; })()],
    ['null', statoVerde({ drainExpired: null })],
    ['zero', statoVerde({ drainExpired: 0 })],
    ['false string', statoVerde({ drainExpired: 'false' })],
    ['true', statoVerde({ drainExpired: true })],
  ];
  for (let i = 0; i < casi.length; i += 1) {
    const [nome, cattivo] = casi[i];
    let stato = cattivo;
    const token = census.registerProducer(() => stato);
    assert.ok(token, nome);
    assert.equal(census.retireProducer(token, rawVerde()), false, `${nome}: a non-false drainExpired must refuse`);
    assert.equal(census.snapshot().producers, prima + i + 1, `${nome}: the refused producer stays censused`);
    // The first failed attempt is final: the same token never requalifies
    // with a later green live state.
    stato = statoVerde();
    assert.equal(census.retireProducer(token, rawVerde()), false, `${nome}: no green a posteriori`);
    assert.equal(census.snapshot().producers, prima + i + 1, `${nome}: still censused after the green retry`);
  }
  // Control: exactly false retires and leaves no tombstone.
  const tokenOk = census.registerProducer(() => statoVerde());
  assert.equal(census.retireProducer(tokenOk, rawVerde()), true);
  assert.equal(census.snapshot().producers, prima + casi.length);
});

test('census: tokens are opaque object identities, forged values retire nothing', () => {
  const tokenA = census.registerProducer(() => statoVerde());
  const tokenB = census.registerProducer(() => statoVerde());
  assert.ok(tokenA && tokenB);
  for (const falso of [{}, { producer: 1 }, 'token', '1', 1, 0, null, undefined, true]) {
    assert.equal(census.retireProducer(falso, rawVerde()), false, JSON.stringify(String(falso)));
  }
  const prima = census.snapshot().producers;
  assert.equal(census.retireProducer(tokenA, rawVerde()), true);
  assert.equal(census.snapshot().producers, prima - 1);
  // An already-retired token stays inert.
  assert.equal(census.retireProducer(tokenA, rawVerde()), false);
  // B's token is not retired by A's retirement and still retires only with
  // its own green outcome.
  assert.equal(census.retireProducer(tokenB, rawVerde({ timedOut: true })), false);
  assert.equal(census.retireProducer(tokenB, rawVerde()), false, 'first failed attempt is final');
});

test('census: claims and consumers are the same conservative sum of live counts', () => {
  const prima = census.snapshot();
  assert.equal(prima.attestable, true);
  const t1 = census.registerProducer(() => statoVerde({ activeCount: 1, attestedActive: 1 }));
  const t2 = census.registerProducer(() => statoVerde({ activeCount: 2, attestedActive: 1, unattestedCount: 1 }));
  const s = census.snapshot();
  assert.equal(s.attestable, true);
  assert.equal(s.claims, prima.claims + 3);
  assert.equal(s.consumers, s.claims, 'consumers is the same conservative bound as claims');
  // A live producer never retires with a green raw: its counts are not zero.
  assert.equal(census.retireProducer(t2, rawVerde()), false);
  assert.ok(t1 && t2);
});

test('census: unreadable or incoherent readings are not attestable, each case in a fresh child', () => {
  // A poisoned producer stays in the census forever, so every variant must
  // run in its own FRESH child process: otherwise each case after the
  // first would be masked by the poison already present and would never
  // exercise its own field (the accumulated-poison version of this table
  // could not even observe a real overflow).
  const stato = (extra) => `() => ({ disarmed: true, inFlightOps: 0, canCleanupOwnedResources: true, drainExpired: false, activeCount: 0, attestedActive: 0, unattestedCount: 0, ${extra} })`;
  const casi = [
    ['throwing readState', `census.registerProducer(() => { throw new Error('boom'); });`, 1],
    ['missing state', `census.registerProducer(() => null);`, 1],
    ['non-object state', `census.registerProducer(() => 'stato');`, 1],
    ['missing counts', `census.registerProducer(() => ({ disarmed: true }));`, 1],
    ['negative count', `census.registerProducer(${stato('activeCount: -1, attestedActive: -1')});`, 1],
    ['non-integer count', `census.registerProducer(${stato('activeCount: 1.5')});`, 1],
    ['incoherent counts', `census.registerProducer(${stato('activeCount: 1, attestedActive: 0, unattestedCount: 0')});`, 1],
    // A single MAX count is still a safe integer: the SUM must overflow.
    ['overflowing sum', `census.registerProducer(${stato('activeCount: Number.MAX_SAFE_INTEGER, attestedActive: Number.MAX_SAFE_INTEGER')});`
      + ` census.registerProducer(${stato('activeCount: Number.MAX_SAFE_INTEGER, attestedActive: Number.MAX_SAFE_INTEGER')});`, 2],
  ];
  for (const [nome, pre, produttori] of casi) {
    const codice = `
'use strict';
const census = require(${JSON.stringify(PERCORSO_CENSUS)});
${pre}
const s = census.snapshot();
console.log(JSON.stringify({ s }));
`;
    const r = spawnSync(process.execPath, ['-e', codice], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `${nome}: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.s.attestable, false, nome);
    assert.equal(out.s.claims, null, nome);
    assert.equal(out.s.consumers, null, nome);
    assert.notEqual(out.s.claims, 0, nome);
    assert.equal(out.s.producers, produttori, `${nome}: exactly the case's own producers in its fresh child`);
  }
});

test('census: the admission fence seals per process and refuses new factories without effects', () => {
  const codice = `
'use strict';
const census = require(${JSON.stringify(PERCORSO_CENSUS)});
const { createBuiltinRuntime } = require(${JSON.stringify(PERCORSO_RUNTIME)});
const v = require(${JSON.stringify(PERCORSO_V)});
const owner = census.createAdmissionOwner();
const r1 = census.sealAdmission(owner);
const prima = census.snapshot();
let errore = null;
try { createBuiltinRuntime({ cfg: { filesRoot: '/tmp/nc-census-fence' } }); }
catch (e) { errore = String(e && e.message); }
const dopo = census.snapshot();
const r2 = census.sealAdmission(owner);
const altro = census.createAdmissionOwner();
const r3 = census.sealAdmission(altro);
const r4 = census.sealAdmission({});
const r5 = census.sealAdmission(null);
const registro = v.getCreationRegistry();
console.log(JSON.stringify({
  r1, prima, errore, dopo, r2, r3, r4, r5,
  nonce: registro.nonce, voci: registro.entries.length,
}));
`;
  const r = spawnSync(process.execPath, ['-e', codice], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.r1.ok, true);
  assert.equal(out.r1.already, false);
  assert.equal(out.prima.admissionClosed, true);
  assert.ok(out.errore && out.errore.includes('fence'), out.errore);
  assert.equal(out.dopo.producers, out.prima.producers, 'no new census record past the fence');
  assert.equal(out.r2.ok, true, 'the same owner reseals idempotently');
  assert.equal(out.r2.already, true);
  assert.equal(out.r3.ok, false, 'a second owner never replaces the one in charge');
  assert.equal(out.r3.reason, 'already-sealed');
  assert.equal(out.r4.ok, false);
  assert.equal(out.r4.reason, 'owner-invalid');
  assert.equal(out.r5.ok, false);
  // No effects on V: the refused factory never reached the registry.
  assert.equal(out.nonce, null);
  assert.equal(out.voci, 0);
});

test('census: a factory suspended before its registration never passes a fence closed meanwhile', () => {
  const codice = `
'use strict';
const census = require(${JSON.stringify(PERCORSO_CENSUS)});
const { createBuiltinRuntime } = require(${JSON.stringify(PERCORSO_RUNTIME)});
const owner = census.createAdmissionOwner();
let sealedDuringConstruction = false;
// The getter fires during the factory, BEFORE the census registration: the
// seal happens while the factory is in progress and suspended right there.
const cfg = {
  filesRoot: '/tmp/nc-census-sospesa',
  get nowMono() {
    if (!sealedDuringConstruction) { census.sealAdmission(owner); sealedDuringConstruction = true; }
    return () => 0;
  },
};
let errore = null;
try { createBuiltinRuntime({ cfg }); } catch (e) { errore = String(e && e.message); }
const s = census.snapshot();
console.log(JSON.stringify({ sealedDuringConstruction, errore, producers: s.producers, admissionClosed: s.admissionClosed }));
`;
  const r = spawnSync(process.execPath, ['-e', codice], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.sealedDuringConstruction, true);
  assert.ok(out.errore && out.errore.includes('fence'), out.errore);
  assert.equal(out.producers, 0, 'the suspended factory never becomes an authorized producer');
  assert.equal(out.admissionClosed, true);
});

test('census: the production graph to V stays the censused runtime->roots path', () => {
  // Static guard: within lib/, only the roots wrapper and the private
  // cleanup hook module (the adapter) may require the qualified Node
  // runtime directly. runtime.js is the factory the census registers.
  const percorsi = [];
  const cammina = (dir) => {
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      const st = fs.statSync(p);
      if (st.isDirectory()) cammina(p);
      else if (p.endsWith('.js')) percorsi.push(p);
    }
  };
  cammina(path.join(__dirname, '..', 'lib'));
  const ammessi = new Set([
    path.join(__dirname, '..', 'lib', 'fleet', 'vl-roots.js'),
    path.join(__dirname, '..', 'lib', 'cli', 'vl-node-cleanup-hook.js'),
  ]);
  const richiedenti = percorsi.filter((p) => {
    const src = fs.readFileSync(p, 'utf8');
    return /require\([^)]*vl-node-runtime\.js[^)]*\)/.test(src);
  });
  for (const p of richiedenti) {
    assert.ok(ammessi.has(p), `unexpected direct requirer of the qualified Node runtime: ${p}`);
  }
  assert.ok(ammessi.has(path.join(__dirname, '..', 'lib', 'fleet', 'vl-roots.js')));
  // The census is wired where the production happens: the factory and the
  // builtin fleet close that retires the token.
  const srcRuntime = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fleet', 'runtime.js'), 'utf8');
  assert.match(srcRuntime, /require\('\.\/vl-node-census\.js'\)/);
  const srcBuiltin = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fleet', 'builtin.js'), 'utf8');
  assert.match(srcBuiltin, /require\('\.\/vl-node-census\.js'\)/);
  assert.match(srcBuiltin, /retireProducer\(rt\.censusToken/);
});
