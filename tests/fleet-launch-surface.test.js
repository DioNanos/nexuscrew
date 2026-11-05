'use strict';
// tests/fleet-launch-surface.test.js — la superficie P1-c: GET
// /api/fleet/launch-state e POST /api/fleet/reconcile (T80–T82 ampliati).
//
// Il motore di riconciliazione ha i suoi test in fleet-launch-reconcile;
// qui si prova la SUPERFICIE: contratti HTTP, guard, enum chiusi, e le
// proprieta' che il design P1-c chiede esplicitamente — la GET non scrive
// niente, il POST ricalcola sotto lock senza fidarsi della GET, la
// risposta non porta path, e la claim straniera resta distinta dall'assente.
// Mondo finto e isolato via helpers/launch-world: nessun tmux reale.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const express = require('express');
const W = require('./helpers/launch-world.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const radici = require('../lib/fleet/vl-roots.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');
const { fleetRoutes } = require('../lib/fleet/routes.js');

const BOOT = '11111111-1111-4111-8111-111111111111';
const NS = '4026531836';
const LID = 'ab'.repeat(8);
const ALTRO_LID = 'cd'.repeat(8);
const FIGLIO = path.join(__dirname, 'helpers', 'launch-crash-child.cjs');

// Mondo con record prepared di QUESTO lancio (come lo lascia un crash fra
// prepared e la creazione): la pratica aperta da riconciliare.
function mondoPrepared(t, famiglia = 'other') {
  const d = W.scriviMondo({ famiglia });
  t.after(() => W.pulisci(d));
  const owner = famiglia === 'vl' ? W.OWNER_INSTANCE_ID : null;
  const r = launchTarget.registraPrepared(d.filesRoot, d.sessione, {
    launchId: LID, family: famiglia, cellId: d.cella, ownerInstanceId: owner,
    tmuxSocket: sharedTmuxSocketPath(), bootId: BOOT, pidNs: NS, daemonInc: 'inc-0',
    res: famiglia === 'vl'
      ? { vlOwner: W.OWNER_INSTANCE_ID, vlRoot: radici.radiceServer(d.home, W.OWNER_INSTANCE_ID, d.cella) }
      : null,
  });
  assert.equal(r.ok, true);
  return d;
}

// Facciata minima del provider builtin per le rotte: stesse firme che
// builtin.js espone (launchState(cell), reconcile(cell, launchId)).
function appCon(t, runtime, cfg = {}) {
  const app = express();
  app.use('/api/fleet', fleetRoutes(Promise.resolve({
    available: true, provider: 'builtin',
    capabilities: () => ['status', 'up', 'down'],
    launchState: (c) => runtime.launchState(c),
    reconcile: (c, l) => runtime.reconcile(c, l),
  }), cfg));
  const srv = app.listen(0, '127.0.0.1');
  t.after(() => srv.close());
  return new Promise((res) => srv.once('listening', () => res(`http://127.0.0.1:${srv.address().port}/api/fleet`)));
}

async function chiama(base, metodo, url, body) {
  const r = await fetch(base + url, {
    method: metodo,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}

const dirClaimVl = (d) => path.join(d.home, '.nexuscrew', 'vl-root-claims');

// ---------------------------------------------------------------------------
// T80 — GET /launch-state: osserva, non scrive
// ---------------------------------------------------------------------------

test('T80 GET: snapshot diagnostico via query, enum chiusi, nessun path', async (t) => {
  const d = mondoPrepared(t);
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const base = await appCon(t, runtime);
  const r = await chiama(base, 'GET', `/launch-state?cell=${d.cella}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.cell, d.cella);
  assert.equal(r.body.inFlight, false);
  assert.equal(r.body.launchId, LID);
  assert.equal(r.body.phase, 'prepared');
  assert.equal(r.body.classification, 'never-materialized');
  assert.equal(r.body.proof, 'prepared');
  assert.equal(typeof r.body.reconcilable, 'boolean');
  assert.ok(Array.isArray(r.body.blockers));
  assert.ok(!('path' in r.body), 'nessun path nella risposta');
  const corpo = JSON.stringify(r.body);
  assert.ok(!corpo.includes('/tmp') && !corpo.includes(d.root) && !corpo.includes(d.home),
    'nessun path del filesystem nel corpo (gli enum come "n/a" non sono path)');
  // La cella e' nella QUERY: senza query la risposta e' 400, non un default.
  assert.equal((await chiama(base, 'GET', '/launch-state')).status, 400);
  assert.equal((await chiama(base, 'GET', '/launch-state?cell=Nope')).status, 400);
});

test('T80 GET: non scrive niente — record intatto, niente journal, niente claim dir', async (t) => {
  // Senza record (diagnosi claim orfana): la directory delle claim NON viene
  // preparata, nessun mkdir, nessun lock.
  {
    const d = W.scriviMondo({ famiglia: 'vl' });
    t.after(() => W.pulisci(d));
    const { runtime } = W.apriRuntime(d, {});
    t.after(() => { try { runtime.shutdown(); } catch (_) {} });
    const st = await runtime.launchState(d.cella);
    assert.equal(st.classification, 'none');
    assert.equal(st.launchId, null);
    assert.equal(st.proofs.root, 'absent', 'root mai creata, qualifica in lettura');
    assert.equal(st.proofs.claim, 'none');
    assert.equal(fs.existsSync(dirClaimVl(d)), false, 'la GET non prepara la directory delle claim');
  }
  // Con record: i byte del record non cambiano, niente journal, niente quarantena.
  {
    const d = mondoPrepared(t);
    const recordPath = W.fileRecord(d);
    const prima = fs.readFileSync(recordPath, 'utf8');
    const { runtime } = W.apriRuntime(d, {});
    t.after(() => { try { runtime.shutdown(); } catch (_) {} });
    const st = await runtime.launchState(d.cella);
    assert.equal(st.classification, 'never-materialized');
    assert.equal(st.reconcilable, true);
    assert.equal(fs.readFileSync(recordPath, 'utf8'), prima, 'record byte-identico');
    assert.equal(fs.existsSync(launchTarget.percorsoJournal(d.filesRoot, d.sessione)), false);
    assert.equal(fs.existsSync(launchTarget.percorsoQuarantena(d.filesRoot, d.sessione, LID)), false);
  }
});

test('T80 GET: catena occupata = busy con inFlight, senza attendere', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  let sblocca;
  const { runtime } = W.apriRuntime(d, {
    issue: () => new Promise((ok) => { sblocca = ok; }),
    cfg: { groupStopBudgetMs: 8000 },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const p = runtime.up(d.cella).catch(() => {});
  await new Promise((ok) => setTimeout(ok, 120));
  const t0 = Date.now();
  const st = await runtime.launchState(d.cella);
  assert.ok(Date.now() - t0 < 2000, 'la GET non aspetta la catena');
  assert.equal(st.inFlight, true);
  assert.equal(st.classification, 'busy');
  sblocca({ socketPath: path.join(d.root, 'broker.sock'), nonce: 'a'.repeat(64) });
  await p;
});

test('T80 GET: la claim straniera e\' distinta dall\'assente (held-other vs none vs held)', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const owner = W.OWNER_INSTANCE_ID;
  const root = radici.radiceServer(d.home, owner, d.cella);
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  assert.equal((await runtime.launchState(d.cella)).proofs.claim, 'none');
  await radici.riserva({ home: d.home, root, launchId: LID, ownerInstanceId: owner, cellId: d.cella, budgetMs: 4000 });
  assert.equal((await runtime.launchState(d.cella)).proofs.claim, 'held');
  // La lease passa a un ALTRO owner: stessa root, stessa cella, claim straniera.
  const lf = W.lease(d)[0];
  const lease = JSON.parse(fs.readFileSync(lf, 'utf8'));
  lease.ownerInstanceId = 'ff'.repeat(16);
  fs.writeFileSync(lf, `${JSON.stringify(lease)}\n`);
  const st = await runtime.launchState(d.cella);
  assert.equal(st.proofs.claim, 'held-other', 'una claim straniera NON e\' una claim assente');
  lease.released = true;
  fs.writeFileSync(lf, `${JSON.stringify(lease)}\n`);
  assert.equal((await runtime.launchState(d.cella)).proofs.claim, 'released');
});

// ---------------------------------------------------------------------------
// T81 — POST /reconcile: mutazione confermata, enum chiusi
// ---------------------------------------------------------------------------

test('T81 POST: launchId obbligatorio e ben formato; body malformato non tocca il record', async (t) => {
  const d = mondoPrepared(t);
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const base = await appCon(t, runtime);
  const prima = fs.readFileSync(W.fileRecord(d), 'utf8');
  assert.equal((await chiama(base, 'POST', '/reconcile', { cell: d.cella })).status, 400);
  assert.equal((await chiama(base, 'POST', '/reconcile', { cell: d.cella, launchId: 'xy' })).status, 400);
  assert.equal((await chiama(base, 'POST', '/reconcile', { cell: 'Nope', launchId: LID })).status, 400);
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima, 'il record non si tocca su 400');
});

test('T81 POST: i campi estranei del corpo sono ignorati, non consumati', async (t) => {
  const d = mondoPrepared(t);
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const base = await appCon(t, runtime);
  // path, pid, family e prove dal client non entrano da nessuna parte: la
  // pratica chiusa resta quella del record, nella quarantena originale.
  const r = await chiama(base, 'POST', '/reconcile', {
    cell: d.cella, launchId: LID, pid: 999, path: '/etc', family: 'vl', bootId: BOOT,
    proofs: { sessione: 'presente' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, 'reconciled');
  assert.equal(r.body.launchId, LID);
  assert.ok(fs.existsSync(launchTarget.percorsoQuarantena(d.filesRoot, d.sessione, LID)));
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
});

test('T81 POST: launchId vecchio = launch-mismatch col corrente; poi il corrente passa', async (t) => {
  const d = mondoPrepared(t);
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const base = await appCon(t, runtime);
  const r = await chiama(base, 'POST', '/reconcile', { cell: d.cella, launchId: ALTRO_LID });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, 'launch-mismatch');
  assert.equal(r.body.currentLaunchId, LID);
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'presente', 'il record non si tocca sul mismatch');
  assert.equal(fs.existsSync(launchTarget.percorsoQuarantena(d.filesRoot, d.sessione, LID)), false);
  // Ripetibile: con il launchId CORRENTE la stessa pratica si chiude.
  const r2 = await chiama(base, 'POST', '/reconcile', { cell: d.cella, launchId: LID });
  assert.equal(r2.body.outcome, 'reconciled');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
});

test('T81 POST: READONLY nega la mutazione, la GET resta leggibile', async (t) => {
  const d = mondoPrepared(t);
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const base = await appCon(t, runtime, { readonlyDefault: true });
  assert.equal((await chiama(base, 'POST', '/reconcile', { cell: d.cella, launchId: LID })).status, 403);
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'presente');
  assert.equal((await chiama(base, 'GET', `/launch-state?cell=${d.cella}`)).status, 200);
});

test('T81 POST: catena occupata oltre il budget = busy, zero azioni', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  let sblocca;
  const { runtime } = W.apriRuntime(d, {
    issue: () => new Promise((ok) => { sblocca = ok; }),
    cfg: { groupStopBudgetMs: 250 },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const p = runtime.up(d.cella).catch(() => {});
  await new Promise((ok) => setTimeout(ok, 120));
  const r = await runtime.reconcile(d.cella, LID);
  assert.equal(r.outcome, 'busy');
  // Zero azioni: il record dell'avvio in corso resta qual era.
  const letto = launchTarget.leggi(d.filesRoot, d.sessione);
  assert.ok(letto.stato === 'assente' || letto.stato === 'presente');
  sblocca({ socketPath: path.join(d.root, 'broker.sock'), nonce: 'a'.repeat(64) });
  await p;
});

test('T81 POST: budget scaduto nelle prove = outcome budget, record intatto, poi ripetibile', async (t) => {
  const d = mondoPrepared(t);
  // tmux LENTO: ogni interrogazione costa piu' del budget totale delle prove.
  const lento = path.join(d.root, 'slow-tmux.cjs');
  fs.writeFileSync(lento, `#!${process.execPath}\n'use strict';\n`
    + `const { spawnSync } = require('node:child_process');\n`
    + `setTimeout(() => { const r = spawnSync(${JSON.stringify(d.tmuxBin)}, process.argv.slice(2), { stdio: 'inherit' });`
    + ` process.exit(r.status == null ? 0 : r.status); }, 400);\n`, { mode: 0o755 });
  fs.chmodSync(lento, 0o755);
  d.tmuxBin = lento;
  const lenta = W.apriRuntime(d, { cfg: { groupStopBudgetMs: 200 } });
  t.after(() => { try { lenta.runtime.shutdown(); } catch (_) {} });
  const r = await lenta.runtime.reconcile(d.cella, LID);
  assert.equal(r.outcome, 'budget');
  assert.ok(r.blockers.includes('BUDGET'));
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'presente', 'zero azioni a budget scaduto');
  // Il budget non ha corrotto niente: con tempo vero la stessa pratica si chiude.
  const normale = W.apriRuntime(d, {});
  t.after(() => { try { normale.runtime.shutdown(); } catch (_) {} });
  const r2 = await normale.runtime.reconcile(d.cella, LID);
  assert.equal(r2.outcome, 'reconciled');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
});

test('T81 POST: lo stato cambiato dopo la GET si impone nel POST', async (t) => {
  const d = mondoPrepared(t);
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const prima = await runtime.launchState(d.cella);
  assert.equal(prima.classification, 'never-materialized');
  assert.equal(prima.reconcilable, true);
  W.impostaScenario(d, { omonima: true }); // la sessione omonima appare DOPO la GET
  const r = await runtime.reconcile(d.cella, LID);
  assert.equal(r.outcome, 'blocked');
  assert.deepEqual(r.blockers, ['SESSION_PRESENT']);
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'presente', 'il record resta: niente prova di assenza');
});

test('T81 POST: record assente = not-needed onesto', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.reconcile(d.cella, LID);
  assert.equal(r.outcome, 'not-needed');
  assert.equal(r.classification, 'none');
});

test('T81 POST: la risposta non porta path ne\' testo, solo enum e backup', async (t) => {
  const d = mondoPrepared(t);
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.reconcile(d.cella, LID);
  assert.equal(r.outcome, 'reconciled');
  assert.equal(r.backup, true, 'quarantena indicata come flag, non come nome');
  assert.ok(!('path' in r));
  assert.ok(!('quarantine' in r));
  const corpo = JSON.stringify(r);
  assert.ok(!corpo.includes('/tmp') && !corpo.includes(d.root) && !corpo.includes(d.home),
    'nessun path del filesystem nel corpo');
});

// ---------------------------------------------------------------------------
// T82 — vl via POST: il motore condiviso sotto la superficie esplicita
// ---------------------------------------------------------------------------

test('T82 vl: crash reale al broker, POST riconcilia col launchId del record', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const c = spawnSync(process.execPath, [FIGLIO, JSON.stringify({ descr: d, crash: { dove: 'issue' } })], { encoding: 'utf8', timeout: 60000 });
  assert.equal(c.signal, 'SIGKILL', `${c.stdout} ${c.stderr}`);
  const letto = launchTarget.leggi(d.filesRoot, d.sessione);
  assert.equal(letto.record.phase, 'prepared');
  assert.equal(W.lease(d).length, 1);
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.reconcile(d.cella, letto.record.launchId);
  assert.equal(r.outcome, 'reconciled');
  assert.equal(r.host, 'root-absent');
  assert.equal(r.backup, true);
  assert.deepEqual(W.lease(d), [], 'la claim di quel lancio e\' sciolta');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
});

test('T82 vl: barriera host senza base qualificata = blocked, claim e record restano', async (t) => {
  const d = mondoPrepared(t, 'vl');
  await radici.riserva({
    home: d.home, root: radici.radiceServer(d.home, W.OWNER_INSTANCE_ID, d.cella),
    launchId: LID, ownerInstanceId: W.OWNER_INSTANCE_ID, cellId: d.cella, budgetMs: 4000,
  });
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.reconcile(d.cella, LID);
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.code, 'HOST_BARRIER');
  assert.equal(r.host, 'base-mancante');
  assert.equal(W.lease(d).length, 1, 'la claim non si tocca');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'presente', 'il record non si tocca');
});
