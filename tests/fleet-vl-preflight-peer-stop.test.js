'use strict';
// Preflight di capacità peer/stop PRIMA dello spawn (D-558 F1 §3, pezzo 1).
// Lo status del binario PINNATO deve dichiarare ENTRAMBE le capacità versionate
// del ciclo peer/stop (host_peer_identity_v1 e host_stop_expected_v1) E
// peer_identity_support uguale a "supported": sono fatti del binario, esposti
// in ogni stato, host assente compreso. Senza una di queste l'up è RIFIUTATO
// in modo visibile PRIMA dello spawn: zero sessioni, zero payload broker,
// zero contesto, claim della root rilasciata. NodeId e owner restano distinti
// dall'identità del processo host: qui non se ne fa nulla, il contesto resta
// un record di lancio con hostIdentity pending.
// Prima parte: unit della funzione (spawn finto). Seconda parte: runtime
// REALE con fake vl + fake tmux a stato vero, HOME isolata in /tmp.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const host = require('../lib/fleet/vl-host-stop.js');
const {
  OWNER_INSTANCE_ID, STATO_HOST_ATTESTATO, IDENTITA_ATTESTATA,
} = require('./helpers/vl-attestato.js');

const STATO_CAPS = '{"state":"none","capabilities":["host_stop_v1","host_peer_identity_v1","host_stop_expected_v1"],"peer_identity_support":"supported"}';

// --- Unit: verificaCapacitaPeerStop ---------------------------------------

function procEsito(output, code) {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => {};
  p.unref = () => {};
  queueMicrotask(() => {
    if (output) p.stdout.emit('data', Buffer.from(output));
    p.emit('close', code);
  });
  return p;
}

test('unit: entrambe le capacità e support dichiarati — ok, host assente', async () => {
  const esito = await host.verificaCapacitaPeerStop({
    bin: '/pin/vl', env: {}, root: '/root/vl',
    spawnImpl: () => procEsito(STATO_CAPS + '\n', 0),
  });
  assert.equal(esito.ok, true);
  assert.equal(esito.stato.state, 'none');
});

test('unit: ok anche con un host GIA\' VIVO — le capacità sono del binario', async () => {
  const vivo = '{"state":"live","declared_pid":4242,"pid_number_in_use":true,'
    + '"capabilities":["host_stop_v1","host_peer_identity_v1","host_stop_expected_v1"],'
    + '"peer_identity_support":"supported"}';
  const esito = await host.verificaCapacitaPeerStop({
    bin: '/pin/vl', env: {}, root: '/root/vl',
    spawnImpl: () => procEsito(vivo + '\n', 0),
  });
  assert.equal(esito.ok, true);
  assert.equal(esito.stato.state, 'live');
});

test('unit: peer_identity_support assente (binario vecchio) — rifiuto support', async () => {
  const vecchio = '{"state":"none","capabilities":["host_stop_v1"]}';
  const esito = await host.verificaCapacitaPeerStop({
    bin: '/pin/vl', env: {}, root: '/root/vl',
    spawnImpl: () => procEsito(vecchio + '\n', 0),
  });
  assert.equal(esito.ok, false);
  assert.equal(esito.motivo, 'support');
});

test('unit: peer_identity_support "unsupported" — rifiuto support', async () => {
  const no = '{"state":"none","capabilities":["host_stop_v1","host_peer_identity_v1","host_stop_expected_v1"],"peer_identity_support":"unsupported"}';
  const esito = await host.verificaCapacitaPeerStop({
    bin: '/pin/vl', env: {}, root: '/root/vl',
    spawnImpl: () => procEsito(no + '\n', 0),
  });
  assert.equal(esito.ok, false);
  assert.equal(esito.motivo, 'support');
});

test('unit: manca host_stop_expected_v1 — rifiuto capacita', async () => {
  const parziale = '{"state":"none","capabilities":["host_stop_v1","host_peer_identity_v1"],"peer_identity_support":"supported"}';
  const esito = await host.verificaCapacitaPeerStop({
    bin: '/pin/vl', env: {}, root: '/root/vl',
    spawnImpl: () => procEsito(parziale + '\n', 0),
  });
  assert.equal(esito.ok, false);
  assert.equal(esito.motivo, 'capacita');
});

test('unit: manca host_peer_identity_v1 — rifiuto capacita', async () => {
  const parziale = '{"state":"none","capabilities":["host_stop_v1","host_stop_expected_v1"],"peer_identity_support":"supported"}';
  const esito = await host.verificaCapacitaPeerStop({
    bin: '/pin/vl', env: {}, root: '/root/vl',
    spawnImpl: () => procEsito(parziale + '\n', 0),
  });
  assert.equal(esito.ok, false);
  assert.equal(esito.motivo, 'capacita');
});

test('unit: uscita senza JSON leggibile o rc non zero — rifiuto probe', async () => {
  const senzaJson = await host.verificaCapacitaPeerStop({
    bin: '/pin/vl', env: {}, root: '/root/vl',
    spawnImpl: () => procEsito('qualcosa di rotto\n', 0),
  });
  assert.equal(senzaJson.ok, false);
  assert.equal(senzaJson.motivo, 'probe');
  const rc2 = await host.verificaCapacitaPeerStop({
    bin: '/pin/vl', env: {}, root: '/root/vl',
    spawnImpl: () => procEsito(STATO_CAPS + '\n', 2),
  });
  assert.equal(rc2.ok, false);
  assert.equal(rc2.motivo, 'probe');
});

// --- Runtime reale ----------------------------------------------------------

const SESSIONE = 'cloud-CellaPre';
const PROMPT = 'Leggi CLAUDE.md e parti';

function vlCorpo(rispostaHost, vlLog) {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'vl 0.4.0\\n'; exit 0; fi
printf '%s\\n' "$0 $*" >> ${JSON.stringify(vlLog)}
if [ "$1" = "host" ]; then printf '%s\\n' ${JSON.stringify(rispostaHost)}; exit 0; fi
if [ "$1" = "shutdown" ]; then printf '%s\\n' '{"ok":true}'; exit 0; fi
exit 0
`;
}

function mondo(t, { caps } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d558pf-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaPre');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  const vlLog = path.join(root, 'vl.log');
  fs.writeFileSync(vlLog, '');
  // Il binario qualificato non dichiara solo le capacita': risponde con l'host
  // LIVE e `peer_identity` verified che la registrazione all'up esige DOPO lo
  // spawn. Un `none` fisso fallirebbe l'up con VL_PEER_UNATTESTED.
  const rispostaHost = caps ? STATO_HOST_ATTESTATO : '{"state":"none"}';
  fs.writeFileSync(vlBin, vlCorpo(rispostaHost, vlLog), { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'NexusFiles'), { recursive: true });
  const catalogoVl = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogoVl, { recursive: true });
  fs.writeFileSync(path.join(catalogoVl, 'config.toml'), '[profiles.work]\nmodel = "m-work"\n');

  const statoPath = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoPath, '');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  // Fake tmux a stato vero (come fleet-vl-bootstrap-d558-runtime.test.js): la
  // risposta al report @nc_delivery sblocca up() senza attendere timeout.
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  if (process.argv.includes('new-session')) {
    const { spawnSync: creaSync } = require('node:child_process');
    const rCrea = creaSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpoCrea = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : ''); if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
    process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  const { spawnSync } = require('node:child_process');
  let n = 0; let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!riga) continue;
      if (riga === 'display-message -p nc-control-open') continue;
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
const cmd = args[0] || '';
const vive = () => fs.readFileSync(STATO, 'utf8').split('\\n').filter(Boolean);
if (cmd === 'list-sessions') { for (const n of vive()) process.stdout.write(n + '\\t1\\n'); process.exit(0); }
if (cmd === 'new-session') {
  if (vive().includes(${JSON.stringify(SESSIONE)})) { process.stderr.write('duplicate session: ' + ${JSON.stringify(SESSIONE)} + '\\n'); process.exit(1); }
  fs.writeFileSync(STATO, vive().concat([${JSON.stringify(SESSIONE)}]).join('\\n') + '\\n');
  process.stdout.write('$5\\t@1\\t%9\\n'); process.exit(0);
}
if (cmd === 'display-message') {
  const iF = args.indexOf('-F');
  const fmt = (iF >= 0 ? args[iF + 1] : args[args.length - 1]) || '';
  if (fmt.includes('socket_path')) { process.stdout.write('/tmp/nc-fake/socket\\t4242\\n'); process.exit(0); }
  if (fmt.includes('@nc_delivery')) { process.stdout.write('submitted\\n'); process.exit(0); }
  process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (cmd === 'capture-pane') { process.stdout.write(''); process.exit(0); }
if (cmd === 'kill-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  const mia = bersaglio === ${JSON.stringify(SESSIONE)} || bersaglio === '$5';
  if (mia) fs.writeFileSync(STATO, vive().filter((n) => n !== ${JSON.stringify(SESSIONE)}).map((n) => n + '\\n').join(''));
  process.exit(0);
}
if (cmd === 'has-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  const mia = bersaglio === ${JSON.stringify(SESSIONE)} || bersaglio === '$5';
  process.exit(mia && vive().includes(${JSON.stringify(SESSIONE)}) ? 0 : 1);
}
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'vl.native', label: 'VL', rc: false,
      managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }],
    cells: [{ id: 'CellaPre', tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false, prompt: PROMPT }],
  });

  const tickets = [];
  const launchBroker = {
    issue: async (payload) => {
      tickets.push(payload);
      return { socketPath: path.join(root, 'broker.sock'), nonce: 'a'.repeat(64) };
    },
    revoke: async () => {},
    close: async () => {},
  };
  const cfgBase = {
    home, fleetDefsPath: defsPath, tmuxBin,
    ensureTmuxProtection: async () => {}, launchBroker, platform: 'linux', env: {},
    launchReadyMs: 0, vlLaunchCooldownMs: 0,
    now: () => 0, monotonicNow: () => Date.now(),
    // Owner hex32 della tuple attestata: con `local` la tuple non e' valida
    // e l'up e' rifiutato per contratto.
    identityOwnerInstanceId: OWNER_INSTANCE_ID,
  };
  const base = () => vlCellBaseDir(home, OWNER_INSTANCE_ID, 'CellaPre');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, home, tickets, cfgBase, base, vlLog, statoPath,
    mettiVl(qualificato) {
      fs.writeFileSync(vlBin, vlCorpo(qualificato ? STATO_HOST_ATTESTATO : '{"state":"none"}', vlLog), { mode: 0o755 });
      fs.chmodSync(vlBin, 0o755);
    },
    async fleet() {
      const f = await createBuiltinFleet(cfgBase);
      t.after(() => f.close().catch(() => {}));
      return f;
    },
  };
}

test('runtime reale: binario senza capacita\' peer/stop — up RIFIUTATO prima dello spawn, zero effetti', async (t) => {
  const w = mondo(t, { caps: false });
  const fleet = await w.fleet();
  await assert.rejects(fleet.up('CellaPre'), (e) => {
    assert.equal(e.fleetCode, 'VL_PEER_STOP_UNSUPPORTED', 'cause enum stabile');
    assert.equal(e.fleetPhase, 'preflight');
    assert.equal(e.status, 500);
    assert.ok(e.data && ['probe', 'support', 'capacita'].includes(e.data.motivo), 'motivo bounded');
    assert.equal(e.data.motivo, 'support', 'il binario vecchio non dichiara il support');
    return true;
  });
  assert.equal(w.tickets.length, 0, 'zero payload broker: nessuno spawn deliberato');
  assert.equal(fs.readFileSync(w.statoPath, 'utf8').trim(), '', 'nessuna sessione tmux creata');
  assert.ok(!fs.existsSync(path.join(w.base(), 'host-context.json')), 'nessun contesto per un lancio rifiutato');
});

test('runtime reale: binario corretto dopo il rifiuto — up ok, claim rilasciata, preflight dal PIN', async (t) => {
  const w = mondo(t, { caps: false });
  const fleet = await w.fleet();
  await assert.rejects(fleet.up('CellaPre'), () => true);
  w.mettiVl(true);
  const res = await fleet.up('CellaPre');
  assert.equal(res.ok, true, 'la claim della root era stata rilasciata: nessun VL_ROOT_COLLISION');
  assert.equal(w.tickets.length, 1, 'un solo spawn, dopo la qualifica');
  const ctx = JSON.parse(fs.readFileSync(path.join(w.base(), 'host-context.json'), 'utf8'));
  assert.equal(ctx.version, 2);
  // La registratione all'up persiste la tuple kernel ATTESTATA nel contesto
  // del launchId: l'instanceId e' l'owner del nodo, distinto dai fatti del
  // processo host (che restano i sette campi kernel, non un nodeId).
  assert.deepEqual(ctx.hostIdentity, IDENTITA_ATTESTATA, 'la tuple attestata all\'up vive nel contesto del lancio');
  assert.match(ctx.vlBinSha256, /^[a-f0-9]{64}$/);
  const righe = fs.readFileSync(w.vlLog, 'utf8').split('\n')
    .filter((r) => r.includes('host status'));
  assert.ok(righe.length >= 1, 'il preflight ha interrogato lo status');
  assert.ok(righe.every((r) => r.includes(path.join('.nexuscrew', 'vl-control-pin'))),
    'il probe di capacità parte dal binario PINNATO, non da quello di origine');
});

test('runtime reale: binario qualificato fin da subito — up ok al primo colpo', async (t) => {
  const w = mondo(t, { caps: true });
  const fleet = await w.fleet();
  const res = await fleet.up('CellaPre');
  assert.equal(res.ok, true);
  assert.equal(w.tickets.length, 1);
  assert.ok(fs.existsSync(path.join(w.base(), 'host-context.json')));
});
