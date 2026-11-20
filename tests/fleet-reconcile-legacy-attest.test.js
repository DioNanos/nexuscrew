'use strict';
// Attestazione esplicita del portatore del token fleet su un record di lancio
// v1 NON provabile, via reconcile + attest: anteprima in SOLA LETTURA e
// conferma compare-and-swap su {record, nodo, boot}. Tutto end-to-route con
// il provider builtin, un token temporaneo, una home e una root dei file
// temporanee e un tmux finto pilotato da scenario. Nessun tmux reale, nessun
// servizio vivo: i processi «supervisore» sono figli di test fermati per PID.
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

const CELLA = 'Cella';
const SESSIONE = 'cloud-Cella';
const OWNER = 'a1b2c3d4'.repeat(4);
const ALTRO_OWNER = 'b2c3d4e5'.repeat(4);
const LID = 'ab'.repeat(8);
const LID2 = 'cd'.repeat(8);
const BOOT = '11111111-1111-4111-8111-111111111111';
const BOOT_ALTRO = '22222222-2222-4222-8222-222222222222';
const NS = '4026531836';
const TS = 1748000000000;
const MOTIVO = 'chiusura dopo verifica operativa documentata';

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
  try { process.kill(pid, 'SIGKILL'); } catch (_) { return; }
  const fine = Date.now() + 5000;
  while (Date.now() < fine) {
    try { process.kill(pid, 0); } catch (_) { return; }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// tmux finto: scenario JSON RILETTO a ogni invocazione (mutabile durante il
// test), log delle chiamate, canale di controllo e creazione funzionanti.
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
const esiste = (n) => fs.existsSync(STATO + '.' + n);
const alza = (n) => fs.writeFileSync(STATO + '.' + n, '1');
const abbassa = (n) => { try { fs.unlinkSync(STATO + '.' + n); } catch (_) {} };
nota(args);
const S = sc();
const idSessione = String(S.ids || '$5 @7 %9').split(' ')[0];
const idPane = String(S.ids || '$5 @7 %9').split(' ')[2];
function eseguiComando(riga, n) {
  const testo = riga.trim();
  nota(['C:' + testo]);
  const cmd = testo.split(/\\s+/)[0];
  const frame = (corpo, ok) => process.stdout.write(
    '%begin 1 ' + n + ' 1\\n' + corpo + (ok ? '%end 1 ' + n + ' 1\\n' : '%error 1 ' + n + ' 1\\n'));
  if (cmd === 'display-message') {
    if (testo.includes('pane_pid')) {
      if (esiste('respawned')) return frame(S.server + '\\t' + S.supervisor + '\\n', true);
      return frame(S.server + '\\t' + S.hold + '\\n', true);
    }
    return frame('0\\t\\t%9\\n', true);
  }
  if (cmd === 'respawn-pane') { alza('respawned'); return frame('', true); }
  if (cmd === 'has-session') return frame('', true);
  if (cmd === 'kill-session') { abbassa('nato'); abbassa('respawned'); return frame('', true); }
  return frame('', true);
}
if (args[0] === '-C' && args.includes('new-session')) {
  if (S.mkdirAlNewSession) { try { fs.mkdirSync(S.mkdirAlNewSession, { recursive: true, mode: 0o700 }); } catch (_) {} }
  alza('nato');
  process.stdout.write('%begin 1 0 1\\n' + (S.ids || '$5 @7 %9') + '\\n%end 1 0 1\\n');
  let buf = '';
  let n = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!riga.trim()) continue;
      n += 1;
      eseguiComando(riga, n);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
if (args[0] === '-C') {
  process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  let buf = '';
  let n = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!riga.trim() || riga.includes('nc-control-open')) continue;
      n += 1;
      eseguiComando(riga, n);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
if (args[0] === 'list-sessions') {
  if (S.omonima) process.stdout.write(NOME + '\\t1\\n');
  process.exit(0);
}
if (args[0] === 'display-message' && args.includes(';')) {
  if (S.nessunServer) { process.stderr.write('no server running on /tmp/fake\\n'); process.exit(1); }
  process.stdout.write(String(S.serverOsservato != null ? S.serverOsservato : (S.server || 4242)) + '\\n');
  if (S.omonima) process.exit(0);
  process.stderr.write("can't find session: " + idSessione + '\\n');
  process.exit(1);
}
if (args[0] === 'has-session') {
  if (S.nessunServer) { process.stderr.write('no server running on /tmp/fake\\n'); process.exit(1); }
  if (S.omonima) process.exit(0);
  process.stderr.write("can't find session: " + idSessione + '\\n');
  process.exit(1);
}
if (args[0] === 'list-panes') {
  if (S.nessunServer) { process.stderr.write('no server running on /tmp/fake\\n'); process.exit(1); }
  const bersaglio = args.indexOf('-t') >= 0 ? String(args[args.indexOf('-t') + 1]) : '';
  if (S.omonima) { process.stdout.write(idPane + '\\n'); process.exit(0); }
  process.stderr.write("can't find pane: " + bersaglio + '\\n');
  process.exit(1);
}
if (args[0] === 'display-message') { process.stdout.write('0\\t\\t%9\\n'); process.exit(0); }
process.exit(0);
`;
}

// Mondo route-end-to-end: createBuiltinFleet su home e root dei file
// TEMPORANEE (verificabili), token temporaneo, identita' kernel con seam
// mutabile (per il cambio di boot fra i due passi).
async function mondo(t, { cfg = {}, scenario = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-attest-'));
  const home = path.join(root, 'home');
  // Explicit home mode: keep the fixture umask-independent (the product
  // rejects group-writable ancestors of the vl root / broker runtime dir).
  fs.mkdirSync(home, { recursive: true, mode: 0o755 });
  fs.chmodSync(home, 0o755);
  const cwd = path.join(home, CELLA);
  fs.mkdirSync(cwd, { recursive: true });
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot, { recursive: true });
  fs.mkdirSync(path.join(filesRoot, 'launch-targets'), { recursive: true, mode: 0o700 });
  const scenarioPath = path.join(root, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({ server: 4242, hold: 1111, supervisor: 2222, ...scenario }));
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
  app.use('/api/fleet', fleetRoutes(Promise.resolve(fleet), cfg.fleetRoutes || {}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.once('listening', res));
  t.after(() => {
    try { server.close(); } catch (_) { /* gia' chiuso */ }
    try { fleet.close(); } catch (_) { /* best-effort */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (rotta, body, token = TOKEN) => {
    const r = await fetch(`${base}/api/fleet${rotta}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
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

// Il record v1 incompleto «storico»: family ASSENTE (null in lettura),
// serverPid null, socket di un'altra incarnazione, niente nascita.
function scriviRecordV1(d, { launchId = LID, family = null, panePid = null, paneStarttime = null, serverPid = null, socket = '/tmp/ncbi-test', ts = TS } = {}) {
  const dato = {
    version: 1, launchId, sessionId: '$0', paneId: '%0',
    tmuxSocket: socket, serverPid, panePid, paneStarttime, ts,
  };
  if (family !== null) dato.family = family;
  const bytes = Buffer.from(`${JSON.stringify(dato)}\n`);
  fs.writeFileSync(path.join(d.filesRoot, 'launch-targets', `${SESSIONE}.json`), bytes, { mode: 0o600 });
  fs.chmodSync(path.join(d.filesRoot, 'launch-targets', `${SESSIONE}.json`), 0o600);
  return { bytes, sha256: sha256Hex(bytes) };
}

function percorsoRecord(d) { return path.join(d.filesRoot, 'launch-targets', `${SESSIONE}.json`); }
function percorsoQuarantena(d, launchId = LID) { return launchTarget.percorsoQuarantena(d.filesRoot, SESSIONE, launchId); }
function percorsoAtto(d, launchId = LID) { return launchTarget.percorsoAtto(d.filesRoot, SESSIONE, launchId); }
function aseguraReconciled(d) {
  fs.mkdirSync(path.join(d.filesRoot, 'launch-targets', 'reconciled'), { recursive: true, mode: 0o700 });
}
function percorsoJournal(d) { return launchTarget.percorsoJournal(d.filesRoot, SESSIONE); }

function leggiBytes(p) { return fs.readFileSync(p); }
function identico(a, b) { return Buffer.compare(leggiBytes(a), leggiBytes(b)) === 0; }

const anteprima = (d, launchId = LID) => d.post('/reconcile', { cell: CELLA, launchId, attest: { azione: 'anteprima' } });

function conferma(d, { sha, bootId = BOOT, owner = OWNER, hostAssente = true, motivo = MOTIVO, attestatore = 'turno serale', launchId = LID } = {}) {
  return d.post('/reconcile', {
    cell: CELLA, launchId,
    attest: {
      azione: 'archivia-legacy',
      conferma: {
        recordSha256: sha, bootId, ownerInstanceId: owner, hostAssente, motivo,
        ...(attestatore !== null ? { attestatoreDichiarato: attestatore } : {}),
      },
    },
  });
}

// ---------------------------------------------------------------------------
// La conferma non e' una prova di lettura dell'anteprima: hash e boot si
// possono ottenere altrove; l'autorita' e' il token, la CAS la rete di sicurezza.
// ---------------------------------------------------------------------------
test('attest: conferma costruita senza mai chiamare l\'anteprima riesce', async (t) => {
  const d = await mondo(t);
  const { sha256: sha } = scriviRecordV1(d);
  const r = await conferma(d, { sha });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'reconciled');
  assert.equal(r.json.prova, 'operator-attest');
});

// ---------------------------------------------------------------------------
// Binding al nodo: boot e owner riverificati al momento della conferma.
// ---------------------------------------------------------------------------
test('attest: boot cambiato fra i due passi rifiuta senza mutazioni', async (t) => {
  const d = await mondo(t);
  const { bytes, sha256: sha } = scriviRecordV1(d);
  const r = await conferma(d, { sha, bootId: BOOT_ALTRO });
  assert.equal(r.status, 200);
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'BOOT-CAMBIATO');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(bytes), 0, 'record mutato');
  assert.equal(fs.existsSync(percorsoAtto(d)), false, 'traccia scritta');
});

test('attest: owner diverso rifiuta senza mutazioni', async (t) => {
  const d = await mondo(t);
  const { bytes, sha256: sha } = scriviRecordV1(d);
  const r = await conferma(d, { sha, owner: ALTRO_OWNER });
  assert.equal(r.status, 200);
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'OWNER-DIVERSO');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(bytes), 0, 'record mutato');
  assert.equal(fs.existsSync(percorsoAtto(d)), false, 'traccia scritta');
});

// CAS 1: la conferma porta l'hash dei byte che ha deciso di archiviare. Un
// hash che non e' quello del record in questo istante non archivia niente.
test('attest: hash del record diverso da quello confermato rifiuta senza mutazioni', async (t) => {
  const d = await mondo(t);
  const { bytes } = scriviRecordV1(d);
  const r = await conferma(d, { sha: 'f'.repeat(64) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'RECORD_CHANGED');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(bytes), 0, 'record mutato');
  assert.equal(fs.existsSync(percorsoAtto(d)), false, 'traccia scritta');
  assert.equal(fs.existsSync(percorsoQuarantena(d)), false, 'quarantena scritta');
});

test('attest: identita\' kernel mancante o malformata rifiuta', async (t) => {
  const d = await mondo(t);
  const { sha256: sha } = scriviRecordV1(d);
  d.nodo.attuale = { bootId: 'non-uuid', pidNamespaceInode: NS };
  const r = await conferma(d, { sha });
  assert.equal(r.status, 200);
  assert.equal(r.json.outcome, 'blocked');
  assert.equal(r.json.code, 'IDENTITA-NODO');
  assert.equal(fs.existsSync(percorsoRecord(d)), true, 'record rimosso');
});

test('attest: sul positivo la traccia porta owner, boot, namespace e hash letti allora', async (t) => {
  const d = await mondo(t);
  const figlio = figlioVivo(t);
  await morto(figlio.pid);
  const { sha256: sha } = scriviRecordV1(d, { panePid: figlio.pid });
  const r = await conferma(d, { sha });
  assert.equal(r.json.outcome, 'reconciled', JSON.stringify(r.json));
  const atto = JSON.parse(leggiBytes(percorsoAtto(d)).toString('utf8'));
  assert.equal(atto.ownerInstanceId, OWNER);
  assert.equal(atto.bootId, BOOT);
  assert.equal(atto.pidNs, NS);
  assert.equal(atto.recordSha256, sha);
  assert.equal(atto.supervisore, 'assente');
});

// ---------------------------------------------------------------------------
// Il positivo end-to-end sul record storico.
// ---------------------------------------------------------------------------
test('attest: positivo end-to-end — anteprima, conferma, quarantena byte-identica, traccia, up dopo', async (t) => {
  const d = await mondo(t);
  const { bytes, sha256: sha } = scriviRecordV1(d);
  const av = await anteprima(d);
  assert.equal(av.status, 200, JSON.stringify(av.json));
  assert.equal(av.json.outcome, 'anteprima');
  assert.equal(av.json.atteso.hostAssente, true);
  assert.equal(av.json.base.stato, 'assente');
  assert.equal(av.json.family, null);
  assert.equal(av.json.ownerInstanceId, OWNER);
  assert.equal(av.json.bootId, BOOT);
  const avvertenza = (av.json.avvertenza || []).join(' ');
  assert.match(avvertenza, /do NOT prove the death of survivors/);
  assert.match(avvertenza, /the base's ENOENT is NOT physical proof/);
  assert.match(avvertenza, /does not touch or stop any host/);
  assert.equal(av.json.evidenze.omonima, 'absent');
  assert.equal(av.json.evidenze.lease, 'none');
  assert.equal(av.json.evidenze.supervisore, 'nessun-pid');
  // zero mutazioni dall'anteprima
  assert.equal(leggiBytes(percorsoRecord(d)).compare(bytes), 0, 'anteprima muta il record');
  assert.equal(fs.existsSync(percorsoAtto(d)), false, 'anteprima scrive la traccia');
  const r = await conferma(d, { sha: sha });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'reconciled');
  assert.equal(r.json.prova, 'operator-attest');
  assert.equal(r.json.provenDead, false);
  assert.equal(r.json.host, 'attest-assente');
  assert.equal(r.json.backup, true);
  assert.equal(fs.existsSync(percorsoRecord(d)), false, 'record non rimosso');
  assert.equal(leggiBytes(percorsoQuarantena(d)).compare(bytes), 0, 'quarantena non byte-identica');
  const statAtto = fs.statSync(percorsoAtto(d));
  assert.equal(statAtto.mode & 0o777, 0o600, 'traccia non 0600');
  const atto = JSON.parse(leggiBytes(percorsoAtto(d)).toString('utf8'));
  assert.equal(atto.esito, 'intent');
  assert.equal(atto.autorita, 'fleet-bearer');
  assert.equal(atto.decisione.hostAssente, true);
  assert.equal(atto.decisione.host, 'attest-assente');
  assert.equal(atto.motivo, MOTIVO);
  // dopo la chiusura la cella riparte senza il muro del duplicato
  const up = await d.post('/up', { cell: CELLA });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.ok, true);
});

// ---------------------------------------------------------------------------
// Base spostata altrove con host vivo: l'atto resta ammissibile ed e'
// l'asserzione dell'attestatore; l'host altrove non e' toccato.
// ---------------------------------------------------------------------------
test('attest: base canonica spostata altrove con host vivo — atto ammissibile, host non toccato', async (t) => {
  const d = await mondo(t);
  const { sha256: sha } = scriviRecordV1(d);
  const base = vlCellBaseDir(d.home, OWNER, CELLA);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(base, 'hostpid'), '0\n');
  const host = figlioVivo(t); // «host» altrove: vivo, mai toccato dal daemon
  fs.renameSync(base, path.join(d.root, 'base-spostata'));
  const av = await anteprima(d);
  assert.equal(av.json.base.stato, 'assente');
  assert.match((av.json.avvertenza || []).join(' '), /the base's ENOENT is NOT physical proof/);
  const r = await conferma(d, { sha });
  assert.equal(r.json.outcome, 'reconciled', JSON.stringify(r.json));
  try { process.kill(host.pid, 0); } catch (_) { assert.fail('host toccato'); }
  const chiamate = fs.readFileSync(d.callsLog, 'utf8');
  assert.equal(/kill-session|kill-pane/.test(chiamate), false, 'comandi host eseguiti');
});

// ---------------------------------------------------------------------------
// Base presente blocca; family dichiarata vl mai; other con atteso false.
// ---------------------------------------------------------------------------
test('attest: family null con base presente blocca qualunque hostAssente', async (t) => {
  const d = await mondo(t);
  const { bytes, sha256: sha } = scriviRecordV1(d);
  fs.mkdirSync(vlCellBaseDir(d.home, OWNER, CELLA), { recursive: true, mode: 0o700 });
  const r = await conferma(d, { sha, hostAssente: true });
  assert.equal(r.json.outcome, 'blocked', JSON.stringify(r.json));
  assert.equal(r.json.code, 'HOST_BARRIER');
  assert.equal(r.json.host, 'base-presente');
  const r2 = await conferma(d, { sha, hostAssente: false });
  assert.equal(r2.json.code, 'HOST_BARRIER', 'hostAssente false non sblocca una base presente');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(bytes), 0, 'record mutato');
  assert.equal(fs.existsSync(percorsoAtto(d)), false, 'traccia scritta');
});

test('attest: family vl dichiarata mai idonea; family other positivo con atteso false', async (t) => {
  const d = await mondo(t);
  const vl = scriviRecordV1(d, { family: 'vl' });
  const rVl = await conferma(d, { sha: vl.sha256 });
  assert.equal(rVl.json.outcome, 'not-eligible', JSON.stringify(rVl.json));
  assert.equal(fs.existsSync(percorsoRecord(d)), true, 'record vl archiviato');
  fs.rmSync(percorsoRecord(d));
  const other = scriviRecordV1(d, { family: 'other' });
  const rIncoerente = await conferma(d, { sha: other.sha256, hostAssente: true });
  assert.equal(rIncoerente.json.outcome, 'blocked');
  assert.equal(rIncoerente.json.code, 'CONFERMA-NON-COERENTE');
  assert.equal(fs.existsSync(percorsoRecord(d)), true, 'record archiviato con conferma incoerente');
  const rOk = await conferma(d, { sha: other.sha256, hostAssente: false });
  assert.equal(rOk.json.outcome, 'reconciled', JSON.stringify(rOk.json));
  assert.equal(rOk.json.host, 'not-vl');
});

test('attest: record v2 e record v1 completo non idonei', async (t) => {
  const d = await mondo(t);
  const reg = launchTarget.registraPrepared(d.filesRoot, SESSIONE, {
    launchId: LID, family: 'other', cellId: CELLA, ownerInstanceId: OWNER,
    tmuxSocket: '/tmp/ncbi-test', bootId: BOOT_ALTRO, pidNs: NS, daemonInc: 'inc-0', res: null,
  });
  assert.equal(reg.ok, true, JSON.stringify(reg));
  const grezzo = launchTarget.leggiGrezzo(d.filesRoot, SESSIONE);
  const rV2 = await conferma(d, { sha: grezzo.sha256 });
  assert.equal(rV2.json.outcome, 'not-eligible', JSON.stringify(rV2.json));
  fs.rmSync(percorsoRecord(d));
  const completo = launchTarget.registra(d.filesRoot, SESSIONE, {
    launchId: LID2, sessionId: '$5', paneId: '%9', tmuxSocket: '/tmp/ncbi-test',
    serverPid: null, panePid: 4242, paneStarttime: 111, family: 'other',
  });
  assert.equal(completo, true, 'registra v1 completo');
  const g2 = launchTarget.leggiGrezzo(d.filesRoot, SESSIONE);
  const rV1c = await conferma(d, { sha: g2.sha256, launchId: LID2, hostAssente: false });
  assert.equal(rV1c.json.outcome, 'not-eligible', JSON.stringify(rV1c.json));
  assert.equal(fs.existsSync(percorsoRecord(d, LID2)), true, 'record v1 completo archiviato');
});

// ---------------------------------------------------------------------------
// La traccia NON e' una prova di morte: il gate automatico resta chiuso e un
// negozio importato non fabbrica nulla.
// ---------------------------------------------------------------------------
test('attest: traccia presente, record in place — reconcile ordinario e anteprima restano di sempre', async (t) => {
  const d = await mondo(t);
  const { bytes, sha256: sha } = scriviRecordV1(d);
  // traccia d'intento scritta «a meta'» (crash prima di claim e commit)
  const atto = {
    v: 1, schema: 'operator-attest-legacy', atto: 'archivia-legacy', esito: 'intent',
    cell: CELLA, sessione: SESSIONE, launchId: LID, recordSha256: sha,
    ownerInstanceId: OWNER, bootId: BOOT, pidNs: NS, autorita: 'fleet-bearer',
    attestatoreDichiarato: 'turno serale',
    decisione: { family: null, hostAssente: true, host: 'attest-assente' },
    supervisore: 'nessun-pid', motivo: MOTIVO, ts: 123,
  };
  aseguraReconciled(d);
  fs.writeFileSync(percorsoAtto(d), `${JSON.stringify(atto)}\n`, { mode: 0o600 });
  fs.chmodSync(percorsoAtto(d), 0o600);
  const ord = await d.post('/reconcile', { cell: CELLA, launchId: LID });
  assert.equal(ord.json.outcome, 'blocked', JSON.stringify(ord.json));
  assert.equal(ord.json.classification, 'legacy-unprovable');
  assert.equal(fs.existsSync(percorsoRecord(d)), true, 'chiusura automatica indotta dalla traccia');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(bytes), 0, 'record mutato');
  const av = await anteprima(d);
  assert.equal(av.json.outcome, 'anteprima');
  // negozio importato: la stessa pratica copiata su un altro nodo non cambia
  // classificazione e non diventa riconciliabile per provenienza dedotta
  const d2 = await mondo(t);
  fs.copyFileSync(percorsoRecord(d), percorsoRecord(d2));
  const ord2 = await d2.post('/reconcile', { cell: CELLA, launchId: LID });
  assert.equal(ord2.json.outcome, 'blocked');
  assert.equal(ord2.json.classification, 'legacy-unprovable');
});

// ---------------------------------------------------------------------------
// Il gate automatico e il ramo attestato sono percorsi distinti.
// ---------------------------------------------------------------------------
test('attest: il ramo attestato non passa dalla barriera host passiva e viceversa', async (t) => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fleet', 'runtime.js'), 'utf8');
  const inizioAttestato = fonte.indexOf('riconciliaLancioAttestato = async');
  const fineAttestato = fonte.indexOf('return {\n      targetRoot', inizioAttestato);
  const corpoAttestato = fonte.slice(inizioAttestato, fineAttestato);
  assert.match(corpoAttestato, /inalterato/);
  assert.equal(corpoAttestato.includes('barrieraHostPassiva'), false, 'il ramo attest chiama la barriera passiva');
  const inizioPassivo = fonte.indexOf('riconciliaLancio = async');
  const finePassivo = fonte.indexOf('// RICONCILIAZIONE ATTESTATA', inizioPassivo);
  const corpoPassivo = fonte.slice(inizioPassivo, finePassivo);
  assert.equal(corpoPassivo.includes('riconciliaLancioAttestato'), false, 'il ramo passivo chiama il ramo attest');
  // controprova di comportamento: base mancante = la barriera passiva
  // rifiuterebbe, il ramo attestato procede perche' l'assenza e' L'asserzione
  // dell'attestatore, non una prova del daemon
  const d = await mondo(t);
  const { sha256: sha } = scriviRecordV1(d);
  const r = await conferma(d, { sha });
  assert.equal(r.json.outcome, 'reconciled', JSON.stringify(r.json));
  const d2 = await mondo(t);
  scriviRecordV1(d2);
  const ord = await d2.post('/reconcile', { cell: CELLA, launchId: LID });
  assert.equal(ord.json.outcome, 'blocked');
  assert.equal(ord.json.classification, 'legacy-unprovable');
});

// ---------------------------------------------------------------------------
// Ricontrolli negativi a conferma.
// ---------------------------------------------------------------------------
test('attest: omonima presente blocca; il ts del record non influenza mai', async (t) => {
  const d = await mondo(t);
  const { sha256: sha } = scriviRecordV1(d, { ts: TS });
  impostaScenario(d, { omonima: true });
  const r = await conferma(d, { sha });
  assert.equal(r.json.outcome, 'blocked', JSON.stringify(r.json));
  assert.equal(r.json.code, 'SESSION_PRESENT');
  assert.equal(fs.existsSync(percorsoRecord(d)), true, 'record archiviato con omonima presente');
  impostaScenario(d, { omonima: false });
  // clock avanti e indietro: il ts non e' mai una prova in nessun verso
  const dAvanti = await mondo(t);
  const avanti = scriviRecordV1(dAvanti, { ts: TS + 24 * 3600 * 1000 });
  const rAvanti = await conferma(dAvanti, { sha: avanti.sha256 });
  assert.equal(rAvanti.json.outcome, 'reconciled', JSON.stringify(rAvanti.json));
  const dIndietro = await mondo(t);
  const indietro = scriviRecordV1(dIndietro, { ts: TS - 24 * 3600 * 1000 });
  const rIndietro = await conferma(dIndietro, { sha: indietro.sha256 });
  assert.equal(rIndietro.json.outcome, 'reconciled', JSON.stringify(rIndietro.json));
});

test('attest: pid supervisore vivo senza nascita rifiuta, pid assento ammissibile', async (t) => {
  const d = await mondo(t);
  const figlio = figlioVivo(t);
  const { sha256: sha } = scriviRecordV1(d, { panePid: figlio.pid });
  const rVivo = await conferma(d, { sha: sha });
  assert.equal(rVivo.json.outcome, 'blocked', JSON.stringify(rVivo.json));
  assert.equal(rVivo.json.code, 'SUPERVISOR_ALIVE');
  assert.equal(fs.existsSync(percorsoRecord(d)), true, 'record archiviato con supervisore vivo');
  await morto(figlio.pid);
  const rMorto = await conferma(d, { sha: sha });
  assert.equal(rMorto.json.outcome, 'reconciled', JSON.stringify(rMorto.json));
});

test('attest: lease live o illeggibile rifiuta l\'atto (gate runtime)', async (t) => {
  for (const stato of ['live', 'grace', 'unreadable']) {
    const d = W.scriviMondo({ famiglia: 'other' });
    t.after(() => W.pulisci(d));
    const bytes = Buffer.from(`${JSON.stringify({
      version: 1, launchId: LID, sessionId: '$0', paneId: '%0',
      tmuxSocket: '/tmp/ncbi-test', serverPid: null, panePid: null, paneStarttime: null, ts: TS,
    })}\n`);
    fs.mkdirSync(path.dirname(W.fileRecord(d)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(W.fileRecord(d), bytes, { mode: 0o600 });
    fs.chmodSync(W.fileRecord(d), 0o600);
    const { runtime } = W.apriRuntime(d, {
      owner: true,
      leaseManager: { status: () => ({ state: stato }), revokeControl: () => {} },
      cfg: {
        reconcileLegacyAttest: true,
        identitaNodoKernel: () => ({ bootId: BOOT, pidNamespaceInode: NS }),
      },
    });
    t.after(() => { try { runtime.shutdown(); } catch (_) { /* best-effort */ } });
    const esito = await runtime.reconcile(CELLA, LID, {
      azione: 'archivia-legacy',
      conferma: {
        recordSha256: sha256Hex(bytes), bootId: BOOT, ownerInstanceId: W.OWNER_INSTANCE_ID,
        hostAssente: true, motivo: MOTIVO,
      },
    });
    assert.equal(esito.outcome, 'blocked', `${stato}: ${JSON.stringify(esito)}`);
    assert.equal(esito.code, stato === 'unreadable' ? 'LEASE_UNREADABLE' : 'LEASE_BLOCKS', stato);
    assert.equal(fs.existsSync(W.fileRecord(d)), true, `${stato}: record mutato`);
  }
});

test('attest: canale posseduto vivo — l\'atto risponde not-needed', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const bytes = Buffer.from(`${JSON.stringify({
    version: 1, launchId: LID, sessionId: '$0', paneId: '%0',
    tmuxSocket: '/tmp/ncbi-test', serverPid: null, panePid: null, paneStarttime: null, ts: TS,
  })}\n`);
  const { runtime } = W.apriRuntime(d, {
    owner: true,
    cfg: {
      reconcileLegacyAttest: true,
      identitaNodoKernel: () => ({ bootId: BOOT, pidNamespaceInode: NS }),
    },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) { /* best-effort */ } });
  // il canale vivo nasce da un lancio posseduto: nessun record v1 prima
  const up = await runtime.up(CELLA).then((x) => x, (e) => ({ errore: e }));
  assert.equal(up && up.ok, true, `up non riuscito: ${up && up.errore && up.errore.message}`);
  const corrente = launchTarget.leggi(d.filesRoot, SESSIONE);
  assert.equal(corrente.stato, 'presente', 'record del lancio vivo');
  const launchVivo = corrente.record.launchId;
  const esito = await runtime.reconcile(CELLA, launchVivo, {
    azione: 'archivia-legacy',
    conferma: {
      recordSha256: launchTarget.leggiGrezzo(d.filesRoot, SESSIONE).sha256,
      bootId: BOOT, ownerInstanceId: W.OWNER_INSTANCE_ID,
      hostAssente: true, motivo: MOTIVO,
    },
  });
  assert.equal(esito.outcome, 'not-needed', JSON.stringify(esito));
  assert.equal(esito.classification, 'live');
});

// ---------------------------------------------------------------------------
// Matrice dei crash e idempotenza della traccia.
// ---------------------------------------------------------------------------
test('attest: crash dopo la traccia — nessuna mutazione, il re-invio idempotente completa riusando il ts', async (t) => {
  const d = await mondo(t);
  const { bytes, sha256: sha } = scriviRecordV1(d);
  const atto = {
    v: 1, schema: 'operator-attest-legacy', atto: 'archivia-legacy', esito: 'intent',
    cell: CELLA, sessione: SESSIONE, launchId: LID, recordSha256: sha,
    ownerInstanceId: OWNER, bootId: BOOT, pidNs: NS, autorita: 'fleet-bearer',
    attestatoreDichiarato: 'turno serale',
    decisione: { family: null, hostAssente: true, host: 'attest-assente' },
    supervisore: 'nessun-pid', motivo: MOTIVO, ts: 4242,
  };
  const byteAtto = Buffer.from(`${JSON.stringify(atto)}\n`);
  aseguraReconciled(d);
  fs.writeFileSync(percorsoAtto(d), byteAtto, { mode: 0o600 });
  fs.chmodSync(percorsoAtto(d), 0o600);
  const prima = await anteprima(d);
  assert.equal(prima.json.outcome, 'anteprima');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(bytes), 0, 'la traccia da sola muta il record');
  const r = await conferma(d, { sha: sha });
  assert.equal(r.json.outcome, 'reconciled', JSON.stringify(r.json));
  const dopo = JSON.parse(leggiBytes(percorsoAtto(d)).toString('utf8'));
  assert.equal(dopo.ts, 4242, 'il retry ha riscritto il ts');
  assert.equal(leggiBytes(percorsoQuarantena(d)).compare(bytes), 0, 'quarantena non byte-identica');
});

test('attest: journal pendente con record gia\' rimosso — diagnosi onesta e completamento meccanico', async (t) => {
  const d = await mondo(t);
  const { bytes, sha256: sha } = scriviRecordV1(d);
  // crash dopo l'unlink, prima del journal via: quarantena e journal sul disco
  fs.mkdirSync(path.join(d.filesRoot, 'launch-targets', 'reconciled'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(percorsoQuarantena(d), bytes, { mode: 0o600 });
  fs.chmodSync(percorsoQuarantena(d), 0o600);
  fs.unlinkSync(percorsoRecord(d));
  const journal = {
    v: 1, sessione: SESSIONE, launchId: LID, sha256: sha,
    quarantena: path.relative(path.join(d.filesRoot, 'launch-targets'), percorsoQuarantena(d)),
  };
  fs.writeFileSync(percorsoJournal(d), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  // l'anteprima e' READ-ONLY: riferisce il pendente e NON lo completa
  const av = await anteprima(d);
  assert.equal(av.status, 200, JSON.stringify(av.json));
  assert.equal(av.json.outcome, 'anteprima');
  assert.equal(av.json.journalPendente, true);
  assert.ok((av.json.blocchi || []).includes('COMMIT_PENDENTE'));
  assert.equal(fs.existsSync(percorsoJournal(d)), true, 'anteprima ha completato il journal');
  // la mutazione successiva completa i passi MECCANICI del journal e l'up
  // riparte: il completamento non ri-deriva alcuna prova
  const ord = await d.post('/reconcile', { cell: CELLA, launchId: LID });
  assert.equal(ord.status, 200);
  assert.equal(ord.json.outcome, 'not-needed');
  assert.equal(fs.existsSync(percorsoJournal(d)), false, 'journal non completato dalla mutazione successiva');
  assert.equal(fs.existsSync(percorsoQuarantena(d)), true, 'quarantena sparita');
  const upDopo = await d.post('/up', { cell: CELLA });
  assert.equal(upDopo.status, 200, JSON.stringify(upDopo.json));
  // con un journal che NON si puo' completare (quarantena mancante) l'up resta
  // rifiutato finche' un operatore non risolve: nessuna mutazione tardiva
  const d2 = await mondo(t);
  const seconda = scriviRecordV1(d2);
  fs.mkdirSync(path.join(d2.filesRoot, 'launch-targets', 'reconciled'), { recursive: true, mode: 0o700 });
  fs.unlinkSync(percorsoRecord(d2));
  fs.writeFileSync(percorsoJournal(d2), `${JSON.stringify({
    v: 1, sessione: SESSIONE, launchId: LID, sha256: seconda.sha,
    quarantena: path.relative(path.join(d2.filesRoot, 'launch-targets'), percorsoQuarantena(d2, LID)),
  })}\n`, { mode: 0o600 });
  const upBloccato = await d2.post('/up', { cell: CELLA });
  assert.equal(upBloccato.status, 409, JSON.stringify(upBloccato.json));
});

test('attest: conferma re-inviata dopo il successo — not-needed end-to-end', async (t) => {
  const d = await mondo(t);
  const { sha256: sha } = scriviRecordV1(d);
  const prima = await conferma(d, { sha });
  assert.equal(prima.json.outcome, 'reconciled');
  const seconda = await conferma(d, { sha });
  assert.equal(seconda.status, 200);
  assert.equal(seconda.json.outcome, 'not-needed', JSON.stringify(seconda.json));
});

test('attest: record sostituito da un lancio nuovo — launch-mismatch, il nuovo non si archivia', async (t) => {
  const d = await mondo(t);
  scriviRecordV1(d);
  const nuovo = scriviRecordV1(d, { launchId: LID2 });
  const r = await conferma(d, { sha: '0'.repeat(64) });
  assert.equal(r.json.outcome, 'launch-mismatch', JSON.stringify(r.json));
  assert.equal(r.json.currentLaunchId, LID2);
  assert.equal(fs.existsSync(percorsoRecord(d, LID2)), true, 'il lancio nuovo e\' stato archiviato');
  assert.equal(leggiBytes(percorsoRecord(d, LID2)).compare(nuovo.bytes), 0, 'record nuovo mutato');
});

test('attest: scrittura della traccia fallita — 409, record intatto', async (t) => {
  const d = await mondo(t);
  const { bytes, sha256: sha } = scriviRecordV1(d);
  // la directory della traccia non qualificabile: un file al posto della dir
  fs.writeFileSync(path.join(d.filesRoot, 'launch-targets', 'reconciled'), 'non una directory');
  const r = await conferma(d, { sha: sha });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.code, 'ATTO_SCRITTURA');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(bytes), 0, 'record mutato con traccia non pubblicabile');
});

test('attest: traccia preesistente con decisione diversa — 409 conflitto, file intatto', async (t) => {
  const d = await mondo(t);
  const { bytes, sha256: sha } = scriviRecordV1(d);
  const altra = {
    v: 1, schema: 'operator-attest-legacy', atto: 'archivia-legacy', esito: 'intent',
    cell: CELLA, sessione: SESSIONE, launchId: LID, recordSha256: sha,
    ownerInstanceId: OWNER, bootId: BOOT, pidNs: NS, autorita: 'fleet-bearer',
    attestatoreDichiarato: null,
    decisione: { family: null, hostAssente: true, host: 'attest-assente' },
    supervisore: 'nessun-pid', motivo: 'un altro motivo, un\'altra decisione', ts: 7,
  };
  const byteAltra = Buffer.from(`${JSON.stringify(altra)}\n`);
  aseguraReconciled(d);
  fs.writeFileSync(percorsoAtto(d), byteAltra, { mode: 0o600 });
  fs.chmodSync(percorsoAtto(d), 0o600);
  const r = await conferma(d, { sha: sha });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.code, 'ATTO_CONFLITTO');
  assert.equal(leggiBytes(percorsoAtto(d)).compare(byteAltra), 0, 'atto conflittuale sovrascritto');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(bytes), 0, 'record mutato su conflitto');
});

test('attest: atto troncato preesistente — conflitto, mai sovrascritto, mai una prova', async (t) => {
  const d = await mondo(t);
  const { bytes, sha256: sha } = scriviRecordV1(d);
  aseguraReconciled(d);
  fs.writeFileSync(percorsoAtto(d), Buffer.from('{"v":1,"schema":"operator-attest-le'), { mode: 0o600 });
  fs.chmodSync(percorsoAtto(d), 0o600);
  const r = await conferma(d, { sha: sha });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'ATTO_CONFLITTO');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(bytes), 0, 'record mutato con atto troncato');
});

// ---------------------------------------------------------------------------
// Igiene del token: nessun derivato in traccia, risposta o log.
// ---------------------------------------------------------------------------
test('attest: né traccia né risposta né log contengono il token o un suo derivato', async (t) => {
  const d = await mondo(t);
  const { sha256: sha } = scriviRecordV1(d);
  const hashToken = sha256Hex(Buffer.from(d.TOKEN));
  const prefissoToken = d.TOKEN.slice(0, 12);
  const av = await anteprima(d);
  const r = await conferma(d, { sha });
  assert.equal(r.json.outcome, 'reconciled');
  const attoGrezzo = leggiBytes(percorsoAtto(d)).toString('utf8');
  const logTmux = fs.readFileSync(d.callsLog, 'utf8');
  for ( const corpo of [attoGrezzo, JSON.stringify(av.json), JSON.stringify(r.json), logTmux]) {
    assert.equal(corpo.includes(d.TOKEN), false, 'token in chiaro');
    assert.equal(corpo.includes(hashToken), false, 'hash del token');
    assert.equal(corpo.includes(prefissoToken), false, 'prefisso del token');
  }
  // l'identita\' dichiarata compare SOLO nella traccia, come non verificata
  assert.match(attoGrezzo, /turno serale/);
  assert.equal(JSON.stringify(av.json).includes('turno serale'), false, 'dichiarazione in risposta');
  assert.equal(JSON.stringify(r.json).includes('turno serale'), false, 'dichiarazione in risposta');
  const atto = JSON.parse(attoGrezzo);
  assert.equal(atto.autorita, 'fleet-bearer');
});

// ---------------------------------------------------------------------------
// Validazione stretta, gate di nodo e READONLY.
// ---------------------------------------------------------------------------
test('attest: forma stretta — ogni deviazione e\' 400 senza mutazioni', async (t) => {
  const d = await mondo(t);
  const { bytes, sha256: sha } = scriviRecordV1(d);
  const casi = [
    { cell: CELLA, launchId: LID, attest: [] },
    { cell: CELLA, launchId: LID, attest: 'anteprima' },
    { cell: CELLA, launchId: LID, attest: { azione: 'bogus' } },
    { cell: CELLA, launchId: LID, attest: { azione: 'anteprima', conferma: {} } },
    { cell: CELLA, launchId: LID, attest: { azione: 'archivia-legacy' } },
    { cell: CELLA, launchId: LID, attest: { azione: 'archivia-legacy', conferma: [] } },
    { cell: CELLA, launchId: LID, attest: { azione: 'archivia-legacy', conferma: { recordSha256: sha } } },
    {
      cell: CELLA, launchId: LID, attest: {
        azione: 'archivia-legacy',
        conferma: {
          recordSha256: sha, bootId: BOOT, ownerInstanceId: OWNER, hostAssente: true,
          motivo: MOTIVO, extra: 1,
        },
      },
    },
    {
      cell: CELLA, launchId: LID, attest: {
        azione: 'archivia-legacy',
        conferma: { recordSha256: sha, bootId: BOOT, ownerInstanceId: OWNER, hostAssente: 'true', motivo: MOTIVO },
      },
    },
    {
      cell: CELLA, launchId: LID, attest: {
        azione: 'archivia-legacy',
        conferma: { recordSha256: sha, bootId: BOOT, ownerInstanceId: OWNER, hostAssente: 1, motivo: MOTIVO },
      },
    },
    {
      cell: CELLA, launchId: LID, attest: {
        azione: 'archivia-legacy',
        conferma: { recordSha256: 'xy'.repeat(32), bootId: BOOT, ownerInstanceId: OWNER, hostAssente: true, motivo: MOTIVO },
      },
    },
    {
      cell: CELLA, launchId: LID, attest: {
        azione: 'archivia-legacy',
        conferma: { recordSha256: sha, bootId: 'non-uuid', ownerInstanceId: OWNER, hostAssente: true, motivo: MOTIVO },
      },
    },
    {
      cell: CELLA, launchId: LID, attest: {
        azione: 'archivia-legacy',
        conferma: { recordSha256: sha, bootId: BOOT, ownerInstanceId: 'zz'.repeat(16), hostAssente: true, motivo: MOTIVO },
      },
    },
    {
      cell: CELLA, launchId: LID, attest: {
        azione: 'archivia-legacy',
        conferma: { recordSha256: sha, bootId: BOOT, ownerInstanceId: OWNER, hostAssente: true, motivo: '' },
      },
    },
    {
      cell: CELLA, launchId: LID, attest: {
        azione: 'archivia-legacy',
        conferma: { recordSha256: sha, bootId: BOOT, ownerInstanceId: OWNER, hostAssente: true, motivo: 'x'.repeat(201) },
      },
    },
    {
      cell: CELLA, launchId: LID, attest: {
        azione: 'archivia-legacy',
        conferma: { recordSha256: sha, bootId: BOOT, ownerInstanceId: OWNER, hostAssente: true, motivo: 'un\x01motivo' },
      },
    },
    {
      cell: CELLA, launchId: LID, attest: {
        azione: 'archivia-legacy',
        conferma: {
          recordSha256: sha, bootId: BOOT, ownerInstanceId: OWNER, hostAssente: true,
          motivo: MOTIVO, attestatoreDichiarato: 'y'.repeat(65),
        },
      },
    },
  ];
  for (const corpo of casi) {
    const r = await d.post('/reconcile', corpo);
    assert.equal(r.status, 400, `atteso 400 per ${JSON.stringify(corpo.attest).slice(0, 60)}`);
  }
  const lista = await d.post('/reconcile', [{ cell: CELLA, launchId: LID }]);
  assert.equal(lista.status, 400, 'body a lista accettato');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(bytes), 0, 'record mutato da input invalido');
  assert.equal(fs.existsSync(percorsoAtto(d)), false, 'traccia scritta da input invalido');
  // il bearer assente o sbagliato non vede nulla, prima di ogni effetto
  const senza = await d.post('/reconcile', { cell: CELLA, launchId: LID, attest: { azione: 'anteprima' } }, 'token-sbagliato');
  assert.equal(senza.status, 401);
});

test('attest: flag di nodo spento — not-enabled visibile; READONLY — 403', async (t) => {
  // Entrambe le vie spente: l'anteprima condivisa non ha niente da proporre.
  // Con la sola via legacy spenta l'anteprima resta una lettura per S2b.
  const d = await mondo(t, { cfg: { reconcileLegacyAttest: false, reconcileServerUncertainAttest: false } });
  const { bytes, sha256: sha } = scriviRecordV1(d);
  const av = await anteprima(d);
  assert.equal(av.status, 200);
  assert.equal(av.json.outcome, 'not-enabled', JSON.stringify(av.json));
  const r = await conferma(d, { sha: sha });
  assert.equal(r.json.outcome, 'not-enabled');
  assert.equal(leggiBytes(percorsoRecord(d)).compare(bytes), 0, 'record mutato con flag spento');
  const d2 = await mondo(t, { cfg: { readonlyDefault: true, fleetRoutes: { readonlyDefault: true } } });
  scriviRecordV1(d2);
  const ro1 = await anteprima(d2);
  assert.equal(ro1.status, 403, JSON.stringify(ro1.json));
  const ro2 = await d2.post('/reconcile', { cell: CELLA, launchId: LID });
  assert.equal(ro2.status, 403);
});

// ---------------------------------------------------------------------------
// Un record per richiesta, mai in blocco.
// ---------------------------------------------------------------------------
test('attest: un atto per richiesta — una traccia, un record in quarantena', async (t) => {
  const d = await mondo(t);
  const { sha256: sha } = scriviRecordV1(d);
  const r = await conferma(d, { sha });
  assert.equal(r.json.outcome, 'reconciled');
  const dir = path.join(d.filesRoot, 'launch-targets', 'reconciled');
  const file = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  assert.deepEqual(file.sort(), [`${SESSIONE}-${LID}.atto.json`, `${SESSIONE}-${LID}.json`].sort());
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.atto.json')).length, 1, 'piu\' di una traccia');
});
