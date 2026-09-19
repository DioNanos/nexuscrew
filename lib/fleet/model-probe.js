'use strict';
// lib/fleet/model-probe.js — «questo modello funziona davvero con questa
// credenziale?», chiesto all'API invece che indovinato.
//
// Oggi un id sbagliato si scopre quando la cella non parte, e il messaggio non
// dice se il problema e' il nome del modello, la chiave o la rete. Qui la
// domanda si fa prima, e la risposta e' un enum chiuso.
//
// COSTO, per gli engine DI CATALOGO: si interroga l'elenco dei modelli
// (`GET .../models`) e nient'altro. Non si genera testo, quindi non si
// consumano token. Dove il catalogo non esiste l'esito e' `unverified`: NON si
// ricade su una richiesta di completamento, per quanto minima. Una prova che
// costa e' una prova che chi la guarda impara a non fare — e allora tanto vale
// non averla.
//
// COSTO, per un endpoint DICHIARATO A MANO (`probeCustomEndpoint`): la regola
// sopra vale finche' il catalogo c'e'. Un router locale spesso non espone
// `GET /models`, e su quel ramo l'alternativa a una richiesta minima non e' una
// prova gratuita — e' nessuna prova, cioe' un `unverified` su un modello che
// quasi certamente esiste. Li' si ricade su UN completamento da un token
// (`max_tokens: 1`) e il testo generato non viene letto ne' registrato: la
// risposta serve solo a distinguere «c'e'» da «non c'e'».
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

// Un endpoint dichiarato A MANO non sta nel catalogo pubblico: la prova si fa
// sul suo indirizzo. Stessa forma di URL della sonda di prontezza (`/v1` non si
// ripete), stesso verdetto enum della prova di catalogo — chi legge l'esito non
// deve sapere da quale dei due rami e' arrivato.
function chatCompletionsUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) return null;
  return /\/v1$/.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

// Un endpoint locale spesso non espone `GET /models` (o lo espone vuoto). La
// seconda via e' la richiesta minima: `max_tokens: 1`, nessun testo letto, e il
// corpo della risposta NON entra nell'esito. Serve a distinguere «il modello
// c'e'» da «il modello non c'e'», non a misurare la qualita' della risposta.
const CUSTOM_FALLBACK_TIMEOUT_MS = 10000;

async function probeCustomEndpoint({
  endpoint, credential = '', model, fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS, fallbackTimeoutMs = CUSTOM_FALLBACK_TIMEOUT_MS,
} = {}) {
  const listUrl = modelsUrl({ endpoint });
  if (!listUrl) return { outcome: 'unverified', latencyMs: 0, detail: 'endpoint non interrogabile' };

  const started = Date.now();
  const headers = credential ? { authorization: `Bearer ${credential}` } : {};
  const list = await timedFetch({
    fetchImpl, url: listUrl, method: 'GET', headers, timeoutMs,
  });
  if (list.transport === 'timeout') return { outcome: 'unreachable', latencyMs: list.latencyMs, detail: `timeout (${timeoutMs}ms)` };
  if (list.transport === 'error') return { outcome: 'unreachable', latencyMs: list.latencyMs, detail: 'endpoint non raggiungibile' };
  if (list.status === 401 || list.status === 403) return { outcome: 'auth', latencyMs: list.latencyMs };
  if (list.status >= 200 && list.status < 300) {
    // Un elenco VUOTO non e' «il modello non c'e'»: e' un endpoint che non
    // espone un catalogo. Trattarlo come assenza darebbe un falso negativo su
    // un modello che risponde benissimo — il caso tipico dei router locali.
    const rows = Array.isArray(list.payload && list.payload.data) ? list.payload.data
      : Array.isArray(list.payload && list.payload.models) ? list.payload.models : null;
    if (rows && rows.length) {
      const found = findInCatalog(list.payload, model);
      if (found === true) return { outcome: 'ok', latencyMs: list.latencyMs };
      if (found === false) return { outcome: 'unknown-model', latencyMs: list.latencyMs };
    }
    // Elenco assente, vuoto o illeggibile: si prova la via minima invece di
    // dichiarare `unverified` un modello che probabilmente c'e'.
  } else if (list.status >= 500) {
    return { outcome: 'unreachable', latencyMs: list.latencyMs, detail: `http ${list.status}` };
  }

  const chatUrl = chatCompletionsUrl(endpoint);
  if (!chatUrl) return { outcome: 'unverified', latencyMs: Date.now() - started, detail: 'endpoint non interrogabile' };
  const chat = await timedFetch({
    fetchImpl,
    url: chatUrl,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    timeoutMs: fallbackTimeoutMs,
  });
  const latencyMs = Date.now() - started;
  if (chat.transport === 'timeout') return { outcome: 'unreachable', latencyMs, detail: `timeout (${fallbackTimeoutMs}ms)` };
  if (chat.transport === 'error') return { outcome: 'unreachable', latencyMs, detail: 'endpoint non raggiungibile' };
  if (chat.status === 401 || chat.status === 403) return { outcome: 'auth', latencyMs };
  if (chat.status >= 200 && chat.status < 300) return { outcome: 'ok', latencyMs };
  // 400/404 su un modello chiesto per nome: l'endpoint risponde e non lo
  // conosce. E' l'esito piu' utile che si possa dare senza leggere il corpo.
  if (chat.status === 400 || chat.status === 404 || chat.status === 422) return { outcome: 'unknown-model', latencyMs };
  return { outcome: 'unverified', latencyMs, detail: `http ${chat.status}` };
}

// Una fetch sola, con budget proprio, che non solleva mai: l'esito e' un valore.
async function timedFetch({ fetchImpl, url, method, headers, body, timeoutMs }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method, signal: controller.signal, headers, ...(body ? { body } : {}),
    });
    const status = res && typeof res.status === 'number' ? res.status : 0;
    let payload = null;
    if (status >= 200 && status < 300) {
      try { payload = typeof res.json === 'function' ? await res.json() : null; } catch (_) { payload = null; }
    }
    return { status, payload, latencyMs: Date.now() - started };
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
    return { status: 0, payload: null, latencyMs: Date.now() - started, transport: aborted ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
  }
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

module.exports = {
  probeModel, OUTCOMES, findInCatalog, modelsUrl,
  probeCustomEndpoint, chatCompletionsUrl, CUSTOM_FALLBACK_TIMEOUT_MS,
};
