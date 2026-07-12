export const FLEET_BACKUP_FORMAT = 'nexuscrew.cells';
export const FLEET_BACKUP_VERSION = 1;

const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const ENGINE_ID_RE = /^[a-z0-9._-]{1,32}$/;
const POLICY = new Set(['standard', 'unsafe']);
const MAX_CWD = 4096;
const MAX_MODEL = 256;
const MAX_PROMPT = 8192;
const MAX_CELLS = 32;
const TOP_KEYS = new Set(['format', 'version', 'exportedAt', 'cells']);
const CELL_KEYS = new Set(['id', 'cwd', 'engine', 'boot', 'model', 'models', 'permissionPolicies', 'systemPrompt', 'prompt']);

function cleanMap(value, validate) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 128) return null;
  const out = {};
  for (const [key, item] of entries) {
    if (!ENGINE_ID_RE.test(key) || !validate(item)) return null;
    out[key] = item;
  }
  return out;
}

export function cleanBackupCell(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Object.keys(raw).some((key) => !CELL_KEYS.has(key))) return null;
  if (!CELL_ID_RE.test(String(raw.id || ''))) return null;
  if (typeof raw.cwd !== 'string' || !raw.cwd || raw.cwd.length > MAX_CWD) return null;
  if (!ENGINE_ID_RE.test(String(raw.engine || ''))) return null;
  if (raw.boot !== undefined && typeof raw.boot !== 'boolean') return null;
  if (raw.model !== undefined && (typeof raw.model !== 'string' || raw.model.length > MAX_MODEL)) return null;
  if (raw.systemPrompt !== undefined && raw.prompt !== undefined && raw.systemPrompt !== raw.prompt) return null;
  const systemPrompt = raw.systemPrompt === undefined ? (raw.prompt === undefined ? '' : raw.prompt) : raw.systemPrompt;
  if (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_PROMPT) return null;
  const models = cleanMap(raw.models, (v) => typeof v === 'string' && !!v && v.length <= MAX_MODEL);
  const permissionPolicies = cleanMap(raw.permissionPolicies, (v) => POLICY.has(v));
  if (models === null || permissionPolicies === null) return null;
  const out = {
    id: raw.id, cwd: raw.cwd, engine: raw.engine, boot: raw.boot === true,
    systemPrompt,
  };
  if (raw.model) out.model = raw.model;
  if (Object.keys(models).length) out.models = models;
  if (Object.keys(permissionPolicies).length) out.permissionPolicies = permissionPolicies;
  return out;
}

export function createFleetBackup(cells, selectedIds, now = new Date()) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const out = [];
  for (const cell of Array.isArray(cells) ? cells : []) {
    if (!selected.has(cell.id)) continue;
    const clean = cleanBackupCell({
      id: cell.id, cwd: cell.cwd, engine: cell.engine, boot: cell.boot === true,
      ...(cell.model ? { model: cell.model } : {}),
      ...(cell.models ? { models: cell.models } : {}),
      ...(cell.permissionPolicies ? { permissionPolicies: cell.permissionPolicies } : {}),
      systemPrompt: cell.prompt || '',
    });
    if (clean) out.push(clean);
  }
  return {
    format: FLEET_BACKUP_FORMAT,
    version: FLEET_BACKUP_VERSION,
    exportedAt: now.toISOString(),
    cells: out,
  };
}

export function parseFleetBackup(text) {
  let value;
  try { value = JSON.parse(String(text || '')); }
  catch (_) { return { ok: false, error: 'invalid-json', cells: [] }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !TOP_KEYS.has(key))
    || value.format !== FLEET_BACKUP_FORMAT || value.version !== FLEET_BACKUP_VERSION
    || !Array.isArray(value.cells) || value.cells.length > MAX_CELLS) {
    return { ok: false, error: 'invalid-format', cells: [] };
  }
  const seen = new Set();
  const cells = [];
  for (const raw of value.cells) {
    const cell = cleanBackupCell(raw);
    if (!cell) return { ok: false, error: 'invalid-cell', cells: [] };
    if (seen.has(cell.id)) return { ok: false, error: 'duplicate-cell', cells: [] };
    seen.add(cell.id); cells.push(cell);
  }
  return { ok: true, cells, exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '' };
}

export function restoreCellDefinition(cell, selectedEngine, availableEngineIds) {
  const engines = new Set(availableEngineIds || []);
  if (!engines.has(selectedEngine)) return null;
  const filterMap = (source) => Object.fromEntries(Object.entries(source || {}).filter(([id]) => engines.has(id)));
  const out = {
    id: cell.id, cwd: cell.cwd, engine: selectedEngine, boot: cell.boot === true,
    prompt: cell.systemPrompt || '',
  };
  if (selectedEngine === cell.engine && cell.model) out.model = cell.model;
  else if (cell.models && cell.models[selectedEngine]) out.model = cell.models[selectedEngine];
  const models = filterMap(cell.models);
  const permissionPolicies = filterMap(cell.permissionPolicies);
  if (Object.keys(models).length) out.models = models;
  if (Object.keys(permissionPolicies).length) out.permissionPolicies = permissionPolicies;
  return out;
}
