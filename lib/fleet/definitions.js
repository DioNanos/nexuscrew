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

// --- Cap + identita' (dichiarati; 100 regge una flotta reale con margine;
// il limite resta deliberato contro un file patologico) ---
const SCHEMA_VERSION = 1;
const MAX_ENGINES = 100;
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
const MAX_PANELURL_LEN = 512;  // stesso cap di validBaseUrl (managed.js)
// Nomi di server MCP dichiarabili per cella. Il tetto e' generoso rispetto agli
// otto configurati qui, e la forma e' quella di un identificatore perche' il
// nome finisce in un prefisso di tool passato al client.
const MAX_MCP_NAMES = 64;
const MCP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
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

// panelUrl: endpoint HTTP(S) di un pannello associato a una cella o a un
// engine (es. il pannello web di un desktop container). Fail-closed e
// STRICT, come il resto del modulo: solo http/https, e solo host loopback
// (127.0.0.1, localhost, ::1) — un URL libero in fleet.json e' una superficie
// che non serve a questo caso d'uso (il pannello vive sulla stessa macchina).
// Validatore UNICO condiviso da parseEngine e parseCell: un valore "valido"
// e' deciso in un solo posto, mai ricalcolato due volte con criteri diversi.
// Esportato: il proxy del pannello disattiva la verifica TLS SOLO verso queste
// destinazioni, e deve leggere la stessa lista che le autorizza — non una copia.
const PANELURL_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
function validPanelUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PANELURL_LEN) return false;
  if (/[\x00-\x1f\x7f]|\s/.test(value)) return false; // no control char, no whitespace
  let parsed;
  try { parsed = new URL(value); } catch (_) { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // new URL() racchiude un host IPv6 fra parentesi quadre (es. "[::1]"): il
  // confronto e' contro quella stessa forma, non contro "::1" nudo.
  if (!PANELURL_LOOPBACK_HOSTS.has(parsed.hostname)) return false;
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
// Modelli dichiarati dall'operatore, accanto agli engine e persistiti con loro.
//
// Perche' esistono: il catalogo dei modelli vive nel pacchetto, e un fornitore
// che pubblica un id nuovo lo rende inutilizzabile fino alla release
// successiva. Qui si dichiara l'id per un profilo gestito, con i dati che il
// client si aspetta — gli stessi campi che il catalogo interno gia' porta.
//
// Un modello dichiarato NON aggira il controllo: lo estende in modo esplicito.
// Un id mai dichiarato resta rifiutato.
const MAX_MODELS = 64;
const MODEL_ID_MAX = 128;

function parseModel(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const allowed = new Set(['id', 'engine', 'label', 'contextWindow', 'maxTokens', 'reasoning']);
  if (Object.keys(m).some((k) => !allowed.has(k))) return null;
  const id = typeof m.id === 'string' ? m.id.trim() : '';
  // Stessa forma accettata dal gate dei modelli: nessun byte di controllo, un
  // limite di lunghezza, e nulla di piu' — l'id lo decide il fornitore, non noi.
  if (!id || id.length > MODEL_ID_MAX || /[\x00-\x1f\x7f]/.test(id)) return null;
  const engine = typeof m.engine === 'string' ? m.engine.trim() : '';
  if (!engine || engine.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(engine)) return null;
  const out = { id, engine };
  if (m.label !== undefined) {
    if (typeof m.label !== 'string' || m.label.length > 64) return null;
    if (m.label.trim()) out.label = m.label.trim();
  }
  for (const key of ['contextWindow', 'maxTokens']) {
    if (m[key] === undefined) continue;
    // Una finestra plausibile: un numero fuori scala e' quasi sempre un errore
    // di battitura, e passerebbe fino al client sotto forma di comportamento
    // inspiegabile.
    if (!Number.isSafeInteger(m[key]) || m[key] < 1024 || m[key] > 100000000) return null;
    out[key] = m[key];
  }
  if (m.reasoning !== undefined) {
    if (typeof m.reasoning !== 'boolean') return null;
    out.reasoning = m.reasoning;
  }
  return out;
}

// parseDefinitions(raw) -> {schemaVersion, engines, cells, models} | null
// Accetta stringa JSON o oggetto gia' parsato. Strict + fail-closed.
// ---------------------------------------------------------------------------
function parseDefinitions(raw, { allowLegacyTmuxNames = true, onReject = null } = {}) {
  const reject = (message) => {
    if (typeof onReject === 'function') onReject(message);
    return null;
  };
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
    if (d.engines.length > MAX_ENGINES) {
      return reject(`fleet.json rifiutato: ${d.engines.length} engine dichiarati, cap ${MAX_ENGINES}; riduci gli engine a ${MAX_ENGINES} o meno`);
    }
    if (!Array.isArray(d.cells)) return null;            // cells obbligatorio (array)
    if (d.cells.length > MAX_CELLS) return null;

    // I modelli si leggono PRIMA degli engine: un engine puo' riferirsi a un id
    // dichiarato qui, e leggerli dopo lo farebbe rifiutare per un dato che in
    // realta' c'e'. `models` e' opzionale: una configurazione che non lo ha
    // resta valida esattamente com'era.
    //
    // da revisione (pacchetto): extraModels porta il DESCRITTORE completo (id,
    // engine, contextWindow, maxTokens, reasoning), non solo l'id. Prima era
    // Map<engine, Set<id>>: bastava per il gate "questo id e' ammesso?"
    // (declaredFor), ma contextWindow/maxTokens/reasoning sparivano — e
    // customCatalogFor/writePiProviderExtension, che ne hanno bisogno per
    // emettere il catalogo, non li vedevano mai. Ora Map<engine, Map<id,
    // model>>: chi ha bisogno solo degli id li ricava dalle CHIAVI della Map
    // interna (stesso .has(id) di un Set — nessun consumatore esistente cambia).
    const models = [];
    const extraModels = new Map();
    if (d.models !== undefined) {
      if (!Array.isArray(d.models) || d.models.length > MAX_MODELS) return null;
      const seen = new Set();
      for (const m of d.models) {
        const model = parseModel(m);
        if (!model) return null;
        const key = `${model.engine}::${model.id}`;
        if (seen.has(key)) return null;   // stesso id due volte per lo stesso profilo
        seen.add(key);
        if (!extraModels.has(model.engine)) extraModels.set(model.engine, new Map());
        extraModels.get(model.engine).set(model.id, model);
        models.push(model);
      }
    }

    const engineIds = new Set();
    const engineMap = new Map();
    const engines = [];
    for (const e of d.engines) {
      const eng = parseEngine(e, { extraModels });
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
      const cell = parseCell(c, engineIds, engineMap, { allowLegacyTmuxNames, extraModels, onReject: reject });
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

    // `models` compare solo se dichiarato: una configurazione senza modelli
    // resta byte-identica a prima, e l'aggiornamento non riscrive nulla.
    const parsed = models.length
      ? { schemaVersion: SCHEMA_VERSION, engines, cells, models }
      : { schemaVersion: SCHEMA_VERSION, engines, cells };
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

function parseEngine(e, { extraModels = null } = {}) {
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
    const managed = normalizeManagedSpec(e.managed, { extraModels });
    if (!managed) return null;
    for (const key of ['command', 'args', 'env', 'promptMode', 'promptFlag', 'model']) {
      if (e[key] !== undefined) return null;
    }
    // panelUrl (opzionale): STESSO validatore e STESSA conservazione del ramo
    // custom, qui sotto. Un engine managed puo' legittimamente avere un
    // pannello, e il fallback engine->cella di cellStatus vale per entrambi.
    // Prima di questo blocco il campo veniva scartato in silenzio: un valore
    // valido spariva e uno invalido veniva accettato (fail-open) — rilievo 1
    // della revisione.
    let managedPanelUrl;
    if (e.panelUrl !== undefined) {
      if (!validPanelUrl(e.panelUrl)) return null;
      managedPanelUrl = e.panelUrl;
    }
    const managedOut = { id: e.id, label, rc, managed };
    if (managedPanelUrl !== undefined) managedOut.panelUrl = managedPanelUrl;
    return managedOut;
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

  // panelUrl (opzionale): valore precompilato dall'engine (es. il pannello di
  // un desktop container) — una cella puo' sovrascriverlo col proprio, vedi
  // parseCell. Stessa validazione condivisa (validPanelUrl).
  let panelUrl;
  if (e.panelUrl !== undefined) {
    if (!validPanelUrl(e.panelUrl)) return null;
    panelUrl = e.panelUrl;
  }

  const out = { id: e.id, label, rc, command: e.command, args, env, promptMode };
  if (model) out.model = model;
  if (promptFlag !== undefined) out.promptFlag = promptFlag;
  if (panelUrl !== undefined) out.panelUrl = panelUrl;
  return out;
}

// Un modello scelto PER CELLA deve superare lo stesso controllo di un modello
// scelto per l'engine. Senza, il gate `strictModels` — che vale su
// define-engine, edit-engine, restore-engines e sulla scrittura diretta —
// resta aggirabile da questa via, che per giunta e' FEDERATA (`/fleet/engine`
// e' nell'allowlist): un peer poteva mettere un id arbitrario in una cella di
// questa installazione, e il boot lo usava senza ricontrollarlo.
//
// Rilievo della revisione indipendente, provato con probe su due profili distinti.
// Il controllo e' quello vero, non una copia: si passa dalla stessa
// `normalizeManagedSpec` con le stesse dichiarazioni.
function cellModelAllowed(engineId, model, engineMap, extraModels) {
  const engine = engineMap.get(engineId);
  // Engine custom (non gestito): il modello e' un argomento del comando, non un
  // id di catalogo, e qui non c'e' nulla da validare.
  if (!engine || !engine.managed) return true;
  return !!normalizeManagedSpec({ ...engine.managed, model }, { extraModels });
}

function parseCell(c, engineIds, engineMap = new Map(), { allowLegacyTmuxNames = true, extraModels = null, onReject = null } = {}) {
  const reject = (message) => {
    if (typeof onReject === 'function') onReject(message);
    return null;
  };
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
    if (!cellModelAllowed(c.engine, c.model, engineMap, extraModels)) return null;
    model = c.model;
  }

  // Ultimo modello per engine, persistito per cella. Consente di tornare a un
  // provider e ritrovare la scelta precedente senza trascinarla su altri engine.
  let models = {};
  if (c.models !== undefined) {
    if (!c.models || typeof c.models !== 'object' || Array.isArray(c.models)) return null;
    const entries = Object.entries(c.models);
    if (entries.length > MAX_ENGINES) {
      return reject(`fleet.json rifiutato: la cella ${c.id} contiene ${entries.length} modelli ricordati, cap ${MAX_ENGINES}; riduci la mappa a ${MAX_ENGINES} o meno`);
    }
    for (const [engineId, value] of entries) {
      if (!engineIds.has(engineId) || typeof value !== 'string' || !value || value.length > MAX_MODEL_VAL_LEN) return null;
      // Anche la memoria per-engine passa dal gate: e' un valore che tornera'
      // in uso appena si ritorna su quell'engine.
      if (!cellModelAllowed(engineId, value, engineMap, extraModels)) return null;
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
    if (entries.length > MAX_ENGINES) {
      return reject(`fleet.json rifiutato: la cella ${c.id} contiene ${entries.length} permissionPolicies, cap ${MAX_ENGINES}; riduci la mappa a ${MAX_ENGINES} o meno`);
    }
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
    if (entries.length > MAX_ENGINES) {
      return reject(`fleet.json rifiutato: la cella ${c.id} contiene ${entries.length} commands, cap ${MAX_ENGINES}; riduci la mappa a ${MAX_ENGINES} o meno`);
    }
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

  // panelUrl (opzionale, per-cella): endpoint HTTP(S) di un pannello associato
  // alla cella (es. desktop container), sovrascrive quello precompilato
  // dall'engine (vedi parseEngine). Opt-in: assente -> comportamento
  // identico a oggi. Un valore PRESENTE ma malformato fa fallire l'INTERA
  // definizione (return null): non collassa in "assente", sono due esiti
  // opposti che si assomigliano.
  let panelUrl;
  if (c.panelUrl !== undefined) {
    if (!validPanelUrl(c.panelUrl)) return null;
    panelUrl = c.panelUrl;
  }

  // mcp (opzionale): QUALI strumenti MCP ha questa cella, per NOME.
  //
  // Solo nomi, mai definizioni. Le definizioni vivono in un posto solo — la
  // configurazione del client — e li' restano: duplicarle per cella
  // significherebbe moltiplicare le credenziali che alcuni server portano nel
  // proprio `env` (una password, due chiavi API su questa installazione), in un
  // file per cella invece che in uno.
  //
  // ASSENTE non e' come VUOTO. Assente = la cella eredita tutti gli strumenti,
  // che e' il comportamento di sempre. `[]` = nessuno strumento, ed e'
  // esattamente cio' che serve per una cella di cui non ci si fida: oggi quel
  // risultato si ottiene solo per caso, come effetto collaterale
  // dell'isolamento per credenziale.
  let mcp;
  if (c.mcp !== undefined) {
    if (!Array.isArray(c.mcp) || c.mcp.length > MAX_MCP_NAMES) return null;
    const visti = new Set();
    for (const nome of c.mcp) {
      // Il nome finisce in un prefisso di tool (`mcp__<nome>`) passato al
      // client: si delimita come un identificatore, non come testo libero.
      if (typeof nome !== 'string' || !MCP_NAME_RE.test(nome) || visti.has(nome)) return null;
      visti.add(nome);
    }
    mcp = [...visti];
  }

  // label (opzionale): nome LEGGIBILE della cella, distinto dall'id.
  // L'id resta la chiave stabile con cui si indirizza una cella e con cui si
  // deriva la sessione tmux; la label e' solo cio' che un umano legge. Senza
  // questa distinzione l'id fa anche da nome, e un nodo che battezza la propria
  // cella come il motore la espone cosi' a tutta la rete: chi la riceve non ha
  // modo di sapere che ruolo occupa. Stessa regola gia' usata per la label
  // degli engine e per quella dei nodi: stampabile, non vuota, max 64.
  let label;
  if (c.label !== undefined) {
    if (typeof c.label !== 'string') return null;
    const trimmed = c.label.trim();
    if (!trimmed || trimmed.length > MAX_LABEL_LEN || !isPrintable(trimmed)) return null;
    label = trimmed;
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
  if (panelUrl !== undefined) out.panelUrl = panelUrl;
  if (mcp !== undefined) out.mcp = mcp;
  if (label !== undefined) out.label = label;
  if (legacyTmuxSession) {
    Object.defineProperty(out, 'legacyTmuxSession', {
      value: legacyTmuxSession, enumerable: false, configurable: false,
    });
  }
  return out;
}


// ---------------------------------------------------------------------------
// aggiornaDefinizioni(p, trasforma, opts) -> definizioni risultanti
//
// Leggi-modifica-scrivi SOTTO LOCK. `atomicWrite` garantisce che il file non
// resti a meta' — non che nessuno lo abbia cambiato mentre lo tenevi in mano:
// sono due proprieta' diverse, e la prima non implica la seconda. Una revisione ha
// riprodotto la perdita su SETTE percorsi diversi (i backfill di avvio, la
// riparazione desktop e la persistenza della migrazione): ognuno salvava,
// osservava sul disco il valore scritto da un altro, e lo perdeva scrivendo un
// draft costruito su uno stato precedente.
//
// `trasforma(defs)` riceve lo stato letto DENTRO il lock e restituisce il draft
// da scrivere, oppure `null` per non scrivere nulla. Se il lock non si ottiene
// entro il tempo concesso si RINUNCIA: per una migrazione opportunistica non
// fare nulla costa un altro avvio, sovrascrivere costa un dato.
// ---------------------------------------------------------------------------
const LOCK_ATTESA_MS = 2000;   // quanto si insiste prima di rinunciare
const LOCK_STALE_MS = 30000;   // oltre questa eta' il lock e' di un morto

function percorsoLock(p) { return `${p}.lock`; }

// La NASCITA di un processo (starttime, /proc/<pid>/stat campo 22: tick di
// uptime a cui il processo e' partito). Un pid e' un numero RICICLATO: chiedere
// «esiste il processo 4711?» non e' la domanda «e' ancora vivo QUEL processo
// che prese il lock?» — se il proprietario muore e il sistema riassegna il
// numero, kill(pid, 0) risponde «vivo» per sempre e ogni scrittura rinuncia in
// silenzio. Due processi con lo stesso numero nascono in istanti diversi: la
// coppia pid+nascita e' l'identita'. Null quando non e' leggibile (pid assente,
// o sistema senza /proc: e' il modo in cui il codice vede macOS).
function leggiStarttimeProc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // il campo comm (2) puo' contenere spazi e parentesi: si salta tutto
    // fino all'ultima ')', i campi seguenti partono dal 3°. Il campo 22
    // (starttime) e' quindi l'indice 19 della coda.
    const coda = stat.slice(stat.lastIndexOf(')') + 2);
    const st = Number(coda.split(' ')[19]);
    return Number.isFinite(st) ? st : null;
  } catch (_) { return null; }
}

function prendiLock(p) {
  const lock = percorsoLock(p);
  // La directory puo' non esistere ancora: alla prima creazione delle
  // definizioni non c'e' nulla. Prima era `atomicWrite` a crearla, e spostando
  // la scrittura sotto lock quell'effetto si era perso — il lock non si apriva,
  // si rinunciava, e la creazione falliva in silenzio.
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) { return null; }
  const scadenza = Date.now() + LOCK_ATTESA_MS;
  // Il token identifica QUESTA presa, non il processo: due prese successive
  // dello stesso pid restano distinguibili, e al rilascio si puo' verificare di
  // stare togliendo il proprio lock e non quello di chi e' subentrato.
  // Il TERZO campo e' la nascita di chi prende: e' quello che rende
  // confrontabile «e' ancora vivo QUEL processo» (pid da solo non basta: e'
  // un numero riciclato). Senza /proc non c'e' nascita da attestare e il
  // token resta a due campi — vedere proprietarioVivo per le conseguenze.
  const nascita = leggiStarttimeProc(process.pid);
  const token = nascita === null
    ? `${process.pid}:${crypto.randomBytes(8).toString('hex')}`
    : `${process.pid}:${crypto.randomBytes(8).toString('hex')}:${nascita}`;
  for (;;) {
    try {
      // 'wx' fallisce se il file esiste: e' l'esclusione mutua, in una syscall.
      const fd = fs.openSync(lock, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${token}\n`);
      } catch (_) {
        // Il contenuto NON e' informativo: e' l'unica cosa che rende il lock
        // attribuibile. Se non si puo' scrivere (disco pieno, quota, errore
        // transitorio) il lock resterebbe VUOTO: nessun pid da interrogare, e
        // dopo 30s chiunque lo esproprierebbe mentre il presunto titolare —
        // vivo e al lavoro, convinto di essere protetto — scrive senza mutua
        // esclusione. Nessuna titolarita' senza token: si chiude il fd e si
        // toglie il file APPENA CREATO (e' nostro per costruzione: 'wx'), poi
        // si rinuncia. Un lock vuoto sul disco puo' restare solo dal relitto
        // di un crash fra open e write — processo che non esiste piu':
        // recuperarlo dopo la scadenza e' giusto (semantica pinnata da
        // fleet-lock-edges «illeggibile = abbandonato»).
        try { fs.closeSync(fd); } catch (_) { /* gia' chiuso */ }
        try { fs.unlinkSync(lock); } catch (_) { /* gia' rimosso */ }
        return null;
      }
      return { fd, token };
    } catch (e) {
      if (e.code !== 'EEXIST') return null; // dir non scrivibile o simili: si rinuncia
      // Un lock abbandonato non deve bloccare per sempre — ma l'eta' da sola non
      // dice che il proprietario sia morto: un lavoro lento e' vivo e sta usando
      // il lock. Espropriarlo per anzianita' ROMPE la mutua esclusione, cioe'
      // riapre esattamente il difetto che il lock chiude. Si guarda prima se il
      // processo esiste ancora.
      try {
        const eta = Date.now() - fs.statSync(lock).mtimeMs;
        if (eta > LOCK_STALE_MS && !proprietarioVivo(lock)) { fs.unlinkSync(lock); continue; }
      } catch (_) { /* sparito nel frattempo: si riprova */ }
      if (Date.now() >= scadenza) return null;
      if (!dormiSincrono(25)) return null; // non si sa attendere: meglio rinunciare che consumare CPU
    }
  }
}

// `kill(pid, 0)` non invia nulla: chiede al kernel se quel NUMERO esiste.
// EPERM significa che esiste e non e' nostro — vivo comunque.
function vivoPerKernel(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

// Il proprietario del lock e' vivo SOLO se e' ancora vivo QUEL processo.
// Tre vie, in ordine di forza:
//   1. token con nascita (pid:hex:starttime) e /proc leggibile: identita'
//      CONFRONTABILE. vivo <=> il numero esiste ed e' nato nello stesso
//      istante che il token attesta. Un numero riassegnato nasce in un
//      istante diverso: il proprietario e' morto anche se il pid esiste.
//   2. token con nascita ma /proc non leggibile (neanche per QUESTO
//      processo: e' come il codice vede un sistema senza /proc, es. macOS):
//      criterio NON CALCOLABILE — nel dubbio il lock resta, decide il kernel.
//   3. token vecchio (pid:hex, nascita assente — lock scritti prima della
//      correzione): identita' non confrontabile — nel dubbio il lock resta,
//      decide il kernel. E' il buco dichiarato che resta per i lock gia'
//      sul disco: costa una scrittura rimandata, mai un vivo espropriato.
// L'asimmetria e' la lezione della cura precedente: dichiarare morto un vivo
// ROMPE la mutua esclusione; dichiarare vivo un morto rimanda una scrittura.
// `lettore` e' iniettabile per provare la via 2 dove /proc esiste eccome.
function proprietarioVivo(lock, lettore = leggiStarttimeProc) {
  let pid;
  let nascita = null;
  try {
    const parti = String(fs.readFileSync(lock, 'utf8')).trim().split(':');
    pid = Number.parseInt(parti[0], 10);
    if (parti.length >= 3) {
      const st = Number(parti[2]);
      if (Number.isFinite(st)) nascita = st;
    }
  } catch (_) { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false; // illeggibile: trattato come abbandonato
  if (nascita !== null) {
    // /proc leggibile per QUESTO processo? Se no, il criterio non e'
    // calcolabile su questo sistema (non «il pid e' morto»: NON LO SO).
    if (lettore(process.pid) === null) return vivoPerKernel(pid);
    const sua = lettore(pid);
    if (sua === null) return false; // /proc c'e' e quel pid non esiste: morto
    return sua === nascita; // stesso numero, stessa nascita: e' ancora LUI
  }
  return vivoPerKernel(pid);
}

// Attesa sincrona senza spawnare nulla: questo percorso e' sincrono per
// costruzione (gira nel bootstrap), quindi non c'e' un event loop da cedere.
function dormiSincrono(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return true;
  } catch (_) {
    // Senza SharedArrayBuffer non si puo' attendere senza girare a vuoto: il
    // ciclo brucerebbe CPU per tutto il tempo concesso. Meglio dirlo al
    // chiamante e rinunciare subito — l'aggiornamento e' opportunistico.
    return false;
  }
}

function rilasciaLock(p, presa) {
  try { fs.closeSync(presa.fd); } catch (_) { /* gia' chiuso */ }
  // Si toglie SOLO il proprio lock. Un unlink cieco, dopo che qualcun altro ha
  // preso il lock, cancellerebbe il suo — e da li' in avanti nessuno sarebbe
  // piu' protetto, a cascata.
  try {
    const dentro = String(fs.readFileSync(percorsoLock(p), 'utf8')).trim();
    if (dentro !== presa.token) return; // subentrato qualcun altro: non e' roba nostra
  } catch (_) { return; }
  try { fs.unlinkSync(percorsoLock(p)); } catch (_) { /* gia' rimosso */ }
}

function aggiornaDefinizioni(p, trasforma, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  // Di default NON si propaga: questi aggiornamenti girano nel bootstrap, dove
  // un'eccezione non degrada — impedisce l'avvio. Prima della conversione ogni
  // backfill aveva il suo `try/catch` attorno alla scrittura, e quella rete va
  // conservata. Chi invece serve una richiesta dell'utente passa
  // `propaga: true`, perche' li' un errore va riportato a chi ha chiesto.
  const propaga = opts.propaga === true;
  const presa = prendiLock(p);
  if (presa === null) {
    log('definizioni fleet: lock non ottenuto, aggiornamento rimandato');
    // Rinunciare NON e' come non aver avuto nulla da fare, e chi propaga deve
    // poterlo distinguere: restituendo lo stato riletto — che e' truthy — una
    // mutazione chiesta dall'utente rispondeva OK senza aver scritto niente.
    // L'errore ha un `code` perche' il chiamante possa dire la cosa giusta
    // invece di confonderlo con «definizioni non valide».
    if (propaga) {
      const e = new Error('definizioni fleet occupate: aggiornamento non eseguito');
      e.code = 'FLEET_LOCK_BUSY';
      throw e;
    }
    return loadDefinitions(p);
  }
  try {
    // La lettura sta DENTRO il lock: e' l'unico modo perche' il draft nasca da
    // uno stato che nessun altro puo' cambiare prima che venga scritto.
    const dentro = loadDefinitions(p);
    if (!dentro) {
      // `loadDefinitions` restituisce null sia per «non c'e'» sia per «c'e' ma
      // non si legge», e la differenza qui e' tutto: creare le definizioni di
      // default sopra un file esistente ma illeggibile CANCELLA una
      // configurazione. Si guarda il filesystem, non il valore di ritorno.
      let assente = false;
      try { fs.lstatSync(p); } catch (e) { assente = e.code === 'ENOENT'; }
      if (!assente || typeof opts.seMancante !== 'function') return null;
      const iniziale = opts.seMancante();
      return iniziale ? atomicWrite(p, iniziale) : null;
    }
    const draft = trasforma(dentro);
    if (!draft) return dentro; // niente da fare: si esce senza scrivere
    return atomicWrite(p, draft);
  } catch (e) {
    if (propaga) throw e;
    log(`definizioni fleet: aggiornamento non riuscito (${e && e.code ? e.code : e && e.message ? e.message : 'errore'})`);
    return loadDefinitions(p);
  } finally {
    rilasciaLock(p, presa);
  }
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
  // Owner check (design §9a, da revisione): il command deve appartenere
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
function resolveCwd(cwd, home, out) {
  try {
    const h = home || process.env.HOME;
    if (typeof cwd !== 'string' || !cwd || typeof h !== 'string' || !h) return null;
    if (cwd.includes('\0') || h.includes('\0')) return null;
    const real = fs.realpathSync(cwd);
    const realHome = fs.realpathSync(h);
    if (!fs.statSync(real).isDirectory()) return null;
    if (real !== realHome && !real.startsWith(realHome + path.sep)) return null;
    return real;
  } catch (e) {
    // ENOENT = la cwd (o la home) non esiste (legittimo "non c'e'" -> null ->
    // resolveCellCwd riporta 'invalid-cwd'/'home-unavailable'); altro code
    // (EACCES/ELOOP/ENOTDIR...) = "esiste ma non ho potuto verificarla", e va
    // distinto dal "non esiste sotto la home" che il messaggio altrimenti direbbe.
    // Il verdetto (null -> cwd rifiutata, fail-closed di sicurezza) e' invariato;
    // out.unverifiable porta il "perche'" a chi costruisce il messaggio
    // (unportableCwdError). Il discriminante e' CHI ha fallito, non che ci sia
    // stata un'eccezione.
    if (out && e.code !== 'ENOENT') out.unverifiable = e.code || e.constructor.name;
    return null;
  }
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
function loadDefinitions(p, out) {
  try {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      // ENOENT = il file non c'e' (legittimo "missing" -> null); qualsiasi altro
      // code (EACCES/ELOOP/ENOTDIR...) = "esiste ma non ho potuto guardarlo", e va
      // distinto dal "missing" che il caller altrimenti riporterebbe come "fleet
      // unavailable" senza dire perche'. Il verdetto (null -> fail-closed) e'
      // invariato; out.lstatBlocked porta il "perche'" a chi costruisce il
      // messaggio. Il discriminante e' CHI ha fallito, non che ci sia stata
      // un'eccezione.
      if (out && e.code !== 'ENOENT') out.lstatBlocked = e.code || e.constructor.name;
      return null;
    }
    if (st.isSymbolicLink()) return null;                    // no symlink
    if (!st.isFile()) return null;
    const raw = fs.readFileSync(p, 'utf8');
    return parseDefinitions(raw, {
      onReject: out ? (reason) => { out.parseReason = reason; } : null,
    });
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
  MAX_PANELURL_LEN,
};

module.exports = {
  parseDefinitions,
  validateCommandTrust,
  aggiornaDefinizioni,
  proprietarioVivo,
  leggiStarttimeProc,
  validPanelUrl, PANELURL_LOOPBACK_HOSTS,
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
  MAX_PANELURL_LEN,
};
