'use strict';
// tests/fleet-cell-mcp.test.js — quali strumenti MCP ha una cella, per NOME.
//
// IL VINCOLO CHE HA DECISO IL DISEGNO. La via ovvia sarebbe generare per ogni
// cella un file con i soli server concessi. Ma quel file conterrebbe le
// DEFINIZIONI, e su questa installazione tre di esse portano credenziali nel
// proprio `env` (una password Nextcloud, due chiavi API): si sarebbero
// duplicati i segreti in un file per cella invece che in uno per profilo —
// peggio del punto di partenza. Qui viaggiano solo NOMI, in argv.
//
// PERCHE' SI NEGA INVECE DI PERMETTERE. Misurato sul client installato:
//   deny:["mcp__*"] + allow:["mcp__nexuscrew"]  ->  nessun tool esposto.
// Un `deny` piu' largo vince su un `allow` piu' specifico. Quindi concedere si
// fa negando il complemento.
//
// COSA E' PROVATO ALTROVE. Che il `deny` tolga davvero i tool dalla sessione e'
// stato verificato su sessioni Claude reali, tre volte con insiemi concessi
// diversi (solo nexuscrew; solo webfetch; nessuno col jolly). Qui si prova
// l'altra meta': che l'argv sia composto giusto, nei casi giusti.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveManagedEngine } = require('../lib/fleet/managed.js');
const { parseDefinitions } = require('../lib/fleet/definitions.js');

function mondo(t, { serverUtente = ['nexuscrew', 'webfetch', 'nextcloud'], serverProgetto = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cellmcp-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  const mcpServers = {};
  for (const nome of serverUtente) mcpServers[nome] = { command: nome };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers }), { mode: 0o600 });
  const cwd = path.join(home, 'lavoro');
  fs.mkdirSync(cwd);
  if (serverProgetto) {
    const p = {};
    for (const nome of serverProgetto) p[nome] = { command: nome };
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: p }));
  }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, cwd };
}

const ENGINE = {
  id: 'claude.native', label: 'N',
  managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' },
};

function settingsDi(w, cell) {
  const out = resolveManagedEngine(ENGINE, { id: 'Dev', cwd: w.cwd, ...cell }, {
    home: w.home, platform: 'linux', env: {},
  });
  assert.equal(out.ok, true, out.reason);
  const token = out.engine.args.find((a) => a.startsWith('--settings'));
  return { token, args: out.engine.args, deny: token ? JSON.parse(token.slice('--settings='.length)).permissions.deny : null };
}

test('assente non e\' come vuoto: senza `mcp` la cella eredita tutto, come sempre', (t) => {
  const w = mondo(t);
  assert.equal(settingsDi(w, {}).token, undefined, 'nessun flag, nessun cambiamento di comportamento');
});

test('`mcp: []` nega col jolly, e questo caso e\' ESATTO', (t) => {
  // E' la cella di cui non ci si fida. Il jolly non dipende da quali server
  // esistono ne' da dove arrivano: e' giusto che il caso restrittivo sia quello
  // senza approssimazioni.
  const w = mondo(t);
  assert.deepEqual(settingsDi(w, { mcp: [] }).deny, ['mcp__*']);
});

test('un elenco parziale nega il COMPLEMENTO, non permette l\'eccezione', (t) => {
  // Perche' un deny piu' largo vince su un allow piu' specifico: concedere
  // «solo nexuscrew» significa negare tutti gli altri per nome.
  const w = mondo(t);
  assert.deepEqual(settingsDi(w, { mcp: ['nexuscrew'] }).deny, ['mcp__nextcloud', 'mcp__webfetch']);
});

test('concedere tutto non produce alcun flag', (t) => {
  const w = mondo(t);
  assert.equal(settingsDi(w, { mcp: ['nexuscrew', 'webfetch', 'nextcloud'] }).token, undefined);
});

test('anche i server di PROGETTO entrano nel complemento', (t) => {
  // Un server dichiarato nel `.mcp.json` della cwd della cella e' una sorgente
  // reale: se non lo si enumerasse, «solo nexuscrew» lascerebbe passare tool
  // che l'operatore credeva esclusi.
  const w = mondo(t, { serverProgetto: ['crew'] });
  assert.deepEqual(settingsDi(w, { mcp: ['nexuscrew'] }).deny,
    ['mcp__crew', 'mcp__nextcloud', 'mcp__webfetch']);
});

test('il LOCAL SCOPE entra nel complemento: stesso file, ramo diverso', (t) => {
  // Trovato dall'audit, ed era reale: su questa installazione nove progetti
  // hanno server dichiarati in `projects[<cwd>].mcpServers` dentro la stessa
  // configurazione utente. Non enumerarli significava che «solo nexuscrew»
  // lasciava passare server che la sessione carica davvero — e l'operatore
  // credeva di averli esclusi.
  const w = mondo(t);
  const file = path.join(w.home, '.claude.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.projects = { [w.cwd]: { mcpServers: { memory: { command: 'memory' } } }, '/altrove': { mcpServers: { spia: {} } } };
  fs.writeFileSync(file, JSON.stringify(j));
  const deny = settingsDi(w, { mcp: ['nexuscrew'] }).deny;
  assert.ok(deny.includes('mcp__memory'), `il local scope della cwd deve entrare: ${JSON.stringify(deny)}`);
  // E quello di UN'ALTRA directory no: e' indicizzato sul percorso, non globale.
  assert.ok(!deny.includes('mcp__spia'), 'il local scope di un altro progetto non riguarda questa cella');
});

test('UN SOLO token con l\'uguale, e niente lo segue che possa essere inghiottito', (t) => {
  // Stessa trappola di `--mcp-config`: nella forma spaziata il client consuma i
  // posizionali successivi, e il prompt della cella e' accodato in fondo.
  const w = mondo(t);
  const { args } = settingsDi(w, { mcp: ['nexuscrew'], prompt: 'sei un auditor' });
  assert.ok(!args.includes('--settings'), `mai passato spaziato: ${JSON.stringify(args)}`);
  assert.equal(args.filter((a) => a.startsWith('--settings=')).length, 1);
  assert.ok(args.includes('sei un auditor'), 'il prompt sopravvive come proprio argomento');
});

test('il campo e\' validato come un identificatore, non come testo libero', () => {
  // Il nome finisce in un prefisso di tool passato al client: uno schema chiuso
  // qui evita di scoprire il problema dal comportamento.
  const defs = (mcp) => ({
    schemaVersion: 1,
    engines: [{ id: 'e1', label: 'E', rc: true, command: '/bin/sh', args: [], env: {}, promptMode: 'flag', promptFlag: '--sp' }],
    cells: [{ id: 'Dev', cwd: path.join(os.homedir(), 'Dev'), engine: 'e1', ...(mcp === undefined ? {} : { mcp }) }],
  });
  assert.ok(parseDefinitions(defs(['nexuscrew'])));
  assert.deepEqual(parseDefinitions(defs([])).cells[0].mcp, []);
  assert.ok(!Object.hasOwn(parseDefinitions(defs(undefined)).cells[0], 'mcp'), 'assente resta assente');
  for (const cattivo of [['a', 'a'], [1], ['../x'], ['con spazio'], ['mcp__gia-prefissato!'], 'nexuscrew', {}]) {
    assert.equal(parseDefinitions(defs(cattivo)), null, `deve rifiutare ${JSON.stringify(cattivo)}`);
  }
});
