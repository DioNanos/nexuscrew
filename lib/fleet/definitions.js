'use strict';
// B4.1 — Definizioni fleet editabili (~/.nexuscrew/fleet.json).
// Modulo PURO: nessun side-effect all'import. Tutto l'I/O vive in
// loadDefinitions/atomicWrite; parseDefinitions/validateCommandTrust non
// toccano il filesystem se non per le stat di trust (sincrone, come binTrusted).
//
// Principio: fail-closed. Qualunque dato malformato -> null, MAI throw non
// gestito. Le definizioni contengono comandi arbitrari (design §6), quindi la
// validazione e' STRICT (garbage -> errore, non guess). Stesso confinamento di
// lib/fs/routes.js e lib/tmux/lifecycle.js.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// --- Cap + identita' (dichiarati; ragionevoli per un file di flotta locale) ---
const SCHEMA_VERSION = 1;
const MAX_ENGINES = 24;
const MAX_CELLS = 32;
const MAX_ARGS = 32;            // argv: array, mai stringa spezzata (no shell)
const MAX_ARG_LEN = 1024;      // 1 KB per arg
const MAX_ENV_KEYS = 32;
const MAX_ENV_KEY_LEN = 64;
const MAX_ENV_VAL_LEN = 4096;  // 4 KB
const MAX_LABEL_LEN = 64;
const MAX_COMMAND_LEN = 512;
const MAX_CWD_LEN = 4096;
const MAX_MODEL_FLAG_LEN = 32;
const MAX_MODEL_VAL_LEN = 128;
const MAX_PROMPTFLAG_LEN = 32;
const MAX_PROMPT_LEN = 8192;   // 8 KB
const MAX_TMUXSESSION_LEN = 64;

const ENGINE_ID_RE = /^[a-z0-9._-]{1,32}$/;   // engine id: lowercase (design 4a/9f)
const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;   // cell id: ammette maiuscole
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/; // identificatore env POSIX-like
const TMUX_NAME_RE = /^[\w.-]{1,64}$/;         // come lifecycle NAME_RE

// Denylist dura di chiavi loader/runtime (design 9a): chi le imposta altera
// l'esecuzione controllata dal service -> rifiuta l'INTERO documento.
const ENV_DENY_EXACT = new Set(['PATH', 'SHELL', 'HOME', 'NODE_OPTIONS']);
const ENV_DENY_PREFIX = ['NPM_CONFIG_', 'LD_', 'DYLD_'];

function envKeyDenied(k) {
  if (ENV_DENY_EXACT.has(k)) return true;
  for (const p of ENV_DENY_PREFIX) { if (k.startsWith(p)) return true; }
  return false;
}

// Solo testo stampabile per le label UI (no control char 0x00-0x1f, no DEL).
function isPrintable(s) {
  if (typeof s !== 'string') return false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

// Singolo elemento argv: no whitespace, no control char (design 9f: niente
// spazi/shell). Vale per model.flag e promptFlag.
function isSingleArgv(s) {
  if (typeof s !== 'string' || !s) return false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return false;
  }
  return true;
}

function validTmuxName(name) {
  return typeof name === 'string'
    && name.length <= MAX_TMUXSESSION_LEN
    && TMUX_NAME_RE.test(name)
    && !name.startsWith('-');
}

// ---------------------------------------------------------------------------
// parseDefinitions(raw) -> {schemaVersion, engines, cells} | null
// Accetta stringa JSON o oggetto gia' parsato. Strict + fail-closed.
// ---------------------------------------------------------------------------
function parseDefinitions(raw) {
  try {
    let d;
    if (typeof raw === 'string') {
      try { d = JSON.parse(raw); } catch (_) { return null; }
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      d = raw;
    } else {
      return null;
    }

    if (d.schemaVersion !== SCHEMA_VERSION) return null;
    if (!Array.isArray(d.engines)) return null;          // engines obbligatorio (array)
    if (d.engines.length > MAX_ENGINES) return null;
    if (!Array.isArray(d.cells)) return null;            // cells obbligatorio (array)
    if (d.cells.length > MAX_CELLS) return null;

    const engineIds = new Set();
    const engines = [];
    for (const e of d.engines) {
      const eng = parseEngine(e);
      if (!eng) return null;
      if (engineIds.has(eng.id)) return null;            // id engine univoco
      engineIds.add(eng.id);
      engines.push(eng);
    }

    const tmuxSeen = new Set();
    const cellIds = new Set();
    const cells = [];
    for (const c of d.cells) {
      const cell = parseCell(c, engineIds);
      if (!cell) return null;
      if (cellIds.has(cell.id)) return null;             // id cell univoco
      cellIds.add(cell.id);
      if (tmuxSeen.has(cell.tmuxSession)) return null;   // tmuxSession univoco
      tmuxSeen.add(cell.tmuxSession);
      cells.push(cell);
    }

    return { schemaVersion: SCHEMA_VERSION, engines, cells };
  } catch (_) {
    return null; // fail-closed: qualunque eccezione inattesa -> null, MAI throw
  }
}

function parseEngine(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;

  // id
  if (typeof e.id !== 'string' || !ENGINE_ID_RE.test(e.id)) return null;

  // label (opzionale, default = id; solo stampabile)
  let label = e.id;
  if (e.label !== undefined) {
    if (typeof e.label !== 'string' || !isPrintable(e.label) || e.label.length > MAX_LABEL_LEN) return null;
    label = e.label;
  }
  if (!label) label = e.id; // etichetta vuota -> fallback id

  // rc (opzionale, default false: remote-control e' l'eccezione)
  let rc = false;
  if (e.rc !== undefined) {
    if (typeof e.rc !== 'boolean') return null;
    rc = e.rc;
  }

  // command (obbligatorio, stringa non vuota; il trust si verifica a parte)
  if (typeof e.command !== 'string' || !e.command || e.command.length > MAX_COMMAND_LEN) return null;

  // args (opzionale, default [])
  let args = [];
  if (e.args !== undefined) {
    if (!Array.isArray(e.args) || e.args.length > MAX_ARGS) return null;
    args = [];
    for (const a of e.args) {
      if (typeof a !== 'string' || a.length > MAX_ARG_LEN) return null;
      args.push(a);
    }
  }

  // env (opzionale, default {}); chiavi identificadori + denylist dura
  let env = {};
  if (e.env !== undefined) {
    if (!e.env || typeof e.env !== 'object' || Array.isArray(e.env)) return null;
    const keys = Object.keys(e.env);
    if (keys.length > MAX_ENV_KEYS) return null;
    env = {};
    for (const k of keys) {
      if (k.length > MAX_ENV_KEY_LEN || !ENV_KEY_RE.test(k)) return null;
      if (envKeyDenied(k)) return null; // loader/runtime key -> rifiuta tutto
      const v = e.env[k];
      if (typeof v !== 'string' || v.length > MAX_ENV_VAL_LEN) return null;
      env[k] = v;
    }
  }

  // promptMode (obbligatorio: l'engine dichiara come iniettare il prompt)
  if (e.promptMode !== 'flag' && e.promptMode !== 'send-keys') return null;
  const promptMode = e.promptMode;

  // model (opzionale {flag, value}); flag = singolo argv senza spazi
  let model;
  if (e.model !== undefined) {
    if (!e.model || typeof e.model !== 'object' || Array.isArray(e.model)) return null;
    if (typeof e.model.flag !== 'string' || !isSingleArgv(e.model.flag) || e.model.flag.length > MAX_MODEL_FLAG_LEN) return null;
    const value = e.model.value !== undefined ? e.model.value : '';
    if (typeof value !== 'string' || value.length > MAX_MODEL_VAL_LEN) return null;
    model = { flag: e.model.flag, value };
  }

  // promptFlag (richiesto solo se promptMode==='flag'; singolo argv)
  let promptFlag;
  if (promptMode === 'flag') {
    if (typeof e.promptFlag !== 'string' || !isSingleArgv(e.promptFlag) || e.promptFlag.length > MAX_PROMPTFLAG_LEN) return null;
    promptFlag = e.promptFlag;
  }
  // promptMode!=='flag' con promptFlag presente -> ignorato (campo non rilevante)

  const out = { id: e.id, label, rc, command: e.command, args, env, promptMode };
  if (model) out.model = model;
  if (promptFlag !== undefined) out.promptFlag = promptFlag;
  return out;
}

function parseCell(c, engineIds) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;

  // id
  if (typeof c.id !== 'string' || !CELL_ID_RE.test(c.id)) return null;

  // cwd (obbligatorio; la risoluzione/confinamento avviene via resolveCwd a runtime)
  if (typeof c.cwd !== 'string' || !c.cwd || c.cwd.length > MAX_CWD_LEN) return null;

  // engine = riferimento a engines[].id esistente (dangling -> null)
  if (typeof c.engine !== 'string' || !engineIds.has(c.engine)) return null;

  // boot (opzionale, default false)
  let boot = false;
  if (c.boot !== undefined) {
    if (typeof c.boot !== 'boolean') return null;
    boot = c.boot;
  }

  // model override (opzionale, stringa = value per l'engine)
  let model;
  if (c.model !== undefined) {
    if (typeof c.model !== 'string' || c.model.length > MAX_MODEL_VAL_LEN) return null;
    model = c.model;
  }

  // prompt (opzionale, cap)
  let prompt;
  if (c.prompt !== undefined) {
    if (typeof c.prompt !== 'string' || c.prompt.length > MAX_PROMPT_LEN) return null;
    prompt = c.prompt;
  }

  // tmuxSession: campo esplicito o derivato da id. UNIVOCO (check in caller).
  // Namespace cloud-* RISERVATO al fleet (coerente con lifecycle.js: le celle
  // sono cloud-<Cell>): un override esplicito che usa cloud-* e' rifiutato,
  // PERCHE' accettare un cloud-* diverso dal proprio aliaserebbe la sessione
  // di un'altra cella fleet. Si ammette SOLO il derivato canonico cloud-<id>
  // della cella stessa (forma normale, sopravvive al round-trip su disco).
  const canonical = `cloud-${c.id}`;
  let tmuxSession;
  if (c.tmuxSession !== undefined) {
    if (typeof c.tmuxSession !== 'string' || !validTmuxName(c.tmuxSession)) return null;
    if (/^cloud-/i.test(c.tmuxSession) && c.tmuxSession !== canonical) return null; // alias cloud-* -> null
    tmuxSession = c.tmuxSession;
  } else {
    tmuxSession = canonical;
  }

  const out = { id: c.id, cwd: c.cwd, engine: c.engine, boot, tmuxSession };
  if (model !== undefined) out.model = model;
  if (prompt !== undefined) out.prompt = prompt;
  return out;
}

// ---------------------------------------------------------------------------
// validateCommandTrust(command) -> {ok, reason}
// Path assoluto, regular file, owner-executable, NON symlink (lstat), NON
// world-writable. Riutilizza il pattern di binTrusted in lib/fleet/index.js.
// ---------------------------------------------------------------------------
function validateCommandTrust(command) {
  if (typeof command !== 'string' || !command) return { ok: false, reason: 'command vuoto' };
  if (!path.isAbsolute(command)) return { ok: false, reason: 'command deve essere un path assoluto' };
  let st;
  try { st = fs.lstatSync(command); } catch (e) { return { ok: false, reason: `non accessibile (${e.code || e.message})` }; }
  if (!st.isFile()) return { ok: false, reason: 'non e\' un file regolare (symlink o speciale)' }; // lstat: symlink -> isFile()=false
  if (!(st.mode & 0o100)) return { ok: false, reason: 'non eseguibile dall\'owner' };
  if (st.mode & 0o002) return { ok: false, reason: 'world-writable' };
  // Owner check (design §9a, audit impl #4): il command deve appartenere
  // all'utente del service o a root — un owner terzo potrebbe sostituire
  // l'eseguibile mantenendo il path "trusted".
  if (typeof process.getuid === 'function') {
    const uid = process.getuid();
    if (st.uid !== uid && st.uid !== 0) return { ok: false, reason: 'owner non fidato (ne\' utente del service ne\' root)' };
  }
  return { ok: true, reason: 'trusted' };
}

// ---------------------------------------------------------------------------
// resolveCwd(cwd, home) -> path|null
// realpath SOTTO la home (default process.env.HOME); stesso confinamento di
// lib/tmux/lifecycle.js: realpath su entrambi (symlink dentro home che punta
// fuori -> rifiutato) e deve essere una directory.
// ---------------------------------------------------------------------------
function resolveCwd(cwd, home) {
  try {
    const h = home || process.env.HOME;
    if (typeof cwd !== 'string' || !cwd || typeof h !== 'string' || !h) return null;
    if (cwd.includes('\0') || h.includes('\0')) return null;
    const real = fs.realpathSync(cwd);
    const realHome = fs.realpathSync(h);
    if (!fs.statSync(real).isDirectory()) return null;
    if (real !== realHome && !real.startsWith(realHome + path.sep)) return null;
    return real;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// loadDefinitions(p) -> parsed | null
// Legge il file rifiutando i symlink; parse strict. Mai throw.
// ---------------------------------------------------------------------------
function loadDefinitions(p) {
  try {
    let st;
    try { st = fs.lstatSync(p); } catch (_) { return null; } // missing -> null
    if (st.isSymbolicLink()) return null;                    // no symlink
    if (!st.isFile()) return null;
    const raw = fs.readFileSync(p, 'utf8');
    return parseDefinitions(raw);
  } catch (_) { return null; }
}

// Backup best-effort del predecessore (su fallimento di validazione, o comunque
// prima di sovrascrivere). Sempre 0600.
function backupPredecessor(p) {
  try {
    if (!fs.lstatSync(p).isFile()) return;
    const bak = `${p}.bak`;
    fs.copyFileSync(p, bak);
    fs.chmodSync(bak, 0o600);
  } catch (_) { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// atomicWrite(p, data) -> parsed
// data: oggetto definizioni OPPURE stringa JSON. Valida PRIMA di scrivere
// (fail-closed: dati invalidi -> backup del predecessore + throw, mai scritti).
// Scrittura atomica: tmp nella stessa dir + rename; file mode 0600; rifiuto
// se il target esiste ed e' un symlink.
// ---------------------------------------------------------------------------
function atomicWrite(p, data) {
  // Rifiuta symlink come target: mai scrivere attraverso un link.
  try {
    if (fs.lstatSync(p).isSymbolicLink()) {
      throw new Error('refuse to write: il target e\' un symlink');
    }
  } catch (e) {
    if (e.code === 'ENOENT') { /* nuovo file, ok */ }
    else throw e; // inclusi i nostri 'refuse to write'
  }

  const parsed = parseDefinitions(data);
  if (!parsed) {
    backupPredecessor(p); // conserva il precedente per recovery/forensics
    throw new Error('definizioni fleet non valide: validazione fallita');
  }

  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // forza 0600 a prescindere da umask/file preesistente
    fs.renameSync(tmp, p);    // atomico sullo stesso filesystem (stessa dir)
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* cleanup best-effort */ }
    throw e;
  }
  return parsed;
}

const CAPS = {
  SCHEMA_VERSION, MAX_ENGINES, MAX_CELLS, MAX_ARGS, MAX_ARG_LEN,
  MAX_ENV_KEYS, MAX_ENV_KEY_LEN, MAX_ENV_VAL_LEN, MAX_LABEL_LEN,
  MAX_COMMAND_LEN, MAX_CWD_LEN, MAX_MODEL_FLAG_LEN, MAX_MODEL_VAL_LEN,
  MAX_PROMPTFLAG_LEN, MAX_PROMPT_LEN, MAX_TMUXSESSION_LEN,
};

module.exports = {
  parseDefinitions,
  validateCommandTrust,
  resolveCwd,
  loadDefinitions,
  atomicWrite,
  CAPS,
  // Costanti esposte anche piatte (comode per la UI/schema e i test)
  SCHEMA_VERSION, MAX_ENGINES, MAX_CELLS, MAX_ARGS, MAX_ARG_LEN,
  MAX_ENV_KEYS, MAX_ENV_KEY_LEN, MAX_ENV_VAL_LEN, MAX_PROMPT_LEN,
};
