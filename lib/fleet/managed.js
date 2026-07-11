'use strict';
// Profili engine gestiti da NexusCrew. La configurazione descrive client e
// provider; command/argv/env effettivi vengono composti qui, senza shell e senza
// salvare segreti in fleet.json. I profili custom v1 restano supportati.
const fs = require('node:fs');
const path = require('node:path');

const OLLAMA_CLOUD_MODELS = Object.freeze([
  'glm-5.2', 'kimi-k2.7-code', 'deepseek-v4-pro', 'minimax-m3',
  'qwen3.5:397b', 'deepseek-v4-flash', 'mistral-large-3:675b', 'gemma4:31b',
]);
const OLLAMA_CONTEXT = Object.freeze({
  'glm-5.2': 1000000,
  'kimi-k2.7-code': 262144,
  'deepseek-v4-pro': 524288,
  'minimax-m3': 524288,
  'qwen3.5:397b': 262144,
  'deepseek-v4-flash': 1048576,
  'mistral-large-3:675b': 262144,
  'gemma4:31b': 262144,
});

const CATALOG = Object.freeze([
  { id: 'claude.native', client: 'claude', provider: 'native', label: 'Claude · Native', auth: 'login', endpoint: 'Anthropic account', rc: true, default: true },
  { id: 'codex-vl.native', client: 'codex-vl', provider: 'native', label: 'Codex-VL · Native', auth: 'login', endpoint: 'OpenAI account', rc: false, default: true },
  { id: 'claude.ollama-cloud', client: 'claude', provider: 'ollama-cloud', label: 'Claude · Ollama Cloud Direct', auth: 'OLLAMA_API_KEY', endpoint: 'https://ollama.com', model: 'glm-5.2', models: OLLAMA_CLOUD_MODELS, rc: false, default: false },
  { id: 'codex-vl.ollama-cloud', client: 'codex-vl', provider: 'ollama-cloud', label: 'Codex-VL · Ollama Cloud Direct', auth: 'OLLAMA_API_KEY', endpoint: 'https://ollama.com/v1', model: 'glm-5.2', models: OLLAMA_CLOUD_MODELS, rc: false, default: false },
  { id: 'claude.zai-a', client: 'claude', provider: 'zai-a', label: 'Claude · Z.AI A', auth: 'ZAI_API_KEY_A', endpoint: 'https://api.z.ai/api/anthropic', model: 'glm-5.2[1m]', models: ['glm-5.2[1m]'], rc: false, default: false },
  { id: 'claude.zai-p', client: 'claude', provider: 'zai-p', label: 'Claude · Z.AI P', auth: 'ZAI_API_KEY_P', endpoint: 'https://api.z.ai/api/anthropic', model: 'glm-5.2[1m]', models: ['glm-5.2[1m]'], rc: false, default: false },
]);

const byPair = (client, provider) => CATALOG.find((p) => p.client === client && p.provider === provider) || null;

function normalizeManagedSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((k) => !['client', 'provider', 'model'].includes(k))) return null;
  const profile = byPair(value.client, value.provider);
  if (!profile) return null;
  const model = value.model === undefined ? (profile.model || '') : value.model;
  if (typeof model !== 'string' || model.length > 128) return null;
  return { client: profile.client, provider: profile.provider, model };
}

function defaultDefinitions() {
  return {
    schemaVersion: 1,
    engines: CATALOG.filter((p) => p.default).map((p) => ({
      id: p.id, label: p.label, rc: p.rc,
      managed: { client: p.client, provider: p.provider, model: p.model || '' },
    })),
    cells: [],
  };
}

function parseEnvFile(file) {
  const out = {};
  let raw;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) return out;
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function binaryCandidates(client, home) {
  const prefix = process.env.PREFIX || '';
  if (client === 'claude') return [path.join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude', prefix && path.join(prefix, 'bin', 'claude')].filter(Boolean);
  return [path.join(home, '.local', 'bin', 'codex-vl'), '/usr/local/bin/codex-vl', '/opt/homebrew/bin/codex-vl', prefix && path.join(prefix, 'bin', 'codex-vl')].filter(Boolean);
}

function findBinary(client, home) {
  for (const candidate of binaryCandidates(client, home)) {
    try {
      const real = fs.realpathSync(candidate);
      const st = fs.lstatSync(real);
      if (!st.isFile() || !(st.mode & 0o100) || (st.mode & 0o002)) continue;
      if (typeof process.getuid === 'function' && st.uid !== process.getuid() && st.uid !== 0) continue;
      return real;
    } catch (_) { /* next */ }
  }
  return null;
}

function secretsPath(cfg, home) {
  return cfg.providerSecretsPath || process.env.NEXUSCREW_PROVIDER_SECRETS
    || path.join(home, '.nexuscrew', 'providers.env');
}

let ollamaCache = { at: 0, models: [] };
async function discoverOllamaModels(opts = {}) {
  const now = Date.now();
  const ttl = opts.ttlMs === undefined ? 30000 : opts.ttlMs;
  if (!opts.noCache && ollamaCache.models.length && now - ollamaCache.at < ttl) return [...ollamaCache.models];
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return [...OLLAMA_CLOUD_MODELS];
  try {
    const home = opts.home || require('node:os').homedir();
    const apiKey = opts.apiKey || parseEnvFile(secretsPath(opts, home)).OLLAMA_API_KEY;
    if (!apiKey) throw new Error('OLLAMA_API_KEY mancante');
    const response = await fetchImpl('https://ollama.com/api/tags', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const available = new Set();
    for (const item of Array.isArray(body.models) ? body.models : []) {
      const name = typeof item?.name === 'string' ? item.name : '';
      if (!/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(name) || name.length > 128) continue;
      available.add(name);
    }
    // La API diretta espone molti modelli, inclusi modelli in deprecazione. La UI
    // mantiene la shortlist TOP curata, ma solo se ancora realmente disponibile.
    const models = OLLAMA_CLOUD_MODELS.filter((name) => available.has(name));
    if (!models.length) throw new Error('nessun modello cloud');
    ollamaCache = { at: now, models };
    return [...models];
  } catch (_) {
    ollamaCache = { at: now, models: [...OLLAMA_CLOUD_MODELS] };
    return [...OLLAMA_CLOUD_MODELS];
  }
}

function describeManaged(spec, cfg = {}) {
  const normalized = normalizeManagedSpec(spec);
  if (!normalized) return { configured: false, reason: 'profilo managed non valido' };
  const home = cfg.home || require('node:os').homedir();
  const profile = byPair(normalized.client, normalized.provider);
  const binary = findBinary(normalized.client, home);
  const secretFile = secretsPath(cfg, home);
  const secrets = profile.auth === 'login' || profile.auth === 'none' ? {} : parseEnvFile(secretFile);
  const authConfigured = profile.auth === 'login' || profile.auth === 'none' || !!secrets[profile.auth];
  const configured = !!binary && authConfigured;
  return {
    client: profile.client, provider: profile.provider, model: normalized.model,
    endpoint: profile.endpoint, auth: profile.auth, authConfigured, configured,
    models: [...(profile.models || [])], defaultModel: profile.model || '',
    binary: binary || '',
    reason: !binary ? `client ${profile.client} non trovato` : (!authConfigured ? `credenziale ${profile.auth} mancante` : 'ready'),
  };
}

function resolveManagedEngine(engine, cell, cfg = {}) {
  const info = describeManaged(engine.managed, cfg);
  if (!info.configured) return { ok: false, reason: info.reason, info };
  const home = cfg.home || require('node:os').homedir();
  const env = {};
  const args = [];
  const model = (cell && cell.model) || info.model;
  if (info.client === 'claude') {
    args.push('--dangerously-skip-permissions');
    if (info.provider === 'native') {
      if (engine.rc !== false) args.push('--remote-control', `Cloud_${cell.id}`);
    } else if (info.provider === 'ollama-cloud') {
      const secrets = parseEnvFile(secretsPath(cfg, home));
      Object.assign(env, {
        ANTHROPIC_BASE_URL: 'https://ollama.com', ANTHROPIC_AUTH_TOKEN: secrets.OLLAMA_API_KEY,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model, API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(OLLAMA_CONTEXT[model] || 200000),
      });
    } else {
      const profile = byPair(info.client, info.provider);
      const secrets = parseEnvFile(secretsPath(cfg, home));
      Object.assign(env, {
        ANTHROPIC_BASE_URL: profile.endpoint, ANTHROPIC_AUTH_TOKEN: secrets[profile.auth],
        ANTHROPIC_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model,
        API_TIMEOUT_MS: '3000000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      });
    }
    if (model) args.push('--model', model);
  } else {
    args.push('--dangerously-bypass-approvals-and-sandbox');
    if (info.provider === 'ollama-cloud') {
      const secrets = parseEnvFile(secretsPath(cfg, home));
      env.OPENAI_API_KEY = secrets.OLLAMA_API_KEY;
      if (model) args.push('-m', model);
      const localCatalog = path.join(home, '.codex', 'ollama_cloud_model_catalog.json');
      args.push(
        '-c', 'model_provider="ollama_cloud"',
        '-c', 'model_providers.ollama_cloud.name="Ollama Cloud"',
        '-c', 'model_providers.ollama_cloud.base_url="https://ollama.com/v1"',
        '-c', 'model_providers.ollama_cloud.wire_api="responses"',
        '-c', 'model_providers.ollama_cloud.stream_idle_timeout_ms=600000',
        '-c', `model_context_window=${OLLAMA_CONTEXT[model] || 200000}`,
      );
      // Codex carica il catalogo solo all'avvio. Il file e' locale e opzionale:
      // sui device che non lo hanno resta valido il fallback context-window sopra.
      if (fs.existsSync(localCatalog)) args.push('-c', `model_catalog_json="${localCatalog}"`);
    }
  }
  // Entrambi i client accettano il bootstrap come argomento posizionale. Questo
  // evita di digitare nella TUI prima che sia pronta; argv e' diretto, mai shell.
  if (cell && cell.prompt) args.push(cell.prompt);
  return { ok: true, info, engine: { ...engine, command: info.binary, args, env, promptMode: 'managed-argv' } };
}

module.exports = {
  CATALOG, OLLAMA_CLOUD_MODELS, OLLAMA_CONTEXT, normalizeManagedSpec, defaultDefinitions, describeManaged,
  discoverOllamaModels,
  resolveManagedEngine, parseEnvFile, findBinary,
};
