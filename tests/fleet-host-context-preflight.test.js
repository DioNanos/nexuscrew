'use strict';
// Il preflight host del teardown non dipende dalla leggibilita' del contesto:
// un contesto assente, corrotto o di un altro lancio rifiuta il down PRIMA di
// qualunque effetto (nessun kill-session, nessuno shutdown del client vl,
// record del lancio conservato). La famiglia del lancio e' quella registrata
// alla creazione, non quella ricostruita dall'engine aggiornato.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');

const SESSIONE = 'cloud-CellaCtx';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ctx-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaCtx');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const vlLog = path.join(root, 'vl.log');
  const tmuxLog = path.join(root, 'tmux.log');
  fs.writeFileSync(vlLog, '');
  fs.writeFileSync(tmuxLog, '');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(vlBin, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'vl 0.3.1\\n'; exit 0; fi
printf '%s\\n' "$*" >> ${JSON.stringify(vlLog)}
if [ "$1" = "host" ]; then printf '%s\\n' '{"state":"none","capabilities":["host_stop_v1","host_peer_identity_v1","host_stop_expected_v1"],"peer_identity_support":"supported"}'; exit 0; fi
if [ "$1" = "shutdown" ]; then printf '%s\\n' '{"ok":true}'; exit 0; fi
exit 0
`, { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  // Catalogo del TEST, non dell'ambiente: env {} esclude l'XDG dell'operatore.
  const catalogo = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogo, { recursive: true });
  fs.writeFileSync(path.join(catalogo, 'config.toml'), '[profiles.work]\nmodel = "m"\n');
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const log = (riga) => fs.appendFileSync(${JSON.stringify(tmuxLog)}, riga + '\\n');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
log('argv:' + args.join(' '));
if (args[0] === '-C') {
  if (process.argv.includes('new-session')) {
    const { spawnSync: creaSync } = require('node:child_process');
    const rCrea = creaSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpoCrea = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : ''); if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
    process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  let buf = '';
  let n = 0;
  let viva = true;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!riga) continue;
      if (riga === 'display-message -p nc-control-open') continue;
      n += 1;
      log('channel:' + riga);
      if (riga.startsWith('kill-session')) viva = false;
      if (riga.startsWith('has-session') && !viva) {
        process.stdout.write('%begin 1 ' + n + ' 1\\n%error 1 ' + n + ' 1\\n');
      } else {
        process.stdout.write('%begin 1 ' + n + ' 1\\n%end 1 ' + n + ' 1\\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
if (args[0] === 'new-session') { process.stdout.write('$8\\t@8\\t%8\\n'); process.exit(0); }
if (args[0] === 'display-message') process.stdout.write('0\\t0\\t%8\\n');
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  const cella = { id: 'CellaCtx', tmuxSession: SESSIONE, cwd, engine: 'motore', boot: false };
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'motore', label: 'VL',
      managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }],
    cells: [cella],
  });
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false, vlLaunchCooldownMs: 0, log: () => {}, env: {} },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'd'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  const contesto = () => {
    const base = path.join(home, '.nexuscrew', 'vl-cells');
    const trovati = [];
    const visita = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) visita(p);
        else if (e.name === 'host-context.json') trovati.push(p);
      }
    };
    visita(base);
    return trovati[0] || null;
  };
  const recordLancio = () => path.join(filesRoot, 'launch-targets', `${SESSIONE}.json`);
  t.after(() => { try { runtime.shutdown(); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); });
  return { runtime, defsPath, cella, vlLog, tmuxLog, contesto, recordLancio };
}

test('contesto corrotto: il down rifiuta prima di qualunque effetto', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaCtx');
  const fileContesto = w.contesto();
  assert.ok(fileContesto, 'contesto host scritto al lancio');
  // Corruzione DOPO il lancio: la lettura restituira' un errore senza
  // launchId — il caso in cui la qualifica non puo' dipendere dal contesto.
  fs.writeFileSync(fileContesto, '{nope', 'utf8');
  await assert.rejects(() => w.runtime.down('CellaCtx'), (e) => e.fleetCode === 'HOST_UNRESOLVABLE');
  const tmux = fs.readFileSync(w.tmuxLog, 'utf8');
  assert.equal(tmux.includes('kill-session'), false, 'nessun kill-session, né dal canale né da client nuovi');
  assert.equal(fs.readFileSync(w.vlLog, 'utf8').includes('shutdown'), false, 'nessuno shutdown del client vl');
  const record = JSON.parse(fs.readFileSync(w.recordLancio(), 'utf8'));
  assert.equal(record.incerto, true, 'record del lancio conservato e marcato incerto');
  assert.equal(record.family, 'vl', 'la famiglia del lancio resta quella registrata');
  await assert.rejects(() => w.runtime.up('CellaCtx'), (e) => e.fleetCode === 'STOP_UNKNOWN',
    'un nuovo avvio non riparte su stato indeterminato');
});

test('contesto di un altro lancio: stessa barriera, stesso rifiuto', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaCtx');
  const fileContesto = w.contesto();
  const ctx = JSON.parse(fs.readFileSync(fileContesto, 'utf8'));
  ctx.launchId = 'f'.repeat(16);
  fs.writeFileSync(fileContesto, `${JSON.stringify(ctx)}\n`, 'utf8');
  await assert.rejects(() => w.runtime.down('CellaCtx'), (e) => e.fleetCode === 'HOST_UNRESOLVABLE');
  assert.equal(fs.readFileSync(w.tmuxLog, 'utf8').includes('kill-session'), false);
  assert.equal(JSON.parse(fs.readFileSync(w.recordLancio(), 'utf8')).incerto, true);
});

test('contesto assente: il down di un lancio vl rifiuta senza effetti', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaCtx');
  fs.unlinkSync(w.contesto());
  await assert.rejects(() => w.runtime.down('CellaCtx'), (e) => e.fleetCode === 'HOST_UNRESOLVABLE');
  assert.equal(fs.readFileSync(w.tmuxLog, 'utf8').includes('kill-session'), false);
  assert.ok(fs.existsSync(w.recordLancio()), 'record del lancio conservato');
});

test('engine cambiato dopo il lancio: la barriera resta quella del lancio', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaCtx');
  fs.writeFileSync(w.contesto(), '{nope', 'utf8');
  // La definizione ora dice un client diverso: il lancio registrato resta vl
  // e il rifiuto non si scioglie perche' l'engine aggiornato e' un'altra
  // famiglia.
  atomicWrite(w.defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'motore', label: 'C',
      managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' },
    }],
    cells: [w.cella],
  });
  await assert.rejects(() => w.runtime.down('CellaCtx'), (e) => e.fleetCode === 'HOST_UNRESOLVABLE');
  assert.equal(fs.readFileSync(w.tmuxLog, 'utf8').includes('kill-session'), false);
});
