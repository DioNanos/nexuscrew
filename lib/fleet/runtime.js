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
const crypto = require('node:crypto');
const {
  loadDefinitions, validateCommandTrust, resolveCwd,
} = require('./definitions.js');
const aiDesktop = require('./ai-desktop.js');
const {
  describeManaged, resolveManagedEngine, discoverOllamaModels, discoverPiModels, extraModelsFrom,
  knownMcpServerNames, filesRootDi,
} = require('./managed.js');
const { sharedProbe: defaultEndpointProbe } = require('./endpoint-probe.js');
const { NC_SUPERVISOR_OPT } = require('../tmux/supervisor-pane.js');
const {
  httpError, minimalEnv, tmuxExec,
  composeClientInvocation, alternateScreenArgs,
  waitAlive, waitStablePane, injectPrompt,
  redactSecrets, sanitizeEarlyDiagnostic,
} = require('./launch.js');
const {
  waitDeliveryReport, actionRequiredFor, vlPaneReadiness,
} = require('./prompt-delivery.js');
const { consumeVlNewSession, vlNewSessionStatus } = require('./vl-session.js');
const {
  pubblicaSelettoreLancio, rimuoviSelettoreLancio, potaTerminali,
  registraLancioCorrente, leggiLancioCorrente, leggiDiagnosiTerminaleCorrente,
} = require('../files/activity.js');

// Insieme MCP MATERIALIZZATO della cella — le chiavi del file che
// writeCellMcpConfig (managed.js) scrive PRIMA dello spawn. Un server non
// concesso non esiste per il launch, quindi non e' atteso dal gate.
const MCP_BUDGET_DEFAULT_MS = 20000; // tetto approvato per il gate MCP

function cellMcpExpectedServers(home, cellId) {
  const fs = require('node:fs');
  try {
    const p = path.join(home, '.nexuscrew', 'cell-mcp', `${cellId}.json`);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile()) return [];
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const servers = parsed && typeof parsed === 'object' && parsed.mcpServers
      && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers : null;
    return servers ? Object.keys(servers).sort() : [];
  } catch (_) { return []; }
}

// Celle claude LEGACY (nessun materializzato cell-mcp): l'atteso e' la config
// nota al client (le tre sorgenti di `knownMcpServerNames`) meno cio' che la
// cella nega con `cell.mcp`. RESIDUO DICHIARATO: plugin, connettori e
// configurazione gestita di sistema non sono enumerabili e restano fuori
// dall'atteso — il gate copre cio' che e' enumerabile, mai promette il totale.
function legacyMcpExpectedServers(home, cwd, cell) {
  const noti = [...(knownMcpServerNames(home, cwd) || [])];
  if (!noti.length) return [];
  const voluti = cell && Array.isArray(cell.mcp) ? cell.mcp : null;
  if (voluti === null) return [...noti].sort();
  const concessi = new Set(voluti.filter((n) => typeof n === 'string'));
  return [...noti].filter((n) => concessi.has(n)).sort();
}

// Payload readiness per il supervisore: cwd reale della cella + attese + tetto
// MCP. Priorita' all'insieme MATERIALIZZATO (cell-mcp); per le claude legacy
// ricade sulla config nota meno i negati. undefined quando la cella non ha
// server attesi (niente gate: consegna come kimi, che da 0.8.47 non ha gate).
function buildMcpReadinessPayload(cell, realCwd, home, cfg) {
  const expectedServers = cellMcpExpectedServers(home, cell.id).length
    ? cellMcpExpectedServers(home, cell.id)
    : legacyMcpExpectedServers(home, realCwd, cell);
  if (!expectedServers.length) return undefined;
  return {
    cwd: realCwd,
    expectedServers,
    budgetMs: Math.max(0, Math.min(120000, Number(cfg && cfg.mcpReadyBudgetMs) || MCP_BUDGET_DEFAULT_MS)),
  };
}

// TTL della cache status (ms): scaduto, status rilegge tmux + defs da disco.
const STATUS_TTL_MS = 2000;

// Pausa minima fra due lanci della STESSA cella vl (ms). Il default è i 10 s
// del contratto; configurabile via cfg.vlLaunchCooldownMs (0 lo disattiva,
// il tetto alto è 1 h). Il clock è il MONOTONO (seam cfg.monotonicNow nei test):
// un balzo dell'orologio di parete non accorcia la pausa minima.
const VL_LAUNCH_COOLDOWN_DEFAULT_MS = 10000;
const VL_LAUNCH_COOLDOWN_MAX_MS = 3600000;

function clampCooldown(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return VL_LAUNCH_COOLDOWN_DEFAULT_MS;
  return Math.max(0, Math.min(VL_LAUNCH_COOLDOWN_MAX_MS, Math.floor(n)));
}

function findCell(defs, id) { return defs.cells.find((c) => c.id === id) || null; }
function findEngine(defs, id) { return defs.engines.find((e) => e.id === id) || null; }

// ---------------------------------------------------------------------------
// createBuiltinRuntime(ctx)
//   ctx: { cfg, home, defsPath, tmuxBin, readonly, launchBroker, boot,
//          ensureProtection }
//   boot = definizioni iniziali (loadDefinitions, non null: il caller gia'
//   e' tornato unavailable su garbage).
// ---------------------------------------------------------------------------
// Preflight identita': un'authority configurata ma non costruibile
// REFUTA il lancio della cella protetta invece di degradarla a standalone in
// silenzio. Il motivo non contiene valori: e' la stessa stringa che il
// risolutore (lib/fleet/managed.js) mette su `identityAuthorityUnavailable`.
// Il codice e' stabile e destinato all'operatore, come gli altri IDENTITY_*.
function identityLaunchRefusal(launchEngine) {
  const reason = launchEngine && launchEngine.identityAuthorityUnavailable;
  if (!reason) return null;
  return {
    status: 500,
    code: 'IDENTITY_AUTHORITY_UNAVAILABLE',
    message: `fleet identity: authority configurata ma non costruibile (${reason}); `
      + 'la cella protetta non parte',
  };
}

function createBuiltinRuntime(ctx) {
  const {
    cfg, home, defsPath, tmuxBin, readonly, launchBroker, leaseManager, boot, ensureProtection,
    identityAuthority = null, identityMode = 'legacy', identityOwnerInstanceId = null,
  } = ctx;
  const identityDaemonBootId = cfg.identityDaemonBootId || crypto.randomBytes(16).toString('hex');
  let cache = { at: 0, defs: boot, sessions: new Set() };

  // --- Serializzazione dei lanci per cella (contratto vl, generale) ----------
  // Due up() concorrenti della STESSA cella si serializzano su una catena di
  // promise: il secondo vede lo stato lasciato dal primo (sessione viva ->
  // 409 di preflight) invece di correre contro di lui sulla new-session. Il
  // 409 resta la rete finale; il lock toglie la corsa. Celle diverse non si
  // toccano. La mappa vive nel runtime (per processo): i nodi non condividono
  // lanci, quindi non c'è niente da coordinare fuori processo.
  const launchLocks = new Map();
  // Timestamp (seam cfg.now) dell'ultimo lancio PER CELLA vl: base della
  // pausa minima fra due lanci della stessa cella.
  const vlLastLaunchAt = new Map();
  // Lancio CORRENTE per sessione — l'autorita' di lettura della diagnosi
  // terminale: { launchId, canale }. Popolato a ogni up() da chi possiede il
  // ciclo di vita, PRIMA dello spawn: vale per questo processo quando resta
  // almeno una traccia durevole (una delle DUE locazioni del registro); se
  // nessuna delle due e' scrivibile il lancio viene rifiutato, perche' dopo
  // un riavvio il registro rimasto indietro tornerebbe autorevole. Dopo un
  // riavvio la stessa verita' si ricostruisce dal registro su file
  // (launch-registry, due locazioni, vince la piu' recente): mai dall'ultimo
  // selettore leggibile, che puo' essere quello di un lancio precedente
  // rimasto li' per una pubblicazione fallita.
  const lanciCorrenti = new Map();
  const nowMs = () => (typeof cfg.now === 'function' ? cfg.now() : Date.now());

  // Il clock del cooldown e' MONOTONO, mai l'orologio di parete: un balzo
  // dell'ora (NTP, correzione manuale) non puo' accorciare la pausa minima
  // fra due lanci della stessa cella, e non puo' nemmeno allungarla. Il
  // default e' il clock monotono del processo; il seam `cfg.monotonicNow`
  // serve ai test, che cosi' non dormono mai.
  const cooldownNow = () => (typeof cfg.monotonicNow === 'function'
    ? cfg.monotonicNow()
    : Number(process.hrtime.bigint() / 1000000n));

  function reloadDefs() {
    const d = loadDefinitions(defsPath);
    if (d) cache = { ...cache, at: 0, defs: d };
    return cache.defs; // mai null: boot non-null e reload mantiene l'ultimo valido
  }

  // La fotografia definitions per le VITE di sola lettura (definitions,
  // credentialStatus): una sola lettura+parse per finestra di TTL, la stessa
  // finestra di cellStatus ma con contatore proprio, per non toccare il
  // fresco di sessions. Le mutazioni dell'interfaccia restano immediate:
  // passano da commitDefs, che aggiorna la fotografia in cache.
  let defsAt = 0;
  function cachedDefs() {
    if (Date.now() - defsAt > STATUS_TTL_MS) {
      reloadDefs();
      defsAt = Date.now();
    }
    return cache.defs;
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

  // La directory cella e il trasporto MCP dipendono soltanto da definizioni e
  // tmux. Tenerla separata dai cataloghi modello evita che un binario esterno
  // lento trasformi `/api/cells` in un falso guasto della flotta.
  // `includeCwd` di default NEGATO. La cwd reale e' un path assoluto della
  // macchina, e questa vista alimenta anche `GET /fleet/status`, che e' nella
  // allowlist federata con inoltro trasparente: senza questo default, la
  // directory di ogni cella uscirebbe verso ogni peer. Serve a un consumatore
  // solo — il ponte Live, che la chiede esplicitamente e in-processo — quindi
  // e' lui a doverla chiedere, non tutti gli altri a doversene ricordare.
  // Il backup vieta gia' le cwd assolute per la stessa ragione: sono specifiche
  // del dispositivo. Rilievo di una revisione indipendente.
  async function cellStatus({ includeCwd = false } = {}) {
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
      const effectivePolicy = ['pi', 'shell'].includes(engineDef?.managed?.client)
        ? 'standard'
        : (remembered || engineDefault || '');
      // da revisione: panelUrl per-cella vince su quello precompilato dall'engine (es.
      // desktop.local), che a sua volta e' il default. Stessa forma di
      // engineDef gia' usata sopra per la permission policy: un valore
      // presente qui e' gia' passato da validPanelUrl a monte (parseEngine/
      // parseCell), quindi si copia, non si ri-valida.
      // La spunta del desktop grafico taglia qui il pannello del container
      // quando è esplicitamente OFF: il campo non esce dallo stato, quindi il
      // tasto e la sorgente Pannello spariscono da OGNI superficie senza un
      // if nel frontend. Solo la chiave esplicita comanda: qui non si
      // interroga mai docker (percorso caldo a polling).
      const panelUrl = aiDesktop.pubblicaPanelUrlCaldo(c.panelUrl || engineDef?.panelUrl || '');
      // Le celle vl portano con se' lo stato della richiesta di sessione nuova:
      // e' l'unico posto dove l'esito di un consumo si vede senza creare una
      // NUOVA richiesta (che sarebbe un'altra mutazione). Nomi e timestamp
      // del marcatore: nessun contenuto di sessione, mai.
      const isVl = !!(engineDef && engineDef.managed && engineDef.managed.client === 'vl');
      // Diagnosi terminale del LANCIO CORRENTE (record su file del
      // supervisore, per cella e per lancio): sopravvive alla scomparsa del
      // pane, quindi e' leggibile anche quando la sessione tmux non c'e' piu'.
      // La lettura e' LEGATA ALL'AUTORITA' DEL LANCIO (registro del runtime:
      // memoria del processo per i lanci di questa vita, file per i
      // precedenti): il selettore su disco da solo non basta, perche' una
      // pubblicazione fallita puo' aver lasciato la selezione del lancio
      // PRECEDENTE — l'esito, in quel caso, e' l'assenza esplicita, mai la
      // diagnosi vecchia spacciata per attuale, e nemmeno dopo un riavvio.
      // Solo enum + timestamp: nessun testo libero, nessun percorso. La UI
      // non deve mostrare «attivo sano» dove c'e' una ragione terminale del
      // lancio corrente.
      const terminale = (() => {
        const root = filesRootDi(cfg);
        if (!root) return null;
        const sessione = c.tmuxSession;
        if (typeof sessione !== 'string' || !sessione) return null;
        const lancio = lanciCorrenti.get(sessione) || leggiLancioCorrente(root, sessione);
        if (!lancio) return null;
        const d = leggiDiagnosiTerminaleCorrente(root, sessione, lancio);
        return d ? { reason: d.reason, ts: d.ts } : null;
      })();
      return {
        // `cell` resta l'id: e' la chiave di indirizzamento. `label` e' il nome
        // leggibile e viaggia accanto, senza mai sostituirlo.
        cell: c.id, label: c.label || '', tmuxSession: c.tmuxSession, engine: c.engine,
        // cwd reale della cella (resolveCwd), per il ponte Live (fetta 3): la
        // thread ponte parte con la directory della cella designata. Null se
        // la definizione non risolve: il ponte lo dichiara, non lo indovina.
        // Presente SOLO su richiesta esplicita: vedi il commento su cellStatus.
        ...(includeCwd ? { cwd: resolveCwd(c.cwd, home) || null } : {}),
        model: c.model || '', models: { ...(c.models || {}) },
        permissionPolicy: effectivePolicy,
        permissionPolicies: { ...(c.permissionPolicies || {}) },
        active: alive, boot: c.boot, tmux: alive,
        supervised: true, keepalive: true,
        // Seam lease↔designazione (2026-08-15): il facade possiede leaseManager
        // nel ctx e qui lo esprime. `active` resta la verita' tmux (con
        // remain-on-exit la sessione sopravvive alla morte del supervisore);
        // `lease` e' la verita' di supervisione: live|grace|expired|none, o
        // 'unavailable' senza leaseManager — il fail-open dichiarato delle
        // route live-host, mai un valore che finga una verifica avvenuta.
        lease: leaseManager && typeof leaseManager.status === 'function'
          ? ((leaseManager.status(c.id) || {}).state || 'none')
          : 'unavailable',
        rc: '', key: '', degraded: false, // supervisor vivo <=> sessione tmux viva
        panelUrl,
        ...(terminale ? { terminal: terminale } : {}),
        ...(isVl ? { newSession: vlNewSessionStatus({ home, cellId: c.id }) } : {}),
      };
    });
    return {
      available: true,
      provider: 'builtin',
      bootOwner: 'builtin',
      reason: cfg.fleetProviderReason || 'fleet.json definitions',
      cells,
    };
  }

  async function status(opts = {}) {
    const base = await cellStatus(opts);
    const needsOllama = cache.defs.engines.some((e) => e.managed?.provider === 'ollama-cloud');
    const needsPi = cache.defs.engines.some((e) => e.managed?.client === 'pi');
    // Le discovery esterne hanno budget propri. Avviarle in parallelo mantiene
    // il budget dello status sotto quello del bridge invece di sommare i timeout
    // di Ollama e Pi in sequenza.
    // Stessa logica per gli endpoint dichiarati a mano: la sonda ha un budget
    // suo (≤ 1,5 s) e va in parallelo alle discovery, non in coda. Si attende
    // SOLO cio' che non e' in cache: entro il TTL il verdetto e' gia' noto, ed
    // e' questo che tiene `nc_status` e la UI lontani dal tempestare i router.
    const endpointProbe = cfg.endpointProbe || defaultEndpointProbe;
    const customUrls = [...new Set(cache.defs.engines
      .map((e) => (e.managed && e.managed.baseUrl ? e.managed.baseUrl : null))
      .filter(Boolean))];
    const endpointVerdicts = new Map();
    const probeEndpoints = customUrls.length
      ? Promise.all(customUrls.map((u) => endpointProbe.status(u).then((v) => [u, v]).catch(() => [u, null])))
      : Promise.resolve([]);
    const [ollamaModels, piModels, probedEndpoints] = await Promise.all([
      needsOllama ? discoverOllamaModels({ ...cfg, home }) : [],
      needsPi ? discoverPiModels({ ...cfg, home }) : {},
      probeEndpoints,
    ]);
    for (const [u, v] of probedEndpoints) endpointVerdicts.set(u, v);
    const engines = cache.defs.engines.map((e) => {
      const managed = e.managed ? describeManaged(e.managed, {
        ...cfg, home, extraModels: extraModelsFrom(cache.defs), engineId: e.id,
        endpointVerdict: e.managed && e.managed.baseUrl ? endpointVerdicts.get(e.managed.baseUrl) || null : null,
      }) : null;
      return {
        id: e.id, label: e.label, rc: !!e.rc,
        ...(managed ? {
          kind: 'managed', client: managed.client, provider: managed.provider,
          model: e.managed.model || managed.defaultModel || '',
          models: managed.provider === 'ollama-cloud' ? ollamaModels
            : (managed.client === 'pi'
              ? (e.managed.provider === 'custom'
                ? [...new Set([e.managed.model, ...managed.models].filter(Boolean))]
                : (e.managed.provider === 'native'
                  ? [...new Set(Object.values(piModels).flat())]
                  : (piModels[e.managed.provider] || [])))
              : managed.models),
          configured: managed.configured, reason: managed.reason,
          // Provenienza della credenziale risolta: prima non arrivava affatto
          // qui, quindi `nc_status` e la vista non potevano distinguere le
          // origini nemmeno in teoria. Path, mtime e impronta del valore — il
          // valore non esce mai da `managed.js`.
          credentialSource: managed.credentialSource || 'missing',
          credentialPath: managed.credentialPath || '',
          credentialMtime: managed.credentialMtime || 0,
          credentialHash8: managed.credentialHash8 || '',
          credentialConflict: managed.credentialConflict || null,
        } : { kind: 'custom', configured: true, model: e.model?.value || '', models: [] }),
      };
    });
    return { ...base, engines };
  }

  function isCellSession(name) {
    return cache.defs.cells.some((c) => c.tmuxSession === String(name));
  }

  // up — mandatory order.
  // Le override {engine,boot} del contratto route sono ignorate: il builtin e'
  // definitions-driven (l'engine della cella e' quello dichiarato; boot e' uno
  // stato persistente gestito da boot()). Lancia SENZA shell.
  //
  // Il corpo vero vive in upSerializzato; up() e' il lock per cella: due
  // richieste concorrenti della stessa cella si mettono in fila (la seconda
  // parte DOPO la prima, non accanto) e la coda si svuota da se'.
  async function up(cellId /* , { engine, boot } = {} */) {
    if (readonly()) throw httpError(403, 'READONLY: up bloccato');
    const previous = launchLocks.get(cellId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chained = previous.then(() => gate);
    launchLocks.set(cellId, chained);
    try {
      await previous;
      return await upSerializzato(cellId);
    } catch (e) {
      throw annotaEsitoSessioneNuova(e, cellId);
    } finally {
      release();
      if (launchLocks.get(cellId) === chained) launchLocks.delete(cellId);
    }
  }

  // Il consumo del marcatore «sessione nuova» e' un FATTO che il solo
  // errore di lancio non racconta: se il fallimento arriva DOPO il consumo,
  // la richiesta e' stata consumata e l'esito vero (la sessione e' ruotata o
  // no) NON e' tracciato da nessuna parte. Il rilievo e' che per sapere questo
  // si doveva creare una NUOVA richiesta — cioe' un'altra mutazione, e una
  // rotazione in piu'. Qui l'errore dichiara l'esito incerto: si sa che il
  // consumo c'e' stato, e non si finge che la rotazione sia avvenuta. La
  // richiesta consumata non viene MAI ripetuta in automatico.
  function annotaEsitoSessioneNuova(e, cellId) {
    try {
      const st = vlNewSessionStatus({ home, cellId });
      if (!st || st.state !== 'consumed') return e;
      if (e && typeof e === 'object') {
        e.data = { ...(e.data || {}), vlNewSession: st };
        // Marker BOUNDED per i diagnostici: un enum, mai un testo libero.
        e.vlNewSessionOutcome = 'consumed-unknown';
      }
    } catch (_) {
      // Lo stato del marcatore non e' un errore: l'errore vero resta quello
      // del lancio, e non si maschera con una lettura fallita.
    }
    return e;
  }

  async function upSerializzato(cellId /* , { engine, boot } = {} */) {
    if (typeof ensureProtection === 'function') await ensureProtection();
    const defs = reloadDefs();
    const cell = findCell(defs, cellId);
    if (!cell) throw httpError(400, `cella sconosciuta: ${cellId}`);
    const engine = findEngine(defs, cell.engine);
    if (!engine) throw httpError(400, `engine dangling per cella ${cellId}: ${cell.engine}`);
    // (0) Una cella GIA' VIVA non si rilancia — e soprattutto non si risolve.
    // Senza questo controllo l'ordine era: si risolve lo spec (che PUBBLICA la
    // generazione di attivita', managed.js:1696), si chiede il ticket, e solo
    // alla new-session si scopre che la sessione esiste gia' -> 409. Il file
    // `activity.gen` restava pero' riscritto con una generazione nuova, mentre
    // gli hook del lancio vero portano quella vecchia: lo stato di quella cella
    // veniva scartato (files/activity.js:336-338) e la UI diceva «non
    // verificata» su una cella che stava lavorando. Lo pagava qualunque `up` su
    // una cella viva: l'operatore dalla UI, e `fleet-boot` all'avvio del
    // servizio, che cicla TUTTE le celle boot:true e su quelle gia' in
    // esecuzione si limitava a saltare (boot.js:49) — dopo aver riscritto il
    // file.
    // Il 409 in fondo (new-session) resta come rete per la corsa fra questo
    // controllo e la creazione della sessione.
    const vive = await refreshSessions();
    if (vive.has(String(cell.tmuxSession))) {
      throw httpError(409, 'sessione già in esecuzione', null,
        { phase: 'preflight', code: 'SESSION_DUPLICATE' });
    }
    // Pausa minima fra due lanci della STESSA cella vl (contratto vl): il
    // cooldown deduplica doppio click/retry e mette un passo massimo alla
    // ripetizione dei lanci. Il rifiuto è dichiarato (429), mai un'attesa
    // silenziosa dentro la route. Le celle non-vl non sono toccate; il clock
    // è il seam cfg.now, i test non dormono.
    if (engine.managed && engine.managed.client === 'vl') {
      const cooldownMs = clampCooldown(cfg.vlLaunchCooldownMs !== undefined
        ? cfg.vlLaunchCooldownMs : VL_LAUNCH_COOLDOWN_DEFAULT_MS);
      const last = vlLastLaunchAt.get(cellId);
      if (cooldownMs > 0 && typeof last === 'number' && cooldownNow() - last < cooldownMs) {
        throw httpError(429,
          `pausa minima fra due lanci della stessa cella vl non trascorsa (${cooldownMs} ms)`,
          null, { phase: 'preflight', code: 'VL_LAUNCH_COOLDOWN' });
      }
    }
    let launchEngine = engine;
    // Generazione del LANCIO: identifica QUESTA partenza della cella. Serve a
    // OGNI famiglia di engine, non solo managed — il canale attivita' e il
    // record terminale sono del supervisore (che esiste per ogni cella), non
    // degli hook del client. Per i managed e' anche la generazione degli hook;
    // per i custom e' l'identita' con cui il supervisore pubblica AVVIO,
    // selettore del lancio e ragione terminale su file.
    const generazione = crypto.randomBytes(8).toString('hex');
    // Canale di attivita' della cella: `resolved` vive solo dentro il ramo
    // managed, e il payload del broker si costruisce FUORI. Portarlo fuori con
    // una variabile dichiarata qui evita di usare, in un ramo, un nome
    // dichiarato in un altro: un errore che in produzione fa fallire il lancio
    // di ogni cella, non una sola asserzione.
    let activityCanale = null;
    // Sessione NUOVA esplicita (contratto vl): il marcatore persistente si
    // consuma qui, atomicamente (rename), PRIMA dello spawn — e una volta
    // sola. Il payload porta la decisione gia' presa (vlNewSession): il
    // supervisore applica --new SOLO alla generazione 0, quindi un suo retry
    // non ripete la rotazione; un restart ordinario non consuma nulla perche'
    // il marcatore non c'e' piu'. Se il lancio fallisce dopo il consumo, il
    // record .consumed resta a dichiarare l'esito incerto: mai un secondo
    // --new automatico.
    let vlNewSessionApplied = false;
    if (engine.managed) {
      // Generazione del lancio: identifica QUESTA partenza della cella. Uno
      // stato di attivita' che ne porta un'altra appartiene a un lancio
      // precedente e viene scartato — una cella riavviata non eredita il
      // «lavora» di prima. (Dichiarata fuori dal ramo: vedi sopra.)
      const resolved = resolveManagedEngine(engine, cell, {
        ...cfg, home, extraModels: extraModelsFrom(defs),
        capabilityProfiles: defs.capabilityProfiles || null,
        activityGeneration: generazione,
        // Stable owner identity for per-cell vl directories: resolved on THIS
        // node (executor), never from a federated viewer.
        vlOwnerInstanceId: typeof identityOwnerInstanceId === 'function'
          ? identityOwnerInstanceId() : identityOwnerInstanceId,
        // La generazione NON si scrive qui: viaggia negli argv degli hook e nel
        // payload del broker, e a scriverla su disco e' `cell-exec`, dentro la
        // sessione che tmux ha appena creato — quindi solo per chi vince la
        // new-session. Chi perde la corsa scriverebbe una generazione che non e'
        // quella di nessun lancio vivo.
      });
      // Il materializzatore MCP per cella e' FAIL-CLOSED: se il file per cella
      // non si scrive, la cella non parte — mai con la superficie intera dove
      // l'operatore l'ha ristretta.
      if (resolved.mcpCellRefused) {
        throw httpError(500, resolved.mcpCellRefused, null, { phase: 'preflight', code: resolved.mcpCellRefusedCode || 'MCP_CELL_FILE_UNWRITABLE' });
      }
      if (!resolved.ok) {
        const code = engine.managed.client === 'shell' ? 'SHELL_NOT_AVAILABLE' : 'ENGINE_UNCONFIGURED';
        throw httpError(400, `engine managed non configurato (${engine.id}): ${resolved.reason}`, null, { phase: 'preflight', code });
      }
      launchEngine = resolved.engine;
      // Qui si porta FUORI dal ramo il solo dato che serve al payload: dove e
      // con quale generazione il supervisore dovra' PUBBLICARLA su disco e
      // dichiarare l'uscita del client.
      if (resolved.activityDir) activityCanale = { dir: resolved.activityDir, generation: generazione };
      // A vl cell whose runtime cannot hold the per-cell prompt
      // (VL_SYSTEM_APPEND_FILE, 0.3.1+) DEGRADES by declaring it — same
      // shape as readinessDegraded: the cell starts without its own identity
      // and the operator sees it (log here + flag in the result, consumed by the UI).
      // Never in silence: a silent start without the prompt is the defect
      // this closes.
      if (launchEngine.vlPromptDegraded) {
        const log = typeof cfg.log === 'function' ? cfg.log : console.warn;
        log(`fleet vl ${cell.id}: ${launchEngine.vlPromptDegraded}`);
      }
      // L'authority e' configurata ma non e' costruibile — il child non
      // partirebbe con un'identita' verificabile, quindi non parte affatto.
      // Prima si esportava REQUIRED=0 con una riga di log: la cella si avviava
      // standalone e il degrado si scopriva solo leggendo il log.
      const refusal = identityLaunchRefusal(launchEngine);
      if (refusal) {
        throw httpError(refusal.status, refusal.message, null,
          { phase: 'preflight', code: refusal.code });
      }
      // Consumo del marcatore «sessione nuova» (solo celle vl): superati i
      // gate di risoluzione, prima del ticket e dello spawn. Un fallimento a
      // valle lascia il record .consumed: l'esito incerto si RIFERISCE, non
      // si ripete. Un albero di stato ostile e' un rifiuto dichiarato, non un
      // lancio senza rotazione richiesta.
      if (engine.managed.client === 'vl') {
        try {
          const consumed = consumeVlNewSession({ home, cellId: cell.id, now: nowMs() });
          if (consumed.consumed) vlNewSessionApplied = true;
        } catch (e) {
          throw httpError(500, `richiesta sessione nuova non consumabile in sicurezza: ${e.message}`,
            null, { phase: 'preflight', code: 'VL_NEW_SESSION_UNSAFE' });
        }
      }
    }

    // Canale attivita' per gli engine a LAUNCHER (custom): la directory e' del
    // supervisore, non degli hook del client — questi engine non ne hanno, ma
    // la dichiarazione di uscita, il selettore del lancio e la ragione
    // terminale su file valgono lo stesso. Stessa directory per sessione che
    // usano gli hook managed (filesRoot/<sessione>): il lettore e' unico.
    // L'opt-out `activityHooks: false` resta dell'operatore e vale per tutti.
    if (!activityCanale && cfg.activityHooks !== false
      && typeof cell.tmuxSession === 'string' && cell.tmuxSession) {
      const activityRoot = filesRootDi(cfg);
      if (activityRoot) activityCanale = { dir: path.join(activityRoot, cell.tmuxSession), generation: generazione };
    }

    // (2) trust del command PRIMA di lanciare
    const trust = validateCommandTrust(launchEngine.command);
    if (!trust.ok) throw httpError(400, `command non trusted (${launchEngine.command}): ${trust.reason}`, null, { phase: 'preflight', code: 'COMMAND_UNTRUSTED' });
    // (3) cwd reale sotto la home
    const realCwd = resolveCwd(cell.cwd, home);
    if (!realCwd) throw httpError(400, `cwd non valida (deve esistere sotto la home): ${cell.cwd}`, null, { phase: 'preflight', code: 'CWD_INVALID' });

    // (3b) AUTORITA' PRIMA, SELETTORE POI. Il REGISTRO del lancio corrente
    // (autorita' di lettura, FUORI dalla directory di sessione: due
    // locazioni indipendenti, primaria + riserva) si committa PRIMA di
    // toccare il selettore: se NESSUNA delle due locazioni accetta la
    // scrittura il lancio e' RIFIUTATO QUI — un'autorita' che non si puo'
    // lasciare in alcun posto durerebbe solo fino al riavvio di questo
    // processo, e il record rimasto su disco (quello del lancio PRECEDENTE)
    // tornerebbe autorevole — e il rifiuto avviene con lo stato visibile del
    // precedente INTATTO: il selettore non e' ancora stato spostato, la sua
    // diagnosi resta coerente e leggibile, ora e dopo un riavvio. Il canale
    // del primo commit e' quello CONSERVATIVO ('none' se il canale attivita'
    // c'e', 'off' se l'operatore l'ha escluso): se la pubblicazione del
    // selettore riesce, un secondo commit porta 'selector'; se quel secondo
    // write fallisce resta 'none', che legge la diagnosi PER IDENTITA' del
    // lancio corrente — comunque corretta, mai il record di un altro lancio.
    // Si scrive per OGNI lancio, anche a canale disattivato: e' il registro
    // del ciclo di vita, non il canale attivita' — porta identita' e stato,
    // mai contenuti, e senza di lui un riavvio non saprebbe che la selezione
    // su disco e' stantia.
    let canaleLancio = 'off';
    if (activityCanale) canaleLancio = 'none';
    if (typeof cell.tmuxSession === 'string' && cell.tmuxSession) {
      const registroRoot = filesRootDi(cfg);
      const log = typeof cfg.log === 'function' ? cfg.log : console.warn;
      if (registroRoot) {
        const esito = { primario: false, riserva: false };
        const registrato = registraLancioCorrente(registroRoot, cell.tmuxSession, {
          launchId: generazione, canale: canaleLancio, ora: nowMs(), esito,
        }) === true;
        if (!esito.primario) {
          log(`nexuscrew fleet: launch registry not written for cell ${cell.id} (primary location; the spare location keeps the current launch identity durable)`);
        } else if (!esito.riserva) {
          log(`nexuscrew fleet: launch registry spare not written for cell ${cell.id}`);
        }
        if (!registrato) {
          throw httpError(500,
            `registro dei lanci non scrivibile per la cella ${cell.id}: nessuna traccia durevole della nuova autorita', lancio rifiutato`,
            null, { phase: 'preflight', code: 'LAUNCH_REGISTRY_UNWRITABLE' });
        }
      } else {
        log(`nexuscrew fleet: launch registry not written for cell ${cell.id} (no files root: terminal diagnosis unavailable across restarts)`);
      }
    }

    // SELETTORE del lancio corrente (`launch-current` = questo lancio) e
    // retention dei record terminali, DOPO il commit dell'autorita'. Il
    // selettore lo pubblica QUI — il proprietario del ciclo di vita, dentro
    // il lock per cella (up e' serializzato per cella) — e NON il
    // supervisore: un cell-exec ritardato di un lancio vecchio non ha in
    // mano la selezione di un lancio nuovo e non puo' spostarla, per
    // costruzione. Pubblicato PRIMA dello spawn: nella transizione la
    // diagnosi e' assente (il lancio nuovo non ha ancora una ragione), mai
    // quella del lancio precedente spacciata per attuale. Selettore non
    // pubblicabile: dichiarazione esplicita e rimozione ONESTA del vecchio,
    // con l'ESITO CONTROLLATO — se anche la rimozione fallisce, il selettore
    // rimasto su disco e' quello del lancio precedente e non verra' MAI
    // mostrato come attuale: lo stato del canale ('none', gia' registrato)
    // lo dice e il lettore non lo tocca. Il lancio non si blocca per questo.
    if (activityCanale) {
      const log = typeof cfg.log === 'function' ? cfg.log : console.warn;
      const pubblicato = pubblicaSelettoreLancio(activityCanale.dir, activityCanale.generation) === true;
      if (pubblicato) {
        canaleLancio = 'selector';
        // Upgrade del canale nel registro, da 'none' a 'selector': il
        // commit dell'autorita' c'e' gia', questo affina COME si legge. Se
        // l'upgrade fallisce (nessuna locazione accetta) resta 'none' —
        // lettura per identita', corretta lo stesso — e il fallimento e'
        // dichiarato: mai un canale preteso che su disco non c'e'.
        const registroRoot = filesRootDi(cfg);
        if (registroRoot && typeof cell.tmuxSession === 'string' && cell.tmuxSession) {
          const esitoUpgrade = {};
          const aggiornato = registraLancioCorrente(registroRoot, cell.tmuxSession, {
            launchId: generazione, canale: 'selector', ora: nowMs(), esito: esitoUpgrade,
          }) === true;
          if (!aggiornato) {
            log(`nexuscrew fleet: launch registry channel not updated for cell ${cell.id} (diagnosis stays bound to the launch identity)`);
          }
        }
      } else {
        log(`nexuscrew fleet: launch selector not published for cell ${cell.id} (terminal diagnosis unavailable)`);
        // Rimozione ONESTA del selettore del lancio precedente, ESITO
        // CONTROLLATO: riuscita = canale pulito (selettore assente);
        // fallita = su disco resta una selezione stantia, che il lettore
        // ignora per costruzione (stato 'none').
        if (rimuoviSelettoreLancio(activityCanale.dir) !== true) {
          log(`nexuscrew fleet: stale launch selector not removable for cell ${cell.id} (previous launch diagnosis not shown)`);
        }
      }
      potaTerminali(activityCanale.dir);
    }
    if (typeof cell.tmuxSession === 'string' && cell.tmuxSession) {
      lanciCorrenti.set(cell.tmuxSession, { launchId: generazione, canale: canaleLancio });
    }

    // (4)+(5) argv diretto (no shell). Every cell goes through the private
    // broker-backed supervisor: credentials never enter tmux state/argv and a
    // client that exits after readiness is restarted with bounded backoff.
    // '-P -F #{pane_id}': tmux stampa il pane id della sessione appena creata,
    // cosi' l'iniezione del prompt bersaglia ESATTAMENTE quel pane (da revisione impl
    // #5: elimina la race di riuso del nome sessione tra waitAlive e paste).
    const readyMs = cfg.launchReadyMs != null ? cfg.launchReadyMs : 500;
    const child = composeClientInvocation(launchEngine, cell);
    let ticket;
    // Punto di impegno del lancio (celle vl): da qui in poi il lancio parte,
    // quindi la pausa minima conta DA ORA. Un fallimento a valle (broker,
    // tmux, readiness) lascia il timestamp: il retry riparte al passo del
    // cooldown, non a raffica — backoff limitato, mai attese arbitrarie.
    if (engine.managed && engine.managed.client === 'vl') {
      vlLastLaunchAt.set(cellId, cooldownNow());
    }
    try {
      let leaseInfo = null;
    if (leaseManager) {
      try { leaseInfo = await leaseManager.track(cell.id); } catch (_) { leaseInfo = null; }
    }
    const identity = identityMode === 'authority' && identityAuthority ? {
      audience: cfg.identityAudience || cfg.fleet?.identity?.audience || 'nexuscrew-lease',
      daemonBootId: identityDaemonBootId,
      connectionId: `${cell.id}-${crypto.randomBytes(8).toString('hex')}`,
      subject: {
        ownerInstanceId: identityOwnerInstanceId,
        cellId: cell.id,
        incarnationId: crypto.randomBytes(16).toString('hex'),
        launchEpoch: leaseInfo ? leaseInfo.launchEpoch : crypto.randomBytes(8).toString('hex'),
      },
    } : undefined;
    if (identity && leaseManager && typeof leaseManager.setLaunchSubject === 'function'
      && leaseManager.setLaunchSubject(cell.id, identity.subject) !== true) {
      throw httpError(500, 'identity launch subject non registrabile', null, {
        phase: 'launch-broker', code: 'IDENTITY_SUBJECT_UNAVAILABLE',
      });
    }
    ticket = await launchBroker.issue({
        command: child.command,
        args: child.args,
        env: {
          ...minimalEnv(),
          ...launchEngine.env,
          MCP_DEVICE: `${String(cell.id).toLowerCase()}-agent`,
          NEXUSCREW_MCP_SESSION: cell.tmuxSession,
        },
        ...(identity ? { identity } : {}),
        // La decisione sul canale viaggia col payload: il supervisore non la
        // ricalcola (era il punto in cui i due potevano divergere).
        ...(typeof launchEngine.identityChannel === 'boolean'
          ? { identityChannel: launchEngine.identityChannel } : {}),
        ...(leaseInfo ? { lease: { cellId: cell.id, launchEpoch: leaseInfo.launchEpoch, stablePath: leaseInfo.stablePath } } : {}),
        // Canale di attivita' verso il supervisore: il riavvio del client
        // avviene DENTRO lo stesso lancio, quindi la generazione non cambia e
        // l'unico modo di invalidare lo stato del client morto e' che sia
        // cell-exec a dichiararlo. Presente solo dove gli hook sono davvero
        // iniettati (`activityDir` lo dice): senza canale non c'e' niente da
        // invalidare.
        ...(activityCanale ? { activity: activityCanale } : {}),
        // Sessione nuova esplicita (vl): la decisione viaggia GIÀ PRESA nel
        // payload, il supervisore non la ricalcola e non rilegge mai il
        // marcatore. cell-exec applica --new SOLO alla generazione 0: i suoi
        // restart usano argv senza --new, quindi la rotazione avviene una
        // volta sola per richiesta.
        ...(vlNewSessionApplied ? { vlNewSession: true } : {}),
        supervise: {
          enabled: !launchEngine.shellOneShot,
          initialReadyMs: Math.max(50, Math.min(30000, Number(readyMs) || 500)),
          restartDelayMs: Math.max(50, Math.min(60000, Number(cfg.cellRestartDelayMs) || 1000)),
          maxRestartDelayMs: Math.max(100, Math.min(300000, Number(cfg.cellMaxRestartDelayMs) || 60000)),
          resetAfterMs: Math.max(1000, Math.min(3600000, Number(cfg.cellRestartResetMs) || 30000)),
          rapidWindowMs: Math.max(1000, Math.min(3600000, Number(cfg.cellRapidWindowMs) || 60000)),
          maxRapidRestarts: Math.max(1, Math.min(100, Number(cfg.cellMaxRapidRestarts) || 8)),
          // Tetto cumulativo di restart del burst (oltre gen0): clamped agli
          // stessi bounds di validSupervise, default 12.
          maxTotalRestarts: Math.max(1, Math.min(200, Number(cfg.cellMaxTotalRestarts) || 12)),
        },
        ...(launchEngine.promptMode === 'send-keys' && cell.prompt ? {
          restartPrompt: {
            tmuxBin,
            tmuxSession: cell.tmuxSession,
            prompt: cell.prompt,
            readyMs: Math.max(0, Math.min(30000, Number(cfg.sendKeysReadyMs) || readyMs)),
            // kimi.* e TUTTE le claude.* hanno la delivery classificata
            // at-most-once ai restart; gli engine custom send-keys conservano
            // il reinject legacy senza Enter (0.8.47).
            client: engine.managed && (engine.managed.client === 'kimi' || engine.managed.client === 'claude')
              ? engine.managed.client : '',
            // Opt-in F4: il supervisore deve applicare lo STESSO contratto ai
            // restart (generazioni > 0). Decide la definizione, non il
            // supervisore: qui viaggia gia' preso.
            ...(launchEngine.submit === 'enter' ? { submit: true } : {}),
            readyWaitMs: Math.max(0, Math.min(120000, Number(cfg.bootstrapReadyWaitMs) || 15000)),
            // Gate readiness MCP solo per le claude.* (budget composto col
            // readyWaitMs: tetto MCP dal launch, avvio degradato visibile).
            ...(engine.managed && engine.managed.client === 'claude' ? {
              mcpReadiness: buildMcpReadinessPayload(cell, realCwd, home, cfg),
            } : {}),
          },
        } : {}),
      });
    } catch (brokerErr) {
      const bmsg = String((brokerErr && brokerErr.message) || brokerErr);
      const bcode = /too large/i.test(bmsg) ? 'LAUNCH_BROKER_PAYLOAD'
        : /closed/i.test(bmsg) ? 'LAUNCH_BROKER_CLOSED'
        : /unsafe launch broker/i.test(bmsg) ? 'LAUNCH_BROKER_UNSAFE'
        : 'LAUNCH_BROKER_FAILED';
      const bpublic = bcode === 'LAUNCH_BROKER_PAYLOAD' ? 'launch broker payload rifiutato'
        : bcode === 'LAUNCH_BROKER_CLOSED' ? 'launch broker non disponibile'
        : bcode === 'LAUNCH_BROKER_UNSAFE' ? 'launch broker non sicuro'
        : 'launch broker failed';
      throw httpError(500, bpublic, null, { phase: 'launch-broker', code: bcode });
    }
    const tmuxLaunchEngine = {
      command: process.execPath,
      args: [path.join(__dirname, 'cell-exec.js'), '--socket', ticket.socketPath, '--nonce', ticket.nonce],
      env: {}, promptMode: 'managed-argv',
    };
    const tmuxChild = composeClientInvocation(tmuxLaunchEngine, cell);

    // Staged start: creates the pane with a trusted inert placeholder
    // (cell-hold.js), arms window-local remain-on-exit on the @N, then
    // respawn-pane -k to cell-exec on the exact %N. So remain-on-exit is already
    // ON when the real child can terminate: no vanished window, no
    // NEW_SESSION_FAILED masking the real exit.
    // per id puntati, definitions.js); gli step critici usano gli ID restituiti
    // da tmux ($N/@N/%N). respawn-pane -k preserva il pane ID: il %N catturato
    // qui resta valido per readiness e prompt. Nessuna shell string, nessun
    // command/env/prompt del child nell'argv tmux (solo cell-hold, poi cell-exec
    // via broker). Nessun sleep come sincronizzazione.
    const CELL_HOLD = path.join(__dirname, 'cell-hold.js');
    const create = await tmuxExec(tmuxBin,
      ['new-session', '-d', '-s', cell.tmuxSession, '-c', realCwd,
        '-P', '-F', '#{session_id}\t#{window_id}\t#{pane_id}',
        process.execPath, CELL_HOLD],
      { env: minimalEnv() });
    if (create.err) {
      // new-session fallita: nessuna sessione creata. Revoca il ticket (il child
      // non partira' mai) prima di propagare l'errore.
      try { await launchBroker.revoke?.(ticket.nonce); } catch (_) { /* best-effort */ }
      // Redaction: the tmux stderr can echo argv/env of the launched command.
      const dup = /duplicate session/i.test(create.stderr);
      const why = dup
        ? 'sessione già in esecuzione'
        : `tmux new-session failed: ${redactSecrets(create.stderr.trim() || create.err.message, launchEngine, cell)}`;
      throw httpError(dup ? 409 : 500, why, null,
        { phase: 'new-session', code: dup ? 'SESSION_DUPLICATE' : 'NEW_SESSION_FAILED' });
    }
    // Il pane del SUPERVISORE si marca ORA, sul pane che esegue cell-exec: e'
    // l'identita' stabile della cella viva. Il server cerca questo marcatore
    // (`list-panes`) perche' `#{pane_dead}` di list-sessions riguarda il pane
    // ATTIVO — con una seconda finestra viva selezionata direbbe «vivo» anche
    // con il supervisore morto. L'id ce l'abbiamo gia' da `-P -F` (sotto), non
    // serve una ricerca. Best effort come le opzioni che seguono: un tmux che
    // non accetta l'opzione non deve impedire l'avvio — la cella resta senza
    // marcatore, e per lei il server dira' «non verificato» invece di leggere
    // uno stato di cui non sa identificare il supervisore.
    const idPaneLancio = /^%[0-9]+$/.test((create.stdout.trim().split('\n')[0] || '').split('\t')[2] || '')
      ? (create.stdout.trim().split('\n')[0] || '').split('\t')[2] : '';
    if (idPaneLancio) {
      const marcato = await tmuxExec(tmuxBin,
        ['set-option', '-p', '-t', idPaneLancio, NC_SUPERVISOR_OPT, '1'],
        { env: minimalEnv(), timeoutMs: 2000 });
      if (marcato.err) {
        const log = typeof cfg.log === 'function' ? cfg.log : console.warn;
        log(`fleet marcatore del pane supervisore non impostato per ${cell.id}; la cella resta non identificabile`);
      }
    }
    // Best effort per la sola sessione appena creata: non tocchiamo mai
    // ~/.tmux.conf, opzioni globali o sessioni preesistenti. Un tmux che non
    // accetta una delle opzioni non deve impedire l'avvio della cella.
    const alternateSteps = alternateScreenArgs(cell.tmuxSession, cfg.alternateScreen);
    if (alternateSteps) {
      for (const args of alternateSteps) {
        const configured = await tmuxExec(tmuxBin, args, { env: minimalEnv(), timeoutMs: 2000 });
        if (configured.err) {
          const log = typeof cfg.log === 'function' ? cfg.log : console.warn;
          log(`fleet alternate-screen setup failed for ${cell.id}; continuing`);
        }
      }
    }
    const createdIds = create.stdout.trim().split('\n')[0].split('\t');
    const sessionId = /^\$[0-9]+$/.test(createdIds[0] || '') ? createdIds[0] : '';
    const windowId = /^@[0-9]+$/.test(createdIds[1] || '') ? createdIds[1] : '';
    const paneId = /^%[0-9]+$/.test(createdIds[2] || '') ? createdIds[2] : '';
    const resolveSessionIdForCleanup = async () => {
      if (sessionId) return sessionId;
      // Output parziale anomalo: risali al $N da un @N/%N gia restituito. Come
      // ultima recovery enumera id+nomi e usa il nome safe solo per SELEZIONARE
      // l'id; kill-session non torna mai al target nominale richiesto.
      for (const target of [paneId, windowId]) {
        if (!target) continue;
        const shown = await tmuxExec(tmuxBin,
          ['display-message', '-p', '-t', target, '#{session_id}'],
          { env: minimalEnv(), timeoutMs: 2000 });
        const resolved = shown.stdout.trim();
        if (!shown.err && /^\$[0-9]+$/.test(resolved)) return resolved;
      }
      const listed = await tmuxExec(tmuxBin,
        ['list-sessions', '-F', '#{session_id}\t#{session_name}'],
        { env: minimalEnv(), timeoutMs: 2000 });
      if (listed.err) return '';
      for (const line of listed.stdout.split('\n')) {
        const [sid, name] = line.split('\t');
        if (name === cell.tmuxSession && /^\$[0-9]+$/.test(sid || '')) return sid;
      }
      return '';
    };
    const cleanupLaunch = async () => {
      const stableSessionId = await resolveSessionIdForCleanup();
      if (stableSessionId) {
        await tmuxExec(tmuxBin, ['kill-session', '-t', stableSessionId],
          { env: minimalEnv(), timeoutMs: 2000 });
      }
      try { await launchBroker.revoke?.(ticket.nonce); } catch (_) { /* best-effort */ }
    };
    if (!sessionId || !windowId || !paneId) {
      await cleanupLaunch();
      throw httpError(500, 'tmux new-session: ID sessione/finestra/pane non restituito', null,
        { phase: 'new-session', code: 'NEW_SESSION_FAILED' });
    }
    // Arma remain-on-exit window-local sul @N: la finestra esiste (il placeholder
    // la tiene viva), quindi niente race con un child che termini nel frattempo.
    const arm = await tmuxExec(tmuxBin,
      ['set-option', '-w', '-t', windowId, 'remain-on-exit', 'on'],
      { env: minimalEnv() });
    if (arm.err) {
      await cleanupLaunch();
      throw httpError(500,
        `tmux set-option remain-on-exit failed: ${redactSecrets(arm.stderr.trim() || arm.err.message, launchEngine, cell)}`,
        null, { phase: 'new-session', code: 'NEW_SESSION_FAILED' });
    }
    // Sostituisci il placeholder con il vero child (cell-exec via broker) sul %N.
    const respawn = await tmuxExec(tmuxBin,
      ['respawn-pane', '-k', '-c', realCwd, '-t', paneId, tmuxChild.command, ...tmuxChild.args],
      { env: minimalEnv() });
    if (respawn.err) {
      // respawn failed after issue(): the nonce must be revoked/consumed first
      // before surfacing the error, then cleanup of the panel session.
      await cleanupLaunch();
      throw httpError(500,
        `tmux respawn-pane failed: ${redactSecrets(respawn.stderr.trim() || respawn.err.message, launchEngine, cell)}`,
        null, { phase: 'new-session', code: 'NEW_SESSION_FAILED' });
    }

    // `tmux new-session -d` can return 0 even when the launched CLI exits a
    // moment later (missing login, bad model, incompatible provider).  Without
    // this readiness gate the PWA reported success and then showed nothing.
    // Always verify liveness, including cells without a system prompt.

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
      await cleanupLaunch();
      cache = { ...cache, at: 0 };
      // Un command Shell completato rapidamente con exit 0 e' un one-shot
      // riuscito. Qualunque altro exit immediato e' invece osservabile come
      // errore strutturato: prima il runtime restituiva un falso successo e
      // scartava proprio l'exit 127/diagnostica che servivano all'operatore.
      if (launchEngine.shellOneShot && readiness.status === 0) {
        return {
          ok: true, cell: cellId, session: cell.tmuxSession, prompt: null,
          oneShot: true, active: false, completed: true, exitCode: 0,
        };
      }
      const client = path.basename(launchEngine.clientBinary || launchEngine.command || 'client');
      const status = Number.isInteger(readiness.status) ? ` (exit ${readiness.status})` : '';
      if (launchEngine.shellOneShot) {
        throw httpError(500,
          `comando Shell terminato subito${status}: ${diagnostic || 'verifica command, PATH e configurazione della shell'}`,
          null, { phase: 'readiness', code: 'SHELL_COMMAND_FAILED' });
      }
      // Cause-preserving: distinguish a cell-client spawn failure (the
      // captured pane carries the stable 'cell spawn failed:' marker produced by
      // cell-exec.js) from a generic early exit. Both stay on the readiness
      // surface; the spawn branch keeps CELL_SPAWN_FAILED sanitized downstream.
      const isSpawn = /cell spawn failed:/.test(diagnostic);
      throw httpError(500, `client ${client} terminato subito${status}: ${diagnostic || 'verifica login, provider, modello e argomenti dell\'engine'}`, null,
        isSpawn ? { phase: 'spawn-client', code: 'SPAWN_CLIENT_FAILED' } : { phase: 'readiness', code: 'CLIENT_EARLY_EXIT' });
    }
    if (readiness.target) {
      await tmuxExec(tmuxBin,
        ['set-option', '-w', '-t', readiness.target, 'remain-on-exit', 'off'], { env: minimalEnv(), timeoutMs: 2000 });
    }

    // Content-readiness vl (marcatore [o] nel pane). MAI fail-closed: se
    // entro il timeout il marcatore non compare DEGRADA e procede come se pronta
    // (una cella che parte oggi deve partire anche domani), lasciando traccia
    // nel risultato. vlPaneReadiness e' il punto di innesto sostituibile quando
    // la readiness si misurera' sul socket (adapter), non sul pane. Solo vl: gli
    // altri client non hanno content-readiness da pane.
    let readinessDegraded = false;
    if (engine.managed && engine.managed.client === 'vl' && readiness.target) {
      const vlReady = await vlPaneReadiness(tmuxBin, readiness.target, { env: minimalEnv() });
      if (vlReady.degraded) readinessDegraded = true;
    }

    // Il command Shell e' partito ed e' ancora vivo dopo la finestra di
    // readiness: la cella deve risultare attiva (per CLI interattive come agy),
    // poi tornera' inattiva quando il processo terminera' naturalmente.
    if (launchEngine.shellOneShot) {
      cache = { ...cache, at: 0 };
      return {
        ok: true, cell: cellId, session: cell.tmuxSession, prompt: null,
        oneShot: true, active: true, completed: false,
      };
    }

    // (6) prompt: two distinct paths (0.8.47, single-owner).
    //  - managed kimi.native / claude.kimi-code: la consegna e' posseduta SOLO
    //    dal supervisore (cell-exec) per TUTTE le generazioni; qui si legge
    //    l'esito bounded (@nc_delivery sul pane) con attesa bounded. Mai paste/
    //    Enter dal runtime: niente doppia delivery se gen0 muore durante
    //    l'attesa e gen1 parte sotto il supervisore.
    //  - engine custom con opt-in `submit: 'enter'`: STESSO proprietario del
    //    bootstrap classificato (il supervisore, per tutte le generazioni):
    //    qui si legge solo l'esito bounded, mai un paste dal runtime.
    //  - engine custom promptMode 'send-keys' senza opt-in: injectPrompt legacy
    //    (bracketed paste SENZA Enter, contratto invariato), target %N esatto.
    let prompt = null;
    let actionRequired = null;
    let mcpDegraded = null;
    if (launchEngine.promptMode === 'send-keys' && cell.prompt) {
      const managedClient = engine.managed && typeof engine.managed.client === 'string' ? engine.managed.client : '';
      const managedProvider = engine.managed && typeof engine.managed.provider === 'string' ? engine.managed.provider : '';
      const classified = managedClient === 'kimi' || managedClient === 'claude';
      // Anche l'opt-in `submit: 'enter'` e' consegnato dal SUPERVISORE per
      // tutte le generazioni, la 0 compresa. Qui si legge solo l'esito bounded
      // dal pane: niente paste e niente Enter dal runtime, quindi niente
      // secondo proprietario e niente delivery vecchia che sopravvive a un
      // restart sullo stesso %N.
      const submitOptIn = launchEngine.submit === 'enter';
      if (classified || submitOptIn) {
        const readyWaitMs = Math.max(0, Math.min(120000, Number(cfg.bootstrapReadyWaitMs) || 15000));
        // Budget unico composto — il report copre anche il tetto MCP del
        // gate (l'attesa MCP consuma lo stesso orologio del launch).
        const mcpBudgetMs = classified && managedClient === 'claude'
          ? Math.max(0, Math.min(120000, Number(cfg.mcpReadyBudgetMs) || MCP_BUDGET_DEFAULT_MS))
          : 0;
        const reportWaitMs = Math.max(100, Math.min(150000,
          (Number(cfg.sendKeysReadyMs) || readyMs) + readyWaitMs + mcpBudgetMs + 2000));
        const report = await waitDeliveryReport(tmuxBin,
          paneId.startsWith('%') ? paneId : `=${cell.tmuxSession}`,
          { env: minimalEnv(), timeoutMs: reportWaitMs });
        const delivery = report || {
          delivered: false, state: 'report-timeout', notReady: '', attempts: 0, reason: 'report-timeout',
        };
        prompt = {
          injected: delivery.delivered,
          delivered: delivery.delivered,
          state: delivery.state,
          reason: delivery.reason,
          ...(delivery.mcp ? { mcp: delivery.mcp } : {}),
        };
        // actionRequired e' del classifier kimi/claude (dialoghi nel terminale):
        // per un engine custom non esiste un kind, e inventarne uno sarebbe
        // una diagnosi finta.
        actionRequired = classified ? actionRequiredFor(managedClient, managedProvider, delivery) : null;
        // Avvio degradato visibile: l'elenco bounded dei server MCP non pronti
        // sale alla UI con il flag esistente readinessDegraded.
        if (delivery.mcp && delivery.mcp.state === 'degraded') {
          mcpDegraded = {
            failed: Array.isArray(delivery.mcp.failed) ? delivery.mcp.failed : [],
            pending: Array.isArray(delivery.mcp.pending) ? delivery.mcp.pending : [],
          };
        }
      } else {
        const target = paneId.startsWith('%') ? paneId : `=${cell.tmuxSession}`;
        prompt = await injectPrompt(tmuxBin, cell.tmuxSession, cell.prompt, {
          env: minimalEnv(),
          readyMs: cfg.sendKeysReadyMs != null ? cfg.sendKeysReadyMs : readyMs,
          target,
          engine: launchEngine, cell, // to redact the reason if the paste-buffer fails
        });
      }
    }
    cache = { ...cache, at: 0 };              // invalida: prossimo status rilegge tmux
    return {
      ok: true, cell: cellId, session: cell.tmuxSession, prompt,
      ...(actionRequired ? { actionRequired } : {}),
      ...(readinessDegraded ? { readinessDegraded: true } : {}),
      ...(mcpDegraded ? { readinessDegraded: true, mcpDegraded } : {}),
      // Per-cell prompt not delivered to a vl cell (old runtime or
      // unwritable file). Strict boolean like readinessDegraded: the
      // payload may come from a federated node and the text is local i18n.
      ...(launchEngine.vlPromptDegraded ? { vlPromptDegraded: true } : {}),
      // Sessione nuova esplicita applicata a QUESTO lancio (generazione 0).
      ...(vlNewSessionApplied ? { vlNewSession: true } : {}),
    };
  }

  async function down(cellId /* , opts */) {
    if (readonly()) throw httpError(403, 'READONLY: down bloccato');
    if (typeof ensureProtection === 'function') await ensureProtection();
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
    status, cellStatus, up, down, restart, isCellSession,
    reloadDefs, cachedDefs, findCell, findEngine, refreshSessions, commitDefs,
  };
}

module.exports = { createBuiltinRuntime, findCell, findEngine, identityLaunchRefusal, STATUS_TTL_MS, buildMcpReadinessPayload, cellMcpExpectedServers };
