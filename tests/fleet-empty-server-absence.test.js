'use strict';
// Il server tmux VIVO ma VUOTO e' assenza PROVATA.
//
// Il difetto: con exit-empty off (la protezione che il demone stesso applica
// all'avvio) e zero sessioni, tmux 3.4 risponde a `has-session -t =X` con
// exit 1 e stderr «no current target»: un verdetto di assenza che il
// predicato di runtime.js non riconosceva, dopo ogni riavvio del nodo ogni
// up con record e ogni down senza record finivano in SESSION_UNKNOWN.
//
// Contratto (2026-11-10):
//  1. has-session -t =<sessione>: exit esattamente 1, non killed/scaduto e
//     non interrotto da segnale, stderr INTERO esattamente «no current
//     target» (normalizzata solo la terminazione di riga) -> assenza provata.
//     «can't find session» e «no server running» restano prova come prima.
//  2. list-sessions sullo stesso socket: exit 0, stdout vuoto, stderr vuoto
//     -> verdetto POSITIVO di elenco vuoto, tenuto SEPARATO dal predicato
//     degli errori: un exit 0 senza testo NON rende vero il predicato di
//     has-session (display-message non prova nulla).
//  3. Tutto il resto NON prova: Permission denied, timeout, segnale, spawn
//     fallito, stderr sconosciuto o contaminato (anche una sola riga
//     innocua accanto), prefissi/suffissi della stringa, exit diverso.
//
// Tre gruppi: (a) unitari sul predicato esportato, con sintetici; (b)
// comportamento del down senza record e di refreshSessions con tmux finto
// scriptato; (c) up e down dopo un «riavvio» simulato con tmux VERO su
// socket privato (-f /dev/null, exit-empty off, zero sessioni), dove il
// record del lancio vecchio deve riconciliarsi invece di generare
// SESSION_DUPLICATE, e la sessione omonima viva resta un duplicato.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { loadDefinitions, leggiStarttimeProc } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');
const { verificaUscitaServer } = require('./tmux-server-exit-guard.js');

const runtimeMod = require('../lib/fleet/runtime.js');

// ===========================================================================
// (a) Unitari sul predicato: i risultati sono i sintetici con la STESSA forma
// di tmuxExec ({ err, stdout, stderr, code }), cosi' ogni esito e' isolato
// dal come e' stato prodotto.
// ===========================================================================

const errExit = (code, extra = {}) => ({ code, killed: false, ...extra });
const esitoHas = (code, stderr, errExtra = {}) => ({
  err: errExit(code, errExtra), stdout: '', stderr, code,
});

test('a1: i predicati di assenza e di elenco vuoto sono esportati dal modulo runtime', () => {
  assert.equal(typeof runtimeMod.esitoAssenzaSessione, 'function',
    'esitoAssenzaSessione deve essere esportato per la prova unitaria');
  assert.equal(typeof runtimeMod.esitoElencoVuoto, 'function',
    'esitoElencoVuoto deve essere esportato per la prova unitaria');
});

test('a2: i due esiti positivi di has-session provano l\'assenza', () => {
  const p = runtimeMod.esitoAssenzaSessione;
  assert.equal(typeof p, 'function', 'predicato esportato (vedi a1)');
  // Il negativo qualificato di sempre resta valido.
  assert.equal(p(esitoHas(1, "can't find session: cloud-X\n")), true,
    'can\'t find session resta una prova');
  assert.equal(p(esitoHas(1, 'no server running on /tmp/tmux-1000/default\n')), true,
    'no server running resta una prova');
  // Il caso nuovo: server VIVO ma vuoto. Lo stderr intero e' esattamente la
  // stringa, con la sola terminazione di riga normalizzata.
  assert.equal(p(esitoHas(1, 'no current target')), true, 'senza newline');
  assert.equal(p(esitoHas(1, 'no current target\n')), true, 'con newline');
  assert.equal(p(esitoHas(1, 'no current target\r\n')), true, 'con CRLF');
});

test('a3: nessun negativo del contratto diventa una prova', () => {
  const p = runtimeMod.esitoAssenzaSessione;
  assert.equal(typeof p, 'function', 'predicato esportato (vedi a1)');
  // stderr contaminato: prefissi, suffissi, righe innocue accanto (anche
  // accanto a un errore vero), righe extra.
  assert.equal(p(esitoHas(1, 'no current target: x\n')), false, 'suffisso «: x»');
  assert.equal(p(esitoHas(1, 'no current target x\n')), false, 'suffisso con spazio');
  assert.equal(p(esitoHas(1, 'x: no current target\n')), false, 'prefisso');
  assert.equal(p(esitoHas(1, 'riga innocua\nno current target\n')), false,
    'una riga innocua accanto non e\' il verdetto intero');
  assert.equal(p(esitoHas(1, 'no current target\nerror connecting to /s (Permission denied)\n')), false,
    'verdetto accanto a Permission denied');
  assert.equal(p(esitoHas(1, 'error connecting to /s (Permission denied)\nno current target\n')), false,
    'Permission denied accanto al verdetto');
  assert.equal(p(esitoHas(1, 'No current target\n')), false, 'il caso non e\' la stringa esatta');
  // Exit diverso da 1: nemmeno lo stderr giusto conta.
  assert.equal(p(esitoHas(2, 'no current target\n')), false, 'exit 2');
  assert.equal(p(esitoHas(2, "can't find session: X\n")), false, 'exit 2 sul negativo di sempre');
  // Processo interrotto o scaduto, segnale, spawn fallito.
  assert.equal(p(esitoHas(1, 'no current target\n', { killed: true })), false, 'killed (timeout)');
  assert.equal(p({ ...esitoHas(1, 'no current target\n'), err: { code: null, signal: 'SIGKILL', killed: false } }), false,
    'morto per segnale');
  assert.equal(p({ err: { code: 'ENOENT', killed: false }, stdout: '', stderr: '', code: 1 }), false,
    'spawn fallito');
  // exit 0 senza testo (display-message '#{session_id}' con target =X):
  // NON e' il predicato di has-session e non prova l'assenza.
  assert.equal(p({ err: null, stdout: '', stderr: '', code: 0 }), false,
    'exit 0 senza testo non e\' un verdetto di has-session');
});

test('a4: il verdetto di elenco vuoto e\' positivo SOLO con exit 0 e flussi esattamente vuoti', () => {
  const l = runtimeMod.esitoElencoVuoto;
  assert.equal(typeof l, 'function', 'predicato esportato (vedi a1)');
  // Il positivo: server vivo, zero sessioni (misura tmux 3.4, caso b).
  assert.equal(l({ err: null, stdout: '', stderr: '', code: 0 }), true,
    'exit 0 con stdout e stderr vuoti');
  // Ogni negativo: e' un elenco letto o un errore, mai «il server e' vuoto».
  assert.equal(l({ err: null, stdout: 'Y: 1 windows\n', stderr: '', code: 0 }), false,
    'un elenco con sessioni non e\' vuoto');
  assert.equal(l({ err: null, stdout: '\n', stderr: '', code: 0 }), false,
    'stdout non esattamente vuoto non e\' il verdetto');
  assert.equal(l({ err: null, stdout: '', stderr: 'x\n', code: 0 }), false,
    'stderr sporco non e\' il verdetto');
  assert.equal(l(esitoHas(1, 'error connecting to /s (Permission denied)\n')), false,
    'un errore NON e\' un elenco vuoto positivo');
  assert.equal(l(esitoHas(1, 'no server running on /s\n')), false,
    'l\'uscita di errore del server resta nel predicato degli errori');
  assert.equal(l(esitoHas(1, 'no sessions\n', { killed: true })), false, 'lettura interrotta');
});

// ===========================================================================
// (b) Comportamento con tmux FINTO scriptato: il ramo «assente» del down
// (has-session in sola lettura) e refreshSessions (list-sessions). Ogni
// marker forza un esito diverso dello stesso comando.
// ===========================================================================

const CELLA = 'CellaUno';
const NOME = 'nc-s1-vuota';

function attendi(check, ms = 5000, passo = 20) {
  const fine = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v = null;
      try { v = check(); } catch (e) { reject(e); return; }
      if (v) { resolve(v); return; }
      if (Date.now() > fine) { reject(new Error('attesa scaduta')); return; }
      setTimeout(tick, passo);
    };
    tick();
  });
}

function creaMondoFinto(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s1-finto-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, CELLA);
  fs.mkdirSync(cwd);
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  const markers = {
    lenta: path.join(root, 'lenta'),
    vuota: path.join(root, 'vuota'),
    contaminata: path.join(root, 'contaminata'),
    suffisso: path.join(root, 'suffisso'),
    permesso: path.join(root, 'permesso'),
    exit2: path.join(root, 'exit2'),
    listaErr: path.join(root, 'lista-err'),
  };
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  fs.writeFileSync(tmuxBin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
const NOME = ${JSON.stringify(NOME)};
const M = ${JSON.stringify(markers)};
const esiste = (p) => fs.existsSync(p);
if (args[0] === 'has-session') {
  if (esiste(M.lenta)) { setTimeout(() => process.exit(1), 8000); return; }
  if (esiste(M.vuota)) { process.stderr.write('no current target\\n'); process.exit(1); }
  if (esiste(M.contaminata)) { process.stderr.write('riga innocua\\nno current target\\n'); process.exit(1); }
  if (esiste(M.suffisso)) { process.stderr.write('no current target: x\\n'); process.exit(1); }
  if (esiste(M.permesso)) { process.stderr.write('error connecting to /tmp/x (Permission denied)\\n'); process.exit(1); }
  if (esiste(M.exit2)) { process.stderr.write('no current target\\n'); process.exit(2); }
  process.stderr.write("can't find session: " + NOME + "\\n");
  process.exit(1);
}
if (args[0] === 'list-sessions') {
  if (esiste(M.listaErr)) {
    process.stderr.write('error connecting to /tmp/x (Permission denied)\\n');
    process.exit(1);
  }
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [{ id: 'eg', label: 'G', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } }],
    cells: [{ id: CELLA, tmuxSession: NOME, cwd, engine: 'eg', boot: false }],
  }));
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false, groupStopBudgetMs: 4000 },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'n'.repeat(64) }),
      revoke: async () => {}, close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  t.after(() => {
    try { runtime.shutdown(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, runtime, markers };
}

function esitoDown(runtime, cella) {
  return runtime.down(cella).then(
    (r) => ({ ok: r.ok === true, risposta: r }),
    (e) => ({ ok: false, perche: e && e.status != null ? `${e.status} ${e.fleetCode || '-'} ${e.message}` : String(e && e.message || e) }),
  );
}

test('b1: down senza record, server vuoto («no current target»): gia\' fermo, non 409', async (t) => {
  const w = creaMondoFinto(t);
  fs.writeFileSync(w.markers.vuota, '1');
  const esito = await esitoDown(w.runtime, CELLA);
  assert.equal(esito.ok, true, `il down sul server vivo ma vuoto deve riuscire: ${esito.perche}`);
  assert.equal(esito.risposta.outcome, 'alreadyAbsent');
});

test('b2: down senza record, «can\'t find session» di sempre: gia\' fermo', async (t) => {
  const w = creaMondoFinto(t);
  const esito = await esitoDown(w.runtime, CELLA);
  assert.equal(esito.ok, true, `il negativo qualificato di sempre resta una prova: ${esito.perche}`);
  assert.equal(esito.risposta.outcome, 'alreadyAbsent');
});

test('b3: stderr contaminato da una riga innocua: resta 409, non e\' il verdetto intero', async (t) => {
  const w = creaMondoFinto(t);
  fs.writeFileSync(w.markers.contaminata, '1');
  await assert.rejects(() => w.runtime.down(CELLA), (e) => e.status === 409
    && e.fleetCode === 'IDENTITY_UNVERIFIED'
    && /esito del has-session non dichiarabile/.test(e.message));
});

test('b4: suffisso sulla stringa («no current target: x»): resta 409', async (t) => {
  const w = creaMondoFinto(t);
  fs.writeFileSync(w.markers.suffisso, '1');
  await assert.rejects(() => w.runtime.down(CELLA), (e) => e.status === 409
    && e.fleetCode === 'IDENTITY_UNVERIFIED'
    && /esito del has-session non dichiarabile/.test(e.message));
});

test('b5: Permission denied: resta 409, un errore non prova l\'assenza', async (t) => {
  const w = creaMondoFinto(t);
  fs.writeFileSync(w.markers.permesso, '1');
  await assert.rejects(() => w.runtime.down(CELLA), (e) => e.status === 409
    && e.fleetCode === 'IDENTITY_UNVERIFIED'
    && /esito del has-session non dichiarabile/.test(e.message));
});

test('b6: exit 2 con lo stderr giusto: resta 409, solo exit 1 e\' un verdetto', async (t) => {
  const w = creaMondoFinto(t);
  fs.writeFileSync(w.markers.exit2, '1');
  await assert.rejects(() => w.runtime.down(CELLA), (e) => e.status === 409
    && e.fleetCode === 'IDENTITY_UNVERIFIED'
    && /esito del has-session non dichiarabile/.test(e.message));
});

test('b7: lettura scaduta (timeout): resta 409', async (t) => {
  const w = creaMondoFinto(t);
  fs.writeFileSync(w.markers.lenta, '1');
  await assert.rejects(() => w.runtime.down(CELLA), (e) => e.status === 409
    && e.fleetCode === 'IDENTITY_UNVERIFIED'
    && /esito del has-session non dichiarabile/.test(e.message));
});

test('b8: client che non parte (spawn fallito): resta 409', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s1-nobin-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(path.join(home, CELLA));
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [{ id: 'eg', label: 'G', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } }],
    cells: [{ id: CELLA, tmuxSession: NOME, cwd: path.join(home, CELLA), engine: 'eg', boot: false }],
  }));
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false },
    home, defsPath, tmuxBin: path.join(root, 'tmux-inesistente'), readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'b.sock'), nonce: 'n'.repeat(64) }),
      revoke: async () => {}, close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  t.after(() => {
    try { runtime.shutdown(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(() => runtime.down(CELLA), (e) => e.status === 409
    && e.fleetCode === 'IDENTITY_UNVERIFIED'
    && /esito del has-session non dichiarabile/.test(e.message));
});

test('b9: refreshSessions — l\'elenco vuoto con exit 0 e\' conclusivo, un errore NON lo e\'', async (t) => {
  const w = creaMondoFinto(t);
  const vuoto = await w.runtime.refreshSessions();
  assert.equal(vuoto.size, 0, 'il server vivo senza sessioni ha elenco vuoto');
  assert.equal(vuoto.conclusivo, true, 'exit 0 con stdout vuoto: elenco vuoto POSITIVO');
  fs.writeFileSync(w.markers.listaErr, '1');
  const errato = await w.runtime.refreshSessions();
  assert.equal(errato.conclusivo, false, 'Permission denied non e\' un elenco vuoto, resta non conclusivo');
  assert.equal(errato.size, 0);
});

// ===========================================================================
// (c) tmux VERO: up e down dopo un «riavvio» simulato del nodo, con il
// server vivo e vuoto. Il socket e' il default risolto dal runtime dentro la
// TMUX_TMPDIR privata del runner: mai il server della flotta. Il server di
// test nasce con -f /dev/null (nessuna config, nessun alias) e si chiude
// per PID esatto, con sonda che fallisce e rimozione della cartella.
// ===========================================================================

const TMUX = process.env.NEXUSCREW_TEST_TMUX_BIN || '/bin/tmux';
const CELLA_E2E = 'CellaUnoE2e';
const NOME_E2E = 'nc-s1-e2e';

function sh(cmd, args, env, timeoutMs = 8000) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, env });
}

async function figlioMorto(t) {
  const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000);'], { detached: true, stdio: 'ignore' });
  f.unref();
  t.after(() => { try { process.kill(f.pid, 'SIGKILL'); } catch (_) { /* gia' uscito */ } });
  // La nascita si legge quando il pid e' osservabile, MAI dopo l'uscita.
  await attendi(() => { try { process.kill(f.pid, 0); return true; } catch (_) { return false; } });
  const nascita = leggiStarttimeProc(f.pid);
  assert.ok(Number.isFinite(nascita), 'nascita del figlio di prova non letta');
  process.kill(f.pid, 'SIGKILL');
  return { pid: f.pid, nascita };
}

async function attendiMorto(pid) {
  await attendi(() => { try { process.kill(pid, 0); return false; } catch (_) { return true; } });
}

function esitoUp(runtime, cella) {
  return runtime.up(cella).then(
    (r) => ({ ok: r.ok === true, risposta: r }),
    (e) => ({ ok: false, perche: e && e.status != null ? `${e.status} ${e.fleetCode || '-'} ${e.message}` : String(e && e.message || e) }),
  );
}

test('c: server tmux vivo e vuoto — l\'up col record vecchio riconcilia e lancia, il down senza record dichiara gia\' fermo, la sessione viva resta duplicato', async (t) => {
  const probe = sh(TMUX, ['-V']);
  if (probe.status !== 0) { t.skip('tmux di sistema non disponibile'); return; }

  // La TMUX_TMPDIR del runner isolato (isolated-home.cjs): il socket di
  // default del runtime sta in <TMUX_TMPDIR>/tmux-<uid>/default. La cartella
  // la crea questo test e la rimuove alla fine.
  const base = process.env.TMUX_TMPDIR;
  assert.ok(typeof base === 'string' && base.startsWith('/'), 'TMUX_TMPDIR privata del runner richiesta');
  const uidDir = `tmux-${typeof process.getuid === 'function' ? process.getuid() : 0}`;
  const socketDir = path.join(base, uidDir);
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const socket = path.join(socketDir, 'default');
  assert.equal(sharedTmuxSocketPath(), socket, 'il socket di default del runtime deve essere quello di test');
  const tmuxEnv = () => ({ ...process.env, TMUX: '', TMUX_PANE: '' });

  // Il server DI TEST: -f /dev/null (nessuna config dell'operatore, nessun
  // alias), exit-empty off, NESSUNA sessione: il mondo che il demone crea da
  // se dopo un riavvio vero del nodo.
  const avvio = sh(TMUX, ['-f', '/dev/null', '-S', socket,
    'start-server', ';', 'set-option', '-s', 'exit-empty', 'off'], tmuxEnv());
  assert.equal(avvio.status, 0, `avvio del server di test fallito: ${avvio.stderr}`);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s1-e2e-'));
  fs.mkdirSync(path.join(home, 'cwd'));
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  fs.mkdirSync(path.join(home, '.nexuscrew', 'run'), { recursive: true, mode: 0o700 });
  const defsPath = path.join(home, 'defs.json');
  const defs = {
    engines: [{ id: 'e', command: '/bin/cat', args: [] }],
    cells: [{ id: CELLA_E2E, engine: 'e', tmuxSession: NOME_E2E, cwd: path.join(home, 'cwd') }],
  };
  const broker = createLaunchBroker({ home });
  const apri = () => createBuiltinRuntime({
    cfg: { activityHooks: false, launchReadyMs: 0, filesRoot, log: () => {}, vlLaunchCooldownMs: 0 },
    home, defsPath, tmuxBin: TMUX, readonly: () => false,
    launchBroker: {
      issue: async (payload) => broker.issue(payload),
      revoke: async (nonce) => broker.revoke(nonce),
    },
    boot: defs,
  });
  const runtimeA = apri();

  const hasSessionEsterno = () => sh(TMUX, ['has-session', '-t', `=${NOME_E2E}`], tmuxEnv()).status === 0;
  const elenco = () => sh(TMUX, ['list-sessions'], tmuxEnv());
  const pidServer = () => Number(String(sh(TMUX, ['-S', socket, 'display-message', '-p', '#{pid}'], tmuxEnv()).stdout || '').trim());

  // La fotografia del caso (b) della misura: server vivo, ZERO sessioni.
  const fotoElenco = elenco();
  assert.equal(fotoElenco.status, 0, 'list-sessions su server vivo vuoto esce 0');
  assert.equal(String(fotoElenco.stdout || ''), '', '...con stdout vuoto');
  assert.equal(String(fotoElenco.stderr || ''), '', '...e stderr vuoto');
  const primoHas = sh(TMUX, ['has-session', '-t', `=${NOME_E2E}`], tmuxEnv());
  assert.equal(primoHas.status, 1);
  assert.equal(String(primoHas.stderr || '').replace(/\r\n?/g, '\n').replace(/\n+$/, ''), 'no current target',
    'lo stderr del has-session sul server vuoto deve essere esattamente «no current target»');
  const serverPid = pidServer();
  assert.ok(Number.isInteger(serverPid) && serverPid > 0, 'PID del server di test letto');

  t.after(async () => {
    try { runtimeA.shutdown(); } catch (_) { /* best-effort */ }
    try { await broker.close(); } catch (_) { /* best-effort */ }
    // Chiusura DAVVERO: per PID esatto (kill-server non e' affidabile),
    // uscita verificata, sonda che deve fallire, poi rimozione cartella.
    let pid = null;
    try { pid = pidServer(); } catch (_) { /* gia' andato */ }
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGTERM'); } catch (_) { /* gia' uscito */ }
      const fine = Date.now() + 5000;
      while (Date.now() < fine) {
        try { process.kill(pid, 0); } catch (e) { if (e && e.code === 'ESRCH') break; }
        spawnSync('sleep', ['0.05']);
      }
      try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gia' uscito */ }
      verificaUscitaServer(spawnSync, pid, { etichetta: 'server tmux di test' });
    }
    const sonda = sh(TMUX, ['-S', socket, 'display-message', '-p', '#{pid}'], tmuxEnv(), 3000);
    assert.notEqual(sonda.status, 0, 'dopo la chiusura nessun server deve rispondere sul socket di test');
    try { fs.rmSync(socketDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  });

  // I «morti» del record vecchio: supervisore e server del lancio
  // precedente, con nascita letta PRIMA dell'uscita.
  const supMorto1 = await figlioMorto(t);
  const srvMorto1 = await figlioMorto(t);
  await attendiMorto(supMorto1.pid);
  await attendiMorto(srvMorto1.pid);

  const LID1 = crypto.randomBytes(8).toString('hex');
  const registraV1 = (launchId, sup, srv) => assert.equal(launchTarget.registra(filesRoot, NOME_E2E, {
    launchId, sessionId: '$3', paneId: '%5', tmuxSocket: socket,
    serverPid: srv.pid, panePid: sup.pid, paneStarttime: sup.nascita, family: 'other',
  }), true, 'semina del record v1 fallita');

  // (1) Riavvio simulato: server VUOTO + record del lancio vecchio con
  // server e supervisore morti. L'up deve RICONCILIARE e lanciare, non
  // rifiutare con SESSION_DUPLICATE.
  registraV1(LID1, supMorto1, srvMorto1);
  const up1 = await esitoUp(runtimeA, CELLA_E2E);
  assert.equal(up1.ok, true, `l'up dopo il riavvio simulato deve riuscire: ${up1.perche}`);
  assert.equal(hasSessionEsterno(), true, 'la sessione della cella deve essere viva dopo l\'up');
  const dopo1 = launchTarget.leggi(filesRoot, NOME_E2E);
  assert.equal(dopo1.stato, 'presente');
  assert.notEqual(dopo1.record.launchId, LID1, 'il record presente deve essere del lancio nuovo');
  assert.ok(fs.existsSync(launchTarget.percorsoQuarantena(filesRoot, NOME_E2E, LID1)),
    'il record del lancio vecchio deve essere in quarantena');

  // (2) Down regolare col canale posseduto: chiude la sessione, il record
  // va via e il server RESTA (exit-empty off, zero sessioni di nuovo).
  const down1 = await runtimeA.down(CELLA_E2E);
  assert.equal(down1.ok, true, `down riuscito: ${JSON.stringify(down1)}`);
  assert.equal(hasSessionEsterno(), false);
  assert.equal(launchTarget.leggi(filesRoot, NOME_E2E).stato, 'assente');
  assert.equal(pidServer(), serverPid, 'il server deve restare vivo dopo il down');
  const elenco2 = elenco();
  assert.equal(elenco2.status, 0);
  assert.equal(String(elenco2.stdout || ''), '', 'dopo il down il server e\' di nuovo vuoto');

  // (3) Down SENZA record sul server vuoto: gia' fermo, non 409.
  const down2 = await esitoDown(runtimeA, CELLA_E2E);
  assert.equal(down2.ok, true, `il down senza record sul server vuoto deve dichiarare gia' fermo: ${down2.perche}`);
  assert.equal(down2.risposta.outcome, 'alreadyAbsent');

  // (4) Un up senza record su server vuoto lancia normalmente.
  const up2 = await esitoUp(runtimeA, CELLA_E2E);
  assert.equal(up2.ok, true, `l\'up senza record deve lanciare: ${up2.perche}`);
  assert.equal(hasSessionEsterno(), true);

  // (5) La sessione omonima VIVA resta un DUPLICATO: record del lancio
  // vecchio seminato sopra la sessione viva, e un runtime NUOVO (il demone
  // dopo il riavvio, senza canali in-process): la presenza provata dalla
  // lettura blocca, non riconcilia.
  const supMorto2 = await figlioMorto(t);
  const srvMorto2 = await figlioMorto(t);
  await attendiMorto(supMorto2.pid);
  await attendiMorto(srvMorto2.pid);
  const LID2 = crypto.randomBytes(8).toString('hex');
  registraV1(LID2, supMorto2, srvMorto2);
  const runtimeB = apri();
  t.after(() => { try { runtimeB.shutdown(); } catch (_) { /* best-effort */ } });
  await assert.rejects(() => runtimeB.up(CELLA_E2E), (e) => e.status === 409
    && e.fleetCode === 'SESSION_DUPLICATE'
    && /SESSION_PRESENT/.test(e.message), 'la sessione presente resta un duplicato');
  assert.equal(hasSessionEsterno(), true, 'nessuna sessione in piu\' dopo il rifiuto');
  assert.equal(elenco().stdout.trim().split('\n').filter(Boolean).length, 1,
    'solo la sessione della cella resta sul server');

  // (6) Il ramo ALIVE del valutatore: il record porta il PID e la nascita
  // del server DI TEST (vivo, stesso socket) e un supervisore morto. La
  // lettura combinata display-message ; has-session stampa il pid del
  // server e poi «no current target»: assenza provata, riconcilia e lancia.
  sh(TMUX, ['kill-session', '-t', `=${NOME_E2E}`], tmuxEnv());
  await attendi(() => !hasSessionEsterno());
  launchTarget.rimuovi(filesRoot, NOME_E2E);
  const nascitaServer = leggiStarttimeProc(serverPid);
  assert.ok(Number.isFinite(nascitaServer), 'nascita del server di test letta');
  const supMorto3 = await figlioMorto(t);
  await attendiMorto(supMorto3.pid);
  const LID3 = crypto.randomBytes(8).toString('hex');
  const prep = launchTarget.registraPrepared(filesRoot, NOME_E2E, {
    launchId: LID3, family: 'other', cellId: CELLA_E2E, ownerInstanceId: null,
    tmuxSocket: socket, bootId: null, pidNs: null, daemonInc: 'inc-0',
  });
  assert.equal(prep.ok, true, JSON.stringify(prep));
  for (const [da, a, campi] of [
    ['prepared', 'creating', {}],
    ['creating', 'created', { sessionId: '$3', windowId: '@9', paneId: '%5', serverPid, serverStarttime: nascitaServer }],
    ['created', 'attested', { panePid: supMorto3.pid, paneStarttime: supMorto3.nascita }],
  ]) {
    const av = launchTarget.avanza(filesRoot, NOME_E2E, { launchId: LID3, da, a, campi });
    assert.equal(av.ok, true, JSON.stringify(av));
  }
  const up3 = await esitoUp(runtimeA, CELLA_E2E);
  assert.equal(up3.ok, true, `l'up col record del server vivo e vuoto deve riconciliare e lanciare: ${up3.perche}`);
  assert.equal(hasSessionEsterno(), true);

  // Chiusura pulita del lancio dell'ultimo up, prima del teardown.
  const down3 = await runtimeA.down(CELLA_E2E);
  assert.equal(down3.ok, true, `down finale: ${JSON.stringify(down3)}`);
  assert.equal(hasSessionEsterno(), false);
});
