// I cinque parametri che l'editor del modello mostra e che la dichiarazione
// salva: contextWindow, maxTokens, tools, vision, reasoning. Poi i livelli di
// effort dichiarati per il modello (`effortLevels`): non sono un quinto
// parametro, sono una lista, e si dichiarano a parte.
//
// Un solo posto per la forma: i limiti sono quelli del parser del file, e i
// booleani sono a TRE stati — assente (lascia vuoto), true, false. `false` e'
// una risposta e non va mai confuso con l'assenza: e' cio' che impedisce a un
// catalogo di riportare `true` sopra la parola dell'operatore.
export const MODEL_FIELD_KEYS = ['contextWindow', 'maxTokens', 'tools', 'vision', 'reasoning'];
export const MODEL_NUMERIC_FIELDS = ['contextWindow', 'maxTokens'];
export const MODEL_BOOLEAN_FIELDS = ['tools', 'vision', 'reasoning'];
// Stessi numeri di `parseModel` (lib/fleet/definitions.js): un valore che il
// dialogo accetta e il file rifiuta farebbe fallire l'intero salvataggio.
export const MODEL_LIMIT_MIN = 1024;
export const MODEL_LIMIT_MAX = 100000000;
// I livelli di effort: stessi limiti del parser del file. Un livello e' un
// token corto in minuscolo, e finisce in un valore d'ambiente: nessuno spazio,
// nessun separatore, nessun carattere di controllo.
export const MODEL_EFFORT_MAX = 8;
export const MODEL_EFFORT_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;

export function validModelLimit(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= MODEL_LIMIT_MIN && n <= MODEL_LIMIT_MAX;
}

// Il campo dei livelli nel dialogo e' una stringa separata da virgole
// ('low, medium'); l'API e il file vogliono un array. Questa e' l'unica
// traduzione ammessa: nessun livello viene rinominato, dedotto o completato.
export function parseEffortLevels(value) {
  if (value === undefined || value === null) return { ok: true, levels: undefined };
  let raw;
  if (Array.isArray(value)) raw = value.map((v) => String(v).trim());
  else raw = String(value).split(',').map((v) => v.trim()).filter(Boolean);
  if (!raw.length) return { ok: true, levels: undefined };
  if (raw.length > MODEL_EFFORT_MAX) return { ok: false, error: 'too-many-levels' };
  const seen = new Set();
  for (const level of raw) {
    if (!MODEL_EFFORT_RE.test(level)) return { ok: false, error: 'invalid-level' };
    if (seen.has(level)) return { ok: false, error: 'duplicate-level' };
    seen.add(level);
  }
  return { ok: true, levels: raw };
}

// Valori del dialogo (stringhe o booleani) -> patch tipizzata per l'API.
// Vuoto o assente non scrive; `false` scrive `false`.
// Errori per campo, PRIMA di convertire. Un valore non vuoto e fuori scala e'
// un errore, non un'assenza: scartarlo in silenzio produrrebbe una patch
// parziale che nessuno ha chiesto.
export function modelFieldErrors(values) {
  const source = values && typeof values === 'object' ? values : {};
  const errors = {};
  for (const key of MODEL_NUMERIC_FIELDS) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    const text = String(raw).trim();
    if (text && !validModelLimit(text)) errors[key] = 'out-of-range';
  }
  for (const key of MODEL_BOOLEAN_FIELDS) {
    const raw = source[key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (raw !== true && raw !== false && raw !== 'true' && raw !== 'false') errors[key] = 'not-a-boolean';
  }
  const effort = parseEffortLevels(source.effortLevels);
  if (!effort.ok) errors.effortLevels = effort.error;
  return errors;
}

export function modelPatchFromValues(values) {
  const source = values && typeof values === 'object' ? values : {};
  const fieldErrors = modelFieldErrors(source);
  if (Object.keys(fieldErrors).length) {
    const error = new Error(`invalid model values: ${Object.keys(fieldErrors).join(', ')}`);
    error.code = 'invalid-model-values';
    error.fields = fieldErrors;
    throw error;
  }
  const patch = {};
  for (const key of MODEL_NUMERIC_FIELDS) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    const text = String(raw).trim();
    if (!text) continue;
    const n = Number(text);
    if (validModelLimit(n)) patch[key] = n;
  }
  for (const key of MODEL_BOOLEAN_FIELDS) {
    const raw = source[key];
    if (raw === true || raw === 'true') patch[key] = true;
    else if (raw === false || raw === 'false') patch[key] = false;
  }
  const effort = parseEffortLevels(source.effortLevels);
  if (effort.levels) patch.effortLevels = effort.levels;
  return patch;
}
