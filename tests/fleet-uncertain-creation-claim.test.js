'use strict';
// Una creazione dal'esito non noto non scioglie la claim della root VL.
// La risposta del server puo' perdersi DOPO la materializzazione della
// sessione: in quel caso «non ho ricevuto niente» non dimostra «non esiste
// niente», e rilasciare la barriera permetterebbe a un altro lancio di
// prendere la stessa root mentre la sessione e' viva. Qui il server finto
// MATERIALIZZA la sessione (marcatore su disco) e poi non risponde mai;
// il lancio fallisce, la lease resta, e un claim con altro launchId sulla
// stessa root e' rifiutato.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const radici = require('../lib/fleet/vl-roots.js');
const { scriptVlFintoConHost, OWNER_INSTANCE_ID } = require('./helpers/vl-attestato.js');

const SESSIONE = 'cloud-CellaIncerta';

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

function mondo(t, { materializza }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-incerta-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaIncerta');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  // Binario finto QUALIFICATO peer/stop: il preflight dell'up interroga le
  // capacita' prima dello spawn. L'host NON nasce mai (la risposta della
  // creazione si perde prima che il client parta), quindi la registrazione
  // dell'identita' non arriva: quel che resta e' la lease incerta, che e'
  // esattamente cio' che il test prova.
  const hostpid = path.join(root, 'hostpid');
  fs.writeFileSync(hostpid, '0\n');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(vlBin, scriptVlFintoConHost({ hostpid }), { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  const catalogo = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogo, { recursive: true });
  fs.writeFileSync(path.join(catalogo, 'config.toml'), '[profiles.work]\nmodel = "m"\n');
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const marker = path.join(root, 'materializzata');
  const script = `#!${process.execPath}
'use strict';
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  // Il server finto crea la sessione (marcatore) e poi PERDE la risposta:
  // nessun frame, il client resta appeso finché il runtime non sconfessa.
  ${materializza ? `require('fs').writeFileSync(${JSON.stringify(marker)}, '1');` : ''}
  setInterval(() => {}, 10000);
}
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
    cells: [{ id: 'CellaIncerta', tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false }],
  });
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false, vlLaunchCooldownMs: 0, log: () => {}, env: {} },
    // Owner hex32 valido: il preflight dell'identita' (F1-01) deve passare,
    // cosi' il test prova la lease incerta e non il rifiuto del preflight.
    identityOwnerInstanceId: OWNER_INSTANCE_ID,
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'b'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); });
  return { runtime, home, root, marker };
}

function leggiLaunchId(home) {
  const lease = trova(path.join(home, '.nexuscrew', 'vl-root-claims'), '.lease')[0];
  assert.ok(lease, 'la lease del lancio e\' presente');
  const record = JSON.parse(fs.readFileSync(lease, 'utf8'));
  assert.equal(record.kind, 'lease');
  return record;
}

test('risposta persa DOPO la materializzazione: lease trattenuta, claim altrui rifiutato', async (t) => {
  const w = mondo(t, { materializza: true });
  await assert.rejects(() => w.runtime.up('CellaIncerta'), (e) => e.fleetCode === 'NEW_SESSION_FAILED');
  assert.ok(fs.existsSync(w.marker), 'il server finto aveva materializzato la sessione');
  const record = leggiLaunchId(w.home);
  // La stessa root non si lascia prendere da un altro launchId: la lease
  // incerta resta una barriera reale, non solo un ricordo del processo.
  const contendente = await radici.riserva({
    home: w.home, root: record.root, launchId: 'ff'.repeat(8),
    ownerInstanceId: record.ownerInstanceId, cellId: record.cellId, budgetMs: 4000,
  });
  assert.equal(contendente.outcome, 'collision');
});

test('risposta persa PRIMA della materializzazione: la lease resta comunque', async (t) => {
  const w = mondo(t, { materializza: false });
  await assert.rejects(() => w.runtime.up('CellaIncerta'), (e) => e.fleetCode === 'NEW_SESSION_FAILED');
  assert.equal(fs.existsSync(w.marker), false);
  const record = leggiLaunchId(w.home);
  const contendente = await radici.riserva({
    home: w.home, root: record.root, launchId: 'ff'.repeat(8),
    ownerInstanceId: record.ownerInstanceId, cellId: record.cellId, budgetMs: 4000,
  });
  assert.equal(contendente.outcome, 'collision');
});
