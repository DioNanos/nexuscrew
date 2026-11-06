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
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  loadDefinitions, validateCommandTrust, resolveCwd, leggiStarttimeProc,
  leggiIdentitaProc, isVlNewSessionSupported,
} = require('./definitions.js');
const aiDesktop = require('./ai-desktop.js');
const {
  describeManaged, resolveManagedEngine, discoverOllamaModels, discoverPiModels, extraModelsFrom,
  knownMcpServerNames, filesRootDi, vlCellBaseDir,
} = require('./managed.js');
const { sharedProbe: defaultEndpointProbe } = require('./endpoint-probe.js');
const { NC_SUPERVISOR_OPT } = require('../tmux/supervisor-pane.js');
const { sharedTmuxSocketPath, baseEreditataCella } = require('../runtime/env.js');
const {
  httpError, minimalEnv, tmuxExec,
  composeClientInvocation, alternateScreenArgs,
  waitAlive, waitStablePane, injectPrompt,
  redactSecrets, sanitizeEarlyDiagnostic,
} = require('./launch.js');
const {
  actionRequiredFor, vlPaneReadiness,
} = require('./prompt-delivery.js');
const { consumeVlNewSession, vlNewSessionStatus, verifyLauncherCaps } = require('./vl-session.js');
const { decideVlBootstrap } = require('./vl-bootstrap-claim.js');

// Outcome of the initial vl prompt delivery, carried IN the up() result and
// derived from the supervisor's bounded report (state and reason are kept,
// notReady included). Closed-enum states:
//   'submitted'     — paste+Enter riusciti (solo trasporto, non esecuzione);
//   'skipped'       — skip NORMALE: respawn/riattacco nello stesso avvio
//                     (generation > 0). Non genera mai un avviso;
//   'not-delivered' — il primo prompt di QUESTO avvio NON è stato consegnato
//                     (claim non presa/non valida): da segnalare;
//   'failed'        — consegna fallita con certezza prima del paste (TUI non
//                     pronta compresa, con notReady bounded);
//   'uncertain'     — paste forse avvenuto o esito non ricevuto: da segnalare.
// Il recupero per not-delivered/failed/uncertain è RIAVVIARE la cella: un
// avvio nuovo porta una consegna nuova, mai un reinvio nello stesso avvio.
// Proiezione bounded dell'esito CANONICO nell'input dei vecchi adattatori
// (actionRequiredFor / vlBootstrapOutcomeFor): stessi enum e slug, nessuna
// seconda tabella del trasporto. `pending` e `unknown` senza esito non
// producono nulla: nessun bootstrap «fallito» inventato.
function consegnaDaCanonico(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.state === 'submitted') return { delivered: true, state: 'submitted' };
  if (d.state === 'skipped') {
    const reason = typeof d.reason === 'string' ? d.reason : '';
    if (reason.startsWith('vl-bootstrap-')) {
      return { delivered: false, state: 'skipped-vl-bootstrap', notReady: reason.slice('vl-bootstrap-'.length) };
    }
    if (reason === 'not-ready' || reason === 'deadline-exceeded' || reason.startsWith('not-ready-')) {
      const kind = d.notReady || (reason.startsWith('not-ready-') ? reason : '');
      return {
        delivered: false,
        state: reason === 'deadline-exceeded' ? 'skipped-unknown' : 'skipped-not-ready',
        ...(kind ? { notReady: kind } : {}),
      };
    }
    return { delivered: false, state: reason === 'cancelled-pre-paste' ? 'cancelled' : reason };
  }
  if (d.state === 'unknown') {
    const reason = typeof d.reason === 'string' ? d.reason : '';
    if (reason === 'paste-only-no-enter') return { delivered: false, state: 'paste-delivered' };
    if (['delivery-unknown', 'staged-not-submitted', 'report-timeout', 'claim-settle-failed'].includes(reason)) {
      return { delivered: false, state: reason };
    }
  }
  return null;
}

function vlBootstrapOutcomeFor(delivery) {
  const state = delivery && typeof delivery.state === 'string' ? delivery.state : '';
  const notReady = delivery && typeof delivery.notReady === 'string' ? delivery.notReady : '';
  if (state === 'skipped-vl-bootstrap') {
    return notReady === 'generation'
      ? { state: 'skipped', reason: 'generation' }
      : { state: 'not-delivered', reason: notReady || 'no-proof' };
  }
  if (state === 'submitted') return { state: 'submitted' };
  if (state === 'delivery-unknown' || state === 'staged-not-submitted' || state === 'report-timeout'
    || state === 'claim-settle-failed') {
    return { state: 'uncertain', reason: state };
  }
  if (state) return { state: 'failed', reason: state, ...(notReady ? { notReady } : {}) };
  return null;
}

// has-session in SOLA LETTURA: l'unico esito che PROVA l'assenza della
// sessione e' quello con cui tmux dichiara una sessione inesistente — exit 1
// con il proprio messaggio «can't find session» (o «no server running»,
// l'equivalente gia' in uso in lifecycle/list). Timeout ed errori di
// esecuzione (kill, exit diverso, stderr sconosciuto, API rifiutata) NON
// sono prove: una lettura fallita non conta come prova riuscita e l'assenza
// resta non dichiarabile.
const ASSENZA_SESSIONE_RE = /can't find session|no server running/i;
function esitoAssenzaSessione(r) {
  return !!(r && r.err
    && r.err.killed !== true
    && r.code === 1
    && ASSENZA_SESSIONE_RE.test(String(r.stderr || '')));
}

// Attestazione dell'assenza della sessione SUL canale di controllo posseduto:
// la gemella del canale di esitoAssenzaSessione (CLI). Solo il verdetto
// SPECIFICO di has-session sul target richiesto («can't find session: $N»,
// marcato `assente` dal canale) prova l'assenza. La sola MORTE del client non
// attesta niente — EOF, timeout e sostituzione del server sono indistinguibi-
// li dalla fine della sessione, e nessuna correlazione temporale li distingue
// — e un errore generico del comando e' un comando fallito, non un verdetto.
// Nel dubbio: false, e il giudizio resta al censimento / STOP_UNKNOWN.
// Mai un client nuovo per «rivedere»: il canale e' quello posseduto o niente.
function attestazioneAssenzaCanale(canale, sessionId) {
  if (!canale || typeof canale.morto !== 'function' || canale.morto()) {
    return Promise.resolve(false);
  }
  if (typeof canale.hasSession !== 'function') return Promise.resolve(false);
  return Promise.resolve()
    .then(() => canale.hasSession(sessionId))
    .then((has) => !!(has && has.assente === true))
    .catch(() => false);
}

const {
  pubblicaSelettoreLancio, rimuoviSelettoreLancio, potaTerminali,
  registraLancioCorrente, leggiLancioCorrente, leggiDiagnosiTerminaleCorrente,
  leggiEsitoPromptCorrente, esitoPromptEPersistito,
} = require('../files/activity.js');
const { composePromptDeliveryQualified, promptDeliveryApplicable } = require('./prompt-outcome.js');
const launchTarget = require('./launch-target.js');
const launchWriterLock = require('./launch-writer-lock.js');
// Catene di serializzazione del ciclo di vita, condivise da TUTTI i runtime del processo.
const catenePerRadiceCella = new Map();
let contatoreRuntime = 0;
const { valutaLancio } = require('./launch-reconcile.js');
const tmuxControl = require('./tmux-control.js');
const {
  attendiFermataGruppo, attendiPreparazione, esitoGruppoPulito, codiceEsito,
  leggiPgrp, osservaGruppoDopoUscita,
} = require('./group-stop.js');
const { radiceServer, riserva, rilascia, qualificaAssenzaRadice, qualificaRadiceInLettura, osservaClaim, stessaImprontaRadice } = require('./vl-roots.js');
const vlHostStop = require('./vl-host-stop.js');
const {
  scriviContesto, pinBinario, verificaPin, fermaHost, leggiContesto, dirPin, contestoIniziale,
  qualificaIsolamentoHost, verificaCapacitaPeerStop, envDalRecord,
  registraIdentitaPeer, profiloDaArgv, ESITI_STOP_ATTESO: ESITI_STOP_ATTESTATI,
} = require('./vl-host-stop.js');

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

// Motivi bounded dell'uscita non provata: quelli che il manager puo' dire.
// Un valore fuori elenco non passa: diventa il valore fisso, cosi' il `data`
// del rifiuto non porta mai testo libero.
const MOTIVI_USCITA = new Set([
  'sessione', 'launch', 'pid', 'proc', 'starttime', 'canale', 'scaduta', 'errore', 'non-provata',
]);
function motivoUscitaBounded(v) {
  return typeof v === 'string' && MOTIVI_USCITA.has(v) ? v : 'non-provata';
}

function createBuiltinRuntime(ctx) {
  const {
    cfg, home, defsPath, tmuxBin, readonly, launchBroker, leaseManager, boot, ensureProtection,
    identityAuthority = null, identityMode = 'legacy', identityOwnerInstanceId = null,
    // Seam di test della lettura TERNARIA dell'identita' del supervisore nel
    // recupero a tre prove del down: la produzione legge /proc (definitions).
    leggiIdentitaProc: identitaProcSeam = leggiIdentitaProc,
    // Seam NUMERICO della nascita (leggiStarttimeProc -> number|null), distinto
    // dalla lettura TERNARIA qui sopra: l'attestazione di sola lettura confronta
    // numeri, e passarle un oggetto la fa rifiutare sempre.
    leggiStarttimeProc: starttimeSeam = leggiStarttimeProc,
    attestaAssenzaNuovaConnessione: attestaSeam = tmuxControl.attestaAssenzaNuovaConnessione,
  } = ctx;
  const identityDaemonBootId = cfg.identityDaemonBootId || crypto.randomBytes(16).toString('hex');
  if (cfg && !cfg.filesRoot && typeof home === 'string' && home) {
    cfg.filesRoot = path.join(home, 'NexusFiles');
  }
  let cache = { at: 0, defs: boot, sessions: new Set() };

  // --- Serializzazione dei lanci per cella (contratto vl, generale) ----------
  // Due up() concorrenti della STESSA cella si serializzano su una catena di
  // promise: il secondo vede lo stato lasciato dal primo (sessione viva ->
  // 409 di preflight) invece di correre contro di lui sulla new-session. Il
  // 409 resta la rete finale; il lock toglie la corsa. Celle diverse non si
  // toccano. La mappa vive nel runtime (per processo): i nodi non condividono
  // lanci, quindi non c'è niente da coordinare fuori processo.
  // R3: l'esclusione del ciclo di vita e' per PROCESSO, chiave radice dei file
  // + cella: due runtime dello stesso processo sulla stessa radice e cella si
  // mettono in fila come due richieste dello stesso runtime (il lock di
  // scrittore su file conta i possessori ma non serializza le operazioni).
  // Senza radice dei file la chiave resta privata del runtime.
  const tagRuntimePrivato = `privato-${++contatoreRuntime}`;
  const chiaveCiclo = (cellId) => {
    const radice = filesRootDi(cfg);
    return `${radice ? path.resolve(radice) : tagRuntimePrivato}\0${cellId}`;
  };
  const launchLocks = {
    get: (cellId) => catenePerRadiceCella.get(chiaveCiclo(cellId)),
    set: (cellId, v) => catenePerRadiceCella.set(chiaveCiclo(cellId), v),
    delete: (cellId) => catenePerRadiceCella.delete(chiaveCiclo(cellId)),
  };
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
  // Connessioni di controllo tmux possedute dai lanci VIVI di questo processo
  // una per sessione di cella, aperta ALLA CREAZIONE
  // e tenuta fino al teardown. Chiave = sessione tmux della cella. Un down
  // senza canale in questa mappa non ha continuita' dimostrabile con il
  // server della creazione: identita' non verificabile, nessuna azione.
  const canaliControllo = new Map();
  // Sessioni il cui teardown e' finito in esito INDETERMINATO in QUESTO
  // processo e la cui persistenza del marker incerto non e' dimostrata
  // (scrittura fallita o root assente). E' la guardia che non dipende dal
  // marker appena mancato: finche' la sessione e' qui dentro, un nuovo up e'
  // rifiutato anche se il record su disco non porta il flag. Recovery durevole:
  // un down che si conclude pulito (o che trova il lancio gia' risolto fuori
  // banda, record assente) svuota la guardia; senza di cio' resta bloccante
  // per la vita del processo.
  const esitiIncerti = new Set();

  // UN SOLO writer del runtime per filesRoot. Il confronto del record per
  // sha256 al commit della riconciliazione non e' una compare-and-swap
  // atomica: il vincolo che lo rende sufficiente e' questo lock di scrittore
  // (lib/fleet/launch-writer-lock.js), preso alla prima mutazione e rilasciato
  // allo shutdown. Un secondo processo NC sulla stessa radice si ferma.
  let scrittoreToken = null;
  function assicuraScrittore(fase) {
    const radice = filesRootDi(cfg);
    if (!radice) return;
    // Il possesso si RIVERIFICA a ogni mutazione: il token in memoria non
    // basta se il file su disco non e' piu' il nostro.
    if (scrittoreToken) {
      if (launchWriterLock.verifica(radice, scrittoreToken)) return;
      throw httpError(409,
        `il lock di scrittore dei lanci non e' piu' nostro (${fase} rifiutato)`,
        null, { phase: fase, code: 'STOP_UNKNOWN' });
    }
    const r = launchWriterLock.acquisisci(radice);
    if (!r.ok) {
      throw httpError(409,
        `un altro processo NC scrive i lanci su questa radice dei file (${r.codice}): ${fase} rifiutato`,
        null, { phase: fase, code: 'STOP_UNKNOWN' });
    }
    scrittoreToken = r.token;
  }
  // Un commit di riconciliazione rimasto a meta' (journal sul disco) si
  // completa PRIMA di qualunque altra cosa; finche' non e' completato nessun
  // lancio puo' partire.
  function completaCommitPendente(cell, fase) {
    const radice = filesRootDi(cfg);
    if (!radice) return;
    const r = launchTarget.completaCommit(radice, cell.tmuxSession);
    if (r.stato === 'bloccato') {
      esitiIncerti.add(cell.tmuxSession);
      throw httpError(409,
        `commit di riconciliazione incompleto per la cella ${cell.id} (${r.codice}): nessun lancio finche' non e' completato`,
        null, { phase: fase, code: 'STOP_UNKNOWN' });
    }
    if (r.stato === 'completato') esitiIncerti.delete(cell.tmuxSession);
  }
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
    if (r.err) {
      // nessun server / nessuna sessione. L'insieme vuoto e' CONCLUSIVO solo
      // quando tmux lo dice ("no server running" / "no sessions"): ogni altro
      // errore e' una lettura non conclusiva, che non prova la chiusura di
      // nessun lancio.
      const vuoto = new Set();
      // Solo l'assenza ESPLICITA di tmux, con uscita 1 non interrotta: un
      // permesso negato, un timeout o una lettura interrotta non sono una
      // chiusura, nemmeno se il messaggio nomina «error connecting to».
      const testo = String(r.stderr || '');
      vuoto.conclusivo = r.code === 1 && !(r.err && r.err.killed === true)
        && (/no server running|no sessions/i.test(testo)
          || /error connecting to .*\(No such file or directory\)/i.test(testo));
      return vuoto;
    }
    const set = new Set();
    set.conclusivo = true;
    for (const line of r.stdout.split('\n')) {
      const [rawName, rawWindows] = line.split('\t');
      const n = String(rawName || '').trim();
      const windows = rawWindows === undefined ? 1 : Number(rawWindows);
      if (n && Number.isFinite(windows) && windows > 0) set.add(n);
    }
    return set;
  }

  // La VISTA delle sessioni attive aggiunge a list-sessions le sessioni
  // POSSEDUTE da questa istanza. Le celle lanciate qui vivono sul server
  // condiviso, che il listing di default vede gia' da solo; l'unione coi
  // canali posseduti resta come CINTURA (una sessione appena creata ma non
  // ancora elencata, un listing rifiutato). La prova posseduta e' il canale
  // di controllo: il client e' attaccato alla sessione e uscirebbe con lei,
  // quindi un canale VIVO e' la sessione viva — nessun client nuovo per
  // «rivederla». Solo per la visibilita' (status): il gate anti-duplicato
  // del preflight resta sulla fonte list-sessions, il contratto «un up
  // successivo rilancia» non cambia.
  async function refreshSessionsVisibili() {
    const set = await refreshSessions();
    for (const [sessionePosseduta, canale] of canaliControllo) {
      if (canale && !canale.morto()) set.add(sessionePosseduta);
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
  // ── Osservatore diagnostico del terminale della consegna (strato 2c) ──────
  //
  // READ-ONLY e abortibile, per il lancio appena creato. Parte DOPO che `up`
  // ha risposto (la risposta non dipende mai da lui), fuori dal lock per cella,
  // in-process. Poll bounded con lo stesso compositore di cellStatus; si ferma
  // al primo terminale PERSISTITO dal proprietario, al tetto monotono ancorato
  // al lancio, o a qualunque cambio di lancio / generazione / abort. Un solo
  // evento terminale per ciclo osservato; mai ricreato da una GET o dal
  // riavvio del demone; nessun evento per poll. Il tetto consumato = nessun
  // evento (lo stato derivato resta leggibile dal record).
  const PROMPT_OBSERVER_POLL_MS = 500;
  const PROMPT_OBSERVER_DEDUP_MAX = 8;
  const osservatori = new Map();        // cellId -> controller del ciclo corrente
  // Epoca di chiusura del runtime: shutdown la avanza; un lancio che l'ha
  // catturata all'inizio non registra ne' avvia piu' osservatori dopo di lei
  // (copre anche il controller non ancora registrato e le callback gia'
  // schedulate).
  let epocaRuntime = 0;
  const terminaliEmessi = new Map();    // cellId -> chiavi (cella|lancio|generazione), bounded

  function abortaOsservatore(cellId) {
    const ctrl = osservatori.get(cellId);
    if (!ctrl) return;
    ctrl.abortato = true;
    osservatori.delete(cellId);
    if (ctrl.timer) { clearTimeout(ctrl.timer); ctrl.timer = null; }
    if (ctrl.sveglia) { const r = ctrl.sveglia; ctrl.sveglia = null; r(); }
  }

  function abortaTuttiGliOsservatori() {
    for (const cellId of [...osservatori.keys()]) abortaOsservatore(cellId);
  }

  function creaOsservatore({ cellId, sessione, ancora, tettoMs, epoca }) {
    if (epoca !== epocaRuntime) return null;   // shutdown intervenuto durante il lancio
    abortaOsservatore(cellId);            // un solo ciclo per cella
    const ctrl = {
      cellId, sessione, ancora, tettoMs, epoca, abortato: false, avviato: false,
      timer: null, sveglia: null, generazione: null,
      launchId: (lanciCorrenti.get(sessione) || {}).launchId || null,
    };
    osservatori.set(cellId, ctrl);
    return ctrl;
  }

  function attendiOsservatore(ctrl, ms) {
    if (typeof cfg.sleepImpl === 'function') return Promise.resolve(cfg.sleepImpl(ms)).catch(() => {});
    return new Promise((resolve) => {
      ctrl.sveglia = resolve;
      ctrl.timer = setTimeout(() => { ctrl.timer = null; ctrl.sveglia = null; resolve(); }, ms);
      if (ctrl.timer && typeof ctrl.timer.unref === 'function') ctrl.timer.unref();
    });
  }

  function emettiTerminalePrompt(cellId, out) {
    const d = out.delivery;
    const chiave = `${cellId}|${d.launchId}|${d.generation}`;
    let visti = terminaliEmessi.get(cellId);
    if (!visti) { visti = []; terminaliEmessi.set(cellId, visti); }
    if (visti.includes(chiave)) return false;
    visti.push(chiave);
    while (visti.length > PROMPT_OBSERVER_DEDUP_MAX) visti.shift();
    const normale = d.state === 'submitted' || (d.state === 'skipped' && d.reason === 'vl-bootstrap-generation');
    let registrato = null;
    try {
      registrato = cfg.diagnostics.record(normale ? 'notice' : 'warn', 'fleet', 'PROMPT_DELIVERY_TERMINAL',
        'Prompt delivery reached a terminal state', {
          cell: cellId, state: d.state, ...(d.reason ? { reason: d.reason } : {}),
          launchId: d.launchId, generation: d.generation,
        });
    } catch (_) { registrato = null; }
    if (!registrato && typeof cfg.log === 'function') {
      // UN solo fallback al logger gia' disponibile: testo costante, nessun
      // metadato sensibile, nessun Error grezzo. Se anche il sink manca il
      // limite resta dichiarato e il canonico non viene toccato.
      try { cfg.log('nexuscrew fleet: prompt delivery event not recorded'); } catch (_) { /* limite dichiarato */ }
    }
    return true;
  }

  function avviaOsservatore(ctrl) {
    if (!ctrl) return;
    // Distaccato: la risposta di `up` non lo attende e non dipende da lui.
    setImmediate(() => {
      if (ctrl.abortato || ctrl.avviato || ctrl.epoca !== epocaRuntime) return;
      ctrl.avviato = true;
      osservaCicloPrompt(ctrl).catch(() => {}).finally(() => {
        if (osservatori.get(ctrl.cellId) === ctrl) osservatori.delete(ctrl.cellId);
      });
    });
  }

  async function osservaCicloPrompt(ctrl) {
    const scadenza = ctrl.ancora + ctrl.tettoMs;
    const maxPoll = Math.ceil(ctrl.tettoMs / PROMPT_OBSERVER_POLL_MS) + 2;
    for (let n = 0; n < maxPoll; n += 1) {
      if (ctrl.abortato || cooldownNow() >= scadenza) return;
      let out = null;
      try {
        out = await consegnaPromptCorrente({
          cellId: ctrl.cellId, sessione: ctrl.sessione, viva: true, chiusuraAttestata: false, ipotesi: true,
        });
      } catch (_) { out = null; }
      // Il residuo si ricontrolla DOPO l'await e prima di ogni effetto: una
      // lettura che attraversa il tetto non produce un evento fuori tempo.
      if (ctrl.abortato || ctrl.epoca !== epocaRuntime || cooldownNow() >= scadenza) return;
      const registro = lanciCorrenti.get(ctrl.sessione);
      if (!registro || registro.launchId !== ctrl.launchId) return;   // lancio sostituito: ciclo invalidato
      if (out && Number.isSafeInteger(out.generation)) {
        if (ctrl.generazione === null) ctrl.generazione = out.generation;
        else if (ctrl.generazione !== out.generation) return;          // cambio di generazione: ciclo invalidato
      }
      if (out && out.terminalPersisted === true && out.delivery
        && out.delivery.generation === ctrl.generazione) {
        emettiTerminalePrompt(ctrl.cellId, out);
        return;
      }
      await attendiOsservatore(ctrl, Math.max(1, Math.min(PROMPT_OBSERVER_POLL_MS, scadenza - cooldownNow())));
    }
  }

  // ── Stato corrente della consegna del prompt (0.9.80, strato 2c) ─────────
  //
  // SOLO letture: registro dei lanci (memoria del processo, poi file), UNA
  // consultazione breve del fence del proprietario sul lease autenticato e il
  // lettore 2b legato alla generazione che il proprietario ha attestato. Nessuna
  // scrittura, nessuna riconciliazione, nessun avvio di osservatore. La
  // generazione arriva dalla fotografia del PROPRIETARIO, mai dal file del
  // prompt, dal PID, dal pane o da `@nc_delivery`.
  //
  // `ipotesi` = applicabilita' ricavata dalla definizione corrente: serve solo
  // quando la fotografia non e' ottenibile, per dire «consegna possibile ma non
  // attestabile» (unknown) invece di tacere. Non sostituisce la richiesta
  // realmente ammessa nel lancio.
  // Ritorna null (campo omesso) oppure { delivery, terminalPersisted, mcp?,
  // launchId, generation } con `delivery` gia' composta.
  async function consegnaPromptCorrente({ cellId, sessione, viva, chiusuraAttestata, ipotesi }) {
    const root = filesRootDi(cfg);
    if (!root || typeof sessione !== 'string' || !sessione) return null;
    const registro = lanciCorrenti.get(sessione) || leggiLancioCorrente(root, sessione);
    if (!registro) {
      // Nessun lancio selezionato. Cella spenta: niente da descrivere. Cella
      // viva con consegna possibile: unknown senza identificatori inventati.
      // Senza registro e senza liveness conclusiva una consegna possibile resta
      // unknown: la sola assenza di un registro non e' una chiusura.
      if (!viva && chiusuraAttestata) return null;
      return ipotesi === true ? { ...composePromptDeliveryQualified({ applicable: null }), launchId: null, generation: null } : null;
    }
    const launchId = registro.launchId;
    if (!viva) {
      // Il campo descrive una consegna CORRENTE, non la storia: omesso solo
      // con la chiusura del lancio attestata (lettura tmux conclusiva).
      if (chiusuraAttestata) return null;
      return { ...composePromptDeliveryQualified({ applicable: null, launchId }), launchId, generation: null };
    }
    let generazione = null;
    let applicabile = null;
    let mcp = null;
    if (leaseManager && typeof leaseManager.readPromptSnapshot === 'function'
      && typeof leaseManager.status === 'function' && (leaseManager.status(cellId) || {}).state === 'live') {
      let foto = null;
      try { foto = await leaseManager.readPromptSnapshot(cellId); } catch (_) { foto = null; }
      // NESSUN await da qui alla composizione: la fotografia resta
      // linearizzabile. Si ricontrollano la connessione che ha risposto e il
      // lancio selezionato dal registro.
      const ancora = lanciCorrenti.get(sessione) || leggiLancioCorrente(root, sessione);
      if (foto && foto.ok === true && foto.launchId === launchId
        && ancora && ancora.launchId === launchId
        && leaseManager.promptSnapshotBinding(cellId, foto)) {
        generazione = foto.generation;
        applicabile = foto.applicable === true;
        mcp = foto.mcp || null;
      }
    }
    if (applicabile === null) {
      // Fotografia non ottenuta, lancio selezionato nel registro: l'UNICA
      // negativa qualificata e' il fatto immutabile del processo che ha
      // lanciato (la richiesta realmente ammessa, `applicabile === false`).
      // Ne' la definizione corrente (mutabile), ne' l'assenza del record (che
      // comprende un record illeggibile o mai scritto), ne' un errore di
      // accesso provano che il lancio non prevedesse una consegna: nel dubbio
      // unknown con il solo launchId. L'esistenza del record non e' autorita'
      // sulla generazione.
      if (registro.applicabile === false) return null;
      return { ...composePromptDeliveryQualified({ applicable: null, launchId }), launchId, generation: null };
    }
    if (applicabile === false) return null;
    const letto = generazione === null ? null
      : leggiEsitoPromptCorrente(root, sessione, { launchId, generation: generazione });
    const q = composePromptDeliveryQualified({
      applicable: true, launchId, generation: generazione, letto, persistito: esitoPromptEPersistito(letto),
    });
    return { ...q, launchId, generation: generazione, mcp };
  }

  // Applicabilita' ricavata dalla definizione corrente (ipotesi, vedi sopra).
  function ipotesiConsegnaDefinizione(defs, c) {
    const eng = findEngine(defs, c.engine);
    if (!eng || eng.promptMode !== 'send-keys' || !c.prompt) return false;
    return promptDeliveryApplicable({
      client: eng.managed && typeof eng.managed.client === 'string' ? eng.managed.client : '',
      submit: eng.submit, repromptOff: eng.restartReprompt === false,
    });
  }

  async function cellStatus({ includeCwd = false } = {}) {
    if (Date.now() - cache.at > STATUS_TTL_MS) {
      reloadDefs();                          // pick-up di edit esterne/file
      const sessions = await refreshSessionsVisibili();
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
      const isVl = isVlNewSessionSupported(engineDef);
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
    // Stato corrente della consegna del prompt: GET passivo, solo letture. Le
    // consultazioni sono brevi (250 ms) e concorrenti fra le celle.
    const defsCelle = cache.defs;
    const chiusuraAttestata = sessions.conclusivo !== false;
    await Promise.all(cells.map(async (cellaStato, i) => {
      const c = defsCelle.cells[i];
      try {
        const out = await consegnaPromptCorrente({
          cellId: c.id, sessione: c.tmuxSession, viva: cellaStato.active === true,
          chiusuraAttestata, ipotesi: ipotesiConsegnaDefinizione(defsCelle, c),
        });
        if (out && out.delivery) cellaStato.promptDelivery = out.delivery;
        // Osservazione MCP accessoria dello STESSO lancio e della STESSA
        // generazione attestata: separata da promptDelivery, volatile (vive nel
        // proprietario), mai storia durevole e mai una promozione del prompt.
        if (out && out.mcp && out.launchId && Number.isSafeInteger(out.generation)) {
          cellaStato.promptMcp = {
            launchId: out.launchId, generation: out.generation,
            state: out.mcp.state, failed: [...out.mcp.failed], pending: [...out.mcp.pending],
          };
        }
      } catch (_) { /* campo omesso: la lettura non e' un guasto dello stato */ }
    }));
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
        withVlProfiles: true,
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
              : (managed.vlProfiles && managed.vlProfiles.state === 'ready'
                // vl.native: what is saved and passed is the profile ID; the
                // `<model> · <id>` text is the option's label (vlProfiles.options).
                ? managed.vlProfiles.options.map((o) => o.value)
                : (managed.vlProfiles && managed.vlProfiles.state === 'none' ? [] : managed.models))),
          ...(managed.vlProfiles ? { vlProfiles: managed.vlProfiles } : {}),
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
    const holder = {};
    try {
      await previous;
      return await upSerializzato(cellId, holder);
    } catch (e) {
      throw annotaEsitoSessioneNuova(e, cellId);
    } finally {
      release();
      if (launchLocks.get(cellId) === chained) launchLocks.delete(cellId);
      avviaOsservatore(holder.osservatore);
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

  async function upSerializzato(cellId /* , { engine, boot } = {} */, holder = null) {
    if (holder) holder.epoca = epocaRuntime;
    if (typeof ensureProtection === 'function') await ensureProtection();
    const defs = reloadDefs();
    const cell = findCell(defs, cellId);
    if (!cell) throw httpError(400, `cella sconosciuta: ${cellId}`);
    assicuraScrittore('preflight');
    completaCommitPendente(cell, 'preflight');
    // (0) Guardie di incertezza (stato non chiuso / indeterminato): nuovo avvio bloccato
    if (esitiIncerti.has(cell.tmuxSession)) {
      throw httpError(409,
        `lancio incerto per la cella ${cell.id}: esito non determinato in questo processo, nuovo avvio bloccato`,
        null, { phase: 'preflight', code: 'STOP_UNKNOWN' });
    }
    const radiceLancio = filesRootDi(cfg);
    let targetSessionId = null;
    if (radiceLancio) {
      const precedente = launchTarget.leggi(radiceLancio, cell.tmuxSession);
      if (precedente.stato === 'indeterminato') {
        throw httpError(409,
          `lancio incerto per la cella ${cell.id}: record del lancio non leggibile, identità non dimostrabile`,
          null, { phase: 'preflight', code: 'STOP_UNKNOWN' });
      }
      if (precedente.stato === 'presente' && precedente.record) {
        if (precedente.record.incerto) {
          throw httpError(409,
            `lancio incerto per la cella ${cell.id}: nuovo avvio bloccato finche' l'esito non e' verificato`,
            null, { phase: 'preflight', code: 'STOP_UNKNOWN' });
        }
        const canalePosseduto = canaliControllo.get(cell.tmuxSession);
        if (!canalePosseduto || canalePosseduto.morto()) {
          throw httpError(409,
            `lancio non chiuso per la cella ${cell.id}: record persistente presente senza continuità di controllo dimostrabile`,
            null, { phase: 'preflight', code: 'SESSION_DUPLICATE' });
        }
        if (precedente.record.sessionId) {
          targetSessionId = precedente.record.sessionId;
        }
      }
    }

    // (1) Cella viva posseduta sul canale di controllo (server condiviso)
    const canalePosseduto = canaliControllo.get(cell.tmuxSession);
    if (canalePosseduto && !canalePosseduto.morto()) {
      const has = typeof canalePosseduto.hasSession === 'function' && targetSessionId
        ? await canalePosseduto.hasSession(targetSessionId)
        : (typeof canalePosseduto.hasSession === 'function'
            ? await canalePosseduto.hasSession(cell.tmuxSession)
            : { ok: true });
      if (has.ok !== false) {
        throw httpError(409, 'sessione già in esecuzione', null,
          { phase: 'preflight', code: 'SESSION_DUPLICATE' });
      }
      canalePosseduto.chiudi();
      canaliControllo.delete(cell.tmuxSession);
    }

    // (2) Sessioni visibili sul socket di default o canali vivi
    const vive = await refreshSessionsVisibili();
    if (vive.has(String(cell.tmuxSession))) {
      throw httpError(409, 'sessione già in esecuzione', null,
        { phase: 'preflight', code: 'SESSION_DUPLICATE' });
    }
    const engine = findEngine(defs, cell.engine);
    if (!engine) throw httpError(400, `engine dangling per cella ${cellId}: ${cell.engine}`);
    // Pausa minima fra due lanci della STESSA cella vl (contratto vl): il
    // cooldown deduplica doppio click/retry e mette un passo massimo alla
    // ripetizione dei lanci. Il rifiuto è dichiarato (429), mai un'attesa
    // silenziosa dentro la route. Le celle non-vl non sono toccate; il clock
    // è il seam cfg.now, i test non dormono.
    if (isVlNewSessionSupported(engine)) {
      const cooldownMs = clampCooldown(cfg.vlLaunchCooldownMs !== undefined
        ? cfg.vlLaunchCooldownMs : VL_LAUNCH_COOLDOWN_DEFAULT_MS);
      const last = vlLastLaunchAt.get(cellId);
      if (cooldownMs > 0 && typeof last === 'number' && cooldownNow() - last < cooldownMs) {
        throw httpError(429,
          `pausa minima fra due lanci della stessa cella vl non trascorsa (${cooldownMs} ms)`,
          null, { phase: 'preflight', code: 'VL_LAUNCH_COOLDOWN' });
      }
    }
    // Generazione del LANCIO: identifica QUESTA partenza della cella. Serve a
    // OGNI famiglia di engine, non solo managed — il canale attivita' e il
    // record terminale sono del supervisore (che esiste per ogni cella), non
    // degli hook del client. Per i managed e' anche la generazione degli hook;
    // per i custom e' l'identita' con cui il supervisore pubblica AVVIO,
    // selettore del lancio e ragione terminale su file.
    const generazione = crypto.randomBytes(8).toString('hex');

    // GIORNALE PRIMA DEGLI EFFETTI. Famiglia, owner e root si risolvono e si
    // validano qui in SOLA LETTURA e il record `prepared` si impegna in modo
    // durevole PRIMA di qualunque effetto del lancio (riserva della root vl,
    // contesto host, marcatore «sessione nuova», registro, selettore, broker).
    // Se il record non e' attestato non succede niente altro: nessuna claim,
    // nessun file, nessuna chiamata. Con il record gia' sul disco, un crash in
    // un punto qualunque lascia sempre una traccia che dice a chi legge cosa
    // poteva essere stato fatto.
    const famiglia = engine.managed && engine.managed.client === 'vl' ? 'vl' : 'other';
    let vlOwnerQualificato = null;
    let vlRootPrevista = null;
    if (famiglia === 'vl') {
      // Node owner identity preflight: resolved ONCE and qualified BEFORE
      // any effect of the launch — root reservation, context, broker,
      // new-session. Shape: hex32 e disponibilita'. Il vecchio fallback
      // `local` faceva partire un lancio che la registrazione a valle
      // rifiutava DOPO aver creato sessione e ticket (VL_PEER_UNATTESTED in
      // readiness): un rifiuto che il nodo poteva dare prima dello spawn. Ora
      // e' un preflight visibile come gli altri esiti, a zero effetti, e lo
      // STESSO valore nutre root, catalogo, pin e registrazione. Nessun
      // nodeId sostitutivo: un nodo senza identita' owner qualificata non
      // lancia vl. Il controllo delle capacita' del binario resta distinto
      // (verificaCapacitaPeerStop).
      const owner = typeof identityOwnerInstanceId === 'function'
        ? identityOwnerInstanceId() : identityOwnerInstanceId;
      if (typeof owner !== 'string' || !/^[a-f0-9]{32}$/.test(owner)) {
        throw httpError(500,
          `identita' owner del nodo non qualificabile per la cella ${cell.id} (${owner == null ? 'assente' : 'forma non hex32'}): avvio rifiutato`,
          { motivo: owner == null ? 'assente' : 'forma' },
          { phase: 'preflight', code: 'NODE_IDENTITY_UNAVAILABLE' });
      }
      vlOwnerQualificato = owner;
      vlRootPrevista = radiceServer(home, owner, cell.id);
      if (!vlRootPrevista) {
        throw httpError(500, `radice vl non canonica per la cella ${cell.id}`, null,
          { phase: 'preflight', code: 'LOCK_UNAVAILABLE' });
      }
    }
    const targetRoot = filesRootDi(cfg);
    if (!targetRoot) {
      throw httpError(500,
        `record del lancio non scrivibile per la cella ${cell.id} (nessuna root dei file): lancio rifiutato`,
        null, { phase: 'new-session', code: 'LAUNCH_TARGET_UNWRITABLE' });
    }
    // Il socket e' quello che tmux risolve da solo (vedi sotto, creazione):
    // pathname calcolato con la stessa fonte, qui perche' il record lo porta.
    const socketLancio = sharedTmuxSocketPath();
    const ownerRecord = famiglia === 'vl' ? vlOwnerQualificato : (() => {
      const o = typeof identityOwnerInstanceId === 'function'
        ? identityOwnerInstanceId() : identityOwnerInstanceId;
      return typeof o === 'string' && /^[a-f0-9]{32}$/.test(o) ? o : null;
    })();
    const identitaNodoLancio = (typeof cfg.identitaNodoKernel === 'function'
      ? cfg.identitaNodoKernel : vlHostStop.identitaNodoKernel)();
    const bootIdLancio = typeof cfg.bootIdKernel === 'function'
      ? cfg.bootIdKernel() : (identitaNodoLancio ? identitaNodoLancio.bootId : null);
    const preparato = launchTarget.registraPrepared(targetRoot, cell.tmuxSession, {
      launchId: generazione,
      family: famiglia,
      cellId: cell.id,
      ownerInstanceId: ownerRecord,
      tmuxSocket: socketLancio,
      bootId: bootIdLancio,
      pidNs: identitaNodoLancio ? String(identitaNodoLancio.pidNamespaceInode) : null,
      daemonInc: identityDaemonBootId,
      res: famiglia === 'vl' ? { vlOwner: vlOwnerQualificato, vlRoot: vlRootPrevista } : null,
      ora: nowMs(),
    });
    if (!preparato || preparato.ok !== true) {
      // Nessun effetto e' ancora avvenuto. Se la scrittura ha lasciato un
      // record pubblicato ma non provato (errore dopo il rename), lo si toglie
      // se si riesce; altrimenti resta e blocca, e la guardia in-process lo dice.
      if (preparato && preparato.pubblicato === 'incerto'
        && launchTarget.rimuoviDelLancio(targetRoot, cell.tmuxSession, generazione) !== true) {
        esitiIncerti.add(cell.tmuxSession);
      }
      throw httpError(500,
        `record del lancio non scrivibile per la cella ${cell.id}: lancio rifiutato prima di ogni effetto`,
        null, { phase: 'new-session', code: 'LAUNCH_TARGET_UNWRITABLE' });
    }
    // Il corpo del lancio. Qualunque errore PRIMA dell'inizio della creazione
    // passa dal cleanup qualificato (claim esatta, poi record del NOSTRO
    // lancio): non c'e' piu' un percorso che esce lasciando la claim senza
    // record o il record senza una ragione.
    const giro = { abort: null, prima: () => true };
    try {
      return await lanciaDopoPrepared({
        cellId, defs, cell, engine, generazione, famiglia, vlOwnerQualificato, vlRootPrevista,
        targetRoot, socketLancio, giro, holder,
      });
    } catch (e) {
      if (giro.abort && giro.prima()) {
        try { await giro.abort(); } catch (_) { /* il record, se resta, blocca un secondo lancio */ }
      }
      throw e;
    }
  }

  // Il corpo del lancio dopo `prepared`: tutto cio' che ha effetti. Il
  // contratto con upSerializzato e' `giro`: abort() chiude i preparativi
  // (claim, record del lancio) e prima() dice se la creazione non e' ancora
  // iniziata, cioe' se abortire e' lecito.
  async function lanciaDopoPrepared({
    cellId, defs, cell, engine, generazione, famiglia, vlOwnerQualificato, vlRootPrevista,
    targetRoot, socketLancio, giro, holder = null,
  }) {
    // Ancora MONOTONA del lancio, acquisita prima di ogni attesa (issue del
    // payload, readiness): il tetto dell'osservatore parte da qui.
    const ancoraLancio = cooldownNow();
    let budgetPrompt = null;
    let launchEngine = engine;
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
    let vlBootstrapDecision = null;     // vl bootstrap claim decision, per launch
    let vlBootstrapOutcome = null;      // vl delivery outcome in the up() result
    let vlClaim = null;
    let improntaRadice = null;
    // Stato della base della cella all'inizio del lancio: assente | presente | illeggibile.
    let baseAllInizio = 'illeggibile';
    // Binario PINNATO e ambiente per la sola lettura `host status` dell'abort:
    // valorizzato quando il pin del lancio esiste. Senza, una root PRESENTE non
    // si puo' giudicare e la barriera resta.
    let sondaHostPre = null;
    // Data for registering the peer host identity AT UP TIME. Declared
    // outside the preflight branch because it is needed at the END of the
    // launch, after the spawn and the prompt delivery, right before the
    // up is declared successful.
    let vlRegistrazione = null;
    // La claim e' esatta: solo il rilascio con esito `released` la scioglie. Un
    // esito diverso (incerto, rifiutato, `not-held`: che non distingue una
    // claim gia' rilasciata da una lease straniera) CONSERVA il riferimento e
    // la barriera. Mai azzerare il riferimento prima di conoscere l'esito.
    const rilasciaClaimPre = async () => {
      if (!vlClaim) return true;
      let esito = null;
      try {
        esito = await rilascia({
          home, root: vlClaim.root, launchId: generazione,
          ownerInstanceId: vlClaim.owner, cellId: cell.id, budgetMs: 8000,
        });
      } catch (_) { esito = null; }
      if (esito && esito.ok === true && esito.outcome === 'released') {
        vlClaim = null;
        return true;
      }
      return false;
    };
    // Cleanup qualificato di un lancio la cui creazione NON e' iniziata (o il
    // cui teardown e' provato): prima la claim esatta, poi il record del
    // NOSTRO lancio. Se la claim non si scioglie il record resta, cosi' la
    // barriera ha sempre una traccia. Un solo tentativo per lancio: il
    // riferimento alla claim resta quello che e'.
    let abortTentato = false;
    // BARRIERA HOST prima di sciogliere qualunque cosa (vl). «Questo lancio
    // non ha emesso new-session» non prova che sulla root non esista un host
    // precedente o sostituto: prepared NON e' un'esenzione. Si scioglie solo
    // con la risorsa provata ASSENTE (root ancora assente, stessa impronta
    // qualificata del preflight se c'e') oppure con la root presente e il
    // binario pinnato che risponde `none`. Root cambiata, host vivo o non
    // qualificabile, probe mancante o fallito: claim e record restano. Nessun
    // host-stop e nessun kill: e' una sola lettura.
    const hostAssenteProvato = async () => {
      if (famiglia !== 'vl') return true;
      let ora = null;
      try {
        const baseCella = vlCellBaseDir(home, vlOwnerQualificato, cell.id);
        // ENOENT di oggi NON dimostra «mai preparata»: una base vista o
        // qualificata prima puo' essere stata spostata o tolta durante un
        // await, con il pin e un host dietro. Vale come assenza sicura solo
        // se la base non esisteva all'INIZIO di questo lancio e nessuna
        // impronta ne' pin sono stati acquisiti da allora: un fallimento
        // ordinario prima di ogni preparazione (engine non configurato,
        // binario assente) non deve bloccare la cella, ma una base gia'
        // osservata che scompare conserva claim e prepared.
        try {
          fs.lstatSync(baseCella);
        } catch (e) {
          if (e && e.code === 'ENOENT') {
            return baseAllInizio === 'assente' && improntaRadice === null && sondaHostPre === null;
          }
          return false;
        }
        ora = qualificaAssenzaRadice(vlRootPrevista, baseCella);
      } catch (_) { return false; }
      if (!ora || ora.esito === 'rifiutata') return false;
      if (ora.esito === 'assente') {
        return improntaRadice ? stessaImprontaRadice(improntaRadice, ora) : true;
      }
      if (!sondaHostPre) return false;
      let cap = null;
      try {
        cap = await vlHostStop.verificaCapacitaPeerStop({
          bin: sondaHostPre.bin, env: sondaHostPre.env, root: vlRootPrevista,
        });
      } catch (_) { return false; }
      return !!(cap && cap.ok === true && cap.stato && cap.stato.state === 'none');
    };
    const abortPreCreazione = async () => {
      if (abortTentato) return;
      abortTentato = true;
      if (!(await hostAssenteProvato())) {
        const log = typeof cfg.log === 'function' ? cfg.log : console.warn;
        log(`fleet abort del lancio per ${cell.id}: host/root vl non provati assenti, claim e record conservati`);
        esitiIncerti.add(cell.tmuxSession);
        return;
      }
      const claimLibera = await rilasciaClaimPre();
      if (!claimLibera) {
        esitiIncerti.add(cell.tmuxSession);
        return;
      }
      if (launchTarget.rimuoviDelLancio(targetRoot, cell.tmuxSession, generazione) !== true) {
        esitiIncerti.add(cell.tmuxSession);
      }
    };
    // La creazione e' iniziata (o il suo commit e' incerto) dal momento in cui
    // il record puo' dire `creating`: da qui la barriera non si scioglie senza
    // prova correlata di chiusura.
    let creatingIncerto = false;
    let sessioneCreata = false;
    let creazioneIniziata = false;
    let rifiutoProvato = false;
    giro.abort = abortPreCreazione;
    giro.prima = () => !creazioneIniziata && !creatingIncerto && !sessioneCreata;
    // La base della cella com'era PRIMA di ogni effetto di questo lancio: il
    // solo riferimento che dia senso a un ENOENT successivo.
    if (famiglia === 'vl') {
      try {
        fs.lstatSync(vlCellBaseDir(home, vlOwnerQualificato, cell.id));
        baseAllInizio = 'presente';
      } catch (e) {
        baseAllInizio = e && e.code === 'ENOENT' ? 'assente' : 'illeggibile';
      }
    }
    if (famiglia === 'vl') {
      const owner = vlOwnerQualificato;
      const root = vlRootPrevista;
      const esito = await riserva({
        home, root, launchId: generazione, ownerInstanceId: owner, cellId: cell.id, budgetMs: 8000,
      });
      if (!esito.ok) {
        // Una riserva INCERTA puo' aver pubblicato la claim: il riferimento si
        // conserva, il cleanup tenta il rilascio esatto e, se non basta, il
        // record resta a dire che la barriera esiste.
        if (esito.outcome === 'uncertain') vlClaim = { root, owner };
        const code = esito.outcome === 'collision' ? 'VL_ROOT_COLLISION'
          : esito.outcome === 'uncertain' ? 'CLAIM_UNCERTAIN' : 'LOCK_UNAVAILABLE';
        throw httpError(code === 'VL_ROOT_COLLISION' ? 409 : 500,
          `riserva della root vl non ottenuta (${esito.outcome})`,
          { outcome: esito.outcome }, { phase: 'preflight', code });
      }
      vlClaim = { root, owner };
    }
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
        // node (executor), never from a federated viewer. The SAME value
        // qualified in the preflight: root, catalog, pin and registration
        // see one single identity per launch.
        vlOwnerInstanceId: vlOwnerQualificato,
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
        await abortPreCreazione();
        throw httpError(500, resolved.mcpCellRefused, null, { phase: 'preflight', code: resolved.mcpCellRefusedCode || 'MCP_CELL_FILE_UNWRITABLE' });
      }
      if (!resolved.ok) {
        await abortPreCreazione();
        const code = engine.managed.client === 'shell' ? 'SHELL_NOT_AVAILABLE' : 'ENGINE_UNCONFIGURED';
        throw httpError(400, `engine managed non configurato (${engine.id}): ${resolved.reason}`, null, { phase: 'preflight', code });
      }
      launchEngine = resolved.engine;
      if (vlClaim && engine.managed.client === 'vl') {
        const rt = (resolved.info && resolved.info.vlRuntime) || {};
        const env = launchEngine.env || {};
        if (!rt.binary || !rt.stateDir || !env.XDG_STATE_HOME) {
          await abortPreCreazione();
          throw httpError(500, `contesto host vl non risolto per la cella ${cell.id}`, null,
            { phase: 'preflight', code: 'HOST_UNRESOLVABLE' });
        }
        const pin = pinBinario({
          source: rt.binary, home, owner: vlClaim.owner, cellId: cell.id,
          log: typeof cfg.log === 'function' ? cfg.log : () => {},
        });
        if (!pin.ok) {
          await abortPreCreazione();
          throw httpError(500, `pin del binario vl non creato (${pin.code})`, null,
            { phase: 'preflight', code: 'HOST_UNRESOLVABLE' });
        }
        const contestoBase = {
          launchId: generazione,
          vlBin: rt.binary,
          vlBinSha256: pin.sha256,
          XDG_STATE_HOME: env.XDG_STATE_HOME,
          XDG_DATA_HOME: env.XDG_DATA_HOME,
          XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
          HOME: home,
          uid: typeof process.getuid === 'function' ? process.getuid() : 0,
          serverRoot: vlClaim.root,
          ts: nowMs(),
        };
        sondaHostPre = { bin: pin.path, env: envDalRecord(contestoBase) };
        // Peer/stop capability preflight BEFORE the spawn: the
        // binario PINNATO deve dichiarare entrambe le capacità versionate
        // (host_peer_identity_v1, host_stop_expected_v1) e il support
        // dell'osservazione del peer. Sono fatti del binario, non dell'host:
        // lo status li porta anche a host assente. Senza una di queste il
        // lancio è RIFIUTATO in modo visibile, prima di qualunque effetto
        // (zero spawn, zero contesto, claim rilasciata): nessun fallback su
        // un binario che non può attestare il processo che fermerebbe.
        // NodeId e owner restano distinti dall'identità del processo host.
        // Assenza della root reale, dopo la claim. host-v1 non si crea.
        // L'impronta si ricontrolla dopo la sonda e ancora prima dello spawn.
        const baseCella = vlCellBaseDir(home, vlClaim.owner, cell.id);
        improntaRadice = qualificaAssenzaRadice(vlClaim.root, baseCella);
        if (!improntaRadice || improntaRadice.esito === 'rifiutata') {
          await abortPreCreazione();
          throw httpError(500,
            `radice host vl non qualificabile per la cella ${cell.id} (${improntaRadice && improntaRadice.code}): avvio rifiutato`,
            null, { phase: 'preflight', code: 'HOST_UNRESOLVABLE' });
        }
        // Radice reale assente: la capacità si legge su una root usa e getta.
        // serverRoot della claim resta la root reale.
        let sonda = null;
        if (improntaRadice.esito === 'assente') {
          sonda = vlHostStop.preparaSondaRadice();
          if (!sonda.ok) {
            let residuo = '';
            if (sonda.baseDev != null && sonda.baseIno != null) {
              if (!vlHostStop.pulisciSondaRadice(sonda)) residuo = sonda.base || '';
            } else if (sonda.residuo || sonda.base) {
              residuo = sonda.residuo || sonda.base;
            }
            await abortPreCreazione();
            throw httpError(500,
              `sonda di capacita' vl non preparabile per la cella ${cell.id} (${sonda.code})${residuo ? `: residuo ${residuo}` : ''}: avvio rifiutato`,
              residuo ? { residuo: true } : null, { phase: 'preflight', code: 'VL_PEER_STOP_UNSUPPORTED' });
          }
        }
        let capacita;
        let sondaPulita = true;
        try {
          capacita = await verificaCapacitaPeerStop({
            bin: pin.path, env: envDalRecord(contestoBase),
            root: sonda ? sonda.dir : vlClaim.root,
          });
        } finally {
          if (sonda) sondaPulita = vlHostStop.pulisciSondaRadice(sonda);
        }
        if (!sondaPulita) {
          await abortPreCreazione();
          throw httpError(500,
            `sonda di capacita' vl non ripulita per la cella ${cell.id}: avvio rifiutato`,
            null, { phase: 'preflight', code: 'VL_PEER_STOP_UNSUPPORTED' });
        }
        const dopoSonda = qualificaAssenzaRadice(vlClaim.root, baseCella);
        if (!stessaImprontaRadice(improntaRadice, dopoSonda)) {
          await abortPreCreazione();
          throw httpError(500,
            `radice host vl cambiata durante la sonda per la cella ${cell.id}: avvio rifiutato`,
            null, { phase: 'preflight', code: 'HOST_UNRESOLVABLE' });
        }
        improntaRadice = dopoSonda;
        if (!capacita.ok) {
          await abortPreCreazione();
          throw httpError(500,
            `binario vl senza capacita' peer/stop per la cella ${cell.id} (${capacita.motivo}): avvio rifiutato`,
            { motivo: capacita.motivo }, { phase: 'preflight', code: 'VL_PEER_STOP_UNSUPPORTED' });
        }
        // La root temporanea qualifica solo il binario. Un host vivo li' non
        // e' l'assenza della root reale e non autorizza lo spawn.
        if (sonda && capacita.stato.state !== 'none') {
          await abortPreCreazione();
          throw httpError(500,
            `sonda di capacita' vl su root temporanea non e' none per la cella ${cell.id}: avvio rifiutato`,
            { motivo: 'probe' }, { phase: 'preflight', code: 'VL_PEER_STOP_UNSUPPORTED' });
        }
        const contesto = contestoIniziale(contestoBase);
        try {
          scriviContesto(rt.stateDir, contesto);
        } catch (_) {
          await abortPreCreazione();
          throw httpError(500, `contesto host vl non scrivibile per la cella ${cell.id}`, null,
            { phase: 'preflight', code: 'HOST_UNRESOLVABLE' });
        }
        // The launch can call itself successful only with the peer host
        // identity REGISTERED in the context (verified, by
        // binario pinnato). I dati per farlo — quando sara' il momento, a
        // lancio gia' partito — si fissano qui: binario PINNATO, root della
        // claim, contesto v2 appena scritto e owner (l'instanceId del nodo,
        // che nella tuple registrata distingue il record di QUESTO lancio).
        vlRegistrazione = {
          bin: pin.path,
          root: vlClaim.root,
          stateDir: rt.stateDir,
          contesto,
          owner: vlClaim.owner,
        };
      }
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
        await abortPreCreazione();
        throw httpError(refusal.status, refusal.message, null,
          { phase: 'preflight', code: refusal.code });
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

    // Canale DEDICATO del record dell'esito della consegna del prompt (0.9.80,
    // strato 2b): indipendente dagli hook del cliente. La durabilita' di
    // quell'esito e' responsabilita' del supervisore, quindi il canale esiste
    // SEMPRE — anche con `activityHooks: false` — quando il riferimento privato
    // e' qualificabile (root dei file + sessione); se non lo e', non lo si
    // inventa: nessuna directory indovinata, nessun fallback al canale
    // attivita'. Stessa directory per sessione dei record esistenti; l'identita'
    // e' il LANCIO (che qui si genera), il campo della generazione del
    // supervisore viaggia nel record, non nel canale.
    let promptOutcomeCanale = null;
    if (typeof cell.tmuxSession === 'string' && cell.tmuxSession) {
      const promptRoot = filesRootDi(cfg);
      if (promptRoot) promptOutcomeCanale = { dir: path.join(promptRoot, cell.tmuxSession), launchId: generazione };
    }

    // (2) trust del command PRIMA di lanciare
    const trust = validateCommandTrust(launchEngine.command);
    if (!trust.ok) {
      await abortPreCreazione();
      throw httpError(400, `command non trusted (${launchEngine.command}): ${trust.reason}`, null, { phase: 'preflight', code: 'COMMAND_UNTRUSTED' });
    }
    // (3) cwd reale sotto la home
    const realCwd = resolveCwd(cell.cwd, home);
    if (!realCwd) {
      await abortPreCreazione();
      throw httpError(400, `cwd non valida (deve esistere sotto la home): ${cell.cwd}`, null, { phase: 'preflight', code: 'CWD_INVALID' });
    }

    // Consumo del marcatore «sessione nuova» (managed-vl e adattatori dichiaranti):
    // il marcatore persistente si consuma qui, atomicamente (rename), DOPO tutti
    // i preflight completi (risoluzione definizione, trust, cwd, manifest capacita
    // del launcher) e PRIMA del commit dell'autorita', del ticket e dello spawn.
    // Un fallimento preflight (trust, cwd, manifest rotto/assente/hash errato, engine mutato non dichiarante)
    // rifiuta il lancio con 400 lasciando il marcatore in stato pending (zero spawn, zero ticket).
    const newSessionStatus = vlNewSessionStatus({ home, cellId: cell.id });
    if (newSessionStatus.state === 'pending') {
      const isOtherManaged = !!(launchEngine.managed && launchEngine.managed.client !== 'vl');
      if (!isOtherManaged) {
        if (!isVlNewSessionSupported(launchEngine)) {
          await abortPreCreazione();
          throw httpError(400,
            `richiesta di sessione nuova pendente ma l'engine attuale della cella ${cell.id} non supporta la sessione nuova (definizione mutata o non dichiarante)`,
            null, { phase: 'preflight', code: 'LAUNCHER_UNSUPPORTED' });
        }
        if (launchEngine.newSessionEnv === true) {
          let caps = null;
          try {
            caps = verifyLauncherCaps(launchEngine.command, { home, cellId: cell.id });
          } catch (_) {
            // Il verificatore e' fail-closed per contratto e restituisce soltanto
            // esiti chiusi; se una qualunque eccezione (open, fstat, read,
            // allocazione) gli sfuggisse comunque, il preflight la converte QUI
            // in un rifiuto chiuso e bounded: mai testo dell'eccezione, mai
            // pathname. Il chiamante non dipende dagli errori filesystem che il
            // verificatore decide di sollevare. Marcatore pending, zero ticket.
            await abortPreCreazione();
            throw httpError(400,
              'launcher non compatibile con newSessionEnv: verifica non riuscita',
              null, { phase: 'preflight', code: 'LAUNCHER_UNSUPPORTED' });
          }
          if (!caps.ok) {
            await abortPreCreazione();
            throw httpError(400,
              `launcher non compatibile con newSessionEnv: ${caps.reason}`,
              null, { phase: 'preflight', code: 'LAUNCHER_UNSUPPORTED' });
          }
          if (caps.pinnedPath) {
            launchEngine = { ...launchEngine, command: caps.pinnedPath };
          }
        }
        try {
          const consumed = consumeVlNewSession({ home, cellId: cell.id, now: nowMs() });
          if (consumed.consumed) {
            vlNewSessionApplied = true;
          }
        } catch (e) {
          await abortPreCreazione();
          throw httpError(500, `richiesta sessione nuova non consumabile in sicurezza: ${e.message}`,
            null, { phase: 'preflight', code: 'VL_NEW_SESSION_UNSAFE' });
        }
      }
    }

    // vl bootstrap claim, PER LAUNCH: EVERY launch (`up`: generation 0 of a
    // new supervisor) delivers cell.prompt exactly once, whether the VL host
    // is new or ALREADY existing. The decision is taken HERE, in the
    // preflight (claim root in hand, TUI not yet started) and travels
    // already taken in the payload, keyed by the launchId of this launch.
    // The supervisor recomputes nothing: it delivers ONLY with
    // claim valida a generation 0; i respawn (generation > 0) non riconsegnano
    // mai. L'idoneità NON dipende più da fresh-host/rotazione. Fail-closed su
    // ogni dubbio.
    if (engine.managed && engine.managed.client === 'vl' && vlClaim) {
      vlBootstrapDecision = decideVlBootstrap({
        home,
        ownerInstanceId: vlClaim.owner,
        cellId: cell.id,
        launchId: generazione,
        now: nowMs(),
      });
      if (!vlBootstrapDecision || vlBootstrapDecision.eligible !== true) {
        const log = typeof cfg.log === 'function' ? cfg.log : console.warn;
        log(`fleet vl ${cell.id}: bootstrap saltato (${vlBootstrapDecision ? vlBootstrapDecision.reason : 'claim-unavailable'})`);
      }
    }

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
        if (!registrato) {
          // Rifiuto anche quando l'ordine delle revisioni non e'
          // stabilibile (una copia del registro illeggibile, o un suo record
          // non valido): una scrittura ammessa sopra il solo massimo
          // LEGGIBILE potrebbe restare sotto una revisione nascosta, e la
          // copia tornando leggibile rispristinerebbe un lancio superato.
          // In quel caso nessuna locazione e' stata toccata: lo stato
          // visibile del lancio precedente resta intatto, ora e dopo un
          // riavvio.
          await abortPreCreazione();
          throw httpError(500,
            `registro dei lanci non impegnabile in sicurezza per la cella ${cell.id} (non scrivibile, o ordine delle revisioni non determinabile): lancio rifiutato`,
            null, { phase: 'preflight', code: 'LAUNCH_REGISTRY_UNWRITABLE' });
        }
        if (!esito.primario) {
          log(`nexuscrew fleet: launch registry not written for cell ${cell.id} (primary location; the spare location keeps the current launch identity durable)`);
        } else if (!esito.riserva) {
          log(`nexuscrew fleet: launch registry spare not written for cell ${cell.id}`);
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
      lanciCorrenti.set(cell.tmuxSession, {
        launchId: generazione, canale: canaleLancio,
        // Fatto del lancio, preso dalla richiesta realmente ammessa: sopravvive
        // a una modifica successiva della definizione (non al riavvio del
        // demone: li' vale la prova del record).
        applicabile: launchEngine.promptMode === 'send-keys' && !!cell.prompt && promptDeliveryApplicable({
          client: engine.managed && typeof engine.managed.client === 'string' ? engine.managed.client : '',
          submit: launchEngine.submit, repromptOff: launchEngine.restartReprompt === false,
        }),
      });
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
    if (isVlNewSessionSupported(engine)) {
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
      await abortPreCreazione();
      throw httpError(500, 'identity launch subject non registrabile', null, {
        phase: 'launch-broker', code: 'IDENTITY_SUBJECT_UNAVAILABLE',
      });
    }
    // Canale di controllo (S3c): il token di questo lancio nasce qui e vive
    // SOLO nel payload (consegnato dal broker autenticato dal nonce one-shot)
    // e nel coordinatore. Il lease manager ne tiene l'HASH: i frame di
    // controllo in ingresso sono ammessi solo con la prova dell'hash.
    let controlChannel = null;
    if (leaseManager && typeof leaseManager.armControl === 'function') {
      const controlToken = crypto.randomBytes(32).toString('hex');
      const armed = leaseManager.armControl(cell.id, { launchId: generazione, token: controlToken });
      if (armed) controlChannel = { launchId: generazione, token: controlToken };
    }
    // Budget EFFETTIVI della consegna del prompt, calcolati UNA volta e usati
    // sia dal payload sia dal tetto dell'osservatore diagnostico: una sola
    // sorgente, nessuna ricomposizione da cfg.
    budgetPrompt = launchEngine.promptMode === 'send-keys' && cell.prompt ? {
      readyMs: Math.max(0, Math.min(30000, Number(cfg.sendKeysReadyMs) || readyMs)),
      readyWaitMs: Math.max(0, Math.min(120000, Number(cfg.bootstrapReadyWaitMs) || 15000)),
      mcpReadiness: engine.managed && engine.managed.client === 'claude'
        ? buildMcpReadinessPayload(cell, realCwd, home, cfg) : null,
    } : null;
    ticket = await launchBroker.issue({
        command: child.command,
        args: child.args,
        env: {
          // Base ereditata delle celle interattive: TERM di ripiego e niente
          // NO_COLOR/FORCE_COLOR non scelti. Poi l'env dell'engine, che vince.
          ...baseEreditataCella(minimalEnv()),
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
        // Token del canale di controllo del ciclo di stop: nel payload (canale
        // del nonce one-shot), mai nel child env, mai nel lease manager in chiaro.
        ...(controlChannel ? { control: controlChannel } : {}),
        // Canale di attivita' verso il supervisore: il riavvio del client
        // avviene DENTRO lo stesso lancio, quindi la generazione non cambia e
        // l'unico modo di invalidare lo stato del client morto e' che sia
        // cell-exec a dichiararlo. Presente solo dove gli hook sono davvero
        // iniettati (`activityDir` lo dice): senza canale non c'e' niente da
        // invalidare.
        ...(activityCanale ? { activity: activityCanale } : {}),
        // Canale del record del prompt: SEMPRE presente quando il riferimento
        // privato e' qualificabile, hooks attivi o no (C4: l'esito della
        // consegna supervisionata non dipende dagli hook del client). Il
        // supervisore lo valida alla ricezione; assente = chiamante vecchio.
        ...(promptOutcomeCanale ? { promptOutcome: promptOutcomeCanale } : {}),
        // Sessione nuova esplicita (vl): la decisione viaggia GIÀ PRESA nel
        // payload, il supervisore non la ricalcola e non rilegge mai il
        // marcatore. cell-exec applica la sessione nuova SOLO alla generazione 0
        // (tramite env per launcher-env o argv --new per managed-vl): i suoi
        // restart non ripetono la rotazione.
        ...(vlNewSessionApplied ? { vlNewSession: true } : {}),
        ...(launchEngine.newSessionEnv === true ? { newSessionTransport: 'launcher-env' } : {}),
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
            readyMs: budgetPrompt.readyMs,
            // kimi.*, ALL claude.* and vl.* have at-most-once classified
            // delivery; custom send-keys engines keep the legacy reinject
            // without Enter (0.8.47).
            client: engine.managed && (engine.managed.client === 'kimi' || engine.managed.client === 'claude' || engine.managed.client === 'vl')
              ? engine.managed.client : '',
            // vl only: the claim decision, ALREADY TAKEN in the preflight.
            // eligible true = incarico di consegnare il bootstrap a generation 0;
            // eligible false = skip esplicito a OGNI generazione, motivo bounded,
            // pubblicato subito (nessuna attesa readiness, nessun timeout fittizio).
            ...(engine.managed && engine.managed.client === 'vl' ? {
              vlBootstrap: {
                eligible: !!(vlBootstrapDecision && vlBootstrapDecision.eligible === true),
                reason: (vlBootstrapDecision && vlBootstrapDecision.reason) || 'no-proof',
                ...(vlBootstrapDecision && vlBootstrapDecision.eligible === true && vlBootstrapDecision.claimPath ? {
                  claimPath: vlBootstrapDecision.claimPath,
                } : {}),
              },
            } : {}),
            // Opt-in F4: il supervisore deve applicare lo STESSO contratto ai
            // restart (generazioni > 0). Decide la definizione, non il
            // supervisore: qui viaggia gia' preso.
            ...(launchEngine.submit === 'enter' ? { submit: true } : {}),
            // Policy di reinvio (restartReprompt): viaggia DENTRO il payload
            // validato e vale SOLO per le generazioni > 0. `false` = nessun
            // reinvio ai restart, e la consegna della generazione 0 passa al
            // supervisore (paste delimitato senza Enter). Assente/`true` =
            // comportamento di oggi, chiave non scritta.
            ...(launchEngine.restartReprompt === false ? { reprompt: false } : {}),
            readyWaitMs: budgetPrompt.readyWaitMs,
            // Gate readiness MCP solo per le claude.* (budget composto col
            // readyWaitMs: tetto MCP dal launch, avvio degradato visibile).
            ...(budgetPrompt.mcpReadiness ? { mcpReadiness: budgetPrompt.mcpReadiness } : {}),
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
      await abortPreCreazione();
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
    // Il lancio vive sul server tmux CONDIVISO, una sessione per lancio: il
    // pathname (socketLancio) e' quello che tmux risolve da solo, calcolato da
    // sharedTmuxSocketPath() prima dei preparativi e scritto nel record: stessa
    // fonte, stesso risultato, per ogni superficie senza -S (sessionExists,
    // paste, terminale PWA, `tmux ls`). Nessuna directory da creare: la dir del
    // socket appartiene a tmux. Il server e' garantito vivo e protetto da
    // ensureProtection() (inizio di upSerializzato e, di nuovo, subito prima
    // della creazione qui sotto): una new-session su un socket senza server ne
    // avvierebbe uno nudo, senza exit-empty off e senza l'alias kill-server
    // negato.
    let canaleAperto = null;
    let sessionId = '';
    let windowId = '';
    let paneId = '';

    const cleanupLaunch = async () => {
      const stableSessionId = sessionId || '';
      if (stableSessionId && canaleAperto && !canaleAperto.morto()) {
        // Solo la connessione gia' aperta da questo lancio. Un client nuovo
        // parlerebbe al pathname del socket, che un altro server puo' occupare.
        await canaleAperto.killSession(stableSessionId);
      } else {
        // Senza continuita' dimostrabile non si apre un client tmux e non si
        // risale l'id con un display-message nuovo. La sessione, se c'e', resta
        // dov'e': traccia dichiarata, nessun comando distruttivo.
        const log = typeof cfg.log === 'function' ? cfg.log : console.warn;
        log(`fleet cleanup del lancio fallito per ${cell.id}: nessun canale posseduto, nessuna sessione fermata`);
      }
      // Dopo l'inizio della creazione la lease non si scioglie MAI qui:
      // «non ho ricevuto la risposta» non e' «la sessione non esiste», e la
      // risposta persa dopo la materializzazione e' indistinguibile da un
      // rifiuto netto. Il record incerto resta come traccia durevole e la
      // barriera della root si scioglie solo con una prova correlata di
      // chiusura (down), mai da una variabile che dice solo «ho ricevuto o
      // no una risposta». Prima che la creazione INIZI il rilascio resta
      // lecito: nessuna sessione puo' essere nata.
      const trattieni = !rifiutoProvato
        && (sessioneCreata || creazioneIniziata || creatingIncerto)
        && (vlClaim || !canaleAperto);
      // Fine lancio = revoca del ticket di controllo: nessun frame del canale
      // e' piu' ammesso per questo launchId.
      if (leaseManager && typeof leaseManager.revokeControl === 'function') {
        try { leaseManager.revokeControl(cell.id); } catch (_) {}
      }
      if (canaleAperto) {
        canaleAperto.chiudi();
        canaliControllo.delete(cell.tmuxSession);
        canaleAperto = null;
      }
      try { await launchBroker.revoke?.(ticket.nonce); } catch (_) { /* best-effort */ }
      // Il lancio e' chiuso senza barriere da tenere: claim esatta, poi il
      // record del nostro lancio. Altrimenti il record resta com'e'.
      if (!trattieni) await abortPreCreazione();
    };

    // Creazione della sessione sul canale di controllo posseduto. Dal
    // momento in cui questa chiamata parte, l'esito non e' piu' «la sessione
    // non esiste di certo»: la risposta puo' perdersi dopo la
    // materializzazione. creazioneIniziata marca quel confine per il
    // cleanup: da qui in poi la barriera della root non si scioglie senza
    // prova correlata di chiusura.
    // Sul confine, il server condiviso torna garantito: la protezione
    // all'inizio di upSerializzato puo' essere sopravanzata da una morte del
    // server nelle attese intercorse, e una new-session su socket senza
    // server avvierebbe un server NUDO condiviso con tutte le superfici.
    // Un rifiuto qui percorre lo STESSO cleanup di una creazione rifiutata:
    // il record intent resta alle stesse condizioni, niente resta a meta'.
    if (typeof ensureProtection === 'function') {
      try {
        await ensureProtection();
      } catch (protErr) {
        await cleanupLaunch();
        throw httpError(500,
          `server tmux condiviso non proteggibile per la cella ${cell.id}: ${redactSecrets(String((protErr && protErr.message) || protErr), launchEngine, cell)}`,
          null, { phase: 'new-session', code: 'SHARED_SERVER_UNPROTECTED' });
      }
    }
    // Ultimo await prima dello spawn: la protezione puo' cambiare la root.
    if (improntaRadice) {
      const oraRadice = qualificaAssenzaRadice(vlClaim.root, vlCellBaseDir(home, vlClaim.owner, cell.id));
      if (!stessaImprontaRadice(improntaRadice, oraRadice)) {
        await cleanupLaunch();
        throw httpError(500,
          `radice host vl cambiata prima dello spawn per la cella ${cell.id}: avvio rifiutato`,
          null, { phase: 'new-session', code: 'HOST_UNRESOLVABLE' });
      }
    }
    // `creating` si impegna e si sincronizza PRIMA della new-session. Se il
    // commit non e' attestato la new-session non si invoca: con l'errore
    // prima del rename il record e' ancora `prepared` e si puo' chiudere il
    // lancio; con l'errore DOPO il rename la fase nuova puo' essere gia'
    // visibile, non si torna indietro e la barriera resta.
    const impegnoCreating = launchTarget.avanza(targetRoot, cell.tmuxSession, {
      launchId: generazione, da: 'prepared', a: 'creating', ora: nowMs(),
    });
    if (!impegnoCreating || impegnoCreating.ok !== true) {
      if (impegnoCreating && impegnoCreating.codice === 'scrittura' && impegnoCreating.pubblicato === 'incerto') {
        creatingIncerto = true;
        esitiIncerti.add(cell.tmuxSession);
      }
      await cleanupLaunch();
      throw httpError(500,
        `record del lancio non scrivibile per la cella ${cell.id}: lancio rifiutato prima della creazione`,
        null, { phase: 'new-session', code: 'LAUNCH_TARGET_UNWRITABLE' });
    }
    creazioneIniziata = true;
    const creation = await tmuxControl.creaSessionePosseduta({
      tmuxBin,
      socket: socketLancio,
      sessionName: cell.tmuxSession,
      cwd: realCwd,
      nodeBin: process.execPath,
      cellHoldPath: CELL_HOLD,
      cellHoldArgs: [],
      env: minimalEnv(),
      prontaMs: 3000,
    });

    if (!creation || creation.ok !== true) {
      // Rifiuto PROVATO (frame %error completo, «duplicate session» per il
      // nome esatto): nessuna sessione NOSTRA e' nata e l'omonima e' estranea.
      // Prima del cleanup serve uno stato terminale DUREVOLE: se il processo
      // muore a meta' pulizia il record dice «abortito», non «creazione in
      // volo». Se quella scrittura non e' attestata, la barriera resta.
      if (creation && creation.rifiutoProvato === 'duplicate-session') {
        const chiusoDurevole = launchTarget.avanza(targetRoot, cell.tmuxSession, {
          launchId: generazione, da: 'creating', a: launchTarget.FASE_ABORTITA,
          campi: { abortReason: 'duplicate-session' }, ora: nowMs(),
        });
        if (chiusoDurevole && chiusoDurevole.ok === true) rifiutoProvato = true;
      }
      await cleanupLaunch();
      const dup = creation && creation.isDuplicate;
      const errMsg = creation && creation.err ? creation.err.message : 'creazione sessione fallita';
      const why = dup
        ? 'sessione già in esecuzione'
        : `tmux new-session failed: ${redactSecrets(errMsg, launchEngine, cell)}`;
      throw httpError(dup ? 409 : 500, why, null,
        { phase: 'new-session', code: dup ? 'SESSION_DUPLICATE' : 'NEW_SESSION_FAILED' });
    }

    sessioneCreata = true;
    canaleAperto = creation.canale;
    canaliControllo.set(cell.tmuxSession, canaleAperto);
    sessionId = creation.createdIds.sessionId;
    windowId = creation.createdIds.windowId;
    paneId = creation.createdIds.paneId;
    const log = typeof cfg.log === 'function' ? cfg.log : console.warn;
    log(`fleet control channel held for cell ${cell.id} (${sessionId})`);
    const sulCanale = async (tipo, args, timeoutMs = 2000) => {
      if (!canaleAperto || canaleAperto.morto()) {
        return { err: new Error('canale assente'), stdout: '', stderr: '' };
      }
      const r = await canaleAperto.chiama(tipo, args, timeoutMs);
      if (!r || r.ok !== true) {
        const testo = Array.isArray(r && r.testo) ? r.testo.join('\n') : '';
        return { err: new Error(testo || 'rifiutato'), stdout: testo, stderr: testo };
      }
      const testo = Array.isArray(r.testo) ? r.testo.join('\n') : '';
      return { err: null, stdout: testo, stderr: '' };
    };
    // Possesso del lancio: gli id restituiti da new-session e il socket su
    // cui e' nato il canale. Nessun client nuovo per rileggere pathname o pid.
    let pidServer = null;
    let pidPane = null;
    {
      const log = typeof cfg.log === 'function' ? cfg.log : console.warn;
      const identita = await sulCanale('display-message', ['-p', '-t', paneId, '#{pid}\t#{pane_pid}']);
      const parti = identita.stdout.trim().split(/\s+/);
      if (/^[0-9]+$/.test(parti[0])) pidServer = Number(parti[0]);
      if (parti.length > 1 && /^[0-9]+$/.test(parti[1])) pidPane = Number(parti[1]);
      // `created`: gli id VERI di tmux e l'identita' del PLACEHOLDER (pid e
      // nascita di cell-hold), in campi distinti da quelli del supervisore.
      // Il pid del placeholder non e' mai il supervisore: sparisce col respawn.
      const registrato = launchTarget.avanza(targetRoot, cell.tmuxSession, {
        launchId: generazione, da: 'creating', a: 'created',
        campi: {
          sessionId, windowId, paneId,
          serverPid: pidServer > 0 ? pidServer : null,
          serverStarttime: pidServer > 0 ? leggiStarttimeProc(pidServer) : null,
          holdPid: pidPane > 0 ? pidPane : null,
          holdStarttime: pidPane > 0 ? leggiStarttimeProc(pidPane) : null,
        },
        ora: nowMs(),
      });
      if (!registrato || registrato.ok !== true) {
        await cleanupLaunch();
        throw httpError(500,
          `record del lancio non scrivibile per la cella ${cell.id}: lancio rifiutato`,
          null, { phase: 'new-session', code: 'LAUNCH_TARGET_UNWRITABLE' });
      }
      log(`fleet launch target registered for cell ${cell.id} (${sessionId})`);
    }
    // Il marcatore del supervisore e lo schermo alternativo stanno sullo
    // stesso canale. Un rifiuto del marcatore non ferma il lancio.
    {
      const log = typeof cfg.log === 'function' ? cfg.log : console.warn;
      const marcato = await sulCanale('set-option', ['-p', '-t', paneId, NC_SUPERVISOR_OPT, '1']);
      if (marcato.err) {
        log(`fleet marcatore del pane supervisore non impostato per ${cell.id}; la cella resta non identificabile`);
      }
      const alternateSteps = alternateScreenArgs(cell.tmuxSession, cfg.alternateScreen);
      if (alternateSteps) {
        for (const args of alternateSteps) {
          const configured = await sulCanale(args[0], args.slice(1));
          if (configured.err) log(`fleet alternate-screen setup failed for ${cell.id}; continuing`);
        }
      }
    }
    // Arma remain-on-exit window-local sul @N: la finestra esiste (il placeholder
    // la tiene viva), quindi niente race con un child che termini nel frattempo.
    const arm = await sulCanale('set-option', ['-w', '-t', windowId, 'remain-on-exit', 'on']);
    if (arm.err) {
      await cleanupLaunch();
      throw httpError(500,
        `tmux set-option remain-on-exit failed: ${redactSecrets(arm.stderr.trim() || arm.err.message, launchEngine, cell)}`,
        null, { phase: 'new-session', code: 'NEW_SESSION_FAILED' });
    }
    // Sostituisci il placeholder con il vero child (cell-exec via broker) sul %N.
    const respawn = await sulCanale('respawn-pane',
      ['-k', '-c', realCwd, '-t', paneId, tmuxChild.command, ...tmuxChild.args]);
    if (respawn.err) {
      // respawn failed after issue(): the nonce must be revoked/consumed first
      // before surfacing the error, then cleanup of the panel session.
      await cleanupLaunch();
      throw httpError(500,
        `tmux respawn-pane failed: ${redactSecrets(respawn.stderr.trim() || respawn.err.message, launchEngine, cell)}`,
        null, { phase: 'new-session', code: 'NEW_SESSION_FAILED' });
    }
    // Refresh the supervisor identity after the successful respawn: the
    // panePid recorded so far is the placeholder's (cell-hold.js); with
    // respawn-pane -k the real supervisor process has just been born. When
    // the record names a placeholder supervisor, the launch may only be
    // declared up if the real identity is captured again AND committed
    // durably: a lost or incomplete reply, or a refused/failed record
    // update, is an explicit failure, never a success riding on the stale
    // pid. No new client is opened to recover the identity here: the socket
    // may have been replaced by another server.
    {
      const identitaPost = await sulCanale('display-message', ['-p', '-t', paneId, '#{pid}\t#{pane_pid}']);
      const partiPost = identitaPost.err ? [] : identitaPost.stdout.trim().split(/\s+/);
      let pidServerPost = null;
      let pidPanePost = null;
      if (/^[0-9]+$/.test(partiPost[0])) pidServerPost = Number(partiPost[0]);
      if (partiPost.length > 1 && /^[0-9]+$/.test(partiPost[1])) pidPanePost = Number(partiPost[1]);
      if (pidPanePost) {
        // La nascita del supervisore REALE, letta da /proc mentre il pid e'
        // un fatto appena osservato: e' l'identita' che permettera' di
        // provare (o confutare) la morte di QUEL processo in un down
        // successivo, anche dopo la perdita del canale. Se /proc non la
        // misura il campo resta assente: il record e' `attested` ma nessuno
        // sblocco si appoggera' al solo pid.
        const nascitaPanePost = leggiStarttimeProc(pidPanePost);
        const serverPidPost = pidServerPost || pidServer;
        let registratoPost = false;
        let errorePost = null;
        try {
          const attestato = launchTarget.avanza(targetRoot, cell.tmuxSession, {
            launchId: generazione, da: 'created', a: 'attested',
            campi: {
              panePid: pidPanePost,
              ...(Number.isFinite(nascitaPanePost) ? { paneStarttime: nascitaPanePost } : {}),
              ...(serverPidPost > 0 ? { serverPid: serverPidPost } : {}),
            },
            ora: nowMs(),
          });
          registratoPost = !!(attestato && attestato.ok === true);
        } catch (e) {
          errorePost = e;
        }
        if (!registratoPost) {
          // Conservative record first, then stop what this launch owns; a
          // cleanup failure must not mask the launch failure itself.
          try { launchTarget.marcaIncerto(targetRoot, cell.tmuxSession); } catch (_) {}
          try { await cleanupLaunch(); } catch (_) {}
          const perchePost = errorePost
            ? `aggiornamento post-respawn non committibile (${redactSecrets(String(errorePost.message || errorePost), launchEngine, cell)})`
            : 'aggiornamento post-respawn rifiutato';
          throw httpError(500,
            `record del lancio non scrivibile per la cella ${cell.id}: ${perchePost}; lancio rifiutato`,
            null, { phase: 'new-session', code: 'LAUNCH_TARGET_UNWRITABLE' });
        }
        pidPane = pidPanePost;
      } else {
        // Il PID del supervisore REALE non e' stato letto dopo il respawn: il
        // lancio non puo' essere dichiarato up, e un supervisore del quale non
        // si e' neppure letto il PID non diventa `attested`. Il pid del
        // placeholder (se noto) e' un'altra cosa e non lo sostituisce. Il
        // cleanup passa dal solo canale posseduto gia' aperto; il record
        // resta incerto e, se la sessione non si ferma, la barriera resta.
        try { launchTarget.marcaIncerto(targetRoot, cell.tmuxSession); } catch (_) {}
        try { await cleanupLaunch(); } catch (_) {}
        const perchePost = identitaPost.err
          ? `identita' non leggibile (${redactSecrets(identitaPost.err.message, launchEngine, cell)})`
          : 'risposta senza il pane_pid del supervisore';
        throw httpError(500,
          `identita' del supervisore non confermata dopo il respawn per la cella ${cell.id}: ${perchePost}`,
          null, { phase: 'new-session', code: 'POST_RESPAWN_IDENTITY_UNKNOWN' });
      }
    }

    // `tmux new-session -d` can return 0 even when the launched CLI exits a
    // moment later (missing login, bad model, incompatible provider).  Without
    // this readiness gate the PWA reported success and then showed nothing.
    // Always verify liveness, including cells without a system prompt.

    const readiness = paneId.startsWith('%')
      ? await waitStablePane(tmuxBin, paneId, { env: minimalEnv(), readyMs, socket: socketLancio })
      : { alive: await waitAlive(tmuxBin, cell.tmuxSession, { env: minimalEnv(), readyMs, socket: socketLancio }), status: null, target: null };
    if (!readiness.alive) {
      let diagnostic = '';
      if (readiness.target) {
        const captured = await tmuxExec(tmuxBin,
          ['-S', socketLancio, 'capture-pane', '-p', '-S', '-80', '-t', readiness.target], { env: minimalEnv(), timeoutMs: 2000 });
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
        ['-S', socketLancio, 'set-option', '-w', '-t', readiness.target, 'remain-on-exit', 'off'], { env: minimalEnv(), timeoutMs: 2000 });
    }

    // vl content-readiness (VL 0.4 idle faces). NEVER fail-closed: if
    // entro il timeout nessuna faccia idle compare DEGRADA e procede come se
    // pronta (una cella che parte oggi deve partire anche domani), lasciando
    // traccia nel risultato. vlPaneReadiness e' il punto di innesto sostituibile
    // quando la readiness si misurera' sul socket (adapter), non sul pane. Solo
    // vl: gli altri client non hanno content-readiness da pane.
    // NO TWO FULL WAITS IN SERIES: when classified delivery is active (vl
    // with prompt) the supervisor report covers readiness — here we wait
    // only on the path without delivery.
    let readinessDegraded = false;
    const vlDeliveryActive = !!(engine.managed && engine.managed.client === 'vl'
      && launchEngine.promptMode === 'send-keys' && cell.prompt);
    if (engine.managed && engine.managed.client === 'vl' && readiness.target && !vlDeliveryActive) {
      const vlReady = await vlPaneReadiness(tmuxBin, readiness.target, { env: minimalEnv(), socket: socketLancio });
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
    //  - engine custom con policy `restartReprompt: false`: stesso predicato —
    //    la gen0 e' paste-only del supervisore e le gen>0 non ricevono nulla;
    //    il runtime NON digita (zero injectPrompt), legge solo l'esito bounded.
    //  - engine custom promptMode 'send-keys' senza opt-in: injectPrompt legacy
    //    (bracketed paste SENZA Enter, contratto invariato), target %N esatto.
    let prompt = null;
    let actionRequired = null;
    let mcpDegraded = null;
    let consegnaSupervisionata = null;
    if (launchEngine.promptMode === 'send-keys' && cell.prompt) {
      const managedClient = engine.managed && typeof engine.managed.client === 'string' ? engine.managed.client : '';
      const managedProvider = engine.managed && typeof engine.managed.provider === 'string' ? engine.managed.provider : '';
      const classified = managedClient === 'kimi' || managedClient === 'claude' || managedClient === 'vl';
      // Anche l'opt-in `submit: 'enter'` e' consegnato dal SUPERVISORE per
      // tutte le generazioni, la 0 compresa. Qui si legge solo l'esito bounded
      // dal pane: niente paste e niente Enter dal runtime, quindi niente
      // secondo proprietario e niente delivery vecchia che sopravvive a un
      // restart sullo stesso %N. La policy `restartReprompt: false` entra
      // nello STESSO predicato: anche per lei il runtime non digita nulla.
      const submitOptIn = launchEngine.submit === 'enter';
      const repromptOff = launchEngine.restartReprompt === false;
      if (classified || submitOptIn || repromptOff) {
        // Consegna POSSEDUTA dal supervisore: il runtime non digita e non
        // aspetta piu' il report volatile dentro il lock. Dopo le attestazioni
        // sincrone (readiness, registrazione del peer VL) si fa UNA lettura
        // del canonico (vedi sotto, `consegnaSupervisionata`).
        // Tetto monotono dell'osservatore: i budget EFFETTIVI del payload
        // (stessa composizione del pending 2b: ritardo di readiness + finestra
        // di bootstrap + MCP solo se il gate ha server attesi, con il suo
        // fallback 20000, + 2000 di tolleranza), ancorato al punto del lancio
        // PRIMA delle attese. Nessun cap arbitrario.
        const mr = budgetPrompt && budgetPrompt.mcpReadiness;
        const mcpPrevisto = mr && Array.isArray(mr.expectedServers) && mr.expectedServers.length > 0
          ? Math.max(0, Number(mr.budgetMs) || 20000) : 0;
        consegnaSupervisionata = {
          classified, managedClient, managedProvider,
          ancora: ancoraLancio,
          tettoMs: (budgetPrompt ? budgetPrompt.readyMs : 400) + (budgetPrompt ? budgetPrompt.readyWaitMs : 15000)
            + mcpPrevisto + 2000,
        };
      } else {
        const target = paneId.startsWith('%') ? paneId : `=${cell.tmuxSession}`;
        prompt = await injectPrompt(tmuxBin, cell.tmuxSession, cell.prompt, {
          env: minimalEnv(),
          readyMs: cfg.sendKeysReadyMs != null ? cfg.sendKeysReadyMs : readyMs,
          target,
          engine: launchEngine, cell, // to redact the reason if the paste-buffer fails
          socket: socketLancio,
        });
      }
    }
    // Registration of the peer host identity, AT UP TIME and BEFORE the
    // launch is declared successful. The PINNED binary
    // interroga l'host della root (anche uno preesistente): la sua
    // `peer_identity` dev'essere `verified` e la tuple viene PERSISTITA nel
    // contesto di QUESTO launchId. Senza verified il lancio e' FALLITO e
    // visibile: nessun «isolato» dedotto da declared_pid, la sessione appena
    // creata viene fermata (quel che il lancio possiede) e la claim della
    // root resta dov'e' — un host non attestabile non si aggira con un
    // secondo tentativo che lo raggiungerebbe di nuovo; lo sblocco e' la
    // procedura esplicita dell'operatore.
    if (vlRegistrazione) {
      const registrazione = await registraIdentitaPeer({
        bin: vlRegistrazione.bin,
        env: envDalRecord(vlRegistrazione.contesto),
        root: vlRegistrazione.root,
        stateDir: vlRegistrazione.stateDir,
        record: vlRegistrazione.contesto,
        profile: profiloDaArgv(launchEngine.args),
        instanceId: /^[a-f0-9]{32}$/.test(vlRegistrazione.owner) ? vlRegistrazione.owner : null,
        ...(typeof cfg.log === 'function' ? { log: cfg.log } : {}),
      });
      if (!registrazione.ok) {
        try { await cleanupLaunch(); } catch (_) { /* la sessione resta tracciata dal record */ }
        cache = { ...cache, at: 0 };
        throw httpError(500,
          `identita' del peer host vl non attestabile per la cella ${cell.id} (${registrazione.motivo}): avvio rifiutato`,
          { motivo: registrazione.motivo }, { phase: 'readiness', code: 'VL_PEER_UNATTESTED' });
      }
    }
    if (consegnaSupervisionata) {
      // UNA lettura del canonico, DOPO le attestazioni sincrone e senza attesa
      // del report: terminale gia' scritto -> tupla; pending valido -> pending;
      // altrimenti unknown. Stesso compositore di cellStatus.
      let out = null;
      try {
        out = await consegnaPromptCorrente({
          cellId, sessione: cell.tmuxSession, viva: true, chiusuraAttestata: false, ipotesi: true,
        });
      } catch (_) { out = null; }
      const delivery = out && out.delivery ? out.delivery : { state: 'unknown' };
      prompt = delivery;
      const trasporto = out && out.terminalPersisted === true ? consegnaDaCanonico(delivery) : null;
      if (consegnaSupervisionata.managedClient === 'vl' && trasporto) {
        vlBootstrapOutcome = vlBootstrapOutcomeFor(trasporto);
        if (readiness.target && trasporto.state === 'skipped-vl-bootstrap' && !readinessDegraded) {
          const vlReady = await vlPaneReadiness(tmuxBin, readiness.target, { env: minimalEnv(), socket: socketLancio });
          if (vlReady.degraded) readinessDegraded = true;
        }
      }
      actionRequired = consegnaSupervisionata.classified && trasporto
        ? actionRequiredFor(consegnaSupervisionata.managedClient, consegnaSupervisionata.managedProvider, trasporto)
        : null;
      // Osservazione MCP accessoria, solo se il proprietario la conosce per la
      // STESSA tupla gia' alla risposta; mai attesa, mai ricavata dal pane.
      if (out && out.mcp && out.mcp.state === 'degraded') {
        mcpDegraded = { failed: [...out.mcp.failed], pending: [...out.mcp.pending] };
      }
      // Osservatore diagnostico: registrato qui (token del ciclo), AVVIATO da
      // up()/restart() dopo la risposta e fuori dalla sezione serializzata.
      if (holder && cfg.diagnostics && typeof cfg.diagnostics.record === 'function') {
        holder.osservatore = creaOsservatore({
          cellId, sessione: cell.tmuxSession, ancora: consegnaSupervisionata.ancora,
          tettoMs: consegnaSupervisionata.tettoMs, epoca: holder.epoca,
        });
      }
    }
    cache = { ...cache, at: 0 };              // invalida: prossimo status rilegge tmux
    vlClaim = null;
    return {
      ok: true, cell: cellId, session: cell.tmuxSession, prompt,
      ...(actionRequired ? { actionRequired } : {}),
      ...(readinessDegraded ? { readinessDegraded: true } : {}),
      ...(mcpDegraded ? { readinessDegraded: true, mcpDegraded } : {}),
      // Per-cell prompt not delivered to a vl cell (old runtime or
      // unwritable file). Strict boolean like readinessDegraded: the
      // payload may come from a federated node and the text is local i18n.
      ...(launchEngine.vlPromptDegraded ? { vlPromptDegraded: true } : {}),
      // Bounded outcome of the initial vl prompt delivery of THIS launch
      // (closed-enum states, local i18n text in the UI).
      ...(vlBootstrapOutcome ? { vlBootstrap: vlBootstrapOutcome } : {}),
      // Sessione nuova esplicita applicata a QUESTO lancio (generazione 0).
      ...(vlNewSessionApplied ? { vlNewSession: true } : {}),
    };
  }

  // PERCORSO DI RICONCILIAZIONE CONDIVISO (P1-b/P1-c). Un solo valutatore e un
  // solo percorso di chiusura, riusati dal down senza canale, dal recupero
  // nella stessa down e dagli endpoint espliciti (launch-state/reconcile):
  // cosi' il giudizio non diverge fra le porte d'ingresso. La factory incapsula
  // le chiusure che prima vivevano dentro downSerializzato — budget, fasi
  // host, valutatore, barriera passiva, fotografia/inalterazione del record e
  // commit — parametrizzate SOLO su cella, deadline e «lancio in corso?».
  function creaPercorsoRiconciliazione(cell, { scadenzaTotale, lancioInCorso = () => false } = {}) {
    const targetRoot = filesRootDi(cfg);
    const budgetFinito = () => cooldownNow() >= scadenzaTotale;
    const timeoutResiduo = () => {
      const resta = scadenzaTotale - cooldownNow();
      return Number.isFinite(resta) && resta > 0 ? resta : 0;
    };
    const faseHostDown = async (launchId, famiglia) => {
      const owner = typeof identityOwnerInstanceId === 'function'
        ? identityOwnerInstanceId() : (identityOwnerInstanceId || 'local');
      let base = null;
      try { base = vlCellBaseDir(home, owner, cell.id); } catch (_) { base = null; }
      const ctx = base ? leggiContesto(base) : null;
      const dalLancio = !!(ctx && !ctx.errore && ctx.launchId === launchId);
      if (!dalLancio) {
        // La famiglia e' quella REGISTRATA AL LANCIO: un errore di lettura
        // del contesto non trasforma mai il lancio in not-vl, e l'engine
        // aggiornato della definizione non e' prova del lancio vecchio.
        if (famiglia === 'other') {
          // not-vl autorizza la chiusura. Scaduta la deadline della stessa
          // down, quel via libera non vale piu': il record non si toglie dopo.
          if (budgetFinito()) return { outcome: 'host-unresolvable' };
          return { outcome: 'not-vl' };
        }
        return { outcome: 'host-unresolvable' };
      }
      if (ctx.version !== 2 || !ctx.hostIdentity) return { outcome: 'host-unresolvable' };
      const pinDir = dirPin(home, owner, cell.id, ctx.vlBinSha256);
      const pin = verificaPin(pinDir ? path.join(pinDir, 'vl') : '', ctx.vlBinSha256);
      if (!pin.ok) return { outcome: 'host-identity-changed' };
      // Isolation is computed by the RUNTIME. A status probe on
      // stato sul binario pinnato; se un host c'e', si osserva nel KERNEL il
      // peer dichiarato e si confronta con la tuple registrata nel contesto
      // v2 al primo sguardo del lancio (identita' mutata, pid riusato o
      // namespace diverso restano «ignoto»). Il giudizio ternario viaggia a
      // fermaHost dentro lo STESSO budget monotono, con la riserva del probe
      // finale gia' contata. I seams servono solo ai test del runtime: la
      // produzione legge /proc.
      const seamsHost = cfg.vlIsolationSeams || {};
      const residuoHost = Math.max(0, scadenzaTotale - cooldownNow());
      const quali = await qualificaIsolamentoHost({
        stateDir: base,
        record: ctx,
        bin: pin.path,
        instanceId: /^[a-f0-9]{32}$/.test(owner) ? owner : null,
        budgetMs: residuoHost,
        monoNow: cooldownNow,
        ...(typeof seamsHost.osservaPeer === 'function' ? { osservaPeer: seamsHost.osservaPeer } : {}),
        ...(typeof seamsHost.identitaNodo === 'function' ? { identitaNodo: seamsHost.identitaNodo } : {}),
        ...(typeof seamsHost.identitaCoordinatore === 'function' ? { identitaCoordinatore: seamsHost.identitaCoordinatore } : {}),
        ...(typeof cfg.log === 'function' ? { log: cfg.log } : {}),
      });
      const esito = await fermaHost({
        record: quali.record, bin: pin.path, budgetMs: quali.residuoMs, monoNow: cooldownNow,
        deadlineAt: scadenzaTotale,
        isolamento: quali.isolamento, probeIniziale: quali.probe,
      });
      if (esito.outcome === 'host-stop-failed'
        && (esito.code === 'IDENTITY_UNKNOWN' || esito.code === 'HOST_IN_GROUP')) {
        esito.motivoIsolamento = quali.motivo;
      }
      return esito;
    };
    const chiudiHostPoiLease = async (launchId, famiglia, ancoraValido = null) => {
      const hostEsito = await faseHostDown(launchId, famiglia);
      const pulito = hostEsito.outcome === 'not-vl'
        || hostEsito.outcome === 'host-stopped-clean'
        || hostEsito.outcome === 'host-already-stopped';
      if (!pulito) {
        // I rifiuti protetti dello stop expected hanno un CODICE LORO, bounded
        // (parola della lista chiusa di vl): cosi' l'operatore vede peer_mismatch
        // e peer_unknown nell'esito API, come gli altri esiti del ciclo peer/stop.
        const code = hostEsito.outcome === 'host-identity-changed' ? 'HOST_IDENTITY_CHANGED'
          : hostEsito.outcome === 'host-unresolvable' ? 'HOST_UNRESOLVABLE'
            : ESITI_STOP_ATTESTATI[hostEsito.reason] || 'HOST_STOP_FAILED';
        throw httpError(500, `host vl non fermo (${hostEsito.outcome})`,
          { outcome: hostEsito.outcome, ...(hostEsito.reason ? { reason: hostEsito.reason } : {}) },
          { phase: 'teardown', code });
      }
      // Il record puo' essere cambiato durante l'host-stop: la claim si rilascia
      // solo se la fotografia delle prove vale ancora.
      if (ancoraValido && !ancoraValido()) {
        throw httpError(409,
          `down rifiutato per la cella ${cell.id}: il record del lancio e' cambiato durante lo stop dell'host (claim intatta)`,
          null, { phase: 'teardown', code: 'IDENTITY_UNVERIFIED' });
      }
      await rilasciaRadiceDown(launchId, famiglia);
      return hostEsito.outcome;
    };
    const rilasciaRadiceDown = async (launchId, famiglia) => {
      if (budgetFinito()) {
        throw httpError(500,
          `down incompleto per la cella ${cell.id}: budget scaduto prima del rilascio della root`,
          null, { phase: 'teardown', code: 'STOP_UNKNOWN' });
      }
      const owner = typeof identityOwnerInstanceId === 'function'
        ? identityOwnerInstanceId() : (identityOwnerInstanceId || 'local');
      let dalRecord = null;
      let dalLancio = false;
      try {
        const ctx = leggiContesto(vlCellBaseDir(home, owner, cell.id));
        if (ctx && !ctx.errore && ctx.launchId === launchId) {
          dalRecord = ctx.serverRoot;
          dalLancio = true;
        }
      } catch (_) { dalRecord = null; }
      if (!dalLancio && famiglia !== 'vl') return;
      const root = dalRecord || radiceServer(home, owner, cell.id);
      if (!root || typeof launchId !== 'string') return;
      const residuoRelease = Math.max(0, scadenzaTotale - cooldownNow());
      const esito = await rilascia({
        home, root, launchId, ownerInstanceId: owner, cellId: cell.id, budgetMs: residuoRelease,
      });
      if (esito.outcome !== 'released' && esito.outcome !== 'not-held') {
        throw httpError(500, `lease della root vl non rilasciata (${esito.outcome})`,
          { outcome: esito.outcome }, { phase: 'teardown', code: 'CLAIM_UNCERTAIN' });
      }
    };
    // L'esito della persistenza si VERIFICA: se il marker non arriva su disco,
    // l'incertezza non evapora — la guardia in-process la tiene bloccante.
    const segnaIncerto = () => {
      if (!targetRoot) {
        esitiIncerti.add(cell.tmuxSession);
        return false;
      }
      const scritto = launchTarget.marcaIncerto(targetRoot, cell.tmuxSession) === true;
      if (!scritto) esitiIncerti.add(cell.tmuxSession);
      return scritto;
    };

    // Marcatura CONDIZIONATA al lancio: `marcaIncerto` scrive per nome di
    // sessione, quindi se il record e' stato sostituito durante un'attesa
    // segnerebbe il lancio NUOVO. Vale anche sui percorsi eccezionali: un
    // fallimento tardivo non deve scrivere sul lancio che non e' il nostro.
    const segnaIncertoDelLancio = (launchId) => {
      if (!targetRoot) {
        esitiIncerti.add(cell.tmuxSession);
        return false;
      }
      if (typeof launchId !== 'string' || !launchId) return false;
      const corrente = launchTarget.leggi(targetRoot, cell.tmuxSession);
      if (!corrente || corrente.stato !== 'presente'
        || !corrente.record || corrente.record.launchId !== launchId) {
        return false;
      }
      const scritto = launchTarget.marcaIncerto(targetRoot, cell.tmuxSession) === true;
      if (!scritto) esitiIncerti.add(cell.tmuxSession);
      return scritto;
    };
    // Chiusura pulita del lancio: il record va via e la guardia in-process si
    // scioglie con lui. Un fallimento della rimozione durevole non dichiara il
    // lancio chiuso e mantiene l'incertezza.
    // La rimozione e' CONDIZIONATA al lancio: se il record e' stato sostituito
    // durante un'attesa, `rimuovi` per nome cancellerebbe il lancio NUOVO.
    const chiudiLancioPulito = (launchId) => {
      const rimosso = targetRoot
        ? launchTarget.rimuoviDelLancio(targetRoot, cell.tmuxSession, launchId) === true
        : false;
      if (!rimosso) {
        esitiIncerti.add(cell.tmuxSession);
        throw httpError(500,
          `down incompleto per la cella ${cell.id}: rimozione durevole del record fallita`,
          null, { phase: 'teardown', code: 'RECORD_REMOVE_FAILED' });
      }
      esitiIncerti.delete(cell.tmuxSession);
    };
    // VALUTATORE UNICO del lancio (lib/fleet/launch-reconcile.js): il giudizio
    // sulle prove di morte e' di una sola funzione, in sola lettura, riusata dal
    // down senza canale, dal recupero nella stessa down e dall'endpoint
    // esplicito. Un clock monotono e una sola deadline.
    const valuta = (lettoCorrente) => valutaLancio({
      nomeSessione: cell.tmuxSession,
      tmuxBin,
      tmuxExec,
      minimalEnv,
      esitoAssenzaSessione,
      socketCorrente: sharedTmuxSocketPath(),
      identitaProc: identitaProcSeam,
      identitaNodo: () => (typeof cfg.identitaNodoKernel === 'function'
        ? cfg.identitaNodoKernel() : vlHostStop.identitaNodoKernel()),
      ownerNodo: () => {
        const o = typeof identityOwnerInstanceId === 'function' ? identityOwnerInstanceId() : identityOwnerInstanceId;
        return typeof o === 'string' && /^[a-f0-9]{32}$/.test(o) ? o : null;
      },
      leaseStatus: () => (leaseManager && typeof leaseManager.status === 'function'
        ? leaseManager.status(cell.id) : { state: 'none' }),
      canaleVivo: () => { const c = canaliControllo.get(cell.tmuxSession); return !!(c && !c.morto()); },
      lancioInCorso,
      monoNow: cooldownNow,
      scadenza: scadenzaTotale,
    }, lettoCorrente);
    // BARRIERA HOST PASSIVA, per le prove che non portano l'identita' del
    // supervisore (prepared, aborted, boot): «questo lancio non ha emesso
    // new-session» non prova che sulla root non ci sia un host precedente o
    // sostituto. Si procede solo con la root provata ASSENTE, oppure con la
    // root presente, il contesto di QUESTO lancio, il pin qualificato e il
    // binario pinnato che risponde `none`. Nessun host-stop, nessun client o
    // host avviato: e' una lettura. Il resto (host vivo, contesto assente,
    // straniero o illeggibile, pin mancante) blocca.
    const barrieraHostPassiva = async (record) => {
      if (record.family === 'other') return { ok: true, host: 'not-vl' };
      const owner = typeof identityOwnerInstanceId === 'function'
        ? identityOwnerInstanceId() : (identityOwnerInstanceId || 'local');
      let base = null;
      let rootAttesa = null;
      try {
        base = vlCellBaseDir(home, owner, cell.id);
        rootAttesa = radiceServer(home, owner, cell.id);
      } catch (_) { return { ok: false, host: 'unresolvable' }; }
      if (!base || !rootAttesa) return { ok: false, host: 'unresolvable' };
      // La root del record e' quella canonica del nodo e della cella: mai un
      // path arbitrario scritto nel record.
      if (record.version === 2 && !(record.res && record.res.vlRoot === rootAttesa && record.res.vlOwner === owner)) {
        return { ok: false, host: 'root-non-canonica' };
      }
      try {
        fs.lstatSync(base);
      } catch (e) {
        // Base della cella scomparsa: NON prova che l'host sia assente (una
        // base qualificata puo' essere stata spostata con l'host ancora vivo).
        // Barriera, claim e record restano. Il positivo e' la root assente
        // dentro una base presente e qualificata (sotto).
        return e && e.code === 'ENOENT' ? { ok: false, host: 'base-mancante' } : { ok: false, host: 'unresolvable' };
      }
      let q = null;
      try { q = qualificaAssenzaRadice(rootAttesa, base); } catch (_) { q = null; }
      if (!q || q.esito === 'rifiutata') return { ok: false, host: 'unresolvable' };
      if (budgetFinito()) return { ok: false, host: 'budget' };
      let ctxHost = null;
      try { ctxHost = leggiContesto(base); } catch (_) { ctxHost = null; }
      // Il contesto di QUESTO lancio dentro la base e' la traccia durevole che
      // la base e' ancora quella del lancio: una base spostata e sostituita da
      // una directory nuova non lo porta, e la root «assente» li' non prova
      // niente sull'host della base originale.
      if (!ctxHost || ctxHost.errore || ctxHost.launchId !== record.launchId
        || ctxHost.version !== 2 || typeof ctxHost.vlBinSha256 !== 'string') {
        return { ok: false, host: 'context-missing' };
      }
      if (q.esito === 'assente') return { ok: true, host: 'root-absent' };
      const pinDir = dirPin(home, owner, cell.id, ctxHost.vlBinSha256);
      const pin = verificaPin(pinDir ? path.join(pinDir, 'vl') : '', ctxHost.vlBinSha256);
      if (!pin.ok) return { ok: false, host: 'pin-missing' };
      let cap = null;
      try {
        cap = await vlHostStop.verificaCapacitaPeerStop({
          bin: pin.path, env: envDalRecord(ctxHost), root: rootAttesa, budgetMs: timeoutResiduo(),
        });
      } catch (_) { cap = null; }
      if (budgetFinito()) return { ok: false, host: 'budget' };
      if (cap && cap.ok === true && cap.stato && cap.stato.state === 'none') return { ok: true, host: 'none' };
      return { ok: false, host: 'host-not-none' };
    };
    // RICONCILIAZIONE: ordine prove -> barriera host -> rilascio esatto della
    // claim -> commit del record in quarantena. Con la prova TERNARIA del
    // supervisore la barriera e' quella di sempre (chiudiHostPoiLease: l'host si
    // ferma con la PROPRIA identita' attestata); con le altre prove e' la
    // lettura passiva. Il commit confronta byte, launchId e fase prima delle
    // azioni e di nuovo al commit (single writer per filesRoot: vedi
    // launch-writer-lock.js), poi sposta il record in launch-targets/reconciled/.
    // Fotografia coerente del record PRIMA delle prove: byte, sha256, launchId
    // e fase. Ogni azione correlata (host, claim, commit) la ricontrolla.
    const fotografa = (lettoCorrente) => {
      const g = launchTarget.leggiGrezzo(targetRoot, cell.tmuxSession);
      if (g.stato !== 'presente') return null;
      let dato;
      try { dato = JSON.parse(g.bytes.toString('utf8')); } catch (_) { return null; }
      const rec = lettoCorrente && lettoCorrente.record;
      if (!dato || !rec || dato.launchId !== rec.launchId || (dato.phase || null) !== (rec.phase || null)) return null;
      return { sha256: g.sha256, launchId: dato.launchId, fase: dato.phase || null };
    };
    const inalterato = (foto) => {
      const g = launchTarget.leggiGrezzo(targetRoot, cell.tmuxSession);
      return !!foto && g.stato === 'presente' && g.sha256 === foto.sha256;
    };
    const riconciliaLancio = async (lettoCorrente, valutazione, foto) => {
      if (!foto) return { outcome: 'blocked', codice: 'RECORD_CAMBIATO' };
      const record = lettoCorrente.record;
      if (budgetFinito() || valutazione.blocchi.includes('BUDGET')) return { outcome: 'blocked', codice: 'BUDGET' };
      if (!inalterato(foto)) return { outcome: 'blocked', codice: 'RECORD_CAMBIATO' };
      let hostOutcome;
      if (valutazione.prova === 'ternary') {
        hostOutcome = await chiudiHostPoiLease(record.launchId, record.family === 'other' ? 'other' : 'vl', () => inalterato(foto));
      } else {
        const barriera = await barrieraHostPassiva(record);
        if (!barriera.ok) return { outcome: 'blocked', codice: 'HOST_BARRIER', host: barriera.host };
        hostOutcome = barriera.host;
        // La claim si rilascia SOLO se il record e' ancora quello provato.
        if (!inalterato(foto)) return { outcome: 'blocked', codice: 'RECORD_CAMBIATO' };
        if (record.family !== 'other') await rilasciaRadiceDown(record.launchId, 'vl');
      }
      if (budgetFinito()) return { outcome: 'blocked', codice: 'BUDGET' };
      const commit = launchTarget.riconciliaRecord(targetRoot, cell.tmuxSession, {
        launchId: record.launchId, sha256: foto.sha256, fase: foto.fase,
      });
      if (!commit.ok) return { outcome: 'blocked', codice: 'COMMIT', dettaglio: commit.codice, incompleto: commit.incompleto === true };
      // I marker in memoria si tolgono SOLO dopo il commit attestato.
      esitiIncerti.delete(cell.tmuxSession);
      return { outcome: 'reconciled', host: hostOutcome, prova: valutazione.prova };
    };
    return {
      targetRoot, budgetFinito, timeoutResiduo, faseHostDown, chiudiHostPoiLease, rilasciaRadiceDown,
      segnaIncerto, segnaIncertoDelLancio, chiudiLancioPulito, valuta, barrieraHostPassiva, fotografa, inalterato, riconciliaLancio,
    };
  }

  // Il corpo vero del down. Vive qui, DENTRO la serializzazione del ciclo di
  // vita: down() e' il lock per cella, downSerializzato() e' l'operazione. Un
  // down che girasse fuori dalla fila di up vedrebbe «nessuna sessione» mentre
  // un lancio e' ancora in attesa (broker, tmux), risponderebbe ok, e la
  // sessione nascerebbe un istante dopo: la cella resterebbe viva dopo uno stop
  // che ha dichiarato successo. restart() usa questa variante interna, non
  // down(): il lock e' gia' tenuto dal chiamante (niente doppia acquisizione).
  async function downSerializzato(cellId /* , opts */) {
    if (readonly()) throw httpError(403, 'READONLY: down bloccato');
    abortaOsservatore(cellId);
    if (typeof ensureProtection === 'function') await ensureProtection();
    const defs = reloadDefs();
    const cell = findCell(defs, cellId);
    if (!cell) throw httpError(400, `cella sconosciuta: ${cellId}`);
    const engine = findEngine(defs, cell.engine) || {};
    const budgetTotale = Number.isSafeInteger(cfg.groupStopBudgetMs)
      && cfg.groupStopBudgetMs >= 200 && cfg.groupStopBudgetMs <= 15000
      ? cfg.groupStopBudgetMs : 8000;
    const scadenzaTotale = cooldownNow() + budgetTotale;
    // Una sola deadline, quella di questo down: vale dentro le tre prove e
    // prima di barriera e commit (un riscontro arrivato dopo non chiude il
    // lancio). Il percorso di riconciliazione e' quello CONDIVISO: valutatore,
    // barriere, fotografia e commit vivono in creaPercorsoRiconciliazione,
    // riusati dagli endpoint espliciti (launch-state/reconcile).
    const {
      targetRoot, budgetFinito, timeoutResiduo, faseHostDown, chiudiHostPoiLease, rilasciaRadiceDown,
      segnaIncerto, segnaIncertoDelLancio, chiudiLancioPulito, valuta, barrieraHostPassiva, fotografa, inalterato, riconciliaLancio,
    } = creaPercorsoRiconciliazione(cell, { scadenzaTotale });
    // Il teardown usa SOLO gli id del lancio posseduto ($sessione dal record
    // scritto alla creazione), MAI il nome della sessione: il nome e' un
    // indirizzo riutilizzabile e fermare «chi lo occupa ora» significherebbe
    // toccare una sessione che questo NC non ha lanciato. Senza record non
    // si agisce: l'esito e' onesto, non un bluff di successo.
    assicuraScrittore('teardown');
    completaCommitPendente(cell, 'teardown');
    const letto = launchTarget.leggi(targetRoot, cell.tmuxSession);
    // Un canale di controllo orfano (record rimosso fuori banda, cella mai
    // registrata da questo lancio) non autorizza nulla: si chiude e basta.
    // Chiudere la PROPRIA connessione non e' un teardown, non tocca il server.
    const chiudiCanaleOrfano = () => {
      const c = canaliControllo.get(cell.tmuxSession);
      if (c) { c.chiudi(); canaliControllo.delete(cell.tmuxSession); }
    };
    if (letto.stato === 'indeterminato') {
      chiudiCanaleOrfano();
      throw httpError(409,
        `down rifiutato per la cella ${cell.id}: record del lancio non leggibile, identità non dimostrabile (nessuna azione eseguita)`,
        null, { phase: 'teardown', code: 'IDENTITY_UNVERIFIED' });
    }
    if (letto.stato === 'assente') {
      chiudiCanaleOrfano();
      // Diagnosi in SOLA LETTURA per nome (nessun effetto): distingue «cella
      // gia' ferma» (idempotente) da «sessione omonima NON posseduta» (rifiuto
      // esplicito: NC non puo' dimostrare che sia la sua).
      const omonima = await tmuxExec(tmuxBin,
        ['has-session', '-t', `=${cell.tmuxSession}`], { env: minimalEnv(), timeoutMs: 2000 });
      if (!esitoAssenzaSessione(omonima)) {
        if (!omonima.err) {
          throw httpError(409,
            `down rifiutato per la cella ${cell.id}: sessione omonima presente ma senza record del lancio di questo NC (nessuna azione eseguita)`,
            null, { phase: 'teardown', code: 'IDENTITY_UNVERIFIED' });
        }
        // La lettura non dichiara niente (timeout, errore di esecuzione, stderr
        // inatteso): l'assenza non e' provata e il «gia' fermo» non si dichiara.
        throw httpError(409,
          `down rifiutato per la cella ${cell.id}: esito del has-session non dichiarabile, assenza della sessione non provata (nessuna azione eseguita)`,
          null, { phase: 'teardown', code: 'IDENTITY_UNVERIFIED' });
      }
      cache = { ...cache, at: 0 };
      // Lancio risolto fuori banda (record assente): la guardia in-process
      // dell'incertezza si scioglie con lui — questo e' il recovery durevole
      // quando il marker non era arrivato su disco.
      esitiIncerti.delete(cell.tmuxSession);
      return { ok: true, cell: cellId, session: cell.tmuxSession, killed: false, outcome: 'alreadyAbsent' };
    }
    const target = letto.record;
    // Famiglia del LANCIO, letta dal record scritto alla creazione: e' un
    // fatto registrato, non una ricostruzione dall'engine aggiornato (che
    // puo' essere cambiato dopo il lancio) ne' dal contesto host (che puo'
    // essere corrotto o illeggibile proprio quando la barriera serve).
    // Record senza famiglia (pre-campo): ignoto, e l'ignoto resta soggetto
    // alla barriera — mai esente per default.
    const famigliaLancio = target.family === 'other' ? 'other' : 'vl';
    // Continuita' con il server della creazione: la
    // verifica e il comando di teardown viaggiano sulla STESSA connessione
    // di controllo aperta al lancio e posseduta da questo processo. Senza
    // canale (NC riavviato, apertura non riuscita) o con canale morto non
    // esiste continuita' dimostrabile: NESSUNA azione, nessun client tmux
    // nuovo per «riprovare» — un client nuovo si riconnetterebbe al pathname
    // del socket, che un sostituto puo' occupare.
    const canale = canaliControllo.get(cell.tmuxSession) || null;
    if (!canale || canale.morto()) {
      if (canale) { canale.chiudi(); canaliControllo.delete(cell.tmuxSession); }
      // Canale perso con record presente: il lancio PUO' essere gia' finito
      // mentre questo processo non guardava (riavvio di NC, canale morto).
      // Il rifiuto resta la regola; la chiusura del record e' concessa SOLO
      // alla congiunzione delle tre prove di morte — tutte in lettura: qui
      // non si uccide NESSUN supervisore ne' sessione, si chiude una pratica
      // su evidenza. La chiusura passa poi dalla barriera host->root di
      // chiudiHostPoiLease: per famiglia vl l'eventuale host si ferma con la
      // PROPRIA identita' attestata, mai con un kill di ripiego. Senza
      // anche una sola prova: 409 di oggi, nessuna azione, nessuno
      // sblocco cieco.
      const foto = fotografa(letto);
      const valutazione = await valuta(letto);
      if (!valutazione.riconciliabile) {
        // Budget: una chiusura tardiva non vale e l'incertezza si segna; ogni
        // altra mancanza di prova e' il 409 di sempre, nessuna azione.
        if (valutazione.blocchi.includes('BUDGET') && valutazione.blocchi.length === 1) {
          segnaIncertoDelLancio(target.launchId);
          throw httpError(409,
            `down rifiutato per la cella ${cell.id}: budget scaduto prima della chiusura del lancio (nessuna azione eseguita)`,
            { prove: valutazione },
            { phase: 'teardown', code: 'IDENTITY_UNVERIFIED' });
        }
        throw httpError(409,
          `down rifiutato per la cella ${cell.id}: nessuna connessione di controllo posseduta dal lancio (identità non dimostrabile, nessuna azione eseguita) [${valutazione.classificazione}: ${valutazione.blocchi.join(',') || 'nessuna prova'}]`,
          { prove: valutazione },
          { phase: 'teardown', code: 'IDENTITY_UNVERIFIED' });
      }
      if (budgetFinito()) {
        segnaIncertoDelLancio(target.launchId);
        throw httpError(409,
          `down rifiutato per la cella ${cell.id}: budget scaduto prima della barriera host (nessuna azione eseguita)`,
          null, { phase: 'teardown', code: 'IDENTITY_UNVERIFIED' });
      }
      // Barriera host -> claim -> record in quarantena (riconciliaLancio): la
      // morte del supervisore e una lease non live non provano che un host
      // SEPARATO sia fermo. Host ignoto, tuple mutata, pin/probe non
      // attestabile o claim non rilasciata conservano record e guardia
      // incerta — mai una chiusura con l'host ancora da giudicare.
      let riconciliato;
      try {
        riconciliato = await riconciliaLancio(letto, valutazione, foto);
      } catch (e) {
        segnaIncertoDelLancio(target.launchId);
        throw e;
      }
      if (riconciliato.outcome !== 'reconciled') {
        segnaIncertoDelLancio(target.launchId);
        throw httpError(409,
          `down rifiutato per la cella ${cell.id}: riconciliazione non completata (${riconciliato.codice}${riconciliato.dettaglio ? `/${riconciliato.dettaglio}` : ''}); nessuna chiusura del record`,
          { prove: valutazione, riconciliazione: riconciliato },
          { phase: 'teardown', code: 'IDENTITY_UNVERIFIED' });
      }
      if (leaseManager && typeof leaseManager.revokeControl === 'function') {
        try { leaseManager.revokeControl(cell.id); } catch (_) {}
      }
      cache = { ...cache, at: 0 };
      return {
        ok: true, cell: cellId, session: cell.tmuxSession, killed: false,
        outcome: valutazione.classificazione === 'never-materialized' ? 'resolved-unlaunched' : 'resolved-dead',
        host: riconciliato.host,
      };
    }
    const liberaCanale = () => {
      canale.chiudi();
      canaliControllo.delete(cell.tmuxSession);
    };
    // FENCE DEL LANCIO: l'identita' congelata all'ingresso deve valere fino al
    // commit, e va RICONTROLLATA dopo ogni await. La morte di un server vecchio
    // non autorizza a chiudere un lancio nuovo; sul rifiuto non si marca nulla,
    // perche' il record in quel momento appartiene al lancio nuovo.
    const verificaFenceLancio = () => {
      const corrente = targetRoot ? launchTarget.leggi(targetRoot, cell.tmuxSession) : null;
      if (!corrente || corrente.stato !== 'presente'
        || !corrente.record || corrente.record.launchId !== target.launchId) {
        liberaCanale();
        throw httpError(409,
          `down rifiutato per la cella ${cell.id}: l'identita' del lancio e' cambiata durante l'attesa (nessuna azione eseguita)`,
          null, { phase: 'teardown', code: 'IDENTITY_UNVERIFIED' });
      }
    };
    // Recupero NELLA STESSA down: dopo l'uscita PROVATA del supervisore, se
    // il canale non da' il verdetto sulla sessione, il lancio si chiude qui —
    // stessa chiamata, stesso lock della cella, stesso launchId e stesso
    // record — con la congiunzione delle TRE prove in lettura (le stesse del
    // down senza canale), poi barriera host attestata, rilascio della root,
    // rimozione durevole del record e revoke/cleanup. Una sola deadline,
    // quella originaria del down: nessun timer nuovo. Nessun client o canale
    // nuovo per comandi distruttivi e nessun kill tmux aggiuntivo: l'eventuale
    // host-stop usa la propria identita' attestata, il lease non si revoca
    // prima per «diventare» non live. Esito DISTINTO: attested-recovery; il
    // resolved-dead resta del down successivo (canale assente all'ingresso).
    // Se una prova manca, il budget scade o la barriera fallisce: null o
    // throw, e il chiamante resta sull'esito non pulito di oggi.
    const recuperoNellaStessaDown = async () => {
      if (budgetFinito()) return null;
      const foto = fotografa(letto);
      const valutazione = await valuta(letto);
      if (!valutazione.riconciliabile || budgetFinito()) return null;
      let riconciliato;
      try {
        riconciliato = await riconciliaLancio(letto, valutazione, foto);
      } catch (e) {
        segnaIncertoDelLancio(target.launchId);
        throw e;
      }
      if (riconciliato.outcome !== 'reconciled') {
        segnaIncertoDelLancio(target.launchId);
        return null;
      }
      liberaCanale();
      if (leaseManager && typeof leaseManager.revokeControl === 'function') {
        try { leaseManager.revokeControl(cell.id); } catch (_) {}
      }
      cache = { ...cache, at: 0 };
      return { host: riconciliato.host };
    };
    const valutaGruppo = async () => {
      if (!(leaseManager && typeof leaseManager.controlArmato === 'function' && leaseManager.controlArmato(cell.id))) {
        return null;
      }
      const idCanale = typeof leaseManager.controlLaunchId === 'function'
        ? leaseManager.controlLaunchId(cell.id) : null;
      if (idCanale && idCanale !== target.launchId) {
        return { outcome: 'identity-lost', conti: null };
      }
      const ora = cooldownNow();
      if (ora >= scadenzaTotale) {
        return { outcome: 'stop-unknown', conti: null };
      }
      const residuo = scadenzaTotale - ora;
      const grazia = Math.min(2000, Math.max(200, residuo - 500));
      // Identita' del gruppo del supervisore CATTURATA PRIMA dello stop:
      // dopo l'uscita del supervisore il PID del pane e' sparito e /proc/<pid>
      // non esiste piu'. Conservare il gruppo prima di inviare i segnali di stop
      // permette all'osservatore post-uscita di quantificare i residui reali.
      const pidSupervisore = target && Number.isInteger(target.panePid) && target.panePid > 0
        ? target.panePid : null;
      const pgrpSupervisore = pidSupervisore ? leggiPgrp(pidSupervisore) : null;
      const starttimeSupervisore = pidSupervisore ? leggiStarttimeProc(pidSupervisore) : null;
      // Identita' del CAPOGRUPPO, catturata separatamente e prima dei segnali:
      // `starttimeSupervisore` e' la nascita del panePid, che non e'
      // necessariamente il processo il cui pid coincide col numero di gruppo.
      // Confrontare quella con /proc/<pgrp>/stat senza aver provato che siano
      // lo stesso processo sarebbe proprio la confusione da evitare. Se la
      // nascita del capo non e' leggibile ora, la sonda non partira' dopo.
      let identitaCapogruppo = null;
      if (pgrpSupervisore) {
        try { identitaCapogruppo = identitaProcSeam(pgrpSupervisore); } catch (_) {
          identitaCapogruppo = null;
        }
      }
      return attendiFermataGruppo({
        leaseManager,
        cellId: cell.id,
        launchId: target.launchId,
        monoNow: cooldownNow,
        deadlineAt: scadenzaTotale,
        graziaMs: grazia,
        attendiUscita: async () => {
          // Prova REALE e correlata al lancio, distinta da EOF: solo l'attesa
          // del supervisore esposta dal leaseManager e' una prova. API
          // mancante => { provato: false }: nessuna prova, esito ignoto.
          // Il valore restituito non viene promosso: false o assenza resta { provato: false }.
          if (leaseManager && typeof leaseManager.attendiUscita === 'function') {
            const res = await leaseManager.attendiUscita(cell.id, {
              launchId: target.launchId,
              panePid: target.panePid,
              starttime: starttimeSupervisore,
              // Il residuo della deadline della down, con un margine perche' la
              // prova possa dire il suo motivo prima del taglio esterno.
              timeoutMs: Math.max(500, scadenzaTotale - cooldownNow() - 100),
            });
            if (res === true) return { provato: true };
            if (res && typeof res === 'object' && res.provato === true) return { provato: true };
            return { provato: false, motivo: motivoUscitaBounded(res && res.motivo) };
          }
          if (leaseManager && typeof leaseManager.osservaUscita === 'function') {
            const res = await leaseManager.osservaUscita(cell.id, {
              launchId: target.launchId,
              panePid: target.panePid,
              starttime: starttimeSupervisore,
              timeoutMs: Math.max(500, scadenzaTotale - cooldownNow() - 100),
            });
            if (res === true) return { provato: true };
            if (res && typeof res === 'object' && res.provato === true) return { provato: true };
            return { provato: false, motivo: motivoUscitaBounded(res && res.motivo) };
          }
          return { provato: false };
        },
        osserva: (limite) => {
          if (typeof leaseManager.osservaGruppo === 'function') {
            const mock = leaseManager.osservaGruppo(cell.id);
            if (mock) return mock;
          }
          // Gruppo del supervisore acquisito PRIMA dello stop. Dopo l'uscita
          // provata il demone non e' piu' membro del gruppo: sonda a segnale
          // zero (ESRCH = percorso rapido), poi breve retry e censimento
          // cooperativo a tempo nel residuo della stessa deadline, perche' un
          // processo uscito e non raccolto tiene il PGID senza essere un
          // residuo. Nessun ripiego sul pgrp riletto DOPO la morte.
          return osservaGruppoDopoUscita({
            pgrp: pgrpSupervisore,
            identita: identitaCapogruppo,
            deadlineAt: limite,
            monoNow: cooldownNow,
          });
        },
        // Attestazione della sessione SUL canale posseduto, dopo la prova di
        // uscita: solo il verdetto specifico di has-session sul target (su
        // questa connessione, nessun client nuovo) attesta l'assenza. La
        // morte del client NON attesta: EOF/timeout/sostituzione sono
        // indistinguibili dalla fine della sessione. Vedi classificaEsito e
        // attestazioneAssenzaCanale.
        verificaSessioneAssente: () => attestazioneAssenzaCanale(canale, target.sessionId),
      });
    };
    // Gia' assente PER ID, osservato SUL canale posseduto: il record viene
    // meno insieme alla sessione.
    const vivePerId = await canale.hasSession(target.sessionId);
    if (vivePerId.morto) {
      // La connessione e' morta DURANTE la verifica: il client -C attached
      // esce anche con la fine della sessione, ma la sua morte da sola non
      // PROVA niente (EOF, timeout e sostituzione del server sono indistingui-
      // bili e nessuna correlazione temporale li separa). Prima del rifiuto si
      // giudica il gruppo: si chiude SOLO con attestazione VERA — uscita del
      // supervisore provata E assenza della sessione attestata dal verdetto
      // specifico di has-session sul canale posseduto (verificaSessioneAssente
      // non considera la morte del client una prova). Senza attestazione, se
      // l'uscita del supervisore e' provata, il recupero a tre prove chiude
      // NELLA STESSA down (attested-recovery); se anche quelle mancano, il
      // rifiuto resta quello di oggi: nessun comando inviato, nessun esito
      // dichiarabile, zero kill (un sostituto puo' gia' occupare il pathname)
      // e il recupero resta al down successivo.
      const attestazione = await valutaGruppo();
      const chiusoDaAttestazione = !!(attestazione
        && attestazione.attestato === true && esitoGruppoPulito(attestazione.outcome));
      if (!chiusoDaAttestazione) {
        // Uscita del supervisore PROVATA e canale morto senza verdetto: il
        // recupero a tre prove chiude QUI, nella stessa down (attested-
        // recovery), senza nuovi teardown. Se le prove non si completano la
        // guardia incerta si MARCA: il lancio resta aperto fino al down
        // successivo, nessuno sblocco cieco.
        if (attestazione && attestazione.uscito === true) {
          const recupero = await recuperoNellaStessaDown();
          if (recupero) {
            return {
              ok: true, cell: cellId, session: cell.tmuxSession, killed: false,
              outcome: 'attested-recovery', host: recupero.host,
            };
          }
          segnaIncertoDelLancio(target.launchId);
        }
        liberaCanale();
        throw httpError(500,
          `down non dichiarabile per la cella ${cell.id}: connessione di controllo persa durante la verifica (nessun comando inviato)`,
          null, { phase: 'teardown', code: 'STOP_UNKNOWN' });
      }
      let hostOutcome;
      try {
        hostOutcome = await chiudiHostPoiLease(target.launchId, famigliaLancio);
      } catch (e) {
        // Percorso eccezionale: prima la fence, poi la marcatura del NOSTRO lancio.
        verificaFenceLancio();
        segnaIncertoDelLancio(target.launchId);
        throw e;
      }
      verificaFenceLancio();
      liberaCanale();
      chiudiLancioPulito(target.launchId);
      if (leaseManager && typeof leaseManager.revokeControl === 'function') {
        try { leaseManager.revokeControl(cell.id); } catch (_) {}
      }
      cache = { ...cache, at: 0 };
      return {
        ok: true, cell: cellId, session: cell.tmuxSession, killed: false,
        outcome: 'attested-exit', host: hostOutcome,
      };
    }
    if (!vivePerId.ok) {
      // Un %error generico (o un argomento rifiutato) NON e' un verdetto
      // sull'esistenza della sessione: e' un comando fallito. Solo il verdetto
      // specifico di tmux sul target — «can't find session», marcato
      // `assente` dal canale — prova l'assenza e autorizza la chiusura per
      // gia'-assente qui sotto. Senza verdetto: rifiuto, nessuna azione,
      // canale e record restano al loro posto.
      if (vivePerId.assente !== true) {
        throw httpError(409,
          `down rifiutato per la cella ${cell.id}: esito del has-session sul canale posseduto non dichiarabile, assenza della sessione non provata (nessuna azione eseguita)`,
          null, { phase: 'teardown', code: 'IDENTITY_UNVERIFIED' });
      }
      if (target.incerto) {
        const diNuovo = await valutaGruppo();
        if (diNuovo && !esitoGruppoPulito(diNuovo.outcome)) {
          const codice = codiceEsito(diNuovo.outcome);
          throw httpError(codice === 'IDENTITY_LOST' ? 409 : 500,
            `down incompleto per la cella ${cell.id}: stop del gruppo ${diNuovo.outcome}; l'assenza della sessione non chiude il lancio`,
            { outcome: diNuovo.outcome, conti: diNuovo.conti || null },
            { phase: 'teardown', code: codice });
        }
        const hostOutcome = await chiudiHostPoiLease(target.launchId, famigliaLancio);
        verificaFenceLancio();
        liberaCanale();
        chiudiLancioPulito(target.launchId);
        if (leaseManager && typeof leaseManager.revokeControl === 'function') {
          try { leaseManager.revokeControl(cell.id); } catch (_) {}
        }
        cache = { ...cache, at: 0 };
        return {
          ok: true, cell: cellId, session: cell.tmuxSession, killed: false,
          outcome: diNuovo ? diNuovo.outcome : 'killed', host: hostOutcome,
        };
      }
      // La barriera host viene PRIMA di togliere record e canale: se l'host
      // non si chiude pulito, il lancio resta com'e' — canale in mano, record
      // al posto, incertezza marcata — invece di dichiarare l'assenza con
      // l'host ancora da giudicare.
      let hostOutcomeAssente;
      try {
        hostOutcomeAssente = await chiudiHostPoiLease(target.launchId, famigliaLancio);
      } catch (e) {
        // Percorso eccezionale: prima la fence, poi la marcatura del NOSTRO lancio.
        verificaFenceLancio();
        segnaIncertoDelLancio(target.launchId);
        throw e;
      }
      verificaFenceLancio();
      liberaCanale();
      chiudiLancioPulito(target.launchId);
      if (leaseManager && typeof leaseManager.revokeControl === 'function') {
        try { leaseManager.revokeControl(cell.id); } catch (_) {}
      }
      cache = { ...cache, at: 0 };
      return { ok: true, cell: cellId, session: cell.tmuxSession, killed: false, outcome: 'alreadyAbsent', host: hostOutcomeAssente };
    }
    // Host del lancio: prima la preparazione senza segnali, poi il probe.
    // Senza isolamento dimostrato, o senza uno stato none esplicito, non si
    // autorizza il gruppo e non si chiude la sessione. La barriera vale per
    // OGNI lancio di famiglia vl REGISTRATO: il contesto assente, corrotto,
    // illeggibile, di un altro lancio o non qualificato rifiuta QUI, prima di
    // stop del gruppo, teardown e shutdown — l'esito host non si scopre dopo
    // gli effetti. Claim e identità restano: il record non si tocca.
    if (famigliaLancio === 'vl') {
      const ownerHost = typeof identityOwnerInstanceId === 'function'
        ? identityOwnerInstanceId() : (identityOwnerInstanceId || 'local');
      let ctxHost = null;
      try { ctxHost = leggiContesto(vlCellBaseDir(home, ownerHost, cell.id)); } catch (_) { ctxHost = null; }
      const diQuesto = !!(ctxHost && ctxHost.launchId === target.launchId);
      if (!diQuesto) {
        // Un contesto illeggibile NON e' l'assenza della barriera: e' la
        // barriera non dimostrabile. Un errore di lettura non diventa mai
        // not-vl.
        segnaIncertoDelLancio(target.launchId);
        throw httpError(409,
          `down rifiutato per la cella ${cell.id}: contesto host del lancio assente, corrotto o non correlato (nessuna azione eseguita)`,
          { outcome: 'host-unresolvable' },
          { phase: 'teardown', code: 'HOST_UNRESOLVABLE' });
      }
      {
        if (ctxHost.errore || ctxHost.version !== 2) {
          segnaIncertoDelLancio(target.launchId);
          throw httpError(500,
            `host vl non isolato (host-unresolvable)`,
            { outcome: 'host-unresolvable' },
            { phase: 'teardown', code: 'HOST_UNRESOLVABLE' });
        }
        if (leaseManager && typeof leaseManager.controlArmato === 'function' && leaseManager.controlArmato(cell.id)) {
          const ora = cooldownNow();
          if (ora >= scadenzaTotale) {
            segnaIncertoDelLancio(target.launchId);
            throw httpError(500,
              `down incompleto per la cella ${cell.id}: preparazione senza segnali non conclusa entro il budget`,
              { outcome: 'stop-unknown' },
              { phase: 'teardown', code: 'STOP_UNKNOWN' });
          }
          const prep = await attendiPreparazione({
            leaseManager,
            cellId: cell.id,
            launchId: target.launchId,
            monoNow: cooldownNow,
            deadlineAt: scadenzaTotale,
          });
          if (!prep || prep.outcome !== 'prepared') {
            segnaIncertoDelLancio(target.launchId);
            throw httpError(500,
              `down incompleto per la cella ${cell.id}: preparazione senza segnali non conclusa`,
              { outcome: prep && prep.outcome },
              { phase: 'teardown', code: 'STOP_UNKNOWN' });
          }
        }
        const prima = await faseHostDown(target.launchId, famigliaLancio);
        // A CLEAN host stop (`host-stopped-clean`) is as safe an outcome as
        // `not-vl` and `host-already-stopped` — the launch proceeds to the
        // barriers and the durable close, without marking itself uncertain
        // (contract already used by chiudiHostPoiLease).
        if (prima.outcome !== 'not-vl' && prima.outcome !== 'host-already-stopped'
          && prima.outcome !== 'host-stopped-clean') {
          segnaIncertoDelLancio(target.launchId);
          // I rifiuti protetti dello stop expected (peer_mismatch, peer_unknown,
          // expected_invalid) hanno un CODICE LORO e la loro parola bounded nel
          // data: l'operatore vede quale dei tre e' stato, come gli altri esiti.
          const code = prima.code === 'HOST_IN_GROUP' ? 'HOST_IN_GROUP'
            : prima.outcome === 'host-identity-changed' ? 'HOST_IDENTITY_CHANGED'
            : prima.outcome === 'host-unresolvable' ? 'HOST_UNRESOLVABLE'
            : ESITI_STOP_ATTESTATI[prima.reason] || 'HOST_STOP_FAILED';
          throw httpError(code === 'HOST_IN_GROUP' ? 409 : 500,
            `host vl non isolato (${prima.outcome}${prima.reason ? `, ${prima.reason}` : ''}${prima.motivoIsolamento ? `, isolamento ${prima.motivoIsolamento}` : ''})`,
            { outcome: prima.outcome, ...(prima.reason ? { reason: prima.reason } : {}),
              ...(prima.motivoIsolamento ? { motivoIsolamento: prima.motivoIsolamento } : {}) },
            { phase: 'teardown', code });
        }
      }
    }
    // Il gruppo si giudica PRIMA del teardown. Uno stop non dimostrato non
    // cancella il record e non ferma la sessione: un down successivo non
    // puo' trattare l'assenza come chiusura.
    const esitoGruppo = await valutaGruppo();
    if (esitoGruppo && !esitoGruppoPulito(esitoGruppo.outcome)) {
      // Uscita del supervisore PROVATA e canale morto senza verdetto sulla
      // sessione (il censimento non dichiara): il recupero a tre prove puo'
      // chiudere qui, nella stessa down, senza nuovi teardown ne' kill. Con
      // il canale VIVO il verdetto resta possibile e il rifiuto e' quello di
      // oggi: il recupero e' solo per il canale che non risponde piu'.
      if (esitoGruppo.uscito === true && canale.morto()) {
        const recupero = await recuperoNellaStessaDown();
        if (recupero) {
          return {
            ok: true, cell: cellId, session: cell.tmuxSession, killed: false,
            outcome: 'attested-recovery', host: recupero.host,
          };
        }
      }
      segnaIncertoDelLancio(target.launchId);
      const codice = codiceEsito(esitoGruppo.outcome);
      throw httpError(codice === 'IDENTITY_LOST' ? 409 : 500,
        `down incompleto per la cella ${cell.id}: stop del gruppo ${esitoGruppo.outcome}; nessuna sessione fermata`,
        {
          outcome: esitoGruppo.outcome,
          conti: esitoGruppo.conti || null,
          uscito: esitoGruppo.uscito === true,
          motivoUscita: esitoGruppo.motivoUscita || null,
        },
        { phase: 'teardown', code: codice });
    }
    if (cooldownNow() >= scadenzaTotale) {
      segnaIncertoDelLancio(target.launchId);
      liberaCanale();
      throw httpError(500,
        `down incompleto per la cella ${cell.id}: budget scaduto prima del teardown finale`,
        null, { phase: 'teardown', code: 'STOP_UNKNOWN' });
    }
    const r = await canale.killSession(target.sessionId);
    if (r.morto) {
      // Comando inviato senza risposta: resta ambiguo — A MENO CHE il gruppo
      // sia gia' pulito DA ATTESTAZIONE (uscita del supervisore provata e
      // assenza della sessione attestata dal VERDETTO specifico di
      // has-session nel valutaGruppo di questo down). Il censimento pulito da
      // solo NON basta, e la morte del canale non e' una prova: senza il
      // verdetto sulla sessione la risposta persa resta non dichiarabile.
      const daAttestazionePerVerdetto = !!(esitoGruppo
        && esitoGruppo.attestato === true && esitoGruppoPulito(esitoGruppo.outcome));
      // Il comando di teardown e' partito e la risposta non e' arrivata: il
      // canale posseduto e' morto e non puo' piu' dire se la sessione esiste.
      // Una connessione NUOVA, di sola lettura, puo' attestare l'assenza SOLO
      // sulla stessa incarnazione del server (pid+nascita congelati al lancio),
      // con l'id esatto della sessione: nessun kill, nessun invio, nessuna
      // creazione, nessuna risoluzione per nome. Se non attesta, resta il
      // rifiuto di sempre.
      let attestatoDaNuovaConnessione = false;
      let motivoAttestazione = null;
      if (!daAttestazionePerVerdetto && esitoGruppo && esitoGruppo.uscito === true) {
        try {
          const nuova = await attestaSeam({
            tmuxBin,
            socket: target.tmuxSocket,
            sessionId: target.sessionId,
            serverPid: target.serverPid,
            serverStarttime: target.serverStarttime,
            deadlineAt: scadenzaTotale,
            monoNow: cooldownNow,
            leggiStarttimeProc: starttimeSeam,
            leggiIdentitaProc: identitaProcSeam,
          });
          attestatoDaNuovaConnessione = !!(nuova && nuova.attestato === true);
          motivoAttestazione = nuova && typeof nuova.motivo === 'string' ? nuova.motivo : null;
        } catch (_) {
          attestatoDaNuovaConnessione = false;
          motivoAttestazione = 'errore';
        }
      }
      const daAttestazione = daAttestazionePerVerdetto || attestatoDaNuovaConnessione;
      if (daAttestazione) {
        // FENCE: la morte di un server VECCHIO non autorizza a chiudere un
        // lancio NUOVO. Prima di toccare record e lease, l'identita' del lancio
        // deve essere ancora quella congelata all'ingresso di questa down.
        verificaFenceLancio();
      }
      if (!daAttestazione) {
        // Comando di teardown gia' inviato, risposta persa e uscita del
        // supervisore PROVATA: il recupero a tre prove chiude nella stessa
        // down (attested-recovery, killed resta true perche' il kill era
        // gia' partito). Nessun comando nuovo, nessun replay.
        if (esitoGruppo && esitoGruppo.uscito === true) {
          const recupero = await recuperoNellaStessaDown();
          if (recupero) {
            return {
              ok: true, cell: cellId, session: cell.tmuxSession, killed: true,
              outcome: 'attested-recovery', host: recupero.host,
            };
          }
        }
        // Comando inviato senza risposta: NON si dichiara ne' successo ne'
        // fallimento. Record trattenuto, zero azioni ulteriori.
        segnaIncertoDelLancio(target.launchId);
        liberaCanale();
        // Il rifiuto deve dire PERCHE': esito del giudizio del gruppo, conti e
        // motivo dell'attestazione di sola lettura. Solo enumerazioni e numeri:
        // nessun errore grezzo, nessun segreto, nessun percorso.
        {
          const log = typeof cfg.log === 'function' ? cfg.log : console.warn;
          log(`fleet down ${cell.id}: risposta del teardown persa `
            + `(outcome=${esitoGruppo ? esitoGruppo.outcome : 'nessuno'}, `
            + `conti=${JSON.stringify((esitoGruppo && esitoGruppo.conti) || null)}, `
            + `attestazione=${motivoAttestazione || 'non-tentata'})`);
        }
        throw httpError(500,
          `down non dichiarabile per la cella ${cell.id}: connessione di controllo persa dopo il comando di teardown`,
          {
            outcome: esitoGruppo ? esitoGruppo.outcome : null,
            conti: (esitoGruppo && esitoGruppo.conti) || null,
            attestazione: motivoAttestazione,
          },
          { phase: 'teardown', code: 'STOP_UNKNOWN' });
      }
      let hostOutcome;
      try {
        hostOutcome = await chiudiHostPoiLease(target.launchId, famigliaLancio);
      } catch (e) {
        // Percorso eccezionale: prima la fence, poi la marcatura del NOSTRO lancio.
        verificaFenceLancio();
        segnaIncertoDelLancio(target.launchId);
        throw e;
      }
      verificaFenceLancio();
      liberaCanale();
      chiudiLancioPulito(target.launchId);
      if (leaseManager && typeof leaseManager.revokeControl === 'function') {
        try { leaseManager.revokeControl(cell.id); } catch (_) {}
      }
      cache = { ...cache, at: 0 };
      return {
        ok: true, cell: cellId, session: cell.tmuxSession, killed: true,
        outcome: 'attested-exit', host: hostOutcome,
      };
    }
    if (!r.ok) {
      segnaIncertoDelLancio(target.launchId);
      liberaCanale();
      throw httpError(500,
        `tmux kill-session failed: ${redactSecrets((r.testo || '').trim() || 'teardown rifiutato dal server', engine, cell)}`,
        null, { phase: 'teardown', code: 'KILL_SESSION_FAILED' });
    }
    // killed:true SOLO dopo verifica: rc0 da solo non prova che la sessione
    // sia finita davvero (e un teardown da dichiarare riuscito deve esserlo).
    const dopo = await canale.hasSession(target.sessionId);
    if (dopo.morto) {
      // Il client di controllo e' ATTACCATO alla sessione di questo lancio:
      // un kill-session ACCETTATO (risposta ricevuta sul canale vivo)
      // chiude quella sessione, e il client attached esce con lei. La morte
      // del canale DOPO il comando accettato e' quindi la conferma osservata
      // sul canale posseduto — il client esce solo se la sessione (o il
      // server che la contiene) finisce — non un esito ambiguo: nessun
      // client nuovo viene aperto per «rivedere» sul pathname del socket.
      // Restano ambigui, e restano STOP_UNKNOWN, i casi in cui la risposta
      // del comando non e' mai arrivata.
      // La barriera host resta PRIMA di togliere record e canale anche qui:
      // il kill accertato chiude la sessione, non il giudizio sull'host.
      let hostOutcome;
      try {
        hostOutcome = await chiudiHostPoiLease(target.launchId, famigliaLancio);
      } catch (e) {
        // Percorso eccezionale: prima la fence, poi la marcatura del NOSTRO lancio.
        verificaFenceLancio();
        segnaIncertoDelLancio(target.launchId);
        throw e;
      }
      verificaFenceLancio();
      liberaCanale();
      chiudiLancioPulito(target.launchId);
      if (leaseManager && typeof leaseManager.revokeControl === 'function') {
        try { leaseManager.revokeControl(cell.id); } catch (_) {}
      }
      cache = { ...cache, at: 0 };
      return {
        ok: true, cell: cellId, session: cell.tmuxSession, killed: true,
        outcome: esitoGruppo ? esitoGruppo.outcome : 'killed',
        host: hostOutcome,
        ...(esitoGruppo && esitoGruppo.conti ? { conti: esitoGruppo.conti } : {}),
      };
    }
    if (dopo.ok) {
      segnaIncertoDelLancio(target.launchId);
      liberaCanale();
      throw httpError(500,
        `down incompleto per la cella ${cell.id}: kill-session accettato ma la sessione risulta ancora presente`,
        null, { phase: 'teardown', code: 'STOP_INCOMPLETE' });
    }
    let hostOutcome;
    try {
      hostOutcome = await chiudiHostPoiLease(target.launchId, famigliaLancio);
    } catch (e) {
      // Percorso eccezionale: prima la fence, poi la marcatura del NOSTRO lancio.
      verificaFenceLancio();
      segnaIncertoDelLancio(target.launchId);
      throw e;
    }
    verificaFenceLancio();
    liberaCanale();
    chiudiLancioPulito(target.launchId);
    if (leaseManager && typeof leaseManager.revokeControl === 'function') {
      try { leaseManager.revokeControl(cell.id); } catch (_) {}
    }
    cache = { ...cache, at: 0 };
    return {
      ok: true, cell: cellId, session: cell.tmuxSession, killed: true,
      outcome: esitoGruppo ? esitoGruppo.outcome : 'killed',
      host: hostOutcome,
      ...(esitoGruppo && esitoGruppo.conti ? { conti: esitoGruppo.conti } : {}),
    };
  }

  // down — stesso lock per cella di up(): due richieste concorrenti della
  // stessa cella (up vs down, down vs down) si mettono in fila, mai affianco.
  async function down(cellId /* , opts */) {
    const previous = launchLocks.get(cellId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chained = previous.then(() => gate);
    launchLocks.set(cellId, chained);
    try {
      await previous;
      return await downSerializzato(cellId);
    } finally {
      release();
      if (launchLocks.get(cellId) === chained) launchLocks.delete(cellId);
    }
  }

  // restart = down (idempotente: cella non viva NON e' errore) seguito da up
  // (rilancia secondo la definizione corrente), come UNA transizione: le
  // varianti interne, non i wrapper col lock, cosi' nessun'altra richiesta
  // della stessa cella si infila fra la fermata e il rilancio. Un down che NON
  // si conclude propaga l'errore PRIMA di chiamare upSerializzato: mai un
  // nuovo client sopra uno stop incompleto.
  async function restart(cellId) {
    if (readonly()) throw httpError(403, 'READONLY: restart bloccato');
    // La catena del ciclo di vita (per radice dei file + cella) si acquisisce UNA
    // volta per l'intera transizione down+up, rilasciata nel finally: nessuna
    // altra richiesta si infila fra la fermata e il rilancio, e nessun up/down
    // concorrente oltrepassa la guardia mentre il restart e' in corso.
    const previous = launchLocks.get(cellId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chained = previous.then(() => gate);
    launchLocks.set(cellId, chained);
    const holder = {};
    try {
      await previous;
      await downSerializzato(cellId);
      // Stessa annotazione di up(): un fallimento DOPO il consumo del marcatore
      // «sessione nuova» resta visibile anche quando il lancio arriva da restart.
      try {
        return await upSerializzato(cellId, holder);
      } catch (e) {
        throw annotaEsitoSessioneNuova(e, cellId);
      }
    } finally {
      release();
      if (launchLocks.get(cellId) === chained) launchLocks.delete(cellId);
      avviaOsservatore(holder.osservatore);
    }
  }

  // --- Stato del lancio, letto senza mutare (P1-c: GET /api/fleet/launch-state)
  //
  // OSSERVAZIONE, non riconciliazione: il lock del ciclo di vita si GUARDA
  // (occupato = «inFlight», classificazione busy), non si attende e non si
  // acquisisce. Nessuna scrittura, nessun mkdir, nessun file di lock, nessun
  // figlio: le prove sono quelle del VALUTATORE UNICO con una deadline propria
  // (bounded), piu' le due sonde read-only di vl-roots — la qualifica della
  // root in lettura e l'osservazione della claim senza preparare la directory.
  // Lo snapshot e' DIAGNOSTICO: il POST ricalcola tutto sotto lock, non ci si
  // fida MAI di questa lettura. La risposta porta solo enum chiusi e id
  // bounded: nessun path, nessun nome di quarantena, nessun testo di record.
  async function launchState(cellId) {
    const defs = reloadDefs();
    const cell = findCell(defs, cellId);
    if (!cell) throw httpError(400, `cella sconosciuta: ${cellId}`);
    const inFlight = !!launchLocks.get(cell.id);
    const budgetTotale = Number.isSafeInteger(cfg.groupStopBudgetMs)
      && cfg.groupStopBudgetMs >= 200 && cfg.groupStopBudgetMs <= 15000
      ? cfg.groupStopBudgetMs : 8000;
    const scadenzaTotale = cooldownNow() + budgetTotale;
    const { targetRoot, valuta } = creaPercorsoRiconciliazione(cell, {
      scadenzaTotale,
      lancioInCorso: () => inFlight,
    });
    const letto = launchTarget.leggi(targetRoot, cell.tmuxSession);
    const valutazione = await valuta(letto);
    const record = letto.stato === 'presente' ? letto.record : null;
    // Sonde host/claim OSSERVATIVE: valgono per la diagnosi (una claim
    // straniera non e' una claim assente — la distinzione che un referto
    // diagnostico non puo' appiattire), non per il verdetto del valutatore:
    // quelle barriere si attraversano solo nel POST, sotto lock. Per un
    // lancio di famiglia 'other' la root vl non esiste e la domanda non si
    // pone; senza record (o record v1 senza famiglia) la sonda resta: e' la
    // diagnosi read-only delle claim orfane, ammessa dal design.
    const famiglia = record
      ? (record.family === 'other' ? 'other' : record.family === 'vl' ? 'vl' : null) : null;
    let root = 'n/a';
    let claim = 'n/a';
    if (famiglia !== 'other') {
      const owner = typeof identityOwnerInstanceId === 'function'
        ? identityOwnerInstanceId() : (identityOwnerInstanceId || 'local');
      let base = null;
      let rootAttesa = null;
      try {
        base = vlCellBaseDir(home, owner, cell.id);
        rootAttesa = radiceServer(home, owner, cell.id);
      } catch (_) { base = null; rootAttesa = null; }
      if (!base || !rootAttesa) { root = 'unresolvable'; claim = 'unresolvable'; }
      else {
        let q = null;
        try { q = qualificaRadiceInLettura(rootAttesa, base); } catch (_) { q = null; }
        root = !q || q.esito === 'rifiutata' ? 'unresolvable'
          : q.esito === 'assente' ? 'absent' : 'present';
        claim = osservaClaim({ home, root: rootAttesa, ownerInstanceId: owner, cellId: cell.id });
      }
    }
    return {
      ok: true,
      cell: cell.id,
      inFlight,
      classification: valutazione.classificazione,
      launchId: record ? record.launchId : null,
      phase: record ? record.phase : null,
      family: famiglia,
      proof: valutazione.prova,
      proofs: {
        ...valutazione.proofs,
        root,
        claim,
      },
      reconcilable: valutazione.riconciliabile,
      blockers: valutazione.blocchi,
    };
  }

  // --- Riconciliazione esplicita (P1-c: POST /api/fleet/reconcile) ----------
  //
  // La mutazione gemella del GET: le prove si RICALCOLANO qui, sotto il lock
  // del ciclo di vita della cella — la lettura di prima non vale niente. Il
  // lock e' la stessa catena di up/down/restart, ma l'attesa e' LIMITATA dal
  // budget: una catena occupata oltre il budget risponde busy con zero azioni,
  // non aspetta all'infinito. Il corpo e' il PERCORSO CONDIVISO di sempre
  // (valutatore unico, barriera host, rilascio della claim, commit in
  // quarantena): cosi' l'esito esplicito non puo' divergere dal down.
  // `launchId` e' obbligatorio e deve coincidere col record corrente: il POST
  // conferma una pratica precisa, non «chiudi quello che c'e'». L'API non
  // accetta path, PID, family, bootId o prove dal client.
  async function reconcile(cellId, launchIdRichiesto) {
    if (readonly()) throw httpError(403, 'READONLY: reconcile bloccato');
    const id = String(cellId || '');
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(id) || id === '.' || id === '..') {
      throw httpError(400, 'id cell non valido');
    }
    const launchId = String(launchIdRichiesto || '');
    if (!/^[0-9a-f]{16}$/.test(launchId)) throw httpError(400, 'launchId non valido');
    const defs = reloadDefs();
    const cell = findCell(defs, id);
    if (!cell) throw httpError(400, `cella sconosciuta: ${id}`);
    const budgetAttesa = Number.isSafeInteger(cfg.groupStopBudgetMs)
      && cfg.groupStopBudgetMs >= 200 && cfg.groupStopBudgetMs <= 15000
      ? cfg.groupStopBudgetMs : 8000;
    const previous = launchLocks.get(cellId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chained = previous.then(() => gate);
    launchLocks.set(cellId, chained);
    // L'attesa della catena e' una gara chiusa, non una coda aperta: superato
    // il budget la risposta e' busy e il RICHIEDENTE smette di aspettare; la
    // catena di proprieta' resta rappresentata in mappa finche' non drena
    // (vedi il ramo busy sotto). Il timer RESTA ref'd di proposito: un'attesa
    // in corso deve produrre la sua risposta anche in un runtime senza altri
    // handle (altrimenti il loop si svuota e il processo esce a meta'
    // operazione); si libera da se' nel finally, entro il budget.
    let timer = null;
    const scadenza = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), budgetAttesa);
    });
    let libera;
    try {
      libera = await Promise.race([
        previous.then(() => 'libera', () => 'libera'),
        scadenza,
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (libera !== 'libera') {
      // Solo l'ATTESA del richiedente viene abbandonata: il predecessore e'
      // ancora pendente e `launchLocks` e' l'unica barriera visibile a
      // up/down/restart e alla GET. Cancellare la voce qui scoprirebbe il
      // ciclo di vita in corso — un down chiuderebbe il record di un lancio
      // ancora da concludere, un up entrerebbe accanto al proprietario. Il
      // gate si rilascia (i successori gia' accodati su questo nodo non
      // devono aspettare anche il POST abbandonato), la mappa NON si tocca:
      // il nodo si toglie da solo quando DRENA — predecessore concluso e
      // gate gia' aperto — se nessun successore l'ha nel frattempo
      // sostituito in coda. FIFO conservata per i terzi accodati prima e
      // dopo il timeout.
      release();
      const smaltisci = () => {
        if (launchLocks.get(cellId) === chained) launchLocks.delete(cellId);
      };
      chained.then(smaltisci, smaltisci);
      return { ok: true, cell: cell.id, launchId, outcome: 'busy' };
    }
    try {
      return await reconcileSerializzato(cell, launchId);
    } finally {
      release();
      if (launchLocks.get(cellId) === chained) launchLocks.delete(cellId);
    }
  }

  async function reconcileSerializzato(cell, launchId) {
    const budgetTotale = Number.isSafeInteger(cfg.groupStopBudgetMs)
      && cfg.groupStopBudgetMs >= 200 && cfg.groupStopBudgetMs <= 15000
      ? cfg.groupStopBudgetMs : 8000;
    const scadenzaTotale = cooldownNow() + budgetTotale;
    const {
      targetRoot, budgetFinito, segnaIncerto, segnaIncertoDelLancio, valuta, fotografa, riconciliaLancio,
    } = creaPercorsoRiconciliazione(cell, { scadenzaTotale });
    // La riconciliazione SCRIVE (quarantena del record): stessa esclusione del
    // writer e stesso completamento dei commit pendenti del teardown. Un
    // commit rimasto a meta' si completa PRIMA, e se e' bloccato la risposta
    // e' il 409 di sempre: un rifiuto d'infrastruttura, non un esito valutato.
    assicuraScrittore('reconcile');
    completaCommitPendente(cell, 'reconcile');
    const letto = launchTarget.leggi(targetRoot, cell.tmuxSession);
    // Esiti in enum chiuso, 200: il cliente legge l'esito, non un errore.
    if (letto.stato === 'assente') {
      // Nessuna pratica aperta da riconciliare: onesto, e senza toccare le
      // guardie in-process che il down gestisce col suo percorso.
      return { ok: true, cell: cell.id, launchId, outcome: 'not-needed', classification: 'none' };
    }
    if (letto.stato !== 'presente' || !letto.record) {
      return {
        ok: true, cell: cell.id, launchId, outcome: 'blocked',
        classification: 'unreadable', blockers: ['RECORD_UNREADABLE'],
      };
    }
    const record = letto.record;
    if (record.launchId !== launchId) {
      // Il launchId chiuso deve essere quello del record corrente: il POST
      // conferma una pratica precisa, non l'ultima arrivata.
      return {
        ok: true, cell: cell.id, launchId, outcome: 'launch-mismatch',
        currentLaunchId: record.launchId,
      };
    }
    const foto = fotografa(letto);
    if (!foto) {
      return {
        ok: true, cell: cell.id, launchId, outcome: 'blocked',
        classification: 'unreadable', blockers: ['RECORD_CHANGED'],
      };
    }
    const valutazione = await valuta(letto);
    const base = {
      ok: true, cell: cell.id, launchId,
      classification: valutazione.classificazione,
      proof: valutazione.prova,
      blockers: valutazione.blocchi,
    };
    // Canale posseduto vivo: il lancio e' vivo e posseduto — niente da
    // riconciliare, nessuna mutazione.
    if (valutazione.classificazione === 'live') return { ...base, outcome: 'not-needed' };
    if (!valutazione.riconciliabile) {
      // Il budget scaduto da solo e' un esito SUO: si dichiara e l'incertezza
      // si segna, come fa il down; ogni altra mancanza di prova e' blocked.
      if (valutazione.blocchi.length === 1 && valutazione.blocchi[0] === 'BUDGET') {
        segnaIncertoDelLancio(launchId);
        return { ...base, outcome: 'budget' };
      }
      return { ...base, outcome: 'blocked' };
    }
    if (budgetFinito()) {
      segnaIncertoDelLancio(launchId);
      return { ...base, outcome: 'budget', blockers: [...new Set([...valutazione.blocchi, 'BUDGET'])] };
    }
    let riconciliato;
    try {
      riconciliato = await riconciliaLancio(letto, valutazione, foto);
    } catch (e) {
      segnaIncertoDelLancio(launchId);
      // Un errore ATTESO del percorso condiviso (host non fermo, claim non
      // rilasciata) e' un esito blocked/budget con codice bounded; un errore
      // che non e' di quel dominio non si traveste da esito: passa, e la
      // superficie HTTP lo dichiara per quello che e'.
      if (!e || typeof e.status !== 'number') throw e;
      return {
        ...base,
        outcome: budgetFinito() ? 'budget' : 'blocked',
        blockers: e.fleetCode ? [e.fleetCode] : base.blockers,
        ...(e.data && e.data.outcome ? { host: e.data.outcome } : {}),
      };
    }
    if (riconciliato.outcome !== 'reconciled') {
      segnaIncertoDelLancio(launchId);
      if (riconciliato.codice === 'BUDGET') {
        return { ...base, outcome: 'budget', blockers: [...new Set([...valutazione.blocchi, 'BUDGET'])] };
      }
      return {
        ...base, outcome: 'blocked', code: riconciliato.codice,
        ...(riconciliato.host ? { host: riconciliato.host } : {}),
        ...(riconciliato.dettaglio ? { detail: riconciliato.dettaglio } : {}),
      };
    }
    if (leaseManager && typeof leaseManager.revokeControl === 'function') {
      try { leaseManager.revokeControl(cell.id); } catch (_) {}
    }
    cache = { ...cache, at: 0 };
    // Il record e' in quarantena: l'indicatore e' backup, MAI il nome del
    // file (nessun path nell'API).
    return { ...base, outcome: 'reconciled', host: riconciliato.host, backup: true };
  }

  // Chiusura del runtime: chiude le connessioni di controllo POSSIEDUTE.
  // Non e' un teardown: chiudere la propria connessione non tocca i server
  // tmux ne' le sessioni; senza canale un down futuro dichiarera' l'identita'
  // non dimostrabile (esito onesto previsto dalla decisione Q2).
  function shutdown() {
    epocaRuntime += 1;
    abortaTuttiGliOsservatori();
    for (const canale of canaliControllo.values()) {
      try { canale.chiudi(); } catch (_) { /* best-effort */ }
    }
    canaliControllo.clear();
    if (scrittoreToken) {
      const radice = filesRootDi(cfg);
      if (radice) launchWriterLock.rilascia(radice, scrittoreToken);
      scrittoreToken = null;
    }
  }

  return {
    status, cellStatus, up, down, restart, isCellSession, launchState, reconcile,
    reloadDefs, cachedDefs, findCell, findEngine, refreshSessions, commitDefs,
    shutdown,
  };
}

module.exports = { createBuiltinRuntime, findCell, findEngine, identityLaunchRefusal, attestazioneAssenzaCanale, STATUS_TTL_MS, buildMcpReadinessPayload, cellMcpExpectedServers };
