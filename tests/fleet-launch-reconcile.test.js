'use strict';
// P1-b: il valutatore unico, le prove di morte e il commit condiviso del down.
// Mondo finto e isolato (tests/helpers/launch-world.js): nessun tmux reale,
// nessun servizio vivo. I processi «supervisore» e «server» sono figli di test
// fermati SOLO per PID esatto.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const launchTarget = require('../lib/fleet/launch-target.js');
const radici = require('../lib/fleet/vl-roots.js');
const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');
const W = require('./helpers/launch-world.js');

const { OWNER_INSTANCE_ID } = W;
const LID = 'ab'.repeat(8);
const BOOT_ORA = '11111111-1111-4111-8111-111111111111';
const BOOT_PRIMA = '22222222-2222-4222-8222-222222222222';
const NS = '4026531836';

function nodoOra(over = {}) {
  return () => ({ bootId: BOOT_ORA, pidNamespaceInode: NS, ...over });
}

function figlioVivo(t) {
  const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000);'], { detached: true, stdio: 'ignore' });
  f.unref();
  t.after(() => { try { process.kill(f.pid, 'SIGKILL'); } catch (_) { /* gia' uscito */ } });
  return f;
}

// Ferma per PID esatto e ATTENDE la scomparsa senza bloccare l'event loop
// (altrimenti il figlio resta zombie finche' libuv non lo raccoglie).
async function morto(pid) {
  process.kill(pid, 'SIGKILL');
  const fine = Date.now() + 5000;
  while (Date.now() < fine) {
    try { process.kill(pid, 0); } catch (_) { return; }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Scrive un record v2 fino alla fase richiesta, con le API del modulo.
function scrivi(d, fase, {
  bootId = BOOT_PRIMA, pidNs = NS, owner = null, socket = sharedTmuxSocketPath(),
  created = {}, attested = null, famiglia = d.famiglia, launchId = LID,
} = {}) {
  const vl = famiglia === 'vl';
  const own = vl ? OWNER_INSTANCE_ID : owner;
  const r = launchTarget.registraPrepared(d.filesRoot, d.sessione, {
    launchId, family: famiglia, cellId: d.cella, ownerInstanceId: own, tmuxSocket: socket,
    bootId, pidNs, daemonInc: 'inc-0',
    res: vl ? { vlOwner: OWNER_INSTANCE_ID, vlRoot: radici.radiceServer(d.home, OWNER_INSTANCE_ID, d.cella) } : null,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const passi = ['creating', 'created', 'attested'];
  let da = 'prepared';
  for (const a of passi) {
    if (fase === da) break;
    const campi = a === 'created' ? { sessionId: '$5', windowId: '@7', paneId: '%9', ...created }
      : a === 'attested' ? { ...attested } : {};
    const av = launchTarget.avanza(d.filesRoot, d.sessione, { launchId, da, a, campi });
    assert.equal(av.ok, true, JSON.stringify(av));
    da = a;
  }
}

function conoscenza(d, over = {}) {
  return { owner: true, cfg: { identitaNodoKernel: nodoOra(), ...over } };
}

function chiamate(d) { return W.chiamateTmux(d).map((a) => a.join(' ')); }

function quarantena(d, launchId = LID) {
  return launchTarget.percorsoQuarantena(d.filesRoot, d.sessione, launchId);
}

async function down(d, opz) {
  const { runtime } = W.apriRuntime(d, opz);
  return { runtime, esito: () => runtime.down(d.cella) };
}

const BLOCCO = (e) => e.fleetCode === 'IDENTITY_UNVERIFIED';

// ---------------------------------------------------------------------------
// prepared: questo lancio non ha emesso new-session
// ---------------------------------------------------------------------------

test('prepared (other): il down lo riconcilia, record in quarantena, nessun kill, l\'up riparte', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'prepared');
  const bytes = fs.readFileSync(W.fileRecord(d), 'utf8');
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.down(d.cella);
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'resolved-unlaunched');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
  assert.equal(fs.readFileSync(quarantena(d), 'utf8'), bytes, 'i byte del record, intatti');
  assert.equal(fs.statSync(quarantena(d)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(quarantena(d))).mode & 0o777, 0o700);
  assert.ok(!chiamate(d).some((c) => c.includes('kill-session') || c.includes('$') || c.includes('%')),
    'sola lettura: nessun comando distruttivo e nessun id');
  assert.equal(fs.existsSync(launchTarget.percorsoJournal(d.filesRoot, d.sessione)), false);
  assert.equal((await runtime.up(d.cella)).ok, true);
});

test('prepared con sessione omonima viva: nessuna prova di assenza, record intatto', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'prepared');
  W.impostaScenario(d, { omonima: true });
  const prima = fs.readFileSync(W.fileRecord(d), 'utf8');
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima);
  assert.equal(fs.existsSync(quarantena(d)), false);
});

test('prepared (vl) con root assente: host -> claim -> record, nell\'ordine', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const root = radici.radiceServer(d.home, OWNER_INSTANCE_ID, d.cella);
  const claim = await radici.riserva({ home: d.home, root, launchId: LID, ownerInstanceId: OWNER_INSTANCE_ID, cellId: d.cella, budgetMs: 4000 });
  assert.equal(claim.ok, true);
  scrivi(d, 'prepared');
  const ordine = [];
  const origCommit = launchTarget.riconciliaRecord;
  launchTarget.riconciliaRecord = (...a) => { ordine.push(`record(claim=${W.lease(d).length})`); return origCommit.apply(launchTarget, a); };
  t.after(() => { launchTarget.riconciliaRecord = origCommit; });
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.down(d.cella);
  assert.equal(r.outcome, 'resolved-unlaunched');
  assert.equal(r.host, 'root-absent');
  assert.deepStrictEqual(ordine, ['record(claim=0)'], 'la claim e\' sciolta PRIMA del commit del record');
  assert.deepStrictEqual(W.lease(d), []);
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
});

test('prepared (vl) con root preesistente e nessun contesto: «prepared» non prova l\'assenza di un host', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const root = radici.radiceServer(d.home, OWNER_INSTANCE_ID, d.cella);
  await radici.riserva({ home: d.home, root, launchId: LID, ownerInstanceId: OWNER_INSTANCE_ID, cellId: d.cella, budgetMs: 4000 });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  scrivi(d, 'prepared');
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
  assert.equal(W.lease(d).length, 1, 'claim intatta');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'presente');
});

test('prepared (vl) con claim di un ALTRO lancio (mismatch): niente rilascio, niente quarantena', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const root = radici.radiceServer(d.home, OWNER_INSTANCE_ID, d.cella);
  await radici.riserva({ home: d.home, root, launchId: 'ee'.repeat(8), ownerInstanceId: OWNER_INSTANCE_ID, cellId: d.cella, budgetMs: 4000 });
  scrivi(d, 'prepared');
  const leaseFile = W.lease(d)[0];
  const prima = fs.readFileSync(leaseFile, 'utf8');
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), (e) => e.fleetCode === 'CLAIM_UNCERTAIN');
  assert.equal(fs.readFileSync(leaseFile, 'utf8'), prima, 'la claim altrui non si tocca');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'presente');
  assert.equal(fs.existsSync(quarantena(d)), false);
});

test('claim: assente prosegue (ripetibile), mismatch blocca', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const root = radici.radiceServer(d.home, OWNER_INSTANCE_ID, d.cella);
  const base = { home: d.home, root, ownerInstanceId: OWNER_INSTANCE_ID, cellId: d.cella, budgetMs: 4000 };
  const assente = await radici.rilascia({ ...base, launchId: LID });
  assert.equal(assente.ok, true);
  assert.equal(assente.outcome, 'not-held');
  await radici.riserva({ ...base, launchId: 'ee'.repeat(8) });
  const mismatch = await radici.rilascia({ ...base, launchId: LID });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.outcome, 'mismatch');
  assert.equal(W.lease(d).length, 1);
  const stesso = await radici.rilascia({ ...base, launchId: 'ee'.repeat(8) });
  assert.equal(stesso.outcome, 'released');
  const ancora = await radici.rilascia({ ...base, launchId: 'ee'.repeat(8) });
  assert.equal(ancora.outcome, 'not-held', 'gia\' rilasciata: ripetibile');
});

// ---------------------------------------------------------------------------
// creating / created: nessuna prova di pid, solo il boot
// ---------------------------------------------------------------------------

test('creating nello stesso boot: materializzazione ignota, nessuna azione', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'creating', { bootId: BOOT_ORA, owner: OWNER_INSTANCE_ID });
  const prima = fs.readFileSync(W.fileRecord(d), 'utf8');
  const { runtime } = W.apriRuntime(d, conoscenza(d));
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), (e) => BLOCCO(e) && /MATERIALIZATION_UNKNOWN/.test(e.message));
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima);
  assert.ok(!chiamate(d).some((c) => c.includes('kill-session')));
});

test('creating con boot DIVERSO (stesso nodo e namespace): prova di boot, sessione assente, lease none', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'creating', { bootId: BOOT_PRIMA, owner: OWNER_INSTANCE_ID });
  const { runtime } = W.apriRuntime(d, conoscenza(d));
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.down(d.cella);
  assert.equal(r.outcome, 'resolved-dead');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
  assert.ok(fs.existsSync(quarantena(d)));
});

const BOOT_NEGATIVI = [
  ['owner di un altro nodo', { owner: 'cd'.repeat(16) }, {}],
  ['record senza owner', { owner: null }, {}],
  ['namespace dei processi diverso', {}, { identitaNodo: { pidNamespaceInode: '1' } }],
  ['record senza namespace', { pidNs: null }, {}],
  ['boot id attuale non leggibile', {}, { identitaNodo: null }],
  ['boot id attuale malformato', {}, { identitaNodo: { bootId: 'xx' } }],
  ['stesso boot id', { bootId: BOOT_ORA }, {}],
  ['boot id del record assente', { bootId: null }, {}],
];

for (const [nome, recOver, nodoOver] of BOOT_NEGATIVI) {
  test(`prova di boot NON valida (${nome}): creating resta bloccato, record intatto`, async (t) => {
    const d = W.scriviMondo({ famiglia: 'other' });
    t.after(() => W.pulisci(d));
    scrivi(d, 'creating', { owner: OWNER_INSTANCE_ID, ...recOver });
    const prima = fs.readFileSync(W.fileRecord(d), 'utf8');
    const identita = 'identitaNodo' in nodoOver
      ? (nodoOver.identitaNodo === null ? () => null : nodoOra(nodoOver.identitaNodo))
      : nodoOra();
    const { runtime } = W.apriRuntime(d, { owner: true, cfg: { identitaNodoKernel: identita } });
    t.after(() => { try { runtime.shutdown(); } catch (_) {} });
    await assert.rejects(() => runtime.down(d.cella), BLOCCO);
    assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima);
  });
}

test('la sola incarnazione del demone diversa non prova niente', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'creating', { bootId: BOOT_ORA, owner: OWNER_INSTANCE_ID });
  const { runtime } = W.apriRuntime(d, { owner: true, cfg: { identitaNodoKernel: nodoOra(), identityDaemonBootId: 'altra-incarnazione' } });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
});

test('created: il pid del placeholder (morto) non e\' una prova nello stesso boot', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const f = figlioVivo(t);
  const nascita = leggiStarttimeProc(f.pid);
  await morto(f.pid);
  scrivi(d, 'created', { bootId: BOOT_ORA, owner: OWNER_INSTANCE_ID, created: { holdPid: f.pid, holdStarttime: nascita } });
  const { runtime } = W.apriRuntime(d, conoscenza(d));
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'presente');
});

test('created con boot diverso ma sessione omonima viva: bloccato; assente: riconciliato', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'created', { owner: OWNER_INSTANCE_ID });
  W.impostaScenario(d, { omonima: true });
  const { runtime } = W.apriRuntime(d, conoscenza(d));
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
  W.impostaScenario(d, { omonima: false });
  const r = await runtime.down(d.cella);
  assert.equal(r.outcome, 'resolved-dead');
});

// ---------------------------------------------------------------------------
// attested: prova ternaria sul supervisore
// ---------------------------------------------------------------------------

async function conSupervisore(t, d, { opz = {}, vivo = false, serverPid = null, serverStarttime = null } = {}) {
  const f = figlioVivo(t);
  const nascita = leggiStarttimeProc(f.pid);
  scrivi(d, 'attested', {
    bootId: BOOT_ORA, owner: OWNER_INSTANCE_ID,
    created: { serverPid, serverStarttime },
    attested: { panePid: f.pid, paneStarttime: nascita },
  });
  if (!vivo) await morto(f.pid);
  const { runtime } = W.apriRuntime(d, { ...conoscenza(d), ...opz });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  return { runtime, f };
}

test('attested: supervisore morto (ternaria), sessione assente, lease none -> resolved-dead', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const { runtime } = await conSupervisore(t, d);
  const r = await runtime.down(d.cella);
  assert.equal(r.outcome, 'resolved-dead');
  assert.ok(fs.existsSync(quarantena(d)));
});

test('attested con supervisore VIVO (stessa nascita): bloccato, record intatto', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const { runtime } = await conSupervisore(t, d, { vivo: true });
  const prima = fs.readFileSync(W.fileRecord(d), 'utf8');
  await assert.rejects(() => runtime.down(d.cella), (e) => BLOCCO(e) && /SUPERVISOR_ALIVE/.test(e.message));
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima);
});

test('attested: la sola incarnazione diversa non sblocca un supervisore vivo', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const { runtime } = await conSupervisore(t, d, { vivo: true, opz: { cfg: { identitaNodoKernel: nodoOra(), identityDaemonBootId: 'zzz' } } });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
});

// ---------------------------------------------------------------------------
// lease di controllo
// ---------------------------------------------------------------------------

for (const [stato, atteso] of [['none', true], ['expired', true], ['grace', false], ['live', false], ['strano', false]]) {
  test(`lease di controllo «${stato}»: ${atteso ? 'ammessa' : 'blocca'}`, async (t) => {
    const d = W.scriviMondo({ famiglia: 'other' });
    t.after(() => W.pulisci(d));
    scrivi(d, 'prepared');
    const lm = { status: () => ({ state: stato }), revokeControl: () => {} };
    const { runtime } = W.apriRuntime(d, { leaseManager: lm });
    t.after(() => { try { runtime.shutdown(); } catch (_) {} });
    if (atteso) assert.equal((await runtime.down(d.cella)).outcome, 'resolved-unlaunched');
    else await assert.rejects(() => runtime.down(d.cella), BLOCCO);
  });
}

test('lease di controllo che lancia: errore di lettura blocca', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'prepared');
  const lm = { status: () => { throw new Error('boom'); }, revokeControl: () => {} };
  const { runtime } = W.apriRuntime(d, { leaseManager: lm });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), (e) => BLOCCO(e) && /LEASE_UNREADABLE/.test(e.message));
});

// ---------------------------------------------------------------------------
// server tmux
// ---------------------------------------------------------------------------

test('server registrato MORTO (prova positiva) e omonima assente sul server attuale: riconciliato', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const srv = figlioVivo(t);
  const nascita = leggiStarttimeProc(srv.pid);
  await morto(srv.pid);
  const { runtime } = await conSupervisore(t, d, { serverPid: srv.pid, serverStarttime: nascita });
  const r = await runtime.down(d.cella);
  assert.equal(r.outcome, 'resolved-dead');
});

test('server registrato morto ma omonima VIVA sul server attuale: bloccato', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const srv = figlioVivo(t);
  const nascita = leggiStarttimeProc(srv.pid);
  await morto(srv.pid);
  const { runtime } = await conSupervisore(t, d, { serverPid: srv.pid, serverStarttime: nascita });
  W.impostaScenario(d, { omonima: true });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
});

test('server registrato VIVO e qualificato, interrogato lo STESSO: «same», assenza sulla stessa connessione', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const srv = figlioVivo(t);
  const nascita = leggiStarttimeProc(srv.pid);
  const { runtime } = await conSupervisore(t, d, { serverPid: srv.pid, serverStarttime: nascita });
  W.impostaScenario(d, { serverOsservato: srv.pid });
  const r = await runtime.down(d.cella);
  assert.equal(r.outcome, 'resolved-dead');
  assert.ok(chiamate(d).some((c) => c.startsWith('display-message -p #{pid} ; has-session')), 'una sola connessione per identita\' e assenza');
});

test('server registrato vivo ma la query arriva a un ALTRO server (cambio fra due letture): unknown', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const srv = figlioVivo(t);
  const nascita = leggiStarttimeProc(srv.pid);
  const { runtime } = await conSupervisore(t, d, { serverPid: srv.pid, serverStarttime: nascita });
  W.impostaScenario(d, { serverOsservato: srv.pid + 1 });
  await assert.rejects(() => runtime.down(d.cella), (e) => BLOCCO(e) && /SERVER_UNKNOWN/.test(e.message));
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'presente');
});

test('server registrato vivo ma non raggiungibile: unknown', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const srv = figlioVivo(t);
  const nascita = leggiStarttimeProc(srv.pid);
  const { runtime } = await conSupervisore(t, d, { serverPid: srv.pid, serverStarttime: nascita });
  W.impostaScenario(d, { nessunServer: true });
  await assert.rejects(() => runtime.down(d.cella), (e) => BLOCCO(e) && /SERVER_UNKNOWN/.test(e.message));
});

test('server registrato vivo senza nascita nel record, o pid illeggibile: unknown', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const srv = figlioVivo(t);
  const { runtime } = await conSupervisore(t, d, { serverPid: srv.pid, serverStarttime: null });
  await assert.rejects(() => runtime.down(d.cella), (e) => BLOCCO(e) && /SERVER_UNKNOWN/.test(e.message));
});

test('socket del record diverso da quello corrente: replaced-unknown', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const f = figlioVivo(t);
  const nascita = leggiStarttimeProc(f.pid);
  await morto(f.pid);
  scrivi(d, 'attested', {
    bootId: BOOT_ORA, owner: OWNER_INSTANCE_ID, socket: '/tmp/altro-socket',
    created: { serverPid: 99999, serverStarttime: 5 }, attested: { panePid: f.pid, paneStarttime: nascita },
  });
  const { runtime } = W.apriRuntime(d, conoscenza(d));
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), (e) => BLOCCO(e) && /SERVER_UNKNOWN/.test(e.message));
});

test('nessun comando con id ($N/%N) e nessun kill durante la riconciliazione passiva', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const { runtime } = await conSupervisore(t, d);
  await runtime.down(d.cella);
  for (const c of chiamate(d)) {
    assert.ok(/^(has-session|display-message)/.test(c), `comando inatteso: ${c}`);
    assert.ok(!/[$%]\d/.test(c), `id nel comando: ${c}`);
  }
});

// ---------------------------------------------------------------------------
// legacy v1
// ---------------------------------------------------------------------------

test('legacy v1 incompleto: solo diagnosi, record intatto', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  launchTarget.registraIntent(d.filesRoot, d.sessione, { launchId: LID, family: 'other', tmuxSocket: sharedTmuxSocketPath() });
  const prima = fs.readFileSync(W.fileRecord(d), 'utf8');
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), (e) => BLOCCO(e) && /LEGACY_UNPROVABLE/.test(e.message));
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima);
});

test('legacy v1 completo con supervisore morto: percorso ternario di sempre', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const f = figlioVivo(t);
  const nascita = leggiStarttimeProc(f.pid);
  await morto(f.pid);
  launchTarget.registra(d.filesRoot, d.sessione, {
    launchId: LID, sessionId: '$5', paneId: '%9', tmuxSocket: sharedTmuxSocketPath(),
    panePid: f.pid, paneStarttime: nascita, family: 'other',
  });
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.down(d.cella);
  assert.equal(r.outcome, 'resolved-dead');
  assert.ok(fs.existsSync(quarantena(d)));
});

test('legacy v1 completo con supervisore VIVO: bloccato', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const f = figlioVivo(t);
  launchTarget.registra(d.filesRoot, d.sessione, {
    launchId: LID, sessionId: '$5', paneId: '%9', tmuxSocket: sharedTmuxSocketPath(),
    panePid: f.pid, paneStarttime: leggiStarttimeProc(f.pid), family: 'other',
  });
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
});

// ---------------------------------------------------------------------------
// famiglia dal record, non dalla definizione
// ---------------------------------------------------------------------------

test('famiglia cambiata nella definizione: conta quella REGISTRATA nel record (vl -> barriera host)', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const root = radici.radiceServer(d.home, OWNER_INSTANCE_ID, d.cella);
  await radici.riserva({ home: d.home, root, launchId: LID, ownerInstanceId: OWNER_INSTANCE_ID, cellId: d.cella, budgetMs: 4000 });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 }); // root preesistente: serve la prova host
  scrivi(d, 'prepared');
  // La definizione diventa un client generico DOPO il lancio.
  const { atomicWrite } = require('../lib/fleet/definitions.js');
  const client = path.join(d.home, 'client');
  fs.writeFileSync(client, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  atomicWrite(d.defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'client', label: 'Client', rc: false, command: client, args: [], env: {}, promptMode: 'flag', promptFlag: '--prompt' }],
    cells: [{ id: d.cella, tmuxSession: d.sessione, cwd: path.join(d.home, d.cella), engine: 'client', boot: false }],
  });
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
  assert.equal(W.lease(d).length, 1, 'il record dice vl: la barriera host vale ancora');
});

// ---------------------------------------------------------------------------
// errori di lettura e budget
// ---------------------------------------------------------------------------

test('record illeggibile (permessi): nessun intervento', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'prepared');
  fs.chmodSync(W.fileRecord(d), 0o000);
  t.after(() => { try { fs.chmodSync(W.fileRecord(d), 0o600); } catch (_) {} });
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
  assert.equal(fs.existsSync(quarantena(d)), false);
});

test('record non qualificato (campo mancante): bloccato, mai interpretato', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'prepared');
  const dato = JSON.parse(fs.readFileSync(W.fileRecord(d), 'utf8'));
  delete dato.daemonInc;
  fs.writeFileSync(W.fileRecord(d), JSON.stringify(dato));
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), (e) => BLOCCO(e) && /RECORD_NOT_QUALIFIED/.test(e.message));
});

test('deadline attraversata da una risposta positiva: non vale, il record resta', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'prepared');
  // Il clock monotono salta oltre la deadline subito dopo la lettura della sessione.
  let tempo = 0;
  const lm = { status: () => { tempo = 100000; return { state: 'none' }; }, revokeControl: () => {} };
  const { runtime } = W.apriRuntime(d, { leaseManager: lm, cfg: { monotonicNow: () => tempo, groupStopBudgetMs: 4000 } });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'presente');
  assert.equal(fs.existsSync(quarantena(d)), false);
});

// ---------------------------------------------------------------------------
// Commit in quarantena: crash a ogni passo, fsync incerto, ripresa
// ---------------------------------------------------------------------------

const { spawnSync } = require('node:child_process');
const FIGLIO = path.join(__dirname, 'helpers', 'launch-crash-child.cjs');
const { spawnaHostFinto } = require('./helpers/vl-attestato.js');

function figlioDown(d, crash) {
  return spawnSync(process.execPath, [FIGLIO, JSON.stringify({ descr: d, azione: 'down', crash })],
    { encoding: 'utf8', timeout: 60000 });
}

const PASSI_CRASH = [
  ['dopo il backup, prima dell\'unlink del record', { fn: 'unlinkSync', suffisso: '/launch-targets/%S.json', quando: 'prima' }],
  ['dopo l\'unlink del record, prima dell\'fsync della directory', { fn: 'unlinkSync', suffisso: '/launch-targets/%S.json', quando: 'dopo' }],
  ['prima di togliere il journal', { fn: 'unlinkSync', suffisso: '/launch-targets/.commit-%S.json', quando: 'prima' }],
  ['dopo aver tolto il journal (commit completo)', { fn: 'unlinkSync', suffisso: '/launch-targets/.commit-%S.json', quando: 'dopo' }],
];

for (const [nome, passo] of PASSI_CRASH) {
  test(`crash ${nome}: il riavvio completa il commit PRIMA di far partire un lancio`, async (t) => {
    const d = W.scriviMondo({ famiglia: 'other' });
    t.after(() => W.pulisci(d));
    scrivi(d, 'prepared');
    const bytes = fs.readFileSync(W.fileRecord(d), 'utf8');
    const crash = { dove: 'fs', ...passo, suffisso: passo.suffisso.replace('%S', d.sessione) };
    const r = figlioDown(d, crash);
    assert.equal(r.signal, 'SIGKILL', `il figlio doveva morire al passo (stdout=${r.stdout} stderr=${r.stderr})`);
    // Un secondo runtime sullo stesso disco: il journal (se c'e') si completa, poi l'up parte.
    const { runtime } = W.apriRuntime(d, {});
    t.after(() => { try { runtime.shutdown(); } catch (_) {} });
    const su = await runtime.up(d.cella);
    assert.equal(su.ok, true);
    assert.equal(fs.readFileSync(quarantena(d), 'utf8'), bytes, 'il backup c\'e\' ed e\' identico');
    assert.equal(fs.existsSync(launchTarget.percorsoJournal(d.filesRoot, d.sessione)), false);
  });
}

test('fsync fallito DOPO l\'unlink: esito incerto, barriera durevole, up rifiutato finche\' non si completa', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'prepared');
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const origUnlink = fs.unlinkSync;
  const origFsync = fs.fsyncSync;
  let tolto = false;
  fs.unlinkSync = function osserva(...a) {
    const r = origUnlink.apply(this, a);
    if (String(a[0]).endsWith(`${d.sessione}.json`)) tolto = true;
    return r;
  };
  fs.fsyncSync = function guasta(...a) {
    if (tolto) throw Object.assign(new Error('EIO iniettato'), { code: 'EIO' });
    return origFsync.apply(this, a);
  };
  try {
    await assert.rejects(() => runtime.down(d.cella), BLOCCO);
    assert.ok(fs.existsSync(launchTarget.percorsoJournal(d.filesRoot, d.sessione)), 'barriera durevole di commit incompleto');
    // I marker in memoria restano: il commit non e' attestato.
    await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'STOP_UNKNOWN');
  } finally {
    fs.unlinkSync = origUnlink;
    fs.fsyncSync = origFsync;
  }
  // Guasto finito: il tentativo successivo completa il commit e solo allora l'up parte.
  const su = await runtime.up(d.cella);
  assert.equal(su.ok, true);
  assert.equal(fs.existsSync(launchTarget.percorsoJournal(d.filesRoot, d.sessione)), false);
  assert.ok(fs.existsSync(quarantena(d)));
});

test('retry dopo riavvio con quarantena identica gia\' presente: ripresa verificata', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'prepared');
  const bytes = fs.readFileSync(W.fileRecord(d));
  fs.mkdirSync(path.dirname(quarantena(d)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(quarantena(d), bytes, { mode: 0o600 });
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.down(d.cella);
  assert.equal(r.outcome, 'resolved-unlaunched');
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'assente');
});

test('quarantena DIVERSA gia\' presente: il down blocca, l\'up resta bloccato dal journal, record intatto', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'prepared');
  const bytes = fs.readFileSync(W.fileRecord(d), 'utf8');
  fs.mkdirSync(path.dirname(quarantena(d)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(quarantena(d), 'estraneo\n', { mode: 0o600 });
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), bytes);
  assert.equal(fs.readFileSync(quarantena(d), 'utf8'), 'estraneo\n', 'mai sovrascritta');
  await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'STOP_UNKNOWN');
});

test('i marker in memoria si tolgono solo dopo il commit attestato (T70/T71)', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'prepared');
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  // commit fallito: l'up resta rifiutato
  const orig = launchTarget.riconciliaRecord;
  launchTarget.riconciliaRecord = () => ({ ok: false, codice: 'unlink', incompleto: false });
  try {
    await assert.rejects(() => runtime.down(d.cella), BLOCCO);
    await assert.rejects(() => runtime.up(d.cella), (e) => e.fleetCode === 'STOP_UNKNOWN');
  } finally { launchTarget.riconciliaRecord = orig; }
  // commit attestato: l'up non e' piu' bloccato dai marker
  assert.equal((await runtime.down(d.cella)).outcome, 'resolved-unlaunched');
  assert.equal((await runtime.up(d.cella)).ok, true);
});

// ---------------------------------------------------------------------------
// Un solo writer per filesRoot
// ---------------------------------------------------------------------------

test('single writer: un altro processo NC che tiene il lock blocca up e down; fermato per PID esatto, si riprende', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'prepared');
  const figlio = spawn(process.execPath, [FIGLIO, JSON.stringify({ descr: d, azione: 'tieni-lock' })], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { process.kill(figlio.pid, 'SIGKILL'); } catch (_) { /* gia' fermo */ } });
  await new Promise((resolveP, rejectP) => {
    figlio.stdout.once('data', (b) => (String(b).includes('"lock":true') ? resolveP() : rejectP(new Error(String(b)))));
    figlio.once('error', rejectP);
    figlio.once('exit', (code) => rejectP(new Error(`il figlio e' uscito prima di tenere il lock (rc=${code})`)));
  });
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const e1 = await runtime.down(d.cella).then(() => null, (e) => e);
  assert.ok(e1 && e1.fleetCode === 'STOP_UNKNOWN' && /altro processo NC/.test(e1.message), e1 && e1.message);
  const e2 = await runtime.up(d.cella).then(() => null, (e) => e);
  assert.ok(e2 && e2.fleetCode === 'STOP_UNKNOWN' && /altro processo NC/.test(e2.message));
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'presente', 'nessuna mutazione');
  // Il possessore muore (PID esatto): il lock di un processo morto si riprende.
  const fine = new Promise((r) => figlio.once('exit', r));
  process.kill(figlio.pid, 'SIGKILL');
  await fine;
  assert.equal((await runtime.down(d.cella)).outcome, 'resolved-unlaunched');
});

test('single writer: lo shutdown rilascia il lock', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  scrivi(d, 'prepared');
  const { runtime } = W.apriRuntime(d, {});
  await runtime.down(d.cella);
  const file = path.join(d.filesRoot, 'launch-targets', '.writer-lock.json');
  assert.ok(fs.existsSync(file));
  runtime.shutdown();
  assert.equal(fs.existsSync(file), false);
});

// ---------------------------------------------------------------------------
// Host vl: «prepared» non prova l'assenza di un host
// ---------------------------------------------------------------------------

function mondoVlCrashato(t) {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const r = spawnSync(process.execPath, [FIGLIO, JSON.stringify({ descr: d, crash: { dove: 'issue' } })], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.signal, 'SIGKILL', `${r.stdout} ${r.stderr}`);
  assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).record.phase, 'prepared');
  assert.equal(W.lease(d).length, 1);
  return d;
}

function rootVl(d) { return radici.radiceServer(d.home, OWNER_INSTANCE_ID, d.cella); }

test('vl: crash al broker, root assente => riconciliato, claim sciolta, nessun host da giudicare', async (t) => {
  const d = mondoVlCrashato(t);
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.down(d.cella);
  assert.equal(r.outcome, 'resolved-unlaunched');
  assert.equal(r.host, 'root-absent');
  assert.deepStrictEqual(W.lease(d), []);
});

test('vl: root preesistente senza host e contesto di QUESTO lancio + pin: status none => riconciliato', async (t) => {
  const d = mondoVlCrashato(t);
  fs.mkdirSync(rootVl(d), { recursive: true, mode: 0o700 });
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.down(d.cella);
  assert.equal(r.outcome, 'resolved-unlaunched');
  assert.equal(r.host, 'none');
  assert.deepStrictEqual(W.lease(d), []);
});

test('vl: root preesistente con host VIVO => nessun rilascio, nessun arresto, record intatto', async (t) => {
  const d = mondoVlCrashato(t);
  fs.mkdirSync(rootVl(d), { recursive: true, mode: 0o700 });
  const host = spawnaHostFinto();
  host.ref();
  t.after(async () => { if (host.exitCode === null) { const f = new Promise((r) => host.once('exit', r)); host.kill('SIGTERM'); await f; } });
  fs.writeFileSync(path.join(d.root, 'hostpid'), String(host.pid));
  const prima = fs.readFileSync(W.fileRecord(d), 'utf8');
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
  assert.equal(W.lease(d).length, 1);
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima);
  assert.equal(host.exitCode, null, 'l\'host non e\' stato fermato dal prodotto');
  assert.equal(fs.existsSync(quarantena(d)), false);
});

const GUASTI_BARRIERA = [
  ['contesto assente', (d) => { for (const f of W.trova(path.join(d.home), 'host-context.json')) fs.unlinkSync(f); }],
  ['contesto illeggibile', (d) => { for (const f of W.trova(path.join(d.home), 'host-context.json')) fs.writeFileSync(f, '{ non json'); }],
  ['contesto di un ALTRO lancio', (d) => {
    for (const f of W.trova(path.join(d.home), 'host-context.json')) {
      const c = JSON.parse(fs.readFileSync(f, 'utf8')); c.launchId = 'ee'.repeat(8); fs.writeFileSync(f, JSON.stringify(c));
    }
  }],
  ['pin del binario mancante', (d) => { fs.rmSync(path.join(d.home, '.nexuscrew', 'vl-control-pin'), { recursive: true, force: true }); }],
];

for (const [nome, guasto] of GUASTI_BARRIERA) {
  test(`vl: root preesistente e ${nome} => blocco, claim e record intatti`, async (t) => {
    const d = mondoVlCrashato(t);
    fs.mkdirSync(rootVl(d), { recursive: true, mode: 0o700 });
    guasto(d);
    const { runtime } = W.apriRuntime(d, {});
    t.after(() => { try { runtime.shutdown(); } catch (_) {} });
    await assert.rejects(() => runtime.down(d.cella), BLOCCO);
    assert.equal(W.lease(d).length, 1);
    assert.equal(launchTarget.leggi(d.filesRoot, d.sessione).stato, 'presente');
    assert.equal(fs.existsSync(quarantena(d)), false);
  });
}

test('vl: la root del record non e\' quella canonica del nodo e della cella => blocco', async (t) => {
  const d = mondoVlCrashato(t);
  const dato = JSON.parse(fs.readFileSync(W.fileRecord(d), 'utf8'));
  dato.res.vlRoot = '/tmp/altra/root';
  fs.writeFileSync(W.fileRecord(d), JSON.stringify(dato));
  const { runtime } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  await assert.rejects(() => runtime.down(d.cella), BLOCCO);
  assert.equal(W.lease(d).length, 1);
});
