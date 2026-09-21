'use strict';
// lib/fleet/endpoint-probe.js — «l'endpoint risponde?», chiesto all'endpoint.
//
// Un engine managed con un `baseUrl` dichiarato a mano (un router llama.cpp, un
// server locale, un proxy) veniva dichiarato `ready` appena il BINARIO esisteva e
// la credenziale era a posto. Nessuno interrogava mai l'indirizzo: un router
// spento risultava pronto, e lo si scopriva facendo partire la cella. Qui la
// domanda si fa prima, con un GET sull'elenco dei modelli — l'unica chiamata che
// non consuma token e non genera testo.
//
// TRE DISCIPLINE, che valgono quanto la sonda:
//   1. NON BLOCCANTE OLTRE IL PROPRIO BUDGET. `refresh` e' l'unico punto che
//      aspetta, e aspetta al massimo `timeoutMs`. Chi legge lo stato da un
//      percorso sincrono usa `read`/`ensure`: ottiene il verdetto NOTO ADESSO e
//      al massimo fa partire un rifornimento in sottofondo.
//   2. UNA PROBE OGNI `ttlMs` PER ENDPOINT. `nc_status` e la UI interrogano lo
//      stato di continuo: senza cache si tradurrebbe in una tempesta di GET
//      verso ogni router del parco.
//   3. GLI ENGINE DI CATALOGO NON SI SONDANO. La sonda si applica solo dove
//      l'indirizzo e' dichiarato (provider pubblici: irraggiungibile da qui non
//      significa rotto, e non e' compito di questo nodo misurarlo).

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_TTL_MS = 30000;

// L'elenco modelli sta sotto `/v1/models` per le API in stile OpenAI. Un
// `baseUrl` che dichiara gia' `/v1` non lo ripete: ripeterlo produce
// `/v1/v1/models`, che risponde 404 e verrebbe letto come «endpoint vivo».
function modelsProbeUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) return null;
  return /\/v1$/.test(b) ? `${b}/models` : `${b}/v1/models`;
}

// `host:porta` per il messaggio: e' cio' che serve a chi legge per capire QUALE
// indirizzo non risponde, senza riversare l'URL intero nel verdetto.
function endpointHost(baseUrl) {
  try {
    const u = new URL(String(baseUrl));
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.hostname}:${port}`;
  } catch (_) { return String(baseUrl || ''); }
}

function createEndpointProbe({
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
} = {}) {
  const cache = new Map();   // baseUrl -> {state, reason, at}
  const inFlight = new Map(); // baseUrl -> Promise

  // Verdetto noto ADESSO, senza toccare la rete. `null` = mai sondato.
  function read(baseUrl) {
    if (!modelsProbeUrl(baseUrl)) return null;
    const hit = cache.get(baseUrl);
    if (!hit) return null;
    return { state: hit.state, reason: hit.reason, at: hit.at, stale: (now() - hit.at) >= ttlMs };
  }

  async function refresh(baseUrl) {
    const url = modelsProbeUrl(baseUrl);
    if (!url) return null;
    if (inFlight.has(baseUrl)) return inFlight.get(baseUrl);
    const run = (async () => {
      const controller = new AbortController();
      const timer = setTimer(() => controller.abort(), timeoutMs);
      // Il timer resta REF per la durata della sonda: e' l'unico handle che
      // puo' chiudere un fetch che non risponde, e con l'unref (senza altri
      // handle) l'event loop si svuota prima che scada — la promise non si
      // risolve mai e il file di test resta appeso. Vive al massimo timeoutMs
      // e viene spento nel finally: nessun processo trattenuto oltre.
      let verdict;
      try {
        const res = await fetchImpl(url, { method: 'GET', signal: controller.signal });
        const status = res && typeof res.status === 'number' ? res.status : 0;
        if (status >= 200 && status < 300) {
          verdict = { state: 'ready', reason: 'ready' };
        } else if (status === 401 || status === 403) {
          // L'endpoint ha risposto e sta chiedendo una credenziale: e' VIVO.
          // Se la chiave sia quella giusta lo decide il client, non questa sonda.
          verdict = { state: 'ready', reason: 'ready' };
        } else if (status >= 500) {
          verdict = { state: 'unreachable', reason: `endpoint unreachable: ${endpointHost(baseUrl)} (http ${status})` };
        } else {
          // Qualunque altra risposta (404 compreso) e' comunque una risposta:
          // l'indirizzo c'e' ed e' in ascolto.
          verdict = { state: 'ready', reason: 'ready' };
        }
      } catch (error) {
        const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
        verdict = {
          state: 'unreachable',
          reason: `endpoint unreachable: ${endpointHost(baseUrl)} (${aborted ? `timeout (${timeoutMs}ms)` : 'connessione rifiutata'})`,
        };
      } finally {
        try { clearTimer(timer); } catch (_) {}
      }
      cache.set(baseUrl, { ...verdict, at: now() });
      try { log(`sonda endpoint ${endpointHost(baseUrl)}: ${verdict.state}`); } catch (_) {}
      return verdict;
    })();
    inFlight.set(baseUrl, run);
    try { return await run; } finally { inFlight.delete(baseUrl); }
  }

  // Percorso SINCRONO: ritorna il verdetto noto (o `null`) e, se manca o e'
  // scaduto, avvia il rifornimento senza attendere. Il primo giro dopo un
  // avvio puo' quindi non sapere ancora; dal secondo in poi dice la verita'
  // per tutta la durata del TTL.
  function ensure(baseUrl) {
    if (!modelsProbeUrl(baseUrl)) return null;
    const hit = read(baseUrl);
    if (!hit || hit.stale) { refresh(baseUrl).catch(() => {}); }
    return hit ? { state: hit.state, reason: hit.reason } : null;
  }

  // Percorso ASINCRONO: attende la sonda SOLO se il verdetto e' assente o
  // scaduto. E' quello che usa lo status, dove un'attesa breve e' ammessa e
  // un'informazione vecchia non serve a nessuno.
  async function status(baseUrl) {
    const hit = read(baseUrl);
    if (hit && !hit.stale) return { state: hit.state, reason: hit.reason };
    return refresh(baseUrl).catch(() => null);
  }

  return {
    read, ensure, refresh, status,
    size: () => cache.size,
    clear: () => cache.clear(),
    limits: { timeoutMs, ttlMs },
    url: modelsProbeUrl,
    host: endpointHost,
  };
}

// Istanza di processo: la cache deve sopravvivere alla singola chiamata, ed e'
// esattamente cio' che evita la tempesta di probe.
const sharedProbe = createEndpointProbe();

module.exports = {
  createEndpointProbe, sharedProbe, modelsProbeUrl, endpointHost,
  ENDPOINT_PROBE_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  ENDPOINT_PROBE_TTL_MS: DEFAULT_TTL_MS,
};
