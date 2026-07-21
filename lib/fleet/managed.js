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
const ALIBABA_TOKEN_PLAN_MODELS = Object.freeze([
  'qwen3.8-max-preview', 'qwen3.7-plus', 'qwen3.7-max',
  'qwen3.6-flash', 'glm-5.2', 'deepseek-v4-pro',
]);
const ALIBABA_CODEX_MODELS = Object.freeze([
  'qwen3.8-max-preview', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash',
]);
const ALIBABA_TOKEN_PLAN_CONTEXT = 983616;
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const ALIBABA_PI_MODELS = Object.freeze([
  Object.freeze({
    id: 'qwen3.8-max-preview', name: 'qwen3.8-max-preview', api: 'openai-responses',
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
const MANAGED_KEYS = new Set(['client', 'provider', 'credentialProfile', 'model', 'permissionPolicy', ...CUSTOM_KEYS]);
const CLIENT_LABELS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', 'codex-vl': 'Codex-VL', pi: 'Pi', shell: 'Shell' });
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
  { id: 'claude.alibaba-token-plan', client: 'claude', provider: 'alibaba-token-plan', label: 'Alibaba Token Plan Personal', auth: 'ALIBABA_CODE_API_KEY', endpoint: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic', protocol: 'anthropic_messages', model: 'qwen3.8-max-preview', models: ALIBABA_TOKEN_PLAN_MODELS, strictModels: true, core: true, notice: 'alibaba-token-plan' },
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
  { id: 'codex-vl.alibaba-token-plan', client: 'codex-vl', provider: 'alibaba-token-plan', label: 'Alibaba Token Plan Personal', auth: 'ALIBABA_CODE_API_KEY', endpoint: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', protocol: 'openai_responses', model: 'qwen3.8-max-preview', models: ALIBABA_CODEX_MODELS, strictModels: true, core: true, notice: 'alibaba-token-plan' },
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
  { id: 'pi.alibaba-token-plan', client: 'pi', provider: 'alibaba-token-plan', label: 'Alibaba Token Plan Personal', auth: 'ALIBABA_CODE_API_KEY', endpoint: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', protocol: 'openai-completions', model: 'qwen3.8-max-preview', models: ALIBABA_TOKEN_PLAN_MODELS, strictModels: true, piProvider: 'alibaba-token-plan', piExtension: { baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', models: ALIBABA_PI_MODELS }, delegatePiAuth: false, core: true, notice: 'alibaba-token-plan' },
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
]);

function profileFor(client, provider, credentialProfile) {
  return CATALOG.find((p) => p.client === client && p.provider === provider
    && (p.credentialProfile || '') === (credentialProfile || '')) || null;
}

function normalizeManagedSpec(value) {
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
  const model = value.model === undefined ? (profile.model || '') : value.model;
  if (typeof model !== 'string' || model.length > 128 || /[\x00-\x1f\x7f]/.test(model)) return null;
  if (value.client === 'shell' && model) return null;
  if (profile.requiresModel && !model) return null;
  if (profile.strictModels && !(profile.models || []).includes(model)) return null;
  const permissionPolicy = value.permissionPolicy === undefined ? (profile.client === 'claude' ? 'unsafe' : 'standard') : value.permissionPolicy;
  if (permissionPolicy !== 'standard' && permissionPolicy !== 'unsafe') return null;
  if ((value.client === 'pi' || value.client === 'shell') && permissionPolicy !== 'standard') return null;
  const out = { client: profile.client, provider: profile.provider, model, permissionPolicy };
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
  const sources = credentialSources(cfg, home);
  // The fixed shell file is already the user's environment source. Values are
  // consumed only in memory and passed to the selected child; never persisted
  // in fleet.json, service files, API responses or logs.
  if (sources.runtime[envKey]) return { envKey, value: sources.runtime[envKey], source: 'environment' };
  if (sources.local[envKey]) return { envKey, value: sources.local[envKey], source: 'local' };
  if (sources.shell[envKey]) return { envKey, value: sources.shell[envKey], source: 'compatibility' };
  if (sources.keys[envKey]) return { envKey, value: sources.keys[envKey], source: 'compatibility' };
  if (profile.legacySecrets && sources.legacy[envKey]) {
    return { envKey, value: sources.legacy[envKey], source: 'compatibility' };
  }
  return { envKey, value: '', source: 'missing' };
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

let piCache = { at: 0, providers: {} };
let piInFlight = null;
async function discoverPiModels(opts = {}) {
  const now = Date.now(); const ttl = opts.ttlMs === undefined ? 300000 : opts.ttlMs;
  if (!opts.noCache && Object.keys(piCache.providers).length && now - piCache.at < ttl) {
    return Object.fromEntries(Object.entries(piCache.providers).map(([k, v]) => [k, [...v]]));
  }
  const home = opts.home || require('node:os').homedir();
  const binary = opts.binary || findBinary('pi', home);
  if (!binary) return {};
  if (!opts.noCache && piInFlight) return piInFlight;
  const execFileImpl = opts.execFileImpl || execFile;
  const load = async () => {
    const stdout = await new Promise((resolve, reject) => {
      execFileImpl(binary, ['--list-models'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 }, (err, out) => {
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
    return Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, [...v]]));
  };
  if (opts.noCache) {
    try { return await load(); } catch (_) { return {}; }
  }
  piInFlight = load().catch(() => ({})).finally(() => { piInFlight = null; });
  return piInFlight;
}

function describeManaged(spec, cfg = {}) {
  const normalized = normalizeManagedSpec(spec);
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
  return {
    client: profile.client, clientLabel: CLIENT_LABELS[profile.client], provider: profile.provider,
    credentialProfile: normalized.credentialProfile || '', model: normalized.model,
    permissionPolicy: normalized.permissionPolicy, protocol: normalized.protocol || profile.protocol,
    endpoint: normalized.baseUrl || profile.endpoint || '', auth: cred.envKey, authConfigured,
    credentialSource: authConfigured ? cred.source : 'missing',
    configured: !!binary && authConfigured, models: [...(profile.models || [])], defaultModel: profile.model || '',
    binary: binary || '', displayName: normalized.displayName || profile.label,
    reason: !binary ? `client ${profile.client} not found` : (!authConfigured
      ? `credential ${cred.envKey} missing — set it on this device`
      : 'ready'),
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
  const spec = normalizeManagedSpec(engine.managed);
  const info = describeManaged(spec, cfg);
  if (!spec || !info.configured) return { ok: false, reason: info.reason, info };
  const home = cfg.home || require('node:os').homedir();
  const profile = profileFor(spec.client, spec.provider, spec.credentialProfile || '');
  const cred = credential(profile, spec, cfg, home);
  const env = {}; const args = []; const model = cell?.model || spec.model;
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
    if (spec.client === 'claude') args.push('--dangerously-skip-permissions');
    if (spec.client === 'codex' || spec.client === 'codex-vl') args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  let shellOneShot = false;
  if (spec.client === 'shell') {
    const raw = cell?.commands && typeof cell.commands[engineId] === 'string'
      ? cell.commands[engineId] : '';
    shellOneShot = raw.trim().length > 0;
    if (shellOneShot) args.push('-lc', raw);
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
      const qwen38 = model === 'qwen3.8-max-preview';
      const aliases = qwen38 ? {
        ANTHROPIC_MODEL: 'qwen3.8-max-preview',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'qwen3.8-max-preview',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-max-preview',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.8-max-preview',
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
      const contextWindow = OLLAMA_CONTEXT[model] || (spec.provider === 'zai' ? 1000000 : 200000);
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
  } else if (spec.client === 'codex' || spec.client === 'codex-vl') {
    if (profile.localProvider) args.push('--oss', '--local-provider', profile.localProvider);
    else if (spec.provider === 'openai-api') env.OPENAI_API_KEY = cred.value;
    else if (spec.provider === 'ollama-cloud') {
      env.OPENAI_API_KEY = cred.value;
      args.push(...codexProviderArgs('ollama_cloud', 'Ollama Cloud', profile.endpoint, 'OPENAI_API_KEY'));
      args.push('-c', 'model_providers.ollama_cloud.stream_idle_timeout_ms=600000', '-c', `model_context_window=${OLLAMA_CONTEXT[model] || 200000}`);
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
      if (model === 'qwen3.8-max-preview') {
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
    if (spec.provider === 'alibaba-token-plan' && model === 'qwen3.8-max-preview') args.push('--thinking', 'xhigh');
  }
  if (spec.client !== 'shell' && cell?.prompt) args.push(cell.prompt);
  let command = info.binary;
  if (needsExplicitNode(info.binary, cfg.platform || process.platform, cfg.env || process.env)) {
    command = cfg.nodeExecPath || process.execPath;
    args.unshift(info.binary);
  }
  return { ok: true, info, engine: {
    ...engine, command, args, env, promptMode: 'managed-argv', clientBinary: info.binary,
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
    credentialEnv: p.auth === 'dynamic' ? !!p.credentialEnv : (ENV_KEY_RE.test(p.auth || '') ? p.auth : false),
    defaultEnvKey: p.defaultEnvKey || '',
  }));
}

module.exports = {
  CATALOG, OLLAMA_CLOUD_MODELS, OLLAMA_CONTEXT, ALIBABA_TOKEN_PLAN_MODELS,
  ALIBABA_CODEX_MODELS, ALIBABA_TOKEN_PLAN_CONTEXT, ALIBABA_PI_MODELS,
  CLIENT_LABELS, normalizeManagedSpec,
  defaultDefinitions, defaultShellEngine, describeManaged, describeCatalogCredential, discoverOllamaModels, resolveManagedEngine, needsExplicitNode,
  discoverPiModels, parseEnvFile, parseProviderShellFile, findBinary, publicCatalog, writePiProviderExtension,
  providerKeyPaths, parseProviderKeyFiles, credentialSources, credential,
  ensureKimiClaudeConfig, ensureAlibabaClaudeConfig, resolveInteractiveShell, shellLoginArgs, ENV_KEY_RE,
};
