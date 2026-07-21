'use strict';
// Fleet built-in. FACADE: espone available/status/up/down/engine/boot e
// isCellSession leggendo le definizioni da ~/.nexuscrew/fleet.json tramite
// lib/fleet/definitions.js, insieme a define*/edit*/remove* +
// schema + capabilities (design §4b/§9c).
//
// La responsabilita' runtime/launch (status/up/down/restart + launch/readiness
// helpers) e' stata estratta in modo behavior-preserving in:
//   - lib/fleet/launch.js   toolkit stateless (argv/env/readiness/redaction)
//   - lib/fleet/runtime.js  createBuiltinRuntime: cache + status/up/down/restart
// Qui resta il bootstrap del cfg, l'istanziazione del runtime e il CRUD
// (define/edit/remove, engine/boot, import, restore, schema, definitions,
// credentials) che collabora con gli accessor del runtime. Il facade re-esporta
// i simboli di launch.js per i test che li importano da builtin.js.
//
// Agnostico: non conosce "claude"/"glm"/"codex" — lancia solo command+args
// dichiarati.
//
// Sicurezza (design §6 / §9a / §9d / §9e) — invariata, vedi launch.js/runtime.js:
//  - up esegue validateCommandTrust(command) e resolveCwd(cwd) PRIMA di lanciare;
//    una cella/engine mancante o non trusted -> httpError(400), NON lancia nulla.
//  - command/args/env NON passano per una shell: execFile + argv diretto.
//  - env: il builtin lancia con un env MINIMALE controllato dal service; engine.env
//    raggiunge il client solo tramite un broker AF_UNIX privato e monouso.
//  - READONLY (cfg.readonlyDefault===true | NEXUSCREW_READONLY=1) blocca ogni
//    mutazione fleet e ogni up (§9d): passano solo status/schema/capabilities.
//  - promptMode 'send-keys' inietta via bracketed paste; se il command e' gia'
//    uscito (sessione morta) NON digita (§9e).
const os = require('node:os');
const path = require('node:path');
const {
  loadDefinitions, atomicWrite, CAPS, MAX_CELLS, validTmuxName,
  resolveCwd, normalizeCwdRel, deriveCwdRel,
} = require('./definitions.js');
const {
  publicCatalog, describeManaged, describeCatalogCredential, defaultShellEngine,
} = require('./managed.js');
const { validEnvKey } = require('./env-key.js');
const { setCredential, removeCredential } = require('./credentials.js');
const { createLaunchBroker } = require('./launch-broker.js');
const { MINIMAL_ENV_KEYS } = require('../runtime/env.js');
const { requireSharedTmuxProtection } = require('../tmux/shared-server.js');

// Toolkit stateless + runtime estratti (behavior-preserving). I simboli di
// launch.js sono re-esportati in module.exports per i test che li importano
// da builtin.js; httpError e' usato anche dal CRUD del facade.
const { createBuiltinRuntime } = require('./runtime.js');
const {
  composeLaunchArgv, composeClientInvocation, minimalEnv, promptCharsOk,
  redactSecrets, sanitizeEarlyDiagnostic, waitStablePane, httpError,
} = require('./launch.js');

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
    cells: defs.cells.map((c) => ({
      ...c,
      ...(c.models ? { models: { ...c.models } } : {}),
      ...(c.permissionPolicies ? { permissionPolicies: { ...c.permissionPolicies } } : {}),
      ...(c.commands ? { commands: { ...c.commands } } : {}),
    })),
  };
}

// Upgrade locale, idempotente e non distruttivo: installazioni gia' esistenti
// ricevono l'engine standard Shell senza riscrivere celle o sostituire un id
// scelto dall'utente. Se lo store e' pieno o la scrittura non e' possibile, il
// bootstrap resta utilizzabile con le definizioni precedenti.
function backfillShellEngine(defsPath, defs) {
  if (!defs || defs.engines.some((engine) => engine.managed?.client === 'shell')) return defs;
  if (defs.engines.some((engine) => engine.id === 'shell.local')) return defs;
  if (defs.engines.length >= CAPS.MAX_ENGINES) return defs;
  const draft = draftFrom(defs);
  draft.engines.push(defaultShellEngine());
  try { return atomicWrite(defsPath, draft); } catch (_) { return defs; }
}

// Applica engine + modello + policy come un'unica transizione. Ogni engine ricorda
// il proprio ultimo modello E l'ultima policy; passando a un altro engine né
// l'uno né l'altra attraversano il confine. La policy e' PER-CELL PER-ENGINE:
// mai si tocca engine.managed.permissionPolicy (globale su tutte le celle che
// usano quell'engine). Valori ammessi solo 'standard' | 'unsafe'.
function applyCellTransition(target, engineId, { model, hasModel, policy, hasPolicy } = {}) {
  const rememberedModels = { ...(target.models || {}) };
  const rememberedPolicies = { ...(target.permissionPolicies || {}) };
  target.engine = engineId;
  if (hasModel) {
    if (typeof model === 'string' && model) rememberedModels[engineId] = model;
    else delete rememberedModels[engineId];
  }
  if (hasPolicy) {
    if (policy === 'standard' || policy === 'unsafe') rememberedPolicies[engineId] = policy;
    else delete rememberedPolicies[engineId];
  }
  if (Object.keys(rememberedModels).length) target.models = rememberedModels; else delete target.models;
  if (Object.keys(rememberedPolicies).length) target.permissionPolicies = rememberedPolicies; else delete target.permissionPolicies;
  const selected = hasModel
    ? (typeof model === 'string' ? model : '')
    : (rememberedModels[engineId] || '');
  if (selected) target.model = selected; else delete target.model;
}

// ---------------------------------------------------------------------------
// cwd portabile (design §4.3). resolveCellCwd riconcilia cwd (assoluta) e
// cwdRel (home-relative) in una COPPIA COERENTE prima di ogni scrittura:
//   - solo cwd (assoluta valida) -> deriva cwdRel
//   - solo cwdRel (valida)        -> calcola la cwd assoluta target
//   - entrambi                     -> devono risolvere allo STESSO realpath
// La risoluzione finale passa SEMPRE da resolveCwd (INVARIATO: realpath su
// entrambi i lati, confinamento sotto home, directory deve esistere, symlink
// escape rifiutato). Nessuna creazione directory, nessun fallback a home o al
// cwd del servizio, nessun rimappaggio automatico di path di altri device.
// Restituisce { ok:true, cwd, cwdRel } oppure { ok:false, fail:{ reason, ... } }.
// ---------------------------------------------------------------------------
function resolveCellCwd(cell, home) {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return { ok: false, fail: { reason: 'invalid-cell' } };
  const hasCwd = typeof cell.cwd === 'string' && cell.cwd.length > 0;
  const hasRel = typeof cell.cwdRel === 'string'; // '' == home, forma valida
  if (!hasCwd && !hasRel) return { ok: false, fail: { reason: 'missing' } };
  let relNorm = null;
  if (hasRel) {
    relNorm = normalizeCwdRel(cell.cwdRel);
    if (relNorm === null) return { ok: false, fail: { reason: 'invalid-rel', cwdRel: cell.cwdRel } };
  }
  const realHome = resolveCwd(home, home);
  if (!realHome) return { ok: false, fail: { reason: 'home-unavailable' } };
  const realCwd = hasCwd ? resolveCwd(cell.cwd, home) : null;
  const realFromRel = hasRel ? resolveCwd(path.join(realHome, relNorm), home) : null;
  if (hasCwd && hasRel) {
    if (!realCwd) return { ok: false, fail: { reason: 'invalid-cwd', cwd: cell.cwd } };
    if (!realFromRel) return { ok: false, fail: { reason: 'invalid-rel', cwdRel: cell.cwdRel } };
    if (realCwd !== realFromRel) return { ok: false, fail: { reason: 'mismatch', cwd: cell.cwd, cwdRel: cell.cwdRel } };
    return { ok: true, cwd: realCwd, cwdRel: relNorm };
  }
  if (hasCwd) {
    if (!realCwd) return { ok: false, fail: { reason: 'invalid-cwd', cwd: cell.cwd } };
    const rel = deriveCwdRel(realCwd, realHome);
    if (rel === null) return { ok: false, fail: { reason: 'not-under-home', cwd: cell.cwd } };
    return { ok: true, cwd: realCwd, cwdRel: rel };
  }
  // solo cwdRel
  if (!realFromRel) return { ok: false, fail: { reason: 'invalid-rel', cwdRel: cell.cwdRel } };
  return { ok: true, cwd: realFromRel, cwdRel: relNorm };
}

// suggestion (hint azionabile, MAI applicato in automatico): il basename della
// cwd fornita combacia con una directory esistente sotto la home locale ->
// suggerisce quel rel. Altrimenti resta assente. Bounded (singolo segmento).
function suggestCwdRel(failedCwd, home) {
  try {
    const base = path.basename(String(failedCwd || ''));
    if (!base || normalizeCwdRel(base) === null) return undefined;
    const realHome = resolveCwd(home, home);
    if (!realHome) return undefined;
    if (!resolveCwd(path.join(realHome, base), home)) return undefined;
    return base;
  } catch (_) { return undefined; }
}

// Costruisce l'errore strutturato fail-closed (code 'unportable-cwd'): per ogni
// cella rifiutata riporta id, eventuale cwd fornita e suggestion bounded.
// Nessun segreto: cwd e' operazionale (gia' esposta dal messaggio di launch in
// runtime.js); hint testuale fisso. Nessun log su buffer diagnostici.
function unportableCwdError(failures, home) {
  const cells = failures.map(({ id, fail }) => {
    const entry = { id };
    const cwd = typeof fail.cwd === 'string' ? fail.cwd : undefined;
    if (cwd !== undefined) entry.cwd = cwd;
    const suggestion = suggestCwdRel(cwd, home);
    if (suggestion) entry.suggestion = suggestion;
    return entry;
  });
  return httpError(400, `cwd non portabile (deve esistere sotto la home) per: ${failures.map((f) => f.id).join(', ')}`, {
    code: 'unportable-cwd',
    cells,
    hint: 'il percorso appartiene a un altro dispositivo o non esiste sotto la home di questo device: scegli una cartella sotto la home',
  });
}

// Prevalida TUTTE le celle prima di mutate/atomicWrite: risolve cwd/cwdRel in
// coppia coerente per ciascuna; al primo blocco lancia l'errore strutturato e
// NESSUNA scrittura parziale avviene. Restituisce l'array di celle risolte
// (con cwd realpath + cwdRel canonico), nell'ordine originale.
function resolveCellsOrFail(cells, home) {
  const failures = [];
  const resolved = [];
  for (const cell of cells) {
    const r = resolveCellCwd(cell, home);
    if (!r.ok) { failures.push({ id: cell.id || '?', fail: r.fail }); continue; }
    const { cwd, cwdRel } = r;
    const next = { ...cell };
    next.cwd = cwd;
    next.cwdRel = cwdRel;
    resolved.push(next);
  }
  if (failures.length) throw unportableCwdError(failures, home);
  return resolved;
}

// ---------------------------------------------------------------------------
// createBuiltinFleet(cfg) — unica implementazione Fleet di NexusCrew.
// cfg: { fleetDefsPath?, tmuxBin?, home?, builtinEnabled?, readonlyDefault?,
//        sendKeysReadyMs?, fleetProviderReason?, launchBroker?, launchReadyMs? }
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
  const launchBroker = cfg.launchBroker || createLaunchBroker({ ...cfg, home });

  // Bootstrap: fleet.json valido? garbage -> unavailable (fail-closed, design §7)
  let boot = loadDefinitions(defsPath);
  if (!boot) return off;
  if (!readonly()) boot = backfillShellEngine(defsPath, boot);

  // Adopt or create the shared server before exposing a mutable Fleet. Reapply
  // before every lifecycle mutation so an accidental config reload cannot
  // silently leave NexusCrew operations unguarded.
  const ensureProtection = typeof cfg.ensureTmuxProtection === 'function'
    ? cfg.ensureTmuxProtection
    : () => requireSharedTmuxProtection(tmuxBin, {
      enabled: cfg.protectSharedTmuxServer !== false,
      home,
    });
  await ensureProtection();

  // Runtime estratto (lib/fleet/runtime.js): possiede cache + definizioni e
  // espone status/up/down/restart/isCellSession + gli accessor allo store
  // (reloadDefs/findCell/findEngine/refreshSessions/commitDefs) che il CRUD
  // qui sotto riusa. status/up/down/restart sono INVARIATI.
  const rt = createBuiltinRuntime({
    cfg, home, defsPath, tmuxBin, readonly, launchBroker, boot, ensureProtection,
  });
  const {
    status, up, down, restart, isCellSession,
    reloadDefs, findCell, findEngine, refreshSessions, commitDefs,
  } = rt;

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
    commitDefs(parsed);
    return parsed;
  }

  async function setEngine(cellId, engId, opts = {}) {
    if (readonly()) throw httpError(403, 'READONLY: engine bloccato');
    const defs = reloadDefs();
    if (!findCell(defs, cellId)) throw httpError(400, `cella sconosciuta: ${cellId}`);
    const selectedEngine = findEngine(defs, engId);
    if (!selectedEngine) throw httpError(400, `engine non valido: ${engId}`);
    const hasModel = typeof opts.model === 'string';
    const hasPolicy = Object.prototype.hasOwnProperty.call(opts, 'permissionPolicy') && typeof opts.permissionPolicy === 'string';
    if (hasPolicy && opts.permissionPolicy !== 'standard' && opts.permissionPolicy !== 'unsafe') {
      throw httpError(400, 'permissionPolicy non valida (standard|unsafe)');
    }
    if (hasPolicy && ['pi', 'shell'].includes(selectedEngine.managed?.client) && opts.permissionPolicy !== 'standard') {
      throw httpError(400, `${selectedEngine.managed.client === 'shell' ? 'Shell' : 'Pi'} supporta solo permissionPolicy standard`);
    }
    await mutate(defs, (d) => applyCellTransition(findCell(d, cellId), engId, {
      model: opts.model, hasModel,
      policy: hasPolicy ? opts.permissionPolicy : null, hasPolicy,
    }));
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
        if (cell.models && Object.prototype.hasOwnProperty.call(cell.models, id)) {
          delete cell.models[id];
          if (!Object.keys(cell.models).length) delete cell.models;
        }
        if (cell.permissionPolicies && Object.prototype.hasOwnProperty.call(cell.permissionPolicies, id)) {
          delete cell.permissionPolicies[id];
          if (!Object.keys(cell.permissionPolicies).length) delete cell.permissionPolicies;
        }
        if (cell.commands && Object.prototype.hasOwnProperty.call(cell.commands, id)) {
          delete cell.commands[id];
          if (!Object.keys(cell.commands).length) delete cell.commands;
        }
      }
    });
    return { ok: true };
  }

  async function defineCell(def) {
    if (readonly()) throw httpError(403, 'READONLY: define-cell bloccato');
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw httpError(400, 'definizione cell mancante');
    if (def.id != null && findCell(reloadDefs(), def.id)) throw httpError(400, `cell esiste già: ${def.id}`);
    // cwd portabile fail-closed: risolve cwd/cwdRel in coppia coerente PRIMA di
    // scrivere (nessuna scrittura parziale su input non portabile).
    const [cellDef] = resolveCellsOrFail([def], home);
    await mutate(reloadDefs(), (d) => { d.cells.push(cellDef); });
    return { ok: true, id: def.id };
  }
  async function editCell(id, patch) {
    if (readonly()) throw httpError(403, 'READONLY: edit-cell bloccato');
    if (!id) throw httpError(400, 'id cell mancante');
    const defs = reloadDefs();
    const current = findCell(defs, id);
    if (!current) throw httpError(400, `cell inesistente: ${id}`);
    if (patch && (Object.prototype.hasOwnProperty.call(patch, 'id') || Object.prototype.hasOwnProperty.call(patch, 'tmuxSession'))) {
      throw httpError(400, 'id e tmuxSession sono immutabili');
    }
    const nextEngine = findEngine(defs, typeof patch?.engine === 'string' ? patch.engine : current.engine);
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'permissionPolicy')
      && patch.permissionPolicy === 'unsafe' && ['pi', 'shell'].includes(nextEngine?.managed?.client)) {
      throw httpError(400, `${nextEngine.managed.client === 'shell' ? 'Shell' : 'Pi'} supporta solo permissionPolicy standard`);
    }
    // cwd portabile fail-closed: se la patch tocca cwd/cwdRel, riconcilia in
    // coppia coerente PRIMA di mutate. cwd/cwdRel non sono chiudibili (null):
    // cwd e' obbligatoria, cwdRel e' canonica derivata. Prevalida => nessuna
    // scrittura parziale.
    const hasCwdPatch = !!(patch && Object.prototype.hasOwnProperty.call(patch, 'cwd'));
    const hasRelPatch = !!(patch && Object.prototype.hasOwnProperty.call(patch, 'cwdRel'));
    let resolvedCwd = null;
    if (hasCwdPatch || hasRelPatch) {
      const candidate = { id };
      if (hasCwdPatch) {
        if (typeof patch.cwd !== 'string' || !patch.cwd) {
          throw unportableCwdError([{ id, fail: { reason: 'invalid-cwd', cwd: patch.cwd } }], home);
        }
        candidate.cwd = patch.cwd;
      }
      if (hasRelPatch) {
        if (typeof patch.cwdRel !== 'string') {
          throw unportableCwdError([{ id, fail: { reason: 'invalid-rel', cwdRel: patch.cwdRel } }], home);
        }
        candidate.cwdRel = patch.cwdRel;
      }
      // Se arriva una sola coordinata, quella e' la nuova sorgente autoritativa:
      // l'altra va ricalcolata, non confrontata col valore persistito precedente.
      // Solo quando la patch porta entrambe si verifica esplicitamente la
      // coerenza della coppia. Questo rende possibile cambiare directory e la
      // futura repair UI senza indebolire il controllo mismatch.
      const [resolved] = resolveCellsOrFail([candidate], home);
      resolvedCwd = { cwd: resolved.cwd, cwdRel: resolved.cwdRel };
    }
    await mutate(defs, (d) => {
      const target = findCell(d, id);
      const hasEngine = typeof patch?.engine === 'string';
      const hasModel = Object.prototype.hasOwnProperty.call(patch || {}, 'model');
      const hasPolicy = Object.prototype.hasOwnProperty.call(patch || {}, 'permissionPolicy');
      if (hasPolicy && patch.permissionPolicy !== 'standard' && patch.permissionPolicy !== 'unsafe' && patch.permissionPolicy !== null) {
        throw httpError(400, 'permissionPolicy non valida (standard|unsafe)');
      }
      for (const [key, value] of Object.entries(patch || {})) {
        if (key === 'engine' || key === 'model' || key === 'permissionPolicy' || key === 'cwd' || key === 'cwdRel') continue;
        if (value === null) delete target[key]; else target[key] = value;
      }
      if (resolvedCwd) { target.cwd = resolvedCwd.cwd; target.cwdRel = resolvedCwd.cwdRel; }
      if (hasEngine || hasModel || hasPolicy) applyCellTransition(target, hasEngine ? patch.engine : target.engine, {
        model: patch?.model, hasModel,
        policy: hasPolicy ? patch.permissionPolicy : null,
        hasPolicy,
      });
    });
    const sessions = await refreshSessions();
    return { ok: true, active: sessions.has(findCell(defs, id).tmuxSession) };
  }

  // Ripristino selettivo atomico da backup PWA. Il body contiene SOLO campi
  // cella allowlisted (mai engine.env/provider secrets). Tutte le celle vengono
  // validate insieme da atomicWrite: un errore lascia il file precedente intatto.
  async function restoreCells(cells) {
    if (readonly()) throw httpError(403, 'READONLY: restore-cells bloccato');
    if (!Array.isArray(cells) || cells.length < 1 || cells.length > MAX_CELLS) {
      throw httpError(400, `cells deve contenere 1..${MAX_CELLS} definizioni`);
    }
    const allowed = new Set(['id', 'cwd', 'cwdRel', 'engine', 'boot', 'model', 'models', 'permissionPolicies', 'commands', 'prompt']);
    const seen = new Set();
    for (const cell of cells) {
      if (!cell || typeof cell !== 'object' || Array.isArray(cell)) throw httpError(400, 'definizione cell non valida');
      for (const key of Object.keys(cell)) if (!allowed.has(key)) throw httpError(400, `campo backup non ammesso: ${key}`);
      if (typeof cell.id !== 'string' || seen.has(cell.id)) throw httpError(400, `id cell duplicato o mancante: ${cell.id || '?'}`);
      seen.add(cell.id);
    }
    const defs = reloadDefs();
    const availableEngines = new Set(defs.engines.map((engine) => engine.id));
    const referencedEngines = new Set();
    for (const cell of cells) {
      referencedEngines.add(cell.engine);
      for (const id of Object.keys(cell.models || {})) referencedEngines.add(id);
      for (const id of Object.keys(cell.permissionPolicies || {})) referencedEngines.add(id);
      for (const id of Object.keys(cell.commands || {})) referencedEngines.add(id);
    }
    const missingEngines = [...referencedEngines].filter((id) => !availableEngines.has(id)).sort();
    if (missingEngines.length) {
      throw httpError(400, `engine mancanti sul target: ${missingEngines.join(', ')}`, {
        code: 'missing-engines', missingEngines,
        hint: 'definisci prima gli engine mancanti oppure mappa le celle su engine disponibili',
      });
    }
    const replaced = cells.filter((cell) => !!findCell(defs, cell.id)).map((cell) => cell.id);
    const created = cells.filter((cell) => !findCell(defs, cell.id)).map((cell) => cell.id);
    // cwd portabile fail-closed: prevalida TUTTE le celle (cwd assoluta legacy
    // oppure cwdRel portatile v3) prima di mutate. Al primo rifiuto nessuna
    // scrittura parziale. v1/v2 portano cwd assoluta e vengono rifiutate in modo
    // strutturato se non valide sul target (path di un altro device / inesistenti).
    const resolvedCells = resolveCellsOrFail(cells, home);
    await mutate(defs, (draft) => {
      for (const cell of resolvedCells) {
        const index = draft.cells.findIndex((current) => current.id === cell.id);
        const next = { ...cell };
        if (index >= 0) {
          // tmuxSession e' identita' runtime immutabile: il backup non la porta.
          next.tmuxSession = draft.cells[index].tmuxSession;
          draft.cells[index] = next;
        } else draft.cells.push(next);
      }
    });
    const sessions = await refreshSessions();
    const saved = reloadDefs();
    return {
      ok: true, count: cells.length, created, replaced,
      needsRestart: cells.map((cell) => findCell(saved, cell.id))
        .filter((cell) => cell && sessions.has(cell.tmuxSession)).map((cell) => cell.id),
    };
  }

  // Ripristino engine separato e atomico. Il formato portatile non accetta mai
  // `env` values: per un engine custom nuovo parte da env vuoto; in overwrite
  // conserva gli eventuali valori write-only già configurati sul target.
  async function restoreEngines(engines, opts = {}) {
    if (readonly()) throw httpError(403, 'READONLY: restore-engines bloccato');
    if (!Array.isArray(engines) || engines.length < 1 || engines.length > 24) {
      throw httpError(400, 'engines deve contenere 1..24 definizioni');
    }
    const allowed = new Set(['id', 'label', 'rc', 'managed', 'command', 'args', 'envKeys', 'model', 'promptMode', 'promptFlag']);
    const seen = new Set();
    for (const engine of engines) {
      if (!engine || typeof engine !== 'object' || Array.isArray(engine)) throw httpError(400, 'definizione engine non valida');
      for (const key of Object.keys(engine)) if (!allowed.has(key)) throw httpError(400, `campo engine backup non ammesso: ${key}`);
      if (typeof engine.id !== 'string' || seen.has(engine.id)) throw httpError(400, `id engine duplicato o mancante: ${engine.id || '?'}`);
      if (engine.managed && engine.envKeys !== undefined) throw httpError(400, `envKeys non ammesso per engine managed: ${engine.id}`);
      if (!engine.managed && (!Array.isArray(engine.envKeys)
        || engine.envKeys.length > 32
        || engine.envKeys.some((key) => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key))
        || new Set(engine.envKeys).size !== engine.envKeys.length)) {
        throw httpError(400, `envKeys non valido per engine: ${engine.id}`);
      }
      if (!engine.managed && Array.isArray(engine.args) && engine.args.some((arg) => {
        const text = String(arg || '');
        return /(?:bearer\s+|authorization\s*[:=]|(?:api[_-]?key|secret|token)\s*[:=])/i.test(text)
          || /^-{1,2}(?:api[-_]?key|access[-_]?key|auth(?:orization)?[-_]?token|token|secret|password|credential)(?:$|=)/i.test(text)
          || /\b(?:sk|fw|fpk|hf|zai)[-_][A-Za-z0-9._-]{8,}\b/i.test(text)
          || /https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(text);
      })) {
        throw httpError(400, `argomento potenzialmente segreto non ammesso per engine: ${engine.id}`);
      }
      seen.add(engine.id);
    }
    const defs = reloadDefs();
    const conflicts = engines.filter((engine) => !!findEngine(defs, engine.id)).map((engine) => engine.id);
    if (conflicts.length && opts.overwrite !== true) {
      throw httpError(409, `engine già esistenti: ${conflicts.join(', ')}`, { code: 'engine-conflicts', conflicts });
    }
    const sessions = await refreshSessions();
    const affected = defs.cells.filter((cell) => conflicts.includes(cell.engine) && sessions.has(cell.tmuxSession)).map((cell) => cell.id);
    await mutate(defs, (draft) => {
      for (const portable of engines) {
        const index = draft.engines.findIndex((current) => current.id === portable.id);
        const current = index >= 0 ? draft.engines[index] : null;
        const next = { ...portable };
        if (!next.managed) {
          const keys = next.envKeys;
          delete next.envKeys;
          next.env = Object.fromEntries(keys.map((key) => [key,
            current && !current.managed && Object.prototype.hasOwnProperty.call(current.env || {}, key)
              ? current.env[key] : '',
          ]));
        }
        if (index >= 0) draft.engines[index] = next; else draft.engines.push(next);
      }
    });
    return {
      ok: true, count: engines.length,
      created: engines.filter((engine) => !conflicts.includes(engine.id)).map((engine) => engine.id),
      replaced: conflicts, needsRestart: affected,
    };
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

  // importCell: riconcilia una sessione tmux esistente (es. cella Fleet legacy
  // rimasta orfana su installazione pulita, tipo "jarvis") in una cella GESTITA
  // di fleet.json. Design §reconciliation:
  //  - idempotente: se una cella gestita possiede gia' questa tmuxSession -> no-op.
  //  - NESSUNA invenzione di engine/provider/model: l'engine DEV'essere gia'
  //    dichiarato in fleet.json (l'operatore lo sceglie). model/policy restano i
  //    default dell'engine scelto (modificabili dopo dal pannello di lancio).
  //  - tmuxSession non canonica (es. "jarvis") è ammessa e round-trip; una
  //    sessione legacy canonica cloud-X viene adottata come cella X.
  //  - cwd obbligatoria (default = home); la validazione strict (parseCell, sotto
  //    home, no cloud-* alias incoerenti) avviene in atomicWrite -> errore chiaro.
  // Dopo l'import la sessione sparisce da "unmanaged" e compare una sola volta in
  // Fleet con gear+power. Elimina/terminate resta solo nelle Impostazioni.
  const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
  function deriveCellId(session, cells) {
    const raw = String(session || '');
    // Una sessione legacy canonica cloud-X si adotta come cella X. Usare
    // direttamente cloud-X come id produrrebbe cloud-cloud-X e fallirebbe la
    // validazione; un id esplicito diverso continua invece a essere rifiutato.
    const canonicalSuffix = raw.startsWith('cloud-') ? raw.slice('cloud-'.length) : '';
    let base = (canonicalSuffix && CELL_ID_RE.test(canonicalSuffix) ? canonicalSuffix : raw)
      .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'cell';
    const used = new Set(cells.map((c) => c.id));
    if (!used.has(base)) return base;
    if (canonicalSuffix) return base; // il caller produrrà un 409 esplicito
    for (let i = 2; i < 100; i += 1) {
      const candidate = `${base.slice(0, Math.max(1, 32 - String(i).length - 1))}-${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return base;
  }
  async function importCell(b = {}) {
    if (readonly()) throw httpError(403, 'READONLY: import bloccato');
    const tmuxSession = typeof b.tmuxSession === 'string' ? b.tmuxSession.trim() : '';
    if (!tmuxSession || !validTmuxName(tmuxSession)) throw httpError(400, 'tmuxSession non valida');
    const defs = reloadDefs();
    const existing = defs.cells.find((c) => c.tmuxSession === tmuxSession);
    if (existing) return { ok: true, id: existing.id, tmuxSession, idempotent: true };
    const sessions = await refreshSessions();
    if (!sessions.has(tmuxSession)) {
      throw httpError(404, `sessione tmux non trovata: ${tmuxSession}`);
    }
    const engineId = typeof b.engine === 'string' ? b.engine.trim() : '';
    if (!engineId || !findEngine(defs, engineId)) {
      throw httpError(400, `engine non dichiarato: "${engineId || '(manca)'}" — crea prima l'engine in Impostazioni`);
    }
    let id = typeof b.id === 'string' && b.id.trim() ? b.id.trim() : deriveCellId(tmuxSession, defs.cells);
    if (!CELL_ID_RE.test(id)) throw httpError(400, 'id non valido (A-Za-z0-9._- max 32)');
    if (defs.cells.some((c) => c.id === id)) throw httpError(409, `id cella già usato: ${id}`);
    const cwd = typeof b.cwd === 'string' && b.cwd.trim() ? b.cwd.trim() : home;
    const cellDef = { id, cwd, engine: engineId, boot: b.boot === true, tmuxSession };
    // Import is a write boundary just like define/edit/restore. Resolve and
    // confine the cwd before mutate so a foreign or missing path is never
    // persisted as a cell that can only fail later at up().
    const [resolvedCell] = resolveCellsOrFail([cellDef], home);
    try {
      await mutate(defs, (d) => { d.cells.push(resolvedCell); });
    } catch (e) { throw httpError(400, `import non valido: ${e.message}`); }
    return { ok: true, id, tmuxSession, imported: true };
  }

  // Vista editabile ma secret-safe: gli env values restano write-only.
  function definitions() {
    const defs = reloadDefs();
    const { map: credentialMap } = credentialRequirements(defs);
    const managedCatalog = publicCatalog().map((profile) => {
      if (typeof profile.credentialEnv !== 'string') return profile;
      const status = describeCatalogCredential(
        profile.client, profile.provider, profile.credentialProfile, { ...cfg, home },
      );
      const usedBy = credentialMap.get(profile.credentialEnv)?.engines || [];
      return {
        ...profile,
        authConfigured: status?.authConfigured === true,
        credentialSource: status?.credentialSource || 'missing',
        credentialUsedBy: [...usedBy].sort(),
      };
    });
    // realHome una volta per le vista cwdRel/needsRepair (derivate, NON persistite).
    const realHome = resolveCwd(home, home);
    return {
      schemaVersion: defs.schemaVersion,
      engines: defs.engines.map((e) => {
        const out = { ...e, envKeys: Object.keys(e.env || {}).sort() };
        delete out.env;
        if (e.managed) out.managedInfo = describeManaged(e.managed, { ...cfg, home });
        return out;
      }),
      cells: defs.cells.map((c) => {
        const out = {
          ...c,
          ...(c.models ? { models: { ...c.models } } : {}),
          ...(c.permissionPolicies ? { permissionPolicies: { ...c.permissionPolicies } } : {}),
          ...(c.commands ? { commands: { ...c.commands } } : {}),
        };
        // cwdRel portatile derivato (solo vista): per celle valide (cwd reale
        // sotto home) espone il rel canonico; per celle persistite ma non
        // valide/fuori home espone needsRepair:true. NESSUNA mutazione di
        // fleet.json (la vista non scrive). cwdRel persistito e' sempre
        // ricalcolato dal realpath (autoritativo) cosi' export e UI sono coerenti.
        const realCwd = resolveCwd(c.cwd, home);
        if (realCwd && realHome) {
          const rel = deriveCwdRel(realCwd, realHome);
          if (rel !== null) out.cwdRel = rel; else out.needsRepair = true;
        } else {
          out.needsRepair = true;
        }
        // Suggerimento azionabile ma mai applicato: se il basename della cwd
        // foreign esiste gia' sotto la home target, la UI puo' offrirlo come
        // cwdRel esplicita senza mostrare o reinviare il path sorgente.
        if (out.needsRepair) {
          const suggestion = suggestCwdRel(c.cwd, home);
          if (suggestion) out.cwdSuggestion = suggestion;
        }
        return out;
      }),
      managedCatalog,
      managedConfig: {
        providerSecretsPath: cfg.providerSecretsPath || path.join(home, '.nexuscrew', 'providers.env'),
        providerShellPath: cfg.providerShellPath || path.join(home, '.config', 'ai-shell', 'providers.zsh'),
        providerKeysPath: cfg.providerKeysPath || path.join(home, '.config', 'keys', 'ai.env'),
        providerSecurePath: cfg.providerSecurePath || path.join(home, '.config', 'secure', '.env'),
        localCredentialStore: true,
      },
    };
  }

  function credentialRequirements(existingDefs) {
    const defs = existingDefs || reloadDefs(); const map = new Map();
    for (const engine of defs.engines) {
      if (!engine.managed) continue;
      const info = describeManaged(engine.managed, { ...cfg, home });
      const envKey = info.auth;
      if (!validEnvKey(envKey) || envKey === 'login' || envKey === 'none') continue;
      const current = map.get(envKey) || {
        envKey, configured: false, source: 'missing', engines: [], activeCells: [],
      };
      current.configured ||= info.authConfigured === true;
      if (info.credentialSource && info.credentialSource !== 'missing') current.source = info.credentialSource;
      current.engines.push(engine.id);
      map.set(envKey, current);
    }
    return { defs, map };
  }

  async function credentialStatus() {
    const { defs, map } = credentialRequirements();
    const sessions = await refreshSessions();
    for (const entry of map.values()) {
      entry.engines.sort();
      entry.activeCells = defs.cells
        .filter((cell) => entry.engines.includes(cell.engine) && sessions.has(cell.tmuxSession))
        .map((cell) => cell.id).sort();
    }
    return { credentials: [...map.values()].sort((a, b) => a.envKey.localeCompare(b.envKey)) };
  }

  async function setLocalCredential(envKey, value) {
    if (readonly()) throw httpError(403, 'READONLY: credential write blocked');
    const { map } = credentialRequirements();
    if (!map.has(envKey)) throw httpError(400, 'credential key is not required by a configured engine');
    try { setCredential({ ...cfg, home }, envKey, value, home); }
    catch (error) { throw httpError(400, error.message); }
    return credentialStatus();
  }

  async function removeLocalCredential(envKey) {
    if (readonly()) throw httpError(403, 'READONLY: credential removal blocked');
    const { map } = credentialRequirements();
    if (!map.has(envKey)) throw httpError(400, 'credential key is not required by a configured engine');
    try { removeCredential({ ...cfg, home }, envKey, home); }
    catch (error) { throw httpError(400, error.message); }
    return credentialStatus();
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
          client: { type: 'enum', values: ['claude', 'codex', 'codex-vl', 'pi', 'shell'] },
          provider: { type: 'catalog', source: 'managedCatalog' },
          credentialProfile: { type: 'string', required: false, max: 32 },
          model: { type: 'string', required: false, max: CAPS.MAX_MODEL_VAL_LEN },
          permissionPolicy: { type: 'enum', values: ['standard', 'unsafe'], default: 'standard' },
          displayName: { type: 'string', requiredFor: 'provider=custom', max: CAPS.MAX_LABEL_LEN },
          protocol: { type: 'catalog', source: 'managedCatalog.protocol' },
          baseUrl: { type: 'string', requiredFor: 'provider=custom', max: CAPS.MAX_COMMAND_LEN },
          envKey: { type: 'string', requiredFor: 'provider=custom', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$' },
          providerId: { type: 'string', requiredFor: 'provider=custom', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
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
        cwdRel: { type: 'string', required: false, max: CAPS.MAX_CWD_LEN, portable: true, default: '' },
        engine: { type: 'string', required: true, ref: 'engine.id' },
        boot: { type: 'boolean', required: false, default: false },
        model: { type: 'string', required: false, max: CAPS.MAX_MODEL_VAL_LEN },
        models: { type: 'object', required: false, keyRef: 'engine.id', valueMax: CAPS.MAX_MODEL_VAL_LEN },
        permissionPolicies: { type: 'object', required: false, keyRef: 'engine.id', valueEnum: ['standard', 'unsafe'] },
        commands: { type: 'object', required: false, keyRef: 'engine.id', valueMax: CAPS.MAX_CELL_COMMAND_LEN, managedClient: 'shell' },
        prompt: { type: 'string', required: false, max: CAPS.MAX_PROMPT_LEN },
      },
    };
  }

  function capabilities() {
    return ['status', 'up', 'down', 'restart', 'engine', 'boot', 'define', 'edit', 'remove', 'import', 'restore', 'schema', 'definitions', 'credentials'];
  }

  async function close() { await launchBroker.close(); }

  return {
    available: true,
    provider: 'builtin',
    status, up, down, restart, engine: setEngine, boot: setBoot, isCellSession,
    defineEngine, editEngine, removeEngine,
    defineCell, editCell, removeCell, importCell, restoreCells, restoreEngines,
    schema, definitions, capabilities,
    credentialStatus, setLocalCredential, removeLocalCredential, close,
  };
}

module.exports = {
  createBuiltinFleet,
  backfillShellEngine,
  resolveCellCwd,
  composeLaunchArgv,
  composeClientInvocation,
  minimalEnv,
  promptCharsOk,
  redactSecrets,
  sanitizeEarlyDiagnostic,
  waitStablePane,
  MINIMAL_ENV_KEYS,
};
