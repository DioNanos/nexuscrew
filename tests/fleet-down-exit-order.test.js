'use strict';
// Le uscite «sessione gia' assente» e «canale morto dopo il kill accettato»
// chiudono PRIMA la barriera host e SOLO POI tolgono record e canale: un host
// non fermo lascia il lancio al suo posto invece di dichiarare la chiusura
// con il record gia' cancellato.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const launchTarget = require('../lib/fleet/launch-target.js');

const SESSIONE = 'cloud-CellaOrd';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ord-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaOrd');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const logPath = path.join(root, 'vl.log');
  const killPath = path.join(root, 'kill.log');
  const muoriSuKill = path.join(root, 'MUORI_SU_KILL');
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(killPath, '');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  // Primo 'host status': host fermo (la barriera del preflight passa).
  // Dal secondo in poi: host vivo senza attestazione (la chiusura post-uscita
  // non deve dichiarare successo).
  fs.writeFileSync(vlBin, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'vl 0.3.1\\n'; exit 0; fi
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [ "$1" = "host" ]; then
  N=$(cat ${JSON.stringify(path.join(root, 'host-n'))} 2>/dev/null || echo 0)
  N=$((N+1)); echo "$N" > ${JSON.stringify(path.join(root, 'host-n'))}
  if [ "$N" -le 1 ]; then printf '%s\\n' '{"state":"none"}'; exit 0; fi
  printf '%s\\n' '{"state":"live","pid":4242}'; exit 0
fi
if [ "$1" = "shutdown" ]; then printf '%s\\n' '{"ok":true}'; exit 0; fi
exit 0
`, { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  const catalogo = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogo, { recursive: true });
  fs.writeFileSync(path.join(catalogo, 'config.toml'), '[profiles.work]\nmodel = "m"\n');
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  const stato = path.join(root, 'sessione-viva');
  fs.writeFileSync(stato, '1\n');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
const STATO = ${JSON.stringify(stato)};
const KILL = ${JSON.stringify(killPath)};
const MUORI_SU_KILL = ${JSON.stringify(muoriSuKill)};
const viva = () => fs.readFileSync(STATO, 'utf8').trim() === '1';
if (args[0] === '-C') {
  process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  let buf = '';
  let n = 0;
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
      if (riga.startsWith('kill-session')) {
        fs.appendFileSync(KILL, 'kill\\n');
        fs.writeFileSync(STATO, '0\\n');
        process.stdout.write('%begin 1 ' + n + ' 1\\n%end 1 ' + n + ' 1\\n');
        if (fs.existsSync(MUORI_SU_KILL)) process.exit(0);
        continue;
      }
      if (riga.startsWith('has-session') && !viva()) {
        process.stdout.write('%begin 1 ' + n + ' 1\\n%error 1 ' + n + ' 1\\n');
      } else {
        process.stdout.write('%begin 1 ' + n + ' 1\\n%end 1 ' + n + ' 1\\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
if (args[0] === 'new-session') { process.stdout.write('$3\\t@3\\t%3\\n'); process.exit(0); }
if (args[0] === 'display-message') process.stdout.write('0\\t0\\t%3\\n');
if (args[0] === 'kill-session') { fs.appendFileSync(KILL, 'fresh\\n'); process.exit(0); }
if (args[0] === 'has-session') process.exit(viva() ? 0 : 1);
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'vl.native', label: 'VL',
      managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }],
    cells: [{ id: 'CellaOrd', tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false }],
  });
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false, vlLaunchCooldownMs: 0, log: () => {}, env: {} },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'f'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  const record = () => path.join(filesRoot, launchTarget.DIR, `${SESSIONE}.json`);
  t.after(() => { try { runtime.shutdown(); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); });
  return { runtime, record, stato, killPath, logPath, muoriSuKill };
}

test('sessione gia assente con host non fermo: record e canale restano', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaOrd');
  // La sessione finisce fuori banda; il record del lancio resta. L'host resta
  // VIVO senza attestazione gia' alla prima verifica (contatore pre-seedato):
  // in questo ramo la barriera host e' l'unica che gira.
  fs.writeFileSync(path.join(path.dirname(w.stato), 'host-n'), '1\n');
  fs.writeFileSync(w.stato, '0\n');
  await assert.rejects(() => w.runtime.down('CellaOrd'), (e) => e.fleetCode === 'HOST_STOP_FAILED');
  assert.ok(fs.existsSync(w.record()), 'il record del lancio NON e\' stato rimosso prima della barriera host');
  assert.equal(JSON.parse(fs.readFileSync(w.record(), 'utf8')).incerto, true);
  assert.equal(fs.readFileSync(w.killPath, 'utf8'), '', 'nessun kill: la sessione era gia\' assente');
  await assert.rejects(() => w.runtime.up('CellaOrd'), (e) => e.fleetCode === 'STOP_UNKNOWN');
});

test('kill accettato e canale morto: la chiusura host precede la rimozione', async (t) => {
  const w = mondo(t);
  await w.runtime.up('CellaOrd');
  // Il canale muore RICEVUTO il kill-session: la morte del client attaccato
  // e' la conferma osservata della fine della sessione.
  fs.writeFileSync(w.muoriSuKill, '1\n');
  await assert.rejects(() => w.runtime.down('CellaOrd'), (e) => e.fleetCode === 'HOST_STOP_FAILED');
  assert.equal(fs.readFileSync(w.killPath, 'utf8'), 'kill\n', 'il kill accettato e\' avvenuto');
  assert.ok(fs.existsSync(w.record()), 'il record del lancio NON e\' stato rimosso prima della barriera host');
  assert.equal(JSON.parse(fs.readFileSync(w.record(), 'utf8')).incerto, true);
  await assert.rejects(() => w.runtime.up('CellaOrd'), (e) => e.fleetCode === 'STOP_UNKNOWN');
});
