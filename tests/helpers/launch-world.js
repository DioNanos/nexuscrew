'use strict';
// Mondo finto e isolato per i test del giornale dei lanci (fasi del record
// launch-targets). Tutto vive in una directory temporanea: HOME, file di NC,
// socket e «tmux» sono finti. Nessun tmux reale, nessun servizio NC vivo.
//
// Il tmux finto e' uno script node pilotato da un file di scenario che il test
// puo' riscrivere fra una chiamata e l'altra. Registra ogni invocazione (e ogni
// comando del canale di controllo, prefisso «C:») nel proprio log.
//
// Due famiglie: 'other' (client generico, nessuna claim VL) e 'vl' (binario vl
// finto qualificato, claim della root riservata PRIMA del record). Il mondo si
// scrive su disco in modo serializzabile (scriviMondo) cosi' lo stesso mondo
// puo' essere riaperto da un figlio di test (apriRuntime) e fatto morire.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../../lib/fleet/runtime.js');
const { scriptVlFintoConHost, OWNER_INSTANCE_ID } = require('./vl-attestato.js');

const CELLA = 'Cella';
const SESSIONE = 'cloud-Cella';

// Scenario di default: creazione riuscita, ids $5 @7 %9, placeholder 1111,
// supervisore vero 2222 dopo il respawn.
const SCENARIO_BASE = { newSession: 'ok', ids: '$5 @7 %9', hold: 1111, supervisor: 2222, server: 4242 };

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
      if (esiste('respawned')) {
        if (S.postRespawn === 'lost') return frame('lost\\n', false);
        if (S.postRespawn === 'incomplete') return frame(S.server + '\\n', true);
        return frame(S.server + '\\t' + S.supervisor + '\\n', true);
      }
      if (S.preIdentity === 'lost') return frame('lost\\n', false);
      return frame(S.server + '\\t' + S.hold + '\\n', true);
    }
    return frame('0\\t\\t' + idPane + '\\n', true);
  }
  if (cmd === 'respawn-pane') {
    if (S.snapshotRespawn) {
      try { fs.copyFileSync(S.snapshotRespawn.from, S.snapshotRespawn.to); } catch (_) { fs.writeFileSync(S.snapshotRespawn.to, 'ASSENTE'); }
    }
    alza('respawned');
    return frame('', true);
  }
  if (cmd === 'has-session') {
    return esiste('nato') ? frame('', true) : frame("can't find session: " + idSessione + '\\n', false);
  }
  if (cmd === 'kill-session') { abbassa('nato'); abbassa('respawned'); return frame('', true); }
  return frame('', true);
}
if (args[0] === '-C' && args.includes('new-session')) {
  const modo = S.newSession || 'ok';
  // Resta vivo finche' il processo che lo possiede non chiude la pipe: se il
  // possessore muore (crash di test) il client finto esce da solo, nessun orfano.
  const resta = () => {
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('close', () => process.exit(0));
    setInterval(() => {}, 10000);
  };
  // Fotografia del record nel momento esatto della new-session: prova cosa
  // era GIA' sul disco quando la creazione e' stata emessa.
  if (S.mkdirAlNewSession) { try { fs.mkdirSync(S.mkdirAlNewSession, { recursive: true, mode: 0o700 }); } catch (_) {} }
  if (S.snapshot) {
    try { fs.copyFileSync(S.snapshot.from, S.snapshot.to); } catch (_) { fs.writeFileSync(S.snapshot.to, 'ASSENTE'); }
  }
  if (S.materializza) alza('nato');
  if (modo === 'hang') { resta(); return; }
  if (modo === 'eof') { process.exit(0); }
  if (modo === 'duplicate') {
    process.stdout.write('%begin 1 0 1\\nduplicate session: ' + NOME + '\\n%error 1 0 1\\n');
    resta(); return;
  }
  if (modo === 'generic-error') {
    process.stdout.write('%begin 1 0 1\\ncan\\'t create session\\n%error 1 0 1\\n');
    resta(); return;
  }
  if (modo === 'duplicate-outside') {
    process.stdout.write('%message duplicate session: ' + NOME + '\\n');
    resta(); return;
  }
  if (modo === 'duplicate-other-name') {
    process.stdout.write('%begin 1 0 1\\nduplicate session: altra-cella\\n%error 1 0 1\\n');
    resta(); return;
  }
  if (modo === 'duplicate-extra') {
    process.stdout.write('%begin 1 0 1\\nduplicate session: ' + NOME + '\\nsecond line\\n%error 1 0 1\\n');
    resta(); return;
  }
  // Sequenze non conformi: un primo frame completo SENZA ids (successo vuoto o
  // ambiguo) seguito da un errore con contatore diverso. Il rifiuto non puo'
  // essere attribuito alla creazione: la materializzazione resta ignota.
  if (modo === 'empty-then-duplicate') {
    process.stdout.write('%begin 1 0 1\\n%end 1 0 1\\n%begin 1 1 1\\nduplicate session: ' + NOME + '\\n%error 1 1 1\\n');
    resta(); return;
  }
  if (modo === 'empties-then-duplicate') {
    process.stdout.write('%begin 1 0 1\\n%end 1 0 1\\n%begin 1 1 1\\n%end 1 1 1\\n%begin 1 2 1\\nduplicate session: ' + NOME + '\\n%error 1 2 1\\n');
    resta(); return;
  }
  if (modo === 'ambiguous-then-duplicate') {
    process.stdout.write('%begin 1 0 1\\n$5\\n%end 1 0 1\\n%begin 1 1 1\\nduplicate session: ' + NOME + '\\n%error 1 1 1\\n');
    resta(); return;
  }
  if (modo === 'empty-then-ids') {
    process.stdout.write('%begin 1 0 1\\n%end 1 0 1\\n%begin 1 1 1\\n' + S.ids + '\\n%end 1 1 1\\n');
    resta(); return;
  }
  if (modo === 'truncated') {
    process.stdout.write('%begin 1 0 1\\nduplicate session: ' + NOME + '\\n');
    process.exit(0);
  }
  if (modo === 'bad-ids') {
    process.stdout.write('%begin 1 0 1\\n$x @y %z\\n%end 1 0 1\\n');
    resta(); return;
  }
  if (modo === 'extra-line') {
    process.stdout.write('%begin 1 0 1\\n$5 @7 %9\\nsecond line\\n%end 1 0 1\\n');
    resta(); return;
  }
  alza('nato');
  process.stdout.write('%begin 1 0 1\\n' + S.ids + '\\n%end 1 0 1\\n');
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
  if (esiste('nato')) process.stdout.write(NOME + '\\t1\\n');
  process.exit(0);
}
if (args[0] === 'has-session') {
  if (esiste('nato') || S.omonima) process.exit(0);
  process.stderr.write("can't find session: " + NOME + '\\n');
  process.exit(1);
}
if (args[0] === 'display-message') { process.stdout.write('0\\t\\t' + idPane + '\\n'); process.exit(0); }
process.exit(0);
`;
}

// Scrive il mondo su disco e restituisce il descrittore serializzabile.
function scriviMondo({ famiglia = 'other', scenario = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-giornale-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, CELLA);
  fs.mkdirSync(cwd, { recursive: true });
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot, { recursive: true });
  const scenarioPath = path.join(root, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({ ...SCENARIO_BASE, ...scenario }));
  const callsLog = path.join(root, 'tmux-calls.log');
  fs.writeFileSync(callsLog, '');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  fs.writeFileSync(tmuxBin, scriptTmux({
    scenario: scenarioPath, stato: path.join(root, 'tmux-stato'), log: callsLog, sessioneNome: SESSIONE,
  }), { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  if (famiglia === 'vl') {
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    const hostpid = path.join(root, 'hostpid');
    fs.writeFileSync(hostpid, '0\n');
    const vlBin = path.join(home, '.local', 'bin', 'vl');
    fs.writeFileSync(vlBin, scriptVlFintoConHost({ hostpid }), { mode: 0o755 });
    fs.chmodSync(vlBin, 0o755);
    const catalogo = path.join(home, '.config', 'vl');
    fs.mkdirSync(catalogo, { recursive: true });
    fs.writeFileSync(path.join(catalogo, 'config.toml'), '[profiles.work]\nmodel = "m"\n');
    atomicWrite(defsPath, {
      schemaVersion: 1,
      engines: [{
        id: 'vl.native', label: 'VL',
        managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
      }],
      cells: [{ id: CELLA, tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false }],
    });
  } else {
    const client = path.join(home, 'client');
    fs.writeFileSync(client, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(client, 0o755);
    atomicWrite(defsPath, {
      schemaVersion: 1,
      engines: [{ id: 'client', label: 'Client', rc: false, command: client, args: [], env: {}, promptMode: 'flag', promptFlag: '--prompt' }],
      cells: [{ id: CELLA, tmuxSession: SESSIONE, cwd, engine: 'client', boot: false }],
    });
  }
  return {
    root, home, filesRoot, scenarioPath, callsLog, tmuxBin, defsPath, famiglia,
    cella: CELLA, sessione: SESSIONE,
  };
}

// Costruisce un runtime sul mondo. `opzioni` sono i seams del test:
//   ensureProtection, issue (sostituisce launchBroker.issue), cfg (override).
function apriRuntime(d, opzioni = {}) {
  const calls = { issue: 0, revoke: [] };
  const launchBroker = {
    issue: async (...a) => {
      calls.issue += 1;
      if (typeof opzioni.issue === 'function') return opzioni.issue(...a);
      return { socketPath: path.join(d.root, 'broker.sock'), nonce: 'a'.repeat(64) };
    },
    revoke: async (nonce) => { calls.revoke.push(nonce); },
    close: async () => {},
  };
  const runtime = createBuiltinRuntime({
    cfg: {
      launchReadyMs: 0, filesRoot: d.filesRoot, activityHooks: false, vlLaunchCooldownMs: 0,
      log: () => {}, env: {}, ...(opzioni.cfg || {}),
    },
    ...(d.famiglia === 'vl' ? { identityOwnerInstanceId: OWNER_INSTANCE_ID } : {}),
    home: d.home, defsPath: d.defsPath, tmuxBin: d.tmuxBin, readonly: () => false,
    launchBroker,
    ...(opzioni.ensureProtection ? { ensureProtection: opzioni.ensureProtection } : {}),
    boot: loadDefinitions(d.defsPath),
  });
  return { runtime, calls };
}

function impostaScenario(d, parziale) {
  const cur = JSON.parse(fs.readFileSync(d.scenarioPath, 'utf8'));
  fs.writeFileSync(d.scenarioPath, JSON.stringify({ ...cur, ...parziale }));
}

function chiamateTmux(d) {
  return fs.readFileSync(d.callsLog, 'utf8').trim().split('\n').filter(Boolean).map((r) => JSON.parse(r));
}

function trova(dir, suffisso) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, voce.name);
    if (voce.isDirectory()) out.push(...trova(p, suffisso));
    else if (voce.name.endsWith(suffisso)) out.push(p);
  }
  return out;
}

// Le lease della claim VL presenti nel mondo (una per root riservata).
function lease(d) {
  return trova(path.join(d.home, '.nexuscrew', 'vl-root-claims'), '.lease');
}

function fileRecord(d) {
  return path.join(d.filesRoot, 'launch-targets', `${d.sessione}.json`);
}

function pulisci(d) {
  try { fs.rmSync(d.root, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

module.exports = {
  scriviMondo, apriRuntime, impostaScenario, chiamateTmux, lease, fileRecord, pulisci, trova,
  CELLA, SESSIONE, OWNER_INSTANCE_ID,
};
