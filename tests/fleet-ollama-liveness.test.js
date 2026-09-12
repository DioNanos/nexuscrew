'use strict';

// tests/fleet-ollama-liveness.test.js — freschezza del catalogo Ollama Cloud.
//
// I modelli cloud NON sono un asset: scadono (l'11/07 una voce della nostra
// lista locale e' morta lo stesso giorno; la beta `deepseek-v4.1-flash-
// expires-on-0910` e' scaduta il 10/09). Il check periodico VERO richiede
// chiamate di rete ed e' una voce separata: qui c'e' solo la guardia a
// fixture, SENZA rete. La lista ufficiale sotto e' il campione MISURATO da
// campione ufficiale misurato il 2026-09-12 (22 id vivi / 8 forme 404, ogni id provato con
// max_tokens 4-8 su /v1/chat/completions).
//
// Cosa fa il test: ogni id in OLLAMA_CLOUD_MODELS deve stare nella lista
// ufficiale del campione. Se upstream toglie un id (o lo rinomina), il test
// va ROSSO nominandolo come «da verificare» — la lista non puo' invecchiare
// in silenzio. Quando succede: si ri-misura (curl con OLLAMA_API_KEY), si
// aggiorna il catalogo e si aggiorna QUESTA fixture con la nuova data.

const { test } = require('node:test');
const assert = require('node:assert');
const { OLLAMA_CLOUD_MODELS } = require('../lib/fleet/managed.js');

// MEASURED 2026-09-12 — official live list (official measured sample, ~1 min, 33 ids probed).
const UFFICIALE_2026_09_12 = Object.freeze(new Set([
  'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1',
  'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-flash:0731',
  'deepseek-v4-pro', 'deepseek-v4-pro:0813',
  'minimax-m2.7', 'minimax-m3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3',
  'nemotron-3-ultra', 'nemotron-3-super', 'nemotron-3-nano:30b',
  'gemma4', 'gemma4:31b', 'qwen3.5', 'qwen3.5:397b',
  'mistral-large-3:675b', 'gpt-oss:120b', 'gpt-oss:20b',
]));

// MISURATO 2026-09-12 — forme 404 sulla nostra API e community cloud: non
// devono mai comparire nel catalogo (un id morto produce un engine che
// fallisce in silenzio all'avvio).
const MORTI_2026_09_12 = Object.freeze(new Set([
  'nemotron-3-super:120b', 'nemotron-3-nano:4b', 'gemma4:12b', 'gemma4:e4b',
  'mistral-large-3', 'qwen3.5:27b', 'qwen3.5:35b', 'qwen3.5:122b',
]));

test('ogni id in OLLAMA_CLOUD_MODELS e\' vivo nel campione ufficiale (fixture senza rete)', () => {
  const daVerificare = OLLAMA_CLOUD_MODELS.filter((id) => !UFFICIALE_2026_09_12.has(id));
  assert.deepEqual(
    daVerificare, [],
    'id DA VERIFICARE (non nel campione ufficiale 2026-09-12): re-misura con OLLAMA_API_KEY, aggiorna il catalogo e la fixture con la nuova data',
  );
});

test('nessuna forma 404 o community entra nel catalogo', () => {
  const morti = OLLAMA_CLOUD_MODELS.filter((id) => MORTI_2026_09_12.has(id));
  assert.deepEqual(morti, [], 'forme 404 nel catalogo: un id morto fallisce in silenzio al launch');
  const community = OLLAMA_CLOUD_MODELS.filter((id) => id.includes('/'));
  assert.deepEqual(community, [], 'id community (`utente/nome`): 404 sulla nostra API, non servono il percorso token');
});
