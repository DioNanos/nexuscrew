'use strict';
// Matrice argv/env completa del ramo vl, con un launcher FINTO che registra
// argv ed env redatti attraverso il ciclo di lancio REALE (broker -> payload ->
// spawn). Non un seccello: il percorso esercitato e' quello che gira in
// produzione, cosi' la matrice descrive il contratto effettivo.
//
// Copre la matrice completa (native/custom/anthropic x
// con/senza profilo/modello/effort, env ambientali ostili, envPassthrough,
// path con spazi, binario inesistente/non eseguibile/versione inadatta,
// profilo mancante, effort non dichiarato/non supportato).
//
// Regole di redazione applicate OVUNQUE (payload, ticket, diagnostica):
// un valore che ha l'aria di un segreto non compare mai per intero. I nomi
// delle env viaggiano sempre: quello che il runtime deve sapere e' QUALE
// variabile, non il suo contenuto.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

// Come un valore sembra un segreto: stessi casi del logger di produzione.
const REDACT_RE = /^(sk-|secret|token|bearer |key-|ghp_)/i;
function redactValue(v) {
  const s = String(v);
  return REDACT_RE.test(s) ? '<redacted>' : s;
}
function redactEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) out[k] = redactValue(v);
  return out;
}

// Il launcher finto: registra argv ed env e non parla MAI col runtime vero.
// Il TUI non parte: qui la prova finisce alla composizione.
function mondo(t, { version = 'vl 0.5.0', engine = null, engineId = null, extraModels = null, clockStart = 0, cells = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlmx-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaProva');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'NexusFiles'), { recursive: true });
  // Il catalogo dell'operatore: la sorgente di un engine native senza
  // vlConfigFile dichiarato. Senza di esso il lancio nativo e' un rifiuto
  // dichiarato, non un avvio sui default del runtime.
  const catalogoVl = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogoVl, { recursive: true });
  fs.writeFileSync(path.join(catalogoVl, 'config.toml'), '[profiles.work]\nmodel = "m-work"\n');

  // Il binario vl nel PATH: serve a findBinary (il gate di `configured`), ma
  // il binario REALE che gira e' quello dichiarato in vlBinary.
  const pathBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(pathBin, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '${version}\\n'; fi\nexit 0\n`, { mode: 0o755 });
  fs.chmodSync(pathBin, 0o755);

  const statoPath = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoPath, '');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  fs.writeFileSync(tmuxBin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const STATO = ${JSON.stringify(statoPath)};
const cmd = args[0] || '';
const vive = () => fs.readFileSync(STATO, 'utf8').split('\\n').filter(Boolean);
if (cmd === 'list-sessions') { for (const n of vive()) process.stdout.write(n + '\\t1\\n'); process.exit(0); }
if (cmd === 'new-session') {
  const i = args.indexOf('-s');
  const nome = i >= 0 ? args[i + 1] : 'sessione-senza-nome';
  fs.writeFileSync(STATO, vive().concat([nome]).join('\\n') + '\\n');
  process.stdout.write('$5\\t@1\\t%9\\n'); process.exit(0);
}
if (cmd === 'display-message') { process.stdout.write('0\\t\\t%9\\n'); process.exit(0); }
if (cmd === 'capture-pane') {
  // Il marcatore di pronta della TUI VL: senza questo il gate di readiness
  // (vlPaneReadiness) aspetta il suo timeout e ogni test durerebbe 12 s.
  process.stdout.write('>\\nvivling [o] writer e42 \\u00b7 zai-a-coding \\u00b7 \\u2191267     esc quit \\u00b7 ^y yield\\n');
  process.exit(0);
}
if (cmd === 'kill-session') {
  const t = String(args[args.length - 1] || '').replace(/^=/, '');
  fs.writeFileSync(STATO, vive().filter((n) => n !== t).map((n) => n + '\\n').join(''));
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [engine || {
      id: 'vl.native', label: 'VL', rc: false,
      managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }],
    cells: (cells || [{ id: 'CellaProva', tmuxSession: 'cloud-CellaProva' }]).map((c) => ({
      id: c.id, tmuxSession: c.tmuxSession || c.id, cwd,
      engine: (engine && engine.id) || 'vl.native', boot: false,
    })),
    ...(extraModels ? { models: extraModels } : {}),
  });

  const tickets = [];
  let adesso = clockStart;
  const clock = { now: () => adesso, advance: (ms) => { adesso += ms; } };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, home, defsPath, tickets, clock,
    async fleet(cfgExtra = {}) {
      const f = await createBuiltinFleet({
        home, fleetDefsPath: defsPath, tmuxBin,
        ensureTmuxProtection: async () => {},
        platform: 'linux', env: {},
        launchReadyMs: 0,
        now: clock.now,
        vlLaunchCooldownMs: 0,
        launchBroker: {
          issue: async (payload) => {
            tickets.push({
              command: payload.command,
              args: [...payload.args],
              env: redactEnv(payload.env),
              envKeys: Object.keys(payload.env || {}).sort(),
            });
            return { socketPath: path.join(root, 'broker.sock'), nonce: 'a'.repeat(64) };
          },
          revoke: async () => {}, close: async () => {},
        },
        ...cfgExtra,
      });
      t.after(() => f.close().catch(() => {}));
      return f;
    },
  };
}

function vlNative(extra = {}) {
  return { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard', ...extra };
}

function catalogo(home, profiles) {
  const dir = path.join(home, 'cataloghi');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, `# catalogo\n${profiles.map((n) => `[profiles.${n}]\nmodel = "m-${n}"\n`).join('\n')}`);
  return file;
}

function binarioConSpazi(home, version = 'vl 0.5.0') {
  const dir = path.join(home, 'vl tools', 'bin 0.5');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'vl Runner');
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '${version}\\n'; fi\nexit 0\n`, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

const MODELS_CON_EFFORT = [{ id: 'gemma4', engine: 'vl.native', effortLevels: ['low', 'high'] }];

// ===========================================================================
// A. NATIVE senza scelte: nessun override, solo il trio XDG per cella
// ===========================================================================

test('matrice native vuoto: argv vuoto, nessuna env VL_*, solo il trio XDG', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  const ticket = w.tickets[0];
  assert.deepEqual(ticket.args, [], 'nessun argomento: la TUI parte nuda');
  for (const name of ['VL_PROVIDER', 'VL_BASE_URL', 'VL_MODEL', 'VL_EFFORT']) {
    assert.equal(ticket.env[name], undefined, `${name}: vl.native non compone override`);
  }
  assert.ok(ticket.env.XDG_STATE_HOME && ticket.env.XDG_DATA_HOME && ticket.env.XDG_CONFIG_HOME,
    'il trio XDG per cella viaggia nel payload');
  assert.ok(ticket.env.VL_SYSTEM_APPEND_FILE, 'il prompt viaggia sul file per cella');
  assert.equal(JSON.stringify(ticket).includes('sk-'), false, 'nessun segreto nel payload');
});

// ===========================================================================
// B. NATIVE + profilo: il profilo decide, l'env ambientale NON passa
// ===========================================================================

test('matrice native+profilo: -p <nome> su argv, provider/base/model/effort neutralizzati', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const cat = catalogo(w.home, ['work']);
  await fleet.editEngine('vl.native', { managed: vlNative({ vlConfigFile: cat, vlProfile: 'work' }) });
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  const ticket = w.tickets[0];
  assert.deepEqual(ticket.args, ['-p', 'work'], 'il profilo e\' UN argomento separato');
  for (const name of ['VL_PROVIDER', 'VL_BASE_URL', 'VL_MODEL', 'VL_EFFORT']) {
    assert.equal(ticket.env[name], undefined, `${name}: in modalita\' profilo l\'env composta non la porta`);
  }
  // la copia del catalogo vive nella config della cella, e selected.toml no
  assert.ok(ticket.env.XDG_CONFIG_HOME.includes('.nexuscrew'), 'la config e\' sotto l\'albero NC');
  assert.ok(!fs.existsSync(path.join(ticket.env.XDG_CONFIG_HOME, 'vl', 'selected.toml')),
    'selected.toml mai creato: la preferenza resta della cella');
});

test('matrice native+profilo con env AMBIENTALE ostile: VL_PROVIDER/VL_BASE_URL non arrivano al child', async (t) => {
  // L'ambiente del processo di NexusCrew ha VL_PROVIDER puntato a un provider
  // che il profilo non ha scelto: senza neutralizzazione il profilo verrebbe
  // scavalcato in silenzio. Il child deve vedere NESSUN provider.
  //
  // Il percorso di attacco che il contratto chiude: il nome VL_PROVIDER
  // ambientale non arriva al child da solo (l'ambiente non viene copiato),
  // e l'unico modo per introdurlo e' dichiararlo in envPassthrough — cosa che
  // il gate dei campi vl RIFIUTA alla sorgente, perche' VL_PROVIDER e' una
  // scelta dell'engine, non una credenziale. Qui si provano entrambi i passi.
  const w = mondo(t);
  const fleet = await w.fleet({
    env: { VL_PROVIDER: 'evil-provider', VL_BASE_URL: 'http://evil.invalid', VL_API_KEY: 'sk-ambient-secret' },
  });
  const cat = catalogo(w.home, ['work']);
  await fleet.editEngine('vl.native', { managed: vlNative({ vlConfigFile: cat, vlProfile: 'work' }) });
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  const ticket = w.tickets[0];
  assert.equal(ticket.env.VL_PROVIDER, undefined, 'VL_PROVIDER ambientale neutralizzato');
  assert.equal(ticket.env.VL_BASE_URL, undefined, 'VL_BASE_URL ambientale neutralizzato');
});

test('matrice passthrough ostile: dichiarare VL_PROVIDER in envPassthrough e\' RIFIUTATO alla sorgente', async (t) => {
  // La difesa in profondita': oltre a non copiare l'ambiente, il gate dei
  // campi vl rifiuta un passthrough che reintroduca una scelta dell'engine.
  // Se il rifiuto mancasse, il valore ambientale entrerebbe DOPO la
  // composizione e vincerebbe sul profilo, in silenzio.
  const w = mondo(t);
  const fleet = await w.fleet({ env: { VL_PROVIDER: 'evil-provider' } });
  const cat = catalogo(w.home, ['work']);
  await assert.rejects(
    () => fleet.editEngine('vl.native', {
      managed: vlNative({ vlConfigFile: cat, vlProfile: 'work', envPassthrough: ['VL_PROVIDER'] }),
    }),
    () => true,
    'un passthrough che reintroduce VL_PROVIDER non entra nella definizione',
  );
  assert.equal(w.tickets.length, 0, 'nessun lancio: la definizione rifiutata non parte');
});

test('matrice passthrough: VL_API_KEY ammesso (nome, mai valore) e neutralizzato in profilo solo se VL_OWNED', async (t) => {
  // VL_API_KEY NON e' una scelta dell'engine: e' una credenziale, e in
  // modalita' profilo resta dichiarabile per nome.
  const w = mondo(t);
  const fleet = await w.fleet({ env: { VL_API_KEY: 'sk-ambient-secret' } });
  const cat = catalogo(w.home, ['work']);
  await fleet.editEngine('vl.native', {
    managed: vlNative({ vlConfigFile: cat, vlProfile: 'work', envPassthrough: ['VL_API_KEY'] }),
  });
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  const ticket = w.tickets[0];
  assert.equal(ticket.env.VL_API_KEY, '<redacted>', 'la chiave viaggia per NOME, col valore redatto nel registro');
  assert.equal(ticket.env.VL_PROVIDER, undefined, 'la coppia del profilo resta neutralizzata');
});

test('matrice native+profilo+modello esplicito NC: il modello NC vince sul profilo', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const cat = catalogo(w.home, ['work']);
  await fleet.editEngine('vl.native', { managed: vlNative({ vlConfigFile: cat, vlProfile: 'work', model: 'scelto-da-ui' }) });
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  const ticket = w.tickets[0];
  assert.equal(ticket.env.VL_MODEL, 'scelto-da-ui', 'scelta esplicita NC > profilo');
  assert.deepEqual(ticket.args, ['-p', 'work'], 'il modello NON viaggia su argv in modalita\' profilo');
});

// ===========================================================================
// C. ANTHROPIC / CUSTOM: la variante e' la scelta, la coppia esce SEMPRE
// ===========================================================================

test('matrice anthropic: la coppia provider/base esce sempre, con o senza modello', async (t) => {
  const w = mondo(t, {
    engine: { id: 'vl.anthropic', label: 'VL', rc: false, managed: { client: 'vl', provider: 'anthropic', model: '', permissionPolicy: 'standard' } },
  });
  const fleet = await w.fleet({ env: { VL_API_KEY: 'sk-anthropic-secret' } });
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  const ticket = w.tickets[0];
  assert.equal(ticket.env.VL_PROVIDER, 'anthropic', 'la variante e\' la scelta');
  assert.equal(ticket.env.VL_BASE_URL, 'https://api.anthropic.com');
  assert.equal(ticket.env.VL_MODEL, undefined, 'senza modello scelto nessuna VL_MODEL');
  assert.deepEqual(ticket.args, [], 'le varianti remote non hanno -p');
  assert.equal(ticket.env.VL_API_KEY, '<redacted>', 'la chiave viaggia per nome, mai il valore');
});

test('matrice custom: il protocollo scelto E\' il provider wire, con baseUrl propria', async (t) => {
  const w = mondo(t, {
    engine: {
      id: 'vl.custom', label: 'GW', rc: false,
      managed: {
        client: 'vl', provider: 'custom', displayName: 'GW', baseUrl: 'https://gw.internal/x',
        protocol: 'anthropic-bearer', model: 'kimi-k2.7', envKey: '', permissionPolicy: 'standard',
      },
    },
  });
  const fleet = await w.fleet();
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  const ticket = w.tickets[0];
  assert.equal(ticket.env.VL_PROVIDER, 'anthropic-bearer', 'il protocollo custom e\' il provider wire');
  assert.equal(ticket.env.VL_BASE_URL, 'https://gw.internal/x');
  assert.equal(ticket.env.VL_MODEL, 'kimi-k2.7');
  assert.deepEqual(ticket.args, []);
});

test('matrice custom: env ambientale ostile NON sovrascrive la coppia composta', async (t) => {
  const w = mondo(t, {
    engine: {
      id: 'vl.custom', label: 'GW', rc: false,
      managed: {
        client: 'vl', provider: 'custom', displayName: 'GW', baseUrl: 'https://gw.internal/x',
        protocol: 'openai-compat', model: 'glm-5.2', envKey: '', permissionPolicy: 'standard',
      },
    },
  });
  const fleet = await w.fleet({ env: { VL_PROVIDER: 'evil', VL_BASE_URL: 'http://evil.invalid' } });
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  const ticket = w.tickets[0];
  assert.equal(ticket.env.VL_PROVIDER, 'openai-compat', 'la variante comanda, non l\'ambiente');
  assert.equal(ticket.env.VL_BASE_URL, 'https://gw.internal/x');
});

// ===========================================================================
// D. EFFORT: solo fra i livelli dichiarati, e solo se il binario lo legge
// ===========================================================================

test('matrice effort: livello dichiarato + binario che lo legge -> VL_EFFORT nel payload', async (t) => {
  const w = mondo(t, { extraModels: MODELS_CON_EFFORT });
  const fleet = await w.fleet();
  await fleet.editEngine('vl.native', { managed: vlNative({ model: 'gemma4', effort: 'high' }) });
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  assert.equal(w.tickets[0].env.VL_EFFORT, 'high', 'VL_EFFORT composta');
  assert.equal(w.tickets[0].env.VL_MODEL, 'gemma4');
});

test('matrice effort: livello NON dichiarato per il modello -> avvio rifiutato, nessun tier inventato', async (t) => {
  const w = mondo(t, { extraModels: MODELS_CON_EFFORT });
  const fleet = await w.fleet();
  await assert.rejects(
    () => fleet.editEngine('vl.native', { managed: vlNative({ model: 'gemma4', effort: 'medium' }) }),
    () => true,
    'un livello non dichiarato non entra nella definizione',
  );
  assert.equal(w.tickets.length, 0, 'nessun lancio: la definizione non e\' nemmeno valida');
});

test('matrice effort: modello SENZA effortLevels -> nessun effort accettato', async (t) => {
  const w = mondo(t, { extraModels: [{ id: 'gemma4', engine: 'vl.native' }] });
  const fleet = await w.fleet();
  await assert.rejects(
    () => fleet.editEngine('vl.native', { managed: vlNative({ model: 'gemma4', effort: 'high' }) }),
    () => true,
    'nessun effort inventato: il modello non dichiara livelli',
  );
});

test('matrice effort: binario che NON legge VL_EFFORT -> avvio rifiutato dichiarato, mai ignorato', async (t) => {
  const w = mondo(t, { version: 'vl 0.4.0', extraModels: MODELS_CON_EFFORT });
  const fleet = await w.fleet();
  await fleet.editEngine('vl.native', { managed: vlNative({ model: 'gemma4', effort: 'high' }) });
  await assert.rejects(() => fleet.up('CellaProva'), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /VL_EFFORT/);
    return true;
  }, 'il gate dichiara il rifiuto invece di comporre un env che il runtime ignorerebbe');
  assert.equal(w.tickets.length, 0, 'nessun ticket: il rifiuto avviene in preflight');
});

test('matrice effort: versione non determinabile -> rifiuto fail-closed dichiarato', async (t) => {
  const w = mondo(t, { extraModels: MODELS_CON_EFFORT });
  const fleet = await w.fleet();
  // un binario che non risponde a --version: il gate non promette niente
  const muto = path.join(w.home, 'vl-muto');
  fs.writeFileSync(muto, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.chmodSync(muto, 0o755);
  await fleet.editEngine('vl.native', { managed: vlNative({ vlBinary: muto, model: 'gemma4', effort: 'high' }) });
  await assert.rejects(() => fleet.up('CellaProva'), (e) => {
    assert.match(e.message, /non determinabile/);
    return true;
  });
  assert.equal(w.tickets.length, 0);
});

// ===========================================================================
// E. vlBinary: lo stesso file per probe e spawn; path con spazi; NO ripiego
// ===========================================================================

test('matrice vlBinary: path CON SPAZI -> argv[0] intero, probe e spawn sullo stesso file', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const bin = binarioConSpazi(w.home);
  await fleet.editEngine('vl.native', { managed: vlNative({ vlBinary: bin }) });
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  const ticket = w.tickets[0];
  assert.equal(ticket.command, fs.realpathSync(bin), 'argv[0] e\' il file risolto, intero');
  assert.ok(ticket.command.includes(' '), 'gli spazi nel percorso restano nel percorso (nessuna shell)');
  assert.deepEqual(ticket.args, [], 'nessun argomento aggiunto');
});

test('matrice vlBinary: inesistente / non eseguibile -> rifiuto dichiarato, MAI ripiego sul PATH', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  // inesistente
  await fleet.editEngine('vl.native', { managed: vlNative({ vlBinary: path.join(w.home, 'non-esiste') }) });
  await assert.rejects(() => fleet.up('CellaProva'), (e) => {
    assert.match(e.message, /nessun ripiego sul PATH/);
    return true;
  });
  // non eseguibile
  const noExec = path.join(w.home, 'vl-noexec');
  fs.writeFileSync(noExec, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  fs.chmodSync(noExec, 0o644);
  await fleet.editEngine('vl.native', { managed: vlNative({ vlBinary: noExec }) });
  await assert.rejects(() => fleet.up('CellaProva'), (e) => {
    assert.match(e.message, /non eseguibile/);
    return true;
  });
  assert.equal(w.tickets.length, 0, 'nessun lancio: il rifiuto avviene in preflight');
});

test('matrice vlBinary: versione inadatta al gate del prompt -> degrado DICHIARATO, niente env promessa', async (t) => {
  const w = mondo(t, { version: 'vl 0.1.0' });
  const fleet = await w.fleet();
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true, 'la cella PARTE: il degrado non e\' un blocco');
  assert.equal(w.tickets[0].env.VL_SYSTEM_APPEND_FILE, undefined,
    'una env che il runtime ignorerebbe in silenzio NON viene composta');
  assert.equal(res.vlPromptDegraded, true, 'il degrado e\' dichiarato nel risultato');
});

// ===========================================================================
// F. Profilo mancante / catalogo assente: rifiuto esplicito, mai silenzio
// ===========================================================================

test('matrice profilo: profilo inesistente nel catalogo -> rifiuto che nomina il profilo', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const cat = catalogo(w.home, ['work']);
  await fleet.editEngine('vl.native', { managed: vlNative({ vlConfigFile: cat, vlProfile: 'ghost' }) });
  await assert.rejects(() => fleet.up('CellaProva'), (e) => {
    assert.match(e.message, /ghost/);
    assert.match(e.message, /profilo inesistente rifiutato esplicitamente/);
    return true;
  });
  assert.equal(w.tickets.length, 0);
});

test('matrice profilo: catalogo dichiarato ma illeggibile -> rifiuto, nessun avvio senza catalogo', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  await fleet.editEngine('vl.native', { managed: vlNative({ vlConfigFile: path.join(w.home, 'manca.toml') }) });
  await assert.rejects(() => fleet.up('CellaProva'), (e) => {
    assert.match(e.message, /non leggibile/);
    assert.match(e.message, /avvio rifiutato/);
    return true;
  });
  assert.equal(w.tickets.length, 0);
});

// ===========================================================================
// G. Diagnostica: nessun segreto, e i tre campi distinguibili
// ===========================================================================

test('diagnostica: tre campi distinti (engine, profilo vl, modello effettivo) e nessun segreto', async (t) => {
  const w = mondo(t, { extraModels: MODELS_CON_EFFORT });
  const fleet = await w.fleet({ env: { VL_API_KEY: 'sk-non-mostrare-mai' } });
  const cat = catalogo(w.home, ['work']);
  await fleet.editEngine('vl.native', {
    managed: vlNative({
      vlConfigFile: cat, vlProfile: 'work', model: 'gemma4', effort: 'high',
      envPassthrough: ['VL_API_KEY'],
    }),
  });
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  const dump = JSON.stringify(res);
  assert.equal(dump.includes('sk-non-mostrare-mai'), false, 'nessun valore segreto nel risultato');
  // la chiave viaggia per nome nel payload, col valore redatto nel registro
  assert.equal(w.tickets[0].env.VL_API_KEY, '<redacted>', 'nel payload il segreto e\' redatto');
  // i tre campi restano distinguibili: il profilo sul argv, il modello e
  // l\'effort sulla env, e nessuno dei tre e\' un segreto
  assert.deepEqual(w.tickets[0].args, ['-p', 'work'], 'il profilo vl e\' il nome del profilo');
  assert.equal(w.tickets[0].env.VL_MODEL, 'gemma4', 'il modello effettivo');
  assert.equal(w.tickets[0].env.VL_EFFORT, 'high', 'l\'effort effettivo');
});

// ===========================================================================
// H. Nessun segreto su argv, MAI (in ogni variante)
// ===========================================================================

test('confini: nessuna variante mette un segreto su argv', async (t) => {
  const varianti = [
    { id: 'vl.native', managed: vlNative({ envPassthrough: ['VL_API_KEY'] }) },
    {
      id: 'vl.anthropic',
      managed: {
        client: 'vl', provider: 'anthropic', model: '', permissionPolicy: 'standard',
        envPassthrough: ['VL_API_KEY'],
      },
    },
    {
      id: 'vl.custom', managed: {
        client: 'vl', provider: 'custom', displayName: 'GW', baseUrl: 'https://gw.internal/x',
        protocol: 'anthropic-bearer', model: 'kimi-k2.7', envKey: '', permissionPolicy: 'standard',
        envPassthrough: ['VL_API_KEY'],
      },
    },
  ];
  for (const v of varianti) {
    const w = mondo(t, {
      engine: { id: v.id, label: 'VL', rc: false, managed: v.managed },
    });
    const fleet = await w.fleet({ env: { VL_API_KEY: 'sk-mai-su-argv' } });
    const res = await fleet.up('CellaProva');
    assert.equal(res.ok, true, v.id);
    const ticket = w.tickets[0];
    const argvDump = JSON.stringify([ticket.command, ...ticket.args]);
    assert.equal(argvDump.includes('sk-mai-su-argv'), false, `${v.id}: nessun segreto su argv`);
    assert.equal(ticket.env.VL_API_KEY, '<redacted>', `${v.id}: nel payload il segreto e\' redatto`);
  }
});

// ===========================================================================
// I. Il trio XDG e' l'IDENTITA' per cella: il passthrough non lo annulla
//
// Il runtime vl deriva dal trio XDG tre cose che condividerebbero una
// cartella: il root del server (che ospita il socket di controllo) e il dove
// finiscono le sessioni. Il trio lo compone NexusCrew, uno per cella: se un
// canale di passthrough puo' sovrascriverlo, due celle finiscono sulla stessa
// directory di stato e l'isolamento per cella diventa una promessa falsa.
// La prova e' sul PAYLOAD DEL BROKER (quello che il child riceve davvero),
// non sul solo helper dei percorsi.
// ===========================================================================

const XDG_TRIO = ['XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'];
// Il trio XDG condiviso, in un posto REALE: l'ambiente del servizio e' anche
// la radice del catalogo dell'operatore, quindi un percorso inesistente
// farebbe rifiutare il lancio nativo per una sorgente assente — e il test
// che segue riguarda il trio, non il catalogo.
function trioCondiviso(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlxdg-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const state = path.join(base, 'state');
  const data = path.join(base, 'data');
  const config = path.join(base, 'config');
  for (const d of [state, data, config]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(config, 'vl'), { recursive: true });
  fs.writeFileSync(path.join(config, 'vl', 'config.toml'), '[profiles.work]\nmodel = "m-work"\n');
  return { XDG_STATE_HOME: state, XDG_DATA_HOME: data, XDG_CONFIG_HOME: config };
}

test('XDG: il passthrough del trio XDG e\' RIFIUTATO alla sorgente (non entra nella definizione)', async (t) => {
  const w = mondo(t);
  const XDG_CONDIVISO = trioCondiviso(t);
  const fleet = await w.fleet({ env: { ...XDG_CONDIVISO } });
  await assert.rejects(
    () => fleet.editEngine('vl.native', { managed: vlNative({ envPassthrough: [...XDG_TRIO] }) }),
    (e) => {
      assert.match(e.message, /XDG_STATE_HOME/, 'il rifiuto nomina la variabile');
      assert.match(e.message, /identita' per cella/, 'il rifiuto dice perche\'');
      return true;
    },
    'un passthrough del trio XDG non entra nella definizione di una cella vl',
  );
  assert.equal(w.tickets.length, 0, 'nessun lancio: la definizione rifiutata non parte');
});

test('XDG: nemmeno scritto a mano nel file di definizioni il payload non porta il trio condiviso', async (t) => {
  // Il percorso della sorgente non e' l'unico: il file di definizioni puo'
  // essere scritto fuori dalla API. Il risultato che conta e' uno solo: il
  // payload del broker NON contiene mai il trio condiviso.
  const w = mondo(t, { cells: [{ id: 'Alpha' }, { id: 'Beta' }] });
  const defs = JSON.parse(fs.readFileSync(w.defsPath, 'utf8'));
  defs.engines[0].managed.envPassthrough = [...XDG_TRIO];
  fs.writeFileSync(w.defsPath, JSON.stringify(defs, null, 2));
  const XDG_CONDIVISO = trioCondiviso(t);
  const fleet = await w.fleet({ env: { ...XDG_CONDIVISO } });
  if (typeof fleet.up === 'function') {
    await assert.rejects(() => fleet.up('Alpha'), () => true,
      'il lancio non parte da una definizione che dichiara il trio XDG in passthrough');
  } else {
    assert.equal(fleet.available, false,
      'definizione non caricabile: il file intero e\' rifiutato, il fleet resta indisponibile');
  }
  assert.equal(w.tickets.length, 0, 'nessun payload emesso');
  for (const tk of w.tickets) {
    for (const nome of XDG_TRIO) {
      assert.notEqual(tk.env[nome], XDG_CONDIVISO[nome], `${nome}: mai il valore condiviso`);
    }
  }
});

test('XDG: due celle, stesso engine -> due payload con trio XDG DISTINTI (e mai quello condiviso)', async (t) => {
  const w = mondo(t, { cells: [{ id: 'Alpha' }, { id: 'Beta' }] });
  const XDG_CONDIVISO = trioCondiviso(t);
  const fleet = await w.fleet({ env: { ...XDG_CONDIVISO } });
  const a = await fleet.up('Alpha');
  const b = await fleet.up('Beta');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(w.tickets.length, 2, 'due lanci, due payload');
  const [pa, pb] = w.tickets.map((x) => x.env);
  for (const nome of XDG_TRIO) {
    assert.ok(pa[nome], `${nome}: presente nel payload di Alpha`);
    assert.ok(pb[nome], `${nome}: presente nel payload di Beta`);
    assert.notEqual(pa[nome], pb[nome], `${nome}: DISTINTO per cella`);
    assert.notEqual(pa[nome], XDG_CONDIVISO[nome], `${nome}: mai il valore condiviso`);
    assert.notEqual(pb[nome], XDG_CONDIVISO[nome], `${nome}: mai il valore condiviso`);
    assert.ok(pa[nome].includes(path.join('.nexuscrew', 'vl-cells')),
      `${nome}: dentro l'albero per cella di NexusCrew`);
  }
});

test('XDG: il trio ambientale non raggiunge mai il payload (assegnazione finale protetta)', async (t) => {
  // Difesa in profondita': anche se un valore ambientale del trio fosse
  // iniettato piu' a valle, l'assegnazione per cella di NexusCrew e' l'ultima
  // parola e resta quella che viaggia.
  const w = mondo(t);
  const XDG_CONDIVISO = trioCondiviso(t);
  const fleet = await w.fleet({ env: { ...XDG_CONDIVISO } });
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  const env = w.tickets[0].env;
  for (const nome of XDG_TRIO) {
    assert.notEqual(env[nome], XDG_CONDIVISO[nome], `${nome}: il valore ambientale non vince`);
    assert.ok(env[nome].includes(path.join('.nexuscrew', 'vl-cells')), `${nome}: per cella`);
  }
});

// ===========================================================================
// J. Catalogo vl: TOML vero (header quotati, commenti) e catalogo malformato
//
// Il catalogo e' un config.toml: si legge con il parser TOML, non con una
// regex. Un header con nome quotato (`[profiles."work"]`) o con un commento
// in coda e' TOML valido e il profilo esiste: rifiutarlo come "inesistente"
// sarebbe un difetto del prodotto, non una garanzia. Un catalogo malformato
// invece non dichiara nulla e la cella non parte, dichiarando il motivo.
// ===========================================================================

function catalogoTesto(home, testo) {
  const dir = path.join(home, 'cataloghi');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, testo);
  return file;
}

test('catalogo: header QUOTATO ([profiles."work"]) -> il profilo esiste e la cella parte', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const cat = catalogoTesto(w.home, '# catalogo\n[profiles."work"] # il profilo di lavoro\nmodel = "m-work"\n');
  await fleet.editEngine('vl.native', { managed: vlNative({ vlConfigFile: cat, vlProfile: 'work' }) });
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true, 'un catalogo TOML valido non viene rifiutato come inesistente');
  assert.deepEqual(w.tickets[0].args, ['-p', 'work'], 'il profilo quotato viaggia su argv');
});

test('catalogo: nomi con punto e trattini, e commenti, -> profili riconosciuti', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const cat = catalogoTesto(w.home, [
    '# catalogo di prova',
    '',
    '[profiles."work.local"]   # nome con punto',
    'model = "m1"',
    '',
    '[profiles.b-c]',
    'model = "m2"',
    '',
  ].join('\n'));
  await fleet.editEngine('vl.native', { managed: vlNative({ vlConfigFile: cat, vlProfile: 'work.local' }) });
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true, 'profilo con nome quotato e punto: riconosciuto');
  assert.deepEqual(w.tickets[0].args, ['-p', 'work.local']);
});

test('catalogo: malformato -> rifiuto DICHIARATO che nomina il file, nessun avvio', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const cat = catalogoTesto(w.home, '[profiles.work\nmodel = "m"\n');
  await fleet.editEngine('vl.native', { managed: vlNative({ vlConfigFile: cat, vlProfile: 'work' }) });
  await assert.rejects(() => fleet.up('CellaProva'), (e) => {
    assert.match(e.message, /catalogo vl non valido/, 'il rifiuto dice che il CATALOGO e\' rotto');
    assert.match(e.message, /config\.toml/, 'il rifiuto nomina il file');
    return true;
  });
  assert.equal(w.tickets.length, 0, 'nessun lancio da un catalogo malformato');
});

test('catalogo: malformato -> nessun profilo inventato (niente -p, niente catalogo accettato)', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const cat = catalogoTesto(w.home, 'profiles = 42\n');
  await fleet.editEngine('vl.native', { managed: vlNative({ vlConfigFile: cat, vlProfile: 'work' }) });
  await assert.rejects(() => fleet.up('CellaProva'), (e) => {
    assert.match(e.message, /catalogo vl non valido/);
    return true;
  });
  assert.equal(w.tickets.length, 0);
});
