'use strict';
// Profile inventory of the `vl` runtime on the node that runs the cell, and the
// capability gate that decides what `VL_MODEL` may carry.
//
// Two commands of the binary that will actually run, never a parser of its
// configuration file:
//   - `vl status`            -> capabilities.model_selector === "profile" says the
//                               binary reads a profile name in VL_MODEL;
//   - `vl models --json`     -> the profiles this node can run, value-free.
// The workspace version cannot tell the two apart (an old and a new vl both say
// 0.4.0), so the version is never consulted here.
//
// Everything that crosses back to the UI is rebuilt from a whitelist after the
// document has been validated field by field: a document with an unknown schema
// version, a value outside its closed vocabulary or an identifier that is not
// one is refused whole, and what refused it is named by FIELD, never echoed.
// No key value, endpoint, path or environment can come out of this module: the
// only inputs it trusts are these two documents, and it copies out of them only
// the fields listed in `entryFor`.

const { spawnSync } = require('node:child_process');

const STATUS_TIMEOUT_MS = 3000;
const MODELS_TIMEOUT_MS = 5000;
// Both documents are one short line; a binary that prints more is not speaking
// this contract.
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_PROFILES = 256;

const INVENTORY_SCHEMA_VERSION = 1;
const CAPABILITY_PROFILE = 'profile';

// Closed vocabularies of schema 1 (vl `config/inventory.rs`).
const INVENTORY_KINDS = new Set(['config', 'catalog']);
const ACTIVE_SOURCES = new Set(['env_profile', 'flag', 'live', 'config_default', 'selected', 'built_in']);
const ACTIVE_ERRORS = new Set(['unresolved', 'unexportable']);
const PROVIDERS = new Set(['anthropic', 'anthropic-bearer', 'openai-compat', 'openai', 'openai-codex', 'unrecognized']);
const SOURCES = new Set(['config', 'preset']);
const KEY_STATES = new Set(['present', 'absent', 'not_needed']);
const AUTH_SURFACES = new Set(['siwc', 'chatgpt-codex', 'unrecognized']);
const BUILT_IN_LABEL = '(built-in)';

// Identifier contract (the same shape vl enforces before it serializes): a profile
// id is [A-Za-z0-9._-], 1..64, first character alphanumeric; a model id adds
// `: / + [ ]`, 1..128, never `//`, `:/` or `..`.
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+[\]-]{0,127}$/;
const EFFORT_RE = /^[a-z][a-z0-9_-]{0,15}$/;

function validProfileId(value) {
  return typeof value === 'string' && PROFILE_ID_RE.test(value);
}

function validModelId(value) {
  return typeof value === 'string' && MODEL_ID_RE.test(value)
    && !value.includes('//') && !value.includes(':/') && !value.includes('..');
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveIntOrNull(value) {
  return value === null || (Number.isInteger(value) && value > 0);
}

// Run one subcommand of the binary: the exact binary and environment the cell
// gets, no tty, no stdin, bounded in time and output. The seam `cfg.vlProbe`
// replaces only this spawn (tests); it receives (binary, args, env) and returns
// the raw stdout, or null when the binary did not answer.
function runVl(binary, args, env, cfg, timeoutMs) {
  const probe = cfg && typeof cfg.vlProbe === 'function' ? cfg.vlProbe : null;
  if (probe) {
    const out = probe(binary, args, env);
    return out === null || out === undefined ? null : String(out);
  }
  const r = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'ignore'],
    env,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout || '';
}

function parseJsonLine(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_OUTPUT_BYTES) return null;
  try {
    const doc = JSON.parse(raw);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch (_) {
    return null;
  }
}

// The capability gate. `ok: true` only when `vl status` of THIS binary answers a
// JSON document whose capabilities.model_selector is exactly "profile". Anything
// else — no answer, not JSON, no field, another value — is `selector: null`, and
// the caller stays on the behaviour that does not put a profile name in
// VL_MODEL.
function probeSelectorCapability(binary, env, cfg = {}) {
  const raw = runVl(binary, ['status'], env, cfg, STATUS_TIMEOUT_MS);
  if (raw === null) return { selector: null, reason: 'vl status does not answer' };
  const doc = parseJsonLine(raw);
  if (!doc) return { selector: null, reason: 'vl status does not answer a JSON document' };
  const capabilities = doc.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return { selector: null, reason: 'vl status declares no capabilities' };
  }
  if (capabilities.model_selector !== CAPABILITY_PROFILE) {
    return { selector: null, reason: 'vl status does not declare capabilities.model_selector = "profile"' };
  }
  return { selector: CAPABILITY_PROFILE, reason: '' };
}

function refuse(reason) {
  return { ok: false, reason };
}

// Validate the whole document and rebuild a value-free inventory. Returns
// { ok: true, inventory } or { ok: false, reason }; the reason names the field.
function validateInventory(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return refuse('not a JSON object');
  if (doc.schema_version !== INVENTORY_SCHEMA_VERSION) {
    return refuse(`schema_version is not ${INVENTORY_SCHEMA_VERSION}: this NexusCrew reads only schema ${INVENTORY_SCHEMA_VERSION}`);
  }
  if (typeof doc.inventory !== 'string' || !INVENTORY_KINDS.has(doc.inventory)) return refuse('inventory is outside its vocabulary');
  let active = null;
  if (doc.active !== null) {
    const a = doc.active;
    if (!a || typeof a !== 'object' || Array.isArray(a)) return refuse('active is neither null nor an object');
    if (!(validProfileId(a.profile) || a.profile === BUILT_IN_LABEL)) return refuse('active.profile is not a valid identifier');
    if (typeof a.source !== 'string' || !ACTIVE_SOURCES.has(a.source)) return refuse('active.source is outside its vocabulary');
    active = { profile: a.profile, source: a.source };
  }
  if (doc.active_error !== null && !(typeof doc.active_error === 'string' && ACTIVE_ERRORS.has(doc.active_error))) {
    return refuse('active_error is outside its vocabulary');
  }
  if (typeof doc.preset_names_resolvable !== 'boolean') return refuse('preset_names_resolvable is missing');
  const excluded = doc.excluded;
  if (!excluded || typeof excluded !== 'object' || Array.isArray(excluded)
    || !isNonNegativeInt(excluded.not_assembled) || !isNonNegativeInt(excluded.invalid_identifier)) {
    return refuse('excluded is missing or malformed');
  }
  if (!Array.isArray(doc.profiles) || doc.profiles.length > MAX_PROFILES) return refuse('profiles is not a bounded list');
  const profiles = [];
  const seen = new Set();
  for (const p of doc.profiles) {
    const entry = entryFor(p);
    if (entry.error) return refuse(`profiles[${profiles.length}].${entry.error}`);
    // Two entries with one id would make a selection ambiguous; the document is
    // not trusted then. Two entries with one MODEL (accounts A and P) are normal.
    if (seen.has(entry.value.id)) return refuse(`profiles[${profiles.length}].id is repeated`);
    seen.add(entry.value.id);
    profiles.push(entry.value);
  }
  return {
    ok: true,
    inventory: {
      kind: doc.inventory,
      active,
      activeError: doc.active_error,
      presetNamesResolvable: doc.preset_names_resolvable,
      excluded: { notAssembled: excluded.not_assembled, invalidIdentifier: excluded.invalid_identifier },
      profiles,
    },
  };
}

// One profile: validated, then copied out field by field. Nothing else of the
// source object survives, whatever it carries.
function entryFor(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: 'is not an object' };
  if (!validProfileId(p.id)) return { error: 'id is not a valid identifier' };
  if (!(p.provider === null || (typeof p.provider === 'string' && PROVIDERS.has(p.provider)))) return { error: 'provider is outside its vocabulary' };
  if (!(p.model === null || validModelId(p.model))) return { error: 'model is not a valid identifier' };
  if (!isPositiveIntOrNull(p.context_window)) return { error: 'context_window is not a positive integer or null' };
  if (!isPositiveIntOrNull(p.max_output_tokens)) return { error: 'max_output_tokens is not a positive integer or null' };
  if (!Array.isArray(p.supported_efforts) || p.supported_efforts.length > 8
    || !p.supported_efforts.every((e) => typeof e === 'string' && EFFORT_RE.test(e))) {
    return { error: 'supported_efforts is malformed' };
  }
  if (typeof p.source !== 'string' || !SOURCES.has(p.source)) return { error: 'source is outside its vocabulary' };
  if (typeof p.key !== 'string' || !KEY_STATES.has(p.key)) return { error: 'key is outside its vocabulary' };
  if (!(p.auth_surface === null || (typeof p.auth_surface === 'string' && AUTH_SURFACES.has(p.auth_surface)))) {
    return { error: 'auth_surface is outside its vocabulary' };
  }
  return {
    value: {
      id: p.id,
      provider: p.provider,
      model: p.model,
      contextWindow: p.context_window,
      maxOutputTokens: p.max_output_tokens,
      source: p.source,
      key: p.key,
    },
  };
}

// The inventory of the binary that runs on this node. `ok: false` carries a
// declared reason; the inventory is never partially trusted.
function readInventory(binary, env, cfg = {}) {
  const raw = runVl(binary, ['models', '--json'], env, cfg, MODELS_TIMEOUT_MS);
  if (raw === null) return refuse('vl models --json does not answer');
  const doc = parseJsonLine(raw.trim());
  if (!doc) return refuse('vl models --json does not answer a JSON document');
  return validateInventory(doc);
}

const LIST_LIMIT = 8;

function listIds(ids) {
  const shown = ids.slice(0, LIST_LIMIT).join(', ');
  return ids.length > LIST_LIMIT ? `${shown}, … (${ids.length} in all)` : shown;
}

// The policy "NC offers and accepts only what the operator declared" is applied
// here, once, to every consumer of the inventory: an entry with source `preset`
// (the built-in catalog, listed by vl when the configuration declares nothing,
// or a built-in row of a declared list) is never an option and never a valid
// selector. `preset_names_resolvable` stays information about the runtime, not
// an authorization for NC to propose them.
function declaredProfiles(inventory) {
  return inventory.profiles.filter((p) => p.source === 'config');
}

const NONE_DECLARED_REASON = 'nessun profilo dichiarato nel config di vl del nodo: dichiara i profili da usare (profili del config, non i preset incorporati)';

// What `VL_MODEL=<value>` selects, decided the way the runtime decides it:
// the exact name of a profile first, then the model of exactly one profile of
// the inventory. Two profiles with that model (accounts A and P) are an error,
// never a preference. A name the inventory does not hold is refused here, before
// the cell starts, instead of failing inside it. The built-in preset names the
// runtime still resolves by name are NOT offered by this inventory and are not
// accepted by this preflight: the list is what the operator declared.
function resolveSelector(inventory, value) {
  const profiles = declaredProfiles(inventory);
  if (!profiles.length) {
    return { ok: false, reason: NONE_DECLARED_REASON };
  }
  const byId = profiles.find((p) => p.id === value);
  if (byId) return { ok: true, profile: byId.id, by: 'profile' };
  const byModel = profiles.filter((p) => p.model === value);
  if (byModel.length === 1) return { ok: true, profile: byModel[0].id, by: 'model' };
  if (byModel.length > 1) {
    return {
      ok: false,
      reason: `il selettore "${safeLabel(value)}" e' ambiguo: ${listIds(byModel.map((p) => p.id))} — scegli il nome del profilo`,
    };
  }
  const available = profiles.length ? listIds(profiles.map((p) => p.id)) : 'nessuno';
  return {
    ok: false,
    reason: `il selettore "${safeLabel(value)}" non e' fra i profili del nodo (${available}) — scegli uno dei profili elencati`,
  };
}

// The selector comes from a definition, i.e. from an operator, and goes into an
// error that reaches a UI: it is shown only when it is shaped like an identifier.
function safeLabel(value) {
  const text = String(value);
  return validModelId(text) ? text : '(valore non valido)';
}

// ---- UI listing ------------------------------------------------------------

// What the engine editor and the cell editor show: one option per profile, as
// `<model> · <profile id>`, the id being what is saved and passed. Two profiles
// with one model are two options. A profile with no key is shown and marked, not
// hidden: choosing it is the operator's call, the launch says what is missing.
function optionsFor(inventory) {
  return declaredProfiles(inventory).map((p) => ({
    value: p.id,
    label: `${p.model || p.id} · ${p.id}`,
    model: p.model,
    provider: p.provider,
    contextWindow: p.contextWindow,
    maxOutputTokens: p.maxOutputTokens,
    source: p.source,
    key: p.key,
  }));
}

// Short-lived cache for the listing, keyed by what the answer depends on: the
// binary file (path, size, mtime) and the keys the environment holds BY NAME
// (never by value). The launch preflight does not use it.
const CACHE_TTL_MS = 15000;
const cache = new Map();

function cacheKey(binary, env, statFn) {
  let stamp = '';
  try {
    const st = statFn(binary);
    stamp = `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch (_) { stamp = 'nostat'; }
  const relevant = Object.keys(env).filter((k) => /KEY|TOKEN|SECRET|VL_|XDG_/.test(k)).sort().join(',');
  return `${binary}\0${stamp}\0${relevant}\0${env.XDG_CONFIG_HOME || ''}`;
}

// The listing for one engine: { state, ... } where state is
//   ready       -> the binary declares the selector and the inventory is valid;
//   old         -> the binary does not declare the capability (or does not answer):
//                  no list, the engine keeps raw model ids;
//   invalid     -> the capability is declared but the document is refused;
//   none        -> the inventory is valid but the configuration declares no
//                  profile (only built-in presets, which are not offered).
// `reason` is a declared sentence, never a value.
function describeProfiles(binary, env, cfg = {}) {
  if (cfg.vlProfilesNoCache === true) return computeListing(binary, env, cfg);
  const now = typeof cfg.now === 'function' ? cfg.now() : Date.now();
  const fs = require('node:fs');
  const key = cacheKey(binary, env, fs.statSync);
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = computeListing(binary, env, cfg);
  cache.set(key, { at: now, value });
  if (cache.size > 32) cache.delete(cache.keys().next().value);
  return value;
}

function computeListing(binary, env, cfg) {
  const capability = probeSelectorCapability(binary, env, cfg);
  if (!capability.selector) return { state: 'old', reason: capability.reason, options: [] };
  const read = readInventory(binary, env, cfg);
  if (!read.ok) return { state: 'invalid', reason: read.reason, options: [] };
  const inv = read.inventory;
  // A node whose configuration declares no profile has nothing to offer: the
  // built-in catalog is not the operator's list.
  if (!declaredProfiles(inv).length) {
    return {
      state: 'none',
      reason: NONE_DECLARED_REASON,
      inventory: inv.kind,
      presetNamesResolvable: inv.presetNamesResolvable,
      excluded: inv.excluded,
      active: inv.active,
      activeError: inv.activeError,
      options: [],
    };
  }
  return {
    state: 'ready',
    reason: '',
    inventory: inv.kind,
    presetNamesResolvable: inv.presetNamesResolvable,
    excluded: inv.excluded,
    active: inv.active,
    activeError: inv.activeError,
    options: optionsFor(inv),
  };
}

function clearCache() {
  cache.clear();
}

module.exports = {
  INVENTORY_SCHEMA_VERSION, CAPABILITY_PROFILE,
  validProfileId, validModelId,
  probeSelectorCapability, validateInventory, readInventory, resolveSelector,
  optionsFor, describeProfiles, clearCache,
};
