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
  // The vl bootstrap is skipped EXPLICITLY, with a bounded reason in
  // notReady (VL_SKIP_REASONS). Never reported as a successful bootstrap.
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
// VL 0.4 status line. The current status line — the one NEAR THE COMPOSER,
// third-to-last line of the pane — shows `VL <face> <word>`. The table is
// an exact copy of crates/vl-tui/src/faces(_regression).rs of VL 0.4:
// pick() is totally ordered (offline › error › asking › alarm ›
// compacting › working › thinking › done › resting › ready), so exactly ONE
// face is the current one.
//
// Reading order: FIRST find the status-line CANDIDATE closest to the
// composer (the LAST line that declares itself a VL status line, even with
// an incomplete or unrecognized word/glyph), THEN interpret it. A candidate
// that is present but unrecognized/truncated counts as 'unknown': NO
// backward scan over older known lines and NO legacy 0.3 fallback — an
// uninterpretable current surface cannot promote earlier text into an
// authorization for paste/Enter (fail-closed). Legacy 0.3 stays valid ONLY
// with no 0.4 candidate line in the tail. FaceClock turns off done after
// 3 s (DONE_FOR) and falls back to ready: a populated conversation becomes
// ready again, and that is NOT proof of a virgin session (the bootstrap
// guard lives in the launcher claim, not here).
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

// Current vl pane state: FIRST the candidate, THEN the interpretation.
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
  // Unrecognized/truncated current candidate -> NOT idle (wait, and on
  // timeout degrade the readiness per contract: never by heuristic).
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
    // VL 0.4. Bootstrap-ready is ONLY 'ready' (the real guard is the
    // launcher claim, handled in runtime/cell-exec: ready alone is not
    // enough). Busy or undeliverable faces (thinking/working/asking/
    // compacting, offline, error, done, resting, alarm) are 'busy': wait
    // bounded and on timeout skip with skipped-not-ready — NEVER a blind
    // paste on unknown/timeout. Busy and asking are never available.
    // An unrecognized/truncated current candidate is 'unknown' — no
    // backward scan and no legacy fallback: an uninterpretable current
    // surface never authorizes paste/Enter.
    const face = vlCurrentFace(text);
    if (face === 'unknown') return 'unknown';
    if (face) return face === 'ready' ? 'ready' : 'busy';
    // Legacy VERSIONATO Vivling 0.3 (vedi vlPaneIdle): SOLO senza alcuna riga
    // candidata VL 0.4 nel tail.
    return /vivling\s+\[o\].*esc quit · \^y yield/.test(tail) ? 'ready' : 'unknown';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Parser del composer (0.9.80 s2a, C6): enum chiuso 'empty' | 'occupied' |
// 'unknown'. Puro: il testo catturato resta DENTRO la funzione, fuori esce
// solo il valore bounded (mai in stato, log, risposta o record).
//
// Regole non negoziabili:
//  - lo stripping degli attributi NON puo' trasformare un testo perso in
//    empty: una riga con contenuto e nessun attributo (capture senza -e o
//    escape rimossi) e' perdita di informazione -> 'unknown';
//  - colore/tema sconosciuto, attributi assenti, caso indistinguibile ->
//    'unknown'; perdita di informazione -> 'unknown' (mai 'empty' per
//    deduzione);
//  - NESSUN confronto fra due capture come prova di vuotezza e NESSUNA
//    whitelist di frasi «Try ...»;
//  - il suggerimento grigio si riconosce SOLO con un contratto di rendering
//    ristretto e QUALIFICATO (provenienza verificabile: renderer/versione/
//    tema pinnati o campioni non sensibili autorizzati, piu' le triple
//    vuoto/suggerimento/testo digitato che ne dimostrino la distinzione).
//    Le fixture sintetiche dei test NON qualificano un cliente reale: il
//    prodotto non porta contratti, quindi un composer con contenuto risolve
//    'unknown' e la consegna e' saltata (guardia conservativa, limite
//    dichiarato dello strato 2a).
//  - Kimi: nessun parser qualificato in 2a (decisione DevAuditor n. 3) ->
//    'unknown', mai un parser Claude travestito da Kimi.
// ---------------------------------------------------------------------------
const COMPOSER_STATES = Object.freeze(['empty', 'occupied', 'unknown']);

// Un'escape SGR: ESC [ <params> m. Params assenti o '0' = default. Qualunque
// altra finale CSI su una riga del composer e' informazione che il parser non
// sa interpretare -> riga non parsabile -> 'unknown'.
const SGR_ESCAPE_RE = /^\x1b\[([0-9;:]*)([A-Za-z])/;

// Parso UNA riga in run di testo con gli attributi SGR attivi.
// { ok:false } su sequenze troncate/malformate. sawSgr dice se la riga
// conteneva ALMENO un escape: una riga con contenuto e sawSgr false ha
// perso gli attributi.
function parseSgrRuns(line) {
  const runs = [];
  let attrs = '';
  let text = '';
  let sawSgr = false;
  for (let i = 0; i < line.length;) {
    if (line[i] === '\x1b') {
      const m = SGR_ESCAPE_RE.exec(line.slice(i));
      if (!m || m[2] !== 'm') return { ok: false, runs: [], sawSgr };
      sawSgr = true;
      if (text) { runs.push({ attrs, text }); text = ''; }
      attrs = (m[1] === '' || m[1] === '0') ? '' : m[1];
      i += m[0].length;
      continue;
    }
    text += line[i];
    i += 1;
  }
  if (text) runs.push({ attrs, text });
  return { ok: true, runs, sawSgr };
}

// Contratto valido: client claude, provenienza DICHIARATA (stringa non
// vuota), insomi chiusi di attributi del placeholder e del testo digitato
// ('' = rendering di default). Un contratto senza provenienza non e'
// qualificato: non conta.
function validComposerContract(contract, client) {
  if (!contract || typeof contract !== 'object') return null;
  if (contract.client !== client) return null;
  if (typeof contract.provenance !== 'string' || !contract.provenance) return null;
  if (!Array.isArray(contract.placeholderAttrs) || !Array.isArray(contract.typedAttrs)) return null;
  return contract;
}

// composerOccupied(captured, client, contract?) -> COMPOSER_STATES. Pura.
function composerOccupied(captured, client, contract) {
  const text = typeof captured === 'string' ? captured : '';
  if (!text.trim()) return 'unknown';
  // Il parser del composer esiste solo per i client con composer classificato
  // (claude, e Kimi quando avra' un contratto proprio). Qualunque altro
  // client non ha un composer da isolare: unknown, mai vuoto per deduzione.
  if (client !== 'claude') return 'unknown';
  const c = validComposerContract(contract, 'claude');
  if (!c) return 'unknown';
  const lines = text.split('\n');
  // Il composer e' la ULTIMA riga che si dichiara composer (❯ in testa alla
  // riga, dopo eventuali attributi/spazi): la superficie corrente, non una
  // riga piu' vecchia della conversazione.
  let idx = -1;
  let parsed = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const p = parseSgrRuns(lines[i]);
    if (!p.ok) continue;
    const plain = p.runs.map((r) => r.text).join('');
    if (/^\s*❯/.test(plain)) { idx = i; parsed = p; break; }
  }
  if (idx === -1) return 'unknown';
  // Contenuto DOPO il glifo del prompt. Il separatore (uno spazio dopo ❯) e'
  // del rendering, non input: si rimuove una sola volta dal primo run; testo
  // digitato che inizia con spazio resta distinguibile dal resto del run.
  const content = [];
  let glyphSeen = false;
  for (const run of parsed.runs) {
    if (!glyphSeen) {
      const at = run.text.indexOf('❯');
      if (at === -1) continue;
      glyphSeen = true;
      const rest = run.text.slice(at + 1);
      if (rest) content.push({ attrs: run.attrs, text: rest });
      continue;
    }
    content.push(run);
  }
  if (content.length && content[0].text.startsWith(' ')) {
    const first = { attrs: content[0].attrs, text: content[0].text.slice(1) };
    if (first.text) content[0] = first; else content.shift();
  }
  // Contenuto presente senza ALCUN attributo sulla riga: attributi persi.
  if (content.some((r) => r.text) && !parsed.sawSgr) return 'unknown';
  const ph = new Set(c.placeholderAttrs);
  const typed = new Set(c.typedAttrs);
  // Classifica un insieme di run: 'typed' se c'e' testo digitato, quindi vince
  // su tutto; 'placeholder' se tutto il contenuto e' nel rendering qualificato
  // del suggerimento; 'none' senza contenuto; 'other' per attributi che il
  // contratto non conosce (tema/colore sconosciuto -> unknown).
  const classifyRuns = (runs) => {
    let sawPh = false; let sawTyped = false;
    for (const r of runs) {
      if (!r.text) continue;
      if (ph.has(r.attrs)) { sawPh = true; continue; }
      if (typed.has(r.attrs)) { sawTyped = true; continue; }
      return 'other';
    }
    if (sawTyped) return 'typed';
    if (sawPh) return 'placeholder';
    return 'none';
  };
  const kind = classifyRuns(content);
  if (kind === 'other') return 'unknown';
  if (kind === 'typed') return 'occupied';
  // Nessun contenuto dopo il glifo: il rendering qualificato mostra SEMPRE il
  // suggerimento quando il composer e' vuoto — niente placeholder significa
  // rendering non qualificato, non buffer vuoto.
  if (kind === 'none') return 'unknown';
  // Tutto in rendering placeholder: il composer e' vuoto solo se anche le
  // righe di continuazione (fino alla riga VUOTA) restano nel placeholder.
  // Testo digitato sotto (wrapping) = input umano; attributi sconosciuti
  // sotto = informazione insufficiente.
  for (let i = idx + 1; i < lines.length; i += 1) {
    const p = parseSgrRuns(lines[i]);
    if (!p.ok) return 'unknown';
    if (!p.runs.some((r) => r.text)) break; // riga vuota: fine della regione
    const k = classifyRuns(p.runs);
    if (k === 'typed') return 'occupied';
    if (k === 'other' || k === 'none') return 'unknown';
  }
  return 'empty';
}

// vlPaneReadiness(tmuxBin, target, opts) -> { ready, degraded }
// Content-readiness (AVAILABILITY) of a vl cell via pane — VL 0.4 with idle
// faces ready/done/error/resting (vlPaneIdle), plus the versioned legacy 0.3.
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
  const now = nowImpl || monoNowMs;
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

// Orologio MONOTONO di default (0.9.80 s2a, C7): durate e deadline non si
// muovono con i salti dell'orologio civile. Stesso primitivo del supervisore
// (cell-exec.js `monoNow`): process.hrtime.bigint()/1000000n. Un valore
// monotono non viene MAI scritto in file, payload, log o risposte: serve solo
// a confronti interni allo stesso processo. I timestamp civili (ts dei record,
// notBeforeMs dei log MCP, presentazione) restano civili: il seam iniettabile
// `nowImpl` sostituisce QUESTO orologio nei test, non quello civile.
function monoNowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
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
  const now = opts.nowImpl || monoNowMs;
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

  // Il budget della fase si acquisisce UNA volta (C7): readiness, gate MCP,
  // verifica fresca e retry pre-paste condividono questo limite. Il GATE sta
  // nella funzione: readyWaitMs 0 (o un clamp che produce 0 da input negativi
  // non nulli) non autorizza NESSUN paste e non concede osservazioni
  // privilegiate a budget zero — non ci si affida al caller.
  const deadline = now() + readyWaitMs;
  // Il timeout del capture e' limitato al RESIDUO della finestra (mai una
  // finestra nuova): un capture che oltrepassa il limite non puo' valere come
  // osservazione che autorizza il paste.
  const captureTimeoutMs = () => Math.max(1, Math.min(2000, Math.max(0, deadline - now())));
  const defaultCapture = async (t) => {
    const r = await exec(tmuxBin, ['capture-pane', '-p', '-t', t], {
      env, timeoutMs: captureTimeoutMs(),
    });
    return r.err ? null : r.stdout;
  };
  // captureImpl resta il seam della readiness (stessa firma, nessun argomento
  // obbligatorio): iniettato copre anche la verifica fresca; il default cattura
  // il target richiesto (il pane PINNATO, nella verifica fresca).
  const capture = opts.captureImpl || (async () => defaultCapture(target));
  const captureFresh = opts.captureImpl || (async (pinned) => defaultCapture(pinned));
  // Seam SEPARATO per la capture con ATTRIBUTI (A4/C6, decisione n. 5):
  // iniettabile solo come dipendenza di test; default `capture-pane -p -e`
  // sul SOLO viewport visibile del pane pinnato, MAI `-S` (scrollback).
  // Vietato il fallback da attributi persi ad attributi sintetizzati o al
  // solo testo per concludere 'empty': la perdita resta 'unknown'.
  const captureAttrs = opts.captureAttrsImpl || (async (pinned) => {
    const r = await exec(tmuxBin, ['capture-pane', '-p', '-e', '-t', pinned], {
      env, timeoutMs: captureTimeoutMs(),
    });
    return r.err ? null : r.stdout;
  });

  // (1) Attesa readiness bounded: la deadline si controlla DOPO ogni await e
  // PRIMA di accettare ready (s2a A2, DevAuditor C7). Un capture che finisce
  // a deadline o dopo non autorizza il paste: stato skipped-unknown con il
  // dettaglio bounded deadlineExceeded nel ritorno; il kind gia' qualificato
  // (busy, not-ready-*) resta dettaglio in notReady, ma lo stato non cambia.
  let paneState = 'unknown';
  for (;;) {
    if (cancelled()) return done(false, 'cancelled', '', 0);
    const text = await capture();
    if (cancelled()) return done(false, 'cancelled', '', 0);
    paneState = text === null ? 'unknown' : classifyPane(text, client);
    if (now() >= deadline) {
      return {
        ...done(false, 'skipped-unknown', paneState === 'unknown' ? '' : paneState, 0),
        deadlineExceeded: true,
      };
    }
    if (paneState === 'ready') break;
    // Sleep al residuo, mai una finestra nuova; qui now() < deadline, quindi
    // la lunghezza e' sempre > 0 (nessun loop a sonno zero).
    await sleepImpl(Math.min(pollMs, deadline - now()));
  }

  // (1b) Gate readiness MCP opzionale (solo claude.*): la mcpWait e'
  // fornita dal supervisore, con deadline ASSOLUTA composta sullo stesso
  // orologio del launch (tetto MCP dal budget approvato, mai un budget nuovo a
  // valle). Il composer pronto resta SEMPRE obbligatorio: qui si arriva solo
  // col pane ready. A budget esaurito senza MCP pronti la consegna prosegue
  // come AVVIO DEGRADATO VISIBILE: esito submitted/degraded con l'elenco
  // bounded dei server failed/pending, mai un lancio silenzioso.
  // s2a A3: anche l'attesa MCP consuma la stessa finestra — la deadline si
  // ricontrolla DOPO l'await e PRIMA di proseguire verso il paste. Il budget
  // MCP resta composto dall'avvio della generazione e non riparte quando il
  // composer e' pronto: il caso «pronto a 20 s / limite 60 s» puo' avere
  // mcp: degraded (visibile, atteso), NON e' un secondo tentativo.
  let mcp = null;
  if (typeof opts.mcpWait === 'function') {
    const r = await opts.mcpWait({ isCancelled: cancelled });
    if (cancelled() || !r || r.cancelled) return done(false, 'cancelled', '', 0);
    if (now() >= deadline) {
      return { ...done(false, 'skipped-unknown', '', 0), deadlineExceeded: true };
    }
    mcp = {
      state: r.state === 'ready' ? 'ready' : 'degraded',
      ready: Array.isArray(r.ready) ? r.ready : [],
      failed: Array.isArray(r.failed) ? r.failed : [],
      pending: Array.isArray(r.pending) ? r.pending : [],
    };
  }

  // (1c) Verifica fresca prima del PRIMO paste e prima del retry certo (A4).
  // UNA sola funzione condivisa, zero effetti, con binding del proprietario:
  // il pane della readiness viene risolto e PINNATO (la sola uguaglianza di
  // %N non attesta la generazione: isCancelled — che nel supervisore lega
  // cancel e childState — e' rivalutato DOPO ogni await e PRIMA di ogni
  // effetto); quel target pinnato e' l'unico usato nell'effetto, mai una
  // ri-risoluzione libera di un pane nuovo fra check e paste. Sul pane
  // pinnato: capture nuovo (classify 'ready') e, per i client con composer
  // classificato (claude/kimi), capture con attributi e composer 'empty'
  // QUALIFICATO. Qualunque altro esito -> zero paste, zero Enter, stato e
  // dettaglio bounded. Nessun tasto per cancellare input o accettare
  // suggerimenti: si salta la consegna, il terminale resta utilizzabile.
  const freshPrePasteCheck = async () => {
    if (cancelled()) return { ok: false, state: 'cancelled', notReady: '' };
    const pinned = await resolveSessionPane(tmuxBin, session, { env, exec, target });
    if (cancelled()) return { ok: false, state: 'cancelled', notReady: '' };
    if (!pinned) return { ok: false, state: 'skipped-unknown', notReady: '' };
    const text = await captureFresh(pinned);
    if (cancelled()) return { ok: false, state: 'cancelled', notReady: '' };
    const again = text === null ? 'unknown' : classifyPane(text, client);
    if (again !== 'ready') {
      return { ok: false, state: 'skipped-unknown', notReady: again === 'unknown' ? '' : again };
    }
    if (client === 'claude' || client === 'kimi') {
      const attrs = await captureAttrs(pinned);
      if (cancelled()) return { ok: false, state: 'cancelled', notReady: '' };
      const occupied = attrs === null
        ? 'unknown'
        : composerOccupied(attrs, client, opts.composerContract);
      // Input umano nel composer: motivo bounded 'busy'. Attributi persi o
      // contratto non qualificato: 'unknown'. In entrambi i casi zero paste.
      if (occupied !== 'empty') {
        return { ok: false, state: 'skipped-unknown', notReady: occupied === 'occupied' ? 'busy' : '' };
      }
    }
    return { ok: true, target: pinned };
  };

  const fresh = await freshPrePasteCheck();
  if (!fresh.ok) {
    return done(false, fresh.state, fresh.notReady, 0, mcp);
  }

  // (2) Consegna AT-MOST-ONCE: delega al nucleo condiviso con il percorso
  // submit opt-in (v. deliverPastedAtMostOnce). L'unica differenza rispetto
  // al submit e' la readiness: qui e' CLASSIFICATA (kimi/claude), e la STESSA
  // verifica fresca vale per l'unico retry pre-paste. Il nucleo riceve
  // l'orologio monotono e la deadline della fase (A6): sleep pre-retry al
  // residuo, tempo ricontrollato dopo il sonno, retry oltre il bound MAI
  // tentato, guardia pre-effetto dentro securePaste.
  const core = await deliverPastedAtMostOnce(opts, {
    exec,
    sleepImpl,
    cancelled,
    target: fresh.target,
    nowImpl: now,
    deadlineAt: deadline,
    recheckPrePaste: async () => (await freshPrePasteCheck()).ok,
  });
  void settleMs;
  return {
    ...done(core.delivered, core.state, '', core.attempts, mcp),
    ...(core.deadlineExceeded ? { deadlineExceeded: true } : {}),
  };
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
  // 0.9.80 s2a (A6): il chiamante puo' passare l'orologio MONOTONO e la
  // deadline della fase. Con il bound: sleep pre-retry limitato al residuo,
  // tempo ricontrollato dopo il sonno e prima della riverifica/secondo paste,
  // retry che supererebbe il bound MAI tentato (nessuna finestra nuova) e
  // guardia pre-effetto dentro securePaste. SENZA bound (chiamanti che non lo
  // passano) il comportamento e' identico a quello di oggi.
  const monoNow = typeof ctx.nowImpl === 'function' ? ctx.nowImpl : null;
  const deadlineAt = Number.isFinite(ctx.deadlineAt) ? ctx.deadlineAt : null;
  const pastDeadline = monoNow && deadlineAt !== null ? () => monoNow() >= deadlineAt : null;
  const deadlineOut = (attempts) => ({
    ...{ delivered: false, state: 'failed-pre-paste', attempts },
    deadlineExceeded: true,
  });
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
      ...(pastDeadline ? { deadlineMs: deadlineAt, monoNow } : {}),
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
    // Guardia pre-effetto scattata dentro securePaste: abort CERTO pre-paste
    // (nessun effetto emesso), dettaglio deadline bounded nel ritorno.
    if (stage.stage === 'deadline') return deadlineOut(attempts);
    if (stage.stage === 'cancelled' || cancelled()) {
      // Pre-paste e gia' invalidata: nessun effetto, nessuna traccia lasciata.
      return out(false, 'cancelled', attempts);
    }
    // Fallimento certo PRE-paste: primo tentativo provatamente fallito con
    // residuo esaurito -> failed-pre-paste con dettaglio deadline, NESSUN
    // secondo tentativo, attempts conservato (decisione n. 6).
    if (pastDeadline && pastDeadline()) return deadlineOut(attempts);
    if (attempts >= 2) return out(false, 'failed-pre-paste', attempts);
    // Un solo retry, readiness riverificata prima — sleep al RESIDUO (mai una
    // finestra nuova; qui now() < deadline, quindi lunghezza > 0) e tempo
    // ricontrollato DOPO il sonno e PRIMA della riverifica e del secondo paste.
    await sleepImpl(pastDeadline ? Math.min(pollMs, Math.max(1, deadlineAt - monoNow())) : pollMs);
    if (cancelled()) return out(false, 'cancelled', attempts);
    if (pastDeadline && pastDeadline()) return deadlineOut(attempts);
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
  const now = opts.nowImpl || monoNowMs;
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
  // s2a A7 (C8): la deadline si controlla DOPO l'await del resolve e PRIMA di
  // accettare il pane — un resolve che finisce oltre il limite non autorizza
  // il paste (il submit mantiene il suo esito pre-effetto failed-pre-paste).
  // Lo sleep e' al residuo; il %N risolto viene PINNATO e usato come target
  // dell'effetto: mai una ri-risoluzione libera di un pane nuovo fra check e
  // paste. Il gate sta nella funzione: readyWaitMs 0 non consegna. Nessun
  // classifier del composer: un engine custom non ce l'ha.
  const deadline = now() + readyWaitMs;
  let pinned = null;
  for (;;) {
    if (cancelled()) return out(false, 'cancelled', 0);
    const paneId = await resolveSessionPane(tmuxBin, session, { env, exec, target });
    if (cancelled()) return out(false, 'cancelled', 0);
    if (now() >= deadline) {
      return { ...out(false, 'failed-pre-paste', 0), deadlineExceeded: true };
    }
    if (paneId) { pinned = paneId; break; }
    await sleepImpl(Math.min(pollMs, Math.max(1, deadline - now())));
  }

  // (2) Un solo paste, un solo Enter. Il nucleo riceve il %N pinnato con
  // l'orologio monotono e la deadline della fase (A6/A7): binding del
  // proprietario negli stadi, retry certo pre-paste entro il bound, guardia
  // pre-effetto dentro securePaste. Retry e post-paste incerto invariati.
  const core = await deliverPastedAtMostOnce(opts, {
    exec,
    sleepImpl,
    cancelled,
    target: pinned,
    nowImpl: now,
    deadlineAt: deadline,
    recheckPrePaste: async () => (await resolveSessionPane(
      tmuxBin, session, { env, exec, target: pinned })) === pinned,
  });
  return {
    ...out(core.delivered, core.state, core.attempts),
    ...(core.deadlineExceeded ? { deadlineExceeded: true } : {}),
  };
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

// Bounded reasons for the vl skip: they travel in the notReady position of
// @nc_delivery (`skipped-vl-bootstrap:<reason>`). Closed enum, no free text
// from the remote launcher. Per launch: host-pre-existing is no longer a
// skip reason, every launch delivers once.
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
  const now = nowImpl || monoNowMs;
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
  COMPOSER_STATES, composerOccupied,
  classifyPane, deliverBootstrapPrompt, waitDeliveryReport, actionRequiredFor, vlPaneReadiness,
  submitPromptWithEnter, deliverPastedAtMostOnce,
};
