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
//
// D2: Map<engine, Map<id, model>> — porta il descrittore intero, non solo
// l'id (stesso motivo del commento gemello in definitions.js: extraModels e'
// costruita due volte, una dentro parseDefinitions per il parsing, una qui per
// il runtime che rilegge le definizioni gia' salvate; le due DEVONO restare
// nella stessa forma).
function extraModelsFrom(defs) {
  const map = new Map();
  for (const m of (defs && Array.isArray(defs.models) ? defs.models : [])) {
    if (!m || typeof m.engine !== 'string' || typeof m.id !== 'string') continue;
    if (!map.has(m.engine)) map.set(m.engine, new Map());
    map.get(m.engine).set(m.id, m);
  }
  return map;
}

// I descrittori dichiarati per UN profilo (client.provider, es.
// 'codex-vl.custom'), come array. Chi ha bisogno solo del catalogo dei
// modelli (customCatalogFor, writePiProviderExtension) chiama questa; chi ha
// bisogno solo di validare un id (declaredFor) continua a usare extraModels
// direttamente — due bisogni diversi sulla STESSA struttura, non due copie.
function declaredModelsFor(extraModels, profileId) {
  if (!extraModels || typeof extraModels.get !== 'function') return [];
  const byId = extraModels.get(profileId);
  return byId && typeof byId.values === 'function' ? [...byId.values()] : [];
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

// OpenCode Go: un abbonamento unico dietro TRE wire, non un provider uniforme.
//
// La documentazione ufficiale assegna a ciascun modello un solo endpoint, ma il
// gateway traduce: gli elenchi qui sotto sono MISURATI coppia per coppia il
// 2026-08-11 (25 ID live x 3 wire, piu' una seconda passata sulle celle fallite
// per distinguere il rifiuto di wire dal payload perso in traduzione).
//
// Cosa NON e' in elenco, e perche' non e' una svista:
//  - kimi-*, mimo-v2.5*, hy3 fuori da Messages/Responses: il gateway inoltra
//    un payload vuoto e l'upstream risponde "messages must not be empty". E' un
//    difetto loro, reversibile senza preavviso: se un giorno rispondono, l'id
//    si dichiara per quell'engine senza toccare il codice.
//  - deepseek-v4-pro: MISURATO 2026-08-13 sul gateway opencode.ai/zen/go ->
//    200 su /v1/responses (status=completed) e 200 su /v1/messages
//    (stop_reason=end_turn), auth x-api-key. DeepSeek ha aggiunto la Responses
//    API a v4-pro il 13/08 (l'11/08 era escluso: "messages must not be empty"):
//    per questo ora entra in MESSAGES e RESPONSES. Se smettesse di rispondere,
//    andrebbe rimosso di nuovo — e questo commento va tenuto allineato al codice.
//  - mimo-v2-pro e mimo-v2-omni: deprecati dall'upstream ("migrate to
//    xiaomi/mimo-v2.5*"). hy3-preview: "Model is unavailable".
//    Il catalogo live li pubblicizza comunque; qui non entrano.
//  - grok-4.5 solo su Responses: su Chat risponde 503 e Messages lo rifiuta
//    esplicitamente ("not supported for format anthropic").
const OPENCODE_GO_MESSAGES_MODELS = Object.freeze([
  'deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.2', 'glm-5.1', 'glm-5',
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
  'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus',
]);
const OPENCODE_GO_RESPONSES_MODELS = Object.freeze([
  'deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.6-luna', 'grok-4.5', 'glm-5.2', 'glm-5.1', 'glm-5',
]);
const OPENCODE_GO_CHAT_MODELS = Object.freeze([
  'deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.2', 'glm-5.1', 'glm-5',
  'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5',
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
  'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus',
  'mimo-v2.5', 'mimo-v2.5-pro', 'hy3', 'gpt-5.6-luna',
]);
const OPENCODE_GO_ANTHROPIC_ROOT = 'https://opencode.ai/zen/go';
const OPENCODE_GO_API_BASE = 'https://opencode.ai/zen/go/v1';

// Limiti dichiarati dal catalogo models.dev per il provider `opencode-go`,
// trascritti il 2026-08-11. Sono l'unica fonte autorevole che abbiamo per il
// contesto: il preflight misura quali coppie wire/modello rispondono, non
// quanto contesto reggono. Senza questi numeri il client sceglie un default
// suo — per Codex il catalogo e' proprio cio' che glielo dice, e per Claude
// l'assenza significa compattare a una soglia che non c'entra col modello.
//
// Restano numeri DICHIARATI, non misurati da noi: se un modello si comporta
// come se ne avesse meno, il sospetto va qui prima che sul client.
const OPENCODE_GO_LIMITS = Object.freeze({
  'deepseek-v4-flash': { context: 1000000, output: 384000 },
  'deepseek-v4-pro': { context: 1000000, output: 384000 },
  'glm-5.2': { context: 1000000, output: 131072 },
  'glm-5.1': { context: 202752, output: 32768 },
  'glm-5': { context: 202752, output: 32768 },
  'kimi-k3': { context: 1048576, output: 131072 },
  'kimi-k2.7-code': { context: 262144, output: 262144 },
  'kimi-k2.6': { context: 262144, output: 65536 },
  'kimi-k2.5': { context: 262144, output: 65536 },
  'minimax-m3': { context: 1000000, output: 131072 },
  'minimax-m2.7': { context: 204800, output: 131072 },
  'minimax-m2.5': { context: 204800, output: 65536 },
  'qwen3.8-max': { context: 1000000, output: 131072 },
  'qwen3.7-max': { context: 1000000, output: 65536 },
  'qwen3.7-plus': { context: 1000000, output: 65536 },
  'qwen3.6-plus': { context: 1000000, output: 65536 },
  'qwen3.5-plus': { context: 262144, output: 65536 },
  'mimo-v2.5': { context: 1000000, output: 128000 },
  'mimo-v2.5-pro': { context: 1048576, output: 128000 },
  hy3: { context: 256000, output: 64000 },
  'gpt-5.6-luna': { context: 1050000, output: 128000 },
  'grok-4.5': { context: 500000, output: 500000 },
});

function opencodeGoContextFor(model) {
  return OPENCODE_GO_LIMITS[String(model || '')]?.context;
}

// Descrittori per l'estensione Pi generata. `compat` viene applicato SOLO ai
// due id per cui il repo lo dichiara gia' altrove sulla stessa wire
// (`pi.alibaba-token-plan`): sono gli stessi modelli su un gateway diverso,
// quindi e' riuso di una dichiarazione esistente. Sugli altri non c'e'
// precedente e non si estrapola.
const OPENCODE_GO_PI_COMPAT = Object.freeze(['glm-5.2', 'deepseek-v4-pro']);
const OPENCODE_GO_PI_MODELS = Object.freeze(OPENCODE_GO_CHAT_MODELS.map((id) => Object.freeze({
  id,
  name: id,
  api: 'openai-completions',
  reasoning: false,
  input: ['text'],
  contextWindow: OPENCODE_GO_LIMITS[id].context,
  maxTokens: OPENCODE_GO_LIMITS[id].output,
  cost: ZERO_COST,
  ...(OPENCODE_GO_PI_COMPAT.includes(id)
    ? { compat: { thinkingFormat: 'openai', requiresReasoningContentOnAssistantMessages: true } }
    : {}),
})));

const CUSTOM_KEYS = ['displayName', 'protocol', 'baseUrl', 'envKey', 'providerId'];
const MANAGED_KEYS = new Set(['client', 'provider', 'credentialProfile', 'model', 'permissionPolicy', 'credentialSourcePolicy', 'envPassthrough', ...CUSTOM_KEYS]);
// D3: massimo numero di nomi in `envPassthrough`. L'allowlist e' opt-in e per
// nome, mai un passthrough in blocco: un tetto basso ferma una lista incontrollata.
const MAX_ENV_PASSTHROUGH = 32;
// Explicit credential source policy. Default 'auto' preserves the legacy
// resolution order (runtime -> store -> shell -> key files -> legacy) so a
// pre-WP1 fleet.json migrates no-op: no existing cell changes resolution.
const CREDENTIAL_SOURCES = Object.freeze(['environment', 'nexuscrew-store', 'auto']);
// I valori che `credential().source` puo' assumere, e che escono verso la UI in
// `describeManaged().credentialSource` / `describeCatalogCredential()`. La UI li
// rende con la chiave `fleet-credential-source-<valore>`, e `t()` su chiave
// assente restituisce LA CHIAVE: un valore nuovo senza traduzione si vede a
// schermo come stringa tecnica. Questa lista e' l'ancora della sonda in
// tests/i18n.test.js — la parita' fra le tre lingue e' gia' garantita da un
// altro test, qui si garantisce la COPERTURA dei valori che il backend produce.
// Chi aggiunge un valore in credential() aggiunge una riga qui e la stringa nei
// tre dizionari, oppure il gate lo ferma.
const CREDENTIAL_SOURCE_VALUES = Object.freeze([
  'login', 'none', 'environment', 'nexuscrew-store', 'local', 'compatibility', 'missing', 'unreadable',
]);
const CLIENT_LABELS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', 'codex-vl': 'Codex-VL', grok: 'Grok', vl: 'VL', pi: 'Pi', agy: 'Agy', kimi: 'Kimi Code CLI', shell: 'Shell' });
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
  // L'ordine di questo array e' semantica contrattuale, non estetica: guida il
  // menu client (prima apparizione di ogni client) e il menu provider dentro un
  // client (ordine dell'array), entrambi via publicCatalog che preserva l'ordine.
  // Ordine client: claude -> codex-vl -> codex -> grok -> vl -> pi -> agy -> kimi
  // -> shell. Dentro ogni client: native/login -> subscription (alibaba-token-
  // plan, kimi-code, zai) -> cloud (openrouter, ollama-cloud, bedrock, vertex,
  // foundry) -> local (ollama, lmstudio) -> custom. Le voci legacy chiudono
  // l'array in una sezione separata. claude.native resta il primo default.

  // Claude Code
  { id: 'claude.native', client: 'claude', provider: 'native', label: 'Anthropic / Claude account', auth: 'login', endpoint: 'Anthropic account', protocol: 'anthropic_messages', rc: true, default: true, core: true },
  { id: 'claude.alibaba-token-plan', client: 'claude', provider: 'alibaba-token-plan', label: 'Alibaba Token Plan Personal', auth: 'ALIBABA_CODE_API_KEY', endpoint: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic', protocol: 'anthropic_messages', model: 'qwen3.8-max', models: ALIBABA_TOKEN_PLAN_MODELS, strictModels: true, core: true, notice: 'alibaba-token-plan' },
  { id: 'claude.kimi-code', client: 'claude', provider: 'kimi-code', label: 'Kimi Code', auth: 'KIMI_API_KEY', endpoint: 'https://api.kimi.com/coding/', protocol: 'anthropic_messages', model: 'k3[1m]', models: ['k3', 'k3[1m]', 'kimi-for-coding', 'kimi-for-coding-highspeed'], strictModels: true, core: true, notice: 'claude-kimi-code' },
  // GLM-5.3 dal 2026-08-15. Sul Coding Plan lo switch e' gia' automatico —
  // chiedendo `glm-5.2` il server risponde `glm-5.3` — ma il nome scritto qui
  // deve dire la verita' su cosa stiamo usando. Il suffisso `[1m]` resta: e' un
  // flag di finestra del CLI e viene tolto prima della richiesta HTTP, dove
  // `glm-5.3[1m]` letterale darebbe 400 (code 1214, misurato).
  { id: 'claude.zai', client: 'claude', provider: 'zai', label: 'Z.AI', auth: 'dynamic', credentialEnv: true, defaultEnvKey: 'ZAI_API_KEY', endpoint: 'https://api.z.ai/api/anthropic', protocol: 'anthropic_messages', model: 'glm-5.3[1m]', models: ['glm-5.3[1m]', 'glm-5.2[1m]'], core: true },
  // OpenCode Go su Claude parla Anthropic Messages, e la wire accetta SOLO
  // `x-api-key`: con `Authorization: Bearer` risponde 401 AuthError. Per questo
  // l'endpoint e' la root senza `/v1` (il client aggiunge `/v1/messages`) e il
  // launch valorizza ANTHROPIC_API_KEY, non ANTHROPIC_AUTH_TOKEN come Z.AI.
  { id: 'claude.opencode-go', client: 'claude', provider: 'opencode-go', label: 'OpenCode Go', auth: 'OPENCODE_API_KEY', endpoint: OPENCODE_GO_ANTHROPIC_ROOT, protocol: 'anthropic_messages', model: 'deepseek-v4-flash', models: OPENCODE_GO_MESSAGES_MODELS, strictModels: true, core: true },
  { id: 'claude.openrouter', client: 'claude', provider: 'openrouter', label: 'OpenRouter', auth: 'OPENROUTER_API_KEY', endpoint: 'https://openrouter.ai/api', protocol: 'anthropic_messages', requiresModel: true, core: true, notice: 'claude-openrouter' },
  { id: 'claude.ollama-cloud', client: 'claude', provider: 'ollama-cloud', label: 'Ollama Cloud', auth: 'OLLAMA_API_KEY', endpoint: 'https://ollama.com', protocol: 'anthropic_messages', model: 'glm-5.2', models: OLLAMA_CLOUD_MODELS, legacySecrets: true, core: true },
  { id: 'claude.bedrock', client: 'claude', provider: 'bedrock', label: 'Amazon Bedrock', auth: 'login', endpoint: 'AWS Bedrock', protocol: 'anthropic_messages', core: true, providerEnv: { CLAUDE_CODE_USE_BEDROCK: '1' } },
  { id: 'claude.vertex', client: 'claude', provider: 'vertex', label: 'Google Vertex AI', auth: 'login', endpoint: 'Google Vertex AI', protocol: 'anthropic_messages', core: true, providerEnv: { CLAUDE_CODE_USE_VERTEX: '1' } },
  { id: 'claude.foundry', client: 'claude', provider: 'foundry', label: 'Microsoft Foundry', auth: 'login', endpoint: 'Microsoft Foundry', protocol: 'anthropic_messages', core: true, providerEnv: { CLAUDE_CODE_USE_FOUNDRY: '1' } },
  { id: 'claude.ollama', client: 'claude', provider: 'ollama', label: 'Ollama local', auth: 'none', endpoint: 'http://127.0.0.1:11434', protocol: 'anthropic_messages', core: true },
  { id: 'claude.custom', client: 'claude', provider: 'custom', label: 'Custom Anthropic-compatible', auth: 'dynamic', protocol: 'anthropic_messages', protocols: ['anthropic_messages'], custom: true, core: true },

  // Codex-VL (fork Vivling, Responses). OpenAI Responses e' l'unica wire API
  // remota custom. Ora precede codex (client primario del fork) in prima
  // apparizione: il seed cambia ordine (non insieme) rispetto a 0.8.55.
  { id: 'codex-vl.native', client: 'codex-vl', provider: 'native', label: 'OpenAI / ChatGPT account', auth: 'login', endpoint: 'OpenAI account', protocol: 'openai_responses', default: true, core: true },
  { id: 'codex-vl.alibaba-token-plan', client: 'codex-vl', provider: 'alibaba-token-plan', label: 'Alibaba Token Plan Personal', auth: 'ALIBABA_CODE_API_KEY', endpoint: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', protocol: 'openai_responses', model: 'qwen3.8-max', models: ALIBABA_CODEX_MODELS, strictModels: true, core: true, notice: 'alibaba-token-plan' },
  { id: 'codex-vl.opencode-go', client: 'codex-vl', provider: 'opencode-go', label: 'OpenCode Go', auth: 'OPENCODE_API_KEY', endpoint: OPENCODE_GO_API_BASE, protocol: 'openai_responses', model: 'deepseek-v4-flash', models: OPENCODE_GO_RESPONSES_MODELS, strictModels: true, core: true },
  { id: 'codex-vl.openrouter', client: 'codex-vl', provider: 'openrouter', label: 'OpenRouter', auth: 'OPENROUTER_API_KEY', endpoint: 'https://openrouter.ai/api/v1', protocol: 'openai_responses', requiresModel: true, core: true, notice: 'codex-openrouter' },
  { id: 'codex-vl.ollama-cloud', client: 'codex-vl', provider: 'ollama-cloud', label: 'Ollama Cloud', auth: 'OLLAMA_API_KEY', endpoint: 'https://ollama.com/v1', protocol: 'openai_responses', model: 'glm-5.2', models: OLLAMA_CLOUD_MODELS, legacySecrets: true, core: true },
  { id: 'codex-vl.openai-api', client: 'codex-vl', provider: 'openai-api', label: 'OpenAI API', auth: 'OPENAI_API_KEY', endpoint: 'https://api.openai.com/v1', protocol: 'openai_responses', core: true },
  { id: 'codex-vl.ollama', client: 'codex-vl', provider: 'ollama', label: 'Ollama local', auth: 'none', endpoint: 'local provider', protocol: 'openai_responses', localProvider: 'ollama', core: true },
  { id: 'codex-vl.lmstudio', client: 'codex-vl', provider: 'lmstudio', label: 'LM Studio', auth: 'none', endpoint: 'local provider', protocol: 'openai_responses', localProvider: 'lmstudio', core: true },
  { id: 'codex-vl.custom', client: 'codex-vl', provider: 'custom', label: 'Custom Responses endpoint', auth: 'dynamic', protocol: 'openai_responses', protocols: ['openai_responses'], custom: true, core: true },

  // Codex (upstream OpenAI, Responses).
  { id: 'codex.native', client: 'codex', provider: 'native', label: 'OpenAI / ChatGPT account', auth: 'login', endpoint: 'OpenAI account', protocol: 'openai_responses', default: true, core: true },
  { id: 'codex.openai-api', client: 'codex', provider: 'openai-api', label: 'OpenAI API', auth: 'OPENAI_API_KEY', endpoint: 'https://api.openai.com/v1', protocol: 'openai_responses', core: true },
  { id: 'codex.ollama-cloud', client: 'codex', provider: 'ollama-cloud', label: 'Ollama Cloud', auth: 'OLLAMA_API_KEY', endpoint: 'https://ollama.com/v1', protocol: 'openai_responses', model: 'glm-5.2', models: OLLAMA_CLOUD_MODELS, legacySecrets: true, core: true },
  { id: 'codex.ollama', client: 'codex', provider: 'ollama', label: 'Ollama local', auth: 'none', endpoint: 'local provider', protocol: 'openai_responses', localProvider: 'ollama', core: true },
  { id: 'codex.lmstudio', client: 'codex', provider: 'lmstudio', label: 'LM Studio', auth: 'none', endpoint: 'local provider', protocol: 'openai_responses', localProvider: 'lmstudio', core: true },
  { id: 'codex.custom', client: 'codex', provider: 'custom', label: 'Custom Responses endpoint', auth: 'dynamic', protocol: 'openai_responses', protocols: ['openai_responses'], custom: true, core: true },

  // Grok Build (xai-org/grok-build): Rust TUI, auth delegata al login del CLI
  // (browser/API key/device-code). NexusCrew NON legge ne' copia credenziali:
  // auth 'login', nessun env provider, nessun token su argv. Come Agy/Kimi non
  // e' un default seed: backfill platform-aware (builtin.js) su Linux/macOS
  // non-Termux; su Termux resta fuori finche' non c'e' uno smoke sul device
  // (il binario aarch64 ufficiale e' statico, promettente ma non provato).
  // Nessun remote-control NexusCrew (rc assente), come agy/kimi. permission
  // default 'standard'; unsafe -> --always-approve (flag reale di `grok`).
  { id: 'grok.native', client: 'grok', provider: 'native', label: 'Grok account (CLI login)', auth: 'login', protocol: 'grok_native', core: true },

  // VL/Vivling (repository `vl`): runtime TUI locale. Auth propria del runtime
  // in OGNI variante (config.toml / VL_API_KEY): NexusCrew non legge ne' copia
  // credenziali (auth 'none') — la chiave, dove serve, sale per NOME via
  // envPassthrough (D3), mai come valore, mai su argv. vl.native e' «usa la tua
  // configurazione»: NESSUNA env provider/base_url, perche' i default interni del
  // runtime sono gia' openai-compat + localhost:11434 e le VL_* ambientali
  // sovrascrivono il config.toml (comporle qui cancellerebbe default_profile in
  // silenzio). Le varianti remote compongono SEMPRE la coppia: la' la variante
  // e' la scelta. Il modello scelto nella UI viaggia via VL_MODEL, il prompt di
  // cella via VL_SYSTEM_APPEND_FILE (gate 0.3.1); `vl --profile` esiste ma resta
  // dell'operatore. Backfill idempotente pattern Kimi (NESSUN platform gate);
  // standard-only in ogni variante. Non e' un default seed; nessun remote-control.
  { id: 'vl.native', client: 'vl', provider: 'native', label: 'VL', auth: 'none', protocol: 'vl_native', core: true },
  // Destinazione unica e sensata: l'API Anthropic vera. La chiave sale per nome:
  // chi non ha VL_API_KEY in nessuna credential source vede la cella rifiutarsi
  // col motivo che la nomina, non partire muta. (Il runtime rifiuta da solo anche
  // i subscription token, fail-closed sul backend nativo.)
  { id: 'vl.anthropic', client: 'vl', provider: 'anthropic', label: 'Anthropic', auth: 'none', endpoint: 'https://api.anthropic.com', protocol: 'vl_native', vlProvider: 'anthropic', envPassthrough: ['VL_API_KEY'], core: true },
  // Endpoint dichiarato dall'operatore. I protocolli sono ESATTAMENTE i tre
  // provider che il runtime parla (anthropic | anthropic-bearer | openai-compat,
  // vivling config/mod.rs): una voce che porti a un dialetto inesistente e'
  // peggio che non averla. Per anthropic-bearer l'endpoint e' obbligatorio per
  // costruzione (baseUrl del custom): un default spedirebbe un bearer token
  // all'API vera di Anthropic. La chiave resta opt-in per nome (envPassthrough):
  // un custom verso Ollama remoto senza auth non dichiara nulla.
  { id: 'vl.custom', client: 'vl', provider: 'custom', label: 'Custom endpoint', auth: 'dynamic', protocol: 'openai-compat', protocols: ['anthropic', 'anthropic-bearer', 'openai-compat'], custom: true, core: true },

  // Pi usa i suoi provider ID reali direttamente. I provider OAuth non
  // richiedono env key.
  { id: 'pi.native', client: 'pi', provider: 'native', label: 'Pi configured default', auth: 'login', protocol: 'pi_native', default: true, core: true },
  { id: 'pi.alibaba-token-plan', client: 'pi', provider: 'alibaba-token-plan', label: 'Alibaba Token Plan Personal', auth: 'ALIBABA_CODE_API_KEY', endpoint: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', protocol: 'openai-completions', model: 'qwen3.8-max', models: ALIBABA_TOKEN_PLAN_MODELS, strictModels: true, piProvider: 'alibaba-token-plan', piExtension: { baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', models: ALIBABA_PI_MODELS }, delegatePiAuth: false, core: true, notice: 'alibaba-token-plan' },
  { id: 'pi.zai', client: 'pi', provider: 'zai', label: 'Z.AI', auth: 'ZAI_API_KEY', protocol: 'pi_native', piProvider: 'zai', core: true },
  // Su Pi la wire e' Chat Completions, la piu' ampia delle tre: e' l'unico
  // percorso verso Kimi, DeepSeek Pro, MiMo e Hy3, che da Claude e Codex-VL
  // oggi non sono raggiungibili. Il contextWindow dei modelli non e' misurato:
  // l'estensione generata usa il default conservativo finche' non esiste lo
  // snapshot models.dev.
  //
  // `delegatePiAuth: false` come per alibaba-token-plan, e per la stessa
  // ragione: la delega vale per i provider che Pi conosce nativamente e
  // risolve dal proprio store di login. OpenCode Go non e' fra quelli — esiste
  // solo come estensione generata il cui apiKey e' `$OPENCODE_API_KEY`, che
  // senza NexusCrew non e' valorizzato. Delegando, la cella risulterebbe
  // configurata senza chiave e fallirebbe al primo uso.
  { id: 'pi.opencode-go', client: 'pi', provider: 'opencode-go', label: 'OpenCode Go', auth: 'OPENCODE_API_KEY', endpoint: OPENCODE_GO_API_BASE, protocol: 'openai-completions', model: 'deepseek-v4-flash', models: OPENCODE_GO_CHAT_MODELS, strictModels: true, piProvider: 'opencode-go', piExtension: { baseUrl: OPENCODE_GO_API_BASE, models: OPENCODE_GO_PI_MODELS }, delegatePiAuth: false, core: true },
  { id: 'pi.anthropic', client: 'pi', provider: 'anthropic', label: 'Anthropic', auth: 'ANTHROPIC_API_KEY', protocol: 'pi_native', piProvider: 'anthropic', core: true },
  { id: 'pi.openai', client: 'pi', provider: 'openai', label: 'OpenAI API', auth: 'OPENAI_API_KEY', protocol: 'pi_native', piProvider: 'openai', core: true },
  { id: 'pi.openai-codex', client: 'pi', provider: 'openai-codex', label: 'OpenAI Codex OAuth', auth: 'login', protocol: 'pi_native', piProvider: 'openai-codex', core: true },
  { id: 'pi.google', client: 'pi', provider: 'google', label: 'Google Gemini', auth: 'GEMINI_API_KEY', protocol: 'pi_native', piProvider: 'google', core: true },
  { id: 'pi.openrouter', client: 'pi', provider: 'openrouter', label: 'OpenRouter', auth: 'OPENROUTER_API_KEY', protocol: 'pi_native', piProvider: 'openrouter', core: true },
  { id: 'pi.github-copilot', client: 'pi', provider: 'github-copilot', label: 'GitHub Copilot', auth: 'login', protocol: 'pi_native', piProvider: 'github-copilot', core: true },
  { id: 'pi.deepseek', client: 'pi', provider: 'deepseek', label: 'DeepSeek', auth: 'DEEPSEEK_API_KEY', protocol: 'pi_native', piProvider: 'deepseek', core: true },
  // Provider Pi NON core: restano fuori dal catalogo UI (publicCatalog filtra
  // core/default/custom), in attesa di una decisione di progetto. Vengono risolti solo da
  // configurazione esistente via profileFor. Etichette senza prefisso "Pi · ".
  { id: 'pi.fireworks', client: 'pi', provider: 'fireworks', label: 'Fireworks AI', auth: 'FIREWORKS_API_KEY', protocol: 'pi_native', piProvider: 'fireworks' },
  { id: 'pi.huggingface', client: 'pi', provider: 'huggingface', label: 'Hugging Face', auth: 'HF_TOKEN', protocol: 'pi_native', piProvider: 'huggingface' },
  { id: 'pi.minimax', client: 'pi', provider: 'minimax', label: 'MiniMax', auth: 'MINIMAX_API_KEY', protocol: 'pi_native', piProvider: 'minimax' },
  { id: 'pi.kimi-coding', client: 'pi', provider: 'kimi-coding', label: 'Kimi For Coding', auth: 'KIMI_API_KEY', protocol: 'pi_native', piProvider: 'kimi-coding' },
  { id: 'pi.mistral', client: 'pi', provider: 'mistral', label: 'Mistral', auth: 'MISTRAL_API_KEY', protocol: 'pi_native', piProvider: 'mistral' },
  { id: 'pi.together', client: 'pi', provider: 'together', label: 'Together AI', auth: 'TOGETHER_API_KEY', protocol: 'pi_native', piProvider: 'together' },
  { id: 'pi.ollama', client: 'pi', provider: 'ollama', label: 'Ollama local', auth: 'none', protocol: 'openai-completions', piProvider: 'ollama', requiresModel: true, core: true, piExtension: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama' } },
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

  // Device-local shell. Resta l'ultimo client (anche fra i default): il seed la
  // preseleziona come engine di fallback, mai come primaria, e cosi' non sposta
  // l'engine preselezionato per una cella appena creata (claude.native primo).
  { id: 'shell.local', client: 'shell', provider: 'local', label: 'Shell', auth: 'none', protocol: 'shell', default: true, core: true },

  // --- Sezione legacy --------------------------------------------------------
  // Compatibilita' sola lettura/launch per configurazioni 0.8.0: mai nel catalogo
  // UI (publicCatalog filtra `legacy`). Risolti solo da profileFor/normalizeManagedSpec.
  { id: 'claude.zai-a', client: 'claude', provider: 'zai', credentialProfile: 'a', label: 'Z.AI legacy profile', auth: 'ZAI_API_KEY_A', endpoint: 'https://api.z.ai/api/anthropic', protocol: 'anthropic_messages', model: 'glm-5.3[1m]', models: ['glm-5.3[1m]', 'glm-5.2[1m]'], legacySecrets: true, legacyProvider: 'zai-a', legacy: true },
  { id: 'claude.zai-p', client: 'claude', provider: 'zai', credentialProfile: 'p', label: 'Z.AI legacy profile', auth: 'ZAI_API_KEY_P', endpoint: 'https://api.z.ai/api/anthropic', protocol: 'anthropic_messages', model: 'glm-5.3[1m]', models: ['glm-5.3[1m]', 'glm-5.2[1m]'], legacySecrets: true, legacyProvider: 'zai-p', legacy: true },
]);

function profileFor(client, provider, credentialProfile) {
  return CATALOG.find((p) => p.client === client && p.provider === provider
    && (p.credentialProfile || '') === (credentialProfile || '')) || null;
}

// D3: validazione unica dell'allowlist envPassthrough (nomi, mai valori): la
// usano sia la dichiarazione dell'operatore sia il default portato dal profilo
// del catalogo, cosi' i due percorsi non possono divergere sui vincoli.
function sanitizeEnvPassthrough(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_ENV_PASSTHROUGH) return null;
  const seen = new Set();
  const names = [];
  for (const raw of list) {
    if (typeof raw !== 'string') return null;
    const name = raw.trim();
    if (!ENV_KEY_RE.test(name) || seen.has(name)) return null;
    seen.add(name);
    names.push(name);
  }
  return names;
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
  // vl e' standard-only: il CLI Vivling non ha flag di approvazione, quindi
  // 'unsafe' non ha controparte argv e va rifiutato (fail-closed), come pi/shell.
  if ((value.client === 'pi' || value.client === 'shell' || value.client === 'vl') && permissionPolicy !== 'standard') return null;
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
    // vl: la chiave NON viaggia come envKey copiata dallo store (pattern degli
    // altri client) ma per NOME via envPassthrough (D3) — un custom vl verso un
    // endpoint senza auth (Ollama remoto) non dichiara nessuna chiave, quindi
    // envKey vuota e' legittima solo per vl. Se dichiarata, resta un nome valido.
    if (profile.client === 'vl' ? (envKey !== '' && !ENV_KEY_RE.test(envKey)) : !ENV_KEY_RE.test(envKey)) return null;
    if (!PROVIDER_ID_RE.test(providerId)) return null;
    if (!model || !(profile.protocols || [profile.protocol]).includes(protocol)) return null;
    Object.assign(out, { displayName, baseUrl, ...(envKey ? { envKey } : {}), protocol, providerId });
  }
  // D3: envPassthrough e' un'allowlist di NOMI di variabili d'ambiente che il
  // child deve ricevere, risolti a runtime dalle credentialSources (dopo i rami
  // provider in resolveManagedEngine). E' opt-in e per nome: MAI un passthrough
  // in blocco dell'ambiente, solo i nomi elencati — ciascuno un nome env valido.
  // E il mezzo con cui una cella vl (auth 'none', ramo senza env provider) riceve
  // le variabili che il suo runtime legge: il nome non e' fisso nel codice vl
  // (vivling/src/main.rs), quindi lo dichiara l'operatore che conosce la sua config.
  if (value.envPassthrough !== undefined) {
    const names = sanitizeEnvPassthrough(value.envPassthrough);
    if (!names) return null;
    out.envPassthrough = names;
  } else if (Array.isArray(profile.envPassthrough) && profile.envPassthrough.length) {
    // Il profilo puo' portare NOMI di default (es. vl.anthropic dichiara
    // VL_API_KEY): la dichiarazione dell'operatore vince, e il default passa
    // per la stessa validazione — una voce di catalogo malformata si rifiuta
    // da sola invece di partire con nomi spurii.
    const names = sanitizeEnvPassthrough(profile.envPassthrough);
    if (!names) return null;
    out.envPassthrough = names;
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

// Engine Grok Build per il backfill platform-aware (builtin.js): standard di
// default, auth delegata al login locale del CLI, niente remote-control. Non e'
// un default seed (come Agy).
function defaultGrokEngine() {
  const profile = CATALOG.find((entry) => entry.id === 'grok.native');
  return {
    id: profile.id,
    label: CLIENT_LABELS.grok,
    rc: false,
    managed: { client: 'grok', provider: 'native', model: '', permissionPolicy: 'standard' },
  };
}

// Engine VL/Vivling per il backfill (builtin.js, pattern Kimi senza platform
// gate): runtime locale standard-only, auth propria del runtime, niente
// remote-control. Non e' un default seed.
function defaultVlEngine() {
  const profile = CATALOG.find((entry) => entry.id === 'vl.native');
  return {
    id: profile.id,
    label: CLIENT_LABELS.vl,
    rc: false,
    managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
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

// `out.blocked` (accumulatore opzionale) raccoglie i file CHE ESISTONO ma non si
// sono potuti leggere/verificare (EACCES/ELOOP/ENOTDIR/EIO...). I rifiuti
// deliberati (symlink fuori roots, mode/uid/size non validi) restano `return {}`
// espliciti — sono legittimi "questo file non e' una credenziale valida" — e NON
// finiscono nei blocked. ENOENT nel catch e' "il file non c'e'" (legittimo, niente
// valore); solo gli altri code sono "non ho potuto guardare", e vanno distinti dal
// "missing" che il caller altrimenti riporterebbe per una credenziale presente ma
// illeggibile. Il verdetto (niente valori estratti -> {}) e' invariato; il
// discriminante e' CHI ha fallito, non che ci sia stata un'eccezione.
function parseEnvFile(file, opts = {}, out) {
  const blocked = Array.isArray(out && out.blocked) ? out.blocked : null;
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
  } catch (e) {
    if (blocked && e.code !== 'ENOENT') blocked.push({ path: file, code: e.code || e.constructor.name });
    return {};
  }
}

function parseProviderShellFile(file, out) {
  const blocked = Array.isArray(out && out.blocked) ? out.blocked : null;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o022) || st.size > 256 * 1024) return {};
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return {};
    return parseAssignments(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (blocked && e.code !== 'ENOENT') blocked.push({ path: file, code: e.code || e.constructor.name });
    return {};
  }
}

function binaryCandidates(client, home) {
  const prefix = process.env.PREFIX || '';
  const bin = client;
  // grok-build installa in ~/.grok/bin (path non standard): cercato prima dei
  // soliti PATH, poi fallback sui path generici (es. symlink in ~/.local/bin).
  const extra = client === 'grok' ? [path.join(home, '.grok', 'bin', bin)] : [];
  return [...new Set([
    ...extra,
    path.join(home, '.local', 'bin', bin), path.join(path.dirname(process.execPath), bin),
    `/usr/local/bin/${bin}`, `/opt/homebrew/bin/${bin}`,
    prefix && path.join(prefix, 'bin', bin),
  ].filter(Boolean))];
}

// `out.blocked` (accumulatore opzionale) raccoglie i candidati CHE ESISTONO come
// nome nel PATH ma che non si sono potuti VERIFICARE (EACCES/ELOOP/ENOTDIR...),
// non i candidati assenti (ENOENT = legittimo "prossimo"). Il verdetto del caller
// non cambia: findBinary torna comunque null se nessun candidato e' confermato
// (non possiamo dichiararlo "trovato"); ma chi costruisce il messaggio
// (describeManaged) puo' ora distinguere "client non trovato" da "non ho potuto
// verificare un candidato" — il discriminante e' CHI ha fallito, non che ci sia
// stata un'eccezione. Stesso principio gia' applicato in checkTermuxExec (3134d2f).
function findBinary(client, home, out) {
  const blocked = Array.isArray(out && out.blocked) ? out.blocked : null;
  for (const candidate of binaryCandidates(client, home)) {
    try {
      const real = fs.realpathSync(candidate); const st = fs.lstatSync(real);
      if (!st.isFile() || !(st.mode & 0o100) || (st.mode & 0o002)) continue;
      if (typeof process.getuid === 'function' && st.uid !== process.getuid() && st.uid !== 0) continue;
      return real;
    } catch (e) {
      // ENOENT = il candidato non esiste (legittimo "prossimo"); qualsiasi altro
      // code (EACCES/ELOOP/ENOTDIR/EIO...) = "esiste ma non ho potuto guardarlo",
      // e va distinto dal "non trovato" finale, non collassato in "prossimo".
      if (blocked && e.code !== 'ENOENT') blocked.push({ path: candidate, code: e.code || e.constructor.name });
    }
  }
  return null;
}

// Resolve a device-local interactive shell without persisting a path in
// fleet.json. Candidates are ordered and fail closed. Symlinks are resolved
// first, then the existing command trust policy is applied to the real file.
function resolveInteractiveShell(cfg = {}, out) {
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
  const blocked = Array.isArray(out && out.blocked) ? out.blocked : null;
  for (const candidate of [...new Set(candidates)]) {
    try {
      const real = fs.realpathSync(candidate);
      if (validate(real).ok) return real;
    } catch (e) {
      // ENOENT = il candidato non esiste (legittimo "prossimo"); altro code
      // (EACCES/ELOOP/ENOTDIR...) = "non ho potuto verificare", da distinguere
      // dal "nessuna shell" finale. validate() che torna ok:false NON e' un
      // throw: e' un rifiuto legittimo (candidato presente ma non fidato), resta
      // "prossimo" senza finire nei blocked — il discriminante e' CHI ha fallito.
      if (blocked && e.code !== 'ENOENT') blocked.push({ path: candidate, code: e.code || e.constructor.name });
    }
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

function parseProviderKeyFiles(cfg, home, out) {
  const values = {};
  // Match providers.zsh ordering: a later secure file may intentionally
  // override the canonical ai.env value. Files remain data-only and must be
  // private regular files owned by the NexusCrew user.
  const files = providerKeyPaths(cfg, home);
  const roots = [...new Set(files.map((file) => path.dirname(path.resolve(file))))];
  for (const file of files) Object.assign(values, parseEnvFile(file, { allowSymlinkRoots: roots }, out));
  return values;
}

// `trackLegacy`: il file legacy viene letto sempre, ma e' una FONTE solo per i
// profili con legacySecrets. Tracciarne l'illeggibilita' anche per gli altri
// produce un messaggio che manda l'operatore a sistemare un permesso
// irrilevante — «non verificabile» su un file che per quella chiave non conta
// nulla, mentre la chiave e' davvero assente. Il tracciamento segue la fonte,
// non la lettura.
function credentialSources(cfg, home, out, { trackLegacy = true } = {}) {
  let local = {};
  try { local = readCredentialStore(cfg, home); } catch (_) { /* unsafe/corrupt store is ignored, never trusted */ }
  return {
    runtime: cfg.env || process.env,
    local,
    shell: parseProviderShellFile(shellProvidersPath(cfg, home), out),
    keys: parseProviderKeyFiles(cfg, home, out),
    legacy: parseEnvFile(secretsPath(cfg, home), {}, trackLegacy ? out : undefined),
  };
}

function credential(profile, spec, cfg, home, out) {
  if (profile.auth === 'login' || profile.auth === 'none') return { envKey: profile.auth, value: '', source: profile.auth };
  const envKey = profile.auth === 'dynamic' ? spec.envKey : profile.auth;
  const policy = spec && CREDENTIAL_SOURCES.includes(spec.credentialSourcePolicy) ? spec.credentialSourcePolicy : 'auto';
  const sources = credentialSources(cfg, home, out, { trackLegacy: !!profile.legacySecrets });
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
  // auto: nessuna fonte ha la chiave. Se un file credenziale esiste ma non si
  // e' potuto leggere (EACCES/ELOOP...), non possiamo dichiarare la chiave
  // "missing" (che implica "mettila su questo device"): e' "unreadable", non
  // verificata. Il verdetto (niente valore -> authConfigured false) e' invariato;
  // il messaggio di describeManaged lo distingue. environment/nexuscrew-store
  // sopra restano 'missing': le loro fonti (runtime env / local store) non
  // passano per i file parseEnvFile/parseProviderShellFile che tracciamo qui.
  const unreadable = out && Array.isArray(out.blocked) && out.blocked.length;
  return { envKey, value: '', source: unreadable ? 'unreadable' : 'missing' };
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
  if (!normalized) {
    // D2: il rifiuto resta (i descrittori NON appartengono al profilo di una
    // cella: vengono dalla definizione dell'ENGINE, in `d.models` — due
    // soggetti diversi, mescolarli renderebbe ambiguo chi dichiara cosa). Ma
    // se la causa e' proprio questa, il messaggio generico "invalid managed
    // profile" manda a cercare ovunque tranne che nel posto giusto: dice
    // dove i descrittori vanno davvero.
    if (spec && typeof spec === 'object' && !Array.isArray(spec)
      && Object.prototype.hasOwnProperty.call(spec, 'models')) {
      return {
        configured: false,
        reason: '"models" non e\' un campo del profilo managed della cella — i descrittori dei modelli si dichiarano nella definizione dell\'ENGINE, nell\'array "models" del documento (schemaVersion/engines/cells/models), non qui',
      };
    }
    return { configured: false, reason: 'invalid managed profile' };
  }
  const home = cfg.home || require('node:os').homedir();
  const profile = profileFor(normalized.client, normalized.provider, normalized.credentialProfile || '');
  // Tracciamento di candidati (binary) e file credenziali che ESISTONO ma non
  // si sono potuti VERIFICARE (EACCES/ELOOP/ENOTDIR...). Il verdetto
  // (configured/authConfigured) non cambia: il discriminante e' CHI ha fallito,
  // non che ci sia stata un'eccezione. ENOENT = legittimo "non c'e'"; altro code
  // = "non ho potuto guardare", e il messaggio deve dirlo invece di collassarlo
  // in "not found" / "missing" (la stessa forma gia' chiusa in checkTermuxExec).
  const binaryBlocked = [];
  const credBlocked = [];
  const binary = normalized.client === 'shell'
    ? resolveInteractiveShell({ ...cfg, home }, { blocked: binaryBlocked })
    : findBinary(normalized.client, home, { blocked: binaryBlocked });
  const cred = credential(profile, normalized, cfg, home, { blocked: credBlocked });
  // Pi can resolve credentials from its own documented /login auth store. Do
  // not inspect or copy that store; delegate native-provider auth to Pi.
  const delegatedPiAuth = profile.client === 'pi' && profile.provider !== 'custom'
    && profile.delegatePiAuth !== false;
  // vl: l'autenticazione e' del runtime in OGNI variante (auth 'none', o chiave
  // che sale per NOME via envPassthrough/D3 quando il profilo la dichiara). Il
  // verdetto configured non puo' dipendere da una credenziale che NexusCrew non
  // possiede: il fail-closed giusto e' quello del D3, che NOMINA il nome mancante.
  const authConfigured = delegatedPiAuth || profile.auth === 'login' || profile.auth === 'none'
    || profile.client === 'vl' || !!cred.value;
  let configured = !!binary && authConfigured;
  let reason;
  if (!binary) {
    reason = binaryBlocked.length
      ? `client ${profile.client} not confirmed: ${binaryBlocked.length === 1 ? 'a candidate could not be verified' : 'some candidates could not be verified'} (${binaryBlocked.map((b) => `${b.path} (${b.code})`).join('; ')}) — not "absent"`
      : `client ${profile.client} not found`;
  } else if (!authConfigured) {
    reason = cred.source === 'unreadable'
      ? `credential ${cred.envKey} not verifiable (file present but unreadable: ${credBlocked.map((b) => `${b.path} (${b.code})`).join('; ')}) — not "missing"`
      : `credential ${cred.envKey} missing — set it on this device`;
  } else {
    reason = 'ready';
  }
  // Agy e grok sono client primari supportati solo su Linux/macOS non-Termux.
  // Rilevazione Termux via termuxRuntimePaths (non solo process.platform): un
  // Node che riporta 'linux' sotto proot/Termux viene comunque intercettato.
  if (normalized.client === 'agy' || normalized.client === 'grok') {
    const platform = cfg.platform || process.platform;
    const termux = platform === 'android' || termuxRuntimePaths(cfg.env || process.env, { platform, home }) !== null;
    if (termux || (platform !== 'linux' && platform !== 'darwin')) {
      configured = false;
      reason = `${normalized.client} non supportato su questa piattaforma (usa shell.local con command ${normalized.client})`;
    }
  }
  return {
    client: profile.client, clientLabel: CLIENT_LABELS[profile.client], provider: profile.provider,
    credentialProfile: normalized.credentialProfile || '', model: normalized.model,
    permissionPolicy: normalized.permissionPolicy, protocol: normalized.protocol || profile.protocol,
    endpoint: normalized.baseUrl || profile.endpoint || '', auth: cred.envKey, authConfigured,
    credentialSourcePolicy: normalized.credentialSourcePolicy || 'auto',
    // cred.source e' gia' 'missing' quando non c'e' valore: non serve il
    // ternario che lo forzava. Cosi' una credenziale presente ma illeggibile
    // (source 'unreadable', authConfigured false) non viene collassata in
    // 'missing' — il discriminante e' CHI ha fallito, non il esito grezzo.
    credentialSource: cred.source,
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
  const cred = credential(profile, {}, cfg, home, { blocked: [] });
  return {
    envKey: cred.envKey,
    authConfigured: !!cred.value,
    // cred.source e' gia' 'missing' quando non c'e' valore: non serve il
    // ternario che lo forzava. Cosi' una credenziale presente ma illeggibile
    // (source 'unreadable') non viene collassata in 'missing'.
    credentialSource: cred.source,
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

// D2 audit: il file .ts generato NON e' il consumatore — Pi lo E'. Un test che
// legge solo il file resta verde su un'estensione che Pi rifiuta a runtime.
// CONTRATTO REALE che Pi (@earendil-works/pi-coding-agent 0.80.10) impone a
// ogni modello di `pi.registerProvider(id, {models: [...]})` — fonte:
// core/extensions/types.d.ts, interface ProviderModelConfig (JSDoc del pacchetto
// installato, non dedotto). Campi OBBLIGATORI: id, name, reasoning, input
// (array "text"|"image"), cost ({input,output,cacheRead,cacheWrite}),
// contextWindow, maxTokens. `input` mancante fa THROW dentro Pi la prima volta
// che un tool consulta le capability del modello (es. core/tools/read.js:
// `model.input.includes("image")` — TypeError su undefined, misurato e
// riprodotto con il modulo Pi reale). I descrittori grezzi dichiarati
// dall'operatore in `d.models` (via parseModel: id, engine, label?,
// contextWindow, maxTokens, reasoning) NON hanno name/input/cost — vanno
// arricchiti PRIMA di finire nell'estensione, mai passati cosi' come sono.
function toPiModelConfig(m) {
  return {
    id: m.id,
    name: m.label || m.id,
    reasoning: m.reasoning === true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow || 128000,
    maxTokens: m.maxTokens || 16384,
  };
}

// D2: `declaredModels` (opzionale) sono i descrittori dichiarati per l'ENGINE
// (via declaredModelsFor), per il ramo Pi CUSTOM — stesso motivo/stessa fonte
// di customCatalogFor, mai letti da `spec.models`. Il ramo Pi NON-custom
// (profile.piExtension) continua a passare `models` dentro l'oggetto spec-like
// come sempre: e' un catalogo STATICO cablato nel codice (es. alibaba-token-
// plan), GIA' nella forma completa che Pi si aspetta — un caso diverso, non
// toccato dal difetto D2. declaredModels, quando presente, ha priorita', ed e'
// sempre passato per toPiModelConfig (mai i descrittori grezzi cosi' come sono).
function writePiProviderExtension(spec, home, declaredModels) {
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
    models: (Array.isArray(declaredModels) && declaredModels.length ? declaredModels.map(toPiModelConfig)
      : (Array.isArray(spec.models) && spec.models.length ? spec.models : null)) || [{
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

// V-69 — prompt per-cella per il runtime vl. Dalla 0.3.1 vl legge
// VL_SYSTEM_APPEND_FILE e COMPONE il file sul proprio system (VL_SYSTEM resta
// «sostituisci» e non si tocca: un wrapper vivo dipende da quel significato).
// Il file porta il prompt della cella e le istruzioni companion MCP: vl non ha
// client MCP, quello e' l'unico punto in cui il testo lo raggiunge. Stessa
// forma e stesso posto di writePiProviderExtension: generato sotto
// ~/.nexuscrew, atomico (tmp+rename), mai credenziali — il contenuto e'
// cell.prompt piu' testo statico, nessun valore letto dalle sorgenti
// credenziali. Il require e' volutamente lazy: companionInstructions vive nel
// server MCP, che trascina config/auth/audio; managed.js e' caricato da tutto
// il fleet e non deve pagarselo a ogni load.
function writeVlCellPrompt(cell, home) {
  // cell.id e' gia' validato (CELL_ID_RE, definitions.js), ma qui si difende
  // da solo e PER PRIMO: '.' e '..' passano quella RE e come nome file sono
  // traversal — un path non si costruisce da un id senza escluderli, e il
  // rifiuto avviene prima di toccare il disco.
  const id = typeof cell?.id === 'string' ? cell.id : '';
  if (!id || id === '.' || id === '..' || id.includes('/')) throw new Error('unsafe vl cell id');
  // La difesa della directory e' safePrivateDir (gia' la regola vigente di
  // ~/.nexuscrew: contiene lo store credenziali), su ENTRAMBI i livelli —
  // difendere solo vl-prompts lascerebbe passare un symlink sul genitore e
  // scriverebbe altrove. Fallire qui degrada (dichiarato), non scrive.
  const base = path.join(home, '.nexuscrew');
  safePrivateDir(base, { create: true });
  const dir = path.join(base, 'vl-prompts');
  safePrivateDir(dir, { create: true });
  const target = path.join(dir, `${id}.md`);
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('refusing symlink vl cell prompt');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const { companionInstructions } = require('../mcp/server.js');
  const prompt = String(cell?.prompt || '').trim();
  const source = `${prompt ? `${prompt}\n\n` : ''}${companionInstructions()}\n`;
  const tmp = path.join(dir, `.${id}.${crypto.randomBytes(6).toString('hex')}.tmp`);
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

// Prima versione del runtime vl che legge VL_SYSTEM_APPEND_FILE. Sotto questa
// soglia la variabile e' ignorata IN SILENZIO (misurato: su 0.1.0 lo stesso
// comando tira dritto fino al controllo TTY; su 0.3.1 fallisce nominando il
// path) — quindi la promessa si fa solo se il binario sul nodo la puo'
// mantenere. Il confronto e' per campi, non per stringa: '0.10.0' > '0.3.1'.
const VL_SYSTEM_APPEND_MIN = [0, 3, 1];

// Probe della versione del binario vl sul nodo. `vl --version` esce subito
// (niente TUI); un timeout comunque difende dai binari che invece restano
// appesi. Il probe e' iniettabile via cfg.vlVersionProbe perche' i test non
// dipendano da un vl vero: torna l'output GREZZO di --version (o null quando
// il binario non risponde), il parse vive qui, cosi' il contratto del seam e'
// una stringa, non una versione parsata.
function vlBinaryVersionOutput(binary, cfg) {
  const probe = cfg && typeof cfg.vlVersionProbe === 'function' ? cfg.vlVersionProbe : null;
  if (probe) {
    const out = probe(binary);
    return out === null || out === undefined ? null : String(out);
  }
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000 });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout || ''}${r.stderr || ''}`;
}

// Gate del ramo vl: la append surface esiste solo dalla VL_SYSTEM_APPEND_MIN.
// Fallisce CHIUSO e DICHIARATO: una versione non determinabile non promette
// niente (niente env), ma la cella parte e il motivo sale con
// vlPromptDegraded — mai in silenzio, che e' il difetto che questo gate chiude.
function vlSystemAppendGate(binary, cfg) {
  const out = vlBinaryVersionOutput(binary, cfg);
  if (out === null) return { ok: false, reason: `versione di vl non determinabile (${binary} --version non risponde) — prompt di cella non consegnato` };
  const m = out.match(/\bvl\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!m) return { ok: false, reason: `versione di vl non riconosciuta da "${String(out).trim().slice(0, 60)}" — prompt di cella non consegnato` };
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i += 1) {
    if (v[i] !== VL_SYSTEM_APPEND_MIN[i]) {
      return v[i] > VL_SYSTEM_APPEND_MIN[i]
        ? { ok: true }
        : { ok: false, reason: `vl ${v.join('.')} < ${VL_SYSTEM_APPEND_MIN.join('.')}: VL_SYSTEM_APPEND_FILE ignorata dal runtime — prompt di cella non consegnato` };
    }
  }
  return { ok: true };
}

// D2 (fix definitivo — l'audit del pacchetto aveva bocciato la prima versione:
// il test costruiva `spec.models` a mano, e in produzione quel campo non
// esiste mai). `declaredModels` NON viene da `spec`: i descrittori sono
// proprieta' della definizione dell'ENGINE (`d.models` del documento), non del
// profilo managed della cella — due soggetti diversi. Il chiamante
// (resolveManagedEngine) li ricava con declaredModelsFor(extraModels,
// profile.id) e li passa qui espliciti, cosi' questa funzione non finge mai
// che `spec` porti qualcosa che semanticamente non gli appartiene.
// Deriva model_catalog_json e model_context_window dal descrittore, così Codex-VL
// non ricade sul fallback 272K (-73% finestra) con parallel tool call assenti.
// Se non ci sono descrittori dichiarati -> null (comportamento invariato,
// NESSUNA regressione per chi non li usa). NON consacra
// ~/.codex/custom_provider_model_catalog.json: era una patch locale di una
// singola installazione, non un contratto; il catalog è generato dai descrittori dichiarati
// in fleet.json. I valori enum/default rispecchiano i cataloghi spediti
// (validati dal test fleet-catalog-schema).
function customCatalogFor(spec, model, declaredModels, home) {
  const models = Array.isArray(declaredModels) ? declaredModels : [];
  if (!models.length) return null;
  const entry = models.find((m) => m && m.id === model) || models[0];
  const cat = {
    models: models.map((m) => {
      const reasoning = m.reasoning === true;
      return {
        slug: m.id,
        display_name: m.label || m.id,
        description: m.label || m.id,
        default_reasoning_level: reasoning ? 'high' : 'medium',
        supported_reasoning_levels: reasoning
          ? [{ effort: 'low', description: 'Fast responses with lighter reasoning' },
            { effort: 'high', description: 'Greater reasoning depth for complex problems' },
            { effort: 'max', description: 'Maximum reasoning depth' }]
          : [{ effort: 'low', description: 'Fast responses with lighter reasoning' },
            { effort: 'medium', description: 'Balanced reasoning depth' },
            { effort: 'high', description: 'Greater reasoning depth for complex problems' }],
        shell_type: 'default',
        visibility: 'list',
        supported_in_api: true,
        priority: 50,
        availability_nux: null,
        upgrade: null,
        base_instructions: '',
        supports_reasoning_summaries: true,
        default_reasoning_summary: 'none',
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: null,
        web_search_tool_type: 'text',
        truncation_policy: { mode: 'tokens', limit: m.maxTokens || m.contextWindow || 128000 },
        supports_parallel_tool_calls: false,
        supports_image_detail_original: false,
        context_window: m.contextWindow || 128000,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: ['text'],
        supports_search_tool: false,
      };
    }),
  };
  const dir = path.join(home, '.nexuscrew', 'custom-catalogs');
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('unsafe custom catalog directory');
  } catch (e) {
    if (e.code === 'ENOENT') fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    else throw e;
  }
  fs.chmodSync(dir, 0o700);
  const target = path.join(dir, `${spec.providerId}.json`);
  const tmp = path.join(dir, `.${spec.providerId}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(cat), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  return { catalogPath: target, contextWindow: entry.contextWindow || 128000 };
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
  // D2: i descrittori dichiarati per QUESTO profilo (client.provider — la
  // stessa chiave che declaredFor usa dentro normalizeManagedSpec per
  // validare gli id). Vengono dalla definizione dell'ENGINE (extraModels),
  // MAI da spec: e' il ponte che customCatalogFor/writePiProviderExtension
  // (rami custom) usano per emettere catalogo e finestra di contesto.
  const declaredModels = declaredModelsFor(cfg.extraModels, profile.id);
  const cred = credential(profile, spec, cfg, home);
  // L'override PER-CELLA va canonicalizzato come lo spec: `normalizeManagedSpec`
  // applica l'alias a `spec.model`, ma `cell.model` lo scavalca DOPO e senza
  // passare di li'. Senza questo, un nome legacy per-cella finisce in argv e in
  // env, e i rami di trattamento (che confrontano il nome nuovo) non scattano:
  // la cella parte, sembra a posto, e gira con i parametri sbagliati.
  const env = {}; const args = []; const model = canonicalModel(cell?.model || spec.model);
  // V-69: motivo per cui il prompt per-cella di vl NON e' stato composto
  // (versione del runtime che non regge, o file non scrivibile in sicurezza).
  // Stringa vuota = consegnato. Sale con l'engine risolto come vlPromptDegraded.
  let vlPromptDegraded = '';
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
  if (spec.client === 'pi' || spec.client === 'shell' || spec.client === 'vl') effectivePolicy = 'standard';
  info.permissionPolicy = effectivePolicy;
  if (effectivePolicy === 'unsafe') {
    if (spec.client === 'claude' || spec.client === 'agy') args.push('--dangerously-skip-permissions');
    if (spec.client === 'codex' || spec.client === 'codex-vl') args.push('--dangerously-bypass-approvals-and-sandbox');
    // Grok Build: unsafe -> --always-approve (flag reale di `grok`, "Auto-approve
    // all tool executions"; verificato su `grok --help`).
    if (spec.client === 'grok') args.push('--always-approve');
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
      // Effort massimo di default dove il modello lo sfrutta davvero. Per
      // GLM-5.3 la misura di Z.AI dice che alzando l'effort l'accuratezza sale
      // E i token per task scendono rispetto a 5.2: con una finestra a tempo,
      // spendere di piu' per chiamata rende di piu' per finestra.
      if (model === 'k3' || model === 'k3[1m]' || model.startsWith('glm-5.3')) {
        env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
        env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1';
      }
    } else if (spec.provider === 'opencode-go') {
      // Misurato il 2026-08-11: `POST /v1/messages` con `Authorization: Bearer`
      // risponde `401 AuthError: Missing API key`, con `x-api-key` risponde 200.
      // ANTHROPIC_API_KEY e' cio' che Claude Code manda come `x-api-key`, quindi
      // qui NON si usa la forma a token degli altri gateway.
      //
      Object.assign(env, {
        ANTHROPIC_BASE_URL: profile.endpoint,
        ANTHROPIC_API_KEY: cred.value,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_FABLE_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model,
        API_TIMEOUT_MS: '3000000',
      });
      // Il contesto si dichiara solo se il modello e' nella tabella: un id
      // fuori tabella non deve ereditare il numero di un altro modello, e
      // l'assenza fa ricadere il client sul proprio default.
      const opencodeContext = opencodeGoContextFor(model);
      if (opencodeContext) {
        env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(opencodeContext);
        env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(opencodeContext);
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
    } else if (spec.provider === 'opencode-go') {
      // Wire Responses nativa: il gateway espone `/v1/responses` e Codex-VL vi
      // aggiunge il path, quindi qui l'endpoint include gia' `/v1`.
      env.OPENCODE_API_KEY = cred.value;
      args.push(...codexProviderArgs('opencode_go', 'OpenCode Go', profile.endpoint, 'OPENCODE_API_KEY'));
      args.push('-c', 'model_providers.opencode_go.stream_idle_timeout_ms=600000');
      // Codex non conosce questi modelli: senza catalogo non ha i metadati di
      // contesto e ricade su un default suo. Il file copre le sole coppie
      // misurate sulla wire Responses; il context window accompagna il modello
      // selezionato ed e' omesso se l'id non e' in tabella.
      const opencodeContext = opencodeGoContextFor(model);
      if (opencodeContext) {
        const localCatalog = path.join(__dirname, 'catalogs', 'opencode-go.json');
        args.push('-c', `model_catalog_json=${JSON.stringify(localCatalog)}`);
        args.push('-c', `model_context_window=${opencodeContext}`);
      }
    } else if (spec.provider === 'custom') {
      env[spec.envKey] = cred.value;
      args.push(...codexProviderArgs(spec.providerId, spec.displayName, spec.baseUrl, spec.envKey));
      // D2: onora `models` (engine definition, già validato) come gli altri
      // provider — deriva model_catalog_json e model_context_window, così
      // Codex-VL non ricade sul fallback 272K. Senza `models` -> null (no regressione).
      const customMeta = customCatalogFor(spec, model, declaredModels, home);
      if (customMeta) {
        args.push('-c', `model_catalog_json=${JSON.stringify(customMeta.catalogPath)}`);
        args.push('-c', `model_context_window=${customMeta.contextWindow}`);
      }
    }
    if (model) args.push('-m', model);
  } else if (spec.client === 'pi') {
    if (profile.auth !== 'none' && profile.auth !== 'login' && cred.value) env[cred.envKey] = cred.value;
    if (spec.provider === 'custom') args.push('--extension', writePiProviderExtension(spec, home, declaredModels));
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
  } else if (spec.client === 'grok') {
    // Grok Build delega l'autenticazione al proprio login locale (auth 'login'):
    // niente env provider, niente credenziali su argv. `--model` prima del
    // prompt; il prompt e' bare posizionale (`grok [OPTIONS] [PROMPT]`), accodato
    // dal push generico qui sotto come ultimo argomento. Senza prompt parte il
    // TUI interattivo nella cwd della cella.
    if (model) args.push('--model', model);
  } else if (spec.client === 'vl') {
    // VL/Vivling runtime TUI: auth gestita dal runtime in ogni variante
    // (config.toml / VL_API_KEY per nome via envPassthrough, D3), mai
    // credenziali su argv. Il modello scelto nella UI viaggia via VL_MODEL
    // (V-69), il prompt di cella via file sul system del runtime
    // (VL_SYSTEM_APPEND_FILE, gate qui sotto); `vl --profile` esiste ma resta
    // dell'operatore. Nessun --model su argv: la TUI parte senza argomenti.
    if (model) env.VL_MODEL = model;
    // vl.native e' «usa la tua configurazione»: NESSUNA env provider/base_url.
    // I default interni del runtime sono gia' openai-compat + localhost:11434,
    // e le VL_* ambientali battono il config.toml — comporle qui non aggiunge
    // nulla e cancella in silenzio default_profile. Le varianti remote invece
    // compongono SEMPRE la coppia, anche senza modello: la' la variante e' la
    // scelta, e un fallback silenzioso manderebbe la cella altrove mentre la
    // UI dice il contrario.
    if (spec.provider === 'custom') {
      // il protocollo scelto nel custom E' il provider wire: il ramo custom di
      // normalizeManagedSpec ha gia' garantito che sia uno dei tre che il
      // runtime parla e che baseUrl esista (endpoint obbligatorio: un default
      // su anthropic-bearer spedirebbe un bearer all'API vera di Anthropic).
      env.VL_PROVIDER = spec.protocol;
      env.VL_BASE_URL = spec.baseUrl;
    } else if (spec.provider !== 'native') {
      // Variante remota: la coppia e' obbligatoria, non condizionale. Un profilo
      // senza vlProvider o endpoint non e' «un caso in cui non componiamo
      // nulla»: e' uno stato impossibile del catalogo che, degradando, manderebbe
      // la cella sui default interni (Ollama locale) mentre la UI dice il
      // contrario. Si rifiuta NOMINANDO il campo che manca — stessa forma del
      // fail-closed delle chiavi, che dice quale variabile manca, non «errore».
      if (!profile.vlProvider) {
        return { ok: false, info, reason: `vl profile ${profile.id}: campo vlProvider mancante — variante remota rifiutata invece di ricadere sui default locali in silenzio` };
      }
      if (!profile.endpoint) {
        return { ok: false, info, reason: `vl profile ${profile.id}: campo endpoint mancante — variante remota rifiutata invece di ricadere sui default locali in silenzio` };
      }
      env.VL_PROVIDER = profile.vlProvider;
      env.VL_BASE_URL = profile.endpoint;
    }
    // V-69 — prompt per-cella: file composto sul system del runtime
    // (VL_SYSTEM_APPEND_FILE). Il gate di versione sta nel codice, non nella
    // speranza: sotto la 0.3.1 la variabile e' ignorata in silenzio, e una
    // cella che parte senza il proprio prompt senza dirlo e' il difetto che
    // questo ramo chiude, non il rimedio. Degradare = NON comporre la env
    // (mai una promessa che il runtime scarta) + dichiarare il motivo.
    const gate = vlSystemAppendGate(info.binary, cfg);
    if (gate.ok) {
      try {
        env.VL_SYSTEM_APPEND_FILE = writeVlCellPrompt(cell, home);
      } catch (e) {
        vlPromptDegraded = `file del prompt di cella non scrivibile in sicurezza: ${e.message}`;
      }
    } else {
      vlPromptDegraded = gate.reason;
    }
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
  // vl e' una TUI senza superficie prompt (`vl [OPTIONS]`, nessun flag prompt):
  // non riceve MAI il prompt di cella su argv — dalla V-69 viaggia nel file
  // per-cella composto dal ramo vl (VL_SYSTEM_APPEND_FILE). send-keys non si
  // applica: il classifier di deliverBootstrapPrompt copre solo kimi/claude, e
  // vl parte subito senza attese.
  if (spec.client !== 'shell' && spec.client !== 'vl' && !promptViaDelivery && cell?.prompt) args.push(cell.prompt);
  // nexuscrew-store source: neutralize the profile's env set in the composed
  // child env (unset, never empty), so the runtime cannot leak credentials that
  // the local store is meant to own.
  applyStoreNeutralization(env, spec, profile);
  // D3: resolve envPassthrough AFTER the provider branches. Each declared name is
  // read from the credentialSources (same order as credential() 'auto': runtime
  // -> store -> shell -> key files -> legacy) and injected into the child env.
  // Per nome, mai in blocco. A name that is declared but absent from every source
  // fails CLOSED but not obscure: the reason names it, so a misconfigured cell
  // says what is missing instead of starting silent and breaking later. (vl.auth
  // is 'none': without this, the vl branch composes no provider env at all, yet
  // the runtime needs its own config vars — whose names are not fixed in the vl
  // binary, so the operator declares the ones their config uses.)
  if (spec.envPassthrough && spec.envPassthrough.length) {
    const sources = credentialSources(cfg, home);
    for (const name of spec.envPassthrough) {
      const value = sources.runtime[name] || sources.local[name] || sources.shell[name]
        || sources.keys[name] || sources.legacy[name];
      if (!value) {
        return { ok: false, info, reason: `envPassthrough name "${name}" is not set in any credential source (environment, nexuscrew-store, ${path.basename(shellProvidersPath(cfg, home))}, key files, legacy)` };
      }
      env[name] = value;
    }
  }
  let command = info.binary;
  if (needsExplicitNode(info.binary, cfg.platform || process.platform, cfg.env || process.env)) {
    command = cfg.nodeExecPath || process.execPath;
    args.unshift(info.binary);
  }
  return { ok: true, info, engine: {
    ...engine, command, args, env,
    promptMode: promptViaDelivery ? 'send-keys' : 'managed-argv', clientBinary: info.binary,
    ...(vlPromptDegraded ? { vlPromptDegraded } : {}),
    ...(spec.client === 'shell' ? { shellOneShot } : {}),
  } };
}

function publicCatalog() {
  return CATALOG.filter((p) => !p.legacy && (p.core || p.default || p.custom)).map((p) => ({
    id: p.id, client: p.client, clientLabel: CLIENT_LABELS[p.client], provider: p.provider,
    credentialProfile: p.credentialProfile || '', label: p.label, protocol: p.protocol,
    auth: p.auth, endpoint: p.endpoint || '', model: p.model || '', models: [...(p.models || [])],
    protocols: [...(p.protocols || [p.protocol])], supportsUnsafe: !['pi', 'shell', 'vl'].includes(p.client), requiresModel: !!p.requiresModel || !!p.custom,
    permissionPolicyDefault: p.client === 'claude' ? 'unsafe' : 'standard',
    // DEC2: solo il client claude riceve MCP gestito da NexusCrew (cellMcpArgs/
    // sharedMcpArgs nel ramo claude di resolveManagedEngine). Per ogni altro
    // client (codex, vl, kimi, pi, agy, grok) `cell.mcp` e' INERTE: la cella lo
    // accetta ma non ha effetto, perche' i server MCP li registra il client nel
    // proprio file di config nativo, non NexusCrew. La vista lo dice cosi' la
    // finestra puo' avvertire l'operatore NEL PUNTO in cui sceglie cell.mcp,
    // invece di confermare un no-op silenzioso.
    mcpManaged: p.client === 'claude',
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
  OPENCODE_GO_MESSAGES_MODELS, OPENCODE_GO_RESPONSES_MODELS, OPENCODE_GO_CHAT_MODELS, OPENCODE_GO_LIMITS,
  OPENCODE_GO_ANTHROPIC_ROOT, OPENCODE_GO_API_BASE,
  CLIENT_LABELS, normalizeManagedSpec, profileFor,
  defaultDefinitions, defaultShellEngine, defaultAgyEngine, defaultKimiEngine, defaultGrokEngine, defaultVlEngine, describeManaged, describeCatalogCredential, discoverOllamaModels, resolveManagedEngine, needsExplicitNode,
  discoverPiModels, EXTERNAL_DISCOVERY_TIMEOUT_MS, parseEnvFile, parseProviderShellFile, findBinary, publicCatalog, writePiProviderExtension, customCatalogFor,
  writeVlCellPrompt, vlSystemAppendGate,
  extraModelsFrom, declaredModelsFor,
  providerKeyPaths, parseProviderKeyFiles, credentialSources, credential, CREDENTIAL_SOURCE_VALUES,
  credentialEnvNeutralizeSet, applyStoreNeutralization,
  ensureKimiClaudeConfig, ensureAlibabaClaudeConfig, resolveInteractiveShell,
  shellLoginArgs, shellConfiguredCommandArgs, ENV_KEY_RE,
};
