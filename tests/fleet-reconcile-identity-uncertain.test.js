'use strict';
// S2b — conferma dell'operatore per un record GIA' MATERIALIZZATO la cui
// identita' del server non e' verificabile (serverPid assente, oppure PID
// nominato senza nascita). La strada e' distinta da quella legacy: stessa rotta
// e stesso corpo stretto, azione `archivia-identita-incerta`. Il difetto che
// questi test fissano: la classe R1 restava ingessata per sempre (server
// originario non verificabile), e l'unica uscita era la mano dell'operatore sul
// filesystem. Qui l'operatore la chiude dalla PWA, con una traccia durevole
// PRIMA della quarantena e le stesse barriere del reconcile.
//
// Mondo route-end-to-end: createBuiltinFleet su home/root temporanee, token
// temporaneo, tmux finto pilotato da uno scenario JSON mutabile.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const express = require('express');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { fleetRoutes } = require('../lib/fleet/routes.js');
const { requireToken } = require('../lib/auth/middleware.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const W = require('./helpers/launch-world.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');

const CELLA = 'Cella';
const SESSIONE = 'cloud-Cella';
const LID = 'cd'.repeat(8);
const BOOT = '11111111-1111-4111-8111-111111111111';
const NS = '4026531836';
const OWNER = 'ab'.repeat(16);
const MOTIVO = 'verificata sul nodo, sessione assente sotto ogni nome';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function figlioVivo(t) {
  const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000);'], { detached: true, stdio: 'ignore' });
  f.unref();
  t.after(() => { try { process.kill(f.pid, 'SIGKILL'); } catch (_) { /* gia' uscito */ } });
  return f;
}

async function morto(pid) {
  process.kill(pid, 'SIGKILL');
  const fine = Date.now() + 5000;
  while (Date.now() < fine) {
    try { process.kill(pid, 0); } catch (_) { return; }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// tmux finto: scenario JSON RILETTO a ogni invocazione. Le sole letture della
// via attestata: list-sessions, display-message (-p '#{pid}' ; <query>),
// has-session, list-panes. Nessuna creazione, nessuno stop.
function scriptTmux({ scenario, stato, log, sessioneNome }) {
  return `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
const SCEN = ${JSON.stringify(scenario)};
const STATO = ${JSON.stringify(stato)};
const LOG = ${JSON.stringify(log)};
const NOME = ${JSON.stringify(sessioneNome)};
const sc = () => { try { return JSON.parse(fs.readFileSync(SCEN, 'utf8')); } catch (_) { return {}; } };
const nota = (riga) => { try { fs.appendFileSync(LOG, JSON.stringify(riga) + '\\n'); } catch (_) {} };
nota(args);
const S = sc();
const vivi = (target, perId) => (target.startsWith('=')
  ? S.omonima === true
  : (perId ? S.idVivo === true : S.omonima === true));
if (args[0] === 'list-sessions') process.exit(0);
if (args[0] === 'display-message') {
  if (S.nessunServer) {
    process.stderr.write('no server running on /tmp/fake\\n');
    // A4: l'exit code fa parte del verdetto. Un'assenza dichiarata con un
    // codice diverso da 1 (lettura interrotta) non e' un'assenza.
    process.exit(Number.isSafeInteger(S.nessunServerExit) ? S.nessunServerExit : 1);
  }
  const semi = args.indexOf(';');
  const coda = semi >= 0 ? args.slice(semi + 1) : [];
  const i = coda.lastIndexOf('-t');
  const bersaglio = i >= 0 ? String(coda[i + 1]) : '';
  const perId = bersaglio.startsWith('$') || bersaglio.startsWith('%');
  // A4: l'omonima compare DOPO le prime letture del nome (contatore delle sole
  // query sul nome). Serve a provare il veto finale sul nome, dopo le query
  // per id, e non solo il primo sguardo.
  let presentiPerNome = S.omonima === true;
  if (!perId && bersaglio.startsWith('=') && S.omonimaDopo != null) {
    const contatore = LOG + '.nameq';
    let n = 0;
    try { n = Number(fs.readFileSync(contatore, 'utf8')) || 0; } catch (_) { n = 0; }
    n += 1;
    try { fs.writeFileSync(contatore, String(n)); } catch (_) { /* best-effort */ }
    if (n >= S.omonimaDopo) presentiPerNome = true;
  }
  // serverSostituito: la seconda lettura arriva a un ALTRO listener (pid
  // diverso): la sonda deve rifiutare, non rispondere per un altro server.
  const pid = perId && S.serverSostituito != null ? S.serverSostituito : (S.server || 4242);
  process.stdout.write(String(pid) + '\\n');
  if (coda[0] === 'list-panes') {
    if (S.paneVivo === true) process.exit(0);
    process.stderr.write("can't find pane: " + bersaglio + '\\n');
    process.exit(1);
  }
  if (semi < 0) process.exit(0);
  if (vivi(bersaglio, perId) || (!perId && presentiPerNome)) process.exit(0);
  process.stderr.write("can't find session: " + (bersaglio || NOME) + '\\n');
  process.exit(1);
}
if (args[0] === 'has-session') {
  if (S.nessunServer) { process.stderr.write('no server running on /tmp/fake\\n'); process.exit(1); }
  const bersaglio = args.indexOf('-t') >= 0 ? String(args[args.indexOf('-t') + 1]) : '';
  const perId = bersaglio.startsWith('$') || bersaglio.startsWith('%');
  if (vivi(bersaglio, perId)) process.exit(0);
  process.stderr.write("can't find session: " + (bersaglio || NOME) + '\\n');
  process.exit(1);
}
if (args[0] === 'list-panes') {
  if (S.nessunServer) { process.stderr.write('no server running on /tmp/fake\\n'); process.exit(1); }
  const bersaglio = args.indexOf('-t') >= 0 ? String(args[args.indexOf('-t') + 1]) : '';
  if (S.paneVivo === true) { process.stdout.write('%0\\n'); process.exit(0); }
  process.stderr.write("can't find pane: " + bersaglio + '\\n');
  process.exit(1);
}
process.exit(0);
`;
}

async function mondo(t, { cfg = {}, scenario = {}, routes = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-incerta-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o755 });
  fs.chmodSync(home, 0o755);
  const cwd = path.join(home, CELLA);
  fs.mkdirSync(cwd, { recursive: true });
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot, { recursive: true });
  fs.mkdirSync(path.join(filesRoot, 'launch-targets'), { recursive: true, mode: 0o700 });
  const scenarioPath = path.join(root, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({ server: 4242, ...scenario }));
  const callsLog = path.join(root, 'tmux-calls.log');
  fs.writeFileSync(callsLog, '');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  fs.writeFileSync(tmuxBin, scriptTmux({
    scenario: scenarioPath, stato: path.join(root, 'tmux-stato'), log: callsLog, sessioneNome: SESSIONE,
  }), { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  const client = path.join(home, 'client');
  fs.writeFileSync(client, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(client, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'client', label: 'Client', rc: false, command: client, args: [], env: {}, promptMode: 'flag', promptFlag: '--prompt' }],
    cells: [{ id: CELLA, tmuxSession: SESSIONE, cwd, engine: 'client', boot: false }],
  });
  const TOKEN = crypto.randomBytes(24).toString('hex');
  const nodo = { attuale: { bootId: BOOT, pidNamespaceInode: NS } };
  const fleet = await createBuiltinFleet({
    home, fleetDefsPath: defsPath, tmuxBin, filesRoot, builtinEnabled: true, cellLeaseEnabled: false,
    identityOwnerInstanceId: OWNER,
    identitaNodoKernel: () => nodo.attuale,
    reconcileLegacyAttest: true,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'a'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    log: () => {},
    ...cfg,
  });
  assert.equal(fleet.available, true, fleet.reason || 'fleet non disponibile');
  const app = express();
  app.use('/api', requireToken({ get: () => TOKEN }));
  app.use('/api/fleet', fleetRoutes(Promise.resolve(fleet), routes));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.once('listening', res));
  t.after(() => {
    try { server.close(); } catch (_) { /* gia' chiuso */ }
    try { fleet.close(); } catch (_) { /* best-effort */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (rotta, body, { token = TOKEN, headers = {} } = {}) => {
    const r = await fetch(`${base}/api/fleet${rotta}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return {
    root, home, filesRoot, defsPath, scenarioPath, callsLog, nodo, fleet, base, post, TOKEN,
    cella: CELLA, sessione: SESSIONE,
  };
}

function impostaScenario(d, parziale) {
  const cur = JSON.parse(fs.readFileSync(d.scenarioPath, 'utf8'));
  fs.writeFileSync(d.scenarioPath, JSON.stringify({ ...cur, ...parziale }));
}

// Record v1 completo (materializzato) SENZA identita' del server: il
// supervisore registrato e' morto per identita'. `serverPid` resta nullo
// oppure nomina un PID senza nascita, secondo il caso.
function scriviRecord(d, {
  family = 'other', panePid, paneStarttime, serverPid = null, launchId = LID,
  sessionId = '$0', paneId = '%0',
} = {}) {
  const dato = {
    version: 1, launchId, sessionId, paneId,
    tmuxSocket: sharedTmuxSocketPath(), serverPid, panePid, paneStarttime, ts: Date.now(),
  };
  if (family !== null) dato.family = family;
  const bytes = Buffer.from(`${JSON.stringify(dato)}\n`);
  const file = path.join(d.filesRoot, 'launch-targets', `${SESSIONE}.json`);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { bytes, sha256: sha256Hex(bytes) };
}

const percorsoRecord = (d) => path.join(d.filesRoot, 'launch-targets', `${SESSIONE}.json`);
const percorsoQuarantena = (d, launchId = LID) => launchTarget.percorsoQuarantena(d.filesRoot, SESSIONE, launchId);
const percorsoAtto = (d, launchId = LID) => launchTarget.percorsoAtto(d.filesRoot, SESSIONE, launchId);
const leggiBytes = (p) => fs.readFileSync(p);

const anteprima = (d, launchId = LID) => d.post('/reconcile', { cell: CELLA, launchId, attest: { azione: 'anteprima' } });

// A6: la conferma porta il token firmato dell'anteprima. Il default lo prende
// da un'anteprima vera (sola lettura); `previewToken` esplicito serve ai test
// della scadenza e della manomissione.
async function conferma(d, {
  sha, bootId = BOOT, owner = OWNER, hostAssente = false, motivo = MOTIVO,
  launchId = LID, opz = {}, previewToken = null,
} = {}) {
  let token = previewToken;
  if (token === null) {
    const av = await anteprima(d, launchId);
    token = av && av.json && typeof av.json.previewToken === 'string'
      ? av.json.previewToken : '0'.repeat(64);
  }
  return d.post('/reconcile', {
    cell: CELLA, launchId,
    attest: {
      azione: 'archivia-identita-incerta',
      conferma: { recordSha256: sha, bootId, ownerInstanceId: owner, hostAssente, motivo, previewToken: token },
    },
  }, opz);
}

// Il fixture di base: supervisore registrato MORTO, nessuna identita' di
// server, nessuna omonima sul listener corrente.
async function baseMaterializzata(t, over = {}) {
  const d = await mondo(t, over.mondo || {});
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const sup = figlioVivo(t);
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const rec = scriviRecord(d, { panePid: sup.pid, paneStarttime: start, ...over.record });
  return { d, rec, sup };
}

test('incerta: anteprima idonea (server non nominato), conferma, quarantena byte-identica e traccia', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const av = await anteprima(d);
  assert.equal(av.status, 200, JSON.stringify(av.json));
  assert.equal(av.json.outcome, 'anteprima');
  assert.equal(av.json.classification, 'proven-dead');
  const elig = av.json.eligibleAttestation;
  assert.ok(elig, JSON.stringify(av.json.motiviRifiuto));
  assert.equal(elig.variante, 'archivia-identita-incerta');
  assert.equal(elig.family, 'other');
  assert.equal(elig.atteso.hostAssente, false);
  assert.equal(elig.evidenze.server.prova, 'unknown');
  assert.equal(elig.evidenze.server.pidNominato, false);
  assert.equal(elig.evidenze.supervisore, 'dead-by-identity');
  assert.equal(elig.evidenze.lease, 'none');
  assert.equal(elig.evidenze.host, 'not-vl');
  assert.equal(elig.evidenze.sonda.esito, 'assente');
  assert.equal((elig.avvertenza || []).join(' ').match(/proves nothing about the recorded server/) !== null, true);
  // zero mutazioni dall'anteprima
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0, 'anteprima muta il record');
  assert.equal(fs.existsSync(percorsoAtto(d)), false, 'anteprima scrive la traccia');

  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'reconciled');
  assert.equal(r.json.prova, 'operator-attest-identita-incerta');
  assert.equal(r.json.host, 'not-vl');
  assert.equal(r.json.backup, true);
  assert.match(r.json.provaOperatore, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(percorsoRecord(d)), false, 'record non rimosso');
  assert.equal(leggiBytes(percorsoQuarantena(d)).compare(rec.bytes), 0, 'quarantena non byte-identica');
  const atto = JSON.parse(leggiBytes(percorsoAtto(d)).toString('utf8'));
  assert.equal(atto.schema, 'operator-attest-identity-uncertain');
  assert.equal(atto.atto, 'archivia-identita-incerta');
  assert.equal(atto.esito, 'intent', 'la decisione resta l\'intenzione, mai un esito');
  assert.equal(atto.autorita, 'fleet-bearer');
  assert.equal(atto.supervisore, 'dead-by-identity');
  assert.equal(atto.decisione.sonda, 'assente');
  assert.equal(atto.motivo, MOTIVO);
  // seconda conferma: idempotente, e non attribuisce merito a un secondo atto
  const r2 = await conferma(d, { sha: rec.sha256 });
  assert.equal(r2.json.outcome, 'not-needed');
  assert.equal(fs.readFileSync(percorsoAtto(d), 'utf8'), JSON.stringify(atto) + '\n');
});

test('incerta: un\'omonima compare sul listener fra anteprima e conferma => rifiuto, record intatto, nessun atto', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const av = await anteprima(d);
  assert.ok(av.json.eligibleAttestation);
  impostaScenario(d, { omonima: true });
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'not-eligible');
  assert.equal(r.json.code, 'SESSION_PRESENT');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0, 'il record non va toccato');
  assert.equal(fs.existsSync(percorsoAtto(d)), false, 'nessun atto di archiviazione');
  assert.equal(fs.existsSync(percorsoQuarantena(d)), false, 'nessuna quarantena');
});

test('incerta: il listener cambia fra le due letture (pid diverso) => rifiuto ignoto, nessun atto', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const av = await anteprima(d);
  assert.ok(av.json.eligibleAttestation, JSON.stringify(av.json.motiviRifiuto));
  impostaScenario(d, { serverSostituito: 5000 });
  const r = await conferma(d, { sha: rec.sha256, previewToken: av.json.previewToken });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'SESSION_UNKNOWN');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta: un ID originale presente sul corrente è un veto (non un duplicato provato)', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const av = await anteprima(d);
  assert.ok(av.json.eligibleAttestation, JSON.stringify(av.json.motiviRifiuto));
  impostaScenario(d, { idVivo: true });
  const r = await conferma(d, { sha: rec.sha256, previewToken: av.json.previewToken });
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'SESSION_PRESENT');
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
});

test('incerta: PID nominato senza nascita e vivo => la classe resta idonea e la conferma chiude', async (t) => {
  const figlio = figlioVivo(t);
  const d = await mondo(t);
  const sup = figlioVivo(t);
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const rec = scriviRecord(d, { panePid: sup.pid, paneStarttime: start, serverPid: figlio.pid });
  const av = await anteprima(d);
  assert.ok(av.json.eligibleAttestation, JSON.stringify(av.json.motiviRifiuto));
  assert.equal(av.json.eligibleAttestation.evidenze.server.prova, 'unqualified-alive');
  assert.equal(av.json.eligibleAttestation.evidenze.server.pidNominato, true);
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.json.outcome, 'reconciled', JSON.stringify(r.json));
});

test('incerta: supervisore vivo => non idonea, nessun atto', async (t) => {
  const d = await mondo(t);
  const sup = figlioVivo(t); // vivo
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const rec = scriviRecord(d, { panePid: sup.pid, paneStarttime: leggiStarttimeProc(sup.pid) });
  const av = await anteprima(d);
  assert.equal(av.json.eligibleAttestation, null);
  assert.ok(av.json.motiviRifiuto.includes('SUPERVISOR_ALIVE'), JSON.stringify(av.json.motiviRifiuto));
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.json.outcome, 'not-eligible');
  assert.equal(r.json.code, 'SUPERVISOR_ALIVE');
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
});

test('incerta: lease in grace => non idonea (fail closed)', async (t) => {
  const lm = {
    status: () => ({ state: 'grace' }), revokeControl: () => {},
    boot: async () => {}, close: () => {},
  };
  const d = await mondo(t, { cfg: { leaseManager: lm } });
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const sup = figlioVivo(t);
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const rec = scriviRecord(d, { panePid: sup.pid, paneStarttime: start });
  const av = await anteprima(d);
  assert.equal(av.json.eligibleAttestation, null);
  assert.ok(av.json.motiviRifiuto.includes('LEASE_BLOCKS'), JSON.stringify(av.json.motiviRifiuto));
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.json.outcome, 'not-eligible');
  assert.equal(r.json.code, 'LEASE_BLOCKS');
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
});

test('incerta: vl senza prova di macchina dell\'host => non idonea', async (t) => {
  const d = await mondo(t);
  const sup = figlioVivo(t);
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const rec = scriviRecord(d, { family: 'vl', panePid: sup.pid, paneStarttime: start });
  fs.mkdirSync(vlCellBaseDir(d.home, OWNER, CELLA), { recursive: true, mode: 0o700 });
  const av = await anteprima(d);
  assert.equal(av.json.eligibleAttestation, null, 'senza contesto host non c\'è prova di macchina');
  assert.ok(av.json.motiviRifiuto.includes('HOST_BARRIER'), JSON.stringify(av.json.motiviRifiuto));
  // C3 — un'anteprima non idonea non emette token: la conferma non è
  // proponibile, e il motivo vero (HOST_BARRIER) resta assertito sopra.
  const r = await conferma(d, { sha: rec.sha256, hostAssente: true });
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'PREVIEW_STALE');
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta: hash diverso => RECORD_CHANGED, nessun atto', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const r = await conferma(d, { sha: 'f'.repeat(64) });
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'RECORD_CHANGED');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta: hostAssente incoerente per family other => CONFERMA-NON-COERENTE', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const r = await conferma(d, { sha: rec.sha256, hostAssente: true });
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'CONFERMA-NON-COERENTE');
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta: traccia non scrivibile => 409, record intatto e nessuna quarantena', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const dirQuarantena = path.dirname(percorsoQuarantena(d));
  fs.mkdirSync(dirQuarantena, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirQuarantena, 0o500);
  t.after(() => { try { fs.chmodSync(dirQuarantena, 0o700); } catch (_) { /* best-effort */ } });
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(fs.existsSync(percorsoQuarantena(d)), false, 'nessuna quarantena senza traccia');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
});

test('incerta: la via federata non la porta (403 OWNER_ONLY)', async (t) => {
  const d = await mondo(t);
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const sup = figlioVivo(t);
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const rec = scriviRecord(d, { panePid: sup.pid, paneStarttime: start });
  const fed = await conferma(d, { sha: rec.sha256, opz: { headers: { 'x-nexuscrew-hop': 'proof' } } });
  assert.equal(fed.status, 403, JSON.stringify(fed.json));
  assert.equal(fed.json.code, 'OWNER_ONLY');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
  // Sullo stesso record, SENZA l'header di hop, la conferma e' dell'owner.
  const own = await conferma(d, { sha: rec.sha256 });
  assert.equal(own.status, 200, JSON.stringify(own.json));
  assert.equal(own.json.outcome, 'reconciled');
});

test('incerta: READONLY blocca la conferma come ogni mutazione', async (t) => {
  const d = await mondo(t, { routes: { readonlyDefault: true } });
  const sup = figlioVivo(t);
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const rec = scriviRecord(d, { panePid: sup.pid, paneStarttime: start });
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.status, 403);
});

test('incerta: corpo non conforme => 400 (enum chiusa, chiavi esatte)', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const r = await d.post('/reconcile', {
    cell: CELLA, launchId: LID,
    attest: {
      azione: 'archivia-identita-incerta',
      conferma: { recordSha256: rec.sha256, bootId: BOOT, ownerInstanceId: OWNER, hostAssente: false, motivo: MOTIVO, extra: 1 },
    },
  });
  assert.equal(r.status, 400);
  const r2 = await d.post('/reconcile', {
    cell: CELLA, launchId: LID,
    attest: { azione: 'archivia-identita-incerta', conferma: { recordSha256: rec.sha256 } },
  });
  assert.equal(r2.status, 400);
});

test('incerta: la via legacy resta invariata (v1 incompleto non idoneo all\'una e all\'altra)', async (t) => {
  const d = await mondo(t);
  const dato = {
    version: 1, launchId: LID, sessionId: '$0', paneId: '%0',
    tmuxSocket: '/tmp/nc-incerta-socket', serverPid: null, panePid: null, paneStarttime: null, ts: Date.now(),
  };
  const bytes = Buffer.from(`${JSON.stringify(dato)}\n`);
  fs.writeFileSync(percorsoRecord(d), bytes, { mode: 0o600 });
  const sha = sha256Hex(bytes);
  const av = await anteprima(d);
  assert.equal(av.json.classification, 'legacy-unprovable');
  assert.equal(av.json.eligibleAttestation, null);
  const r = await conferma(d, { sha });
  assert.equal(r.json.outcome, 'not-eligible');
  assert.equal(r.json.code, 'LEGACY_UNPROVABLE');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(bytes), 0);
  // la conferma legacy dello stesso record resta quella di sempre
  const leg = await d.post('/reconcile', {
    cell: CELLA, launchId: LID,
    attest: {
      azione: 'archivia-legacy',
      conferma: { recordSha256: sha, bootId: BOOT, ownerInstanceId: OWNER, hostAssente: true, motivo: MOTIVO },
    },
  });
  assert.equal(leg.json.outcome, 'reconciled', JSON.stringify(leg.json));
  assert.equal(leg.json.prova, 'operator-attest');
});

// ---------------------------------------------------------------------------
// Tranche VL: la conferma per identita' incerta vale anche per una cella vl,
// ma SOLO con la prova di macchina POSITIVA dell'host nel suo contesto
// canonico (root assente dentro la base qualificata, oppure host `none`).
// Mai un host vivo o ignoto: qui la prova la da' la macchina, non l'operatore.
// ---------------------------------------------------------------------------
function scriviContestoHost(d, { launchId = LID, root } = {}) {
  const base = vlCellBaseDir(d.home, OWNER, CELLA);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o700);
  const ctx = {
    launchId,
    vlBin: path.join(d.root, 'vl-finto'),
    vlBinSha256: 'ab'.repeat(32),
    XDG_STATE_HOME: path.join(base, 'xdg-state'),
    XDG_DATA_HOME: path.join(base, 'xdg-data'),
    XDG_CONFIG_HOME: path.join(base, 'xdg-config'),
    HOME: base,
    uid: process.getuid(),
    serverRoot: root || path.join(base, 'state', 'vl', 'host-v1'),
    ts: Date.now(),
    version: 2,
    hostIdentity: { state: 'none' },
  };
  fs.writeFileSync(path.join(base, 'host-context.json'), JSON.stringify(ctx), { mode: 0o600 });
  fs.chmodSync(path.join(base, 'host-context.json'), 0o600);
  return { base, root: ctx.serverRoot };
}

test('incerta/vl: root assente nel contesto canonico => prova di macchina positiva, conferma chiusa', async (t) => {
  const d = await mondo(t);
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const sup = figlioVivo(t);
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const rec = scriviRecord(d, { family: 'vl', panePid: sup.pid, paneStarttime: start });
  const { base } = scriviContestoHost(d);
  const av = await anteprima(d);
  const elig = av.json.eligibleAttestation;
  assert.ok(elig, JSON.stringify(av.json.motiviRifiuto));
  assert.equal(elig.family, 'vl');
  assert.equal(elig.evidenze.host, 'root-absent');
  assert.equal(elig.atteso.hostAssente, true);
  const r = await conferma(d, { sha: rec.sha256, hostAssente: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'reconciled', JSON.stringify(r.json));
  assert.equal(r.json.host, 'root-absent', 'l\'esito porta la prova di macchina, non un\'asserzione');
  assert.match(r.json.provaOperatore, /^[0-9a-f]{64}$/);
  const atto = JSON.parse(leggiBytes(percorsoAtto(d)).toString('utf8'));
  assert.equal(atto.decisione.family, 'vl');
  assert.equal(atto.decisione.host, 'root-absent');
  assert.equal(leggiBytes(percorsoQuarantena(d)).compare(rec.bytes), 0);
  assert.ok(fs.existsSync(base), 'la base della cella non viene toccata');
});

test('incerta/vl: root PRESENTE e pin mancante => host non provato, nessun atto', async (t) => {
  const d = await mondo(t);
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const sup = figlioVivo(t);
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const rec = scriviRecord(d, { family: 'vl', panePid: sup.pid, paneStarttime: start });
  const { root } = scriviContestoHost(d);
  fs.mkdirSync(path.join(root, 'state', 'vl'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const av = await anteprima(d);
  assert.equal(av.json.eligibleAttestation, null, 'senza la prova di macchina non c\'è idoneità');
  assert.ok(av.json.motiviRifiuto.includes('HOST_BARRIER'), JSON.stringify(av.json.motiviRifiuto));
  const r = await conferma(d, { sha: rec.sha256, hostAssente: true });
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'PREVIEW_STALE');
  assert.equal(r.json.host, undefined);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
});

// ---------------------------------------------------------------------------
// Casi di controllo aggiuntivi per l'attestazione di identita' incerta (A1..A6).
// ---------------------------------------------------------------------------

// Record v2 `attested` e qualificato: la stessa classe del fixture v1, ma coi
// campi che legano la prova al RECORD (owner e namespace dei processi).
function scriviRecordV2(d, {
  family = 'other', panePid, paneStarttime, serverPid = null, serverStarttime = null,
  launchId = LID, ownerInstanceId = OWNER, pidNs = NS,
} = {}) {
  const dato = {
    version: 2, phase: 'attested', launchId, family, cellId: CELLA, session: SESSIONE,
    ownerInstanceId, tmuxSocket: sharedTmuxSocketPath(), bootId: BOOT, pidNs,
    daemonInc: 'inc-test', res: null, sessionId: '$0', windowId: '@0', paneId: '%0',
    serverPid, serverStarttime, holdPid: null, holdStarttime: null,
    panePid, paneStarttime, ts: Date.now(),
  };
  const bytes = Buffer.from(`${JSON.stringify(dato)}\n`);
  const file = path.join(d.filesRoot, 'launch-targets', `${SESSIONE}.json`);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { bytes, sha256: sha256Hex(bytes) };
}

test('incerta/A1: PID con nascita registrata e lettura inconcludente => non idoneo (SERVER_QUALIFIED)', async (t) => {
  const sup = figlioVivo(t);
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  // Il record NOMINA un server qualificato (PID + nascita); la lettura di
  // /proc non conclude (presente senza nascita). Prima del rientro questo
  // diventava `unknown` e la classe lo accettava: la prova che manca qui e'
  // di macchina, e l'operatore non la sostituisce.
  const d = await mondo(t, { cfg: { leggiIdentitaProc: () => ({ esito: 'presente' }) } });
  // Il record v1 non porta la nascita: per esercitare A1 serve un v2. Il PID
  // del server è VIVO (un figlio vero) e la nascita è registrata: la lettura
  // che non conclude non è una prova del valutatore, ma il perimetro si legge
  // sul record.
  const serverVivo = figlioVivo(t);
  const r2 = scriviRecordV2(d, {
    panePid: sup.pid, paneStarttime: start, serverPid: serverVivo.pid, serverStarttime: start,
  });
  const av = await anteprima(d);
  assert.equal(av.status, 200, JSON.stringify(av.json));
  assert.equal(av.json.eligibleAttestation, null, 'un PID con nascita non è la classe 2A');
  assert.ok((av.json.motiviRifiuto || []).includes('SERVER_QUALIFIED'), JSON.stringify(av.json.motiviRifiuto));
  const r = await conferma(d, { sha: r2.sha256 });
  assert.equal(r.json.outcome, 'not-eligible');
  assert.equal(r.json.code, 'SERVER_QUALIFIED');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(r2.bytes), 0);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta/A1: v2 con PID nominato SENZA nascita resta nella classe 2A (controprova del perimetro)', async (t) => {
  // Controprova del perimetro: un v2 SENZA nascita registrata (PID nominato
  // senza serverStarttime) resta nella classe 2A.
  const sup = figlioVivo(t);
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const d = await mondo(t);
  const serverVivo = figlioVivo(t);
  const rec = scriviRecordV2(d, {
    panePid: sup.pid, paneStarttime: start, serverPid: serverVivo.pid,
  });
  const av = await anteprima(d);
  assert.ok(av.json.eligibleAttestation, JSON.stringify(av.json.motiviRifiuto));
  assert.equal(av.json.eligibleAttestation.evidenze.server.nascita, 'assente');
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.json.outcome, 'reconciled', JSON.stringify(r.json));
});

test('incerta/A2: v2 con un ALTRO owner => OWNER_MISMATCH, nessun effetto', async (t) => {
  const sup = figlioVivo(t);
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const d = await mondo(t);
  const rec = scriviRecordV2(d, {
    panePid: sup.pid, paneStarttime: start, ownerInstanceId: 'cd'.repeat(16),
  });
  const av = await anteprima(d);
  assert.equal(av.json.eligibleAttestation, null);
  assert.ok(av.json.motiviRifiuto.includes('OWNER_MISMATCH'), JSON.stringify(av.json.motiviRifiuto));
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.json.outcome, 'not-eligible');
  assert.equal(r.json.code, 'OWNER_MISMATCH');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta/A2: v2 con un ALTRO namespace dei processi => NAMESPACE_MISMATCH', async (t) => {
  const sup = figlioVivo(t);
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const d = await mondo(t);
  const rec = scriviRecordV2(d, { panePid: sup.pid, paneStarttime: start, pidNs: '4026999999' });
  const av = await anteprima(d);
  assert.equal(av.json.eligibleAttestation, null);
  assert.ok(av.json.motiviRifiuto.includes('NAMESPACE_MISMATCH'), JSON.stringify(av.json.motiviRifiuto));
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.json.code, 'NAMESPACE_MISMATCH');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
});

test('incerta/A3: journal pendente di un\'ALTRA pratica => COMMIT_PENDENTE, nessun effetto', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const altro = 'ef'.repeat(8);
  fs.writeFileSync(launchTarget.percorsoJournal(d.filesRoot, SESSIONE), JSON.stringify({
    v: 1, sessione: SESSIONE, launchId: altro, sha256: rec.sha256,
    quarantena: path.relative(
      path.join(d.filesRoot, launchTarget.DIR),
      launchTarget.percorsoQuarantena(d.filesRoot, SESSIONE, altro),
    ),
  }));
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'COMMIT_PENDENTE');
  // Il record della pratica confermata NON è stato spostato né toccato.
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
  assert.equal(fs.existsSync(launchTarget.percorsoQuarantena(d.filesRoot, SESSIONE, altro)), false);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta/C1: journal pendente della STESSA pratica => COMMIT_PENDENTE, nessun recupero', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const journal = launchTarget.percorsoJournal(d.filesRoot, SESSIONE);
  const prima = JSON.stringify({
    v: 1, sessione: SESSIONE, launchId: LID, sha256: rec.sha256,
    quarantena: path.relative(
      path.join(d.filesRoot, launchTarget.DIR),
      launchTarget.percorsoQuarantena(d.filesRoot, SESSIONE, LID),
    ),
  });
  fs.writeFileSync(journal, prima);
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'COMMIT_PENDENTE');
  // Nessun recupero: il journal resta esattamente com'era, il record non si
  // sposta e l'atto attestato non si attribuisce il completamento.
  assert.equal(fs.readFileSync(journal, 'utf8'), prima, 'il journal è stato completato');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
  assert.equal(fs.existsSync(percorsoQuarantena(d)), false);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta/C1: journal presente ma non verificabile (link pendente) => COMMIT_PENDENTE', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const journal = launchTarget.percorsoJournal(d.filesRoot, SESSIONE);
  // Un link pendente È un artefatto di journal presente: l'assenza del suo
  // bersaglio non è l'assenza del journal.
  fs.symlinkSync(path.join(d.filesRoot, 'niente', 'manca.json'), journal);
  assert.equal(fs.existsSync(journal), false, 'il link deve essere pendente');
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'COMMIT_PENDENTE');
  assert.ok(fs.lstatSync(journal).isSymbolicLink(), 'il link resta al suo posto');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta/C1: journal presente ma illeggibile (EACCES) => COMMIT_PENDENTE', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const opaca = path.join(d.filesRoot, 'opaca');
  fs.mkdirSync(opaca, { mode: 0o000 });
  t.after(() => { try { fs.chmodSync(opaca, 0o755); } catch (_) {} });
  const journal = launchTarget.percorsoJournal(d.filesRoot, SESSIONE);
  fs.symlinkSync(path.join(opaca, 'commit.json'), journal);
  // Ogni errore diverso da ENOENT è «non verificabile», e vale come pendente.
  assert.throws(() => fs.statSync(journal), (e) => e && e.code === 'EACCES');
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'COMMIT_PENDENTE');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta/A6: token d\'anteprima manomesso => PREVIEW_STALE, nessun atto', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const av = await anteprima(d);
  const token = av.json.previewToken;
  assert.equal(typeof token, 'string');
  const manomesso = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  const r = await conferma(d, { sha: rec.sha256, previewToken: manomesso });
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'PREVIEW_STALE');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta/C3: token scaduto (120 s) sull\'orologio MONOTONO => PREVIEW_STALE', async (t) => {
  let mono = 5_000_000;
  const d = await mondo(t, { cfg: { monotonicNow: () => mono } });
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const sup = figlioVivo(t);
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const rec = scriviRecord(d, { panePid: sup.pid, paneStarttime: start });
  const av = await anteprima(d);
  const token = av.json.previewToken;
  assert.equal(typeof token, 'string');
  mono += 121_000;
  const r = await conferma(d, { sha: rec.sha256, previewToken: token });
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'PREVIEW_STALE');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta/C3: un arretramento dell\'ora di parete non riapre il TTL', async (t) => {
  let adesso = 1_700_000_000_000;
  let mono = 5_000_000;
  const d = await mondo(t, { cfg: { now: () => adesso, monotonicNow: () => mono } });
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const sup = figlioVivo(t);
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const rec = scriviRecord(d, { panePid: sup.pid, paneStarttime: start });
  const av = await anteprima(d);
  const token = av.json.previewToken;
  mono += 121_000;
  adesso -= 600_000;
  const r = await conferma(d, { sha: rec.sha256, previewToken: token });
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'PREVIEW_STALE');
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta/C3: un\'anteprima NON idonea non emette alcun token', async (t) => {
  const sup = figlioVivo(t);
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const d = await mondo(t);
  scriviRecordV2(d, { panePid: sup.pid, paneStarttime: start, ownerInstanceId: 'cd'.repeat(16) });
  const av = await anteprima(d);
  assert.equal(av.json.eligibleAttestation, null);
  assert.equal(av.json.previewToken, null);
});

test('incerta/A2: namespace nominato dal record e identità locale parziale => rifiuto esplicito', async (t) => {
  const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
  const sup = figlioVivo(t);
  const start = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  const d = await mondo(t);
  scriviRecordV2(d, { panePid: sup.pid, paneStarttime: start, pidNs: NS });
  // Il nodo locale non sa dire il proprio namespace: con un record che ne
  // NOMINA uno non si può concludere che coincida.
  d.nodo.attuale = { bootId: BOOT };
  const av = await anteprima(d);
  assert.equal(av.json.eligibleAttestation, null);
  assert.ok(
    av.json.motiviRifiuto.includes('NAMESPACE_UNVERIFIABLE'),
    JSON.stringify(av.json.motiviRifiuto),
  );
});

test('incerta/A4: l\'omonima compare DOPO le query per id => il veto finale sul nome la vede', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  // Anteprima: due letture del nome (primo sguardo + veto finale). Conferma:
  // terzo sguardo pulito, poi la comparsa alla quarta lettura, che è il veto
  // finale DOPO le query per id. Senza il veto finale l'atto passerebbe.
  const av = await anteprima(d);
  assert.ok(av.json.eligibleAttestation, JSON.stringify(av.json.motiviRifiuto));
  impostaScenario(d, { omonimaDopo: 4 });
  const r = await conferma(d, { sha: rec.sha256 });
  assert.equal(r.json.outcome, 'blocked', JSON.stringify(r.json));
  assert.equal(r.json.code, 'SESSION_PRESENT');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta/A4: «no server running» con exit code diverso da 1 non è un\'assenza', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const av = await anteprima(d);
  assert.ok(av.json.eligibleAttestation);
  impostaScenario(d, { nessunServer: true, nessunServerExit: 2 });
  const r = await conferma(d, { sha: rec.sha256, previewToken: av.json.previewToken });
  assert.equal(r.json.outcome, 'blocked', JSON.stringify(r.json));
  assert.equal(r.json.code, 'SESSION_UNKNOWN');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(rec.bytes), 0);
  assert.equal(fs.existsSync(percorsoAtto(d)), false);
});

test('incerta/flag: le quattro combinazioni dei due gate di nodo', async (t) => {
  const casi = [
    { legacy: true, s2b: true, atteso: 'reconciled', propone: true },
    { legacy: true, s2b: false, atteso: 'not-enabled', propone: false },
    { legacy: false, s2b: true, atteso: 'reconciled', propone: true },
    { legacy: false, s2b: false, atteso: 'not-enabled', propone: false },
  ];
  for (const c of casi) {
    const { d, rec } = await baseMaterializzata(t, {
      mondo: { cfg: { reconcileLegacyAttest: c.legacy, reconcileServerUncertainAttest: c.s2b } },
    });
    const av = await anteprima(d);
    if (c.propone) {
      assert.ok(av.json.eligibleAttestation, `legacy=${c.legacy} s2b=${c.s2b}: ${JSON.stringify(av.json.motiviRifiuto)}`);
    } else {
      assert.equal(av.json.eligibleAttestation, null, `legacy=${c.legacy} s2b=${c.s2b}`);
      // Via S2b spenta: o l'anteprima è spenta del tutto, o la variante non
      // viene proposta col suo motivo.
      const motivi = av.json.motiviRifiuto || [];
      assert.ok(
        av.json.outcome === 'not-enabled' || motivi.includes('NOT_ENABLED'),
        JSON.stringify(av.json),
      );
    }
    const r = await conferma(d, { sha: rec.sha256 });
    assert.equal(r.json.outcome, c.atteso, `legacy=${c.legacy} s2b=${c.s2b}: ${JSON.stringify(r.json)}`);
  }
});

test('incerta/A6: conferma senza previewToken => 400 (chiave obbligatoria dell\'atto nuovo)', async (t) => {
  const { d, rec } = await baseMaterializzata(t);
  const r = await d.post('/reconcile', {
    cell: CELLA, launchId: LID,
    attest: {
      azione: 'archivia-identita-incerta',
      conferma: { recordSha256: rec.sha256, bootId: BOOT, ownerInstanceId: OWNER, hostAssente: false, motivo: MOTIVO },
    },
  });
  assert.equal(r.status, 400);
});
