'use strict';
// tests/fleet-private-profile-mcp.test.js — una cella isolata per credenziale
// non deve perdere gli strumenti.
//
// IL REPERTO. NexusCrew crea una directory di configurazione privata per i
// client Claude su certi profili di credenziale (`CLAUDE_CONFIG_DIR`), e fa
// bene: separa le chiavi. Ma Claude tiene l'elenco MCP nello STESSO file, e
// nei profili privati quell'elenco e' vuoto: misurato 0 contro gli 8 della
// configurazione principale. Una cella li' gira senza memoria, senza
// `nc_notify`, senza `webfetch` — e dal di fuori si vede solo come «quella
// cella non usa i tool».
//
// COSA PROVA QUESTO TEST E COSA NO. Che il flag `--mcp-config` produca davvero
// gli strumenti e' stato verificato a parte, su una sessione Claude reale: con
// `--strict-mcp-config` su un file con un solo server la sessione vedeva solo
// quei tool, e puntandolo alla configurazione principale li vedeva tutti e
// otto. Qui si prova l'altra meta': che il lancio componga l'argv giusto, nei
// casi giusti, e che un file assente non impedisca alla cella di partire.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveManagedEngine } = require('../lib/fleet/managed.js');

function mondo(t, { claudeJson } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-privmcp-'));
  // Il resolver cerca il binario del client sotto la home: senza, l'engine
  // non risulta configurato e non si arriva mai all'argv.
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(path.join(home, '.local', 'bin', 'claude'), 0o755);
  if (claudeJson !== undefined) {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(claudeJson), { mode: 0o600 });
  }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const CON_MCP = { mcpServers: { nexuscrew: { command: 'nexuscrew', args: ['mcp'] } } };

const engineAlibaba = () => ({
  id: 'claude.alibaba-token-plan',
  label: 'Alibaba',
  managed: { client: 'claude', provider: 'alibaba-token-plan', model: 'qwen3.8-max', permissionPolicy: 'unsafe' },
});
const engineKimi = () => ({
  id: 'claude.kimi-code',
  label: 'Kimi',
  managed: { client: 'claude', provider: 'kimi-code', model: 'k3[1m]', permissionPolicy: 'unsafe' },
});

function risolvi(engine, home, env) {
  return resolveManagedEngine(engine, { id: 'Aud' }, { home, platform: 'linux', env });
}

// Le credenziali dei due profili arrivano dall'ambiente: senza, l'engine non e'
// configurato e non si arriva all'argv.
const ENV_ALIBABA = { ALIBABA_CODE_API_KEY: 'chiave-finta-per-il-test' };
const ENV_KIMI = { KIMI_API_KEY: 'chiave-finta-per-il-test', MOONSHOT_API_KEY: 'chiave-finta-per-il-test' };

test('un profilo privato riceve la sorgente MCP della configurazione principale', (t) => {
  const home = mondo(t, { claudeJson: CON_MCP });
  const out = risolvi(engineAlibaba(), home, ENV_ALIBABA);
  assert.equal(out.ok, true, out.reason);
  const token = out.engine.args.find((a) => a.startsWith('--mcp-config='));
  assert.ok(token, `atteso --mcp-config= in ${JSON.stringify(out.engine.args)}`);
  assert.equal(token, `--mcp-config=${path.join(home, '.claude.json')}`);
  // Si PUNTA al file, non se ne copia il contenuto: la directory privata non
  // deve diventare un secondo posto dove vivono le credenziali degli MCP.
  const privata = path.join(home, '.nexuscrew', 'claude-profiles', 'alibaba-token-plan', '.claude.json');
  const scritta = fs.existsSync(privata) ? JSON.parse(fs.readFileSync(privata, 'utf8')) : {};
  assert.ok(!scritta.mcpServers, 'la configurazione privata non deve contenere definizioni MCP copiate');
});

test('UN SOLO token: nella forma spaziata il flag si mangia il prompt della cella', (t) => {
  // Il caso vero, non un dettaglio di stile. `--mcp-config` e' variadico:
  // nella forma spaziata consuma ogni argomento successivo che non inizi per
  // `-`, e il prompt della cella e' accodato come POSIZIONALE in fondo
  // all'argv. Misurato sul client installato:
  //   --mcp-config <file> ciao-prompt -> «MCP config file not found: .../ciao-prompt»
  //   --mcp-config=<file> ciao-prompt -> un solo file letto
  const home = mondo(t, { claudeJson: CON_MCP });
  const out = resolveManagedEngine(
    engineAlibaba(), { id: 'Aud', prompt: 'sei un auditor' },
    { home, platform: 'linux', env: ENV_ALIBABA },
  );
  assert.equal(out.ok, true, out.reason);
  // Nessun token nudo: se qualcuno «per leggibilita'» lo rispezza in due,
  // questo test cade prima che cada una cella.
  assert.ok(!out.engine.args.includes('--mcp-config'),
    `il flag non va mai passato spaziato: ${JSON.stringify(out.engine.args)}`);
  assert.equal(out.engine.args.filter((a) => a.startsWith('--mcp-config=')).length, 1);
  // E il prompt sopravvive come proprio argomento.
  assert.ok(out.engine.args.includes('sei un auditor'), JSON.stringify(out.engine.args));
});

test('vale anche per il profilo Kimi', (t) => {
  const home = mondo(t, { claudeJson: CON_MCP });
  const out = risolvi(engineKimi(), home, ENV_KIMI);
  if (!out.ok) { t.skip(`profilo kimi non configurabile qui: ${out.reason}`); return; }
  assert.ok(out.engine.args.some((a) => a.startsWith('--mcp-config=')), JSON.stringify(out.engine.args));
});

test('senza configurazione principale la cella PARTE lo stesso, solo senza strumenti', (t) => {
  // Fail-safe deliberato: un flag che punta a un file inesistente fa fallire
  // l'avvio del client. Senza strumenti si lavora peggio, senza cella no.
  const home = mondo(t);
  const out = risolvi(engineAlibaba(), home, ENV_ALIBABA);
  assert.equal(out.ok, true, out.reason);
  assert.ok(!out.engine.args.some((a) => a.startsWith('--mcp-config')));
});

test('una configurazione principale senza `mcpServers` non produce il flag', (t) => {
  const home = mondo(t, { claudeJson: { hasCompletedOnboarding: true } });
  assert.ok(!risolvi(engineAlibaba(), home, ENV_ALIBABA).engine.args.some((a) => a.startsWith('--mcp-config')));
  const vuoto = mondo(t, { claudeJson: { mcpServers: {} } });
  assert.ok(!risolvi(engineAlibaba(), vuoto, ENV_ALIBABA).engine.args.some((a) => a.startsWith('--mcp-config')));
});

test('un profilo NON isolato non riceve il flag: legge gia\' quel file da se\'', (t) => {
  // Aggiungerlo sarebbe innocuo ma falso: direbbe che serve un raccordo dove
  // non ce n'e' bisogno, e il prossimo che legge l'argv ci ragionerebbe sopra.
  const home = mondo(t, { claudeJson: CON_MCP });
  const nativo = {
    id: 'claude.native', label: 'Nativo',
    managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' },
  };
  const out = risolvi(nativo, home, {});
  assert.equal(out.ok, true, out.reason);
  assert.ok(!out.engine.args.some((a) => a.startsWith('--mcp-config')), JSON.stringify(out.engine.args));
});

test('un `.claude.json` che e\' un symlink viene ignorato', (t) => {
  // Stessa disciplina di `ensurePrivateClaudeConfig`, che i symlink li rifiuta
  // gia': non si segue un puntatore per decidere cosa dare in pasto al client.
  const home = mondo(t);
  const altrove = path.join(home, 'altrove.json');
  fs.writeFileSync(altrove, JSON.stringify(CON_MCP));
  fs.symlinkSync(altrove, path.join(home, '.claude.json'));
  assert.ok(!risolvi(engineAlibaba(), home, ENV_ALIBABA).engine.args.some((a) => a.startsWith('--mcp-config')));
});
