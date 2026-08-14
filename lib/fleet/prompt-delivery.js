'use strict';
// Delivery del bootstrap prompt per gli engine managed Kimi (kimi.native e
// claude.kimi-code) — NexusCrew 0.8.47. SOLO questi due engine: gli altri
// managed conservano il prompt su argv (finding separato) e i custom send-keys
// conservano injectPrompt legacy senza Enter.
//
// Contratto (design audit 0.8.47):
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

// Esiti bounded della consegna (prompt.reason in API: closed enum, G5).
const DELIVERY_STATES = Object.freeze([
  'submitted',             // paste ok + pane riverificato + Enter ok
  'staged-not-submitted',  // paste ok, Enter fallito: testo forse nel composer
  'delivery-unknown',      // paste tentato con esito incerto / pane sparito dopo il paste
  'failed-pre-paste',      // resolve/load certamente falliti (anche dopo 1 retry)
  'skipped-not-ready',     // classifier not-ready a fine attesa bounded (kind in notReady)
  'skipped-unknown',       // classifier mai ready entro il timeout
  'prompt-rejected',       // byte di controllo nel prompt (policy §9e)
  'cancelled',             // generazione terminata durante l'attesa/consegna (R3)
  'report-timeout',        // up() non ha ricevuto l'esito del launcher entro il bound
]);

// Codici bounded actionRequired (G5). Nessuna inferenza "rifiutato": il marker
// TUI prova solo che serve un'azione nel terminale della cella.
const ACTION_CODES = Object.freeze(['KIMI_AUTH_ACTION_REQUIRED', 'CLIENT_INTERACTION_REQUIRED']);

// Slug recovery bounded (R10): l'API trasporta SOLO {code, recovery}; il testo
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
// classificare (R7: il marker auth e' la stringa ESATTA di status bar, non un
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
    // READY positivo Kimi: box di input corrente E modello configurato (G2).
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
    // READY positivo VL (TUI Vivling): la riga di stato in coda porta il
    // marcatore stabile prefisso `vivling` + stato `[o]` e la coda
    // `esc quit · ^y yield`. Misurato 2026-08-14 su due backend
    // (zai-a-coding, opencode-go): il marcatore e' stabile a prescindere dal
    // backend, dal writer-id (e<numero>) e dal contatore (↑<numero>).
    //
    // NON si classifica 'busy' dal contenuto: su alcuni backend il ragionamento
    // non viene renderizzato e il pane resta IDENTICO mentre la cella lavora
    // (gli stati [?] e [<<] esistono ma non sono affidabili per il busy). Il
    // busy di vl si rileva con la sonda esterna (CPU del demone, connessione
    // :443, figli), non di qui; qui si dice solo "pronta" ([o]) o "non pronta".
    // Il titolo pane NON reca lo spinner braille (vl.bin non contiene "tmux"):
    // il ready si prende dalla riga di stato, MAI dal titolo (che resta idle).
    return /vivling\s+\[o\].*esc quit · \^y yield/.test(tail) ? 'ready' : 'unknown';
  }
  return 'unknown';
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
// isCancelled() (R3): valutato ad OGNI poll, prima del paste e prima dell'
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
  const done = (delivered, state, notReady, attempts) => ({
    delivered, state, notReady, attempts, reason: state,
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

  // (2) Consegna AT-MOST-ONCE: un solo paste per generazione. Il retry copre
  // SOLO fallimenti certi pre-paste (resolve/load); dopo qualsiasi tentativo
  // di paste-buffer non esiste retry automatico (G1).
  let attempts = 0;
  for (;;) {
    if (cancelled()) return done(false, 'cancelled', '', attempts);
    attempts += 1;
    const stage = await securePaste(tmuxBin, session, prompt, {
      env, exec, target, tmpdir: opts.tmpdir, fsImpl: opts.fsImpl,
    });
    if (cancelled()) {
      // Il paste potrebbe essere avvenuto: mai riprovare, mai Enter.
      return done(false, stage.ok ? 'delivery-unknown' : 'cancelled', '', attempts);
    }
    if (stage.ok) {
      await sleepImpl(settleMs);
      if (cancelled()) return done(false, 'delivery-unknown', '', attempts);
      // Riverifica dello stesso %N sulla stessa sessione prima dell'Enter.
      const paneAgain = await resolveSessionPane(tmuxBin, session, { env, exec, target });
      if (paneAgain !== stage.paneId) return done(false, 'delivery-unknown', '', attempts);
      if (cancelled()) return done(false, 'delivery-unknown', '', attempts);
      const enter = await exec(tmuxBin, ['send-keys', '-t', stage.paneId, 'Enter'], { env });
      if (enter.err) return done(false, 'staged-not-submitted', '', attempts);
      // R9: cancel con Enter appena partito -> la generazione e' morta con un
      // submit in volo: esito incerto (residuo PTY possibile), mai 'submitted'.
      if (cancelled()) return done(false, 'delivery-unknown', '', attempts);
      return done(true, 'submitted', '', attempts);
    }
    if (stage.stage === 'paste' || stage.stage === 'validate') {
      // Paste tentato (esito incerto) o input rifiutato: zero secondo paste.
      return done(false, stage.stage === 'validate' ? 'prompt-rejected' : 'delivery-unknown', '', attempts);
    }
    if (attempts >= 2) return done(false, 'failed-pre-paste', '', attempts);
    // Fallimento certo PRE-paste: un solo retry, readiness riverificata prima.
    await sleepImpl(pollMs);
    if (cancelled()) return done(false, 'cancelled', '', attempts);
    const text = await capture();
    const again = text === null ? 'unknown' : classifyPane(text, client);
    if (again !== 'ready') return done(false, 'failed-pre-paste', '', attempts);
  }
}

// waitDeliveryReport(tmuxBin, target, opts) -> delivery-like | null (R2).
// Il launcher supervisionato (cell-exec) e' l'UNICO owner della consegna per
// TUTTE le generazioni degli engine Kimi e pubblica l'esito bounded sull'
// opzione tmux di pane @nc_delivery ('<state>' o '<state>:<notReady>', solo
// enum chiusi; muore col pane, nessuno state file). up() la legge con attesa
// bounded: niente paste dal runtime, niente doppio writer cross-generation.
async function waitDeliveryReport(tmuxBin, target, { env, exec, sleepImpl, nowImpl, timeoutMs, pollMs } = {}) {
  const run = exec || tmuxExec;
  const sleepFn = sleepImpl || sleep;
  const now = nowImpl || Date.now;
  const deadline = now() + clampInt(timeoutMs, 18000, 100, 150000);
  const step = clampInt(pollMs, 300, 50, 5000);
  for (;;) {
    const r = await run(tmuxBin,
      ['display-message', '-p', '-t', target, '#{@nc_delivery}'],
      { env, timeoutMs: 2000 });
    const raw = r.err ? '' : r.stdout.trim();
    if (raw) {
      const [state, notReady = ''] = raw.split(':');
      if (!DELIVERY_STATES.includes(state)) return null;   // valore non bounded: mai fidarsi
      const kind = PANE_STATES.includes(notReady) ? notReady : '';
      return {
        delivered: state === 'submitted',
        state, notReady: state === 'skipped-not-ready' ? kind : '',
        attempts: 0, reason: state,
      };
    }
    if (now() >= deadline) return null;
    await sleepFn(step);
  }
}

// actionRequiredFor(client, provider, delivery) -> null | { code, recovery }
// Mappa bounded delivery -> azione operatore. Solo skip per not-ready/unknown
// producono actionRequired; i fallimenti di trasporto restano nel prompt.state.
// R10: SOLO {code, recovery} closed enum/slug — il testo e' i18n locale PWA.
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
  PANE_STATES, DELIVERY_STATES, ACTION_CODES, RECOVERY_SLUGS,
  classifyPane, deliverBootstrapPrompt, waitDeliveryReport, actionRequiredFor,
};
