'use strict';
// Runtime del fleet built-in (estratto da builtin.js in modo behavior-preserving).
// Possiede lo stato condiviso (cache definizioni + sessioni tmux) ed espone:
//   status / up / down / restart / isCellSession   — contratto runtime
//   reloadDefs / findCell / findEngine / refreshSessions / commitDefs
//     — accessor allo store, riusati dal facade CRUD di builtin.js
//
// Tutto l'argv/env/readiness/redaction e' delegato al toolkit stateless
// launch.js. createBuiltinFleet() (builtin.js) istanzia questo runtime e
// costruisce sopra di esso il CRUD/schema/credentials.
//
// Il contratto pubblico, l'argv, l'env, i readiness check, la permission
// policy, la redazione e il testo degli errori sono INVARIATI rispetto a
// builtin.js prima dell'estrazione.
const path = require('node:path');
const {
  loadDefinitions, validateCommandTrust, resolveCwd,
} = require('./definitions.js');
const {
  describeManaged, resolveManagedEngine, discoverOllamaModels, discoverPiModels,
} = require('./managed.js');
const {
  httpError, minimalEnv, tmuxExec,
  composeClientInvocation, composeLaunchArgv,
  waitAlive, waitStablePane, injectPrompt,
  redactSecrets, sanitizeEarlyDiagnostic,
} = require('./launch.js');

// TTL della cache status (ms): scaduto, status rilegge tmux + defs da disco.
const STATUS_TTL_MS = 2000;

function findCell(defs, id) { return defs.cells.find((c) => c.id === id) || null; }
function findEngine(defs, id) { return defs.engines.find((e) => e.id === id) || null; }

// ---------------------------------------------------------------------------
// createBuiltinRuntime(ctx)
//   ctx: { cfg, home, defsPath, tmuxBin, readonly, launchBroker, boot }
//   boot = definizioni iniziali (loadDefinitions, non null: il caller gia'
//   e' tornato unavailable su garbage).
// ---------------------------------------------------------------------------
function createBuiltinRuntime(ctx) {
  const { cfg, home, defsPath, tmuxBin, readonly, launchBroker, boot } = ctx;
  let cache = { at: 0, defs: boot, sessions: new Set() };

  function reloadDefs() {
    const d = loadDefinitions(defsPath);
    if (d) cache = { ...cache, at: 0, defs: d };
    return cache.defs; // mai null: boot non-null e reload mantiene l'ultimo valido
  }

  // Commit del defs mutato dal facade CRUD (builtin.js mutate()). invalida anche
  // la TTL dello status, esattamente come faceva builtin.js prima dell'estrazione.
  function commitDefs(defs) {
    cache = { ...cache, at: 0, defs };
    return defs;
  }

  async function refreshSessions() {
    const r = await tmuxExec(tmuxBin, ['list-sessions', '-F', '#{session_name}\t#{session_windows}'], { env: minimalEnv() });
    if (r.err) return new Set();            // nessun server / nessuna sessione
    const set = new Set();
    for (const line of r.stdout.split('\n')) {
      const [rawName, rawWindows] = line.split('\t');
      const n = String(rawName || '').trim();
      const windows = rawWindows === undefined ? 1 : Number(rawWindows);
      if (n && Number.isFinite(windows) && windows > 0) set.add(n);
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
      // Effective policy per cella: override remembered per-engine, altrimenti il
      // default dell'engine gestito. Esposta SOLO come policy effettiva (mai segreti).
      const engineDef = findEngine(cache.defs, c.engine);
      const engineDefault = engineDef && engineDef.managed ? engineDef.managed.permissionPolicy : '';
      const remembered = c.permissionPolicies
        && (c.permissionPolicies[c.engine] === 'standard' || c.permissionPolicies[c.engine] === 'unsafe')
        ? c.permissionPolicies[c.engine] : null;
      const effectivePolicy = engineDef?.managed?.client === 'pi'
        ? 'standard'
        : (remembered || engineDefault || '');
      return {
        cell: c.id, tmuxSession: c.tmuxSession, engine: c.engine,
        model: c.model || '', models: { ...(c.models || {}) },
        permissionPolicy: effectivePolicy,
        permissionPolicies: { ...(c.permissionPolicies || {}) },
        active: alive, boot: c.boot, tmux: alive,
        supervised: true, keepalive: true,
        rc: '', key: '', degraded: false, // supervisor vivo <=> sessione tmux viva
      };
    });
    const needsOllama = cache.defs.engines.some((e) => e.managed?.provider === 'ollama-cloud');
    const ollamaModels = needsOllama ? await discoverOllamaModels({ ...cfg, home }) : [];
    const needsPi = cache.defs.engines.some((e) => e.managed?.client === 'pi');
    const piModels = needsPi ? await discoverPiModels({ ...cfg, home }) : {};
    const engines = cache.defs.engines.map((e) => {
      const managed = e.managed ? describeManaged(e.managed, { ...cfg, home }) : null;
      return {
        id: e.id, label: e.label, rc: !!e.rc,
        ...(managed ? {
          kind: 'managed', client: managed.client, provider: managed.provider,
          model: e.managed.model || managed.defaultModel || '',
          models: managed.provider === 'ollama-cloud' ? ollamaModels
            : (managed.client === 'pi'
              ? (e.managed.provider === 'custom'
                ? [e.managed.model]
                : (e.managed.provider === 'native'
                  ? [...new Set(Object.values(piModels).flat())]
                  : (piModels[e.managed.provider] || [])))
              : managed.models),
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

    // (4)+(5) argv diretto (no shell). Every cell goes through the private
    // broker-backed supervisor: credentials never enter tmux state/argv and a
    // client that exits after readiness is restarted with bounded backoff.
    // '-P -F #{pane_id}': tmux stampa il pane id della sessione appena creata,
    // cosi' l'iniezione del prompt bersaglia ESATTAMENTE quel pane (audit impl
    // #5: elimina la race di riuso del nome sessione tra waitAlive e paste).
    const readyMs = cfg.launchReadyMs != null ? cfg.launchReadyMs : 500;
    const child = composeClientInvocation(launchEngine, cell);
    const ticket = await launchBroker.issue({
      command: child.command,
      args: child.args,
      env: {
        ...minimalEnv(),
        ...launchEngine.env,
        NEXUSCREW_MCP_SESSION: cell.tmuxSession,
      },
      supervise: {
        enabled: true,
        initialReadyMs: Math.max(50, Math.min(30000, Number(readyMs) || 500)),
        restartDelayMs: Math.max(50, Math.min(60000, Number(cfg.cellRestartDelayMs) || 1000)),
        maxRestartDelayMs: Math.max(100, Math.min(300000, Number(cfg.cellMaxRestartDelayMs) || 60000)),
        resetAfterMs: Math.max(1000, Math.min(3600000, Number(cfg.cellRestartResetMs) || 30000)),
        rapidWindowMs: Math.max(1000, Math.min(3600000, Number(cfg.cellRapidWindowMs) || 60000)),
        maxRapidRestarts: Math.max(1, Math.min(100, Number(cfg.cellMaxRapidRestarts) || 8)),
      },
      ...(launchEngine.promptMode === 'send-keys' && cell.prompt ? {
        restartPrompt: {
          tmuxBin,
          tmuxSession: cell.tmuxSession,
          prompt: cell.prompt,
          readyMs: Math.max(0, Math.min(30000, Number(cfg.sendKeysReadyMs) || readyMs)),
        },
      } : {}),
    });
    const tmuxLaunchEngine = {
      command: process.execPath,
      args: [path.join(__dirname, 'cell-exec.js'), '--socket', ticket.socketPath, '--nonce', ticket.nonce],
      env: {}, promptMode: 'managed-argv',
    };
    const argv = composeLaunchArgv({ tmuxSession: cell.tmuxSession, realCwd, engine: tmuxLaunchEngine, cell });
    argv.splice(2, 0, '-P', '-F', '#{pane_id}');
    // Mantieni il pane morto solo durante la finestra di readiness: permette di
    // catturare un errore reale del client senza lasciare una sessione fantasma.
    // Il separatore e' interpretato da tmux (execFile argv diretto), non da shell.
    argv.push(';', 'set-option', '-w', '-t', `=${cell.tmuxSession}:`, 'remain-on-exit', 'on');
    const launch = await tmuxExec(tmuxBin, argv, { env: minimalEnv() });
    if (launch.err) {
      // Redazione (§9h): lo stderr di tmux puo' ecoare argv/env del comando lanciato.
      const why = /duplicate session/i.test(launch.stderr)
        ? 'sessione già in esecuzione'
        : `tmux new-session failed: ${redactSecrets(launch.stderr.trim() || launch.err.message, launchEngine, cell)}`;
      throw httpError(/duplicate/i.test(launch.stderr) ? 409 : 500, why);
    }

    // `tmux new-session -d` can return 0 even when the launched CLI exits a
    // moment later (missing login, bad model, incompatible provider).  Without
    // this readiness gate the PWA reported success and then showed nothing.
    // Always verify liveness, including cells without a system prompt.
    const paneId = launch.stdout.trim().split('\n')[0] || '';
    const readiness = paneId.startsWith('%')
      ? await waitStablePane(tmuxBin, paneId, { env: minimalEnv(), readyMs })
      : { alive: await waitAlive(tmuxBin, cell.tmuxSession, { env: minimalEnv(), readyMs }), status: null, target: null };
    if (!readiness.alive) {
      let diagnostic = '';
      if (readiness.target) {
        const captured = await tmuxExec(tmuxBin,
          ['capture-pane', '-p', '-S', '-80', '-t', readiness.target], { env: minimalEnv(), timeoutMs: 2000 });
        if (!captured.err) diagnostic = sanitizeEarlyDiagnostic(captured.stdout, launchEngine, cell, home);
      }
      // remain-on-exit era soltanto diagnostico: nessun pane morto deve restare
      // nella Fleet o nella lista tmux dopo aver raccolto l'errore.
      await tmuxExec(tmuxBin, ['kill-session', '-t', `=${cell.tmuxSession}`], { env: minimalEnv(), timeoutMs: 2000 });
      cache = { ...cache, at: 0 };
      const client = path.basename(launchEngine.clientBinary || launchEngine.command || 'client');
      const status = Number.isInteger(readiness.status) ? ` (exit ${readiness.status})` : '';
      throw httpError(500, `client ${client} terminato subito${status}: ${diagnostic || 'verifica login, provider, modello e argomenti dell\'engine'}`);
    }
    if (readiness.target) {
      await tmuxExec(tmuxBin,
        ['set-option', '-w', '-t', readiness.target, 'remain-on-exit', 'off'], { env: minimalEnv(), timeoutMs: 2000 });
    }

    // (6) prompt send-keys: bracketed-paste best-effort, target = pane id esatto
    // (fallback al nome sessione con match esatto '=' se tmux non ha stampato l'id).
    let prompt = null;
    if (launchEngine.promptMode === 'send-keys' && cell.prompt) {
      const target = paneId.startsWith('%') ? paneId : `=${cell.tmuxSession}`;
      prompt = await injectPrompt(tmuxBin, cell.tmuxSession, cell.prompt, {
        env: minimalEnv(),
        readyMs: cfg.sendKeysReadyMs != null ? cfg.sendKeysReadyMs : readyMs,
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
  // Restart è implementato dal runtime built-in come transizione intenzionale.
  async function restart(cellId) {
    if (readonly()) throw httpError(403, 'READONLY: restart bloccato');
    await down(cellId); // idempotente: cella non viva -> nessun errore
    return up(cellId);
  }

  return {
    status, up, down, restart, isCellSession,
    reloadDefs, findCell, findEngine, refreshSessions, commitDefs,
  };
}

module.exports = { createBuiltinRuntime, findCell, findEngine, STATUS_TTL_MS };
