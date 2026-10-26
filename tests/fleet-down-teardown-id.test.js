'use strict';
// tests/fleet-down-teardown-id.test.js — il teardown del down usa SOLO gli id
// del lancio posseduto (record sessionId/paneId), MAI il nome della sessione.
//
// PERCHE' QUESTO TEST ESISTE. Il down fermava la sessione PER NOME
// (`kill-session -t =<nome>`): un nome e' un indirizzo riutilizzabile. Se il
// lancio A e' terminato e una sessione B ha preso lo stesso nome, il down
// tardivo di A ammazza B — un processo che NC non ha mai creato. Il contratto
// del possesso: NC ferma SOLO cio' che puo' dimostrare di aver lanciato, per
// id ($N/%N) registrati alla creazione; senza record non agisce e lo dichiara.
// Questo passo copre il teardown per id; la verifica «stesso server tmux fra
// registrazione e comando» (socket+pid del server) arriva con la decisione
// ancora aperta sul canale di controllo e qui il record porta i campi che si
// raccolgono senza ambiguità.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');

const SESSIONE = 'cloud-CellaTeardown';
const DIR_TARGETS = 'launch-targets';

// --- il mondo -------------------------------------------------------------
// Fake tmux con stato su file (sessioni con NOME e ID propri) e log ordinato
// delle chiamate col bersaglio. Gli id sono assegnati alla creazione e NON
// cambiano: e' l'identita' stabile, il nome e' solo un'etichetta riutilizzabile.
function mondo(t, { killMuto = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-teardown-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'CellaTeardown'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const client = path.join(home, '.local', 'bin', 'claude');
  fs.writeFileSync(client, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); fs.chmodSync(client, 0o755);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  const filesRoot = path.join(home, 'NexusFiles'); fs.mkdirSync(filesRoot);

  const statoPath = path.join(root, 'sessions.json');
  fs.writeFileSync(statoPath, '[]');
  const logPath = path.join(root, 'chiamate.log');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv; // -S <socket> in testa quando il record lo porta
const STATO = ${JSON.stringify(statoPath)};
const LOG = ${JSON.stringify(logPath)};
const KILL_MUTO = ${JSON.stringify(killMuto)};
let seq = 4;
const leggi = () => { try { return JSON.parse(fs.readFileSync(STATO, 'utf8')); } catch (_) { return []; } };
const vive = () => leggi();
const nota = (cosa) => fs.appendFileSync(LOG, cosa + '\\n');
// risolve un bersaglio tmux (nome, =nome, $id) a una sessione dello stato
const risolvi = (t) => {
  const nudo = String(t || '').replace(/^=/, '');
  return vive().find((s) => s.nome === nudo || s.id === nudo) || null;
};
if (cmd(args) === 'list-sessions') {
  for (const s of vive()) process.stdout.write(s.nome + '\\t1\\n');
  process.exit(0);
}
if (cmd(args) === 'new-session') {
  const nome = args[args.indexOf('-s') + 1];
  if (vive().some((s) => s.nome === nome)) {
    process.stderr.write('duplicate session: ' + nome + '\\n'); process.exit(1);
  }
  seq += 1;
  const s = { nome, id: '$' + seq, w: '@' + seq, p: '%' + seq };
  fs.writeFileSync(STATO, JSON.stringify(vive().concat([s])));
  nota('new-session:' + nome);
  process.stdout.write(s.id + '\\t' + s.w + '\\t' + s.p + '\\n'); process.exit(0);
}
if (cmd(args) === 'kill-session') {
  const bersaglio = args[args.length - 1];
  const s = risolvi(bersaglio);
  nota('kill-session:' + bersaglio);
  if (s && !KILL_MUTO) fs.writeFileSync(STATO, JSON.stringify(vive().filter((x) => x !== s)));
  process.exit(0);
}
if (cmd(args) === 'has-session') {
  const bersaglio = args[args.length - 1];
  nota('has-session:' + bersaglio);
  process.exit(risolvi(bersaglio) ? 0 : 1);
}
if (cmd(args) === 'display-message') {
  const fmt = args[args.indexOf('-F') + 1] || '';
  if (fmt.includes('socket_path')) { process.stdout.write('/tmp/nc-fake/socket\\t4242\\n'); process.exit(0); }
  if (fmt.includes('pane_dead')) { process.stdout.write('0\\t0\\t%9\\n'); process.exit(0); }
  process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (cmd(args) === 'capture-pane') { process.stdout.write(''); process.exit(0); }
process.exit(0);
function cmd(a) { return a[0] || ''; }
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 }); fs.chmodSync(tmuxBin, 0o755);

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'ec', label: 'Claude', managed: {
        client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe',
      },
    }],
    cells: [{ id: 'CellaTeardown', tmuxSession: SESSIONE, cwd, engine: 'ec', boot: false }],
  });

  const launchBroker = {
    issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'n'.repeat(64) }),
    revoke: async () => {},
    close: async () => {},
  };
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: true },
    home, defsPath, tmuxBin, readonly: () => false, launchBroker,
    boot: loadDefinitions(defsPath),
  });

  const percorsoRecord = () => path.join(filesRoot, DIR_TARGETS, `${SESSIONE}.json`);
  const sessioni = () => JSON.parse(fs.readFileSync(statoPath, 'utf8'));
  const logChiamate = () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { runtime, home, filesRoot, sessioni, logChiamate, percorsoRecord, statoPath };
}

// --- 1. il nome è riutilizzabile, l'id no: B omonima sopravvive al down di A

test('down del lancio A terminato: la sessione B col medesimo nome resta viva', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaTeardown');
  const record = JSON.parse(fs.readFileSync(w.percorsoRecord(), 'utf8'));
  const idA = record.sessionId;
  assert.match(idA, /^\$[0-9]+$/);

  // A termina e B (altro proprietario) prende lo stesso nome con un id NUOVO.
  const conB = w.sessioni().map((s) => (s.nome === SESSIONE
    ? { nome: s.nome, id: '$99', w: '@99', p: '%99' } : s));
  fs.writeFileSync(w.statoPath, JSON.stringify(conB));

  const esito = await w.runtime.down('CellaTeardown');
  assert.strictEqual(esito.ok, true, 'down onesto: niente da fermare per id');

  // B vive: il nome e' ancora li, con il SUO id.
  assert.ok(w.sessioni().some((s) => s.nome === SESSIONE && s.id === '$99'),
    'la sessione omonima B (id diverso) deve restare viva');
  // Il down non ha MAI indirizzato la sessione per nome.
  assert.ok(!w.logChiamate().some((l) => /kill-session:=/.test(l)),
    'nessun kill-session per nome');
});

// --- 2. killed:true solo dopo verifica: kill accettato ma sessione viva

test('kill-session accettato ma la sessione resta: esito onesto, mai killed:true', async (t) => {
  const w = mondo(t, { killMuto: true });
  await w.runtime.up('CellaTeardown');
  await assert.rejects(
    () => w.runtime.down('CellaTeardown'),
    (e) => e.status === 500 && /kill-session/i.test(e.message),
    'il down deve dichiarare lo stop incompleto, non un successo');
});

// --- 3. record assente e sessione omonima viva: nessuna azione, identità non dimostrata

test('senza record del lancio il down non tocca una sessione omonima', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaTeardown');
  fs.rmSync(w.percorsoRecord());

  await assert.rejects(
    () => w.runtime.down('CellaTeardown'),
    (e) => e.status === 409 && e.fleetCode === 'IDENTITY_UNVERIFIED',
    'down rifiutato: non può dimostrare di possedere quella sessione');
  assert.ok(w.sessioni().some((s) => s.nome === SESSIONE), 'la sessione resta viva');
  assert.ok(!w.logChiamate().some((l) => l.startsWith('kill-session')),
    'nessuna chiamata kill-session');
});

// --- 4. cella mai lanciata: down idempotente, nessuna azione

test('down di una cella mai lanciata: ok, nessuna azione', async (t) => {
  const w = mondo(t);
  const esito = await w.runtime.down('CellaTeardown');
  assert.strictEqual(esito.ok, true);
  assert.strictEqual(esito.killed, false);
  assert.ok(!w.logChiamate().some((l) => l.startsWith('kill-session')));
});

// --- 5. sessione già assente con record: già-assente dichiarato e record pulito

test('sessione già assente: alreadyAbsent e record rimosso', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaTeardown');
  assert.ok(fs.existsSync(w.percorsoRecord()), 'record scritto all\'up');
  fs.writeFileSync(w.statoPath, '[]'); // la sessione muore fuori da NC

  const esito = await w.runtime.down('CellaTeardown');
  assert.strictEqual(esito.ok, true);
  assert.strictEqual(esito.killed, false);
  assert.strictEqual(esito.outcome, 'alreadyAbsent');
  assert.ok(!fs.existsSync(w.percorsoRecord()), 'record del lancio rimosso');
});

// --- 6. il record accetta solo id conformi e dichiara gli stati di lettura

test('launch-target: id non conformi rifiutati, lettura a tre stati', async (t) => {
  const launchTarget = require('../lib/fleet/launch-target.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ltarget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessione = 'cloud-Prova';

  assert.strictEqual(launchTarget.registra(root, sessione, {
    launchId: 'a'.repeat(16), sessionId: 'finestra', paneId: '%1',
  }), false, 'sessionId fuori forma tmux: rifiutato');
  assert.strictEqual(launchTarget.registra(root, sessione, {
    launchId: 'a'.repeat(16), sessionId: '$7', paneId: '%9',
  }), true, 'record valido scritto');
  const letto = launchTarget.leggi(root, sessione);
  assert.strictEqual(letto.stato, 'presente');
  assert.strictEqual(letto.record.sessionId, '$7');
  assert.strictEqual(letto.record.paneId, '%9');

  const assente = launchTarget.leggi(root, 'cloud-Mai');
  assert.strictEqual(assente.stato, 'assente');

  fs.writeFileSync(path.join(root, launchTarget.DIR, `${sessione}.json`), '{nope', 'utf8');
  const rotto = launchTarget.leggi(root, sessione);
  assert.strictEqual(rotto.stato, 'indeterminato', 'record illeggibile: mai fidarsi, mai cancellare');

  assert.strictEqual(launchTarget.registra(root, 'cammina/fora', {
    launchId: 'a'.repeat(16), sessionId: '$7', paneId: '%9',
  }), false, 'nome sessione con separatore: rifiutato');
});
