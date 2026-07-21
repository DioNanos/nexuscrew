export const FLEET_BACKUP_FORMAT = 'nexuscrew.fleet';
export const FLEET_BACKUP_VERSION = 3;
export const LEGACY_BACKUP_FORMAT = 'nexuscrew.cells';

const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const ENGINE_ID_RE = /^[a-z0-9._-]{1,32}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const POLICY = new Set(['standard', 'unsafe']);
const MAX_CWD = 4096;
const MAX_CWD_REL = 4096;
const MAX_MODEL = 256;
const MAX_PROMPT = 8192;
const MAX_CELLS = 32;
const MAX_ENGINES = 24;
const TOP_KEYS = new Set(['format', 'version', 'exportedAt', 'cells', 'engines']);
// v3 portatile: la cella ammette cwdRel (home-relative) e VIETA cwd (assoluta,
// device-specifica). Un backup v3 con cwd -> invalid-cell (fail-closed).
const CELL_KEYS_V3 = new Set(['id', 'cwdRel', 'engine', 'boot', 'model', 'models', 'permissionPolicies', 'systemPrompt', 'prompt']);
// Legacy v1 (nexuscrew.cells) / v2 (nexuscrew.fleet): cella con cwd assoluta,
// non portabile, da validare sul target al restore.
const CELL_KEYS_LEGACY = new Set(['id', 'cwd', 'engine', 'boot', 'model', 'models', 'permissionPolicies', 'systemPrompt', 'prompt']);

// normalizeCwdRel — mirror frontend del helper backend (lib/fleet/definitions.js).
// Pura, fail-closed: '' == home; niente assoluto, '..', NUL/C0/DEL, backslash,
// drive letter, leading sep. Normalizza (collassa '.' e vuoti) RIFIUTANDO
// traversal. Il backend rimane l'autorita' (realpath); qui si valida la forma.
function normalizeCwdRel(rel) {
  if (typeof rel !== 'string') return null;
  if (rel.length > MAX_CWD_REL) return null;
  for (let i = 0; i < rel.length; i += 1) {
    const c = rel.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x5c) return null;
  }
  if (rel === '') return '';
  if (rel.charAt(0) === '/') return null;
  if (/^[A-Za-z]:/.test(rel)) return null;
  const out = [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    out.push(seg);
  }
  return out.join('/');
}
const ENGINE_KEYS = new Set(['id', 'label', 'rc', 'managed', 'command', 'args', 'envKeys', 'model', 'promptMode', 'promptFlag']);
const MANAGED_KEYS = new Set(['client', 'provider', 'credentialProfile', 'model', 'permissionPolicy', 'displayName', 'protocol', 'baseUrl', 'envKey', 'providerId']);

function printable(value, max) {
  return typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}

function looksSecret(value) {
  const text = String(value || '');
  return /(?:bearer\s+|authorization\s*[:=]|(?:api[_-]?key|secret|token)\s*[:=])/i.test(text)
    // A sensitive flag is unsafe even when its value is the *next* argv item.
    // Rejecting the flag closes split forms such as `--api-key`, `sk-...`.
    || /^-{1,2}(?:api[-_]?key|access[-_]?key|auth(?:orization)?[-_]?token|token|secret|password|credential)(?:$|=)/i.test(text)
    || /\b(?:sk|fw|fpk|hf|zai)[-_][A-Za-z0-9._-]{8,}\b/i.test(text)
    || /https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(text);
}

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

// cleanBackupCell — cella portatile v3. cwdRel obbligatorio e canonico; cwd
// assoluta VIETATA (non in CELL_KEYS_V3 -> presenza -> null -> invalid-cell).
export function cleanBackupCell(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Object.keys(raw).some((key) => !CELL_KEYS_V3.has(key))) return null;
  if (!CELL_ID_RE.test(String(raw.id || ''))) return null;
  if (typeof raw.cwdRel !== 'string') return null;
  const cwdRel = normalizeCwdRel(raw.cwdRel);
  if (cwdRel === null) return null;
  if (!ENGINE_ID_RE.test(String(raw.engine || ''))) return null;
  if (raw.boot !== undefined && typeof raw.boot !== 'boolean') return null;
  if (raw.model !== undefined && (typeof raw.model !== 'string' || raw.model.length > MAX_MODEL)) return null;
  if (raw.systemPrompt !== undefined && raw.prompt !== undefined && raw.systemPrompt !== raw.prompt) return null;
  const systemPrompt = raw.systemPrompt === undefined ? (raw.prompt === undefined ? '' : raw.prompt) : raw.systemPrompt;
  if (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_PROMPT) return null;
  const models = cleanMap(raw.models, (v) => typeof v === 'string' && !!v && v.length <= MAX_MODEL);
  const permissionPolicies = cleanMap(raw.permissionPolicies, (v) => POLICY.has(v));
  if (models === null || permissionPolicies === null) return null;
  const out = { id: raw.id, cwdRel, engine: raw.engine, boot: raw.boot === true, systemPrompt };
  if (raw.model) out.model = raw.model;
  if (Object.keys(models).length) out.models = models;
  if (Object.keys(permissionPolicies).length) out.permissionPolicies = permissionPolicies;
  return out;
}

// cleanLegacyCell — cella legacy v1/v2 con cwd ASSOLUTA (non portabile). Va
// conservata per leggere i backup vecchi, ma al restore sara' il backend a
// validarla sul target (path di un altro device / inesistente -> rifiuto).
function cleanLegacyCell(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Object.keys(raw).some((key) => !CELL_KEYS_LEGACY.has(key))) return null;
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
  const out = { id: raw.id, cwd: raw.cwd, engine: raw.engine, boot: raw.boot === true, systemPrompt };
  if (raw.model) out.model = raw.model;
  if (Object.keys(models).length) out.models = models;
  if (Object.keys(permissionPolicies).length) out.permissionPolicies = permissionPolicies;
  return out;
}

function cleanManaged(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some((key) => !MANAGED_KEYS.has(key))) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !printable(value, key === 'baseUrl' ? 512 : 128) || looksSecret(value)) return null;
    out[key] = value;
  }
  if (!out.client || !out.provider) return null;
  if (out.envKey && !ENV_KEY_RE.test(out.envKey)) return null;
  return out;
}

export function cleanBackupEngine(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some((key) => !ENGINE_KEYS.has(key))) return null;
  if (!ENGINE_ID_RE.test(String(raw.id || '')) || !printable(raw.label || raw.id, 64)) return null;
  if (raw.rc !== undefined && typeof raw.rc !== 'boolean') return null;
  const out = { id: raw.id, label: raw.label || raw.id, rc: raw.rc === true };
  if (raw.managed !== undefined) {
    const managed = cleanManaged(raw.managed);
    if (!managed || ['command', 'args', 'envKeys', 'model', 'promptMode', 'promptFlag'].some((key) => raw[key] !== undefined)) return null;
    out.managed = managed;
    return out;
  }
  if (!printable(raw.command, 512) || !raw.command.startsWith('/')) return null;
  if (!Array.isArray(raw.args) || raw.args.length > 32
    || raw.args.some((arg) => !printable(arg, 1024) || looksSecret(arg))) return null;
  if (raw.promptMode !== 'flag' && raw.promptMode !== 'send-keys') return null;
  if (raw.promptMode === 'flag' && (!printable(raw.promptFlag, 32) || /\s/.test(raw.promptFlag))) return null;
  if (raw.model !== undefined) {
    if (!raw.model || typeof raw.model !== 'object' || Array.isArray(raw.model)
      || Object.keys(raw.model).some((key) => key !== 'flag' && key !== 'value')
      || !printable(raw.model.flag, 32) || /\s/.test(raw.model.flag)
      || !printable(raw.model.value || '', 128)) return null;
    out.model = { flag: raw.model.flag, value: raw.model.value || '' };
  }
  const envKeys = raw.envKeys === undefined ? [] : raw.envKeys;
  if (!Array.isArray(envKeys) || envKeys.length > 32 || envKeys.some((key) => !ENV_KEY_RE.test(key))) return null;
  Object.assign(out, { command: raw.command, args: [...raw.args], envKeys: [...new Set(envKeys)].sort(), promptMode: raw.promptMode });
  if (raw.promptMode === 'flag') out.promptFlag = raw.promptFlag;
  return out;
}

export function portableEngineDefinition(engine) {
  if (!engine || typeof engine !== 'object' || Array.isArray(engine)) return null;
  // `/fleet/definitions` adds runtime-only fields (`managedInfo`, and an empty
  // `envKeys` view for managed engines).  Build the portable allowlist
  // explicitly instead of silently dropping every managed engine export.
  const candidate = engine.managed ? {
    id: engine.id, label: engine.label, rc: engine.rc, managed: engine.managed,
  } : {
    id: engine.id, label: engine.label, rc: engine.rc, command: engine.command,
    args: engine.args, envKeys: engine.envKeys, model: engine.model,
    promptMode: engine.promptMode, promptFlag: engine.promptFlag,
  };
  const clean = cleanBackupEngine(candidate);
  if (!clean) return null;
  return clean;
}

export function createFleetBackup(cells, selectedCellIds, engines = [], selectedEngineIds = [], now = new Date()) {
  // Backward-compatible call used by old tests/callers: third argument was Date.
  if (engines instanceof Date) { now = engines; engines = []; selectedEngineIds = []; }
  const selectedCells = selectedCellIds instanceof Set ? selectedCellIds : new Set(selectedCellIds || []);
  const selectedEngines = selectedEngineIds instanceof Set ? selectedEngineIds : new Set(selectedEngineIds || []);
  const cleanCells = [];
  for (const cell of Array.isArray(cells) ? cells : []) {
    if (!selectedCells.has(cell.id)) continue;
    // Fail-closed: una cella SELEZIONATA priva di cwdRel portabile (es. cella
    // needsRepair) NON viene mai omessa silenziosamente. Si restituisce un
    // errore esplicito che il caller (FleetBackupDialog) mostra via i18n
    // fleet-backup-invalid-cell. NESSUNA cwd assoluta nel backup v3.
    const clean = cleanBackupCell({
      id: cell.id, cwdRel: cell.cwdRel, engine: cell.engine, boot: cell.boot === true,
      ...(cell.model ? { model: cell.model } : {}), ...(cell.models ? { models: cell.models } : {}),
      ...(cell.permissionPolicies ? { permissionPolicies: cell.permissionPolicies } : {}), systemPrompt: cell.prompt || '',
    });
    if (!clean) return { ok: false, error: 'invalid-cell', invalidCellIds: [cell.id] };
    cleanCells.push(clean);
  }
  const cleanEngines = [];
  for (const engine of Array.isArray(engines) ? engines : []) {
    if (!selectedEngines.has(engine.id)) continue;
    const clean = portableEngineDefinition(engine);
    if (clean) cleanEngines.push(clean);
  }
  return { format: FLEET_BACKUP_FORMAT, version: FLEET_BACKUP_VERSION, exportedAt: now.toISOString(), cells: cleanCells, engines: cleanEngines };
}

export function parseFleetBackup(text) {
  let value;
  try { value = JSON.parse(String(text || '')); }
  catch (_) { return { ok: false, error: 'invalid-json', cells: [], engines: [] }; }
  // Versioni accettate: v1 (nexuscrew.cells, cwd assoluta, senza engines),
  // v2 (nexuscrew.fleet, cwd assoluta, con engines) -> legacy/non portabili,
  // da validare sul target; v3 (nexuscrew.fleet, cwdRel portatile, corrente).
  const isV1 = value?.format === LEGACY_BACKUP_FORMAT && value?.version === 1;
  const isV2 = value?.format === FLEET_BACKUP_FORMAT && value?.version === 2;
  const isV3 = value?.format === FLEET_BACKUP_FORMAT && value?.version === FLEET_BACKUP_VERSION;
  const legacyCwd = isV1 || isV2; // le celle portano cwd assoluta
  const hasEngines = isV2 || isV3; // v1 non aveva engines
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !TOP_KEYS.has(key))
    || (!isV1 && !isV2 && !isV3)
    || !Array.isArray(value.cells) || value.cells.length > MAX_CELLS
    || (hasEngines && (!Array.isArray(value.engines) || value.engines.length > MAX_ENGINES))) {
    return { ok: false, error: 'invalid-format', cells: [], engines: [] };
  }
  const cells = []; const cellSeen = new Set();
  for (const raw of value.cells) {
    const cell = legacyCwd ? cleanLegacyCell(raw) : cleanBackupCell(raw);
    if (!cell) return { ok: false, error: 'invalid-cell', cells: [], engines: [] };
    if (cellSeen.has(cell.id)) return { ok: false, error: 'duplicate-cell', cells: [], engines: [] };
    cellSeen.add(cell.id); cells.push(cell);
  }
  const engines = []; const engineSeen = new Set();
  for (const raw of hasEngines ? value.engines : []) {
    const engine = cleanBackupEngine(raw);
    if (!engine) return { ok: false, error: 'invalid-engine', cells: [], engines: [] };
    if (engineSeen.has(engine.id)) return { ok: false, error: 'duplicate-engine', cells: [], engines: [] };
    engineSeen.add(engine.id); engines.push(engine);
  }
  return { ok: true, cells, engines, legacy: legacyCwd, exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '' };
}

export function restoreCellDefinition(cell, selectedEngine, availableEngineIds) {
  const engines = new Set(availableEngineIds || []);
  if (!engines.has(selectedEngine)) return null;
  const filterMap = (source) => Object.fromEntries(Object.entries(source || {}).filter(([id]) => engines.has(id)));
  const out = { id: cell.id, engine: selectedEngine, boot: cell.boot === true, prompt: cell.systemPrompt || '' };
  // v3 portatile: cwdRel (il backend calcola la cwd assoluta target). Legacy
  // v1/v2: cwd assoluta (il backend la rifiuta in modo strutturato se non
  // valida sul target). Mai entrambi.
  if (typeof cell.cwdRel === 'string') out.cwdRel = cell.cwdRel;
  else if (typeof cell.cwd === 'string' && cell.cwd) out.cwd = cell.cwd;
  if (selectedEngine === cell.engine && cell.model) out.model = cell.model;
  else if (cell.models && cell.models[selectedEngine]) out.model = cell.models[selectedEngine];
  const models = filterMap(cell.models); const permissionPolicies = filterMap(cell.permissionPolicies);
  if (Object.keys(models).length) out.models = models;
  if (Object.keys(permissionPolicies).length) out.permissionPolicies = permissionPolicies;
  return out;
}
