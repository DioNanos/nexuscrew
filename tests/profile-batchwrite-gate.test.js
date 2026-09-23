'use strict';
// tests/profile-batchwrite-gate.test.js — gate D-343: il profilo per cella
// supera la write REALE del client (config/batchWrite, il percorso della TUI
// che salva /model) su CODEX_HOME isolato, mai ~/.codex.
//
// Nota di metodo: `codex app-server` rifiuta -p (l'opzione vale solo per i
// comandi runtime e `codex mcp`; la TUI usa il client app-server IN-PROCESS
// col proprio argv). Il documento del profilo generato viene quindi esercitato
// come layer utente ATTIVO: apply_edits lo valida con la STESSA funzione e nel
// STESSO ordine del caso -p (get_active_user_layer -> validate_config ->
// mcp_types). Il controllo negativo fissa la discriminante: la forma vecchia
// (enabled=false senza trasporto) deve riprodurre l'errore di produzione
// «invalid transport in mcp_servers.X» (code -32600, configValidationError).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const toml = require('smol-toml');
const { writeCellCodexProfile } = require('../lib/fleet/managed.js');

const BIN = process.env.NC_D343_CODEX_BIN || 'codex-vl';
const MODEL_SCRITTO = 'gpt-5.1-codex';

function binarioOk() {
  try {
    return spawnSync(BIN, ['--version'], { timeout: 20000, encoding: 'utf8' }).status === 0;
  } catch (_) {
    return false;
  }
}

// Stato di un server nell'output di `codex -p <profilo> mcp list` (righe
// «nome command args env cwd <enabled|disabled> auth»). Con un profilo
// inesistente la riga mostra `enabled`: l'asserzione su questo output
// discrimina davvero il profilo selezionato, non solo l'exit code.
function statoServerDaMcpList(output, nome) {
  for (const riga of String(output).split('\n')) {
    const t = riga.trim().split(/\s+/);
    if (t[0] === nome) {
      const stato = t.find((x) => x === 'enabled' || x === 'disabled');
      if (stato) return stato;
    }
  }
  return null;
}

// RPC reale contro app-server: initialize, poi config/batchWrite del model
// (stesso edit che la TUI invia da /model: keyPath model, mergeStrategy
// replace, reloadUserConfig).
function batchWriteRpc(codexHome) {
  return new Promise((resolve) => {
    const child = spawn(BIN, ['app-server'], { env: { ...process.env, CODEX_HOME: codexHome } });
    let buf = '';
    const stderr = [];
    const risposta = new Map();
    child.stdout.on('data', (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const riga = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!riga) continue;
        try {
          const msg = JSON.parse(riga);
          if (msg && msg.id !== undefined) risposta.set(msg.id, msg);
        } catch (_) { /* non-JSON: ignora */ }
      }
    });
    child.stderr.on('data', (d) => stderr.push(String(d)));
    const scrivi = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    let secondoInviato = false;
    const poll = setInterval(() => {
      if (risposta.has(1) && !secondoInviato) {
        secondoInviato = true;
        scrivi({
          jsonrpc: '2.0', id: 2, method: 'config/batchWrite',
          params: { edits: [{ keyPath: 'model', value: MODEL_SCRITTO, mergeStrategy: 'replace' }], reloadUserConfig: true },
        });
      }
      if (risposta.has(2)) {
        clearInterval(poll);
        child.kill('SIGTERM');
        resolve({ risposta: risposta.get(2), stderr: stderr.join('') });
      }
    }, 40);
    scrivi({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'nexuscrew-gate-d343', version: '0.0.0' } } });
    setTimeout(() => {
      clearInterval(poll);
      child.kill('SIGKILL');
      resolve({ risposta: null, stderr: stderr.join('') });
    }, 25000);
  });
}

const SCENARI = {
  'spento-stdio': {
    config: ['model = "gpt-5"', '', '[mcp_servers.nexuscrew]', 'command = "nexuscrew"', 'args = ["mcp", "serve"]', 'env = { MCP_MODE = "cella" }', ''].join('\n'),
    declared: { mcp: [] },
  },
  'spento-http': {
    config: ['model = "gpt-5"', '', '[mcp_servers.web]', 'url = "http://127.0.0.1:3939/mcp"', 'bearer_token_env_var = "WEB_TOKEN"', ''].join('\n'),
    declared: { mcp: [] },
  },
  'on-demand': {
    config: ['model = "gpt-5"', '', '[mcp_servers.nexuscrew]', 'command = "nexuscrew"', '', '[mcp_servers.webfetch]', 'command = "webfetch"', ''].join('\n'),
    declared: { mcp: ['nexuscrew', 'webfetch'], ondemand: ['webfetch'] },
  },
  'misto': {
    config: [
      'model = "gpt-5"',
      '',
      '[mcp_servers.nexuscrew]',
      'command = "nexuscrew"',
      '',
      '[mcp_servers.web]',
      'url = "http://127.0.0.1:3939/mcp"',
      '',
      '[[skills.config]]',
      'name = "fleet"',
      'enabled = true',
      '',
      '[[skills.config]]',
      'name = "cellforge"',
      'enabled = true',
      '',
    ].join('\n'),
    declared: { mcp: [], skills: ['fleet'] },
  },
  'nome-quotato': {
    config: ['model = "gpt-5"', '', '[mcp_servers."srv.quote.test"]', 'command = "/bin/echo"', ''].join('\n'),
    declared: { mcp: [] },
  },
};

test('d343 gate: la forma vecchia (enabled=false senza trasporto) riproduce l\'errore di produzione', { skip: !binarioOk() && 'binario codex-vl non disponibile' }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d343-negctrl-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const appHome = path.join(home, 'app');
  fs.mkdirSync(appHome);
  const rotto = ['model = "gpt-5"', '', '[mcp_servers.crew]', 'enabled = false', ''].join('\n');
  fs.writeFileSync(path.join(appHome, 'config.toml'), rotto, { mode: 0o600 });
  const esito = await batchWriteRpc(appHome);
  assert.ok(esito.risposta, `app-server non ha risposto: ${esito.stderr.slice(0, 300)}`);
  assert.ok(esito.risposta.error, `atteso errore di validazione, arrivato: ${JSON.stringify(esito.risposta).slice(0, 300)}`);
  const testo = JSON.stringify(esito.risposta);
  assert.match(testo, /invalid transport/, 'errore di produzione mancante');
  assert.match(testo, /mcp_servers\.crew/, 'il path del server nell\'errore e mancante');
});

for (const [nome, spec] of Object.entries(SCENARI)) {
  test(`d343 gate: batchWrite reale accetta il profilo generato (${nome})`, { skip: !binarioOk() && 'binario codex-vl non disponibile' }, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `nc-d343-gate-${nome}-`));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    // Il profilo lo genera il generatore VERO con le capability dello scenario.
    fs.writeFileSync(path.join(home, 'config.toml'), spec.config, { mode: 0o600 });
    writeCellCodexProfile('T', spec.declared, home);
    const profilo = fs.readFileSync(path.join(home, 'nexuscrew-T.config.toml'), 'utf8');
    // batchWrite reale: il documento del profilo come layer utente attivo.
    const appHome = path.join(home, 'app');
    fs.mkdirSync(appHome);
    fs.writeFileSync(path.join(appHome, 'config.toml'), profilo, { mode: 0o600 });
    const esito = await batchWriteRpc(appHome);
    assert.ok(esito.risposta, `app-server non ha risposto: ${esito.stderr.slice(0, 300)}`);
    assert.equal(esito.risposta.error, undefined, `batchWrite rifiutato: ${JSON.stringify(esito.risposta).slice(0, 400)}`);
    // Verifica del file scritto: il model arriva nel layer e le tabelle MCP
    // restano intatte (la write tocca solo la chiave richiesta).
    const doc = toml.parse(fs.readFileSync(path.join(appHome, 'config.toml'), 'utf8'));
    assert.equal(doc.model, MODEL_SCRITTO, 'la write non e arrivata sul file');
    assert.deepEqual(doc.mcp_servers, toml.parse(profilo).mcp_servers, 'le tabelle MCP sono mutate durante la write');
    if (nome === 'misto') {
      // La selezione -p carica il profilo in merge nel client vero E riduce:
      // gli spenti risultano disabled, non e sufficiente l'exit 0 (che viene
      // anche con un profilo inesistente).
      const lista = spawnSync(BIN, ['-p', 'nexuscrew-T', 'mcp', 'list'],
        { env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 60000 });
      assert.equal(lista.status, 0, `mcp list con -p fallito: ${(lista.stderr || '').slice(0, 300)}`);
      for (const spento of Object.keys(toml.parse(profilo).mcp_servers)) {
        assert.equal(statoServerDaMcpList(lista.stdout, spento), 'disabled',
          `${spento} dovrebbe risultare disabled col profilo giusto`);
      }
      // Discriminante: con un profilo INESISTENTE nessuna riduzione — la
      // stessa asserzione qui sopra fallirebbe.
      const senza = spawnSync(BIN, ['-p', 'nexuscrew-INESISTENTE', 'mcp', 'list'],
        { env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 60000 });
      assert.equal(senza.status, 0);
      for (const nome2 of Object.keys(toml.parse(profilo).mcp_servers)) {
        assert.equal(statoServerDaMcpList(senza.stdout, nome2), 'enabled',
          `${nome2} col profilo inesistente resta enabled: la riduzione viene dal profilo`);
      }
    }
  });
}
