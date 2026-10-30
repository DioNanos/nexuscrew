'use strict';
// D-558 FIX2a (F2, audit finale DevAuditor) — un esito `host-stopped-clean`
// del modulo host è uno stop PULITO: il controllo preliminare del down deve
// accettarlo come accetta `not-vl` e `host-already-stopped`, e il lancio deve
// proseguire fino alla chiusure durevole (barriere, teardown, record) così
// che l'up successivo sia ammesso.
// Prova del contratto runtime<->modulo: il modulo host è sostituito da un seam
// che restituisce `host-stopped-clean` (non è una prova di isolamento reale,
// che arriva con F1 nello strato successivo). Il resto del runtime è REALE:
// fixture fleet-vl-session (fake vl + fake tmux a stato vero + broker), HOME
// isolata in /tmp, nessun tmux/vl/cella veri.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// PRIMA di ogni require che carica il runtime: il seam su `fermaHost` va
// installato sull'oggetto esportato (il runtime destruttura al load time).
const hostStop = require('../lib/fleet/vl-host-stop.js');
const fermate = [];
hostStop.fermaHost = async function seamFermaHost(args) {
  fermate.push(args);
  return { outcome: 'host-stopped-clean', spawned: 0, via: 'internal' };
};

const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const launchTarget = require('../lib/fleet/launch-target.js');

const SESSIONE = 'cloud-CellaProva';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d558f2-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaProva');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(vlBin, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'vl 0.4.0\\n'; exit 0; fi\nif [ "$1" = "host" ]; then printf '%s\\n' '{"state":"none"}'; exit 0; fi\nif [ "$1" = "shutdown" ]; then printf '%s\\n' '{"ok":true}'; exit 0; fi\nexit 0\n`, { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot, { recursive: true });
  const catalogoVl = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogoVl, { recursive: true });
  fs.writeFileSync(path.join(catalogoVl, 'config.toml'), '[profiles.work]\nmodel = "m-work"\n');

  const statoPath = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoPath, '');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
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
    cells: [{ id: 'CellaProva', tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false, prompt: 'Leggi CLAUDE.md e parti' }],
  });

  const tickets = [];
  let adesso = 0;
  const clock = { now: () => adesso, advance: (ms) => { adesso += ms; } };
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
    now: clock.now, monotonicNow: clock.now,
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, home, tickets, filesRoot,
    async fleet() {
      const f = await createBuiltinFleet(cfgBase);
      t.after(() => f.close().catch(() => {}));
      return f;
    },
  };
}

test('F2: host-stopped-clean dal modulo host — down pulito, record chiuso, up ammesso', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const up1 = await fleet.up('CellaProva');
  assert.equal(up1.ok, true);
  assert.ok(fermate.length === 0, 'l\'up non consulta il modulo host');

  const down = await fleet.down('CellaProva');
  assert.equal(down.ok, true, 'stop pulito dell\'host: niente HOST_STOP_FAILED');
  assert.ok(fermate.length >= 1, 'il modulo host è stato consultato dal down');
  assert.equal(down.host, 'host-stopped-clean', 'l\'esito pulito viaggia nel risultato');

  // Record del lancio CHIUSO: o rimosso, o comunque non incerto (la guardia
  // persistente all'up rifiuterebbe con STOP_UNKNOWN).
  const record = path.join(w.filesRoot, launchTarget.DIR, `${SESSIONE}.json`);
  if (fs.existsSync(record)) {
    const letto = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.notEqual(letto.incerto, true, 'il record del lancio non resta incerto');
  }

  const up2 = await fleet.up('CellaProva');
  assert.equal(up2.ok, true, 'up successivo ammesso dopo lo stop pulito');
});
