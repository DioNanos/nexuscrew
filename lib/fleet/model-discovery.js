'use strict';
// lib/fleet/model-discovery.js — per-engine dynamic model discovery (lot 1).
//
// One collector per endpoint kind (OpenAI-compatible, Anthropic, Ollama,
// llama-server, LM Studio), a per-engine disk cache with TTL under the
// NexusCrew home, and a field-by-field precedence merge. The engine's endpoint
// and key are resolved by the CALLER (managed.js, through the same
// credentialSources/credential path the launcher uses) and handed to this
// module in memory only: the key never reaches a file, a log, a cache entry
// or an error string.
//
// Hard constraints encoded here:
//   * llama-server: ONLY `GET /v1/models` plus a single `GET /props` for the
//     resident model. A router with `--models-max 1` unloads the resident
//     model on any per-model request, so this collector must never issue a
//     per-model request (measured on the production router, 2026-10-18).
//   * discovery PROPOSES, never fills: the merged list is capped at
//     DISCOVERY_PROPOSAL_CAP. The number mirrors MAX_MODELS in
//     definitions.js on purpose; it is not imported from there because
//     definitions.js requires managed.js, which requires this module — the
//     duplication is deliberate and pinned by tests.
//   * a model absent from the API listing is never dropped: it keeps its
//     user/backup record and is marked `inApi: false`. When the API could
//     not be reached at all (and no last-good value exists) `inApi` stays
//     ABSENT: unknown is not false.
//   * fallback chain on error/timeout: last good disk value first, then the
//     backup catalog supplied by the caller.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DISCOVERY_PROPOSAL_CAP = 128; // mirrors MAX_MODELS (definitions.js)
const DEFAULT_TIMEOUT_MS = 2500;
const HOSTED_TTL_MS = 12 * 60 * 60 * 1000;
const LOCAL_TTL_MS = 60 * 1000;
const CACHE_VERSION = 1;
const MAX_SHOW_CALLS = 32;      // Ollama /api/show: only listed ids the caller asked about
const ANTHROPIC_MAX_PAGES = 5;  // pagination safety bound
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ENGINE_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MERGE_FIELDS = Object.freeze(['contextWindow', 'maxTokens', 'tools', 'vision', 'reasoning']);

const COLLECTOR_KINDS = Object.freeze(['openai-compat', 'anthropic', 'ollama', 'llama-server', 'lmstudio']);

// Local endpoints change with every pull/start; hosted listings barely move
// in a day. The TTL follows the endpoint, not the caller.
function collectorDefaultTtlMs(collector) {
  return collector === 'ollama' || collector === 'llama-server' || collector === 'lmstudio'
    ? LOCAL_TTL_MS : HOSTED_TTL_MS;
}

// Sanitized failure: fixed reason strings only. The raw fetch error can embed
// the request URL; the key lives in headers — neither may surface here.
class DiscoveryError extends Error {
  constructor(reason) {
    super(`model discovery: ${reason}`);
    this.name = 'DiscoveryError';
    this.reason = reason;
  }
}

function trimBase(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(b) ? b : null;
}

function openAiStyleModelsUrl(base) {
  const b = trimBase(base);
  if (!b) return null;
  return /\/v1$/.test(b) ? `${b}/models` : `${b}/v1/models`;
}

function anthropicModelsUrl(base) {
  const b = trimBase(base);
  if (!b) return null;
  return /\/v1$/.test(b) ? `${b}/models?limit=1000` : `${b}/v1/models?limit=1000`;
}

function ollamaApiUrl(base, suffix) {
  const b = trimBase(base);
  if (!b) return null;
  // ollama-cloud engines declare `https://ollama.com/v1`: the native API
  // (`/api/tags`, `/api/show`) lives at the root, not under `/v1`.
  return `${b.replace(/\/v1$/, '')}${suffix}`;
}

function llamaPropsUrl(base) {
  const b = trimBase(base);
  if (!b) return null;
  return `${b.replace(/\/v1$/, '')}/props`;
}

function lmstudioModelsUrl(base) {
  const b = trimBase(base);
  if (!b) return null;
  return /\/api\/v\d+$/.test(b) ? `${b}/models` : `${b}/api/v0/models`;
}

async function httpJson(url, {
  apiKey = '', authMode = 'bearer', method = 'GET', body, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (apiKey) {
      if (authMode === 'x-api-key') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = ANTHROPIC_VERSION;
      } else {
        headers.authorization = `Bearer ${apiKey}`;
      }
    }
    response = await fetchImpl(url, {
      method,
      headers,
      signal: controller.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
    throw new DiscoveryError(aborted ? `timeout after ${timeoutMs}ms` : 'network error');
  } finally {
    clearTimeout(timer);
  }
  // Minimal fakes (and some SDK shims) carry `ok` without `status`: honor
  // `ok === true` as 200, mirroring the previous discoverOllamaModels check.
  const okFlag = !!(response && typeof response === 'object' && response.ok === true);
  const status = response && typeof response.status === 'number' ? response.status : (okFlag ? 200 : 0);
  if (!(status >= 200 && status < 300)) throw new DiscoveryError(`HTTP ${status}`);
  let parsed;
  try { parsed = await response.json(); } catch (_) { throw new DiscoveryError('invalid JSON response'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DiscoveryError('unexpected response shape');
  }
  return parsed;
}

// One normalized record per model. Fields the source does not provide stay
// ABSENT — no invented defaults, no guesses.
function normalizeModelRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!MODEL_ID_RE.test(id)) return null;
  const out = { id };
  for (const key of ['contextWindow', 'maxTokens']) {
    if (raw[key] === undefined) continue;
    if (Number.isSafeInteger(raw[key]) && raw[key] > 0) out[key] = raw[key];
  }
  for (const key of ['tools', 'vision', 'reasoning']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  return out;
}

function collectIds(records, seen, out) {
  for (const raw of records) {
    const rec = normalizeModelRecord(raw);
    if (!rec || seen.has(rec.id)) continue;
    seen.add(rec.id);
    out.push(rec);
  }
  return out;
}

// --- Collectors -------------------------------------------------------------
// Each collector maps an endpoint kind to a list of normalized API records
// (`{ id, contextWindow?, maxTokens?, tools?, vision?, reasoning? }`).

const collectors = {
  // OpenAI-compatible `GET /v1/models`: `{ data: [{ id, ... }] }`. The listing
  // carries ids; context/pricing fields are provider-specific and usually
  // absent — they stay absent.
  'openai-compat': async ({ baseUrl, apiKey, fetchImpl, timeoutMs }) => {
    const url = openAiStyleModelsUrl(baseUrl);
    if (!url) throw new DiscoveryError('invalid base URL');
    const body = await httpJson(url, { apiKey, fetchImpl, timeoutMs });
    return collectIds(Array.isArray(body.data) ? body.data : [], new Set(), []);
  },

  // Anthropic `GET /v1/models` with x-api-key + anthropic-version and
  // `after_id` pagination (limit <= 1000 per page, bounded pages).
  'anthropic': async ({ baseUrl, apiKey, fetchImpl, timeoutMs }) => {
    const base = anthropicModelsUrl(baseUrl);
    if (!base) throw new DiscoveryError('invalid base URL');
    const out = []; const seen = new Set();
    let after = '';
    for (let page = 0; page < ANTHROPIC_MAX_PAGES; page += 1) {
      const url = after ? `${base}&after_id=${encodeURIComponent(after)}` : base;
      const body = await httpJson(url, { apiKey, authMode: 'x-api-key', fetchImpl, timeoutMs });
      collectIds(Array.isArray(body.data) ? body.data : [], seen, out);
      if (body.has_more !== true || typeof body.last_id !== 'string' || !body.last_id) break;
      after = body.last_id;
    }
    return out;
  },

  // Ollama `GET /api/tags` (+ Bearer key on cloud). `POST /api/show` runs ONLY
  // for listed ids the caller explicitly asked details for (`detailIds`) and
  // only to read what the listing cannot give (context length, capabilities).
  'ollama': async ({ baseUrl, apiKey, fetchImpl, timeoutMs, detailIds }) => {
    const tagsUrl = ollamaApiUrl(baseUrl, '/api/tags');
    if (!tagsUrl) throw new DiscoveryError('invalid base URL');
    const tags = await httpJson(tagsUrl, { apiKey, fetchImpl, timeoutMs });
    const listed = collectIds(Array.isArray(tags.models) ? tags.models.map((m) => ({
      id: typeof m?.name === 'string' && m.name ? m.name : m?.model,
    })) : [], new Set(), []);
    const wanted = new Set(Array.isArray(detailIds) ? detailIds.filter((id) => typeof id === 'string') : []);
    if (!wanted.size) return listed;
    const showUrl = ollamaApiUrl(baseUrl, '/api/show');
    let calls = 0;
    for (const rec of listed) {
      if (calls >= MAX_SHOW_CALLS) break;
      if (!wanted.has(rec.id)) continue;
      calls += 1;
      try {
        const show = await httpJson(showUrl, {
          method: 'POST', body: { name: rec.id }, apiKey, fetchImpl, timeoutMs,
        });
        for (const [key, value] of Object.entries(show.model_info || {})) {
          if (/\.context_length$/.test(key) && Number.isSafeInteger(value) && value > 0) {
            if (rec.contextWindow === undefined) rec.contextWindow = value;
            break;
          }
        }
        const caps = Array.isArray(show.capabilities) ? show.capabilities : [];
        if (caps.includes('tools')) rec.tools = true;
        if (caps.includes('vision')) rec.vision = true;
        if (caps.includes('thinking') || show.thinking === true) rec.reasoning = true;
      } catch (_) {
        // A failed per-model detail is not a failed discovery: the id stays
        // listed with the fields the listing provides.
      }
    }
    return listed;
  },

  // llama-server `GET /v1/models` + ONE `GET /props` (resident model only).
  // NEVER a per-model request: on a `--models-max 1` router any per-model
  // request unloads the resident model. `/props` describes whichever model is
  // resident; it enriches at most the matching record and its failure is
  // non-fatal (an idle router still lists its presets).
  'llama-server': async ({ baseUrl, apiKey, fetchImpl, timeoutMs }) => {
    const modelsUrl = openAiStyleModelsUrl(baseUrl);
    if (!modelsUrl) throw new DiscoveryError('invalid base URL');
    const body = await httpJson(modelsUrl, { apiKey, fetchImpl, timeoutMs });
    const listed = collectIds(Array.isArray(body.data) ? body.data : [], new Set(), []);
    try {
      const props = await httpJson(llamaPropsUrl(baseUrl), { apiKey, fetchImpl, timeoutMs });
      const alias = typeof props.model_alias === 'string' ? props.model_alias : '';
      const target = alias ? listed.find((r) => r.id === alias) : null;
      if (target) {
        if (Number.isSafeInteger(props.n_ctx) && props.n_ctx > 0) target.contextWindow = props.n_ctx;
        if (props.modalities && props.modalities.vision === true) target.vision = true;
        const caps = props.chat_template_caps;
        if (caps && typeof caps === 'object' && caps.tools === true) target.tools = true;
      }
    } catch (_) { /* no resident / props unavailable: the listing stands */ }
    return listed;
  },

  // LM Studio `GET /api/v0/models`: `{ data: [{ id, max_context_length, ... }] }`.
  'lmstudio': async ({ baseUrl, apiKey, fetchImpl, timeoutMs }) => {
    const url = lmstudioModelsUrl(baseUrl);
    if (!url) throw new DiscoveryError('invalid base URL');
    const body = await httpJson(url, { apiKey, fetchImpl, timeoutMs });
    const items = Array.isArray(body.data) ? body.data : [];
    return collectIds(items.map((m) => ({
      id: m?.id, contextWindow: m?.max_context_length,
    })), new Set(), []);
  },
};

// --- Disk cache -------------------------------------------------------------
// <home>/.nexuscrew/model-discovery/<engine>.json, mode 600, atomic write.
// Only SUCCESSFUL API results are cached; failures never poison the file, and
// a stale-but-valid file is the "last good value" the fallback chain serves.

function cacheDirFor(home) { return path.join(home, '.nexuscrew', 'model-discovery'); }

function safeEngineKey(engine) {
  const e = String(engine || '');
  return ENGINE_KEY_RE.test(e) ? e : crypto.createHash('sha256').update(e).digest('hex').slice(0, 16);
}

function cachePathFor(home, engine) { return path.join(cacheDirFor(home), `${safeEngineKey(engine)}.json`); }

function readCache(home, engine) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePathFor(home, engine), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== CACHE_VERSION || parsed.engine !== String(engine)) return null;
    if (!Array.isArray(parsed.models) || !Number.isSafeInteger(parsed.fetchedAt)) return null;
    const models = collectIds(parsed.models, new Set(), []);
    if (!models.length) return null;
    return { fetchedAt: parsed.fetchedAt, collector: typeof parsed.collector === 'string' ? parsed.collector : '', models };
  } catch (_) { return null; }
}

function writeCache(home, engine, collector, fetchedAt, models) {
  const dir = cacheDirFor(home);
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('unsafe model-discovery directory');
  } catch (e) {
    if (e.code === 'ENOENT') fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    else throw e;
  }
  fs.chmodSync(dir, 0o700);
  const target = cachePathFor(home, engine);
  const tmp = path.join(dir, `.${safeEngineKey(engine)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const payload = JSON.stringify({ version: CACHE_VERSION, engine: String(engine), collector, fetchedAt, models });
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

// --- Precedence merge -------------------------------------------------------
// Field-by-field, per the approved precedence order: user (fleet.json) > provider API >
// [public catalog: LOT 2 HOOK — the models.dev layer is accepted here but no
// fetcher exists yet] > internal backup. The user layer also fixes the ORDER:
// user-declared models come first, so the cap can never cut them out of the
// proposal.

function mergeModelRecords({
  userModels = [], apiModels = [], publicCatalogModels = [], backupModels = [],
  apiKnown = true, fetchedAt = 0, cap = DISCOVERY_PROPOSAL_CAP,
} = {}) {
  const layers = [
    { name: 'user', models: userModels },
    { name: 'api', models: apiModels },
    { name: 'public', models: publicCatalogModels },
    { name: 'backup', models: backupModels },
  ];
  const merged = new Map(); // id -> { order, values, fieldSources, source }
  const apiIds = new Set();
  let order = 0;
  for (const layer of layers) {
    const records = collectIds(Array.isArray(layer.models) ? layer.models : [], new Set(), []);
    if (layer.name === 'api') for (const r of records) apiIds.add(r.id);
    for (const rec of records) {
      let entry = merged.get(rec.id);
      if (!entry) {
        entry = { order: order++, values: {}, fieldSources: {}, source: layer.name };
        merged.set(rec.id, entry);
      }
      for (const field of MERGE_FIELDS) {
        if (rec[field] !== undefined && entry.values[field] === undefined) {
          entry.values[field] = rec[field];
          entry.fieldSources[field] = layer.name;
        }
      }
    }
  }
  const effectiveCap = Number.isSafeInteger(cap) && cap > 0 ? cap : DISCOVERY_PROPOSAL_CAP;
  return [...merged.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .slice(0, effectiveCap)
    .map(([id, entry]) => ({
      id,
      ...entry.values,
      source: entry.source,
      ...(Object.keys(entry.fieldSources).length ? { fieldSources: entry.fieldSources } : {}),
      ...(apiKnown ? { inApi: apiIds.has(id) } : {}),
      ...(fetchedAt ? { fetchedAt } : {}),
    }));
}

// --- Discovery instance -----------------------------------------------------

function createModelDiscovery({ fetchImpl: defaultFetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  // Raw API layer with cache + fallback. Returns:
  //   { status: 'api',    fetchedAt, apiModels, stale: false, error: '' }
  //   { status: 'cache',  fetchedAt, apiModels, stale: true|false, error }  (last good value)
  //   { status: 'backup', fetchedAt: 0, apiModels: [], stale: false, error } (nothing known)
  async function fetchEngineModels(opts = {}) {
    const {
      engine, collector, baseUrl, apiKey = '', home,
      noCache = false, ttlMs, timeoutMs = DEFAULT_TIMEOUT_MS, detailIds,
      fetchImpl = defaultFetchImpl,
    } = opts;
    if (!engine) throw new DiscoveryError('engine is required');
    if (!COLLECTOR_KINDS.includes(collector)) throw new DiscoveryError(`unknown collector: ${collector}`);
    if (typeof fetchImpl !== 'function') throw new DiscoveryError('no fetch implementation');
    const ttl = ttlMs === undefined ? collectorDefaultTtlMs(collector) : ttlMs;
    const at = now();
    const cached = home ? readCache(home, engine) : null;
    if (!noCache && cached && at - cached.fetchedAt < ttl) {
      return {
        status: 'cache', fetchedAt: cached.fetchedAt, stale: false, error: '',
        apiModels: cached.models.map((m) => ({ ...m })),
      };
    }
    let apiModels;
    try {
      apiModels = await collectors[collector]({ baseUrl, apiKey, fetchImpl, timeoutMs, detailIds });
    } catch (error) {
      const reason = error instanceof DiscoveryError ? error.reason : 'discovery failed';
      if (cached) {
        return {
          status: 'cache', fetchedAt: cached.fetchedAt, stale: true, error: reason,
          apiModels: cached.models.map((m) => ({ ...m })),
        };
      }
      return { status: 'backup', fetchedAt: 0, stale: false, error: reason, apiModels: [] };
    }
    const fetchedAt = now();
    if (home && apiModels.length) {
      try { writeCache(home, engine, collector, fetchedAt, apiModels); } catch (_) { /* cache is best-effort */ }
    }
    return { status: 'api', fetchedAt, stale: false, error: '', apiModels: apiModels.map((m) => ({ ...m })) };
  }

  // Full engine view: API layer + user/backup layers merged per field, capped,
  // with `inApi` marked only when the API (or its last good value) actually
  // answered.
  async function discoverEngine(opts = {}) {
    const {
      userModels = [], backupModels = [], publicCatalogModels = [],
      cap = DISCOVERY_PROPOSAL_CAP,
    } = opts;
    const layer = await fetchEngineModels(opts);
    const apiKnown = layer.status !== 'backup';
    const models = mergeModelRecords({
      userModels,
      apiModels: layer.apiModels,
      publicCatalogModels,
      backupModels,
      apiKnown,
      fetchedAt: layer.fetchedAt || now(),
      cap,
    });
    return { ...layer, source: layer.status, models };
  }

  return { fetchEngineModels, discoverEngine, limits: { cap: DISCOVERY_PROPOSAL_CAP } };
}

module.exports = {
  COLLECTOR_KINDS,
  DiscoveryError,
  createModelDiscovery,
  mergeModelRecords,
  normalizeModelRecord,
  collectorDefaultTtlMs,
  DISCOVERY_PROPOSAL_CAP,
  DEFAULT_TIMEOUT_MS,
};
