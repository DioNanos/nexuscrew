'use strict';
// Delivery del bootstrap prompt per gli engine managed Kimi (kimi.native e
// claude.kimi-code) — NexusCrew 0.8.47. SOLO questi due engine: gli altri
// managed conservano il prompt su argv (finding separato) e i custom send-keys
// conservano injectPrompt legacy senza Enter.
//
// Contratto (design della revisione 0.8.47):
//  - Readiness REALE prima della consegna: il pane viene classificato sul SOLO
//    viewport visibile (capture-pane -p, mai scrollback -S: su generation>0 lo
//    scrollback puo' contenere vecchi prompt e marker stale). Auth, consenso
//    custom API key e onboarding/trust sono NOT_READY: nessun paste, nessun
//    Enter, la sessione resta viva e utilizzabile dall'operatore. UNKNOWN a
//    timeout NON diventa mai READY: la consegna viene saltata.
//  - AT-MOST-ONCE per generazione: UNA sola sequenza paste+Enter. Retry
//    automatico ammesso SOLO su fallimento certo PRE-paste (resolve pane o
//    load-buffer falliti): mai un secondo paste — dopo QUALUNQUE tentativo di
//    paste-buffer il composer potrebbe contenere testo parziale/completo e lo
//    stato e' DELIVERY_UNKNOWN/STAGED_NOT_SUBMITTED con zero secondo paste.
//    Dopo un Enter OK l'esito e' 'submitted' e non esiste replay.
//  - Classifier enum-only: il testo catturato non viene MAI loggato,
//    persistito o incluso in risposte; esce solo lo stato bounded.
//  - Recovery da catalogo costante; mai suggerire /login Anthropic per
//    claude.kimi-code (il recovery corretto e' il consenso Kimi in /config).
const { tmuxExec, securePaste, resolveSessionPane, promptCharsOk, sleep } = require('./launch.js');

// Stati bounded del classifier pane. Output unico esposto all'esterno.
const PANE_STATES = Object.freeze([
  'ready', 'busy', 'not-ready-auth', 'not-ready-consent', 'not-ready-onboarding', 'unknown',
]);

// Esiti bounded della consegna (prompt.reason in API: closed enum).
const DELIVERY_STATES = Object.freeze([
  'submitted',             // paste ok + pane riverificato + Enter ok
  'staged-not-submitted',  // paste ok, Enter fallito: testo forse nel composer
  'delivery-unknown',      // paste tentato con esito incerto / pane sparito dopo il paste
  'failed-pre-paste',      // resolve/load certamente falliti (anche dopo 1 retry)
  'skipped-not-ready',     // classifier not-ready a fine attesa bounded (kind in notReady)
  'skipped-unknown',       // classifier mai ready entro il timeout
  // D-558 (vl): il bootstrap vl e' saltato in modo ESPLICITO, motivo bounded
  // in notReady (VL_SKIP_REASONS). Mai presentato come bootstrap riuscito.
  'skipped-vl-bootstrap',
  'prompt-rejected',       // control bytes found in the prompt (policy check)
  'cancelled',             // Generazione terminata durante l'attesa/consegna
  'report-timeout',        // up() non ha ricevuto l'esito del launcher entro il bound
  // Opt-in submit (F4): il chiamante non ha attestato un trasporto delimitato,
  // quindi non si incolla nulla. Nessun degrado a testo grezzo e' implementato.
  'transport-unsupported',
  // Policy restartReprompt (consegna paste-only della gen0 da parte del
  // supervisore): paste-delivered = paste riuscito SENZA Enter (NC non attesta
  // l'Enter del guardiano esterno, quindi non e' 'submitted');
  // paste-failed:<stage> = fallimento certo PRE-paste (validate/resolve/load):
  // nulla e' stato digitato e la generazione prosegue senza prompt.
  'paste-delivered',
  'paste-failed',
]);

// Codici bounded actionRequired. Nessuna inferenza "rifiutato": il marker
// TUI prova solo che serve un'azione nel terminale della cella.
const ACTION_CODES = Object.freeze(['KIMI_AUTH_ACTION_REQUIRED', 'CLIENT_INTERACTION_REQUIRED']);

// Slug recovery bounded: l'API trasporta SOLO {code, recovery}; il testo
// e' mappato localmente dalla PWA via i18n (fleet-recovery-<slug>), mai inviato
// dal server (un nodo remoto federato non deve poter iniettare testo libero).
const RECOVERY_SLUGS = Object.freeze([
  'kimi-code-consent-yes',
  'kimi-code-config-custom-api-key',
  'kimi-cli-login',
  'client-terminal-dialog',
]);

// Marker di dialoghi MODALI full-screen: occupano la viewport, valgono su
// tutto il catturato visibile (non solo la coda).
// Live-verificati: claude 2.1.220 (consent custom API key, trust dialog).
const MODAL_NOT_READY = Object.freeze([
  ['not-ready-consent', /Detected a custom API key in your environment|Do you want to use this API key\?/],
  ['not-ready-onboarding', /Yes, I trust this folder|Quick safety check/],
]);

// Marker ancorati alla CODA visibile (status bar / righe finali): lo stesso
// testo in scrollback, nel corpo conversazione o in forma diversa non deve
// Classificare (il marker auth e' la stringa ESATTA di status bar, non un
// "Not logged in" qualunque). Live-verificati: claude 2.1.220 (status bar
// "Not logged in · Run /login"), kimi 0.31.1 (welcome "Run /login or
// /provider", "Model: not set").
const TAIL_NOT_READY = Object.freeze([
  ['not-ready-auth', /Not logged in · (?:Please run|Run) \/login\b/],
  ['not-ready-auth', /Run \/login or \/provider|Model:\s+not set\b/],
]);

// TUI occupata a processare (restart durante lavoro residuo): si attende.
const BUSY_TAIL = /esc to interrupt/i;

const TAIL_LINES = 14;

// ---------------------------------------------------------------------------
// VL 0.4 status line (D-558). La riga di stato corrente — quella VICINO AL
// COMPOSER, terzultima riga del pane — mostra `VL <faccia> <parola>`. La
// tabella è la copia esatta di crates/vl-tui/src/faces(_regression).rs di
// VL 0.4: pick() è totalmente ordinato (offline › error › asking › alarm ›
// compacting › working › thinking › done › resting › ready), quindi UNA sola
// faccia è quella corrente.
//
// R4 (audit): PRIMA si trova la riga di stato CANDIDATA più vicina al
// composer (l'ULTIMA riga che si dichiara riga di stato VL, anche se la
// parola/glifo sono incompleti o non riconosciuti), POI la si interpreta.
// La candidata presente ma non riconosciuta/troncata vale 'unknown': NIENTE
// scansione all'indietro su righe precedenti note e NIENTE fallback legacy
// 0.3 — la superficie corrente non interpretabile non può promuovere testo
// precedente ad autorizzazione di paste/Enter (fail-closed). Il legacy 0.3
// resta valido SOLO senza alcuna riga candidata 0.4 nel tail. FaceClock
// spegne done dopo 3 s (DONE_FOR) e ripiega su ready: una conversazione
// popolata torna ready, e questo NON è una prova di sessione vergine (la
// guardia D-558 sta nella claim del launcher, non qui).
// ---------------------------------------------------------------------------
const VL_FACES = Object.freeze([
  { face: 'offline', word: 'offline', unicode: '(◡_◡)⌁', ascii: '[._.]' },
  { face: 'error', word: 'error', unicode: '(×_×)', ascii: '[x_x]' },
  { face: 'asking', word: 'asking', unicode: '(・_・)⁇', ascii: '[?_?]' },
  { face: 'alarm', word: 'alarm', unicode: '(⊙_⊙)!', ascii: '[O_O]' },
  { face: 'compacting', word: 'compacting', unicode: '(•_•)⇄', ascii: '[o_o]~' },
  { face: 'working', word: 'working', unicode: '(•̀ᴗ•́)', ascii: '[>_<]' },
  { face: 'thinking', word: 'thinking', unicode: '(•_•)?', ascii: '[o_O]' },
  { face: 'done', word: 'done', unicode: '(^‿^)', ascii: '[^_^]' },
  { face: 'resting', word: 'resting', unicode: '(－_－)zz', ascii: '[-_-]' },
  { face: 'ready', word: 'ready', unicode: '(•‿•)', ascii: '[o_o]' },
]);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Una riga di stato VL 0.4 riconosciuta: `VL <glifo noto> <parola della
// faccia>` — il glifo deve essere ESATTAMENTE uno della tabella (Unicode o
// ASCII), la parola esattamente quella della faccia (working è seguita da
// ` · bash` / ` | bash` in VL 0.4, quindi word in coda di riga con \b).
const VL_FACE_RES = VL_FACES.map((f) => ({
  face: f.face,
  re: new RegExp(`^\\s*VL\\s+(?:${escapeRe(f.unicode)}|${escapeRe(f.ascii)})\\s+${f.word}\\b`),
}));

// Una riga che SI Dichiara riga di stato VL 0.4: `VL` a inizio riga seguito
// da un confine di parola. È la CANDIDATA, a prescindere dal riconoscimento:
// anche una cattura troncita (parola o glifo incompleti) si dichiara comunque
// superficie di stato corrente e non può essere scavalcata da righe vecchie.
const VL_CANDIDATE_RE = /^\s*VL\b/;

// La riga di stato candidata più VICINA al composer (l'ultima nel tail), o
// null se il tail non contiene alcuna superficie VL 0.4. Pura.
function vlCandidateLine(text) {
  const lines = tailOf(String(text || '')).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (VL_CANDIDATE_RE.test(lines[i])) return lines[i];
  }
  return null;
}

// Stato corrente del pane vl (R4): PRIMA la candidata, POI l'interpretazione.
//   faccia nota   -> la faccia della candidata (bounded);
//   'unknown'     -> candidata presente ma non riconosciuta/troncata: la
//                    superficie corrente non è interpretabile, fail-closed;
//   null          -> nessuna riga candidata 0.4 nel tail (legacy possibile).
// Pura: fuori esce solo il valore bounded.
function vlCurrentFace(text) {
  const candidate = vlCandidateLine(text);
  if (candidate === null) return null;
  for (const { face, re } of VL_FACE_RES) {
    if (re.test(candidate)) return face;
  }
  return 'unknown';
}

// Facce IDLE della TUI vl (disponibile ≠ bootstrap-abilitata): ready, done,
// error, resting rendono osservabile una TUI ferma. done scade in ready dopo
// 3 s; error non garantisce un provider funzionante — qui si dichiara solo
// disponibilità, mai idoneità al bootstrap (per quella serve 'ready' + claim).
const VL_IDLE_FACES = Object.freeze(['ready', 'done', 'error', 'resting']);

// vlPaneIdle(text): la TUI vl è in uno stato idle osservabile.
function vlPaneIdle(text) {
  const face = vlCurrentFace(text);
  // R4: candidata corrente non riconosciuta/troncata -> NON idle (si attende
  // e, a timeout, la readiness degrada secondo contratto: mai per euristica).
  if (face === 'unknown') return false;
  if (face) return VL_IDLE_FACES.includes(face);
  // Compatibilità legacy VERSIONATA (Vivling 0.3, agosto 2026): il marcatore
  // storico [o] resta riconosciuto SOLO finché una riga VL 0.4 non compare.
  // Non è una prova di sessione vergine: è la vecchia superficie di stato.
  return /vivling\s+\[o\].*esc quit · \^y yield/.test(tailOf(String(text || '')));
}

function tailOf(text) {
  const lines = String(text).split('\n');
  const nonEmpty = [];
  for (let i = lines.length - 1; i >= 0 && nonEmpty.length < TAIL_LINES; i -= 1) {
    if (lines[i].trim() !== '') nonEmpty.unshift(lines[i]);
  }
  return nonEmpty.join('\n');
}

// classifyPane(captured, client) -> PANE_STATES enum. Pura, senza dipendenze:
// il testo resta dentro la funzione, fuori esce solo lo stato bounded.
// client: 'kimi' | 'claude' | 'vl' (gli altri non passano mai di qui: 'unknown').
function classifyPane(captured, client) {
  const text = typeof captured === 'string' ? captured : '';
  if (!text.trim()) return 'unknown';
  for (const [state, re] of MODAL_NOT_READY) if (re.test(text)) return state;
  const tail = tailOf(text);
  for (const [state, re] of TAIL_NOT_READY) if (re.test(tail)) return state;
  if (BUSY_TAIL.test(tail)) return 'busy';
  if (client === 'kimi') {
    // READY positivo Kimi: box di input corrente E modello configurato.
    // Il solo "Model:" non basta; la sola box non basta (presente anche da
    // logged-out). Il welcome logged-out e' gia' intercettato dai marker
    // not-ready qui sopra; se scrolla via senza login resta 'unknown' (safe).
    const box = /^\s*│\s*>/m.test(text);
    const model = /! to run a shell command/.test(tail) || /Model:\s+(?!not set\b)\S/.test(text);
    return box && model ? 'ready' : 'unknown';
  }
  if (client === 'claude') {
    // READY positivo Claude: riga prompt "❯" in coda, assenza dei marker
    // not-ready (gia' valutati sopra: il cursore ❯ dei dialoghi non inganna).
    return /^\s*❯/m.test(tail) ? 'ready' : 'unknown';
  }
  if (client === 'vl') {
    // D-558: VL 0.4. Bootstrap-ready SOLO 'ready' (la guardia vera è la claim
    // del launcher, gestita in runtime/cell-exec: ready da solo non basta).
    // Le facce occupate o non consegnabili (thinking/working/asking/compacting,
    // offline, error, done, resting, alarm) sono 'busy': si attende bounded e
    // a timeout si salta con skipped-not-ready — MAI paste alla cieca su
    // unknown/timeout. Busy e asking NON sono mai disponibili.
    // R4: la candidata corrente non riconosciuta/troncata è 'unknown' — niente
    // scansione all'indietro e niente fallback legacy: la superficie corrente
    // non interpretabile non autorizza mai paste/Enter.
    const face = vlCurrentFace(text);
    if (face === 'unknown') return 'unknown';
    if (face) return face === 'ready' ? 'ready' : 'busy';
    // Legacy VERSIONATO Vivling 0.3 (vedi vlPaneIdle): SOLO senza alcuna riga
    // candidata VL 0.4 nel tail.
    return /vivling\s+\[o\].*esc quit · \^y yield/.test(tail) ? 'ready' : 'unknown';
  }
  return 'unknown';
}

// vlPaneReadiness(tmuxBin, target, opts) -> { ready, degraded }
// Content-readiness (DISPONIBILITÀ) di una cella vl via pane — D-558: VL 0.4
// con facce idle ready/done/error/resting (vlPaneIdle), legacy 0.3 versione.
// E' il PUNTO DI INNESTO della readiness vl: quando arrivera' l'adapter di
// runtime, la readiness si misurera' sul socket di controllo
// (vl-core/src/transport.rs) e non sul pane — si sostituisce questa funzione,
// non si cercano capture-pane sparsi nel codice. Un solo chiamante
// (runtime.js, ramo vl post-liveness).
//
// MAI fail-closed su un'euristica di testo. Se entro il timeout nessuna faccia
// idle compare (backend che cambia la riga di stato, pane non ancora stabile),
// DEGRADA: ritorna {ready:true, degraded:true} e procede come se fosse pronta.
// Una cella che oggi parte deve partire anche domani: il peggio ammesso e'
// tornare al comportamento di oggi (avvio sulla sola liveness), MAI "non parte
// piu'". Il chiamante lascia traccia del degrado (readinessDegraded nel risultato).
async function vlPaneReadiness(tmuxBin, target, {
  env, timeoutMs = 12000, pollMs = 400, captureImpl, sleepImpl, nowImpl, socket,
} = {}) {
  const sleepFn = sleepImpl || sleep;
  const now = nowImpl || Date.now;
  const capture = captureImpl || (async () => {
    const argv = (typeof socket === 'string' && socket.startsWith('/'))
      ? ['-S', socket, 'capture-pane', '-p', '-t', target]
      : ['capture-pane', '-p', '-t', target];
    const r = await tmuxExec(tmuxBin, argv, { env, timeoutMs: 2000 });
    return r.err ? null : r.stdout;
  });
  const deadline = now() + Math.max(0, timeoutMs);
  for (;;) {
    const text = await capture();
    if (text !== null && vlPaneIdle(text)) return { ready: true, degraded: false };
    if (now() >= deadline) return { ready: true, degraded: true };
    await sleepFn(pollMs);
  }
}

function clampInt(value, dflt, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// deliverBootstrapPrompt(opts) -> { delivered, state, notReady, attempts, reason }
//   opts: { tmuxBin, session, prompt, client ('kimi'|'claude'), env,
//           paneTarget (%N opzionale), readyWaitMs, pollMs, settleMs, tmpdir,
//           tmuxExecImpl, captureImpl, sleepImpl, nowImpl, fsImpl, isCancelled }
// reason e' SEMPRE lo state (closed enum); notReady e' il kind bounded o ''.
// IsCancelled: valutato ad OGNI poll, prima del paste e prima dell'
// Enter; se true la consegna si ferma subito ('cancelled') senza paste/Enter —
// cell-exec cancella la delivery quando la generazione termina, cosi' un
// polling in volo non puo' mai iniettare nella generazione successiva.
async function deliverBootstrapPrompt(opts = {}) {
  const { tmuxBin, session, prompt } = opts;
  const client = typeof opts.client === 'string' ? opts.client : '';
  const env = opts.env;
  const exec = opts.tmuxExecImpl || tmuxExec;
  const sleepImpl = opts.sleepImpl || sleep;
  const now = opts.nowImpl || Date.now;
  const cancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
  const target = opts.paneTarget || `=${session}`;
  const readyWaitMs = clampInt(opts.readyWaitMs, 15000, 0, 120000);
  const pollMs = clampInt(opts.pollMs, 400, 50, 5000);
  const settleMs = clampInt(opts.settleMs, 150, 0, 5000);
  const done = (delivered, state, notReady, attempts, mcp) => ({
    delivered, state, notReady, attempts, reason: state,
    ...(mcp ? { mcp } : {}),
  });
  if (!promptCharsOk(prompt)) return done(false, 'prompt-rejected', '', 0);

  const capture = opts.captureImpl || (async () => {
    const r = await exec(tmuxBin, ['capture-pane', '-p', '-t', target], { env, timeoutMs: 2000 });
    return r.err ? null : r.stdout;
  });

  // (1) Attesa readiness bounded: solo 'ready' positivo sblocca la consegna.
  let paneState = 'unknown';
  const deadline = now() + readyWaitMs;
  for (;;) {
    if (cancelled()) return done(false, 'cancelled', '', 0);
    const text = await capture();
    if (cancelled()) return done(false, 'cancelled', '', 0);
    paneState = text === null ? 'unknown' : classifyPane(text, client);
    if (paneState === 'ready') break;
    if (now() >= deadline) {
      return paneState === 'unknown'
        ? done(false, 'skipped-unknown', '', 0)
        : done(false, 'skipped-not-ready', paneState, 0);
    }
    await sleepImpl(pollMs);
  }

  // (1b) Gate readiness MCP opzionale (solo claude.*): la mcpWait e'
  // fornita dal supervisore, con deadline ASSOLUTA composta sullo stesso
  // orologio del launch (tetto MCP dal budget approvato, mai un budget nuovo a
  // valle). Il composer pronto resta SEMPRE obbligatorio: qui si arriva solo
  // col pane ready. A budget esaurito senza MCP pronti la consegna prosegue
  // come AVVIO DEGRADATO VISIBILE: esito submitted/degraded con l'elenco
  // bounded dei server failed/pending, mai un lancio silenzioso.
  let mcp = null;
  if (typeof opts.mcpWait === 'function') {
    const r = await opts.mcpWait({ isCancelled: cancelled });
    if (cancelled() || !r || r.cancelled) return done(false, 'cancelled', '', 0);
    mcp = {
      state: r.state === 'ready' ? 'ready' : 'degraded',
      ready: Array.isArray(r.ready) ? r.ready : [],
      failed: Array.isArray(r.failed) ? r.failed : [],
      pending: Array.isArray(r.pending) ? r.pending : [],
    };
  }

  // (2) Consegna AT-MOST-ONCE: delega al nucleo condiviso con il percorso
  // submit opt-in (v. deliverPastedAtMostOnce). L'unica differenza rispetto
  // al submit e' la readiness: qui e' CLASSIFICATA (kimi/claude), e la stessa
  // classificazione viene riverificata prima dell'unico retry pre-paste.
  const core = await deliverPastedAtMostOnce(opts, {
    exec,
    sleepImpl,
    cancelled,
    target,
    recheckPrePaste: async () => {
      const text = await capture();
      const again = text === null ? 'unknown' : classifyPane(text, client);
      return again === 'ready';
    },
  });
  void settleMs; void pollMs;
  return done(core.delivered, core.state, '', core.attempts, mcp);
}

// deliverPastedAtMostOnce(opts, ctx) -> { delivered, state, attempts }
//
// NUCLEO UNICO della consegna con Enter (F4, 2026-10-22). Un solo paste
// delimitato, poi UN solo Enter sullo STESSO %N riverificato; nessun retry dopo
// un tentativo di paste-buffer, in nessun esito.
//
// Estratto dal percorso bootstrap perche' la disciplina non venga copiata in
// una versione piu' debole (mandato F4: «riusando la disciplina at-most-once
// del percorso bootstrap, non una copia piu' debole»). Bootstrap (kimi/claude)
// e submit opt-in degli engine custom send-keys passano da QUI: cambia solo la
// readiness, che il chiamante inietta con `recheckPrePaste`.
//
// Garanzie, una per riga di codice sotto:
//  - 'cancelled' valutato PRIMA del paste e ad OGNI await successivo;
//  - dopo un paste tentato non esiste un secondo paste ('delivery-unknown');
//  - l'Enter usa il %N del paste, mai il nome sessione, e solo dopo averlo
//    ri-risolto uguale (pane riusato o generazione cambiata -> nessun Enter);
//  - il successo di `send-keys` non viene mai promosso a "prompt consumato":
//    'submitted' significa paste+Enter, non accettazione del TUI.
async function deliverPastedAtMostOnce(opts = {}, ctx = {}) {
  const { tmuxBin, session, prompt } = opts;
  const env = opts.env;
  const exec = ctx.exec || opts.tmuxExecImpl || tmuxExec;
  const sleepImpl = ctx.sleepImpl || opts.sleepImpl || sleep;
  const cancelled = ctx.cancelled || (() => false);
  const target = ctx.target || opts.paneTarget || `=${session}`;
  const settleMs = clampInt(opts.settleMs, 150, 0, 5000);
  const pollMs = clampInt(opts.pollMs, 400, 50, 5000);
  const recheckPrePaste = typeof ctx.recheckPrePaste === 'function'
    ? ctx.recheckPrePaste : async () => true;
  const out = (delivered, state, attempts) => ({ delivered, state, attempts });
  // Il retry copre SOLO fallimenti certi pre-paste (resolve/load).
  let attempts = 0;
  for (;;) {
    if (cancelled()) return out(false, 'cancelled', attempts);
    attempts += 1;
    const stage = await securePaste(tmuxBin, session, prompt, {
      env, exec, target, tmpdir: opts.tmpdir, fsImpl: opts.fsImpl,
      // Il predicato entra negli stadi: resolve, load e paste lo
      // controllano prima di ogni effetto.
      isCancelled: cancelled,
    });
    // Lo stadio decide l'esito PRIMA della cancellazione: da quando il paste e'
    // stato tentato l'incertezza e' irreversibile e non si perde mai, nemmeno
    // su errore, cancellazione o cleanup.
    if (stage.stage === 'paste') return out(false, 'delivery-unknown', attempts);
    if (stage.ok) {
      if (cancelled()) return out(false, 'delivery-unknown', attempts);
      await sleepImpl(settleMs);
      if (cancelled()) return out(false, 'delivery-unknown', attempts);
      // Riverifica dello stesso %N sulla stessa sessione prima dell'Enter.
      const paneAgain = await resolveSessionPane(tmuxBin, session, { env, exec, target });
      if (paneAgain !== stage.paneId) return out(false, 'delivery-unknown', attempts);
      if (cancelled()) return out(false, 'delivery-unknown', attempts);
      const enter = await exec(tmuxBin, ['send-keys', '-t', stage.paneId, 'Enter'], { env });
      if (enter.err) return out(false, 'staged-not-submitted', attempts);
      // Cancel con Enter appena partito -> la generazione e' morta con un
      // submit in volo: esito incerto (residuo PTY possibile), mai 'submitted'.
      if (cancelled()) return out(false, 'delivery-unknown', attempts);
      return out(true, 'submitted', attempts);
    }
    if (stage.stage === 'validate') return out(false, 'prompt-rejected', attempts);
    if (stage.stage === 'cancelled' || cancelled()) {
      // Pre-paste e gia' invalidata: nessun effetto, nessuna traccia lasciata.
      return out(false, 'cancelled', attempts);
    }
    if (attempts >= 2) return out(false, 'failed-pre-paste', attempts);
    // Fallimento certo PRE-paste: un solo retry, readiness riverificata prima.
    await sleepImpl(pollMs);
    if (cancelled()) return out(false, 'cancelled', attempts);
    if (!(await recheckPrePaste())) return out(false, 'failed-pre-paste', attempts);
  }
}

// submitPromptWithEnter(opts) -> { delivered, state, notReady:'', attempts, reason }
//   opts: { tmuxBin, session, prompt, env, paneTarget, readyWaitMs, pollMs,
//           settleMs, tmpdir, bracketedPaste, isCancelled, tmuxExecImpl,
//           sleepImpl, nowImpl, fsImpl }
//
// Percorso OPT-IN `submit: 'enter'` degli engine CUSTOM con promptMode
// 'send-keys'. Assente = comportamento storico (paste senza Invio, injectPrompt
// in launch.js): qui non si tocca nulla di quel ramo. Gli engine MANAGED vl
// restano fuori (usano VL_SYSTEM_APPEND_FILE): il chiamante non arriva qui.
//
// Stesso transport del bootstrap (securePaste: load-buffer su file 0600 +
// paste-buffer -p sul %N risolto) e stesso nucleo at-most-once; qui la
// readiness non e' classificata (un engine custom non ha un classifier di
// contenuto) ma di TRASPORTO: il pane deve esistere, essere vivo ed essere
// quello atteso, entro un'attesa bounded.
//
// TRASPORTO DELIMITATO (F4). tmux inserisce i codici di bracketed paste solo se
// l'applicazione nel pane li ha richiesti (tmux(1), paste-buffer -p); altrimenti
// il testo arriva GREZZO e un LF diventa Invio. tmux 3.4 non espone quello
// stato in alcun formato: misurato il 2026-10-22 con `display-message -a` (120
// variabili, nessuna pertinente; `bracketed_paste_flag` e' sconosciuto e si
// espande vuoto). Non esiste quindi una sonda runtime onesta, e indovinare e'
// escluso: il percorso si apre SOLO su attestazione esplicita del chiamante
// (`bracketedPaste === true`, cioe' l'opt-in `submit: 'enter'` gia' validato
// nella definizione e collaudato sul client). Senza attestazione si risponde
// 'transport-unsupported' con ZERO paste e ZERO Enter. In nessun ramo di questo
// file esiste un ripiego a `send-keys -l <testo>`: il degrado a tasti grezzi
// non e' implementabile per distrazione.
async function submitPromptWithEnter(opts = {}) {
  const { tmuxBin, session, prompt } = opts;
  const env = opts.env;
  const exec = opts.tmuxExecImpl || tmuxExec;
  const sleepImpl = opts.sleepImpl || sleep;
  const now = opts.nowImpl || Date.now;
  const cancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
  const target = opts.paneTarget || `=${session}`;
  const readyWaitMs = clampInt(opts.readyWaitMs, 15000, 0, 120000);
  const pollMs = clampInt(opts.pollMs, 400, 50, 5000);
  const out = (delivered, state, attempts) => ({
    delivered, state, notReady: '', attempts, reason: state,
  });
  if (opts.bracketedPaste !== true) return out(false, 'transport-unsupported', 0);
  if (!promptCharsOk(prompt)) return out(false, 'prompt-rejected', 0);

  // (1) Readiness di trasporto, bounded: nessun sleep cieco, nessun paste su
  // un pane che non esiste o non e' piu' quello della sessione attesa.
  const deadline = now() + readyWaitMs;
  for (;;) {
    if (cancelled()) return out(false, 'cancelled', 0);
    const paneId = await resolveSessionPane(tmuxBin, session, { env, exec, target });
    if (paneId) break;
    if (now() >= deadline) return out(false, 'failed-pre-paste', 0);
    await sleepImpl(pollMs);
  }

  // (2) Un solo paste, un solo Enter.
  const core = await deliverPastedAtMostOnce(opts, {
    exec,
    sleepImpl,
    cancelled,
    target,
    recheckPrePaste: async () => (await resolveSessionPane(
      tmuxBin, session, { env, exec, target })) !== null,
  });
  return out(core.delivered, core.state, core.attempts);
}

// WaitDeliveryReport(tmuxBin, target, opts) -> delivery-like null.
// Il launcher supervisionato (cell-exec) e' l'UNICO owner della consegna per
// TUTTE le generazioni degli engine Kimi e claude.* e pubblica l'esito bounded
// sull'opzione tmux di pane @nc_delivery ('<state>' / '<state>:<notReady>' /
// '<state>:<notReady>:mcp<state>' dal 0.9.41, solo enum chiusi; muore col
// pane, nessuno state file). Con degrado MCP l'elenco bounded dei server
// failed/pending viaggia su @nc_mcp_list ('failed=a,b|pending=c', nomi
// validati). up() la legge con attesa bounded: niente paste dal runtime,
// niente doppio writer cross-generation.
const MCP_REPORT_STATES = Object.freeze(['ready', 'degraded']);
const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Motivi bounded dello skip vl (D-558): viaggiano nella posizione notReady di
// @nc_delivery (`skipped-vl-bootstrap:<motivo>`). Closed enum, niente testo
// libero dal launcher remoto. Per avvio (requisito DAG 30/10): host-pre-existing
// non è più un motivo di skip, ogni avvio consegna una volta.
const VL_SKIP_REASONS = Object.freeze([
  'claim-taken',        // avvio già rivendicato (stesso launchId: respawn/concorrenza)
  'claim-unavailable',  // claim non materializzabile durevole in sicurezza: nessun paste
  'generation',         // generazione > 0 del supervisore: skip esplicito, mai reinvio
  'no-proof',           // payload senza decisione vlBootstrap valida: fail-closed
]);

function parseMcpListOption(raw) {
  const out = { failed: [], pending: [] };
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return out;
  for (const part of text.split('|')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const kind = part.slice(0, eq);
    if (kind !== 'failed' && kind !== 'pending') continue;
    for (const nome of part.slice(eq + 1).split(',')) {
      if (nome && MCP_NAME_RE.test(nome) && !out[kind].includes(nome)) out[kind].push(nome);
    }
  }
  return out;
}

async function waitDeliveryReport(tmuxBin, target, { env, exec, sleepImpl, nowImpl, timeoutMs, pollMs, socket } = {}) {
  const run = exec || tmuxExec;
  const sleepFn = sleepImpl || sleep;
  const now = nowImpl || Date.now;
  const suSocket = (argv) => (typeof socket === 'string' && socket.startsWith('/')
    ? ['-S', socket, ...argv]
    : argv);
  const deadline = now() + clampInt(timeoutMs, 18000, 100, 150000);
  const step = clampInt(pollMs, 300, 50, 5000);
  for (;;) {
    const r = await run(tmuxBin, suSocket(
      ['display-message', '-p', '-t', target, '#{@nc_delivery}'],
    ), { env, timeoutMs: 2000 });
    const raw = r.err ? '' : r.stdout.trim();
    if (raw) {
      const [state, notReady = '', mcpTag = ''] = raw.split(':');
      if (!DELIVERY_STATES.includes(state)) return null;   // valore non bounded: mai fidarsi
      const kind = PANE_STATES.includes(notReady) || VL_SKIP_REASONS.includes(notReady)
        ? notReady : '';
      const mcpState = mcpTag.startsWith('mcp') && MCP_REPORT_STATES.includes(mcpTag.slice(3))
        ? mcpTag.slice(3) : '';
      let mcp = null;
      if (mcpState) {
        const r2 = await run(tmuxBin, suSocket(
          ['display-message', '-p', '-t', target, '#{@nc_mcp_list}'],
        ), { env, timeoutMs: 2000 });
        const { failed, pending } = parseMcpListOption(r2.err ? '' : r2.stdout);
        mcp = { state: mcpState, ready: [], failed, pending };
      }
      return {
        delivered: state === 'submitted',
        // Il kind bounded (PANE_STATES o VL_SKIP_REASONS) sale SOLO con gli
        // stati skip; qualsiasi altro valore e' gia' stato droppato sopra.
        state,
        notReady: state === 'skipped-not-ready' || state === 'skipped-vl-bootstrap' ? kind : '',
        attempts: 0, reason: state,
        ...(mcp ? { mcp } : {}),
      };
    }
    if (now() >= deadline) return null;
    await sleepFn(step);
  }
}

// actionRequiredFor(client, provider, delivery) -> null | { code, recovery }
// Mappa bounded delivery -> azione operatore. Solo skip per not-ready/unknown
// producono actionRequired; i fallimenti di trasporto restano nel prompt.state.
// SOLO {code, recovery} closed enum/slug — il testo e' i18n locale PWA.
function actionRequiredFor(client, provider, delivery) {
  if (!delivery || delivery.delivered) return null;
  if (delivery.state !== 'skipped-not-ready' && delivery.state !== 'skipped-unknown') return null;
  const kind = delivery.notReady;
  let recovery = 'client-terminal-dialog';
  let code = 'CLIENT_INTERACTION_REQUIRED';
  if (provider === 'kimi-code') {
    code = kind === 'not-ready-consent' || kind === 'not-ready-auth'
      ? 'KIMI_AUTH_ACTION_REQUIRED' : 'CLIENT_INTERACTION_REQUIRED';
    recovery = kind === 'not-ready-consent' ? 'kimi-code-consent-yes'
      : kind === 'not-ready-auth' ? 'kimi-code-config-custom-api-key'
        : 'client-terminal-dialog';
  } else if (client === 'kimi') {
    if (kind === 'not-ready-auth') {
      code = 'KIMI_AUTH_ACTION_REQUIRED';
      recovery = 'kimi-cli-login';
    }
  }
  if (!ACTION_CODES.includes(code) || !RECOVERY_SLUGS.includes(recovery)) return null;
  return { code, recovery };
}

module.exports = {
  PANE_STATES, DELIVERY_STATES, ACTION_CODES, RECOVERY_SLUGS, MCP_REPORT_STATES, parseMcpListOption,
  VL_FACES, VL_IDLE_FACES, VL_SKIP_REASONS, vlCandidateLine, vlCurrentFace, vlPaneIdle,
  classifyPane, deliverBootstrapPrompt, waitDeliveryReport, actionRequiredFor, vlPaneReadiness,
  submitPromptWithEnter, deliverPastedAtMostOnce,
};
