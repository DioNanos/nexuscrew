'use strict';
// lib/fleet/model-discovery.js — per-engine dynamic model discovery (lots 1-2).
//
// One collector per endpoint kind (OpenAI-compatible, Anthropic, Ollama,
// llama-server, LM Studio), a per-engine disk cache with TTL under the
// NexusCrew home, and a field-by-field precedence merge. Lot 2 adds the public
// catalog (models.dev) as a third, key-less source: a snapshot with its own
// TTL and fallback, an explicit provider/model mapping, and the same record
// shape joining the merge below the provider API. The engine's endpoint
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
//     user/backup record and is marked `inApi: false`; a model that no layer
//     carries but the PREVIOUS cached listing knew stays too, as a bare id
//     (the 'known' layer) — a model that was in the APIs never silently
//     disappears from the proposal. When the API could
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
const MERGE_FIELDS = Object.freeze(['contextWindow', 'maxTokens', 'tools', 'vision', 'reasoning', 'deprecated']);

const COLLECTOR_KINDS = Object.freeze(['openai-compat', 'anthropic', 'ollama', 'llama-server', 'lmstudio']);

// Local endpoints change with every pull/start; hosted listings barely move
// in a day. The TTL follows the endpoint, not the caller.
function collectorDefaultTtlMs(collector) {
  return collector === 'ollama' || collector === 'llama-server' || collector === 'lmstudio'
    ? LOCAL_TTL_MS : HOSTED_TTL_MS;
}

// Sanitized failure: fixed reason strings only. The raw fetch error can embed
// the request URL; the key lives in headers — neither may surface here.
// The optional `attempt` object adds the FIXED facts of the request that
// failed (numeric HTTP status, error category, whether the credential header
// was applied). Internal diagnostics for the fallback chain: they ride
// DiscoveryError and the layer results, never a route response — the public
// face stays the sanitized `reason` above.
class DiscoveryError extends Error {
  constructor(reason, attempt = null) {
    super(`model discovery: ${reason}`);
    this.name = 'DiscoveryError';
    this.reason = reason;
    if (attempt && typeof attempt === 'object') {
      if (Number.isSafeInteger(attempt.status)) this.status = attempt.status;
      if (typeof attempt.category === 'string') this.category = attempt.category;
      if (typeof attempt.credentialSent === 'boolean') this.credentialSent = attempt.credentialSent;
    }
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
  // The deadline covers the WHOLE read: headers AND body. The timer stays
  // armed until the response is parsed — a server that answers the headers
  // and then stalls inside `json()` cannot hang the request with no expiry,
  // and the abort while reading is reported as the same fixed timeout reason.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const isAbort = (error) => !!(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
  // Direct transport: the credential header is applied exactly when a key is
  // valued (pinned by tests with a header-capturing fake fetch) — that is what
  // `credentialSent` reports on every failure below.
  const credentialSent = !!apiKey;
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
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new DiscoveryError(isAbort(error) ? `timeout after ${timeoutMs}ms` : 'network error', {
        category: isAbort(error) ? 'timeout' : 'network', credentialSent,
      });
    }
    // Minimal fakes (and some SDK shims) carry `ok` without `status`: honor
    // `ok === true` as 200, mirroring the previous discoverOllamaModels check.
    const okFlag = !!(response && typeof response === 'object' && response.ok === true);
    const status = response && typeof response.status === 'number' ? response.status : (okFlag ? 200 : 0);
    if (!(status >= 200 && status < 300)) throw new DiscoveryError(`HTTP ${status}`, { status, category: 'http', credentialSent });
    let parsed;
    try {
      parsed = await response.json();
    } catch (error) {
      // The timer is still armed here: an abort while reading the body is the
      // deadline expiring again, not a malformed payload.
      throw new DiscoveryError(isAbort(error) ? `timeout after ${timeoutMs}ms` : 'invalid JSON response', {
        category: isAbort(error) ? 'timeout' : 'invalid-response', credentialSent,
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new DiscoveryError('unexpected response shape', { category: 'invalid-response', credentialSent });
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
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
  for (const key of ['tools', 'vision', 'reasoning', 'deprecated']) {
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
// The cache key is the DECLARED engine id: two engines sharing one profile
// (two custom engines of the same client) must never share a listing. The
// record also carries an endpoint FINGERPRINT — a truncated sha256 of the
// normalized base URL — so a listing fetched from another endpoint is never
// served (nor kept as last-good) after the engine's endpoint changed. The
// fingerprint covers the URL only: the API key, or anything derived from it,
// must never reach the file. Records without a fingerprint (older layout)
// are simply ignored: no error, no forced deletion.

function cacheDirFor(home) { return path.join(home, '.nexuscrew', 'model-discovery'); }

function safeEngineKey(engine) {
  const e = String(engine || '');
  return ENGINE_KEY_RE.test(e) ? e : crypto.createHash('sha256').update(e).digest('hex').slice(0, 16);
}

function cachePathFor(home, engine) { return path.join(cacheDirFor(home), `${safeEngineKey(engine)}.json`); }

function endpointFingerprint(baseUrl) {
  const base = trimBase(baseUrl) || '';
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 16);
}

function readCache(home, engine, endpoint) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePathFor(home, engine), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== CACHE_VERSION || parsed.engine !== String(engine)) return null;
    if (!Array.isArray(parsed.models) || !Number.isSafeInteger(parsed.fetchedAt)) return null;
    if (parsed.endpoint !== endpoint) return null;
    // A successful EMPTY listing is a valid record: a provider that dropped
    // every model must not fall back to the previous one forever.
    const models = collectIds(parsed.models, new Set(), []);
    return { fetchedAt: parsed.fetchedAt, collector: typeof parsed.collector === 'string' ? parsed.collector : '', models };
  } catch (_) { return null; }
}

function writeCache(home, engine, collector, fetchedAt, models, endpoint) {
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
  const payload = JSON.stringify({ version: CACHE_VERSION, engine: String(engine), collector, fetchedAt, models, endpoint });
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

// --- Public catalog snapshot (lot 2: models.dev) -----------------------------
// Third source: a public, key-less catalog. NEVER mandatory: on failure the
// last good snapshot serves, then nothing — an engine keeps working on its
// user/api/backup layers either way. The snapshot is large (~6 MB), so the TTL
// is one day, the default timeout is generous, and a fresh read is memoized
// in-process so per-engine lookups do not reparse the file every time.

const PUBLIC_CATALOG_URL = 'https://models.dev/api.json';
const PUBLIC_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLIC_CATALOG_TIMEOUT_MS = 10000;
const PUBLIC_CATALOG_CACHE_FILE = 'public-catalog.json';

// Shape: `{ "<provider>": { id, name, models: { "<model>": { … } } } }`. Model
// entries are validated leniently at LOOKUP time (absent fields stay absent);
// here only the provider level must hold.
function validateCatalogSnapshot(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  let withModels = 0;
  for (const provider of Object.values(parsed)) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return false;
    if (provider.models && typeof provider.models === 'object' && !Array.isArray(provider.models)) withModels += 1;
  }
  return withModels > 0;
}

function readPublicCatalogCache(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cacheDirFor(home), PUBLIC_CATALOG_CACHE_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== CACHE_VERSION || parsed.kind !== 'public-catalog') return null;
    if (!Number.isSafeInteger(parsed.fetchedAt) || !validateCatalogSnapshot(parsed.providers)) return null;
    return { fetchedAt: parsed.fetchedAt, catalog: parsed.providers };
  } catch (_) { return null; }
}

function writePublicCatalogCache(home, fetchedAt, catalog) {
  const dir = cacheDirFor(home);
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('unsafe model-discovery directory');
  } catch (e) {
    if (e.code === 'ENOENT') fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    else throw e;
  }
  fs.chmodSync(dir, 0o700);
  const target = path.join(dir, PUBLIC_CATALOG_CACHE_FILE);
  const tmp = path.join(dir, `.public-catalog.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const payload = JSON.stringify({ version: CACHE_VERSION, kind: 'public-catalog', fetchedAt, providers: catalog });
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

// --- Public catalog mapping --------------------------------------------------
// Engine provider -> catalog provider id, as an explicit, TESTED table: no
// inference. The mapping decides the FIRST lookup namespace (the most
// pertinent one for that endpoint); every provider — local runtimes, custom
// gateways on unknown hosts included — can still be enriched by the by-id
// fallback below, which never guesses a namespace: it matches ids only.

const PUBLIC_CATALOG_PROVIDER_IDS = Object.freeze({
  zai: 'zai',
  'zai-a': 'zai',
  'zai-p': 'zai',
  'ollama-cloud': 'ollama-cloud',
  'opencode-go': 'opencode-go',
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-api': 'openai',
  'openai-codex': 'openai',
  deepseek: 'deepseek',
  openrouter: 'openrouter',
  nvidia: 'nvidia',
  xai: 'xai',
});

// Custom engines carry no provider type: an EXACT host match is the only
// fallback. No suffix or substring matching — a lookalike host maps to nothing.
const PUBLIC_CATALOG_HOSTS = Object.freeze({
  'api.z.ai': 'zai',
  'opencode.ai': 'opencode-go',
  'ollama.com': 'ollama-cloud',
  'api.anthropic.com': 'anthropic',
  'api.openai.com': 'openai',
  'openrouter.ai': 'openrouter',
  'api.deepseek.com': 'deepseek',
  'api.x.ai': 'xai',
  'integrate.api.nvidia.com': 'nvidia',
});

function publicCatalogProviderId({ provider, baseUrl } = {}) {
  const type = PUBLIC_CATALOG_PROVIDER_IDS[String(provider || '')];
  if (type) return type;
  const base = trimBase(baseUrl);
  if (!base) return null;
  let host;
  try { host = new URL(base).hostname.toLowerCase(); } catch (_) { return null; }
  return PUBLIC_CATALOG_HOSTS[host] || null;
}

// --- Public catalog by-id fallback --------------------------------------------
// Resolution per model id, in tiers. A tier's candidates are ALL the entries
// of that tier — never the first in Object.keys order — and the first tier
// (strongest first) that has candidates wins: weaker tiers are never
// consulted afterwards, so a conflict among the winning tier's candidates
// cannot be dodged by descending, and the snapshot's provider/key order
// cannot change the outcome.
//
//   1. mapped: the namespace of the engine's EXPLICIT provider/host mapping.
//      A field present here is never replaced by global consensus.
//   2. vendor: the namespace of a vendor prefix recognized by the explicit
//      table below, with the prefix removed for this resolution only. Any
//      other first segment is NOT a vendor and is never stripped.
//   3. global exact → 4. global case-folded → 5. global ":cloud"/"-cloud"
//      suffix stripped. Tags, versions, quantizations and "[1m]" markers are
//      never removed; the row keeps its original API id.
//
// Within the winning tier the agreement is per normalized field: a value
// enters when at least one valid value exists and all valid values are equal;
// absent/invalid values abstain (they are neither false nor zero), `false` is
// a value, and a disagreement leaves the field absent (counted, bounded).

// Vendor prefixes recognized for the namespace tier. Explicit and tested: a
// first segment not in this table is not a vendor, and is never stripped. The
// values are catalog provider ids, mirroring PUBLIC_CATALOG_PROVIDER_IDS.
const PUBLIC_CATALOG_VENDOR_IDS = Object.freeze({
  zai: 'zai',
  'z-ai': 'zai',
  anthropic: 'anthropic',
  openai: 'openai',
  deepseek: 'deepseek',
  openrouter: 'openrouter',
  nvidia: 'nvidia',
  xai: 'xai',
  'ollama-cloud': 'ollama-cloud',
  'opencode-go': 'opencode-go',
});
const PUBLIC_CATALOG_VENDOR_IDS_FOLDED = new Map(
  Object.entries(PUBLIC_CATALOG_VENDOR_IDS).map(([k, v]) => [k.toLowerCase(), v])
);

function publicCatalogVendorProviderId(prefix) {
  const p = String(prefix || '');
  return PUBLIC_CATALOG_VENDOR_IDS[p] || PUBLIC_CATALOG_VENDOR_IDS_FOLDED.get(p.toLowerCase()) || null;
}

// `z-ai/glm-5.3` -> { providerId: 'zai', rest: 'glm-5.3' }. Only the FIRST
// segment is considered, and only when the explicit table recognizes it.
function publicCatalogVendorSplit(apiId) {
  const id = String(apiId || '');
  const slash = id.indexOf('/');
  if (slash <= 0 || slash >= id.length - 1) return null;
  const providerId = publicCatalogVendorProviderId(id.slice(0, slash));
  return providerId ? { providerId, rest: id.slice(slash + 1) } : null;
}

function stripCloudSuffix(id) { return id.replace(/(?::cloud|-cloud)$/, ''); }

// Index over one snapshot object, reused across rows and engines, never
// persisted: a plain WeakMap keyed by the catalog object itself, so each
// actual snapshot (including one read with noCache) has its own index and a
// dropped snapshot drops its index with it. Built once per snapshot, not per
// row.
const publicCatalogIndexes = new WeakMap();

function publicCatalogIndex(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return null;
  const cached = publicCatalogIndexes.get(catalog);
  if (cached) return cached;
  const providers = new Map();  // providerId -> { exact: Map(key->entry), folded: Map(lc->[entry]) }
  const globalExact = new Map(); // key -> [entry]
  const globalFolded = new Map(); // lc(key) -> [entry]
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue;
    const models = provider.models && typeof provider.models === 'object' && !Array.isArray(provider.models)
      ? provider.models : null;
    if (!models) continue;
    const exact = new Map();
    const folded = new Map();
    for (const [key, model] of Object.entries(models)) {
      if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
      const entry = { provider: providerId, key, fields: normalizePublicCatalogModel(key, model) };
      exact.set(key, entry);
      const lc = key.toLowerCase();
      if (folded.has(lc)) folded.get(lc).push(entry); else folded.set(lc, [entry]);
      if (globalExact.has(key)) globalExact.get(key).push(entry); else globalExact.set(key, [entry]);
      if (globalFolded.has(lc)) globalFolded.get(lc).push(entry); else globalFolded.set(lc, [entry]);
    }
    providers.set(providerId, { exact, folded });
  }
  const index = { providers, globalExact, globalFolded };
  publicCatalogIndexes.set(catalog, index);
  return index;
}

// First non-empty tier (exact -> case-folded -> cloud-suffix stripped) within
// one provider namespace; ALL candidates of that tier, deduplicated.
function publicCatalogNamespaceCandidates(index, providerId, apiId) {
  const ns = index.providers.get(providerId);
  if (!ns) return [];
  const id = String(apiId || '');
  const out = [];
  const seen = new Set();
  const add = (entries) => {
    for (const entry of entries || []) if (!seen.has(entry)) { seen.add(entry); out.push(entry); }
  };
  const exact = ns.exact.get(id);
  if (exact) return [exact];
  add(ns.folded.get(id.toLowerCase()));
  if (out.length) return out;
  const stripped = stripCloudSuffix(id);
  if (stripped !== id) {
    const sExact = ns.exact.get(stripped);
    if (sExact) return [sExact];
    add(ns.folded.get(stripped.toLowerCase()));
  }
  return out;
}

// Same tier ladder across every provider of the snapshot.
function publicCatalogGlobalCandidates(index, apiId) {
  const id = String(apiId || '');
  const out = [];
  const seen = new Set();
  const add = (entries) => {
    for (const entry of entries || []) if (!seen.has(entry)) { seen.add(entry); out.push(entry); }
  };
  const exact = index.globalExact.get(id);
  if (exact) { add(exact); return out; }
  add(index.globalFolded.get(id.toLowerCase()));
  if (out.length) return out;
  const stripped = stripCloudSuffix(id);
  if (stripped !== id) {
    const sExact = index.globalExact.get(stripped);
    if (sExact) { add(sExact); return out; }
    add(index.globalFolded.get(stripped.toLowerCase()));
  }
  return out;
}

// Per-field agreement among one tier's candidates, restricted to `allowed`
// fields (null = all fields). Absent/invalid values abstain; a disagreement
// is a conflict and leaves the field absent.
function publicCatalogAgreement(entries, allowed) {
  const values = {};
  const conflictFields = [];
  let noData = 0;
  for (const field of MERGE_FIELDS) {
    if (allowed && !allowed.has(field)) continue;
    const vals = [];
    for (const entry of entries) {
      const v = entry.fields[field];
      if (v !== undefined) vals.push(v);
    }
    if (!vals.length) { noData += 1; continue; }
    if (vals.every((v) => v === vals[0])) values[field] = vals[0];
    else conflictFields.push(field);
  }
  return { values, conflictFields, noData };
}

function resolvePublicCatalogRow(index, mappedProviderId, apiId) {
  const fields = {};
  const blocked = new Set();
  // Tier 1: the mapped namespace of the engine's actual provider. Fields
  // present here stay; a field this tier disagrees on is blocked — a weaker
  // tier must not be used to dodge the conflict.
  if (mappedProviderId) {
    const entries = publicCatalogNamespaceCandidates(index, mappedProviderId, apiId);
    if (entries.length) {
      const agg = publicCatalogAgreement(entries, null);
      Object.assign(fields, agg.values);
      for (const f of agg.conflictFields) blocked.add(f);
    }
  }
  const allowed = new Set(MERGE_FIELDS.filter((f) => fields[f] === undefined && !blocked.has(f)));
  // The mapped tier's conflicts are diagnostics too: a field blocked here is
  // never consulted again, so counting it here and the fallback's own
  // conflicts later cannot count the same field twice.
  const stats = { matched: false, enriched: false, conflicts: blocked.size, noData: 0 };
  if (!allowed.size) return { fields, stats };
  // By-id ladder: a recognized vendor namespace first, then the global tiers.
  // The first step with candidates wins; weaker steps are never consulted.
  const split = publicCatalogVendorSplit(apiId);
  let entries = split ? publicCatalogNamespaceCandidates(index, split.providerId, split.rest) : [];
  if (!entries.length) entries = publicCatalogGlobalCandidates(index, apiId);
  if (!entries.length) return { fields, stats };
  stats.matched = true;
  const agg = publicCatalogAgreement(entries, allowed);
  Object.assign(fields, agg.values);
  stats.conflicts = blocked.size + agg.conflictFields.length;
  stats.noData = agg.noData;
  stats.enriched = Object.keys(agg.values).length > 0;
  return { fields, stats };
}

// Records plus bounded by-id counters for a set of proposal ids. Records keep
// the API id unchanged, so they merge onto the engine's own listing; ids that
// resolve to nothing produce no record — the model keeps whatever the other
// layers say. The public layer never adds a model to the proposal.
function resolvePublicCatalogRecords(catalog, mappedProviderId, modelIds) {
  const records = [];
  const byId = { rows: 0, enriched: 0, conflicts: 0, noData: 0 };
  const index = publicCatalogIndex(catalog);
  if (!index) return { records, byId };
  const seen = new Set();
  for (const apiId of Array.isArray(modelIds) ? modelIds : []) {
    if (typeof apiId !== 'string' || !apiId || seen.has(apiId)) continue;
    seen.add(apiId);
    const { fields, stats } = resolvePublicCatalogRow(index, mappedProviderId, apiId);
    if (stats.matched) byId.rows += 1;
    if (stats.enriched) byId.enriched += 1;
    byId.conflicts += stats.conflicts;
    byId.noData += stats.noData;
    if (Object.keys(fields).length) records.push({ id: apiId, ...fields });
  }
  return { records, byId };
}

// One normalized record per MATCHING api id. The record keeps the API id, so
// it merges onto the engine's own listing; catalog fields map as:
// limit.context -> contextWindow, limit.output -> maxTokens, tool_call ->
// tools, modalities.input "image" -> vision, reasoning -> reasoning,
// status "deprecated" -> deprecated. Absent catalog fields stay absent.
function normalizePublicCatalogModel(id, m) {
  const out = { id };
  const limit = m.limit && typeof m.limit === 'object' && !Array.isArray(m.limit) ? m.limit : {};
  if (Number.isSafeInteger(limit.context) && limit.context > 0) out.contextWindow = limit.context;
  if (Number.isSafeInteger(limit.output) && limit.output > 0) out.maxTokens = limit.output;
  if (typeof m.tool_call === 'boolean') out.tools = m.tool_call;
  const input = m.modalities && Array.isArray(m.modalities.input) ? m.modalities.input : null;
  if (input) out.vision = input.includes('image');
  if (typeof m.reasoning === 'boolean') out.reasoning = m.reasoning;
  if (m.status === 'deprecated') out.deprecated = true;
  return out;
}

// Backward-compatible shape: the resolved records alone.
function publicCatalogRecords(catalog, providerId, modelIds) {
  return resolvePublicCatalogRecords(catalog, providerId, modelIds).records;
}

// --- Precedence merge -------------------------------------------------------
// Field-by-field, per the approved precedence order: user (fleet.json) > provider API >
// public catalog (models.dev snapshot, lot 2) > internal backup > known-gone.
// The user layer also fixes the ORDER: user-declared models come first, so the
// cap can never cut them out of the proposal. The last layer carries BARE IDS
// of models the API listed on a previous fetch and no longer lists: they carry
// no fields (nothing below the real layers may invent data), they only keep
// the row alive with `inApi: false` — a model that was there never silently
// disappears from the proposal.

function mergeModelRecords({
  userModels = [], apiModels = [], publicCatalogModels = [], backupModels = [],
  knownModels = [], apiKnown = true, fetchedAt = 0, cap = DISCOVERY_PROPOSAL_CAP,
} = {}) {
  const layers = [
    { name: 'user', models: userModels },
    { name: 'api', models: apiModels },
    { name: 'public', models: publicCatalogModels },
    { name: 'backup', models: backupModels },
    { name: 'known', models: knownModels },
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
  // Raw API layer with cache + fallback. `noCache: true` disattiva la cache in
  // ENTRAMBE le direzioni: nessuna lettura, nessuna scrittura, e su errore la
  // ricaduta e' il backup (vuoto), non l'ultimo valore buono.
  // Returns:
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
    const endpoint = endpointFingerprint(baseUrl);
    // `noCache` deve voler dire UNA cosa: nessuna cache. Non solo «salta il
    // valore fresco», ma nemmeno LEGGE (per ricadere sull'ultimo buono) e
    // nemmeno SCRIVE. Il caso che l'ha imposto: una fixture ha scritto la cache
    // nella home vera dell'operatore; e con `noCache` attivo una lettura ferma
    // non e' una risposta, e' un residuo di ieri.
    // L'UNICA lettura che sopravvive a noCache e' il listing PRECEDENTE, e non
    // come risposta: serve solo a calcolare quali id l'API ha tolto (il delta
    // «prima c'era, ora no»). La risposta non esce mai dal file e il file non
    // si scrive: e' storia, non cache attiva.
    const previous = home ? readCache(home, engine, endpoint) : null;
    const cached = !noCache ? previous : null;
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
      // Attempt metadata of the failed request rides the fallback so the
      // caller can diagnose WHAT rejected the listing (fixed status/category,
      // credential applied or not). Ephemeral only: nothing here is cached.
      const failed = error instanceof DiscoveryError && typeof error.credentialSent === 'boolean'
        ? {
          ...(Number.isSafeInteger(error.status) ? { status: error.status } : {}),
          ...(typeof error.category === 'string' ? { category: error.category } : {}),
          credentialSent: error.credentialSent,
        }
        : null;
      if (cached) {
        return {
          status: 'cache', fetchedAt: cached.fetchedAt, stale: true, error: reason,
          ...(failed ? { attempt: failed } : {}),
          apiModels: cached.models.map((m) => ({ ...m })),
        };
      }
      return { status: 'backup', fetchedAt: 0, stale: false, error: reason, ...(failed ? { attempt: failed } : {}), apiModels: [] };
    }
    const fetchedAt = now();
    // Il delta degli spariti si calcola SOLO su una lettura vera: la risposta
    // fresca riuscita contro il listing precedente. Gli id che mancano restano
    // fuori dalla cache appena scritta: il file conserva il listing come
    // l'API l'ha dato, non la nostra storia.
    const freshIds = new Set(apiModels.map((m) => m.id));
    const disappeared = previous
      ? previous.models.filter((m) => !freshIds.has(m.id)).map((m) => m.id)
      : [];
    // The write follows the SUCCESS, not the size: an empty listing that the
    // API answered with replaces the previous one. Failures never reach here.
    if (!noCache && home) {
      try { writeCache(home, engine, collector, fetchedAt, apiModels, endpoint); } catch (_) { /* cache is best-effort */ }
    }
    return {
      status: 'api', fetchedAt, stale: false, error: '',
      // The listing request went out: whether it carried the credential is
      // what separates an anonymous success from an authenticated one.
      attempt: { credentialSent: !!apiKey },
      apiModels: apiModels.map((m) => ({ ...m })),
      ...(disappeared.length ? { disappeared } : {}),
    };
  }

  // Public catalog snapshot with cache + fallback. Same contract shape as
  // fetchEngineModels, minus any key — and the SAME noCache contract as the
  // API layer: with `noCache` the snapshot is never served as the answer,
  // never used as a ripiego on failure, and never written (disk or memo):
  //   { status: 'api',    fetchedAt, stale: false, error: '', catalog }
  //   { status: 'cache',  fetchedAt, stale: true|false, error, catalog }  (last good)
  //   { status: 'none',   fetchedAt: 0, stale: false, error, catalog: null }
  let publicCatalogMemo = null; // { home, fetchedAt, catalog }: same-process reuse
  async function fetchPublicCatalogSnapshot(opts = {}) {
    const {
      home, noCache = false, ttlMs = PUBLIC_CATALOG_TTL_MS,
      timeoutMs = PUBLIC_CATALOG_TIMEOUT_MS, fetchImpl = defaultFetchImpl,
    } = opts;
    if (typeof fetchImpl !== 'function') throw new DiscoveryError('no fetch implementation');
    const at = now();
    const memoFresh = !noCache && publicCatalogMemo && publicCatalogMemo.home === home
      && at - publicCatalogMemo.fetchedAt < ttlMs;
    if (memoFresh) {
      return {
        status: 'cache', fetchedAt: publicCatalogMemo.fetchedAt, stale: false, error: '',
        catalog: publicCatalogMemo.catalog,
      };
    }
    const cached = home ? readPublicCatalogCache(home) : null;
    if (!noCache && cached && at - cached.fetchedAt < ttlMs) {
      publicCatalogMemo = { home, fetchedAt: cached.fetchedAt, catalog: cached.catalog };
      return {
        status: 'cache', fetchedAt: cached.fetchedAt, stale: false, error: '',
        catalog: cached.catalog,
      };
    }
    let catalog;
    try {
      // Public endpoint: no key, no auth header, fixed accept header only.
      catalog = await httpJson(PUBLIC_CATALOG_URL, { fetchImpl, timeoutMs });
      if (!validateCatalogSnapshot(catalog)) throw new DiscoveryError('unexpected response shape');
    } catch (error) {
      const reason = error instanceof DiscoveryError ? error.reason : 'catalog fetch failed';
      if (cached && !noCache) {
        publicCatalogMemo = { home, fetchedAt: cached.fetchedAt, catalog: cached.catalog };
        return { status: 'cache', fetchedAt: cached.fetchedAt, stale: true, error: reason, catalog: cached.catalog };
      }
      return { status: 'none', fetchedAt: 0, stale: false, error: reason, catalog: null };
    }
    const fetchedAt = now();
    // A forced read answers but leaves no trace: neither the memo nor the disk
    // snapshot is written under noCache.
    if (!noCache) publicCatalogMemo = { home, fetchedAt, catalog };
    if (home && !noCache) {
      try { writePublicCatalogCache(home, fetchedAt, catalog); } catch (_) { /* cache is best-effort */ }
    }
    return { status: 'api', fetchedAt, stale: false, error: '', catalog };
  }

  // Public layer for one engine: resolve the provider mapping, snapshot the
  // catalog (its own TTL, cache and fallback), then enrich the ids the
  // engine's proposal already carries — from the mapped namespace first, and
  // for the fields still absent (or without a mapping at all) by id across
  // the whole snapshot: custom gateways and local endpoints included. The
  // public catalog COMPLETES fields; it never adds models to the proposal.
  // Nothing about the engine's endpoint (model names, URLs, keys) is ever
  // sent to the catalog: the fetch is the one fixed public snapshot URL,
  // keyless. With no id to enrich the snapshot is not fetched at all.
  async function resolvePublicCatalogLayer(opts, apiModels, userModels, backupModels, knownIds) {
    const config = opts.publicCatalog && typeof opts.publicCatalog === 'object' ? opts.publicCatalog : {};
    const providerId = publicCatalogProviderId(config);
    const ids = [];
    const seen = new Set();
    const pushId = (id) => { if (id && !seen.has(id)) { seen.add(id); ids.push(id); } };
    for (const list of [userModels, apiModels, backupModels]) {
      for (const m of Array.isArray(list) ? list : []) {
        pushId(m && typeof m.id === 'string' ? m.id : null);
      }
    }
    // Known-gone ids stay in the proposal as bare rows: they are enrichable
    // like any other id already present.
    for (const id of Array.isArray(knownIds) ? knownIds : []) {
      pushId(typeof id === 'string' ? id : null);
    }
    if (!ids.length) {
      return { providerId, records: [], summary: { providerId, status: 'skipped', records: 0 } };
    }
    // `noCache` is ONE contract on BOTH layers: a forced refresh that skips
    // the engine cache skips the public snapshot too. The engine-level flag
    // reaches the snapshot unless the publicCatalog config overrides it.
    const noCache = config.noCache === true || opts.noCache === true;
    const snapshot = await fetchPublicCatalogSnapshot({
      home: opts.home,
      ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.ttlMs !== undefined ? { ttlMs: config.ttlMs } : {}),
      ...(noCache ? { noCache: true } : {}),
    });
    if (!snapshot.catalog) {
      return {
        providerId, records: [],
        summary: { providerId, status: snapshot.status, error: snapshot.error, records: 0 },
      };
    }
    const { records, byId } = resolvePublicCatalogRecords(snapshot.catalog, providerId, ids);
    return {
      providerId, records,
      summary: {
        providerId, status: snapshot.status, fetchedAt: snapshot.fetchedAt,
        stale: snapshot.stale, error: snapshot.error, records: records.length,
        // Additive, bounded by-id counters (consumed by the view layer):
        // rows matched by id, rows that received at least one field, fields
        // blocked by disagreement, fields with no data among the candidates.
        byId: { rows: byId.rows, enriched: byId.enriched, conflicts: byId.conflicts, noData: byId.noData },
      },
    };
  }

  // Full engine view: API layer + user/backup layers merged per field, capped,
  // with `inApi` marked only when the API (or its last good value) actually
  // answered. The public catalog layer joins the merge when `publicCatalog`
  // describes the engine's provider (or when `publicCatalogModels` is supplied
  // pre-built, e.g. by tests and later UI lots).
  async function discoverEngine(opts = {}) {
    const {
      userModels = [], backupModels = [], publicCatalogModels, publicCatalog,
      cap = DISCOVERY_PROPOSAL_CAP,
    } = opts;
    const layer = await fetchEngineModels(opts);
    let publicModels = Array.isArray(publicCatalogModels) ? publicCatalogModels : [];
    let publicLayer = null;
    if (!Array.isArray(publicCatalogModels) && publicCatalog) {
      publicLayer = await resolvePublicCatalogLayer(
        opts, layer.apiModels, userModels, backupModels, layer.disappeared || []
      );
      publicModels = publicLayer.records;
    }
    const apiKnown = layer.status !== 'backup';
    const models = mergeModelRecords({
      userModels,
      apiModels: layer.apiModels,
      publicCatalogModels: publicModels,
      backupModels,
      knownModels: (layer.disappeared || []).map((id) => ({ id })),
      apiKnown,
      fetchedAt: layer.fetchedAt || now(),
      cap,
    });
    return {
      ...layer,
      source: layer.status,
      models,
      ...(publicLayer ? { publicCatalog: publicLayer.summary } : {}),
    };
  }

  return { fetchEngineModels, discoverEngine, fetchPublicCatalogSnapshot, limits: { cap: DISCOVERY_PROPOSAL_CAP } };
}

module.exports = {
  COLLECTOR_KINDS,
  DiscoveryError,
  createModelDiscovery,
  mergeModelRecords,
  normalizeModelRecord,
  collectorDefaultTtlMs,
  PUBLIC_CATALOG_URL,
  PUBLIC_CATALOG_TTL_MS,
  publicCatalogProviderId,
  publicCatalogVendorProviderId,
  publicCatalogVendorSplit,
  resolvePublicCatalogRecords,
  publicCatalogRecords,
  DISCOVERY_PROPOSAL_CAP,
  DEFAULT_TIMEOUT_MS,
};
