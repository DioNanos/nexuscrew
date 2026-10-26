'use strict';
// La continuita' del teardown: la verifica e il comando
// di stop viaggiano sulla connessione di controllo APERTA ALLA CREAZIONE e
// posseduta dal lancio. Barriere: canale morto prima del down, canale morto
// fra verifica e comando (server sostituito), NC riavviato senza canale,
// sessione omonima di un altro proprietario. In ogni caso di continuita'
// rotta: NESSUNA azione, NESSUN client tmux nuovo per «riprovare».
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const launchTarget = require('../lib/fleet/launch-target.js');

const SESSIONE = 'nc-cc-prova';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cc-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'CellaCC'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const filesRoot = path.join(home, 'NexusFiles'); fs.mkdirSync(filesRoot);
  const statoPath = path.join(root, 'sessions.json'); fs.writeFileSync(statoPath, '[]');
  const logPath = path.join(root, 'chiamate.log');
  // trigger del fake: MUORI = il server sparisce (EOF del canale in ogni
  // istante); MUORI_SU_KILL = il canale muore RICEVUTO il kill-session,
  // cioe' la sostituzione del server fra l'ultima verifica e il comando.
  const muori = path.join(root, 'MUORI');
  const muoriSuKill = path.join(root, 'MUORI_SU_KILL');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  if (args.includes('nc-control-open')) process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  const { spawnSync } = require('node:child_process');
  const MUORI = ${JSON.stringify(muori)};
  const MUORI_SU_KILL = ${JSON.stringify(muoriSuKill)};
  const sparisco = () => { if (fs.existsSync(MUORI)) process.exit(0); };
  setInterval(sparisco, 25);
  let n = 0; let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!riga) continue;
      if (riga.startsWith('kill-session') && fs.existsSync(MUORI_SU_KILL)) process.exit(0);
      n += 1;
      const r = spawnSync(process.execPath,
        [__filename, '-S', process.argv[3] || 'x'].concat(riga.split(/\\s+/)), { encoding: 'utf8' });
      if ((r.status || 0) === 0) {
        process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stdout || '') + '%end 1 ' + n + ' 1\\n');
      } else {
        process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stderr || '') + '%error 1 ' + n + ' 1\\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
const STATO = ${JSON.stringify(statoPath)};
const LOG = ${JSON.stringify(logPath)};
const nota = (cosa) => fs.appendFileSync(LOG, cosa + '\\n');
const leggi = () => { try { return JSON.parse(fs.readFileSync(STATO, 'utf8')); } catch (_) { return []; } };
const cmd = (a) => a[0] || '';
if (cmd(args) === 'new-session') {
  const nome = args[args.indexOf('-s') + 1];
  const s = { nome, id: '$5', w: '@5', p: '%5' };
  fs.writeFileSync(STATO, JSON.stringify(leggi().concat([s])));
  nota('new-session:' + nome);
  process.stdout.write(s.id + '\\t' + s.w + '\\t' + s.p + '\\n'); process.exit(0);
}
if (cmd(args) === 'kill-session') {
  const bersaglio = args[args.length - 1];
  const nudo = String(bersaglio || '').replace(/^=/, '');
  const lista = leggi();
  const s = lista.find((x) => x.nome === nudo || x.id === nudo) || null;
  nota('kill-session:' + bersaglio);
  if (s) fs.writeFileSync(STATO, JSON.stringify(lista.filter((x) => x.id !== s.id)));
  process.exit(0);
}
if (cmd(args) === 'has-session') {
  const bersaglio = args[args.length - 1];
  const nudo = String(bersaglio || '').replace(/^=/, '');
  nota('has-session:' + bersaglio);
  process.exit(leggi().some((x) => x.nome === nudo || x.id === nudo) ? 0 : 1);
}
if (cmd(args) === 'display-message') {
  const iF = args.indexOf('-F');
  const fmt = (iF >= 0 ? args[iF + 1] : args[args.length - 1]) || '';
  if (fmt.includes('socket_path')) { process.stdout.write('/tmp/nc-fake/socket\\t4242\\n'); process.exit(0); }
  if (fmt.includes('pane_dead')) { process.stdout.write('0\\t0\\t%9\\n'); process.exit(0); }
  process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (cmd(args) === 'capture-pane') { process.stdout.write(''); process.exit(0); }
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 }); fs.chmodSync(tmuxBin, 0o755);

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'ec', label: 'C', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } }],
    cells: [{ id: 'CellaCC', tmuxSession: SESSIONE, cwd, engine: 'ec', boot: false }],
  });
  const runtimeDi = () => createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: true },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'n'.repeat(64) }),
      revoke: async () => {}, close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  const percorsoRecord = () => path.join(filesRoot, launchTarget.DIR, `${SESSIONE}.json`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, filesRoot, statoPath, muori, muoriSuKill, runtimeDi, percorsoRecord,
    sessioni: () => JSON.parse(fs.readFileSync(statoPath, 'utf8')),
    logChiamate: () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean),
  };
}
const dormi = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. positivo: teardown TUTTO dal canale posseduto, killed solo dopo verifica
test('down dal canale posseduto: killed:true e la sessione finisce davvero', async (t) => {
  const w = mondo(t);
  const runtime = w.runtimeDi();
  await runtime.up('CellaCC');
  const esito = await runtime.down('CellaCC');
  assert.equal(esito.killed, true);
  assert.equal(esito.outcome, 'killed');
  assert.equal(w.sessioni().length, 0, 'la sessione posseduta e\' finita');
  assert.ok(!fs.existsSync(w.percorsoRecord()), 'record rimosso a teardown completato');
});

// 2. EOF prima del down (server morto/sostituito): identita' non dimostrabile
test('canale morto prima del down: 409 onesto, zero kill, record trattenuto', async (t) => {
  const w = mondo(t);
  const runtime = w.runtimeDi();
  await runtime.up('CellaCC');
  fs.writeFileSync(w.muori, '1');
  await dormi(120); // il server di prova sparisce: EOF sul canale
  await assert.rejects(() => runtime.down('CellaCC'),
    (e) => e.status === 409 && e.fleetCode === 'IDENTITY_UNVERIFIED',
    'nessuna continuita\' dimostrabile: il down non agisce');
  assert.equal(w.sessioni().length, 1, 'nessuna sessione toccata');
  assert.ok(!w.logChiamate().some((l) => l.startsWith('kill-session')),
    'nessun comando di teardown dopo la morte del canale');
  assert.ok(fs.existsSync(w.percorsoRecord()), 'il record resta: claim trattenuto');
});

// 3. sostituzione fra verifica e comando: il canale muore RICEVUTO il kill
test('canale perso al comando di teardown: stop-unknown, la sessione resta viva', async (t) => {
  const w = mondo(t);
  const runtime = w.runtimeDi();
  await runtime.up('CellaCC');
  fs.writeFileSync(w.muoriSuKill, '1');
  await assert.rejects(() => runtime.down('CellaCC'),
    (e) => e.status === 500 && e.fleetCode === 'STOP_UNKNOWN',
    'il comando e\' partito senza risposta: l\'esito non e\' dichiarabile');
  assert.equal(w.sessioni().length, 1, 'la sessione NON e\' stata terminata da nessuno');
  assert.ok(fs.existsSync(w.percorsoRecord()), 'record trattenuto: niente successo dichiarato');
});

// 4. NC riavviato: il record resta ma la connessione della creazione no
test('down dopo un riavvio di NC: identita\' non dimostrabile, nessuna azione', async (t) => {
  const w = mondo(t);
  const runtime = w.runtimeDi();
  await runtime.up('CellaCC');
  const runtimeNuovo = w.runtimeDi(); // nuovo processo NC: nessun canale in mano
  await assert.rejects(() => runtimeNuovo.down('CellaCC'),
    (e) => e.status === 409 && e.fleetCode === 'IDENTITY_UNVERIFIED');
  assert.equal(w.sessioni().length, 1, 'la sessione lanciata dal NC precedente resta viva');
  assert.ok(!w.logChiamate().some((l) => l.startsWith('kill-session')),
    'nessun client nuovo per raggiungere la sessione');
  runtime.shutdown(); // il NC vecchio chiude le proprie connessioni e sparisce
});

// 5. sessione omonima di un altro proprietario: gia' assente per id posseduto
test('down del lancio finito con sessione omonima altrui: alreadyAbsent, B resta viva', async (t) => {
  const w = mondo(t);
  const runtime = w.runtimeDi();
  await runtime.up('CellaCC');
  // A esce; B (altro proprietario) prende lo stesso nome con un id NUOVO.
  fs.writeFileSync(w.statoPath, JSON.stringify([{ nome: SESSIONE, id: '$99', w: '@99', p: '%99' }]));
  const esito = await runtime.down('CellaCC');
  assert.equal(esito.ok, true);
  assert.equal(esito.outcome, 'alreadyAbsent');
  assert.equal(w.sessioni()[0].id, '$99', 'B omonima resta viva col SUO id');
  assert.ok(!fs.existsSync(w.percorsoRecord()), 'record rimosso: nulla di mio da fermare');
});
