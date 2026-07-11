'use strict';
// Managed AI engine registry. Definitions contain adapter/provider metadata but
// never secret values. Commands are direct argv; no shell or chat-protocol
// compatibility fallback is allowed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const OLLAMA_CLOUD_MODELS = Object.freeze([
  'glm-5.2', 'kimi-k2.7-code', 'deepseek-v4-pro', 'minimax-m3',
  'qwen3.5:397b', 'deepseek-v4-flash', 'mistral-large-3:675b', 'gemma4:31b',
]);
const OLLAMA_CONTEXT = Object.freeze({
  'glm-5.2': 1000000, 'kimi-k2.7-code': 262144, 'deepseek-v4-pro': 524288,
  'minimax-m3': 524288, 'qwen3.5:397b': 262144, 'deepseek-v4-flash': 1048576,
  'mistral-large-3:675b': 262144, 'gemma4:31b': 262144,
});

const CUSTOM_KEYS = ['displayName', 'protocol', 'baseUrl', 'envKey', 'providerId'];
const MANAGED_KEYS = new Set(['client', 'provider', 'credentialProfile', 'model', 'permissionPolicy', ...CUSTOM_KEYS]);
const CLIENT_LABELS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', 'codex-vl': 'Codex-VL', pi: 'Pi' });
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
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
  { id: 'claude.native', client: 'claude', provider: 'native', label: 'Claude · Anthropic', auth: 'login', endpoint: 'Anthropic account', protocol: 'anthropic_messages', rc: true, default: true },
  { id: 'claude.ollama-cloud', client: 'claude', provider: 'ollama-cloud', label: 'Claude · Ollama Cloud', auth: 'OLLAMA_API_KEY', endpoint: 'https://ollama.com', protocol: 'anthropic_messages', model: 'glm-5.2', models: OLLAMA_CLOUD_MODELS, legacySecrets: true },
  { id: 'claude.ollama', client: 'claude', provider: 'ollama', label: 'Claude · Ollama local', auth: 'none', endpoint: 'http://127.0.0.1:11434', protocol: 'anthropic_messages' },
  { id: 'claude.zai-a', client: 'claude', provider: 'zai', credentialProfile: 'a', label: 'Claude · Z.AI · profile A', auth: 'ZAI_API_KEY_A', endpoint: 'https://api.z.ai/api/anthropic', protocol: 'anthropic_messages', model: 'glm-5.2[1m]', models: ['glm-5.2[1m]'], legacySecrets: true, legacyProvider: 'zai-a' },
  { id: 'claude.zai-p', client: 'claude', provider: 'zai', credentialProfile: 'p', label: 'Claude · Z.AI · profile P', auth: 'ZAI_API_KEY_P', endpoint: 'https://api.z.ai/api/anthropic', protocol: 'anthropic_messages', model: 'glm-5.2[1m]', models: ['glm-5.2[1m]'], legacySecrets: true, legacyProvider: 'zai-p' },
  { id: 'claude.custom', client: 'claude', provider: 'custom', label: 'Claude · Custom', auth: 'dynamic', protocol: 'anthropic_messages', protocols: ['anthropic_messages'], custom: true },

  // Codex family. OpenAI Responses is the only remote custom wire API.
  { id: 'codex.native', client: 'codex', provider: 'native', label: 'Codex · OpenAI', auth: 'login', endpoint: 'OpenAI account', protocol: 'openai_responses', default: true },
  { id: 'codex-vl.native', client: 'codex-vl', provider: 'native', label: 'Codex-VL · OpenAI', auth: 'login', endpoint: 'OpenAI account', protocol: 'openai_responses', default: true },
  { id: 'codex.ollama', client: 'codex', provider: 'ollama', label: 'Codex · Ollama local', auth: 'none', endpoint: 'local provider', protocol: 'openai_responses', localProvider: 'ollama' },
  { id: 'codex-vl.ollama', client: 'codex-vl', provider: 'ollama', label: 'Codex-VL · Ollama local', auth: 'none', endpoint: 'local provider', protocol: 'openai_responses', localProvider: 'ollama' },
  { id: 'codex.lmstudio', client: 'codex', provider: 'lmstudio', label: 'Codex · LM Studio', auth: 'none', endpoint: 'local provider', protocol: 'openai_responses', localProvider: 'lmstudio' },
  { id: 'codex-vl.lmstudio', client: 'codex-vl', provider: 'lmstudio', label: 'Codex-VL · LM Studio', auth: 'none', endpoint: 'local provider', protocol: 'openai_responses', localProvider: 'lmstudio' },
  { id: 'codex.ollama-cloud', client: 'codex', provider: 'ollama-cloud', label: 'Codex · Ollama Cloud', auth: 'OLLAMA_API_KEY', endpoint: 'https://ollama.com/v1', protocol: 'openai_responses', model: 'glm-5.2', models: OLLAMA_CLOUD_MODELS, legacySecrets: true },
  { id: 'codex-vl.ollama-cloud', client: 'codex-vl', provider: 'ollama-cloud', label: 'Codex-VL · Ollama Cloud', auth: 'OLLAMA_API_KEY', endpoint: 'https://ollama.com/v1', protocol: 'openai_responses', model: 'glm-5.2', models: OLLAMA_CLOUD_MODELS, legacySecrets: true },
  { id: 'codex.custom', client: 'codex', provider: 'custom', label: 'Codex · Custom Responses', auth: 'dynamic', protocol: 'openai_responses', protocols: ['openai_responses'], custom: true },
  { id: 'codex-vl.custom', client: 'codex-vl', provider: 'custom', label: 'Codex-VL · Custom Responses', auth: 'dynamic', protocol: 'openai_responses', protocols: ['openai_responses'], custom: true },

  // Pi uses its real provider IDs directly. OAuth providers do not need env keys.
  { id: 'pi.anthropic', client: 'pi', provider: 'anthropic', label: 'Pi · Anthropic', auth: 'ANTHROPIC_API_KEY', protocol: 'pi_native', piProvider: 'anthropic' },
  { id: 'pi.openai', client: 'pi', provider: 'openai', label: 'Pi · OpenAI', auth: 'OPENAI_API_KEY', protocol: 'pi_native', piProvider: 'openai' },
  { id: 'pi.google', client: 'pi', provider: 'google', label: 'Pi · Google Gemini', auth: 'GEMINI_API_KEY', protocol: 'pi_native', piProvider: 'google' },
  { id: 'pi.openrouter', client: 'pi', provider: 'openrouter', label: 'Pi · OpenRouter', auth: 'OPENROUTER_API_KEY', protocol: 'pi_native', piProvider: 'openrouter' },
  { id: 'pi.github-copilot', client: 'pi', provider: 'github-copilot', label: 'Pi · GitHub Copilot', auth: 'login', protocol: 'pi_native', piProvider: 'github-copilot' },
  { id: 'pi.fireworks', client: 'pi', provider: 'fireworks', label: 'Pi · Fireworks AI', auth: 'FIREWORKS_API_KEY', protocol: 'pi_native', piProvider: 'fireworks' },
  { id: 'pi.huggingface', client: 'pi', provider: 'huggingface', label: 'Pi · Hugging Face', auth: 'HF_TOKEN', protocol: 'pi_native', piProvider: 'huggingface' },
  { id: 'pi.minimax', client: 'pi', provider: 'minimax', label: 'Pi · MiniMax', auth: 'MINIMAX_API_KEY', protocol: 'pi_native', piProvider: 'minimax' },
  { id: 'pi.deepseek', client: 'pi', provider: 'deepseek', label: 'Pi · DeepSeek', auth: 'DEEPSEEK_API_KEY', protocol: 'pi_native', piProvider: 'deepseek' },
  { id: 'pi.kimi-coding', client: 'pi', provider: 'kimi-coding', label: 'Pi · Kimi For Coding', auth: 'KIMI_API_KEY', protocol: 'pi_native', piProvider: 'kimi-coding' },
  { id: 'pi.mistral', client: 'pi', provider: 'mistral', label: 'Pi · Mistral', auth: 'MISTRAL_API_KEY', protocol: 'pi_native', piProvider: 'mistral' },
  { id: 'pi.together', client: 'pi', provider: 'together', label: 'Pi · Together AI', auth: 'TOGETHER_API_KEY', protocol: 'pi_native', piProvider: 'together' },
  { id: 'pi.ollama', client: 'pi', provider: 'ollama', label: 'Pi · Ollama local', auth: 'none', protocol: 'openai-completions', piProvider: 'ollama', requiresModel: true, piExtension: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama' } },
  { id: 'pi.zai', client: 'pi', provider: 'zai', label: 'Pi · Z.AI', auth: 'ZAI_API_KEY', protocol: 'pi_native', piProvider: 'zai' },
  { id: 'pi.custom', client: 'pi', provider: 'custom', label: 'Pi · Custom provider', auth: 'dynamic', protocol: 'openai-responses', protocols: ['openai-responses', 'anthropic-messages', 'openai-completions', 'google-generative-ai'], custom: true },
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
  if (profile.requiresModel && !model) return null;
  const permissionPolicy = value.permissionPolicy === undefined ? 'standard' : value.permissionPolicy;
  if (permissionPolicy !== 'standard' && permissionPolicy !== 'unsafe') return null;
  if (value.client === 'pi' && permissionPolicy !== 'standard') return null;
  const out = { client: profile.client, provider: profile.provider, model, permissionPolicy };
  if (profile.credentialProfile) out.credentialProfile = profile.credentialProfile;
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
      id: p.id, label: p.label, rc: !!p.rc,
      managed: { client: p.client, provider: p.provider, model: p.model || '', permissionPolicy: 'standard' },
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
    let v = m[2];
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
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

function secretsPath(cfg, home) {
  return cfg.providerSecretsPath || process.env.NEXUSCREW_PROVIDER_SECRETS || path.join(home, '.nexuscrew', 'providers.env');
}

function credential(profile, spec, cfg, home) {
  if (profile.auth === 'login' || profile.auth === 'none') return { envKey: profile.auth, value: '' };
  const envKey = profile.auth === 'dynamic' ? spec.envKey : profile.auth;
  const runtimeEnv = cfg.env || process.env;
  let value = runtimeEnv[envKey] || '';
  // Preserve 0.8.0 Z.AI/Ollama Cloud behavior, but new Custom never reads disk.
  if (!value && profile.legacySecrets) value = parseEnvFile(secretsPath(cfg, home))[envKey] || '';
  return { envKey, value };
}

let ollamaCache = { at: 0, models: [] };
async function discoverOllamaModels(opts = {}) {
  const now = Date.now(); const ttl = opts.ttlMs === undefined ? 30000 : opts.ttlMs;
  if (!opts.noCache && ollamaCache.models.length && now - ollamaCache.at < ttl) return [...ollamaCache.models];
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return [...OLLAMA_CLOUD_MODELS];
  try {
    const home = opts.home || require('node:os').homedir();
    const apiKey = opts.apiKey || (opts.env || process.env).OLLAMA_API_KEY || parseEnvFile(secretsPath(opts, home)).OLLAMA_API_KEY;
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
  const binary = findBinary(normalized.client, home);
  const cred = credential(profile, normalized, cfg, home);
  // Pi can resolve credentials from its own documented /login auth store. Do
  // not inspect or copy that store; delegate native-provider auth to Pi.
  const delegatedPiAuth = profile.client === 'pi' && profile.provider !== 'custom';
  const authConfigured = delegatedPiAuth || profile.auth === 'login' || profile.auth === 'none' || !!cred.value;
  return {
    client: profile.client, clientLabel: CLIENT_LABELS[profile.client], provider: profile.provider,
    credentialProfile: normalized.credentialProfile || '', model: normalized.model,
    permissionPolicy: normalized.permissionPolicy, protocol: normalized.protocol || profile.protocol,
    endpoint: normalized.baseUrl || profile.endpoint || '', auth: cred.envKey, authConfigured,
    configured: !!binary && authConfigured, models: [...(profile.models || [])], defaultModel: profile.model || '',
    binary: binary || '', displayName: normalized.displayName || profile.label,
    reason: !binary ? `client ${profile.client} not found` : (!authConfigured ? `environment variable ${cred.envKey} missing` : 'ready'),
  };
}

function codexProviderArgs(id, name, baseUrl, envKey) {
  return [
    '-c', `model_provider=${JSON.stringify(id)}`, '-c', `model_providers.${id}.name=${JSON.stringify(name)}`,
    '-c', `model_providers.${id}.base_url=${JSON.stringify(baseUrl)}`, '-c', `model_providers.${id}.env_key=${JSON.stringify(envKey)}`,
    '-c', `model_providers.${id}.wire_api="responses"`,
  ];
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
    models: [{
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
  if (spec.permissionPolicy === 'unsafe') {
    if (spec.client === 'claude') args.push('--dangerously-skip-permissions');
    if (spec.client === 'codex' || spec.client === 'codex-vl') args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  if (spec.client === 'claude') {
    if (spec.provider === 'native') {
      if (engine.rc !== false) args.push('--remote-control', `Cloud_${cell.id}`);
    } else {
      const endpoint = spec.baseUrl || profile.endpoint;
      const token = profile.auth === 'none' ? 'ollama' : cred.value;
      Object.assign(env, {
        ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: '',
        ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model, API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(OLLAMA_CONTEXT[model] || (spec.provider === 'zai' ? 1000000 : 200000)),
      });
    }
    if (model) args.push('--model', model);
  } else if (spec.client === 'codex' || spec.client === 'codex-vl') {
    if (profile.localProvider) args.push('--oss', '--local-provider', profile.localProvider);
    else if (spec.provider === 'ollama-cloud') {
      env.OPENAI_API_KEY = cred.value;
      args.push(...codexProviderArgs('ollama_cloud', 'Ollama Cloud', profile.endpoint, 'OPENAI_API_KEY'));
      args.push('-c', 'model_providers.ollama_cloud.stream_idle_timeout_ms=600000', '-c', `model_context_window=${OLLAMA_CONTEXT[model] || 200000}`);
      const localCatalog = path.join(home, '.codex', 'ollama_cloud_model_catalog.json');
      if (fs.existsSync(localCatalog)) args.push('-c', `model_catalog_json="${localCatalog}"`);
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
      protocol: profile.protocol, model,
    }, home));
    args.push('--provider', spec.provider === 'custom' ? spec.providerId : profile.piProvider);
    if (model) args.push('--model', model);
  }
  if (cell?.prompt) args.push(cell.prompt);
  return { ok: true, info, engine: { ...engine, command: info.binary, args, env, promptMode: 'managed-argv' } };
}

function publicCatalog() {
  return CATALOG.map((p) => ({
    id: p.id, client: p.client, clientLabel: CLIENT_LABELS[p.client], provider: p.provider,
    credentialProfile: p.credentialProfile || '', label: p.label, protocol: p.protocol,
    auth: p.auth, endpoint: p.endpoint || '', model: p.model || '', models: [...(p.models || [])],
    protocols: [...(p.protocols || [p.protocol])], supportsUnsafe: p.client !== 'pi', requiresModel: !!p.requiresModel || !!p.custom,
    rc: !!p.rc, custom: !!p.custom, default: !!p.default,
  }));
}

module.exports = {
  CATALOG, OLLAMA_CLOUD_MODELS, OLLAMA_CONTEXT, CLIENT_LABELS, normalizeManagedSpec,
  defaultDefinitions, describeManaged, discoverOllamaModels, resolveManagedEngine,
  discoverPiModels, parseEnvFile, findBinary, publicCatalog, writePiProviderExtension,
};
