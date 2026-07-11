'use strict';
// B4.2 — Fleet built-in. Implementa lo STESSO contratto di lib/fleet/index.js
// (createFleet: available / status / up / down / engine / boot / isCellSession)
// leggendo le definizioni da ~/.nexuscrew/fleet.json tramite lib/fleet/definitions.js,
// e lo ESTENDE con define*/edit*/remove* + schema + capabilities (design §4b/§9c).
//
// Agnostico: non conosce "claude"/"glm"/"codex" — lancia solo command+args dichiarati.
//
// Sicurezza (design §6 / §9a / §9d / §9e):
//  - up esegue validateCommandTrust(command) e resolveCwd(cwd) PRIMA di lanciare;
//    una cella/engine mancante o non trusted -> httpError(400), NON lancia nulla.
//  - command/args/env NON passano per una shell: execFile + argv diretto (tmux fa
//    exec del comando, NON sh -c — verificato: ';','|','$' passano verbatim).
//  - env: il builtin lancia con un env MINIMALE controllato dal service (allowlist
//    dura); engine.env — gia' ripulito dalle loader-key da parseDefinitions —
//    raggiunge la sessione SOLO via `tmux -e` (chiavi validate). PATH lo controlla
//    il service, mai la definizione.
//  - READONLY (cfg.readonlyDefault===true | NEXUSCREW_READONLY=1) blocca ogni
//    mutazione fleet e ogni up (§9d): passano solo status/schema/capabilities.
//  - promptMode 'send-keys' inietta via `tmux load-buffer` + `paste-buffer -p`
//    (bracketed paste), NON send-keys grezzo; se il command e' gia' uscito
//    (sessione morta) NON digita (§9e).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const {
  parseDefinitions, validateCommandTrust, resolveCwd,
  loadDefinitions, atomicWrite, CAPS,
} = require('./definitions.js');
const {
  CATALOG: MANAGED_CATALOG, describeManaged, resolveManagedEngine, discoverOllamaModels,
} = require('./managed.js');

const STATUS_TTL_MS = 2000;

// Env minimale controllato dal service (design §9a). Allowlist DURA: le definizioni
// non possono toccare PATH/loader-key (parseDefinitions le rifiuta gia' in env);
// qui NON passiamo MAI l'env del processo per intero. engine.env va in session via -e.
// Nota: se un server tmux e' gia' in esecuzione (avviato fuori dal service), i comandi
// ereditano l'env di quel server; la garanzia dura resta: le definizioni non possono
// iniettare loader-key, e engine.env arriva al pane SOLO tramite chiavi validate.
const MINIMAL_ENV_KEYS = [
  'PATH', 'HOME', 'SHELL', 'TERM', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
];
function minimalEnv() {
  const env = {};
  for (const k of MINIMAL_ENV_KEYS) {
    if (process.env[k] !== undefined && process.env[k] !== '') env[k] = process.env[k];
  }
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  if (!env.HOME) env.HOME = os.homedir();
  if (!env.TERM) env.TERM = 'xterm-256color';
  return env;
}

function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }

// Marcatore di redazione (design §9h): stderr/stdout dei comandi tmux falliti
// NON devono mai ecoare i segreti delle definizioni.
const REDACTED = '‹redacted›';

// redactSecrets(text, engine, cell) -> string con ogni occorrenza dei segreti
// delle definizioni sostituita da '‹redacted›'. Segreti coperti (§9h):
//  - valori di engine.env           (le CHIAVI restano, i VALUES vengono redatti)
//  - testo del prompt della cella   (cell.prompt)
//  - testo del prompt dell'engine   (engine.prompt) se presente
// Applicato a OGNI messaggio d'errore che incorpora stderr/stdout dei comandi
// tmux falliti (up / down / injectPrompt): tmux puo' ecoare argv/env del comando
// lanciato nei suoi log di errore. Pura + senza dipendenze: testabile direttamente.
function redactSecrets(text, engine, cell) {
  if (typeof text !== 'string' || text === '') return text;
  const secrets = [];
  if (engine && typeof engine === 'object' && engine.env) {
    for (const v of Object.values(engine.env)) {
      if (typeof v === 'string' && v) secrets.push(v);
    }
  }
  if (engine && typeof engine.prompt === 'string' && engine.prompt) secrets.push(engine.prompt);
  if (cell && typeof cell.prompt === 'string' && cell.prompt) secrets.push(cell.prompt);
  // Ordina per lunghezza DECRESCENTE: i segreti piu' lunghi prima, cosi' un segreto
  // che e' prefisso/sottostringa di un altro non ne maschera il rimpiazzo completo.
  secrets.sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of secrets) out = out.split(s).join(REDACTED); // replace globale, regex-free
  return out;
}

// Esecutore tmux: argv diretto (MAI shell). Risolve sempre {err,stdout,stderr,code}
// cosi' il chiamante distingue "sessione assente" (code!==0 atteso) da errori reali.
function tmuxExec(tmuxBin, args, { env, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    execFile(tmuxBin, args, { env, timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || ''), code });
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Policy caratteri del prompt send-keys (§9e): ammette stampabili + \t \n \r;
// rifiuta ESC(0x1b) e gli altri byte di controllo (niente marker bracketed-paste
// iniettabili). parseDefinitions caps solo la lunghezza: questo e' defense-in-depth.
function promptCharsOk(prompt) {
  if (typeof prompt !== 'string') return false;
  for (let i = 0; i < prompt.length; i += 1) {
    const c = prompt.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;        // \t \n \r ammessi
    if (c < 32 || c === 127) return false;                 // ESC/null/altri control
  }
  return true;
}

// ---------------------------------------------------------------------------
// composeLaunchArgv({tmuxSession, realCwd, engine, cell}) -> argv per new-session
// PURA + testabile. No shell: command e args sono argv diretto. model/prompt sono
// aggiunti solo se c'e' un VALORE effettivo (override cella || default engine).
// ---------------------------------------------------------------------------
function composeLaunchArgv({ tmuxSession, realCwd, engine, cell }) {
  const args = ['new-session', '-d', '-s', tmuxSession, '-c', realCwd];
  // engine.env -> env di sessione via -e (chiavi gia' validate, no loader-key)
  for (const [k, v] of Object.entries(engine.env || {})) args.push('-e', `${k}=${v}`);
  // command + args: argv diretto (tmux exec, NON sh -c)
  args.push(engine.command, ...(engine.args || []));
  // model: flag + (override cella || valore engine), solo se c'e' un valore
  if (engine.model) {
    const val = (cell.model != null && cell.model !== '') ? cell.model : engine.model.value;
    if (val) args.push(engine.model.flag, val);
  }
  // prompt flag-mode: promptFlag + prompt cella, solo se c'e' un prompt effettivo.
  // SICUREZZA (design §9h): promptMode 'flag' mette il prompt in ARGV -> e' visibile
  // nella process list (ps) / argv della sessione, a differenza di 'send-keys' che lo
  // inietta DOPO via bracketed paste. Va quindi vincolato a prompt NON-segreti.
  if (engine.promptMode === 'flag' && cell.prompt) {
    args.push(engine.promptFlag, cell.prompt);
  }
  return args;
}

// Poll has-session entro readyMs (no delay fisso cieco). Ritorna true se la sessione
// e' viva entro la deadline, false altrimenti (command uscito / mai partita).
async function waitAlive(tmuxBin, session, { env, readyMs }) {
  const deadline = Date.now() + Math.max(0, readyMs | 0);
  for (;;) {
    const r = await tmuxExec(tmuxBin, ['has-session', '-t', `=${session}`], { env, timeoutMs: 2000 });
    if (!r.err) return true;
    if (Date.now() >= deadline) return false;
    await sleep(60);
  }
}

// Iniezione prompt send-keys via bracketed paste (come skills/.../nc-send):
// load-buffer del prompt in un buffer nominato + paste-buffer -p (bracketed),
// poi cleanup. Readiness best-effort: se la sessione non e' viva quando paste-iamo
// (command gia' uscito) NON digita (design §9e). Ritorna {injected, reason}.
async function injectPrompt(tmuxBin, session, prompt, { env, readyMs = 400, target, engine, cell } = {}) {
  if (!promptCharsOk(prompt)) {
    return { injected: false, reason: 'prompt contiene byte di controllo (rifiutato)' };
  }
  let tmp = null;
  try {
    tmp = path.join(os.tmpdir(), `.ncsend.${session}.${process.pid}.txt`);
    fs.writeFileSync(tmp, prompt, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);

    const alive = await waitAlive(tmuxBin, session, { env, readyMs });
    if (!alive) return { injected: false, reason: 'sessione non viva (command uscito?): nessuna digitazione' };

    // Target esatto: pane id (%N) se disponibile, altrimenti '=sessione' (match
    // esatto, mai prefix-match) — audit impl #5.
    const to = target || `=${session}`;
    await tmuxExec(tmuxBin, ['load-buffer', '-b', 'ncsend', tmp], { env });
    const paste = await tmuxExec(tmuxBin, ['paste-buffer', '-p', '-t', to, '-b', 'ncsend'], { env });
    if (paste.err) return { injected: false, reason: redactSecrets(`paste-buffer failed: ${paste.stderr.trim()}`, engine, cell) };
    return { injected: true, reason: 'bracketed paste (load-buffer + paste-buffer -p)' };
  } finally {
    try { if (tmp) fs.unlinkSync(tmp); } catch (_) { /* best-effort */ }
    try { await tmuxExec(tmuxBin, ['delete-buffer', '-b', 'ncsend'], { env }); } catch (_) { /* best-effort */ }
  }
}

// Copia deep delle definizioni per il draft di mutazione (round-trip sicuro su disco).
function draftFrom(defs) {
  return {
    schemaVersion: defs.schemaVersion,
    engines: defs.engines.map((e) => ({
      ...e,
      ...(e.managed ? { managed: { ...e.managed } } : {}),
      ...(e.args ? { args: [...e.args] } : {}),
      ...(e.env ? { env: { ...e.env } } : {}),
      ...(e.model ? { model: { ...e.model } } : {}),
    })),
    cells: defs.cells.map((c) => ({ ...c, ...(c.models ? { models: { ...c.models } } : {}) })),
  };
}

// Applica engine + modello come un'unica transizione. Ogni engine ricorda il
// proprio ultimo modello; passando a un altro engine il modello vecchio non
// attraversa mai il confine.
function applyCellEngineModel(target, engineId, model, hasModel) {
  const remembered = { ...(target.models || {}) };
  target.engine = engineId;
  if (hasModel) {
    if (typeof model === 'string' && model) remembered[engineId] = model;
    else delete remembered[engineId];
  }
  const selected = hasModel
    ? (typeof model === 'string' ? model : '')
    : (remembered[engineId] || '');
  if (Object.keys(remembered).length) target.models = remembered; else delete target.models;
  if (selected) target.model = selected; else delete target.model;
}

// ---------------------------------------------------------------------------
// createBuiltinFleet(cfg) — async per parita' di contratto con createFleet.
// cfg: { fleetDefsPath?, tmuxBin?, home?, builtinEnabled?, readonlyDefault?,
//        sendKeysReadyMs?, fleetProviderReason? }
// ---------------------------------------------------------------------------
async function createBuiltinFleet(cfg = {}) {
  const off = {
    available: false, provider: 'builtin',
    isCellSession: () => false, capabilities: () => [],
  };
  if (cfg.builtinEnabled === false) return off;

  const home = cfg.home || os.homedir();
  const defsPath = cfg.fleetDefsPath || path.join(home, '.nexuscrew', 'fleet.json');
  const tmuxBin = cfg.tmuxBin || process.env.TMUX_BIN || 'tmux';
  const readonly = () => (cfg.readonlyDefault === true || process.env.NEXUSCREW_READONLY === '1');

  // Bootstrap: fleet.json valido? garbage -> unavailable (fail-closed, design §7)
  const boot = loadDefinitions(defsPath);
  if (!boot) return off;
  let cache = { at: 0, defs: boot, sessions: new Set() };

  function reloadDefs() {
    const d = loadDefinitions(defsPath);
    if (d) cache = { ...cache, at: 0, defs: d };
    return cache.defs; // mai null: boot non-null e reload mantiene l'ultimo valido
  }
  function findCell(defs, id) { return defs.cells.find((c) => c.id === id) || null; }
  function findEngine(defs, id) { return defs.engines.find((e) => e.id === id) || null; }

  async function refreshSessions() {
    const r = await tmuxExec(tmuxBin, ['list-sessions', '-F', '#{session_name}'], { env: minimalEnv() });
    if (r.err) return new Set();            // nessun server / nessuna sessione
    const set = new Set();
    for (const line of r.stdout.split('\n')) {
      const n = line.trim();
      if (n) set.add(n);
    }
    return set;
  }

  async function status() {
    if (Date.now() - cache.at > STATUS_TTL_MS) {
      reloadDefs();                          // pick-up di edit esterne/file
      const sessions = await refreshSessions();
      cache = { at: Date.now(), defs: cache.defs, sessions };
    }
    const sessions = cache.sessions;
    const cells = cache.defs.cells.map((c) => {
      const alive = sessions.has(c.tmuxSession);
      return {
        cell: c.id, tmuxSession: c.tmuxSession, engine: c.engine,
        model: c.model || '', models: { ...(c.models || {}) },
        active: alive, boot: c.boot, tmux: alive,
        rc: '', key: '', degraded: false, // builtin: cella "up" <=> sessione tmux viva
      };
    });
    const needsOllama = cache.defs.engines.some((e) => e.managed?.provider === 'ollama-cloud');
    const ollamaModels = needsOllama ? await discoverOllamaModels({ ...cfg, home }) : [];
    const engines = cache.defs.engines.map((e) => {
      const managed = e.managed ? describeManaged(e.managed, { ...cfg, home }) : null;
      return {
        id: e.id, label: e.label, rc: !!e.rc,
        ...(managed ? {
          kind: 'managed', client: managed.client, provider: managed.provider,
          model: e.managed.model || managed.defaultModel || '',
          models: managed.provider === 'ollama-cloud' ? ollamaModels : managed.models,
          configured: managed.configured, reason: managed.reason,
        } : { kind: 'custom', configured: true, model: e.model?.value || '', models: [] }),
      };
    });
    return {
      available: true,
      provider: 'builtin',
      bootOwner: 'builtin', // §9b: la UI non puo' mentire su chi possiede il boot
      reason: cfg.fleetProviderReason || 'fleet.json definitions',
      cells, engines,
    };
  }

  function isCellSession(name) {
    return cache.defs.cells.some((c) => c.tmuxSession === String(name));
  }

  // up — ordine obbligatorio (design §9a, task B4.2).
  // Le override {engine,boot} del contratto route sono ignorate: il builtin e'
  // definitions-driven (l'engine della cella e' quello dichiarato; boot e' uno
  // stato persistente gestito da boot()). Lancia SENZA shell.
  async function up(cellId /* , { engine, boot } = {} */) {
    if (readonly()) throw httpError(403, 'READONLY: up bloccato');
    const defs = reloadDefs();
    const cell = findCell(defs, cellId);
    if (!cell) throw httpError(400, `cella sconosciuta: ${cellId}`);
    const engine = findEngine(defs, cell.engine);
    if (!engine) throw httpError(400, `engine dangling per cella ${cellId}: ${cell.engine}`);
    let launchEngine = engine;
    if (engine.managed) {
      const resolved = resolveManagedEngine(engine, cell, { ...cfg, home });
      if (!resolved.ok) throw httpError(400, `engine managed non configurato (${engine.id}): ${resolved.reason}`);
      launchEngine = resolved.engine;
    }

    // (2) trust del command PRIMA di lanciare
    const trust = validateCommandTrust(launchEngine.command);
    if (!trust.ok) throw httpError(400, `command non trusted (${launchEngine.command}): ${trust.reason}`);
    // (3) cwd reale sotto la home
    const realCwd = resolveCwd(cell.cwd, home);
    if (!realCwd) throw httpError(400, `cwd non valida (deve esistere sotto la home): ${cell.cwd}`);

    // (4)+(5) argv diretto (no shell), env minimale + engine.env via -e.
    // '-P -F #{pane_id}': tmux stampa il pane id della sessione appena creata,
    // cosi' l'iniezione del prompt bersaglia ESATTAMENTE quel pane (audit impl
    // #5: elimina la race di riuso del nome sessione tra waitAlive e paste).
    const argv = composeLaunchArgv({ tmuxSession: cell.tmuxSession, realCwd, engine: launchEngine, cell });
    argv.splice(2, 0, '-P', '-F', '#{pane_id}');
    const launch = await tmuxExec(tmuxBin, argv, { env: minimalEnv() });
    if (launch.err) {
      // Redazione (§9h): lo stderr di tmux puo' ecoare argv/env del comando lanciato.
      const why = /duplicate session/i.test(launch.stderr)
        ? 'sessione già in esecuzione'
        : `tmux new-session failed: ${redactSecrets(launch.stderr.trim() || launch.err.message, launchEngine, cell)}`;
      throw httpError(/duplicate/i.test(launch.stderr) ? 409 : 500, why);
    }

    // (6) prompt send-keys: bracketed-paste best-effort, target = pane id esatto
    // (fallback al nome sessione con match esatto '=' se tmux non ha stampato l'id).
    let prompt = null;
    if (launchEngine.promptMode === 'send-keys' && cell.prompt) {
      const paneId = launch.stdout.trim().split('\n')[0] || '';
      const target = paneId.startsWith('%') ? paneId : `=${cell.tmuxSession}`;
      prompt = await injectPrompt(tmuxBin, cell.tmuxSession, cell.prompt, {
        env: minimalEnv(),
        readyMs: cfg.sendKeysReadyMs != null ? cfg.sendKeysReadyMs : 400,
        target,
        engine: launchEngine, cell, // per la redazione del reason se paste-buffer fallisce (§9h)
      });
    }
    cache = { ...cache, at: 0 };              // invalida: prossimo status rilegge tmux
    return { ok: true, cell: cellId, session: cell.tmuxSession, prompt };
  }

  async function down(cellId /* , opts */) {
    if (readonly()) throw httpError(403, 'READONLY: down bloccato');
    const defs = reloadDefs();
    const cell = findCell(defs, cellId);
    if (!cell) throw httpError(400, `cella sconosciuta: ${cellId}`);
    const engine = findEngine(defs, cell.engine) || {};
    const r = await tmuxExec(tmuxBin, ['kill-session', '-t', `=${cell.tmuxSession}`], { env: minimalEnv() });
    if (r.err && !/no server running|can't find session|not found/i.test(r.stderr)) {
      throw httpError(500, `tmux kill-session failed: ${redactSecrets(r.stderr.trim(), engine, cell)}`);
    }
    cache = { ...cache, at: 0 };
    return { ok: true, killed: !r.err };
  }

  // restart = down (riusa la kill esistente; sessione non viva NON e' errore,
  // come down) seguito da up (rilancia secondo la definizione corrente).
  // Capability del SOLO built-in: i provider legacy non la espongono (501 in route).
  async function restart(cellId) {
    if (readonly()) throw httpError(403, 'READONLY: restart bloccato');
    await down(cellId); // idempotente: cella non viva -> nessun errore
    return up(cellId);
  }

  async function setEngine(cellId, engId, opts = {}) {
    if (readonly()) throw httpError(403, 'READONLY: engine bloccato');
    const defs = reloadDefs();
    if (!findCell(defs, cellId)) throw httpError(400, `cella sconosciuta: ${cellId}`);
    if (!findEngine(defs, engId)) throw httpError(400, `engine non valido: ${engId}`);
    await mutate(defs, (d) => applyCellEngineModel(findCell(d, cellId), engId, opts.model, typeof opts.model === 'string' && opts.model !== ''));
    const saved = reloadDefs(); const target = findCell(saved, cellId);
    return { ok: true, engine: engId, model: target.model || '' };
  }

  async function setBoot(cellId, enabled) {
    if (readonly()) throw httpError(403, 'READONLY: boot bloccato');
    const defs = reloadDefs();
    if (!findCell(defs, cellId)) throw httpError(400, `cella sconosciuta: ${cellId}`);
    await mutate(defs, (d) => { findCell(d, cellId).boot = !!enabled; });
    return { ok: true };
  }

  // --- define / edit / remove (engine e cell) ---
  // atomicWrite valida PRIMA di scrivere (fail-closed); input invalido -> backup
  // predecessore + throw -> httpError(400). MAI garbage su disco.
  async function defineEngine(def) {
    if (readonly()) throw httpError(403, 'READONLY: define-engine bloccato');
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw httpError(400, 'definizione engine mancante');
    if (def.id != null && findEngine(reloadDefs(), def.id)) throw httpError(400, `engine esiste già: ${def.id}`);
    await mutate(reloadDefs(), (d) => { d.engines.push(def); });
    return { ok: true, id: def.id };
  }
  async function editEngine(id, patch, envChanges) {
    if (readonly()) throw httpError(403, 'READONLY: edit-engine bloccato');
    if (!id) throw httpError(400, 'id engine mancante');
    const defs = reloadDefs();
    if (!findEngine(defs, id)) throw httpError(400, `engine inesistente: ${id}`);
    if (patch && (Object.prototype.hasOwnProperty.call(patch, 'id') || Object.prototype.hasOwnProperty.call(patch, 'env'))) {
      throw httpError(400, 'id ed env non sono modificabili tramite patch generica');
    }
    await mutate(defs, (d) => {
      const target = findEngine(d, id);
      for (const [key, value] of Object.entries(patch || {})) {
        if (value === null) delete target[key]; else target[key] = value;
      }
      if (envChanges !== undefined) {
        if (!envChanges || typeof envChanges !== 'object' || Array.isArray(envChanges)) throw httpError(400, 'envChanges non valido');
        const next = { ...(target.env || {}) };
        for (const key of Array.isArray(envChanges.remove) ? envChanges.remove : []) delete next[key];
        if (envChanges.set && typeof envChanges.set === 'object' && !Array.isArray(envChanges.set)) {
          for (const [key, value] of Object.entries(envChanges.set)) next[key] = value;
        }
        target.env = next;
      }
    });
    const sessions = await refreshSessions();
    return { ok: true, activeCells: defs.cells.filter((c) => c.engine === id && sessions.has(c.tmuxSession)).map((c) => c.id) };
  }
  async function removeEngine(id) {
    if (readonly()) throw httpError(403, 'READONLY: remove-engine bloccato');
    const defs = reloadDefs();
    if (!findEngine(defs, id)) throw httpError(400, `engine inesistente: ${id}`);
    const used = defs.cells.filter((c) => c.engine === id);
    if (used.length) throw httpError(400, `engine in uso da ${used.length} cella/e: rimuovi prima la cella`);
    await mutate(defs, (d) => {
      d.engines = d.engines.filter((e) => e.id !== id);
      for (const cell of d.cells) {
        if (!cell.models || !Object.prototype.hasOwnProperty.call(cell.models, id)) continue;
        delete cell.models[id];
        if (!Object.keys(cell.models).length) delete cell.models;
      }
    });
    return { ok: true };
  }

  async function defineCell(def) {
    if (readonly()) throw httpError(403, 'READONLY: define-cell bloccato');
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw httpError(400, 'definizione cell mancante');
    if (def.id != null && findCell(reloadDefs(), def.id)) throw httpError(400, `cell esiste già: ${def.id}`);
    await mutate(reloadDefs(), (d) => { d.cells.push(def); });
    return { ok: true, id: def.id };
  }
  async function editCell(id, patch) {
    if (readonly()) throw httpError(403, 'READONLY: edit-cell bloccato');
    if (!id) throw httpError(400, 'id cell mancante');
    const defs = reloadDefs();
    if (!findCell(defs, id)) throw httpError(400, `cell inesistente: ${id}`);
    if (patch && (Object.prototype.hasOwnProperty.call(patch, 'id') || Object.prototype.hasOwnProperty.call(patch, 'tmuxSession'))) {
      throw httpError(400, 'id e tmuxSession sono immutabili');
    }
    await mutate(defs, (d) => {
      const target = findCell(d, id);
      const hasEngine = typeof patch?.engine === 'string';
      const hasModel = Object.prototype.hasOwnProperty.call(patch || {}, 'model');
      for (const [key, value] of Object.entries(patch || {})) {
        if (key === 'engine' || key === 'model') continue;
        if (value === null) delete target[key]; else target[key] = value;
      }
      if (hasEngine || hasModel) applyCellEngineModel(target, hasEngine ? patch.engine : target.engine, patch?.model, hasModel);
    });
    const sessions = await refreshSessions();
    return { ok: true, active: sessions.has(findCell(defs, id).tmuxSession) };
  }
  async function removeCell(id, opts = {}) {
    if (readonly()) throw httpError(403, 'READONLY: remove-cell bloccato');
    let defs = reloadDefs();
    const cell = findCell(defs, id);
    if (!cell) throw httpError(400, `cell inesistente: ${id}`);
    const sessions = await refreshSessions();
    if (sessions.has(cell.tmuxSession)) {
      if (opts.stop !== true) throw httpError(409, 'cell attiva: conferma stop e rimozione');
      await down(id);
      defs = reloadDefs();
    }
    await mutate(defs, (d) => { d.cells = d.cells.filter((c) => c.id !== id); });
    return { ok: true };
  }

  // Vista editabile ma secret-safe: gli env values restano write-only.
  function definitions() {
    const defs = reloadDefs();
    return {
      schemaVersion: defs.schemaVersion,
      engines: defs.engines.map((e) => {
        const out = { ...e, envKeys: Object.keys(e.env || {}).sort() };
        delete out.env;
        if (e.managed) out.managedInfo = describeManaged(e.managed, { ...cfg, home });
        return out;
      }),
      cells: defs.cells.map((c) => ({ ...c, ...(c.models ? { models: { ...c.models } } : {}) })),
      managedCatalog: MANAGED_CATALOG.map((p) => ({ ...p })),
      managedConfig: { providerSecretsPath: cfg.providerSecretsPath || path.join(home, '.nexuscrew', 'providers.env') },
    };
  }

  // Scrive il draft mutato; atomicWrite valida PRIMA (fail-closed). Su input
  // invalido: backup predecessore + throw -> httpError(400) (mai garbage).
  async function mutate(defs, mutator) {
    const draft = draftFrom(defs);
    mutator(draft);
    let parsed;
    try {
      parsed = atomicWrite(defsPath, draft);
    } catch (e) {
      throw httpError(400, `definizioni non valide: ${e.message}`);
    }
    cache = { ...cache, at: 0, defs: parsed };
    return parsed;
  }

  // schema() — descrittore campi per editor UI schema-driven (design §5/§9f).
  function schema() {
    return {
      schemaVersion: 1,
      caps: CAPS,
      engine: {
        kind: { type: 'enum', values: ['managed', 'custom'], default: 'managed' },
        id: { type: 'string', required: true, pattern: '^[a-z0-9._-]{1,32}$', max: 32 },
        label: { type: 'string', required: false, max: CAPS.MAX_LABEL_LEN, default: '<id>' },
        rc: { type: 'boolean', required: false, default: false },
        managed: {
          type: 'object', requiredFor: 'managed',
          client: { type: 'enum', values: ['claude', 'codex-vl'] },
          provider: { type: 'enum', values: ['native', 'ollama-cloud', 'zai-a', 'zai-p'] },
          model: { type: 'string', required: false, max: CAPS.MAX_MODEL_VAL_LEN },
        },
        command: { type: 'string', requiredFor: 'custom', max: CAPS.MAX_COMMAND_LEN, absolute: true },
        args: { type: 'array', of: 'string', required: false, max: CAPS.MAX_ARGS, itemMax: CAPS.MAX_ARG_LEN },
        env: {
          type: 'object', required: false, maxKeys: CAPS.MAX_ENV_KEYS,
          keyPattern: '^[A-Za-z_][A-Za-z0-9_]*$', keyMax: CAPS.MAX_ENV_KEY_LEN,
          valueMax: CAPS.MAX_ENV_VAL_LEN,
          denylist: ['PATH', 'SHELL', 'HOME', 'NODE_OPTIONS', 'LD_*', 'DYLD_*', 'NPM_CONFIG_*'],
        },
        model: {
          type: 'object', required: false,
          fields: {
            flag: { type: 'string', required: true, singleArgv: true, max: CAPS.MAX_MODEL_FLAG_LEN },
            value: { type: 'string', required: false, default: '', max: CAPS.MAX_MODEL_VAL_LEN },
          },
        },
        promptMode: { type: 'enum', required: true, values: ['flag', 'send-keys'] },
        promptFlag: { type: 'string', requiredIf: 'promptMode=flag', singleArgv: true, max: CAPS.MAX_PROMPTFLAG_LEN },
      },
      cell: {
        id: { type: 'string', required: true, pattern: '^[A-Za-z0-9._-]{1,32}$', max: 32 },
        cwd: { type: 'string', required: true, max: CAPS.MAX_CWD_LEN, underHome: true },
        engine: { type: 'string', required: true, ref: 'engine.id' },
        boot: { type: 'boolean', required: false, default: false },
        model: { type: 'string', required: false, max: CAPS.MAX_MODEL_VAL_LEN },
        models: { type: 'object', required: false, keyRef: 'engine.id', valueMax: CAPS.MAX_MODEL_VAL_LEN },
        prompt: { type: 'string', required: false, max: CAPS.MAX_PROMPT_LEN },
      },
    };
  }

  function capabilities() {
    return ['status', 'up', 'down', 'restart', 'engine', 'boot', 'define', 'edit', 'remove', 'schema', 'definitions'];
  }

  return {
    available: true,
    provider: 'builtin',
    status, up, down, restart, engine: setEngine, boot: setBoot, isCellSession,
    defineEngine, editEngine, removeEngine,
    defineCell, editCell, removeCell,
    schema, definitions, capabilities,
  };
}

module.exports = {
  createBuiltinFleet,
  composeLaunchArgv,
  minimalEnv,
  promptCharsOk,
  redactSecrets,
  MINIMAL_ENV_KEYS,
};
