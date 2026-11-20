'use strict';
// 0.9.83 strato S7 — la finestra di auto-compattazione passata a Claude Code
// non può superare 1.000.000: sopra quel valore Claude Code avverte a ogni
// avvio («too large») e usa comunque il massimo. Si limita SOLO il valore
// passato a Claude Code; le finestre piccole NON si alzano (una finestra di
// compattazione più grande del contesto reale farebbe sforare il modello) e
// non esiste alcun minimo né ripiego.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveManagedEngine, tettoFinestraCompattazione, OLLAMA_CONTEXT,
} = require('../lib/fleet/managed.js');

function fakeClient(home, name) {
  const p = path.join(home, '.local', 'bin', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.160.0" ;; --help) echo "Usage: codex --no-daemon" ;; esac\n', { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

test('S7 unit: il tetto vale solo sopra 1.000.000 e solo su interi positivi', () => {
  assert.equal(tettoFinestraCompattazione(1048576), 1000000);
  assert.equal(tettoFinestraCompattazione('1048576'), '1000000');
  assert.equal(tettoFinestraCompattazione(2000000), 1000000);
  // invariati: 1M esatto, finestre piccole, e qualunque valore non intero/positivo
  assert.equal(tettoFinestraCompattazione(1000000), 1000000);
  assert.equal(tettoFinestraCompattazione(262144), 262144);
  assert.equal(tettoFinestraCompattazione('262144'), '262144');
  assert.equal(tettoFinestraCompattazione(65536), 65536);
  assert.equal(tettoFinestraCompattazione('65536'), '65536');
  assert.equal(tettoFinestraCompattazione(0), 0);
  assert.equal(tettoFinestraCompattazione(-5), -5);
  assert.equal(tettoFinestraCompattazione('abc'), 'abc');
  assert.equal(tettoFinestraCompattazione('1e6'), '1e6');
  assert.equal(tettoFinestraCompattazione(undefined), undefined);
  assert.equal(tettoFinestraCompattazione(null), null);
});

test('S7: ramo ollama/zai — finestra 1.048.576 -> AUTO_COMPACT 1000000, MAX_CONTEXT invariato', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s7-'));
  try {
    fakeClient(home, 'claude');
    const secrets = path.join(home, 'providers.env');
    fs.writeFileSync(secrets, 'OLLAMA_API_KEY=ollama-secret\n', { mode: 0o600 });
    const r = resolveManagedEngine(
      { id: 'claude.ollama-cloud', label: 'Ollama', managed: { client: 'claude', provider: 'ollama-cloud', model: 'deepseek-v4-pro' } },
      { id: 'CellaProva' },
      { home, providerSecretsPath: secrets, env: {} },
    );
    assert.equal(r.ok, true, r.reason);
    assert.equal(OLLAMA_CONTEXT['deepseek-v4-pro'], 1048576, 'presupposto: la finestra dichiarata è 1.048.576');
    assert.equal(r.engine.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000');
    assert.equal(r.engine.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1048576', 'MAX_CONTEXT non cambia');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('S7: ramo ollama/zai — finestra 262.144 e piccola restano invariate', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s7-'));
  try {
    fakeClient(home, 'claude');
    const secrets = path.join(home, 'providers.env');
    fs.writeFileSync(secrets, 'OLLAMA_API_KEY=ollama-secret\n', { mode: 0o600 });
    for (const [model, atteso] of [['kimi-k2.7-code', '262144'], ['minimax-m3', '524288']]) {
      const r = resolveManagedEngine(
        { id: 'claude.ollama-cloud', label: 'Ollama', managed: { client: 'claude', provider: 'ollama-cloud', model } },
        { id: 'CellaProva' },
        { home, providerSecretsPath: secrets, env: {} },
      );
      assert.equal(r.ok, true, `${model}: ${r.reason}`);
      assert.equal(r.engine.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, atteso, `${model}: nessun minimo, nessun rialzo`);
      assert.equal(r.engine.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, atteso, `${model}: MAX_CONTEXT invariato`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('S7: finestra assente (id fuori tabella, provider non zai) -> valore di oggi, senza tetto inventato', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s7-'));
  try {
    fakeClient(home, 'claude');
    const secrets = path.join(home, 'providers.env');
    fs.writeFileSync(secrets, 'OLLAMA_API_KEY=ollama-secret\n', { mode: 0o600 });
    const r = resolveManagedEngine(
      { id: 'claude.ollama-cloud', label: 'Ollama', managed: { client: 'claude', provider: 'ollama-cloud', model: 'modello-fuori-tabella' } },
      { id: 'CellaProva' },
      { home, providerSecretsPath: secrets, env: {} },
    );
    assert.equal(r.ok, true, r.reason);
    // Comportamento di oggi: fallback dichiarato, invariato dal tetto.
    assert.equal(r.engine.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000');
    assert.equal(r.engine.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '200000');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
