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
  'claim-settle-failed',
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
  if (Object.hasOwn(record, 'deadlineTs')) {
    if (record.state !== 'pending') return false;
    if (!numeroFinito(record.deadlineTs)) return false;
    if (record.deadlineTs < record.ts) return false;
  }
  return true;
}

// Nome del file del record, per lancio: la generazione e' un campo, non un nome.
function nomeRecordPrompt(launchId) {
  return `${PREFIX_RECORD_PROMPT}${launchId}${ESTENSIONE_PROMPT}`;
}

module.exports = {
  validLaunchId, RE_LAUNCH_ID,
  VERSIONE_RECORD_PROMPT, EVENTO_RECORD_PROMPT,
  PREFIX_RECORD_PROMPT, ESTENSIONE_PROMPT, nomeRecordPrompt,
  PROMPT_STATES, RAGIONI_SKIPPED, RAGIONI_UNKNOWN, RAGIONI_PER_STATO,
  NOT_READY_KINDS, CHIAVI_RECORD,
  validPromptRecord,
};
