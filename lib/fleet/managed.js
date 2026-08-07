'use strict';
// Managed AI engine registry. Definitions contain adapter/provider metadata but
// never secret values. Commands are direct argv; no shell or chat-protocol
// compatibility fallback is allowed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { ENV_KEY_RE } = require('./env-key.js');
const { termuxRuntimePaths } = require('../runtime/env.js');
const { readCredentialStore, safePrivateDir } = require('./credentials.js');

const OLLAMA_CLOUD_MODELS = Object.freeze([
  'glm-5.2', 'kimi-k2.7-code', 'deepseek-v4-pro', 'minimax-m3',
  'qwen3.5:397b', 'deepseek-v4-flash', 'mistral-large-3:675b', 'gemma4:31b',
]);
const OLLAMA_CONTEXT = Object.freeze({
  'glm-5.2': 1000000, 'kimi-k2.7-code': 262144, 'deepseek-v4-pro': 524288,
  'minimax-m3': 524288, 'qwen3.5:397b': 262144, 'deepseek-v4-flash': 1048576,
  'mistral-large-3:675b': 262144, 'gemma4:31b': 262144,
});
// Lo stesso modello si scrive con o senza tag ('deepseek-v4-flash' e
// 'deepseek-v4-flash:0731'). Si prova prima la chiave esatta, perche' nella
// mappa ci sono nomi in cui il tag fa parte dell'identita' del modello
// ('qwen3.5:397b'), e solo dopo si ricade sul nome base. Troncare sempre al
// primo ':' romperebbe proprio quelle voci.
function ollamaContextFor(model) {
  const key = String(model || '');
  return OLLAMA_CONTEXT[key] ?? OLLAMA_CONTEXT[key.split(':')[0]];
}
// Rinomini di modello, dichiarati in UN posto solo.
//
// Un fornitore che promuove un preview a stabile cambia l'id, e con
// `strictModels` un id non piu' in catalogo NON e' un avviso: e' una cella che
// non parte. Le due celle configurate con `qwen3.8-max-preview` si sarebbero
// fermate al primo avvio dopo l'aggiornamento, senza che nulla dicesse
// perche'.
//
// L'alias risolve il nome vecchio e restituisce quello NUOVO, quindi la
// configurazione converge da sola alla prima riscrittura invece di restare
// indietro per sempre.
const MODEL_ALIASES = Object.freeze({
  'qwen3.8-max-preview': 'qwen3.8-max',
});

// Modelli dichiarati in configurazione, indicizzati per PROFILO gestito. La
// dichiarazione e' per profilo e non per fornitore: gli elenchi di Alibaba per
// Claude e per Codex differiscono davvero, e generalizzare creerebbe
// combinazioni che non esistono.
function declaredFor(extraModels, profileId, model) {
  if (!extraModels || typeof extraModels.get !== 'function') return false;
  const set = extraModels.get(profileId);
  return !!(set && typeof set.has === 'function' && set.has(model));
}

// Dalle definizioni alla mappa che il gate si aspetta. Sta qui e non nei
// chiamanti perche' ognuno di loro la ricostruirebbe a modo suo, e basta che
// uno la dimentichi perche' un modello dichiarato smetta di essere valido
// proprio nel punto che conta — l'avvio.
function extraModelsFrom(defs) {
  const map = new Map();
  for (const m of (defs && Array.isArray(defs.models) ? defs.models : [])) {
    if (!m || typeof m.engine !== 'string' || typeof m.id !== 'string') continue;
    if (!map.has(m.engine)) map.set(m.engine, new Set());
    map.get(m.engine).add(m.id);
  }
  return map;
}

function canonicalModel(model) {
  const key = String(model || '');
  return Object.hasOwn(MODEL_ALIASES, key) ? MODEL_ALIASES[key] : model;
}

const ALIBABA_TOKEN_PLAN_MODELS = Object.freeze([
  'qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-max',
  'qwen3.6-flash', 'glm-5.2', 'deepseek-v4-pro',
]);
const ALIBABA_CODEX_MODELS = Object.freeze([
  'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash',
]);
const ALIBABA_TOKEN_PLAN_CONTEXT = 983616;
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const ALIBABA_PI_MODELS = Object.freeze([
  Object.freeze({
    id: 'qwen3.8-max', name: 'qwen3.8-max', api: 'openai-responses',
    reasoning: true, thinkingLevelMap: { low: 'low', high: 'high', xhigh: 'xhigh' },
    input: ['text', 'image'], contextWindow: ALIBABA_TOKEN_PLAN_CONTEXT, maxTokens: 131072,
    cost: ZERO_COST,
  }),
  Object.freeze({
    id: 'qwen3.7-plus', name: 'qwen3.7-plus', api: 'openai-responses', reasoning: false,
    input: ['text', 'image'], contextWindow: 1000000, maxTokens: 65536, cost: ZERO_COST,
  }),
  Object.freeze({
    id: 'qwen3.7-max', name: 'qwen3.7-max', api: 'openai-responses', reasoning: false,
    input: ['text'], contextWindow: 1000000, maxTokens: 65536, cost: ZERO_COST,
  }),
  Object.freeze({
    id: 'qwen3.6-flash', name: 'qwen3.6-flash', api: 'openai-responses', reasoning: false,
    input: ['text', 'image'], contextWindow: 1000000, maxTokens: 32768, cost: ZERO_COST,
  }),
  Object.freeze({
    id: 'glm-5.2', name: 'glm-5.2', api: 'openai-completions', reasoning: false,
    input: ['text'], contextWindow: 1000000, maxTokens: 16384, cost: ZERO_COST,
    compat: { thinkingFormat: 'openai', requiresReasoningContentOnAssistantMessages: true },
  }),
  Object.freeze({
    id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', api: 'openai-completions', reasoning: false,
    input: ['text'], contextWindow: 163840, maxTokens: 32768, cost: ZERO_COST,
    compat: { thinkingFormat: 'openai', requiresReasoningContentOnAssistantMessages: true },
  }),
]);

const CUSTOM_KEYS = ['displayName', 'protocol', 'baseUrl', 'envKey', 'providerId'];
const MANAGED_KEYS = new Set(['client', 'provider', 'credentialProfile', 'model', 'permissionPolicy', 'credentialSourcePolicy', ...CUSTOM_KEYS]);
// Explicit credential source policy. Default 'auto' preserves the legacy
// resolution order (runtime -> store -> shell -> key files -> legacy) so a
// pre-WP1 fleet.json migrates no-op: no existing cell changes resolution.
const CREDENTIAL_SOURCES = Object.freeze(['environment', 'nexuscrew-store', 'auto']);
const CLIENT_LABELS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', 'codex-vl': 'Codex-VL', pi: 'Pi', agy: 'Agy', kimi: 'Kimi Code CLI', shell: 'Shell' });
const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function validBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 512 || /\s|[\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username && !parsed.password && !parsed.hash;
  } catch (_) { return false; }
}

const CATALOG = Object.freeze([
  // Claude Code
  { id: 'claude.native', client: 'claude', provider: 'native', label: 'Anthropic / Claude account', auth: 'login', endpoint: 'Anthropic account', protocol: 'anthropic_messages', rc: true, default: true, core: true },
  { id: 'claude.alibaba-token-plan', client: 'claude', provider: 'alibaba-token-plan', label: 'Alibaba Token Plan Personal', auth: 'ALIBABA_CODE_API_KEY', endpoint: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic', protocol: 'anthropic_messages', model: 'qwen3.8-max', models: ALIBABA_TOKEN_PLAN_MODELS, strictModels: true, core: true, notice: 'alibaba-token-plan' },
  { id: 'claude.openrouter', client: 'claude', provider: 'openrouter', label: 'OpenRouter', auth: 'OPENROUTER_API_KEY', endpoint: 'https://openrouter.ai/api', protocol: 'anthropic_messages', requiresModel: true, core: true, notice: 'claude-openrouter' },
  { id: 'claude.kimi-code', client: 'claude', provider: 'kimi-code', label: 'Kimi Code', auth: 'KIMI_API_KEY', endpoint: 'https://api.kimi.com/coding/', protocol: 'anthropic_messages', model: 'k3[1m]', models: ['k3', 'k3[1m]', 'kimi-for-coding', 'kimi-for-coding-highspeed'], strictModels: true, core: true, notice: 'claude-kimi-code' },
  { id: 'claude.bedrock', client: 'claude', provider: 'bedrock', label: 'Amazon Bedrock', auth: 'login', endpoint: 'AWS Bedrock', protocol: 'anthropic_messages', core: true, providerEnv: { CLAUDE_CODE_USE_BEDROCK: '1' } },
  { id: 'claude.vertex', client: 'claude', provider: 'vertex', label: 'Google Vertex AI', auth: 'login', endpoint: 'Google Vertex AI', protocol: 'anthropic_messages', core: true, providerEnv: { CLAUDE_CODE_USE_VERTEX: '1' } },
  { id: 'claude.foundry', client: 'claude', provider: 'foundry', label: 'Microsoft Foundry', auth: 'login', endpoint: 'Microsoft Foundry', protocol: 'anthropic_messages', core: true, providerEnv: { CLAUDE_CODE_USE_FOUNDRY: '1' } },
  { id: 'claude.ollama-cloud', client: 'claude', provider: 'ollama-cloud', label: 'Ollama Cloud', auth: 'OLLAMA_API_KEY', endpoint: 'https://ollama.com', protocol: 'anthropic_messages', model: 'glm-5.2', models: OLLAMA_CLOUD_MODELS, legacySecrets: true, core: true },
  { id: 'claude.ollama', client: 'claude', provider: 'ollama', label: 'Ollama local', auth: 'none', endpoint: 'http://127.0.0.1:11434', protocol: 'anthropic_messages', core: true },
  { id: 'claude.zai', client: 'claude', provider: 'zai', label: 'Z.AI', auth: 'dynamic', credentialEnv: true, defaultEnvKey: 'ZAI_API_KEY', endpoint: 'https://api.z.ai/api/anthropic', protocol: 'anthropic_messages', model: 'glm-5.2[1m]', models: ['glm-5.2[1m]'], core: true },
  // Compatibilità sola lettura/launch per configurazioni 0.8.0: mai nel catalogo UI.
  { id: 'claude.zai-a', client: 'claude', provider: 'zai', credentialProfile: 'a', label: 'Z.AI legacy profile', auth: 'ZAI_API_KEY_A', endpoint: 'https://api.z.ai/api/anthropic', protocol: 'anthropic_messages', model: 'glm-5.2[1m]', models: ['glm-5.2[1m]'], legacySecrets: true, legacyProvider: 'zai-a', legacy: true },
  { id: 'claude.zai-p', client: 'claude', provider: 'zai', credentialProfile: 'p', label: 'Z.AI legacy profile', auth: 'ZAI_API_KEY_P', endpoint: 'https://api.z.ai/api/anthropic', protocol: 'anthropic_messages', model: 'glm-5.2[1m]', models: ['glm-5.2[1m]'], legacySecrets: true, legacyProvider: 'zai-p', legacy: true },
  { id: 'claude.custom', client: 'claude', provider: 'custom', label: 'Custom Anthropic-compatible', auth: 'dynamic', protocol: 'anthropic_messages', protocols: ['anthropic_messages'], custom: true, core: true },

  // Codex family. OpenAI Responses is the only remote custom wire API.
  { id: 'codex.native', client: 'codex', provider: 'native', label: 'OpenAI / ChatGPT account', auth: 'login', endpoint: 'OpenAI account', protocol: 'openai_responses', default: true, core: true },
  { id: 'codex-vl.native', client: 'codex-vl', provider: 'native', label: 'OpenAI / ChatGPT account', auth: 'login', endpoint: 'OpenAI account', protocol: 'openai_responses', default: true, core: true },
  { id: 'codex-vl.alibaba-token-plan', client: 'codex-vl', provider: 'alibaba-token-plan', label: 'Alibaba Token Plan Personal', auth: 'ALIBABA_CODE_API_KEY', endpoint: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', protocol: 'openai_responses', model: 'qwen3.8-max', models: ALIBABA_CODEX_MODELS, strictModels: true, core: true, notice: 'alibaba-token-plan' },
  { id: 'codex.openai-api', client: 'codex', provider: 'openai-api', label: 'OpenAI API', auth: 'OPENAI_API_KEY', endpoint: 'https://api.openai.com/v1', protocol: 'openai_responses', core: true },
  { id: 'codex-vl.openai-api', client: 'codex-vl', provider: 'openai-api', label: 'OpenAI API', auth: 'OPENAI_API_KEY', endpoint: 'https://api.openai.com/v1', protocol: 'openai_responses', core: true },
  { id: 'codex-vl.openrouter', client: 'codex-vl', provider: 'openrouter', label: 'OpenRouter', auth: 'OPENROUTER_API_KEY', endpoint: 'https://openrouter.ai/api/v1', protocol: 'openai_responses', requiresModel: true, core: true, notice: 'codex-openrouter' },
  { id: 'codex.ollama', client: 'codex', provider: 'ollama', label: 'Ollama local', auth: 'none', endpoint: 'local provider', protocol: 'openai_responses', localProvider: 'ollama', core: true },
  { id: 'codex-vl.ollama', client: 'codex-vl', provider: 'ollama', label: 'Ollama local', auth: 'none', endpoint: 'local provider', protocol: 'openai_responses', localProvider: 'ollama', core: true },
  { id: 'codex.lmstudio', client: 'codex', provider: 'lmstudio', label: 'LM Studio', auth: 'none', endpoint: 'local provider', protocol: 'openai_responses', localProvider: 'lmstudio', core: true },
  { id: 'codex-vl.lmstudio', client: 'codex-vl', provider: 'lmstudio', label: 'LM Studio', auth: 'none', endpoint: 'local provider', protocol: 'openai_responses', localProvider: 'lmstudio', core: true },
  { id: 'codex.ollama-cloud', client: 'codex', provider: 'ollama-cloud', label: 'Ollama Cloud', auth: 'OLLAMA_API_KEY', endpoint: 'https://ollama.com/v1', protocol: 'openai_responses', model: 'glm-5.2', models: OLLAMA_CLOUD_MODELS, legacySecrets: true, core: true },
  { id: 'codex-vl.ollama-cloud', client: 'codex-vl', provider: 'ollama-cloud', label: 'Ollama Cloud', auth: 'OLLAMA_API_KEY', endpoint: 'https://ollama.com/v1', protocol: 'openai_responses', model: 'glm-5.2', models: OLLAMA_CLOUD_MODELS, legacySecrets: true, core: true },
  { id: 'codex.custom', client: 'codex', provider: 'custom', label: 'Custom Responses endpoint', auth: 'dynamic', protocol: 'openai_responses', protocols: ['openai_responses'], custom: true, core: true },
  { id: 'codex-vl.custom', client: 'codex-vl', provider: 'custom', label: 'Custom Responses endpoint', auth: 'dynamic', protocol: 'openai_responses', protocols: ['openai_responses'], custom: true, core: true },

  // Pi uses its real provider IDs directly. OAuth providers do not need env keys.
  { id: 'pi.native', client: 'pi', provider: 'native', label: 'Pi configured default', auth: 'login', protocol: 'pi_native', default: true, core: true },
  { id: 'pi.alibaba-token-plan', client: 'pi', provider: 'alibaba-token-plan', label: 'Alibaba Token Plan Personal', auth: 'ALIBABA_CODE_API_KEY', endpoint: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', protocol: 'openai-completions', model: 'qwen3.8-max', models: ALIBABA_TOKEN_PLAN_MODELS, strictModels: true, piProvider: 'alibaba-token-plan', piExtension: { baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', models: ALIBABA_PI_MODELS }, delegatePiAuth: false, core: true, notice: 'alibaba-token-plan' },
  // Device-local shell. Kept after the established default clients so adding
  // it does not change the preselected engine for a newly-created cell.
  { id: 'shell.local', client: 'shell', provider: 'local', label: 'Shell', auth: 'none', protocol: 'shell', default: true, core: true },
  { id: 'pi.anthropic', client: 'pi', provider: 'anthropic', label: 'Anthropic', auth: 'ANTHROPIC_API_KEY', protocol: 'pi_native', piProvider: 'anthropic', core: true },
  { id: 'pi.openai', client: 'pi', provider: 'openai', label: 'OpenAI API', auth: 'OPENAI_API_KEY', protocol: 'pi_native', piProvider: 'openai', core: true },
  { id: 'pi.openai-codex', client: 'pi', provider: 'openai-codex', label: 'OpenAI Codex OAuth', auth: 'login', protocol: 'pi_native', piProvider: 'openai-codex', core: true },
  { id: 'pi.google', client: 'pi', provider: 'google', label: 'Google Gemini', auth: 'GEMINI_API_KEY', protocol: 'pi_native', piProvider: 'google', core: true },
  { id: 'pi.openrouter', client: 'pi', provider: 'openrouter', label: 'OpenRouter', auth: 'OPENROUTER_API_KEY', protocol: 'pi_native', piProvider: 'openrouter', core: true },
  { id: 'pi.github-copilot', client: 'pi', provider: 'github-copilot', label: 'GitHub Copilot', auth: 'login', protocol: 'pi_native', piProvider: 'github-copilot', core: true },
  { id: 'pi.fireworks', client: 'pi', provider: 'fireworks', label: 'Pi · Fireworks AI', auth: 'FIREWORKS_API_KEY', protocol: 'pi_native', piProvider: 'fireworks' },
  { id: 'pi.huggingface', client: 'pi', provider: 'huggingface', label: 'Pi · Hugging Face', auth: 'HF_TOKEN', protocol: 'pi_native', piProvider: 'huggingface' },
  { id: 'pi.minimax', client: 'pi', provider: 'minimax', label: 'Pi · MiniMax', auth: 'MINIMAX_API_KEY', protocol: 'pi_native', piProvider: 'minimax' },
  { id: 'pi.deepseek', client: 'pi', provider: 'deepseek', label: 'DeepSeek', auth: 'DEEPSEEK_API_KEY', protocol: 'pi_native', piProvider: 'deepseek', core: true },
  { id: 'pi.kimi-coding', client: 'pi', provider: 'kimi-coding', label: 'Pi · Kimi For Coding', auth: 'KIMI_API_KEY', protocol: 'pi_native', piProvider: 'kimi-coding' },
  { id: 'pi.mistral', client: 'pi', provider: 'mistral', label: 'Pi · Mistral', auth: 'MISTRAL_API_KEY', protocol: 'pi_native', piProvider: 'mistral' },
  { id: 'pi.together', client: 'pi', provider: 'together', label: 'Pi · Together AI', auth: 'TOGETHER_API_KEY', protocol: 'pi_native', piProvider: 'together' },
  { id: 'pi.ollama', client: 'pi', provider: 'ollama', label: 'Ollama local', auth: 'none', protocol: 'openai-completions', piProvider: 'ollama', requiresModel: true, core: true, piExtension: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama' } },
  { id: 'pi.zai', client: 'pi', provider: 'zai', label: 'Z.AI', auth: 'ZAI_API_KEY', protocol: 'pi_native', piProvider: 'zai', core: true },
  { id: 'pi.custom', client: 'pi', provider: 'custom', label: 'Custom provider', auth: 'dynamic', protocol: 'openai-responses', protocols: ['openai-responses', 'anthropic-messages', 'openai-completions', 'google-generative-ai'], custom: true, core: true },

  // Agy: client gestito primario (Linux/macOS non-Termux). Auth delegata al
  // login locale del client (nessuno store letto/copiato). Nessun remote-control
  // NexusCrew; permission default 'standard' (unsafe aggiunge --dangerously-skip-
  // permissions, allineato agli altri client). NON e' un default seed (non va nel
  // fleet.json fresco su piattaforme non supportate): viene aggiunto solo da un
  // backfill platform-aware (builtin.js) su Linux/macOS non-Termux. Qui figura
  // (core) per la UI; describeManaged lo dichiara non configurato altrove.
  // Termux/Windows restano fuori dal primary: l'utente usa agy via shell.local.
  { id: 'agy.native', client: 'agy', provider: 'native', label: 'Agy', auth: 'login', protocol: 'agy_native', core: true },

  // Kimi Code CLI nativo (@moonshot-ai/kimi-code): client gestito con auth
  // delegata al login del CLI (device-code flow, provider in config.toml).
  // NexusCrew non legge ne' copia credenziali: nessun env provider, nessun
  // token su argv. Distinto dal provider claude.kimi-code (adattatore Claude
  // Code sull'endpoint Kimi), che resta il percorso K3 gestito via ANTHROPIC_*.
  // Non e' un default seed: backfill idempotente in builtin.js, come Agy ma
  // senza platform gate (il CLI gira ovunque giri Node; su Termux il resolver
  // applica gia' il workaround shebang needsExplicitNode).
  { id: 'kimi.native', client: 'kimi', provider: 'native', label: 'Kimi account (CLI login)', auth: 'login', protocol: 'kimi_native', core: true, notice: 'kimi-native' },
]);

function profileFor(client, provider, credentialProfile) {
  return CATALOG.find((p) => p.client === client && p.provider === provider
    && (p.credentialProfile || '') === (credentialProfile || '')) || null;
}

function normalizeManagedSpec(value, { extraModels = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((k) => !MANAGED_KEYS.has(k))) return null;
  if (!CLIENT_LABELS[value.client]) return null;
  let provider = value.provider;
  let credentialProfile = value.credentialProfile || '';
  // 0.8.0 compatibility: zai-a/zai-p were encoded as providers.
  if (value.client === 'claude' && (provider === 'zai-a' || provider === 'zai-p')) {
    credentialProfile = provider.slice(-1);
    provider = 'zai';
  }
  if (typeof provider !== 'string') return null;
  const profile = profileFor(value.client, provider, credentialProfile);
  if (!profile) return null;
  const requested = value.model === undefined ? (profile.model || '') : value.model;
  if (typeof requested !== 'string' || requested.length > 128 || /[\x00-\x1f\x7f]/.test(requested)) return null;
  // L'alias si applica PRIMA del gate: un nome legacy deve passare, e deve
  // passare diventando il nome nuovo.
  const model = canonicalModel(requested);
  if (value.client === 'shell' && model) return null;
  if (profile.requiresModel && !model) return null;
  // Il catalogo del codice e' l'elenco dei modelli NOTI, non il muro di cio' che
  // esiste: un fornitore pubblica quando vuole, e senza questa via usare un
  // modello nuovo richiederebbe una release di NexusCrew.
  //
  // Un id dichiarato nella configurazione passa perche' e' stato DICHIARATO per
  // quel profilo, non perche' il controllo e' stato tolto: un id mai visto
  // resta rifiutato, ed e' cio' che impedisce di far partire una cella con un
  // modello inesistente e scoprirlo dal fallimento.
  if (profile.strictModels && !(profile.models || []).includes(model)
    && !declaredFor(extraModels, profile.id, model)) return null;
  const permissionPolicy = value.permissionPolicy === undefined ? (profile.client === 'claude' ? 'unsafe' : 'standard') : value.permissionPolicy;
  if (permissionPolicy !== 'standard' && permissionPolicy !== 'unsafe') return null;
  if ((value.client === 'pi' || value.client === 'shell') && permissionPolicy !== 'standard') return null;
  const credentialSourcePolicy = value.credentialSourcePolicy === undefined ? 'auto' : value.credentialSourcePolicy;
  if (!CREDENTIAL_SOURCES.includes(credentialSourcePolicy)) return null;
  const out = { client: profile.client, provider: profile.provider, model, permissionPolicy };
  // 'auto' is the default and stays ABSENT from the normalized spec, so a legacy
  // fleet.json (no credentialSourcePolicy) migrates truly no-op: no added field,
  // no change in resolution. Explicit environment|nexuscrew-store are recorded.
  if (credentialSourcePolicy !== 'auto') out.credentialSourcePolicy = credentialSourcePolicy;
  if (profile.credentialProfile) out.credentialProfile = profile.credentialProfile;
  if (profile.credentialEnv) {
    const envKey = typeof value.envKey === 'string' && value.envKey.trim()
      ? value.envKey.trim()
      : profile.defaultEnvKey;
    if (!ENV_KEY_RE.test(envKey || '')) return null;
    out.envKey = envKey;
  }
  if (profile.custom) {
    const displayName = typeof value.displayName === 'string' ? value.displayName.trim() : '';
    const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
    const envKey = typeof value.envKey === 'string' ? value.envKey.trim() : '';
    const protocol = value.protocol || profile.protocol;
    const providerId = typeof value.providerId === 'string' && value.providerId ? value.providerId : 'nexuscrew-custom';
    if (!displayName || displayName.length > 64 || /[\x00-\x1f\x7f]/.test(displayName)) return null;
    if (!validBaseUrl(baseUrl)) return null;
    if (!ENV_KEY_RE.test(envKey) || !PROVIDER_ID_RE.test(providerId)) return null;
    if (!model || !(profile.protocols || [profile.protocol]).includes(protocol)) return null;
    Object.assign(out, { displayName, baseUrl, envKey, protocol, providerId });
  }
  return out;
}

function defaultDefinitions() {
  return {
    schemaVersion: 1,
    engines: CATALOG.filter((p) => p.default).map((p) => ({
      id: p.id, label: CLIENT_LABELS[p.client], rc: !!p.rc,
      managed: { client: p.client, provider: p.provider, model: p.model || '', permissionPolicy: p.client === 'claude' ? 'unsafe' : 'standard' },
    })),
    cells: [],
  };
}

function defaultShellEngine() {
  const profile = CATALOG.find((entry) => entry.id === 'shell.local');
  return {
    id: profile.id,
    label: CLIENT_LABELS.shell,
    rc: false,
    managed: { client: 'shell', provider: 'local', model: '', permissionPolicy: 'standard' },
  };
}

// Engine Agy per il backfill platform-aware (builtin.js): standard di default,
// auth delegata al login locale, niente remote-control. Non e' un default seed.
function defaultAgyEngine() {
  const profile = CATALOG.find((entry) => entry.id === 'agy.native');
  return {
    id: profile.id,
    label: CLIENT_LABELS.agy,
    rc: false,
    managed: { client: 'agy', provider: 'native', model: '', permissionPolicy: 'standard' },
  };
}

// Engine Kimi Code CLI per il backfill (builtin.js): standard di default, auth
// delegata al login nativo del CLI, niente remote-control. Non e' un default seed.
function defaultKimiEngine() {
  const profile = CATALOG.find((entry) => entry.id === 'kimi.native');
  return {
    id: profile.id,
    label: CLIENT_LABELS.kimi,
    rc: false,
    managed: { client: 'kimi', provider: 'native', model: '', permissionPolicy: 'standard' },
  };
}

function parseAssignments(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    // This is a data parser, not a shell. Reject syntax that would have a
    // different meaning if sourced instead of treating it as a credential.
    if (/\$\(|`|\x00|\r|\n|\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/.test(v)) continue;
    out[m[1]] = v;
  }
  return out;
}

function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeAllowedRoots(roots = []) {
  const out = [];
  for (const root of roots) {
    try {
      const st = fs.lstatSync(root);
      if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o022)) continue;
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) continue;
      out.push(fs.realpathSync(root));
    } catch (_) {}
  }
  return out;
}

function parseEnvFile(file, opts = {}) {
  try {
    const lst = fs.lstatSync(file);
    let target = file;
    if (lst.isSymbolicLink()) {
      const roots = safeAllowedRoots(opts.allowSymlinkRoots);
      if (!roots.length) return {};
      target = fs.realpathSync(file);
      if (!roots.some((root) => insideRoot(root, target))) return {};
    }
    const st = fs.lstatSync(target);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || st.size > 256 * 1024) return {};
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return {};
    return parseAssignments(fs.readFileSync(target, 'utf8'));
  } catch (_) { return {}; }
}

function parseProviderShellFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o022) || st.size > 256 * 1024) return {};
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return {};
    return parseAssignments(fs.readFileSync(file, 'utf8'));
  } catch (_) { return {}; }
}

function binaryCandidates(client, home) {
  const prefix = process.env.PREFIX || '';
  const bin = client;
  return [...new Set([
    path.join(home, '.local', 'bin', bin), path.join(path.dirname(process.execPath), bin),
    `/usr/local/bin/${bin}`, `/opt/homebrew/bin/${bin}`,
    prefix && path.join(prefix, 'bin', bin),
  ].filter(Boolean))];
}

function findBinary(client, home) {
  for (const candidate of binaryCandidates(client, home)) {
    try {
      const real = fs.realpathSync(candidate); const st = fs.lstatSync(real);
      if (!st.isFile() || !(st.mode & 0o100) || (st.mode & 0o002)) continue;
      if (typeof process.getuid === 'function' && st.uid !== process.getuid() && st.uid !== 0) continue;
      return real;
    } catch (_) { /* next */ }
  }
  return null;
}

// Resolve a device-local interactive shell without persisting a path in
// fleet.json. Candidates are ordered and fail closed. Symlinks are resolved
// first, then the existing command trust policy is applied to the real file.
function resolveInteractiveShell(cfg = {}) {
  const env = cfg.env || process.env;
  const platform = cfg.platform || process.platform;
  const termux = termuxRuntimePaths(env, { platform, home: cfg.home });
  const candidates = [];
  if (typeof env.SHELL === 'string' && path.isAbsolute(env.SHELL)) candidates.push(env.SHELL);
  if (termux?.prefix) {
    candidates.push(path.join(termux.prefix, 'bin', 'bash'));
    candidates.push(path.join(termux.prefix, 'bin', 'sh'));
  }
  candidates.push('/bin/bash', '/bin/sh');
  const validate = cfg.validateCommandTrust
    || ((command) => require('./definitions.js').validateCommandTrust(command));
  for (const candidate of [...new Set(candidates)]) {
    try {
      const real = fs.realpathSync(candidate);
      if (validate(real).ok) return real;
    } catch (_) { /* next candidate */ }
  }
  return null;
}

function shellLoginArgs(command) {
  return ['bash', 'zsh', 'sh', 'dash'].includes(path.basename(String(command || ''))) ? ['-l'] : [];
}

// Un command configurato deve vedere lo stesso ambiente della shell interattiva
// che l'utente ottiene lasciando vuoto il campo. Con `-lc`, zsh non carica
// `.zshrc`: alias e PATH user-locali (per esempio ~/.local/bin) spariscono e il
// command esce 127 pur essendo disponibile nel terminale normale. I quattro
// shell POSIX-like supportati vengono quindi avviati login+interactive+command;
// shell custom conservano il contratto storico -lc.
function shellConfiguredCommandArgs(command, raw) {
  return ['bash', 'zsh', 'sh', 'dash'].includes(path.basename(String(command || '')))
    ? ['-lic', raw] : ['-lc', raw];
}

// Termux reports process.platform === 'android' and deliberately has no
// /usr/bin/env.  npm CLI shims commonly resolve to a JavaScript file with
// `#!/usr/bin/env node`; direct tmux exec then fails in the kernel before the
// client starts.  Detect only that explicit Node shebang and invoke it through
// the already-running trusted Node executable.  Native and shell binaries keep
// their original direct-exec path.
//
// Detection uses both process.platform AND the runtime Termux layout (PREFIX /
// files/home) so that a Node build that reports `linux` while actually running
// under Termux (proot / custom build) still gets the shebang workaround. The
// optional `env` argument lets tests inject a synthetic environment; the public
// two-argument call form is unchanged.
function needsExplicitNode(binary, platform = process.platform, env = process.env) {
  const termux = platform === 'android' || termuxRuntimePaths(env, { platform }) !== null;
  if (!termux) return false;
  try {
    const fd = fs.openSync(binary, 'r');
    try {
      const buffer = Buffer.alloc(160);
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const first = buffer.subarray(0, length).toString('utf8').split(/\r?\n/, 1)[0];
      return /^#!\s*\/usr\/bin\/env(?:\s+-S)?\s+node(?:\s|$)/.test(first);
    } finally { fs.closeSync(fd); }
  } catch (_) { return false; }
}

function secretsPath(cfg, home) {
  return cfg.providerSecretsPath || process.env.NEXUSCREW_PROVIDER_SECRETS || path.join(home, '.nexuscrew', 'providers.env');
}

function shellProvidersPath(cfg, home) {
  return cfg.providerShellPath || process.env.NEXUSCREW_PROVIDER_SHELL
    || path.join(home, '.config', 'ai-shell', 'providers.zsh');
}

function providerKeyPaths(cfg, home) {
  const paths = [
    cfg.providerKeysPath || process.env.NEXUSCREW_PROVIDER_KEYS
      || path.join(home, '.config', 'keys', 'ai.env'),
    cfg.providerSecurePath || process.env.NEXUSCREW_PROVIDER_SECURE
      || path.join(home, '.config', 'secure', '.env'),
  ];
  return [...new Set(paths.filter((file) => typeof file === 'string' && file))];
}

function parseProviderKeyFiles(cfg, home) {
  const values = {};
  // Match providers.zsh ordering: a later secure file may intentionally
  // override the canonical ai.env value. Files remain data-only and must be
  // private regular files owned by the NexusCrew user.
  const files = providerKeyPaths(cfg, home);
  const roots = [...new Set(files.map((file) => path.dirname(path.resolve(file))))];
  for (const file of files) Object.assign(values, parseEnvFile(file, { allowSymlinkRoots: roots }));
  return values;
}

function credentialSources(cfg, home) {
  let local = {};
  try { local = readCredentialStore(cfg, home); } catch (_) { /* unsafe/corrupt store is ignored, never trusted */ }
  return {
    runtime: cfg.env || process.env,
    local,
    shell: parseProviderShellFile(shellProvidersPath(cfg, home)),
    keys: parseProviderKeyFiles(cfg, home),
    legacy: parseEnvFile(secretsPath(cfg, home)),
  };
}

function credential(profile, spec, cfg, home) {
  if (profile.auth === 'login' || profile.auth === 'none') return { envKey: profile.auth, value: '', source: profile.auth };
  const envKey = profile.auth === 'dynamic' ? spec.envKey : profile.auth;
  const policy = spec && CREDENTIAL_SOURCES.includes(spec.credentialSourcePolicy) ? spec.credentialSourcePolicy : 'auto';
  const sources = credentialSources(cfg, home);
  // The fixed shell file is already the user's environment source. Values are
  // consumed only in memory and passed to the selected child; never persisted
  // in fleet.json, service files, API responses or logs.
  if (policy === 'environment') {
    if (sources.runtime[envKey]) return { envKey, value: sources.runtime[envKey], source: 'environment' };
    return { envKey, value: '', source: 'missing' };
  }
  if (policy === 'nexuscrew-store') {
    if (sources.local[envKey]) return { envKey, value: sources.local[envKey], source: 'nexuscrew-store' };
    return { envKey, value: '', source: 'missing' };
  }
  // auto: legacy resolution order (runtime -> store -> shell -> keys -> legacy).
  if (sources.runtime[envKey]) return { envKey, value: sources.runtime[envKey], source: 'environment' };
  if (sources.local[envKey]) return { envKey, value: sources.local[envKey], source: 'local' };
  if (sources.shell[envKey]) return { envKey, value: sources.shell[envKey], source: 'compatibility' };
  if (sources.keys[envKey]) return { envKey, value: sources.keys[envKey], source: 'compatibility' };
  if (profile.legacySecrets && sources.legacy[envKey]) {
    return { envKey, value: sources.legacy[envKey], source: 'compatibility' };
  }
  return { envKey, value: '', source: 'missing' };
}

// The profile's "owned" env set. When the credential source is the local store,
// the child environment must not inherit any of these from the runtime: the
// entire set is enumerated and neutralized (unset), never just envKey. For
// Anthropic-compatible (claude.*) clients the set is the ANTHROPIC_* triple;
// every other client keeps the single profile envKey.
function credentialEnvNeutralizeSet(profile) {
  if (!profile) return [];
  if (profile.client === 'claude') return ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];
  const auth = profile.auth;
  const envKey = auth && auth !== 'dynamic' && auth !== 'login' && auth !== 'none'
    ? auth : (profile.defaultEnvKey || '');
  return envKey ? [envKey] : [];
}

// Apply nexuscrew-store neutralization to a composed child env: keys of the
// profile set that carry no NexusCrew-injected value are UNSET (deleted), never
// left as an empty string. 'auto'/'environment' are unchanged (legacy behavior).
function applyStoreNeutralization(env, spec, profile) {
  if (!env || !spec || spec.credentialSourcePolicy !== 'nexuscrew-store') return env;
  for (const k of credentialEnvNeutralizeSet(profile)) {
    if (env[k] === undefined || env[k] === '') delete env[k];
  }
  return env;
}

let ollamaCache = { at: 0, models: [] };
async function discoverOllamaModels(opts = {}) {
  const now = Date.now(); const ttl = opts.ttlMs === undefined ? 30000 : opts.ttlMs;
  if (!opts.noCache && ollamaCache.models.length && now - ollamaCache.at < ttl) return [...ollamaCache.models];
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return [...OLLAMA_CLOUD_MODELS];
  try {
    const home = opts.home || require('node:os').homedir();
    const sources = credentialSources(opts, home);
    const apiKey = opts.apiKey || sources.runtime.OLLAMA_API_KEY
      || sources.local.OLLAMA_API_KEY || sources.shell.OLLAMA_API_KEY || sources.keys.OLLAMA_API_KEY
      || sources.legacy.OLLAMA_API_KEY;
    if (!apiKey) throw new Error('OLLAMA_API_KEY missing');
    const response = await fetchImpl('https://ollama.com/api/tags', { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout?.(2500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json(); const available = new Set();
    for (const item of Array.isArray(body.models) ? body.models : []) {
      const name = typeof item?.name === 'string' ? item.name : '';
      if (/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(name) && name.length <= 128) available.add(name);
    }
    const models = OLLAMA_CLOUD_MODELS.filter((name) => available.has(name));
    if (!models.length) throw new Error('no cloud models');
    ollamaCache = { at: now, models }; return [...models];
  } catch (_) {
    ollamaCache = { at: now, models: [...OLLAMA_CLOUD_MODELS] }; return [...OLLAMA_CLOUD_MODELS];
  }
}

// Una discovery esterna non deve mai consumare l'intero budget del bridge MCP
// (10 s): il caller ha ancora margine per serializzare la directory e fallire
// in modo diagnostico. Ogni futura discovery tramite binario deve usare lo
// stesso contratto bounded + negative-cache, non una retry ad ogni richiesta.
const EXTERNAL_DISCOVERY_TIMEOUT_MS = 5000;
let piCache = { at: 0, providers: {} };
let piInFlight = null;
function copyPiProviders(providers) {
  return Object.fromEntries(Object.entries(providers).map(([key, models]) => [key, [...models]]));
}

async function discoverPiModels(opts = {}) {
  const now = Date.now(); const ttl = opts.ttlMs === undefined ? 300000 : opts.ttlMs;
  // `at`, non il contenuto, rende valida anche una failure cacheata: una lista
  // vuota e' un risultato operativo, non il segnale di rilanciare un binario
  // eventualmente bloccato ad ogni richiesta.
  if (!opts.noCache && piCache.at > 0 && now - piCache.at < ttl) {
    return copyPiProviders(piCache.providers);
  }
  const home = opts.home || require('node:os').homedir();
  const binary = opts.binary || findBinary('pi', home);
  if (!binary) return {};
  if (!opts.noCache && piInFlight) return piInFlight;
  const execFileImpl = opts.execFileImpl || execFile;
  const load = async () => {
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFileImpl(binary, ['--list-models'], {
          encoding: 'utf8', timeout: opts.timeoutMs === undefined ? EXTERNAL_DISCOVERY_TIMEOUT_MS : opts.timeoutMs,
          maxBuffer: 1024 * 1024,
        }, (err, out) => {
          if (err) reject(err); else resolve(String(out || ''));
        });
      });
      const providers = {};
      for (const line of stdout.split(/\r?\n/).slice(1)) {
        const [provider, model] = line.trim().split(/\s+/);
        if (!PROVIDER_ID_RE.test(provider || '') || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model || '')) continue;
        (providers[provider] ||= []).push(model);
      }
      for (const key of Object.keys(providers)) providers[key] = [...new Set(providers[key])];
      piCache = { at: now, providers };
      return copyPiProviders(providers);
    } catch (_) {
      // Cache negativa: una failure (timeout compreso) vale per il TTL intero.
      // Questo mantiene le route Fleet disponibili anche quando un binario di
      // discovery e' installato ma non risponde.
      // `noCache` e' un refresh diagnostico richiesto dall'operatore: se
      // fallisce non deve avvelenare una cache condivisa ancora valida.
      if (!opts.noCache) piCache = { at: now, providers: {} };
      return {};
    }
  };
  if (opts.noCache) return load();
  // load() assorbe gia' gli errori operativi. Il catch e' una cintura per una
  // futura regressione: chi aspetta il single-flight non deve mai ricevere un
  // rejection che renda la directory Fleet indisponibile.
  piInFlight = load().catch(() => ({})).finally(() => { piInFlight = null; });
  return piInFlight;
}

function describeManaged(spec, cfg = {}) {
  const extraModels = cfg.extraModels || null;
  const normalized = normalizeManagedSpec(spec, { extraModels });
  if (!normalized) return { configured: false, reason: 'invalid managed profile' };
  const home = cfg.home || require('node:os').homedir();
  const profile = profileFor(normalized.client, normalized.provider, normalized.credentialProfile || '');
  const binary = normalized.client === 'shell'
    ? resolveInteractiveShell({ ...cfg, home })
    : findBinary(normalized.client, home);
  const cred = credential(profile, normalized, cfg, home);
  // Pi can resolve credentials from its own documented /login auth store. Do
  // not inspect or copy that store; delegate native-provider auth to Pi.
  const delegatedPiAuth = profile.client === 'pi' && profile.provider !== 'custom'
    && profile.delegatePiAuth !== false;
  const authConfigured = delegatedPiAuth || profile.auth === 'login' || profile.auth === 'none' || !!cred.value;
  let configured = !!binary && authConfigured;
  let reason = !binary ? `client ${profile.client} not found` : (!authConfigured
    ? `credential ${cred.envKey} missing — set it on this device`
    : 'ready');
  // Agy e' un client primario supportato solo su Linux/macOS non-Termux.
  // Rilevazione Termux via termuxRuntimePaths (non solo process.platform): un
  // Node che riporta 'linux' sotto proot/Termux viene comunque intercettato.
  if (normalized.client === 'agy') {
    const platform = cfg.platform || process.platform;
    const termux = platform === 'android' || termuxRuntimePaths(cfg.env || process.env, { platform, home }) !== null;
    if (termux || (platform !== 'linux' && platform !== 'darwin')) {
      configured = false;
      reason = 'agy non supportato su questa piattaforma (usa shell.local con command agy)';
    }
  }
  return {
    client: profile.client, clientLabel: CLIENT_LABELS[profile.client], provider: profile.provider,
    credentialProfile: normalized.credentialProfile || '', model: normalized.model,
    permissionPolicy: normalized.permissionPolicy, protocol: normalized.protocol || profile.protocol,
    endpoint: normalized.baseUrl || profile.endpoint || '', auth: cred.envKey, authConfigured,
    credentialSourcePolicy: normalized.credentialSourcePolicy || 'auto',
    credentialSource: authConfigured ? cred.source : 'missing',
    configured, models: [...(profile.models || [])], defaultModel: profile.model || '',
    binary: binary || '', displayName: normalized.displayName || profile.label,
    reason,
  };
}

// Target-local, value-free status for a fixed catalog credential. The caller
// supplies only a profile already present in the public catalog, so this cannot
// be used as an arbitrary environment-variable oracle.
function describeCatalogCredential(client, provider, credentialProfile = '', cfg = {}) {
  const profile = profileFor(client, provider, credentialProfile);
  if (!profile || profile.auth === 'dynamic' || profile.auth === 'login' || profile.auth === 'none'
    || !ENV_KEY_RE.test(profile.auth || '')) return null;
  const home = cfg.home || require('node:os').homedir();
  const cred = credential(profile, {}, cfg, home);
  return {
    envKey: cred.envKey,
    authConfigured: !!cred.value,
    credentialSource: cred.value ? cred.source : 'missing',
  };
}

function codexProviderArgs(id, name, baseUrl, envKey) {
  return [
    '-c', `model_provider=${JSON.stringify(id)}`, '-c', `model_providers.${id}.name=${JSON.stringify(name)}`,
    '-c', `model_providers.${id}.base_url=${JSON.stringify(baseUrl)}`, '-c', `model_providers.${id}.env_key=${JSON.stringify(envKey)}`,
    '-c', `model_providers.${id}.wire_api="responses"`,
  ];
}

function codexCommandAuthProviderArgs(id, name, baseUrl, command, args) {
  return [
    '-c', `model_provider=${JSON.stringify(id)}`, '-c', `model_providers.${id}.name=${JSON.stringify(name)}`,
    '-c', `model_providers.${id}.base_url=${JSON.stringify(baseUrl)}`,
    '-c', `model_providers.${id}.wire_api="responses"`,
    '-c', `model_providers.${id}.auth.command=${JSON.stringify(command)}`,
    '-c', `model_providers.${id}.auth.args=${JSON.stringify(args)}`,
    '-c', `model_providers.${id}.auth.timeout_ms=5000`,
    '-c', `model_providers.${id}.auth.refresh_interval_ms=300000`,
  ];
}

function ensureKimiClaudeConfig(home) {
  return ensurePrivateClaudeConfig(home, 'kimi-code', 'Kimi Code', true);
}

function ensureAlibabaClaudeConfig(home) {
  return ensurePrivateClaudeConfig(home, 'alibaba-token-plan', 'Alibaba Token Plan', false);
}

// Un profilo Claude privato esiste per separare le CREDENZIALI, ma Claude tiene
// la configurazione MCP nello STESSO file: isolando l'una si e' isolata anche
// l'altra, e una cella su quei profili partiva senza nessuno strumento — niente
// memoria, niente `nc_notify`, niente `webfetch`. Non e' un difetto
// dell'isolamento: e' una conseguenza di dove Claude tiene le due cose.
//
// Si passa il file principale COME SORGENTE invece di copiarne il contenuto.
// Misurato: quelle definizioni portano `env` con una password Nextcloud e due
// chiavi API — copiarle avrebbe messo dei segreti in un secondo file, cioe' un
// altro posto da ruotare e da cui possono uscire, proprio dentro la directory
// che serve a tenerli separati.
//
// Niente `--strict-mcp-config`: la configurazione di progetto deve continuare a
// valere, ed e' il punto in cui si innestera' un elenco per-cella.
//
// UN SOLO TOKEN, con l'uguale. `--mcp-config` e' VARIADICO e nella forma
// spaziata consuma ogni argomento successivo che non inizi per `-` — compreso
// il prompt della cella, che viene accodato come posizionale in fondo
// all'argv. Misurato sul client installato:
//   --mcp-config <file> ciao-prompt -> «MCP config file not found: .../ciao-prompt»
//   --mcp-config=<file> ciao-prompt -> nessun errore, un solo file letto
// Non riportarlo alla forma spaziata «per leggibilita'»: rompe ogni cella che
// abbia un prompt, cioe' quelle vere.
//
// Fail-safe: un file assente, illeggibile o senza `mcpServers` non aggiunge il
// flag. Senza strumenti si lavora peggio; con un flag che punta al vuoto la
// cella non parte affatto.
function sharedMcpArgs(home) {
  const file = path.join(home, '.claude.json');
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 8 * 1024 * 1024) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const servers = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.mcpServers : null;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)
      || !Object.keys(servers).length) return [];
  } catch (_) {
    return [];
  }
  return [`--mcp-config=${file}`];
}

// Quali server MCP esistono, per NOME. Si guarda dove il client li prende.
// Non si legge nient'altro di quei file: servono solo i nomi.
//
// TRE SORGENTI, non due. Il local scope vive nello STESSO file della
// configurazione utente ma in un ramo diverso — `projects[<cwd>].mcpServers`,
// indicizzato sul percorso assoluto — ed e' reale: su questa installazione nove
// progetti ne hanno, fra cui la directory di lavoro delle celle. Dimenticarlo
// significava che un elenco parziale non negava server che la sessione carica
// davvero, e l'operatore avrebbe creduto di averli esclusi. Trovato dall'audit.
//
// RESTANO FUORI, e non sono enumerabili da qui: plugin, connettori claude.ai e
// la configurazione gestita di sistema. Per quelli l'unica esclusione certa e'
// `mcp: []`, che usa il jolly e non dipende da nessuna enumerazione. La finestra
// lo dice all'operatore invece di lasciarglielo credere.
function knownMcpServerNames(home, cwd) {
  const nomi = new Set();
  const raccogli = (servers) => {
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      for (const nome of Object.keys(servers)) nomi.add(nome);
    }
  };
  const leggi = (file) => {
    try {
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink() || !st.isFile() || st.size > 8 * 1024 * 1024) return null;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) { return null; /* un file assente o illeggibile non e' un errore qui */ }
  };
  const utente = leggi(path.join(home, '.claude.json'));
  if (utente) {
    raccogli(utente.mcpServers);
    const progetti = utente.projects;
    if (typeof cwd === 'string' && cwd && progetti && typeof progetti === 'object' && !Array.isArray(progetti)) {
      const voce = progetti[cwd];
      if (voce && typeof voce === 'object' && !Array.isArray(voce)) raccogli(voce.mcpServers);
    }
  }
  if (typeof cwd === 'string' && cwd) {
    const progetto = leggi(path.join(cwd, '.mcp.json'));
    if (progetto) raccogli(progetto.mcpServers);
  }
  return nomi;
}

// Gli strumenti MCP che questa cella deve avere, per NOME.
//
// SI CONCEDE NEGANDO IL COMPLEMENTO, non permettendo l'eccezione. Misurato sul
// client installato, in tre configurazioni, perche' l'intera funzione poggia su
// questo — `mcp: []` PROMETTE che non ci sono strumenti:
//   1. deny e allow nello STESSO file  -> vince il deny;
//   2. deny e allow in DUE sorgenti `--settings` distinte -> vince il deny;
//   3. un `allow` di progetto in un workspace non fidato viene ignorato dal
//      client prima ancora di arrivare al confronto.
// Non e' provato il caso di un `allow` a livello utente in un workspace fidato:
// richiederebbe di modificare la configurazione reale dell'operatore. Dato il
// verso costante delle prime due, l'attesa e' che il deny vinca anche li'.
//
// `mcp: []` usa il jolly, e questo caso e' ESATTO: non dipende da quali server
// esistono ne' da dove arrivano. E' la cella di cui non ci si fida, ed e' giusto
// che sia il caso senza approssimazioni.
//
// Un elenco parziale nega il complemento di cio' che si riesce a enumerare
// (le tre sorgenti in `knownMcpServerNames`). RESIDUO DICHIARATO: plugin,
// connettori e configurazione gestita di sistema non sono enumerabili da qui, e
// un server che arrivasse da li' non verrebbe negato. Non lo nascondo dietro un
// nome rassicurante: chi vuole la garanzia certa usa `mcp: []`, e la finestra
// lo dice.
//
// Nessun file per cella: la lista viaggia in argv e contiene SOLO NOMI. Le
// definizioni — e le credenziali che alcune portano nel proprio `env` — restano
// nell'unico posto dove vivono.
//
// Forma con l'uguale, come `--mcp-config`: un solo token, cosi' nessun argomento
// successivo puo' essere inghiottito.
function cellMcpArgs(home, cell) {
  const voluti = cell && Array.isArray(cell.mcp) ? cell.mcp : null;
  if (!voluti) return [];
  if (!voluti.length) return [`--settings=${JSON.stringify({ permissions: { deny: ['mcp__*'] } })}`];
  const concessi = new Set(voluti);
  const deny = [...knownMcpServerNames(home, cell.cwd)]
    .filter((nome) => !concessi.has(nome)).sort().map((nome) => `mcp__${nome}`);
  if (!deny.length) return [];
  return [`--settings=${JSON.stringify({ permissions: { deny } })}`];
}

function ensurePrivateClaudeConfig(home, profileId, label, penguinMode) {
  const nexusDir = path.join(home, '.nexuscrew');
  const profilesDir = path.join(nexusDir, 'claude-profiles');
  const configDir = path.join(profilesDir, profileId);
  safePrivateDir(nexusDir, { create: true });
  safePrivateDir(profilesDir, { create: true });
  safePrivateDir(configDir, { create: true });
  const file = path.join(configDir, '.claude.json');
  let current = {};
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) || st.size > 256 * 1024
      || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
      throw new Error(`unsafe ${label} Claude config`);
    }
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`invalid ${label} Claude config`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const next = { ...current, hasCompletedOnboarding: true,
    ...(penguinMode ? { penguinModeOrgEnabled: true } : {}) };
  if (current.hasCompletedOnboarding === true
    && (!penguinMode || current.penguinModeOrgEnabled === true)) return configDir;
  const tmp = path.join(configDir, `.claude.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  return configDir;
}

function writePiProviderExtension(spec, home) {
  const dir = path.join(home, '.nexuscrew', 'pi-providers');
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('unsafe Pi provider extension directory');
  } catch (e) {
    if (e.code === 'ENOENT') fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    else throw e;
  }
  fs.chmodSync(dir, 0o700);
  const target = path.join(dir, `${spec.providerId}.ts`);
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('refusing symlink Pi provider extension');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const definition = {
    name: spec.displayName,
    baseUrl: spec.baseUrl,
    apiKey: spec.apiKey || `$${spec.envKey}`,
    authHeader: true,
    api: spec.protocol,
    models: Array.isArray(spec.models) && spec.models.length ? spec.models : [{
      id: spec.model, name: spec.model, reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  };
  const source = `// Generated by NexusCrew. Contains environment references only, never secret values.\nexport default function (pi) {\n  pi.registerProvider(${JSON.stringify(spec.providerId)}, ${JSON.stringify(definition, null, 2)});\n}\n`;
  const tmp = path.join(dir, `.${spec.providerId}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, source, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  return target;
}

function resolveManagedEngine(engine, cell, cfg = {}) {
  // `extraModels` DEVE arrivare fin qui. Threadarlo al chiamante e alla vista
  // non basta: la normalizzazione che decide se la cella PARTE e' questa, e
  // senza l'elenco dichiarato un modello legittimo diventa «invalid managed
  // profile» — cioe' una cella che non si avvia per una ragione invisibile.
  // E' il difetto che l'audit ha ripreso due volte: la vista diceva di si',
  // il boot diceva di no, e nessun test guardava il boot.
  const spec = normalizeManagedSpec(engine.managed, { extraModels: cfg.extraModels || null });
  const info = describeManaged(spec, cfg);
  if (!spec || !info.configured) return { ok: false, reason: info.reason, info };
  const home = cfg.home || require('node:os').homedir();
  const profile = profileFor(spec.client, spec.provider, spec.credentialProfile || '');
  const cred = credential(profile, spec, cfg, home);
  // L'override PER-CELLA va canonicalizzato come lo spec: `normalizeManagedSpec`
  // applica l'alias a `spec.model`, ma `cell.model` lo scavalca DOPO e senza
  // passare di li'. Senza questo, un nome legacy per-cella finisce in argv e in
  // env, e i rami di trattamento (che confrontano il nome nuovo) non scattano:
  // la cella parte, sembra a posto, e gira con i parametri sbagliati.
  const env = {}; const args = []; const model = canonicalModel(cell?.model || spec.model);
  // I due profili Claude con configurazione privata: perdono gli MCP del file
  // principale e vanno ricollegati (vedi `sharedMcpArgs`).
  let privateProfile = false;
  // Effective permission policy: override PER-CELL PER-ENGINE (remembered) vince sul
  // default dell'engine. Mai si mutationa engine.managed.permissionPolicy (globale).
  // Pi resta sempre 'standard' (lo spec normalized rifiuta gia' unsafe per pi).
  const engineId = engine && typeof engine.id === 'string' ? engine.id : '';
  const override = cell && cell.permissionPolicies && Object.prototype.hasOwnProperty.call(cell.permissionPolicies, engineId)
    ? cell.permissionPolicies[engineId] : null;
  let effectivePolicy = (override === 'standard' || override === 'unsafe') ? override : spec.permissionPolicy;
  // Pi resta sempre 'standard': normalizeManagedSpec rifiuta gia' unsafe nello spec
  // dell'engine, ma l'override PER-CELL bypasserebbe quel check -> clamp esplicito.
  if (spec.client === 'pi' || spec.client === 'shell') effectivePolicy = 'standard';
  info.permissionPolicy = effectivePolicy;
  if (effectivePolicy === 'unsafe') {
    if (spec.client === 'claude' || spec.client === 'agy') args.push('--dangerously-skip-permissions');
    if (spec.client === 'codex' || spec.client === 'codex-vl') args.push('--dangerously-bypass-approvals-and-sandbox');
    // Kimi Code CLI: unsafe mappa su --yolo (auto-approva le chiamate tool
    // ordinarie ma l'agente puo' ancora fare domande). --auto (fully
    // autonomous, nessuna domanda) NON e' mappato: il contratto NexusCrew
    // distingue solo standard/unsafe e il default resta interattivo.
    if (spec.client === 'kimi') args.push('--yolo');
  }
  let shellOneShot = false;
  if (spec.client === 'shell') {
    const raw = cell?.commands && typeof cell.commands[engineId] === 'string'
      ? cell.commands[engineId] : '';
    shellOneShot = raw.trim().length > 0;
    if (shellOneShot) args.push(...shellConfiguredCommandArgs(info.binary, raw));
    else args.push(...shellLoginArgs(info.binary));
  } else if (spec.client === 'claude') {
    if (spec.provider === 'native') {
      if (engine.rc !== false) args.push('--remote-control', `Cloud_${cell.id}`);
    } else if (profile.providerEnv) {
      Object.assign(env, profile.providerEnv);
    } else if (spec.provider === 'openrouter') {
      Object.assign(env, {
        ANTHROPIC_BASE_URL: profile.endpoint, ANTHROPIC_AUTH_TOKEN: cred.value, ANTHROPIC_API_KEY: '',
        ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model, API_TIMEOUT_MS: '3000000',
      });
    } else if (spec.provider === 'kimi-code') {
      privateProfile = true;
      const contextWindow = model === 'k3[1m]' ? '1048576' : '262144';
      Object.assign(env, {
        CLAUDE_CONFIG_DIR: ensureKimiClaudeConfig(home),
        ANTHROPIC_BASE_URL: profile.endpoint, ANTHROPIC_API_KEY: cred.value,
        ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_FABLE_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: contextWindow,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: contextWindow,
        API_TIMEOUT_MS: '3000000',
      });
      if (model === 'k3' || model === 'k3[1m]') {
        env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
        env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1';
      }
    } else if (spec.provider === 'alibaba-token-plan') {
      privateProfile = true;
      const qwen38 = model === 'qwen3.8-max';
      const aliases = qwen38 ? {
        ANTHROPIC_MODEL: 'qwen3.8-max',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'qwen3.8-max',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-max',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.8-max',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.6-flash',
        CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3.7-max',
      } : {
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_FABLE_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model,
      };
      Object.assign(env, {
        CLAUDE_CONFIG_DIR: ensureAlibabaClaudeConfig(home),
        ANTHROPIC_BASE_URL: profile.endpoint,
        ANTHROPIC_AUTH_TOKEN: cred.value,
        ANTHROPIC_API_KEY: '',
        ...aliases,
        API_TIMEOUT_MS: '3000000',
      });
      if (qwen38) {
        env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(ALIBABA_TOKEN_PLAN_CONTEXT);
        env.CLAUDE_CODE_EFFORT_LEVEL = 'xhigh';
        env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1';
      }
    } else {
      const endpoint = spec.baseUrl || profile.endpoint;
      const token = profile.auth === 'none' ? 'ollama' : cred.value;
      const contextWindow = ollamaContextFor(model) ?? (spec.provider === 'zai' ? 1000000 : 200000);
      Object.assign(env, {
        ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: '',
        ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model, API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow),
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow),
      });
    }
    if (model) args.push('--model', model);
    // In coda di proposito: `--mcp-config` e' variadico e consuma ogni token
    // che non inizi per `-`. Messo qui non ha nulla da inghiottire.
    if (privateProfile) args.push(...sharedMcpArgs(home));
    // Vale per OGNI cella Claude, non solo per i profili isolati: il filtro
    // agisce sui nomi dei tool, non su dove i server sono definiti.
    args.push(...cellMcpArgs(home, cell));
  } else if (spec.client === 'codex' || spec.client === 'codex-vl') {
    if (profile.localProvider) args.push('--oss', '--local-provider', profile.localProvider);
    else if (spec.provider === 'openai-api') env.OPENAI_API_KEY = cred.value;
    else if (spec.provider === 'ollama-cloud') {
      env.OPENAI_API_KEY = cred.value;
      args.push(...codexProviderArgs('ollama_cloud', 'Ollama Cloud', profile.endpoint, 'OPENAI_API_KEY'));
      args.push('-c', 'model_providers.ollama_cloud.stream_idle_timeout_ms=600000', '-c', `model_context_window=${ollamaContextFor(model) ?? 200000}`);
      const localCatalog = path.join(home, '.codex', 'ollama_cloud_model_catalog.json');
      if (fs.existsSync(localCatalog)) args.push('-c', `model_catalog_json="${localCatalog}"`);
    } else if (spec.provider === 'openrouter') {
      env.OPENROUTER_API_KEY = cred.value;
      const authHelper = path.join(__dirname, 'openrouter-auth-helper.js');
      args.push(...codexCommandAuthProviderArgs('openrouter', 'OpenRouter', profile.endpoint, process.execPath, [authHelper, 'OPENROUTER_API_KEY']));
      args.push('-c', 'model_providers.openrouter.stream_idle_timeout_ms=600000');
      if (model === 'moonshotai/kimi-k3') {
        const localCatalog = path.join(__dirname, 'catalogs', 'openrouter-kimi-k3.json');
        args.push('-c', `model_catalog_json=${JSON.stringify(localCatalog)}`);
        args.push('-c', 'model_context_window=1048576');
      }
    } else if (spec.provider === 'alibaba-token-plan') {
      env.ALIBABA_CODE_API_KEY = cred.value;
      args.push(...codexProviderArgs('alibaba_token_plan', 'Alibaba Token Plan Personal', profile.endpoint, 'ALIBABA_CODE_API_KEY'));
      args.push('-c', 'model_providers.alibaba_token_plan.stream_idle_timeout_ms=600000');
      if (model === 'qwen3.8-max') {
        const localCatalog = path.join(__dirname, 'catalogs', 'alibaba-token-plan-qwen3.8.json');
        args.push('-c', `model_catalog_json=${JSON.stringify(localCatalog)}`);
        args.push('-c', `model_context_window=${ALIBABA_TOKEN_PLAN_CONTEXT}`);
      }
    } else if (spec.provider === 'custom') {
      env[spec.envKey] = cred.value;
      args.push(...codexProviderArgs(spec.providerId, spec.displayName, spec.baseUrl, spec.envKey));
    }
    if (model) args.push('-m', model);
  } else if (spec.client === 'pi') {
    if (profile.auth !== 'none' && profile.auth !== 'login' && cred.value) env[cred.envKey] = cred.value;
    if (spec.provider === 'custom') args.push('--extension', writePiProviderExtension(spec, home));
    else if (profile.piExtension) args.push('--extension', writePiProviderExtension({
      providerId: profile.piProvider, displayName: profile.label.replace(/^Pi · /, ''),
      baseUrl: profile.piExtension.baseUrl, apiKey: profile.piExtension.apiKey,
      protocol: profile.protocol, model, envKey: cred.envKey, models: profile.piExtension.models,
    }, home));
    if (spec.provider !== 'native') args.push('--provider', spec.provider === 'custom' ? spec.providerId : profile.piProvider);
    if (model) args.push('--model', model);
    if (spec.provider === 'alibaba-token-plan' && model === 'qwen3.8-max') args.push('--thinking', 'xhigh');
  } else if (spec.client === 'agy') {
    // Agy delega l'autenticazione al proprio login locale (auth: 'login'): niente
    // env provider, niente credenziali copiate. Argv diretto: --model prima del
    // prompt; --prompt-interactive e' l'ultima coppia (il prompt value e' accodato
    // dal push generico qui sotto). Senza prompt parte il TUI interattivo `agy`.
    if (model) args.push('--model', model);
    if (cell?.prompt) args.push('--prompt-interactive');
  } else if (spec.client === 'kimi') {
    // Kimi Code CLI nativo: auth e provider gestiti dal CLI (login device-code,
    // config.toml): niente env provider, niente credenziali su argv. Il CLI non
    // documenta un flag prompt interattivo (`kimi -p` e' non-interattivo, senza
    // TUI): il prompt della cella NON va su argv ma viene iniettato via
    // bracketed paste dopo la readiness (promptMode 'send-keys' qui sotto,
    // reiniettato anche ai restart supervisionati). Senza argomenti parte il
    // TUI interattivo nella cwd della cella.
    if (model) args.push('--model', model);
  }
  // Prompt su argv (0.8.47): SOLO i client che non hanno un percorso classified
  // delivery. kimi.native e claude.kimi-code usano promptMode 'send-keys' con
  // deliverBootstrapPrompt (readiness classificata + at-most-once): il prompt
  // NON deve mai comparire nel loro argv (visibile in ps / perso dietro
  // consenso/onboarding). Gli altri managed conservano il contratto argv
  // (finding separato, fuori da questa patch).
  const promptViaDelivery = spec.client === 'kimi'
    || (spec.client === 'claude' && spec.provider === 'kimi-code');
  if (spec.client !== 'shell' && !promptViaDelivery && cell?.prompt) args.push(cell.prompt);
  // nexuscrew-store source: neutralize the profile's env set in the composed
  // child env (unset, never empty), so the runtime cannot leak credentials that
  // the local store is meant to own.
  applyStoreNeutralization(env, spec, profile);
  let command = info.binary;
  if (needsExplicitNode(info.binary, cfg.platform || process.platform, cfg.env || process.env)) {
    command = cfg.nodeExecPath || process.execPath;
    args.unshift(info.binary);
  }
  return { ok: true, info, engine: {
    ...engine, command, args, env,
    promptMode: promptViaDelivery ? 'send-keys' : 'managed-argv', clientBinary: info.binary,
    ...(spec.client === 'shell' ? { shellOneShot } : {}),
  } };
}

function publicCatalog() {
  return CATALOG.filter((p) => !p.legacy && (p.core || p.default || p.custom)).map((p) => ({
    id: p.id, client: p.client, clientLabel: CLIENT_LABELS[p.client], provider: p.provider,
    credentialProfile: p.credentialProfile || '', label: p.label, protocol: p.protocol,
    auth: p.auth, endpoint: p.endpoint || '', model: p.model || '', models: [...(p.models || [])],
    protocols: [...(p.protocols || [p.protocol])], supportsUnsafe: !['pi', 'shell'].includes(p.client), requiresModel: !!p.requiresModel || !!p.custom,
    permissionPolicyDefault: p.client === 'claude' ? 'unsafe' : 'standard',
    rc: !!p.rc, custom: !!p.custom, default: !!p.default, notice: p.notice || '',
    // 'login'/'none' non sono variabili d'ambiente: nessuna KEY section per gli
    // engine che delegano l'auth al login del CLI (rappresentazione onesta).
    credentialEnv: p.auth === 'dynamic' ? !!p.credentialEnv
      : (p.auth !== 'login' && p.auth !== 'none' && ENV_KEY_RE.test(p.auth || '') ? p.auth : false),
    defaultEnvKey: p.defaultEnvKey || '',
  }));
}

module.exports = {
  knownMcpServerNames,
  CATALOG, OLLAMA_CLOUD_MODELS, OLLAMA_CONTEXT, ALIBABA_TOKEN_PLAN_MODELS,
  ALIBABA_CODEX_MODELS, ALIBABA_TOKEN_PLAN_CONTEXT, ALIBABA_PI_MODELS,
  CLIENT_LABELS, normalizeManagedSpec, profileFor,
  defaultDefinitions, defaultShellEngine, defaultAgyEngine, defaultKimiEngine, describeManaged, describeCatalogCredential, discoverOllamaModels, resolveManagedEngine, needsExplicitNode,
  discoverPiModels, EXTERNAL_DISCOVERY_TIMEOUT_MS, parseEnvFile, parseProviderShellFile, findBinary, publicCatalog, writePiProviderExtension,
  extraModelsFrom,
  providerKeyPaths, parseProviderKeyFiles, credentialSources, credential,
  credentialEnvNeutralizeSet, applyStoreNeutralization,
  ensureKimiClaudeConfig, ensureAlibabaClaudeConfig, resolveInteractiveShell,
  shellLoginArgs, shellConfiguredCommandArgs, ENV_KEY_RE,
};
