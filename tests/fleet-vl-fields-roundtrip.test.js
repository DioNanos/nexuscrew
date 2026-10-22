'use strict';
// Roundtrip API/UI/persistenza/export dei campi nuovi del ramo vl
// (vlBinary, vlConfigFile, vlProfile, effort + effortLevels dei modelli).
//
// Copre il ciclo completo che fleet-vl.test.js e fleet-vl-fields.test.js
// non toccano: il gate di normalizzazione e' provato, ma qui si verifica che il
// campo attraversi INTERO il ciclo forma UI -> definizione persistita -> API ->
// esportazione -> ripristino, e che il cambio engine conservi l'identita' di
// stato della cella ("cambio engine conserva l'identita' dello stato").
// Nessun valore segreto transita: i campi vl sono path e nomi di profilo, mai
// chiavi; l'export non deve contenere segreti.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { normalizeManagedSpec, vlCellBaseDir } = require('../lib/fleet/managed.js');

const forms = () => import('../frontend/src/lib/fleet-forms.js');

// --- mondo minimal: fleet builtin con home temporanea e tmux finto a zero -----
// defineEngine/editEngine/definitions/restoreEngines non avviano celle, ma
// editEngine chiama refreshSessions(): serve un tmux che risponda (nessuna
// sessione viva), altrimenti l'edit non completa.
function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlrt-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'NexusFiles'), { recursive: true });
  const statoPath = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoPath, '');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  fs.writeFileSync(tmuxBin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'list-sessions') { process.exit(0); }
if (args[0] === 'display-message') { process.stdout.write('0\\t\\t%9\\n'); process.exit(0); }
if (args[0] === 'capture-pane') { process.stdout.write(''); process.exit(0); }
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, { schemaVersion: 1, engines: [], cells: [] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = {
    home, fleetDefsPath: defsPath, tmuxBin,
    ensureTmuxProtection: async () => {}, platform: 'linux', env: {},
    launchReadyMs: 0, now: () => 0,
  };
  return {
    home, defsPath, cfg,
    async fleet() {
      const f = await createBuiltinFleet(cfg);
      t.after(() => f.close().catch(() => {}));
      return f;
    },
  };
}

function vlManaged(extra = {}) {
  return { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard', ...extra };
}

// --- UI: forma ---------------------------------------------------------------

test('UI: blankEngine espone i campi vl vuoti (il selettore li presenta sempre)', async () => {
  const { blankEngine } = await forms();
  const e = blankEngine();
  for (const key of ['vlBinary', 'vlConfigFile', 'vlProfile', 'effort']) {
    assert.equal(e[key], '', `${key} presente e vuoto nella forma vergine`);
  }
});

test('UI: engineForm legge i campi vl dal managed; buildEngine li riscrive (round-trip forma)', async () => {
  const { engineForm, buildEngine } = await forms();
  const form = engineForm({
    id: 'vl.native', label: 'VL',
    managed: vlManaged({ vlBinary: '/opt/vl/bin/vl', vlConfigFile: '/opt/vl/config.toml', vlProfile: 'work', effort: 'high' }),
    rc: true,
  });
  assert.equal(form.vlBinary, '/opt/vl/bin/vl');
  assert.equal(form.vlConfigFile, '/opt/vl/config.toml');
  assert.equal(form.vlProfile, 'work');
  assert.equal(form.effort, 'high');
  // buildEngine ricostruisce il managed: i campi vl non vuoti rientrano, SOLO
  // per client vl, e l'omissione e' come si cancella (un valore nullo sarebbe
  // rifiutato dal validatore).
  const out = buildEngine({ ...form, kind: 'managed' }, false, []);
  assert.equal(out.managed.vlBinary, '/opt/vl/bin/vl');
  assert.equal(out.managed.vlConfigFile, '/opt/vl/config.toml');
  assert.equal(out.managed.vlProfile, 'work');
  assert.equal(out.managed.effort, 'high');
});

test('UI: buildEngine omette i campi vl vuoti (clearing per omissione) e non li attacca mai a client non-vl', async () => {
  const { buildEngine } = await forms();
  const out = buildEngine({
    kind: 'managed', id: 'vl.native', client: 'vl', provider: 'native',
    managedModel: '', permissionPolicy: 'standard', label: '', rc: true,
    vlBinary: '', vlConfigFile: '', vlProfile: '', effort: '', envRows: [],
  }, true, []);
  for (const key of ['vlBinary', 'vlConfigFile', 'vlProfile', 'effort']) {
    assert.equal(Object.hasOwn(out.managed, key), false, `${key} omesso quando vuoto: cosi' si cancella`);
  }
  // un client non-vl che portasse (per errore) campi vl nella forma NON li vede
  // nel managed costruito: il gate e' per client, non solo per non-vuoto.
  const claude = buildEngine({
    kind: 'managed', id: 'claude.native', client: 'claude', provider: 'native',
    managedModel: '', permissionPolicy: 'unsafe', label: '', rc: true,
    vlBinary: '/x', vlConfigFile: '/y', vlProfile: 'w', effort: 'high', envRows: [],
  }, true, []);
  for (const key of ['vlBinary', 'vlConfigFile', 'vlProfile', 'effort']) {
    assert.equal(Object.hasOwn(claude.managed, key), false, `${key} mai attaccato a client non-vl`);
  }
});

test('UI: buildEngine trimma i campi vl (spazi accidentali non diventano valori vuoti sporchi)', async () => {
  const { buildEngine } = await forms();
  const out = buildEngine({
    kind: 'managed', id: 'vl.native', client: 'vl', provider: 'native',
    managedModel: '', permissionPolicy: 'standard', label: '', rc: true,
    vlBinary: '  /opt/vl  ', vlProfile: '  work  ', envRows: [],
  }, true, []);
  assert.equal(out.managed.vlBinary, '/opt/vl');
  assert.equal(out.managed.vlProfile, 'work');
  assert.equal(Object.hasOwn(out.managed, 'vlConfigFile'), false, 'solo spazi -> omesso');
});

// --- persistenza: definitions.js atomicWrite -> loadDefinitions ---------------

test('persistenza: engine vl con campi nuovi round-tripa attraverso atomicWrite/loadDefinitions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlrt-p-'));
  try {
    const p = path.join(root, 'fleet.json');
    const managed = vlManaged({
      model: 'gemma4',
      vlBinary: '/opt/vl/bin/vl', vlConfigFile: '/opt/vl/config.toml',
      vlProfile: 'work', effort: 'high',
    });
    atomicWrite(p, {
      schemaVersion: 1,
      engines: [{ id: 'vl.native', label: 'VL', rc: true, managed }],
      models: [{ id: 'gemma4', engine: 'vl.native', effortLevels: ['low', 'high'] }],
      cells: [],
    });
    const defs = loadDefinitions(p);
    assert.ok(defs, 'defs leggibili');
    const eng = defs.engines.find((e) => e.id === 'vl.native');
    assert.equal(eng.managed.vlBinary, '/opt/vl/bin/vl');
    assert.equal(eng.managed.vlConfigFile, '/opt/vl/config.toml');
    assert.equal(eng.managed.vlProfile, 'work');
    assert.equal(eng.managed.effort, 'high');
    const model = defs.models.find((m) => m.id === 'gemma4');
    assert.deepEqual(model.effortLevels, ['low', 'high'], 'effortLevels del modello persistiti');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('persistenza: effortLevels invalidi rifiutano l intero file (nessun garbage su disco)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlrt-pi-'));
  try {
    const p = path.join(root, 'fleet.json');
    const base = {
      schemaVersion: 1,
      engines: [{ id: 'vl.native', label: 'VL', rc: true, managed: vlManaged() }],
      cells: [],
    };
    // atomicWrite valida PRIMA di scrivere (fail-closed): l'input invalido
    // lancio, il file non e' scritto. Si prova ogni famiglia di rifiuto.
    const casi = [
      Array.from({ length: 9 }, (_, i) => `l${i}`), // >8
      ['High'], // maiuscolo
      ['low', 'low'], // duplicato
      [], // vuoto
      'low', // non-array
    ];
    for (const lv of casi) {
      assert.throws(() => atomicWrite(p, { ...base, models: [{ id: 'm', engine: 'vl.native', effortLevels: lv }] }),
        /non vali/i, `effortLevels ${JSON.stringify(lv)}: atomicWrite rifiuta`);
    }
    // il disco NON e' rimasto sporco: nessun file scritto dai rifiuti
    assert.ok(!fs.existsSync(p), 'nessun file creato dai tentativi invalidi');
    // un file sano di nuovo passa (il rifiuto non ha bloccato il percorso)
    atomicWrite(p, { ...base, models: [{ id: 'm', engine: 'vl.native', effortLevels: ['low'] }] });
    assert.ok(loadDefinitions(p), 'file sano riammesso dopo i rifiuti');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('persistenza: vlBinary relativo nel fleet.json rifiutato dal gate di normalizzazione', () => {
  // MANAGED_KEYS include vlBinary e normalizeManagedSpec lo valida: un engine
  // persistito con vlBinary relativo fa lanciare atomicWrite (valida prima di
  // scrivere) -> nessun garbage su disco.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlrt-pr-'));
  try {
    const p = path.join(root, 'fleet.json');
    assert.throws(() => atomicWrite(p, {
      schemaVersion: 1,
      engines: [{ id: 'vl.native', label: 'VL', rc: true, managed: vlManaged({ vlBinary: 'vl' }) }],
      cells: [],
    }), /vlBinary/, 'vlBinary relativo: atomicWrite rifiuta in persistenza');
    assert.ok(!fs.existsSync(p), 'nessun file scritto con vlBinary relativo');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- API: defineEngine / definitions / editEngine / restoreEngines -----------

test('API: defineEngine con campi vl -> definitions() li espone; export senza segreti', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  // vl.native e' backfillato di default: si usa un id laboratorio per define.
  await fleet.defineEngine({
    id: 'vl.lab', label: 'VL Lab', rc: true,
    managed: vlManaged({ vlBinary: '/opt/vl/bin/vl', vlConfigFile: '/opt/vl/config.toml', vlProfile: 'work' }),
  });
  const defs = fleet.definitions();
  const eng = defs.engines.find((e) => e.id === 'vl.lab');
  assert.equal(eng.managed.vlBinary, '/opt/vl/bin/vl');
  assert.equal(eng.managed.vlConfigFile, '/opt/vl/config.toml');
  assert.equal(eng.managed.vlProfile, 'work');
  // export: i campi vl sono path/nomi, mai chiavi; il dump non contiene segreti
  const dump = JSON.stringify(defs);
  assert.equal(/sk-[A-Za-z0-9]/.test(dump), false, 'nessun segreto nell export definitions');
  assert.equal(dump.includes('vlBinary'), true, 'il campo e visibile nel payload UI/API');
});

test('API: editEngine che sostituisce managed cancellando un campo vl -> campo assente', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  // si parte dal vl.native backfillato (senza campi vl) e si aggiungono, poi si
  // cancella vlProfile per omissione: la UI ricostruisce l intero managed.
  await fleet.editEngine('vl.native', {
    managed: vlManaged({ vlBinary: '/opt/vl/bin/vl', vlProfile: 'work' }),
  });
  let eng = fleet.definitions().engines.find((e) => e.id === 'vl.native');
  assert.equal(eng.managed.vlBinary, '/opt/vl/bin/vl');
  assert.equal(eng.managed.vlProfile, 'work');
  // secondo edit: vlProfile omesso (campo vuoto -> buildEngine omette) -> cancellato
  await fleet.editEngine('vl.native', {
    managed: vlManaged({ vlBinary: '/opt/vl/bin/vl' }),
  });
  eng = fleet.definitions().engines.find((e) => e.id === 'vl.native');
  assert.equal(eng.managed.vlBinary, '/opt/vl/bin/vl', 'il campo tenuto resta');
  assert.equal(Object.hasOwn(eng.managed, 'vlProfile'), false, 'il campo omesso e cancellato');
  assert.equal(eng.managed.vlProfile, undefined);
});

test('API: restoreEngines round-tripa i campi vl (export -> import)', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  // effort richiede un modello dichiarato con effortLevels che lo contenga
  // E il modello deve essere quello del managed (la validazione cerca per id):
  // restoreEngines accetta i modelli insieme agli engine (opts.models).
  const exported = [
    { id: 'vl.lab', label: 'VL Lab', rc: true, managed: vlManaged({ model: 'gemma4', vlBinary: '/opt/vl/bin/vl', vlConfigFile: '/c.toml', vlProfile: 'work', effort: 'high' }) },
  ];
  await fleet.restoreEngines(exported, { overwrite: true, models: [{ id: 'gemma4', engine: 'vl.lab', effortLevels: ['low', 'high'] }] });
  const eng = fleet.definitions().engines.find((e) => e.id === 'vl.lab');
  assert.equal(eng.managed.vlProfile, 'work');
  assert.equal(eng.managed.effort, 'high');
  assert.equal(eng.managed.vlConfigFile, '/c.toml');
  assert.equal(eng.managed.model, 'gemma4');
});

test('API: defineEngine con vlProfile su variante custom rifiutato (incompatibili)', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  await assert.rejects(() => fleet.defineEngine({
    id: 'vl.custom', label: 'GW', rc: true,
    managed: {
      client: 'vl', provider: 'custom', displayName: 'GW', baseUrl: 'https://gw/x',
      protocol: 'anthropic-bearer', model: 'kimi', vlProfile: 'work', vlConfigFile: '/c.toml',
    },
  }), (e) => {
    // la validazione e quella di normalizeManagedSpec, riversata in mutate
    assert.equal(e.status, 400);
    return true;
  }, 'custom + profilo: il file non entra su disco');
  assert.equal(fleet.definitions().engines.find((e) => e.id === 'vl.custom'), undefined, 'nessun engine sporco persistito');
});

// --- identita' di stato: indipendente dall engine -------------------------

test('identita stato: vlCellBaseDir e indipendente dall engine; cambio engine conserva il percorso', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlrt-id-'));
  try {
    const owner = 'node-1';
    const before = vlCellBaseDir(home, owner, 'CellaProva');
    // stesso owner+cellId, nessun engine in input: il percorso e una funzione
    // di (home, owner, cellId). Cambiare engine non sposta lo stato.
    const after = vlCellBaseDir(home, owner, 'CellaProva');
    assert.equal(before, after, 'cambio engine: stessa directory di stato');
    // e' distinto da un altra cella
    assert.notEqual(before, vlCellBaseDir(home, owner, 'CellaProva2'));
    // owner diverso, stessa cellId: diverso
    assert.notEqual(before, vlCellBaseDir(home, 'node-2', 'CellaProva'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('identita stato: normalizeManagedSpec non accetta campi vl su client non-vl (gate di dominio)', () => {
  // I campi nuovi vivono solo sul client vl; su altri client sono un
  // errore di configurazione dichiarato, non un no-op silenzioso che li
  // persistirebbe di nascosto.
  let issue = null;
  const out = normalizeManagedSpec(
    { client: 'claude', provider: 'native', vlBinary: '/x', vlProfile: 'w' },
    { onIssue: (i) => { issue = i; } },
  );
  assert.equal(out, null);
  assert.ok(issue, 'campo vl su client non-vl: rifiuto dichiarato');
});