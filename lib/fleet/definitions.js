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
const { normalizeManagedSpec } = require('./managed.js');

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
const MAX_CELL_COMMAND_LEN = 4096;
const MAX_TMUXSESSION_LEN = 64;

const ENGINE_ID_RE = /^[a-z0-9._-]{1,32}$/;   // engine id: lowercase (design 4a/9f)
const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;   // cell id: ammette maiuscole (il punto e' un id umano valido)
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/; // identificatore env POSIX-like
const TMUX_NAME_RE = /^[\w.-]{1,64}$/;         // parsing: ammette il punto (legacy puntato da migrare)
const TMUX_SAFE_NAME_RE = /^[\w-]{1,64}$/;     // scrittura: nomi tmux-safe (NO punto: tmux lo normalizza in '_')

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

// Un nome tmux e' "safe" se non contiene delimitatori che tmux rifiuta,
// interpreta o normalizza. L'unico raggiungibile via CELL_ID_RE/TMUX_NAME_RE e'
// il punto ('.' -> '_' silenzioso, poi trattato come separatore pane nei target).
// `:` non e' ammesso dai RE, e validTmuxName rifiuta gia' il leading '-': per
// costruzione il punto e' dunque l'unico carattere ostile coperto da questo gate.
function isTmuxSafeName(name) {
  return validTmuxName(name) && TMUX_SAFE_NAME_RE.test(name);
}

// Deriva il nome sessione tmux CANONICO di una cella. Puro, iniettivo, reversibile.
//  - ID senza punto: storico `cloud-<id>` (le sessioni esistenti non vengono
//    rinominate; il namespace e' tmux-safe perche' l'id stesso non ha punto).
//  - ID con punto: mapping v2 dot-free (design §3.1.5):
//      raw    = base64url(UTF-8 id), senza padding '='
//      n      = lunghezza di raw su due cifre
//      padded = raw right-padded con '-' fino a 43 caratteri
//      session= "cloud-v2-" + n + "-" + padded   (55 char, charset [A-Za-z0-9_-])
//    Il suffisso v2 supera sempre i 32 char di un id, quindi il namespace e'
//    disgiunto da `cloud-<id>`. base64url di un id ASCII <=32 byte e' <=43 char,
//    cosi' `padded` non tronca mai. Ritorna null se l'id non e' un cell id valido.
function tmuxSessionForCell(cellId) {
  if (typeof cellId !== 'string' || !CELL_ID_RE.test(cellId)) return null;
  if (!cellId.includes('.')) return `cloud-${cellId}`;
  const raw = Buffer.from(cellId, 'utf8').toString('base64url'); // base64url: nessun padding '='
  const n = String(raw.length).padStart(2, '0').slice(-2);
  const padded = (raw + '-'.repeat(43)).slice(0, 43);
  return `cloud-v2-${n}-${padded}`;
}

// Reverse di tmuxSessionForCell: dal nome sessione tmux ricostruisce il cellId
// umano quando il nome e' canonico (v2 decodificato, o cloud-<id> senza punto).
// Verifica il round-trip esatto (tmuxSessionForCell(id) === session) per evitare
// falsi positivi. Ritorna null per nomi non canonici (es. override custom, "jarvis").
function cellIdFromTmuxSession(session) {
  if (typeof session !== 'string' || !session) return null;
  const m = /^cloud-v2-(\d{2})-(.{43})$/.exec(session);
  if (m) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 43) {
      try {
        const id = Buffer.from(m[2].slice(0, n), 'base64url').toString('utf8');
        if (CELL_ID_RE.test(id) && tmuxSessionForCell(id) === session) return id;
      } catch (_) { /* fall through */ }
    }
    return null;
  }
  if (session.startsWith('cloud-')) {
    const suffix = session.slice('cloud-'.length);
    if (CELL_ID_RE.test(suffix) && !suffix.includes('.') && tmuxSessionForCell(suffix) === session) return suffix;
  }
  return null;
}

// ---------------------------------------------------------------------------
// parseDefinitions(raw) -> {schemaVersion, engines, cells} | null
// Accetta stringa JSON o oggetto gia' parsato. Strict + fail-closed.
// ---------------------------------------------------------------------------
function parseDefinitions(raw, { allowLegacyTmuxNames = true } = {}) {
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
    const engineMap = new Map();
    const engines = [];
    for (const e of d.engines) {
      const eng = parseEngine(e);
      if (!eng) return null;
      if (engineIds.has(eng.id)) return null;            // id engine univoco
      engineIds.add(eng.id);
      engineMap.set(eng.id, eng);
      engines.push(eng);
    }

    const tmuxSeen = new Set();
    const legacyTmuxSeen = new Set();
    const legacyTmuxSessions = new Map();
    const cellIds = new Set();
    const cells = [];
    for (const c of d.cells) {
      const cell = parseCell(c, engineIds, engineMap, { allowLegacyTmuxNames });
      if (!cell) return null;
      if (cellIds.has(cell.id)) return null;             // id cell univoco
      cellIds.add(cell.id);
      if (tmuxSeen.has(cell.tmuxSession)) return null;   // tmuxSession univoco
      tmuxSeen.add(cell.tmuxSession);
      if (cell.legacyTmuxSession) {
        if (legacyTmuxSeen.has(cell.legacyTmuxSession)) return null;
        legacyTmuxSeen.add(cell.legacyTmuxSession);
        legacyTmuxSessions.set(cell.id, cell.legacyTmuxSession);
      }
      cells.push(cell);
    }

    const parsed = { schemaVersion: SCHEMA_VERSION, engines, cells };
    // Metadato solo in memoria: serve al bootstrap per rinominare una sessione
    // legacy PRIMA di persistere il nome safe. Non entra in JSON, draft o API.
    Object.defineProperty(parsed, 'legacyTmuxSessions', {
      value: legacyTmuxSessions, enumerable: false, configurable: false,
    });
    return parsed;
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

  // Managed: NexusCrew conosce client/provider e compone internamente il
  // processo. Nessun command/env/argv o segreto vive nella definizione.
  if (e.managed !== undefined) {
    const managed = normalizeManagedSpec(e.managed);
    if (!managed) return null;
    for (const key of ['command', 'args', 'env', 'promptMode', 'promptFlag', 'model']) {
      if (e[key] !== undefined) return null;
    }
    return { id: e.id, label, rc, managed };
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

function parseCell(c, engineIds, engineMap = new Map(), { allowLegacyTmuxNames = true } = {}) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;

  // id
  if (typeof c.id !== 'string' || !CELL_ID_RE.test(c.id)) return null;

  // cwd (obbligatorio; la risoluzione/confinamento avviene via resolveCwd a runtime)
  if (typeof c.cwd !== 'string' || !c.cwd || c.cwd.length > MAX_CWD_LEN) return null;

  // cwdRel (opzionale canonico, design §4.3): forma portatile home-relative.
  // Qui si valida solo il FORMATO (stringa canonica): la coerenza cwd<->cwdRel
  // e' un invariante di SCRITTURA (define/edit/restore), non di lettura — così
  // le definizioni legacy (solo cwd) e quelle nuove (cwd+cwdRel) caricano senza
  // riscrittura on-read e senza rendere il file illeggibile per disallineamenti.
  let cwdRel;
  if (c.cwdRel !== undefined) {
    if (typeof c.cwdRel !== 'string') return null;
    cwdRel = normalizeCwdRel(c.cwdRel);
    if (cwdRel === null) return null;
  }

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

  // Ultimo modello per engine, persistito per cella. Consente di tornare a un
  // provider e ritrovare la scelta precedente senza trascinarla su altri engine.
  let models = {};
  if (c.models !== undefined) {
    if (!c.models || typeof c.models !== 'object' || Array.isArray(c.models)) return null;
    const entries = Object.entries(c.models);
    if (entries.length > MAX_ENGINES) return null;
    for (const [engineId, value] of entries) {
      if (!engineIds.has(engineId) || typeof value !== 'string' || !value || value.length > MAX_MODEL_VAL_LEN) return null;
      models[engineId] = value;
    }
  }

  // permissionPolicies: scelta PER-CELL PER-ENGINE (override del default engine).
  // Stesso confine di `models`: ricorda l'ultima policy usata con ogni engine, così
  // tornando a un provider si ritrova la scelta precedente senza trascinarla altrove
  // e SENZA toccare engine.managed.permissionPolicy (globale: cambierebbe ogni cella
  // che usa quell'engine). Valori ammessi solo 'standard' | 'unsafe'.
  let permissionPolicies;
  if (c.permissionPolicies !== undefined) {
    if (!c.permissionPolicies || typeof c.permissionPolicies !== 'object' || Array.isArray(c.permissionPolicies)) return null;
    const entries = Object.entries(c.permissionPolicies);
    if (entries.length > MAX_ENGINES) return null;
    permissionPolicies = {};
    for (const [engineId, value] of entries) {
      if (!engineIds.has(engineId)) return null;
      if (value !== 'standard' && value !== 'unsafe') return null;
      if (engineMap.get(engineId)?.managed?.client === 'shell' && value !== 'standard') return null;
      permissionPolicies[engineId] = value;
    }
  }

  // commands: comando Shell PER-CELL PER-ENGINE. La stringa resta opaca e
  // viene interpretata solo dalla shell target con `-lc`; qui si applicano
  // limiti e forma chiusa. Sono ammesse soltanto chiavi di engine Shell.
  let commands;
  if (c.commands !== undefined) {
    if (!c.commands || typeof c.commands !== 'object' || Array.isArray(c.commands)) return null;
    const entries = Object.entries(c.commands);
    if (entries.length > MAX_ENGINES) return null;
    commands = {};
    for (const [engineId, value] of entries) {
      if (!engineIds.has(engineId) || engineMap.get(engineId)?.managed?.client !== 'shell') return null;
      if (typeof value !== 'string' || value.length > MAX_CELL_COMMAND_LEN || /[\x00-\x1f\x7f]/.test(value)) return null;
      commands[engineId] = value;
    }
  }

  // prompt (opzionale, cap)
  let prompt;
  if (c.prompt !== undefined) {
    if (typeof c.prompt !== 'string' || c.prompt.length > MAX_PROMPT_LEN) return null;
    prompt = c.prompt;
  }

  // tmuxSession: campo esplicito o derivato da id. UNIVOCO (check in caller).
  // Il nome CANONICO e' tmux-safe (v2 per id puntati): tmux normalizza '.' in
  // '_' nei nomi sessione, per cui `cloud-agy.native` diverrebbe `cloud-agy_native`
  // e ogni target `-t =cloud-agy.native:` fallirebbe deterministicamente.
  //  - override === canonico safe (post-migrazione): round-trip.
  //  - qualunque override legacy con punto e' ammesso SOLO dal percorso di
  //    lettura/migrazione, normalizzato in memoria al canonico safe e conservato
  //    come metadato non enumerabile. atomicWrite usa il parser strict e quindi
  //    non puo reintrodurlo come nuovo valore.
  //  - override cloud-* di altra cella: rifiutato (aliaserebbe sessioni altrui).
  //  - override custom con punto: rifiutato (nuovo nome non tmux-safe).
  //  - override custom senza punto: ammesso (gia' tmux-safe).
  // La restrizione del punto vive in SCRITTURA (derivazione/override), non in
  // lettura: validTmuxName resta permissivo, cosi' uno store legacy con
  // tmuxSession puntato viene normalizzato, non scartato.
  const canonical = tmuxSessionForCell(c.id);
  const legacy = `cloud-${c.id}`;
  let tmuxSession;
  let legacyTmuxSession = '';
  if (c.tmuxSession !== undefined) {
    if (typeof c.tmuxSession !== 'string' || !validTmuxName(c.tmuxSession)) return null;
    if (c.tmuxSession.includes('.')) {
      if (!allowLegacyTmuxNames) return null;
      if (/^cloud-/i.test(c.tmuxSession) && c.tmuxSession !== legacy) return null;
      legacyTmuxSession = c.tmuxSession;
      tmuxSession = canonical;
    } else if (c.tmuxSession === canonical || c.tmuxSession === legacy) {
      tmuxSession = canonical;
    } else if (/^cloud-/i.test(c.tmuxSession)) {
      return null; // alias cloud-* di altra cella
    } else {
      tmuxSession = c.tmuxSession; // override custom tmux-safe (no punto)
    }
  } else {
    tmuxSession = canonical;
  }

  const out = { id: c.id, cwd: c.cwd, engine: c.engine, boot, tmuxSession };
  if (cwdRel !== undefined) out.cwdRel = cwdRel;
  if (model !== undefined) out.model = model;
  if (Object.keys(models).length) out.models = models;
  if (permissionPolicies) out.permissionPolicies = permissionPolicies;
  if (commands && Object.keys(commands).length) out.commands = commands;
  if (prompt !== undefined) out.prompt = prompt;
  if (legacyTmuxSession) {
    Object.defineProperty(out, 'legacyTmuxSession', {
      value: legacyTmuxSession, enumerable: false, configurable: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// validateCommandTrust(command) -> {ok, reason}
// Path assoluto, regular file, owner-executable, NON symlink (lstat), NON
// world-writable. Questa è la trust boundary dei comandi engine built-in.
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
// cwdRel — cwd home-relative PORTATILE (design §4.3 / backup v3).
// Rappresentazione canonica di una cwd come percorso relativo alla home del
// device target: '' == la home stessa; 'personal' == <home>/personal.
// Helper PURI (nessun fs): la normalizzazione e' string-only e fail-closed.
// La risoluzione/confinamento finale resta demandata a resolveCwd (realpath su
// entrambi i lati), INVARIATO: cwdRel aggiunge un vincolo in scrittura, non lo
// indebolisce in lettura. Nessun '..'/assoluto/control/backslash/drive letter.
// ---------------------------------------------------------------------------
// Restituisce la forma canonica ('' = home) oppure null (input non portabile).
// Normalizza (collassa '.' e segmenti vuoti, scosta lo slash finale) RIFIUTANDO
// traversal, path assoluti, drive letter (Win), NUL/C0/DEL e backslash.
function normalizeCwdRel(rel, maxLen = MAX_CWD_LEN) {
  if (typeof rel !== 'string') return null;
  if (rel.length > maxLen) return null;
  for (let i = 0; i < rel.length; i += 1) {
    const c = rel.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x5c) return null; // C0, DEL, backslash
  }
  if (rel === '') return ''; // la home stessa
  if (rel.charAt(0) === '/') return null; // path assoluto (leading sep)
  if (/^[A-Za-z]:/.test(rel)) return null; // drive letter (Win-like)
  const out = [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue; // collassa vuoti/dot
    if (seg === '..') return null; // traversal
    out.push(seg);
  }
  return out.join('/');
}

// Deriva il cwdRel canonico da una cwd ASSOLUTA rispetto a una home (entrambe
// gia' realpath: il caller passa realpath). Restituisce '' (== home), un rel
// normalizzato, oppure null se la cwd non e' esprimibile sotto la home.
// Pura: nessun fs. Usa path.relative sulle stringhe (sicuro perche' entrambi
// realpath e cwd confinato sotto home).
function deriveCwdRel(absCwd, home) {
  if (typeof absCwd !== 'string' || !absCwd || typeof home !== 'string' || !home) return null;
  if (absCwd.includes('\0') || home.includes('\0')) return null;
  const rel = path.relative(home, absCwd);
  if (rel === '') return ''; // cwd == home
  if (path.isAbsolute(rel)) return null; // drive diverso (Win)
  if (rel === '..' || rel.startsWith('..' + path.sep)) return null; // fuori home
  return normalizeCwdRel(rel);
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

  // Le letture devono accettare store legacy per poterli migrare; le scritture
  // invece sono sempre tmux-safe e rifiutano qualunque nuovo nome con punto.
  const parsed = parseDefinitions(data, { allowLegacyTmuxNames: false });
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
  MAX_PROMPTFLAG_LEN, MAX_PROMPT_LEN, MAX_CELL_COMMAND_LEN, MAX_TMUXSESSION_LEN,
};

module.exports = {
  parseDefinitions,
  validateCommandTrust,
  resolveCwd,
  normalizeCwdRel,
  deriveCwdRel,
  loadDefinitions,
  atomicWrite,
  validTmuxName,
  isTmuxSafeName,
  tmuxSessionForCell,
  cellIdFromTmuxSession,
  CAPS,
  // Costanti esposte anche piatte (comode per la UI/schema e i test)
  SCHEMA_VERSION, MAX_ENGINES, MAX_CELLS, MAX_ARGS, MAX_ARG_LEN,
  MAX_ENV_KEYS, MAX_ENV_KEY_LEN, MAX_ENV_VAL_LEN, MAX_PROMPT_LEN, MAX_CELL_COMMAND_LEN,
};
