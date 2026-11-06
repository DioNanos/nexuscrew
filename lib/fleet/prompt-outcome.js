'use strict';
// Contratto PURO dell'esito durevole della consegna del prompt (0.9.80, strato
// 2b). Nessun `fs`, nessun require: questo modulo e' l'unico posto dove vivono
// lo schema del record `prompt-<launchId>.json`, il predicato dell'identificatore
// di lancio e la tabella canonica che mappa l'esito del proprietario della
// consegna nei quattro stati del record. Writer (il supervisore), lettore e —
// nello strato 2c — la UI importano da qui: nessuna seconda copia.
//
// Il record porta SOLO scalari whitelisted. Mai testo del prompt, capture,
// argv, path arbitrari o errori grezzi: l'oggetto di ritorno della consegna
// non si spalma nel record, i suoi campi si scelgono uno a uno.

// ── Identificatore di lancio ────────────────────────────────────────────────
//
// UNA sola definizione, condivisa dal record del prompt, dal validatore del
// canale e da activity.js (che la re-esporta). La forma e' quella storica dei
// record per lancio; il predicato RIFIUTA ESPLICITAMENTE i componenti `.` e
// `..` che la sola forma ammetterebbe: l'id finisce in un nome di file, e la
// prova ostile non si puo' dichiarare coperta dalla sola regex.
const RE_LAUNCH_ID = /^[A-Za-z0-9._-]{1,128}$/;
function validLaunchId(id) {
  return typeof id === 'string' && RE_LAUNCH_ID.test(id) && id !== '.' && id !== '..';
}

// ── Schema del record ───────────────────────────────────────────────────────
const VERSIONE_RECORD_PROMPT = 1;
const EVENTO_RECORD_PROMPT = 'prompt-delivery';
const PREFIX_RECORD_PROMPT = 'prompt-';
const ESTENSIONE_PROMPT = '.json';

// I quattro stati della consegna: liveness della cella a parte, nessuno stato
// di successo nuovo oltre `submitted`.
const PROMPT_STATES = Object.freeze(['pending', 'submitted', 'skipped', 'unknown']);

// Catalogo CHIUSO delle ragioni, per stato: niente testo libero, niente
// Error.message, niente argv. `pending` e `submitted` non portano ragione.
// `deadline-exceeded` e' ammessa su SKIPPED solo quando il proprietario
// attesta zero paste (skipped-unknown con deadlineExceeded) e su UNKNOWN come
// scadenza di osservabilita' del pending: la ragione da sola non determina lo
// stato.
const RAGIONI_SKIPPED = Object.freeze([
  'not-ready', 'not-ready-auth', 'not-ready-consent', 'not-ready-onboarding',
  'prompt-rejected',
  'failed-pre-paste', 'failed-pre-paste-validate', 'failed-pre-paste-resolve',
  'failed-pre-paste-load',
  'transport-unsupported',
  'vl-bootstrap-launch', 'vl-bootstrap-claim-taken', 'vl-bootstrap-claim-unavailable',
  'vl-bootstrap-generation', 'vl-bootstrap-no-proof',
  'cancelled-pre-paste', 'reprompt-disabled', 'deadline-exceeded',
]);
const RAGIONI_UNKNOWN = Object.freeze([
  'delivery-unknown', 'staged-not-submitted', 'paste-only-no-enter',
  'report-timeout', 'deadline-exceeded', 'record-broken', 'channel-unavailable',
  'claim-settle-failed', 'generation-not-recorded',
]);
const RAGIONI_PER_STATO = Object.freeze({
  pending: Object.freeze([]),
  submitted: Object.freeze([]),
  skipped: RAGIONI_SKIPPED,
  unknown: RAGIONI_UNKNOWN,
});

// Kind qualificati della non-pronta (sottoinsieme degli stati del classifier:
// i kind che il proprietario puo' attestare a corredo di uno skip). Copia
// volontaria e dichiarata: questo modulo non dipende da prompt-delivery.js.
const NOT_READY_KINDS = Object.freeze([
  'busy', 'not-ready-auth', 'not-ready-consent', 'not-ready-onboarding',
]);

const CHIAVI_RECORD = Object.freeze([
  'version', 'event', 'launchId', 'generation', 'state', 'reason', 'notReady', 'ts', 'deadlineTs',
]);

function numeroFinito(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Schema CHIUSO del record del prompt: chiavi esatte, versione/evento, forma
 * dell'identificatore di lancio, generazione intera non negativa, stato del
 * catalogo, ragione coerente con lo stato, kind solo su skipped, timestamp
 * civili finiti e deadline solo sul pending (e mai prima del ts).
 */
function validPromptRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  // Chiavi esatte: nessuna oltre alle nove dello schema, le sei obbligatorie
  // presenti (reason/notReady/deadlineTs sono opzionali e vincolate sotto).
  const chiavi = Object.keys(record);
  if (chiavi.some((k) => !CHIAVI_RECORD.includes(k))) return false;
  for (const obbligatoria of ['version', 'event', 'launchId', 'generation', 'state', 'ts']) {
    if (!Object.hasOwn(record, obbligatoria)) return false;
  }
  if (record.version !== VERSIONE_RECORD_PROMPT) return false;
  if (record.event !== EVENTO_RECORD_PROMPT) return false;
  if (!validLaunchId(record.launchId)) return false;
  if (!Number.isSafeInteger(record.generation) || record.generation < 0) return false;
  if (!PROMPT_STATES.includes(record.state)) return false;
  // reason: assente per pending/submitted, da catalogo per skipped/unknown.
  const ammesse = RAGIONI_PER_STATO[record.state];
  if (Object.hasOwn(record, 'reason')) {
    if (ammesse.length === 0) return false;
    if (!ammesse.includes(record.reason)) return false;
  }
  // notReady: kind del classifier, SOLO con uno skipped da qualificare.
  if (Object.hasOwn(record, 'notReady')) {
    if (record.state !== 'skipped') return false;
    if (!NOT_READY_KINDS.includes(record.notReady)) return false;
  }
  if (!numeroFinito(record.ts)) return false;
  // deadlineTs: OBBLIGATORIO e finito sul pending (il limite di osservabilita':
  // senza, un pending sarebbe eterno), vietato su ogni terminale, mai prima
  // del ts.
  if (record.state === 'pending') {
    if (!Object.hasOwn(record, 'deadlineTs') || !numeroFinito(record.deadlineTs)) return false;
    if (record.deadlineTs < record.ts) return false;
  } else if (Object.hasOwn(record, 'deadlineTs')) {
    return false;
  }
  return true;
}

// Nome del file del record, per lancio: la generazione e' un campo, non un nome.
function nomeRecordPrompt(launchId) {
  return `${PREFIX_RECORD_PROMPT}${launchId}${ESTENSIONE_PROMPT}`;
}

// ── Tabella C3: l'esito del proprietario -> stato canonico ──────────────────
//
// UNA sola funzione pura, tabella ESAUSTIVA. Input chiusi: gli stati di
// consegna del trasporto (piu' lo stage per paste-failed e il dettaglio
// deadlineExceeded del ritorno della consegna) e il secondo input chiuso
// `claim` del settle vl (not-applicable | settled | failed). Nessun path,
// Error o oggetto claim grezzo, nessun I/O. Writer, lettore e UI importano
// QUESTA funzione: nessun secondo posto nel codice mappa gli esiti.
//
// `skipped-unknown` (osservazione non pronta, ZERO paste) non e'
// `delivery-unknown` (puo' aver gia' digitato): mai equiparati.
// Nessun nuovo stato di successo: `submitted` esiste SOLO dall'input submitted
// con claim coerente.
const CLAIM_INPUTS = Object.freeze(['not-applicable', 'settled', 'failed']);
const STAGE_PRE_PASTE = Object.freeze(['validate', 'resolve', 'load']);

function canonicalOutcome(source, claim = 'not-applicable') {
  // Il claim vince su tutto quando era dovuto e non e' stato attestato: un
  // esito canonico scritto prima del settle non si puo' piu' degradare, quindi
  // il terminale si compone UNA volta sola, dopo il tentativo. Un valore
  // fuori catalogo e' conservativo come un fallimento: mai un attestato.
  if (!CLAIM_INPUTS.includes(claim)) claim = 'failed';
  if (claim === 'failed') return { state: 'unknown', reason: 'claim-settle-failed' };
  if (!source || typeof source !== 'object' || typeof source.state !== 'string') {
    return { state: 'unknown' };
  }
  const notReady = typeof source.notReady === 'string' && NOT_READY_KINDS.includes(source.notReady)
    ? source.notReady : '';
  const kind = notReady ? { notReady } : {};
  const conKind = (esito) => ({ ...esito, ...(Object.keys(kind).length ? kind : {}) });
  switch (source.state) {
    case 'submitted':
      return { state: 'submitted' };
    case 'delivery-unknown':
    case 'staged-not-submitted':
      return { state: 'unknown', reason: source.state };
    case 'paste-delivered':
      // paste noto, Enter NON attestato: mai submitted, mai «non incollato».
      return { state: 'unknown', reason: 'paste-only-no-enter' };
    case 'skipped-not-ready':
    case 'skipped-unknown':
      // Zero paste. deadlineExceeded attestato dal proprietario: la ragione e'
      // la scadenza, il kind qualificato resta dettaglio (mai due codifiche).
      return conKind({ state: 'skipped', reason: source.deadlineExceeded ? 'deadline-exceeded' : 'not-ready' });
    case 'skipped-vl-bootstrap': {
      // La ragione vl viaggia nel campo notReady del ritorno del proprietario:
      // ragione chiusa vl-bootstrap-<motivo>, no-proof quando assente.
      const motivo = typeof source.notReady === 'string' && source.notReady
        && ['launch', 'claim-taken', 'claim-unavailable', 'generation', 'no-proof'].includes(source.notReady)
        ? source.notReady : 'no-proof';
      return { state: 'skipped', reason: `vl-bootstrap-${motivo}` };
    }
    case 'prompt-rejected':
      return { state: 'skipped', reason: 'prompt-rejected' };
    case 'failed-pre-paste':
      return { state: 'skipped', reason: 'failed-pre-paste' };
    case 'transport-unsupported':
      return { state: 'skipped', reason: 'transport-unsupported' };
    case 'paste-failed':
      // Solo i tre stage PRE-paste chiusi attestano zero paste. Uno stage
      // post-paste (paste, pasted), ignoto o assente non lo attesta: unknown,
      // mai uno skipped per deduzione.
      if (!STAGE_PRE_PASTE.includes(source.stage)) return { state: 'unknown' };
      return { state: 'skipped', reason: `failed-pre-paste-${source.stage}` };
    case 'cancelled':
      // Cancellazione CERTA pre-paste. Una cancellazione dopo un tentativo di
      // paste arriva gia' come delivery-unknown / staged-not-submitted.
      return { state: 'skipped', reason: 'cancelled-pre-paste' };
    case 'report-timeout':
      return { state: 'unknown', reason: 'report-timeout' };
    default:
      // Valore non riconosciuto: unknown, mai un successo per deduzione.
      return { state: 'unknown' };
  }
}

module.exports = {
  validLaunchId, RE_LAUNCH_ID,
  VERSIONE_RECORD_PROMPT, EVENTO_RECORD_PROMPT,
  PREFIX_RECORD_PROMPT, ESTENSIONE_PROMPT, nomeRecordPrompt,
  PROMPT_STATES, RAGIONI_SKIPPED, RAGIONI_UNKNOWN, RAGIONI_PER_STATO,
  NOT_READY_KINDS, CHIAVI_RECORD, CLAIM_INPUTS, STAGE_PRE_PASTE,
  validPromptRecord, canonicalOutcome,
};
