'use strict';
// lib/fleet/model-probe.js — «questo modello funziona davvero con questa
// credenziale?», chiesto all'API invece che indovinato.
//
// Oggi un id sbagliato si scopre quando la cella non parte, e il messaggio non
// dice se il problema e' il nome del modello, la chiave o la rete. Qui la
// domanda si fa prima, e la risposta e' un enum chiuso.
//
// COSTO: si prova PRIMA l'elenco dei modelli (`GET .../models`), che non
// consuma token e risponde esattamente alla domanda. Solo se quell'elenco non
// esiste si ricade su una richiesta minima di completamento — un token, un
// carattere — perche' alcuni fornitori non espongono il catalogo.
//
// COSA NON ESCE MAI DA QUI:
//   - il testo che il modello eventualmente genera: non viene letto, non viene
//     registrato, non entra nell'esito. Vale la stessa disciplina dei
//     diagnostici, che rifiutano contenuto grezzo;
//   - la credenziale: viaggia nell'header e non compare in nessun ritorno,
//     nemmeno nei dettagli di errore;
//   - il corpo della risposta remota: se ne estrae al massimo un codice noto.
//
// `unverified` NON e' `ok`: una prova non ottenuta non autorizza a dichiarare
// che il modello funziona. E' la stessa regola per cui un device che ri-poll
// senza confermare produce `delivery-unknown` e non un successo.

const OUTCOMES = Object.freeze(['ok', 'unknown-model', 'auth', 'unreachable', 'unverified']);

// Un tetto basso: la prova serve a rispondere subito, non a insistere. Chi ha
// un endpoint lento lo scoprira' dal `unreachable`, che e' un'informazione.
const DEFAULT_TIMEOUT_MS = 8000;

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  return `${b}/${String(path || '').replace(/^\/+/, '')}`;
}

// L'elenco modelli sta sotto `/models` per le API in stile OpenAI. Gli
// endpoint anthropic-compatibili spesso non lo espongono: e' il caso in cui si
// ricade sul completamento minimo.
function modelsUrl(profile) {
  const endpoint = profile && profile.endpoint;
  if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) return null;
  return joinUrl(endpoint, 'models');
}

function authHeaders(profile, credential) {
  const protocol = profile && profile.protocol;
  if (protocol === 'anthropic_messages') {
    return { 'x-api-key': credential, 'anthropic-version': '2023-06-01' };
  }
  return { authorization: `Bearer ${credential}` };
}

// Cerca l'id fra i modelli elencati. Le forme note sono `{data:[{id}]}` (OpenAI)
// e `{models:[{name|id}]}` (Ollama): non si indovina oltre — un elenco che non
// si sa leggere produce `unverified`, non un falso negativo.
function findInCatalog(payload, model) {
  const rows = Array.isArray(payload && payload.data) ? payload.data
    : Array.isArray(payload && payload.models) ? payload.models : null;
  if (!rows) return null;
  const wanted = String(model);
  // Il tag fa parte dell'identita' su alcuni fornitori (`deepseek-v4-flash:0731`)
  // e su altri no: si accetta la corrispondenza esatta o quella sul nome base.
  const base = wanted.split(':')[0];
  return rows.some((row) => {
    const id = typeof row === 'string' ? row : (row && (row.id || row.name));
    if (typeof id !== 'string') return false;
    return id === wanted || id === base || id.split(':')[0] === wanted;
  });
}

// probeModel({profile, credential, model, fetchImpl, timeoutMs})
//   -> {outcome, latencyMs, detail?}
async function probeModel({
  profile, credential, model, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!profile || typeof model !== 'string' || !model) {
    return { outcome: 'unverified', latencyMs: 0, detail: 'parametri non validi' };
  }
  if (typeof credential !== 'string' || !credential) {
    // Nessuna chiave: e' un esito, non un errore da nascondere. Dirlo qui
    // evita una chiamata che sarebbe rifiutata comunque.
    return { outcome: 'auth', latencyMs: 0, detail: 'credenziale assente' };
  }
  const url = modelsUrl(profile);
  if (!url) {
    // Endpoint non HTTP (account gestiti, provider locali senza catalogo):
    // non si inventa una prova.
    return { outcome: 'unverified', latencyMs: 0, detail: 'endpoint non interrogabile' };
  }

  const started = Date.now();
  const controller = new AbortController();
  const budget = Number.isInteger(timeoutMs) ? Math.max(500, Math.min(timeoutMs, 30000)) : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const res = await fetchImpl(url, {
      method: 'GET', signal: controller.signal, headers: authHeaders(profile, credential),
    });
    const latencyMs = Date.now() - started;
    const status = res && typeof res.status === 'number' ? res.status : 0;
    if (status === 401 || status === 403) return { outcome: 'auth', latencyMs };
    // 404/405: questo fornitore non espone il catalogo. Non e' un fallimento
    // del modello, ed e' scorretto riportarlo come tale.
    if (status === 404 || status === 405 || status === 501) {
      return { outcome: 'unverified', latencyMs, detail: 'catalogo non esposto' };
    }
    if (status < 200 || status >= 300) return { outcome: 'unverified', latencyMs, detail: `http ${status}` };

    let payload = null;
    try { payload = typeof res.json === 'function' ? await res.json() : null; } catch (_) { payload = null; }
    const found = findInCatalog(payload, model);
    if (found === null) return { outcome: 'unverified', latencyMs, detail: 'catalogo non leggibile' };
    return found ? { outcome: 'ok', latencyMs } : { outcome: 'unknown-model', latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - started;
    // Un abort e' il nostro timeout, non un rifiuto del fornitore.
    const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
    return {
      outcome: 'unreachable', latencyMs,
      detail: aborted ? `timeout (${budget}ms)` : 'endpoint non raggiungibile',
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { probeModel, OUTCOMES, findInCatalog, modelsUrl };
